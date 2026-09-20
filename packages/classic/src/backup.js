// `backup` service (Backup_20170222) — robot backup-to-cloud, the "Backing up robot…" step of
// the UI's wipe/factory-reset flow. Audited against the original jiborobot/srv-backup-ws
// @1153de1e343310a3f48f74ea3cbbe01e4bccab65 (src/handlers/handler.js, src/controllers/ctrl.js,
// src/errors/backup.js, src/clients/account.client.js) and the robot-side driver
// PlatformTeam/system-manager scripts/jibo-system-{backup,restore}.js, which is the authoritative
// client:
//
//   Loop.list {}                  -> [{ id: loopId, … }]   (exactly one; handled by @phoenix/account)
//   Backup.new  { loopId }        -> { uploadUrl }          a PUT URL the robot uploads the blob to
//   <PUT uploadUrl> octet-stream  -> 200 + ETag header      (the robot reads response.headers.etag)
//   Backup.list { loopId }        -> [{ modified, etag, size, location:{ expires, url } }]
//                                    newest-first; the robot asserts entry.etag === the PUT ETag,
//                                    so backup() succeeds and the wipe is allowed to proceed.
//   <GET location.url>            -> 200 + the blob         (restore: jibo-system-restore.js)
//
// Source semantics reproduced here (srv-backup-ws@1153de1):
//   * BOTH ops call `accountClient.getLoop(loopId)` and reject unless
//     `loop.robot === credentials.id` with 403 ROBOT_SHOULD_BELONG_TO_LOOP
//     (ctrl.js:26-28,48-50; errors/backup.js:1-5). `credentials` come from the
//     security gateway's `x-amz-credentials` header (srv-server@master parseCredentials.ts:15).
//   * Missing/invalid `loopId` fails Joi (`Joi.string().required()`,
//     handler.js:15,26) -> Boom.badData, i.e. HTTP 422 with the Hapi payload
//     {statusCode, error:"Unprocessable Entity", message} and no `code`.
//   * An unknown operation is `Boom.notFound("Method <op> not found.")` -> 404
//     (srv-server server.ts:182-183), where <op> is the target's second segment
//     with its first character lowercased.
//   * `modified`/`etag`/`size`/`location.expires` are emitted with the same
//     runtime types the source did, including the source's model mismatch: `size`
//     and `expires` are declared `string` in backup-2017-02-22.normal.json but the
//     controller returns numbers (S3 Size, epoch ms) — reproduced faithfully.
//
// The original handed back S3 presigned URLs. Phoenix has no S3, so — exactly like the OTA
// "self-hosted packages" divergence — the URLs point back at the explicitly configured public
// origin (ETCO_classic_publicUrl/publicUrl), and the blob is stored locally. Each URL is signed
// with a server-held HMAC and carries an epoch-ms expiry. The query names loopId/key remain the
// robot's URL contract; the additional bearer fields replace S3's signature/expiry enforcement.
// The secret is never placed in a URL or a request log. Configure ETCO_classic_backupBearerSecret
// (or the launcher's stable ETCO_server_hubTokenSecret) when URLs must survive a process restart;
// an unconfigured process uses a random secret, which intentionally invalidates old URLs on exit.

// DURABILITY: the index is a cache. The object files under
// ETCO_classic_backupDir / $TMPDIR/phx-backups ARE the source of truth and are re-indexed on a
// cache miss, so blob retrieval and `Backup.List` survive a process restart/crash. (The original
// survived the same way: S3 persisted, the service held no state.)

// RESTORE AUTHORIZATION is the signed URL itself in the source (an S3 presigned GET). Phoenix's
// self-hosted URL preserves that possession model with a method- and loop-bound HMAC that is
// checked on both GET and PUT before touching the object store.

import { createReadStream, openSync, readSync, closeSync, readdirSync, statSync, lstatSync, realpathSync, constants } from 'node:fs';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DefaultPort } from '@phoenix/contracts';
import { sendAmz } from './awsJson.js';
import { verifiedCallerFromRequest } from './caller.js';
import { canonicalPublicOrigin } from './publicOrigin.js';
import {
  UploadTooLargeError,
  configuredMaxBytes,
  declaredContentLength,
  normalizeMaxBytes,
  writeAtomicUpload,
} from './rawUpload.js';

