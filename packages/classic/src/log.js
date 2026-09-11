// `log` service (Log_20150309) + `logadmin` (Log_20150309.SetLevel) — robot log/telemetry
// ingestion. Rebuilt against the archived source: jiborobot/srv-log-ws
// (src/handlers/log.handler.ts, src/controllers/{log,kinesis}.ctrl.ts, src/errors/log.ts)
// read at the pvindex archive HEAD d72f82d, plus the API models
// apis/log-2015-03-09.normal.json and apis/logadmin-2015-03-09.normal.json (both share the
// X-Amz-Target prefix `Log_20150309`, like Account/AccountAdmin under A-03).
//
// Wire ops (7):
//   PutEvents            events[]  -> { result: "Successfully added events" }        sync ack
//   PutEventsAsync       kind/serial -> { contentEncoding:"gzip", uploadUrl }      async ack
//   NewKinesisCredentials           -> { credentials, region, streamName }         sync ack
//   PutBinary   (raw body PUT)      -> { path, url }                               sync ack
//   PutBinaryAsync                  -> { path, url, uploadUrl }                    async ack
//   PutAsrBinary                    -> { bucketName, key, metadata, uploadUrl }    async ack
//   SetLevel (admin)                -> { result: "Command accepted" }              sync ack
//
// Validation mirrors the source's Joi rules (unknown members allowed, required fields, enum
// checks, and Joi.string()'s rejection of the empty string); failures are the source's
// Boom.badData -> HTTP 422 and unknown ops are Boom.notFound -> HTTP 404. Both are emitted
// as the source's raw Boom payload
// `{statusCode, error, message}` — with no error `code` — because that is what the pinned
// client read (`extractError` -> body.error = the HTTP reason phrase). The source's codified
// REQUEST_THROTTLED (429) / ROBOT_ONLY (403) / AUTHORIZED_UNDER_ADMIN (401) errors keep their
// codes/status through the shared AWS envelope. See `sendLogError`.
//
// The original returned S3 presigned URLs and wrote blobs to an S3 bucket. Phoenix has
// no S3: uploadUrl/url point back at THIS entrypoint (a local PUT/GET sink, same pattern
// as Backup's self-hosted blobs), and the events/binary/ASR payloads are stored under a
// process-lifetime local dir (default `$TMPDIR/phx-logs`). The dead S3 bucket name is
// replaced by the constant `VIRTUAL_BUCKET` in the `path`/`bucketName` fields. The source
// had no server-side retention (S3 lifecycle owned it); Phoenix likewise never deletes.
// (DIVERGENCES: self-hosted upload sink, no SNS fan-out on SetLevel, dead Kinesis.)

import { createReadStream, createWriteStream, appendFileSync, mkdirSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATUS_CODES } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sendAmz, sendAmzError, AMZ_JSON } from './awsJson.js';

const NPM_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
const KINDS = ['HEALTH', 'LOG'];
const BUCKET_PATH = 'log-binary';
const ASR_BUCKET_PATH = 'asr-binary';
const ASYNC_EVENTS_BUCKET_PATH = 'log-async';
const VIRTUAL_BUCKET = 'log'; // replacement for the dead S3 bucket name in path/bucketName
const HUNDRED_PERCENT = 10000;

// The source hands these out from src/errors/log.ts + server errors.ts (via createWithCode).
const REQUEST_THROTTLED = { code: 'REQUEST_THROTTLED', message: 'Request throttled due to server rules.', statusCode: 429 };
const ROBOT_ONLY = { code: 'ROBOT_ONLY', message: 'Request forbidden. Only robotd are allowed.', statusCode: 403 };
const AUTHORIZED_UNDER_ADMIN = { code: 'AUTHORIZED_UNDER_ADMIN', message: 'Must be authorized under admin account', statusCode: 401 };
const INTERNAL = { code: 'INTERNAL', message: 'Internal server error', statusCode: 500 };

