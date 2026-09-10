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
// Validation mirrors the source's Joi rules exactly (unknown members allowed, required
// fields, enum checks); failures are the source's Boom.badData -> HTTP 422, and the
// source's REQUEST_THROTTLED (429) / ROBOT_ONLY (403) / AUTHORIZED_UNDER_ADMIN (401)
// errors keep their codes/status. The original sat behind the AWS-JSON envelope and the
// client SDK read `x-amz-errortype`; Phoenix keeps its __type+header convention so the
// robot's client sees a normal AWS error.
//
// The original returned S3 presigned URLs and wrote blobs to an S3 bucket. Phoenix has
// no S3: uploadUrl/url point back at THIS entrypoint (a local PUT/GET sink, same pattern
// as Backup's self-hosted blobs), and the events/binary/ASR payloads are stored under a
// process-lifetime local dir (default `$TMPDIR/phx-logs`). The dead S3 bucket name is
// replaced by the constant `VIRTUAL_BUCKET` in the `path`/`bucketName` fields. The source
// had no server-side retention (S3 lifecycle owned it); Phoenix likewise never deletes.
// (DIVERGENCES: self-hosted upload sink, no SNS fan-out on SetLevel, dead Kinesis.)

import { createReadStream, createWriteStream, appendFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sendAmz, sendAmzError } from './awsJson.js';

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

const boomBadData = (message) => ({ code: 'ValidationException', message, statusCode: 422 });
const boomNotFound = (op) => ({ code: 'NotFoundException', message: `Method ${op} not found.`, statusCode: 404 });

const validString = (v) => v === undefined || typeof v === 'string';
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
 * Process-lifetime local sink standing in for the source's S3 bucket. Keys are the
 * source's S3 keys verbatim (log-binary/…, asr-binary/…, log-async/…); each object is a
 * file under `dir`. Nothing is evicted here (the source had no server-side retention —
 * S3 lifecycle owned it), so objects stay retrievable for the life of the server run.
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
    return this.index.get(safe) || null;
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
          return void sendAmzError(res, boomBadData('child "events" fails because ["events" is required]'));
        }
        if (!validString(b.deviceId)) return void sendAmzError(res, boomBadData('child "deviceId" fails because ["deviceId" must be a string]'));
        if (!validString(b.trackingId)) return void sendAmzError(res, boomBadData('child "trackingId" fails because ["trackingId" must be a string]'));
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
          return void sendAmzError(res, boomBadData('child "kind" fails because ["kind" must be one of [HEALTH, LOG]]'));
        }
        if (typeof b.serial !== 'string') {
          return void sendAmzError(res, boomBadData('child "serial" fails because ["serial" is required]'));
        }
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
        // RAW binary body (payload stream); x-tracking-id arrives as a header.
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
        if (!validString(b.trackingId)) return void sendAmzError(res, boomBadData('child "trackingId" fails because ["trackingId" must be a string]'));
        if (!selected()) return void sendAmzError(res, REQUEST_THROTTLED);
        const { id: accountId } = credentialsFrom(req);
        const trackingIdPart = b.trackingId ? `${b.trackingId}/` : '';
        const key = `${BUCKET_PATH}/${accountId || ''}/${trackingIdPart}${randomUUID()}`;
        return void sendAmz(res, 200, { path: `/${VIRTUAL_BUCKET}/${key}`, url: blobUrl(req, key), uploadUrl: putUrl(req, key) });
      }

      case 'putasrbinary': {
        if (b.trackingId !== undefined && typeof b.trackingId !== 'string') {
          return void sendAmzError(res, boomBadData('child "trackingId" fails because ["trackingId" must be a string]'));
        }
        if (typeof b.trackingId === 'undefined' || b.trackingId === '') {
          return void sendAmzError(res, boomBadData('child "trackingId" fails because ["trackingId" is required]'));
        }
        if (b.metadata !== undefined && !plainObject(b.metadata)) {
          return void sendAmzError(res, boomBadData('child "metadata" fails because ["metadata" must be an object]'));
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
        if (!Array.isArray(b.friendlyIds)) return void sendAmzError(res, boomBadData('child "friendlyIds" fails because ["friendlyIds" is required]'));
        if (!Array.isArray(b.namespaces)) return void sendAmzError(res, boomBadData('child "namespaces" fails because ["namespaces" is required]'));
        for (const id of b.friendlyIds) {
          if (typeof id !== 'string') return void sendAmzError(res, boomBadData('child "friendlyIds" fails because ["friendlyIds" must only contain strings]'));
        }
        for (const ns of b.namespaces) {
          if (!plainObject(ns) || typeof ns.namespace !== 'string' || !NPM_LEVELS.includes(ns.level)) {
            return void sendAmzError(res, boomBadData('child "namespaces" fails because ["namespaces" must contain {namespace, level}]'));
          }
        }
        log?.info?.('SetLevel', { namespaces: b.namespaces, friendlyIds: b.friendlyIds });
        // The source also published RobotVerbosityChanged via SNS (DIVERGENCE: no SNS).
        return void sendAmz(res, 200, { result: 'Command accepted' });
      }

      default:
        return void sendAmzError(res, boomNotFound(op));
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