// Mirrors srv-backup-ws: keys are `MAGICK - now` so a lexical/numeric sort puts newest first.
const MAGICK = 9999999999999;
const URL_EXPIRATION_MS = 24 * 60 * 60 * 1000; // ctrl.js URL_EXPIRATION_SEC (24h)
const SAFE = /^[A-Za-z0-9_-]+$/;               // loopId/key live in URLs + file paths — no traversal
const BEARER_SIGNATURE_BYTES = 32;
const ACCOUNT_TIMEOUT_MS = Number(process.env.ETCO_classic_backupAccountTimeoutMS) || 3000;

export const BACKUP_MAX_BYTES = 1_000_000_000;
export const BACKUP_URL_EXPIRATION_MS = URL_EXPIRATION_MS;

function bearerSecretFrom(options) {
  // A configured value keeps URLs valid across a restart. The parity launcher already exposes the
  // process hub secret; the random fallback avoids a predictable bearer key in standalone runs.
  const configured = options.bearerSecret
    ?? process.env.ETCO_classic_backupBearerSecret
    ?? process.env.ETCO_server_hubTokenSecret
    ?? process.env.HUB_TOKEN_SECRET;
  if (Buffer.isBuffer(configured) && configured.length > 0) return configured;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  // A per-process secret is safer than an unsigned URL when no deployment secret was configured.
  // Operators that need URLs to survive a restart must provide one of the variables above.
  return randomBytes(BEARER_SIGNATURE_BYTES);
}