const boomBadData = (message) => ({ boom: true, statusCode: 422, message });
const boomNotFound = (op) => ({ boom: true, statusCode: 404, message: `Method ${op} not found.` });

/**
 * The source surfaced validation + unknown-method failures as raw Boom payloads —
 * `{ statusCode, error, message }` with `error` = the HTTP reason phrase and NO error `code`.
 * The pinned client's `lib/protocol/json.js:extractError` resolves the code as
 * `body.__type || body.code || body.error` (falling back to `x-amzn-errortype`), so on the
 * source the client-visible `err.code` was `Unprocessable Entity` (422) / `Not Found` (404).
 *
 * The shared `sendAmzError()` in awsJson.js stamps `__type` + `x-amzn-errortype` and is used
 * by every classic service (router/stubs/robot/push/key/backup/notification), so rewriting it
 * would change their wire contract. This Boom shape is therefore reproduced HERE, scoped to
 * the Log surface only; every codified Log error (429/403/401/500) still uses the shared
 * AWS-code envelope because those codes match the source.
 */
function sendLogError(res, err) {
  if (!err || !err.boom) return sendAmzError(res, err);
  const body = JSON.stringify({ statusCode: err.statusCode, error: STATUS_CODES[err.statusCode], message: err.message });
  res.writeHead(err.statusCode, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The Joi failure clause for a `Joi.string()` member, or null when it passes — the wire
 * behaviour and message text of the pinned handler's schemas, not just "is a string":
 * joi@10 rejects the EMPTY STRING for `Joi.string()` ("is not allowed to be empty") unless
 * the schema calls `.allow("")`; the only Log member that does is SetLevel's `namespace`.
 * A missing value is "is required" for a `.required()` member and passes otherwise.
 */
const stringClause = (v, required = false) => {
  if (v === undefined) return required ? 'is required' : null;
  if (typeof v !== 'string') return 'must be a string';
  if (v === '') return 'is not allowed to be empty';
  return null;
};
const stringMemberError = (name, v, required = false) => {
  const clause = stringClause(v, required);
  return clause ? boomBadData(`child "${name}" fails because ["${name}" ${clause}]`) : null;
};

function credentialsFrom(req) {
  try {
    const parsed = JSON.parse(req?.headers?.['x-amz-credentials'] || '');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---- durable local sink ----------------------------------------------------

/**
 * Local sink standing in for the source's S3 bucket. Keys are the source's S3 keys verbatim
 * (log-binary/…, asr-binary/…, log-async/…); each object is a file under `dir`. Nothing is
 * evicted here (the source had no server-side retention — S3 lifecycle owned it), so objects
 * stay retrievable. The in-memory index is only a cache: a miss falls back to the object file
 * on disk, so objects survive a process restart (the source's S3 objects did too).
 */
export class LogStore {
  constructor(dir = process.env.ETCO_classic_logDir || join(tmpdir(), 'phx-logs')) {
    this.dir = dir;
    this.index = new Map(); // key -> { key, size, etag, file, modified }
  }

  /** Stream an upload to disk under a source-shaped key; record and return the entry. */
  async put(key, reqStream) {
    const safe = safeKey(key);
    const file = join(this.dir, safe);
    await mkdir(dirname(file), { recursive: true });
    const hash = createHash('md5');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); },
    });
    await pipeline(reqStream, tap, createWriteStream(file));
    const entry = { key: safe, size, etag: `"${hash.digest('hex')}"`, file, modified: Date.now() };
    this.index.set(safe, entry);
    return entry;
  }

  find(key) {
    const safe = safeKey(key);
    const cached = this.index.get(safe);
    if (cached) return cached;
    // The index is in memory only, so a freshly started process (or any process that did not
    // accept the PUT) has an empty index even though the object file survived on disk. The
    // file IS the durable source of truth: rebuild the entry from it so `GET /log/blob` keeps
    // working across restarts. On-disk layout is unchanged — we add no sidecar/companion files.
    return this.rebuild(safe);
  }

  /** Reconstruct (and cache) an index entry from an object file left by an earlier process. */
  rebuild(safe) {
    const file = join(this.dir, safe);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return null; // never stored, or not on this dir — a genuine miss
    }
    if (!stat.isFile()) return null;
    const entry = { key: safe, size: stat.size, etag: `"${md5FileSync(file)}"`, file, modified: stat.mtimeMs };
    this.index.set(safe, entry);
    return entry;
  }

  /** Append one ingested event as a JSONL line (the source logged an event per record). */
  logEvent(event) {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify({ ts: Date.now(), ...event }) + '\n');
    } catch {
      /* a log sink write must never take the POST/upload down */
    }
  }
}

