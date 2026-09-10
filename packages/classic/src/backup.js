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
// "self-hosted packages" divergence — the URLs point back at THIS entrypoint (derived from the
// request Host, or ETCO_classic_publicUrl), and the blob is stored locally.
//
// DURABILITY: the index is a cache. The object files under
// ETCO_classic_backupDir / $TMPDIR/phx-backups ARE the source of truth and are re-indexed on a
// cache miss, so blob retrieval and `Backup.List` survive a process restart/crash. (The original
// survived the same way: S3 persisted, the service held no state.)
//
// RESTORE AUTHORIZATION is the signed URL itself in the source (an S3 presigned GET). Phoenix's
// self-hosted URL carries no signature, so possession of the URL is the only gate — recorded as
// part of the H-backup self-hosting divergence.

import { createWriteStream, createReadStream, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DefaultPort } from '@phoenix/contracts';
import { sendAmz } from './awsJson.js';

// Mirrors srv-backup-ws: keys are `MAGICK - now` so a lexical/numeric sort puts newest first.
const MAGICK = 9999999999999;
const URL_EXPIRATION_MS = 24 * 60 * 60 * 1000; // ctrl.js URL_EXPIRATION_SEC (24h)
const SAFE = /^[A-Za-z0-9_-]+$/;               // loopId/key live in URLs + file paths — no traversal
const ACCOUNT_TIMEOUT_MS = Number(process.env.ETCO_classic_backupAccountTimeoutMS) || 3000;

export class BackupStore {
  constructor(dir = process.env.ETCO_classic_backupDir || join(tmpdir(), 'phx-backups')) {
    this.dir = dir;
    this.index = new Map(); // loopId -> [{ key, etag, modified, size, file }]
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
      let names = [];
      try { names = readdirSync(join(this.dir, loopId)); } catch { names = []; }
      for (const name of names) {
        if (!SAFE.test(name)) continue;
        try {
          const file = join(this.dir, loopId, name);
          const stat = statSync(file);
          if (!stat.isFile()) continue;
          arr.push({ key: name, etag: `"${md5FileSync(file)}"`, modified: stat.mtimeMs, size: stat.size, file });
        } catch { /* skip an unreadable object rather than failing the whole loop */ }
      }
    }
    this.index.set(loopId, arr);
    return arr;
  }

  /** A fresh, unique, newest-sorts-first object key for a Backup.new call. */
  newKey() {
    return `${MAGICK - Date.now()}-${randomBytes(4).toString('hex')}`;
  }

  /** Stream an upload to disk, hashing as it goes; record + return the entry (with S3-style ETag). */
  async put(loopId, key, reqStream) {
    await mkdir(join(this.dir, loopId), { recursive: true });
    const file = join(this.dir, loopId, key);
    const hash = createHash('md5');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); },
    });
    await pipeline(reqStream, tap, createWriteStream(file));
    const entry = { key, etag: `"${hash.digest('hex')}"`, modified: Date.now(), size, file };
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
    return this._entries(loopId).find((e) => e.key === key) || null;
  }
}

/** Chunked md5 so re-indexing an object never buffers a whole blob in memory. */
function md5FileSync(file) {
  const hash = createHash('md5');
  const fd = openSync(file, 'r');
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

const REASON = { 403: 'Forbidden', 404: 'Not Found', 422: 'Unprocessable Entity' };

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
 * checks. Phoenix runs no security gateway, so an absent header means "no identity to check" and
 * the LAN-trust path applies — see DIVERGENCES (the gateway allow-lists are A-02's boundary).
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

/**
 * Resolve a loop's robot account id the way srv-backup-ws did: AccountClient.getLoop issues
 * `GET <account>/loop?loopId=<id>` (src/clients/account.client.js:10-18). Distinct return values
 * matter: a robot id (or `null` for "loop exists but has no robot") is compared against the
 * caller; `undefined` means "could not resolve" (service down / other error) and ownership is
 * not enforced rather than failing a legitimate backup on an unrelated outage.
 */
export async function accountLoopRobot(loopId) {
  try {
    const res = await fetch(`${accountBase()}/loop?loopId=${encodeURIComponent(loopId)}`, {
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
 * @param {{accountId?: (req) => string|null, loopRobotId?: (loopId) => Promise<string|null|undefined>}} [ownership]
 */
export function makeBackupHandler(store, baseFor, { ownership } = {}) {
  const accountIdOf = ownership?.accountId || credentialsAccountId;
  const loopRobotIdOf = ownership?.loopRobotId || accountLoopRobot;
  const blobUrl = (req, loopId, key) =>
    `${baseFor(req)}/backup/blob?loopId=${encodeURIComponent(loopId)}&key=${encodeURIComponent(key)}`;

  async function ownershipRefusal(req, loopId, log) {
    const caller = accountIdOf(req);
    if (!caller) return null; // no identity to check against (no security gateway) -> LAN trust
    let robot;
    try { robot = await loopRobotIdOf(loopId); } catch { robot = undefined; }
    if (robot === undefined) {
      log?.warn?.('backup ownership unresolved; allowing (account loop lookup failed)', { loopId });
      return null;
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
        return void sendAmz(res, 200, { uploadUrl: blobUrl(req, loopId, store.newKey()) });
      }
      case 'list': {
        const invalid = loopIdValidationMessage(loopId);
        if (invalid) return void sendBoom(res, 422, invalid);
        const refusal = await ownershipRefusal(req, loopId, log);
        if (refusal) return void sendBoom(res, refusal.statusCode, refusal.message, refusal.code);
        const entries = store.list(loopId, b.max).map((e) => ({
          modified: new Date(e.modified).toISOString(),
          etag: e.etag,
          size: e.size,
          location: { expires: Date.now() + URL_EXPIRATION_MS, url: blobUrl(req, loopId, e.key) },
        }));
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
    const loopId = url.searchParams.get('loopId');
    const key = url.searchParams.get('key');
    return (loopId && key && SAFE.test(loopId) && SAFE.test(key)) ? { loopId, key } : null;
  };

  const putBlob = async ({ req, res, url, log }) => {
    const id = ids(url);
    if (!id) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('bad loopId/key'); }
    try {
      const entry = await store.put(id.loopId, id.key, req);
      // The robot's uploader reads response.headers.etag and later asserts it == Backup.list's etag.
      log.info?.('backup blob stored', { loopId: id.loopId, key: id.key, size: entry.size, etag: entry.etag });
      res.writeHead(200, { ETag: entry.etag, 'content-length': 0 });
      res.end();
    } catch (err) {
      log.error?.('backup blob store failed', { error: err.message });
      if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('store failed'); }
    }
  };
  putBlob.rawBody = true; // do not JSON-parse the binary upload

  const getBlob = async ({ res, url, log }) => {
    const id = ids(url);
    const entry = id && store.find(id.loopId, id.key);
    if (!entry) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('no such backup'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.size });
    try {
      await pipeline(createReadStream(entry.file), res);
    } catch (err) {
      log.warn?.('backup blob stream interrupted', { error: err.message });
    }
  };

  return { 'PUT /backup/blob': putBlob, 'GET /backup/blob': getBlob };
}