function clockNow(clock) {
  try {
    const value = Number(clock());
    return Number.isFinite(value) ? Math.floor(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function bearerPayload(method, loopId, key, expires) {
  return ['phoenix-backup-v1', String(method).toUpperCase(), loopId, key, String(expires)].join('\n');
}

function signBearer(secret, method, loopId, key, expires) {
  return createHmac('sha256', secret).update(bearerPayload(method, loopId, key, expires)).digest('hex');
}

function singleQueryParam(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function bearerIds(url, method, secret, now) {
  const loopId = singleQueryParam(url, 'loopId');
  const key = singleQueryParam(url, 'key');
  const expiresText = singleQueryParam(url, 'expires');
  const signature = singleQueryParam(url, 'signature');
  if (!loopId || !key || !expiresText || !signature || !SAFE.test(loopId) || !SAFE.test(key)) return null;
  if (!/^[0-9]+$/.test(expiresText)) return null;
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || String(expires) !== expiresText || expires <= now) return null;
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = Buffer.from(signBearer(secret, method, loopId, key, expires), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return { loopId, key };
}

function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  if (!address) return false;
  if (address === '::1' || address === '127.0.0.1') return true;
  if (isIP(address) === 6 && address.toLowerCase() === '::ffff:127.0.0.1') return true;
  return false;
}

function assertContainedPath(root, target) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error('backup path escapes configured directory');
  }
}

function safeComponent(value, name) {
  if (typeof value !== 'string' || !SAFE.test(value)) throw new Error(`invalid backup ${name}`);
  return value;
}

/** Resolve the configured root once per operation; a missing root is a normal empty store on read. */
function rootRealpathSync(dir) {
  try {
    const root = realpathSync(resolve(dir));
    if (!lstatSync(root).isDirectory()) return null;
    return root;
  } catch {
    return null;
  }
}

/** Reject a loop directory symlink before readdir/stat can follow it. */
function loopDirectorySync(root, loopId) {
  const lexical = resolve(root, safeComponent(loopId, 'loopId'));
  assertContainedPath(root, lexical);
  let info;
  try { info = lstatSync(lexical); } catch { return null; }
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  const canonical = realpathSync(lexical);
  assertContainedPath(root, canonical);
  const canonicalInfo = lstatSync(canonical);
  return canonicalInfo.isDirectory() ? canonical : null;
}

/** Validate a returned object path after lstat and realpath, with no symlink traversal. */
function objectFileSync(root, loopDir, key) {
  const lexical = resolve(loopDir, safeComponent(key, 'key'));
  assertContainedPath(root, lexical);
  let info;
  try { info = lstatSync(lexical); } catch { return null; }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  const canonical = realpathSync(lexical);
  assertContainedPath(root, canonical);
  const canonicalInfo = lstatSync(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) return null;
  return { file: canonical, stat: canonicalInfo };
}

/** Async equivalent used immediately before publishing an upload. */
async function safeUploadPaths(dir, loopId, key) {
  const root = await realpath(resolve(dir));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error('backup root is not a directory');
  const loopLexical = resolve(root, safeComponent(loopId, 'loopId'));
  assertContainedPath(root, loopLexical);
  const loopInfo = await lstat(loopLexical);
  if (loopInfo.isSymbolicLink() || !loopInfo.isDirectory()) throw new Error('backup loop path contains symlink');
  const loopDir = await realpath(loopLexical);
  assertContainedPath(root, loopDir);
  const loopCanonicalInfo = await lstat(loopDir);
  if (!loopCanonicalInfo.isDirectory()) throw new Error('backup loop path is not a directory');
  const file = resolve(loopDir, safeComponent(key, 'key'));
  assertContainedPath(root, file);
  try {
    const fileInfo = await lstat(file);
    if (fileInfo.isSymbolicLink()) throw new Error('backup object path contains symlink');
    const canonical = await realpath(file);
    assertContainedPath(root, canonical);
    const canonicalInfo = await lstat(canonical);
    if (canonicalInfo.isSymbolicLink()) throw new Error('backup object path contains symlink');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { root, loopDir, file };
}

export class BackupStore {
  constructor(dir = process.env.ETCO_classic_backupDir || join(tmpdir(), 'phx-backups'), options = {}) {
    if (dir && typeof dir === 'object') {
      options = dir;
      dir = options.dir;
    }
    this.dir = dir || process.env.ETCO_classic_backupDir || join(tmpdir(), 'phx-backups');
    this.maxBytes = normalizeMaxBytes(
      options.maxBytes,
      configuredMaxBytes('ETCO_classic_backupMaxBytes', BACKUP_MAX_BYTES),
    );
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    const configuredExpiry = Number(options.urlExpirationMs);
    this.urlExpirationMs = Number.isSafeInteger(configuredExpiry) && configuredExpiry > 0
      ? configuredExpiry
      : URL_EXPIRATION_MS;
    this.bearerSecret = bearerSecretFrom(options);
    this.index = new Map(); // loopId -> [{ key, etag, modified, size, file }]
  }

  now() {
    return clockNow(this.clock);
  }

  signedBlobUrl(base, method, loopId, key) {
    const origin = canonicalPublicOrigin(String(base));
    const expires = this.now() + this.urlExpirationMs;
    const signature = signBearer(this.bearerSecret, method, loopId, key, expires);
    return {
      expires,
      url: `${origin}/backup/blob?loopId=${encodeURIComponent(loopId)}&key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`,
    };
  }

  /**
   * The loop's entries. A cache miss re-indexes the loop's directory from disk: the object
   * files written by an earlier process are the durable record, so a restarted service can
   * still list and serve them.
   */
  _entries(loopId) {
    let a = this.index.get(loopId);
    if (!a) a = this.recover(loopId);
    return a;
  }

  /** Rebuild (and cache) a loop's index from the object files an earlier process left behind. */
  recover(loopId) {
    const arr = [];
    if (SAFE.test(loopId)) {
      const root = rootRealpathSync(this.dir);
      let loopDir = null;
      try { loopDir = root ? loopDirectorySync(root, loopId) : null; } catch { loopDir = null; }
      let names = [];
      try { names = loopDir ? readdirSync(loopDir) : []; } catch { names = []; }
      for (const name of names) {
        if (!SAFE.test(name)) continue;
        try {
          const object = objectFileSync(root, loopDir, name);
          if (!object) continue;
          const { file, stat } = object;
          arr.push({ key: name, etag: `"${md5FileSync(file)}"`, modified: stat.mtimeMs, size: stat.size, file });
        } catch { /* skip an unreadable or symlinked object rather than failing the whole loop */ }
      }
    }
    this.index.set(loopId, arr);
    return arr;
  }

  /** A fresh, unique, newest-sorts-first object key for a Backup.new call. */
  newKey() {
    return `${MAGICK - this.now()}-${randomBytes(4).toString('hex')}`;
  }

  /** Stream an upload to a same-directory temporary file, hashing as it goes; publish only at EOF. */
  async put(loopId, key, reqStream) {
    safeComponent(loopId, 'loopId');
    safeComponent(key, 'key');
    await mkdir(resolve(this.dir), { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.dir, loopId), { recursive: true, mode: 0o700 });
    const initial = await safeUploadPaths(this.dir, loopId, key);
    const hash = createHash('md5');
    const result = await writeAtomicUpload(reqStream, initial.file, {
      maxBytes: this.maxBytes,
      onChunk: (chunk) => hash.update(chunk),
    });
    // Re-resolve after rename. The index must never retain a path that crossed the root while the
    // request was in flight, and a replaced loop/object symlink is treated as a failed publication.
    const published = await safeUploadPaths(this.dir, loopId, key);
    const entry = {
      key, etag: `"${hash.digest('hex')}"`, modified: this.now(), size: result.size, file: published.file,
    };
    const arr = this._entries(loopId).filter((e) => e.key !== key);
    arr.push(entry);
    this.index.set(loopId, arr);
    return entry;
  }

  /** Newest-first, capped to [1, 1000] like the original (default max=1 — one entry, matching S3). */
  list(loopId, max = 1) {
    const cap = Math.max(1, Math.min(1000, Number(max) || 1));
    return [...this._entries(loopId)].sort((a, b) => b.modified - a.modified).slice(0, cap);
  }

  find(loopId, key) {
    if (!SAFE.test(String(loopId)) || !SAFE.test(String(key))) return null;
    return this._entries(loopId).find((e) => e.key === key) || null;
  }

  /** Open a stored object only after re-checking every path component and its canonical target. */
  openObject(loopId, key) {
    const root = rootRealpathSync(this.dir);
    if (!root) return null;
    const loopDir = loopDirectorySync(root, loopId);
    if (!loopDir) return null;
    const object = objectFileSync(root, loopDir, key);
    if (!object) return null;
    const noFollow = constants.O_NOFOLLOW || 0;
    return {
      file: object.file,
      size: object.stat.size,
      stream: createReadStream(object.file, { flags: constants.O_RDONLY | noFollow }),
    };
  }
}

/** Chunked md5 so re-indexing an object never buffers a whole blob in memory. */
function md5FileSync(file) {
  const hash = createHash('md5');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

// ---- source error envelopes (srv-server Boom) ------------------------------

const REASON = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  503: 'Service Unavailable',
};
const BACKUP_AUTH_REQUIRED = {
  statusCode: 401,
  message: 'Backup credentials required',
  code: 'BACKUP_AUTH_REQUIRED',
};
const ACCOUNT_SERVICE_UNAVAILABLE = {
  statusCode: 503,
  message: 'Account service unavailable',
  code: 'ACCOUNT_SERVICE_UNAVAILABLE',
};

/**
 * The source replied with a raw Hapi/Boom payload and no `x-amzn-errortype` header. The pinned
 * client's extractError (lib/protocol/json.js:62-71) reads the body's `__type || code || error`,
 * so a 422 carries `error:"Unprocessable Entity"` while the ownership refusal carries its
 * explicit `code:"ROBOT_SHOULD_BELONG_TO_LOOP"`. `message` is always read from the body.
 */
function sendBoom(res, statusCode, message, code) {
  const payload = { statusCode, error: REASON[statusCode] || 'Error', message };
  if (code) payload.code = code;
  const body = JSON.stringify(payload);
  res.removeHeader?.('x-powered-by');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(body);
}

/** srv-server server.ts:139-143 lowerMethodName — lowercases only the first character. */
function sourceOp(op) {
  const s = String(op || '');
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The source Joi schema is `Joi.string().required()` on loopId (handler.js:15,26). */
function loopIdValidationMessage(loopId) {
  if (loopId === undefined || loopId === null) return 'child "loopId" fails because ["loopId" is required]';
  if (typeof loopId !== 'string') return 'child "loopId" fails because ["loopId" must be a string]';
  if (loopId.length === 0) return 'child "loopId" fails because ["loopId" is not allowed to be empty]';
  // Phoenix hardening: loopId becomes a URL query value and a directory name, so a traversal
  // attempt is refused here rather than reaching the filesystem (unreachable from the source's
  // generated client, which only ever sends the loop id it read from Loop.List).
  if (!SAFE.test(loopId)) return 'child "loopId" fails because ["loopId" must only contain alpha-numeric characters, underscores and dashes]';
  return null;
}

// ---- caller identity + ownership -------------------------------------------

/**
 * The source's identity source for Backup is the security gateway's `x-amz-credentials`
 * forwarding header (srv-server parseCredentials.ts parses it into request.auth.credentials and
 * handler.js:19,31 reads `credentials.id`). Same seam log.js already uses for its robot/admin
 * checks. That header is only an identity assertion after a trusted gateway has verified the
 * request; a missing header is never treated as LAN trust. The current parity authenticated-stack
 * binds Classic directly to the robot-facing listener and does not inject a Backup resolver, so
 * this code deliberately rejects that unconfigured external path instead of treating a raw
 * Authorization Credential value as verified. For a deliberately private, same-host deployment,
 * `allowLoopbackWithoutIdentity` is an explicit opt-in and is accepted only when the socket peer
 * is loopback (not from a forwarded client address).
 */
export function credentialsAccountId(req) {
  try {
    const parsed = JSON.parse(req?.headers?.['x-amz-credentials'] || '');
    if (!parsed || typeof parsed !== 'object') return null;
    const id = parsed.id ?? parsed._id;
    return id === undefined || id === null || String(id).length === 0 ? null : String(id);
  } catch {
    return null;
  }
}

function accountBase() {
  const v = process.env.NET_account;
  if (!v) return `http://localhost:${DefaultPort.account}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

function accountPeerHeaders() {
  const token = process.env.ETCO_account_internalPeerToken;
  return token ? { 'x-phoenix-internal-token': token } : {};
}

/**
 * Resolve a loop's robot account id the way srv-backup-ws did: AccountClient.getLoop issues
 * `GET <account>/loop?loopId=<id>` (src/clients/account.client.js:10-18). Distinct return values
 * robot id (or `null` for "loop exists but has no robot") is compared against the caller;
 * `undefined` means Account could not resolve the loop, so sensitive ownership checks deny with a
 * service-unavailable response rather than authorizing through an outage.
 */
export async function accountLoopRobot(loopId) {
  try {
    const res = await fetch(`${accountBase()}/loop?loopId=${encodeURIComponent(loopId)}`, {
      headers: accountPeerHeaders(),
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
    if (res.status === 404) return null;      // the account service answered: no such loop
    if (!res.ok) return undefined;            // transient/other failure -> unresolved
    const doc = await res.json();
    if (!doc || typeof doc !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(doc, 'robot') ? doc.robot : null;
  } catch {
    return undefined;                          // unreachable account service -> unresolved
  }
}

/**
 * @param {{accountId?: (req) => string|null, loopRobotId?: (loopId) => Promise<string|null|undefined>, allowLoopbackWithoutIdentity?: boolean}} [ownership]
 */
export function makeBackupHandler(store, baseFor, { ownership, callerBoundary } = {}) {
  const configuredAccountId = ownership?.accountId;
  const accountIdOf = configuredAccountId || credentialsAccountId;
  const loopRobotIdOf = ownership?.loopRobotId || accountLoopRobot;

  async function ownershipRefusal(req, loopId, log) {
    const verified = verifiedCallerFromRequest(req);
    let caller;
    try {
      // A verified request-local identity always wins. When the boundary is configured, a
      // forwarded x-amz-credentials header or a custom resolver is never an authorization source.
      caller = verified ? verified.accountId : callerBoundary ? null : accountIdOf(req);
    } catch {
      return ACCOUNT_SERVICE_UNAVAILABLE;
    }
    if (!caller) {
      // The source received this only after its security gateway populated credentials. Never turn
      // an absent forwarding header into authorization. A local-only test/sidecar may opt in, but
      // the peer check is on the socket address so X-Forwarded-For cannot manufacture loopback.
      return ownership?.allowLoopbackWithoutIdentity && isLoopbackRequest(req)
        ? null
        : BACKUP_AUTH_REQUIRED;
    }
    let robot;
    try { robot = await loopRobotIdOf(loopId); } catch { robot = undefined; }
    if (robot === undefined) {
      log?.warn?.('backup ownership denied; Account loop lookup unavailable', { loopId });
      return ACCOUNT_SERVICE_UNAVAILABLE;
    }
    if (String(robot) === caller) return null;
    return { statusCode: 403, message: 'Robot should belong to the loop', code: 'ROBOT_SHOULD_BELONG_TO_LOOP' };
  }

  return async function backupHandler({ req, res, body, op, log }) {
    const b = body || {};
    const loopId = b.loopId;
    switch (sourceOp(op)) {
      case 'new': {
        const invalid = loopIdValidationMessage(loopId);
        if (invalid) return void sendBoom(res, 422, invalid);
        const refusal = await ownershipRefusal(req, loopId, log);
        if (refusal) return void sendBoom(res, refusal.statusCode, refusal.message, refusal.code);
        const upload = store.signedBlobUrl(baseFor(req), 'PUT', loopId, store.newKey());
        return void sendAmz(res, 200, { uploadUrl: upload.url });
      }
      case 'list': {
        const invalid = loopIdValidationMessage(loopId);
        if (invalid) return void sendBoom(res, 422, invalid);
        const refusal = await ownershipRefusal(req, loopId, log);
        if (refusal) return void sendBoom(res, refusal.statusCode, refusal.message, refusal.code);
        const entries = store.list(loopId, b.max).map((e) => {
          const location = store.signedBlobUrl(baseFor(req), 'GET', loopId, e.key);
          return {
            modified: new Date(e.modified).toISOString(),
            etag: e.etag,
            size: e.size,
            location,
          };
        });
        return void sendAmz(res, 200, entries);
      }
      default:
        return void sendBoom(res, 404, `Method ${sourceOp(op)} not found.`);
    }
  };
}

/**
 * The blob endpoints the Backup.New/List URLs point at — registered on the entrypoint's HTTP
 * server (NOT the AWS-JSON prefix router). PUT stores the upload (raw body — opts out of the
 * common runner's JSON parsing) and answers with the ETag; GET streams it back for restore.
 */
export function backupBlobRoutes(store) {
  const ids = (url) => {
    const loopId = singleQueryParam(url, 'loopId');
    const key = singleQueryParam(url, 'key');
    return (loopId && key && SAFE.test(loopId) && SAFE.test(key)) ? { loopId, key } : null;
  };
  const denyBearer = (res) => {
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('forbidden');
  };

  const putBlob = async ({ req, res, url, log }) => {
    const id = ids(url);
    if (!id) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('bad loopId/key'); }
    const authorized = bearerIds(url, 'PUT', store.bearerSecret, store.now());
    if (!authorized || authorized.loopId !== id.loopId || authorized.key !== id.key) {
      req.resume?.();
      return void denyBearer(res);
    }
    const contentLength = declaredContentLength(req);
    if (contentLength !== null && contentLength > store.maxBytes) {
      req.resume?.();
      return void sendBoom(res, 413, `Payload content length greater than maximum allowed: ${store.maxBytes}`, 'PAYLOAD_TOO_LARGE');
    }
    try {
      const entry = await store.put(id.loopId, id.key, req);
      // The robot's uploader reads response.headers.etag and later asserts it == Backup.list's etag.
      log.info?.('backup blob stored', { loopId: id.loopId, key: id.key, size: entry.size, etag: entry.etag });
      res.writeHead(200, { ETag: entry.etag, 'content-length': 0 });
      res.end();
    } catch (err) {
      log.error?.('backup blob store failed', { error: err.message });
      if (!res.writableEnded) {
        if (err instanceof UploadTooLargeError || err?.statusCode === 413) {
          sendBoom(res, 413, err.message, 'PAYLOAD_TOO_LARGE');
        } else {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('store failed');
        }
      }
    }
  };
  putBlob.rawBody = true; // do not JSON-parse the binary upload

  const getBlob = async ({ res, url, log }) => {
    const id = ids(url);
    if (!id) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('bad loopId/key'); }
    const authorized = bearerIds(url, 'GET', store.bearerSecret, store.now());
    if (!authorized || authorized.loopId !== id.loopId || authorized.key !== id.key) return void denyBearer(res);
    const object = store.openObject(id.loopId, id.key);
    if (!object) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('no such backup'); }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': object.size,
      'cache-control': 'private, no-store',
    });
    try {
      await pipeline(object.stream, res);
    } catch (err) {
      log.warn?.('backup blob stream interrupted', { error: err.message });
    }
  };

  return { 'PUT /backup/blob': putBlob, 'GET /backup/blob': getBlob };
}