/** Chunked md5 so rebuilding an index entry never buffers a whole blob in memory. */
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

function safeKey(key) {
  const parts = String(key).split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..' || part.includes('\\') || part.includes('\0')) {
      throw new Error(`unsafe log object key: ${key}`);
    }
  }
  if (parts.length === 0 || !/^[A-Za-z0-9._/#:=,-]+$/.test(String(key))) {
    throw new Error(`unsafe log object key: ${key}`);
  }
  return parts.join('/');
}

// ---- handler ---------------------------------------------------------------

/**
 * @param {LogStore} store
 * @param {(req) => string} [baseFn] public URL of this entrypoint (like Backup's baseFor)
 */
export function makeLogHandler(store, baseFn) {
  const baseFor = (req) => (baseFn ? baseFn(req) : fallbackBase(req));
  const putUrl = (req, key) => `${baseFor(req)}/log/upload?key=${encodeURIComponent(key)}`;
  const blobUrl = (req, key) => `${baseFor(req)}/log/blob?key=${encodeURIComponent(key)}`;

  const probability = clampProbability(process.env.ETCO_log_probability);
  const selected = () => probability > Math.random();
  const selectForAsr = (trackingId) => hashCode(trackingId) % HUNDRED_PERCENT <= probability * HUNDRED_PERCENT;

  return function logHandler({ req, res, body, op, log }) {
    const b = body || {};
    switch (op.toLowerCase()) {
      case 'putevents': {
        if (!Array.isArray(b.events)) {
          return void sendLogError(res, boomBadData('child "events" fails because ["events" is required]'));
        }
        const badDevice = stringMemberError('deviceId', b.deviceId);
        if (badDevice) return void sendLogError(res, badDevice);
        const badTracking = stringMemberError('trackingId', b.trackingId);
        if (badTracking) return void sendLogError(res, badTracking);
        const { id: accountId, friendlyId: robotId } = credentialsFrom(req);
        for (const event of b.events) {
          if (b.deviceId) event.deviceId = b.deviceId;
          if (robotId) event.robotId = robotId;
          if (b.trackingId) event.trackingId = b.trackingId;
          if (accountId) event.accountId = accountId;
          if (!event.level || !NPM_LEVELS.includes(event.level)) {
            // srv-log-ws: a message mentioning "error" -> error, otherwise info
            event.level = event.message && event.message.includes('error') ? 'error' : 'info';
          }
          store.logEvent({ level: event.level, message: event.message, ...event });
        }
        return void sendAmz(res, 200, { result: 'Successfully added events' });
      }

      case 'puteventsasync': {
        if (typeof b.kind !== 'string' || !KINDS.includes(b.kind)) {
          return void sendLogError(res, boomBadData('child "kind" fails because ["kind" must be one of [HEALTH, LOG]]'));
        }
        const badSerial = stringMemberError('serial', b.serial, true);
        if (badSerial) return void sendLogError(res, badSerial);
        if (!selected()) return void sendAmzError(res, REQUEST_THROTTLED);
        const { id: accountId, friendlyId: robotId } = credentialsFrom(req);
        const date = new Date();
        const day = `year=${date.getFullYear()}/month=${date.getMonth()}/day=${date.getDate()}`;
        const robot = `robot=${robotId || ''}/serial=${b.serial}`;
        const key = `${ASYNC_EVENTS_BUCKET_PATH}/${robot}/account=${accountId || ''}/${day}/kind=${b.kind}/${date.getTime()}.gz`;
        return void sendAmz(res, 200, { contentEncoding: 'gzip', uploadUrl: putUrl(req, key) });
      }

      case 'newkinesiscredentials': {
        const { friendlyId } = credentialsFrom(req);
        if (!friendlyId) return void sendAmzError(res, ROBOT_ONLY);
        // Kinesis is dead and Phoenix has no AWS STS. Hand back the documented shape
        // with an already-expired timestamp so the robot's telemetry degrades cleanly
        // to "no streaming" instead of hard-failing on a missing member.
        return void sendAmz(res, 200, {
          credentials: {
            AccessKeyId: '',
            Expiration: '1970-01-01T00:00:00.000Z',
            SecretAccessKey: '',
            SessionToken: '',
          },
          region: '',
          streamName: '',
        });
      }

      case 'putbinary': {
        // RAW binary body (payload stream); x-tracking-id arrives as a header. The source's
        // @validateHeaders({'x-tracking-id': Joi.string()}) runs before the throttle check, so
        // an absent header passes but an empty/non-string one is the usual Joi.string() 422.
        const badHeader = stringMemberError('x-tracking-id', req?.headers?.['x-tracking-id']);
        if (badHeader) return void sendLogError(res, badHeader);
        const trackingId = req?.headers?.['x-tracking-id'] || '';
        if (!selected()) return sendAmzError(res, REQUEST_THROTTLED);
        const { id: accountId } = credentialsFrom(req);
        const binaryPath = `${accountId || ''}/${trackingId}/${randomUUID()}`;
        return store.put(`${BUCKET_PATH}/${binaryPath}`, req)
          .then((entry) => sendAmz(res, 200, { path: `/${VIRTUAL_BUCKET}/${entry.key}`, url: blobUrl(req, entry.key) }))
          .catch((err) => {
            log?.warn?.('log binary store failed', { error: err.message });
            if (!res.writableEnded) sendAmzError(res, INTERNAL);
          });
      }

      case 'putbinaryasync': {
        const badTrackingId = stringMemberError('trackingId', b.trackingId);
        if (badTrackingId) return void sendLogError(res, badTrackingId);
        if (!selected()) return void sendAmzError(res, REQUEST_THROTTLED);
        const { id: accountId } = credentialsFrom(req);
        const trackingIdPart = b.trackingId ? `${b.trackingId}/` : '';
        const key = `${BUCKET_PATH}/${accountId || ''}/${trackingIdPart}${randomUUID()}`;
        return void sendAmz(res, 200, { path: `/${VIRTUAL_BUCKET}/${key}`, url: blobUrl(req, key), uploadUrl: putUrl(req, key) });
      }

      case 'putasrbinary': {
        const badTrackingId = stringMemberError('trackingId', b.trackingId, true);
        if (badTrackingId) return void sendLogError(res, badTrackingId);
        if (b.metadata !== undefined && !plainObject(b.metadata)) {
          return void sendLogError(res, boomBadData('child "metadata" fails because ["metadata" must be an object]'));
        }
        if (!selectForAsr(b.trackingId)) return void sendAmzError(res, REQUEST_THROTTLED);
        const { id: accountId } = credentialsFrom(req);
        const date = new Date();
        const day = `year=${date.getFullYear()}/month=${date.getMonth()}/day=${date.getDate()}`;
        const key = `${ASR_BUCKET_PATH}/${day}/accountId=${accountId || ''}/trackingId=${b.trackingId}/${date.getTime()}.bin`;
        return void sendAmz(res, 200, {
          bucketName: VIRTUAL_BUCKET,
          key,
          metadata: b.metadata || {},
          uploadUrl: putUrl(req, key),
        });
      }

      case 'setlevel': {
        const { isAdmin } = credentialsFrom(req);
        if (!isAdmin) return void sendAmzError(res, AUTHORIZED_UNDER_ADMIN);
        if (!Array.isArray(b.friendlyIds)) return void sendLogError(res, boomBadData('child "friendlyIds" fails because ["friendlyIds" is required]'));
        if (!Array.isArray(b.namespaces)) return void sendLogError(res, boomBadData('child "namespaces" fails because ["namespaces" is required]'));
        for (const id of b.friendlyIds) {
          // FriendlyId is Joi.string(): non-strings and the empty string are rejected.
          if (typeof id !== 'string' || id === '') {
            return void sendLogError(res, boomBadData('child "friendlyIds" fails because ["friendlyIds" must only contain non-empty strings]'));
          }
        }
        // Joi's VerbosityLevel has NO required members, so `{}`, `{namespace}` and `{level}`
        // are all valid upstream (200); a member that IS present is still type/enum checked.
        // `namespace` is Joi.string().allow('') upstream, so the EMPTY STRING is a valid
        // namespace (only non-strings are rejected); `level` has no allow(''), so '' is not
        // in the enum and is rejected. Unknown extra members are allowed (validatePayload
        // runs Joi with { allowUnknown: true }), so they are not checked here either.
        for (const ns of b.namespaces) {
          if (!plainObject(ns)
            || (ns.namespace !== undefined && typeof ns.namespace !== 'string')
            || (ns.level !== undefined && !NPM_LEVELS.includes(ns.level))) {
            return void sendLogError(res, boomBadData('child "namespaces" fails because ["namespaces" items must be {namespace?, level?}]'));
          }
        }
        log?.info?.('SetLevel', { namespaces: b.namespaces, friendlyIds: b.friendlyIds });
        // The source also published RobotVerbosityChanged via SNS (DIVERGENCE: no SNS).
        return void sendAmz(res, 200, { result: 'Command accepted' });
      }

      default:
        return void sendLogError(res, boomNotFound(op));
    }
  };
}

// ---- routes behind the upload/blob URLs ------------------------------------

/**
 * The PUT/GET endpoints the uploadUrl/blob URL fields point at. PUT stores the raw
 * upload (opts out of the common runner's JSON parsing), GET streams it back.
 */
export function logHttpRoutes(store) {
  const putBlob = async ({ req, res, url, log }) => {
    const key = keyFromUrl(url, 'key');
    if (!key) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('bad key'); }
    try {
      const entry = await store.put(key, req);
      log?.info?.('log object stored', { key: entry.key, size: entry.size, etag: entry.etag });
      res.writeHead(200, { ETag: entry.etag, 'content-length': 0 });
      res.end();
    } catch (err) {
      log?.warn?.('log object store failed', { error: err.message });
      if (!res.writableEnded) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('bad key'); }
    }
  };
  putBlob.rawBody = true; // do not JSON-parse the binary upload

  const getBlob = async ({ res, url, log }) => {
    const key = keyFromUrl(url, 'key');
    const entry = key && store.find(key);
    if (!entry) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('no such log object'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.size });
    try {
      await pipeline(createReadStream(entry.file), res);
    } catch (err) {
      log?.warn?.('log object stream interrupted', { error: err.message });
    }
  };

  return { 'PUT /log/upload': putBlob, 'GET /log/blob': getBlob };
}

function keyFromUrl(url, name) {
  try {
    return url?.searchParams?.get(name) || '';
  } catch {
    return '';
  }
}

function fallbackBase(req) {
  return process.env.ETCO_classic_publicUrl
    || `${req?.socket?.encrypted ? 'https' : 'http'}://${(req?.headers && req.headers.host) || 'localhost'}`;
}

function clampProbability(value) {
  let p = value === undefined || value === '' ? 1 : Number.parseFloat(value);
  if (!Number.isFinite(p)) p = 1;
  if (p > 1) p = 1;
  if (p < 0) p = 0;
  return p;
}

// java.lang.String.hashCode, exactly as srv-log-ws: hash % 10000 <= probability*10000
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (31 * h + str.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}