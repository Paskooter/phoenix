// `voicetraining` service — the robot's voice-sample enrollment/training store. Until now Phoenix
// had NO `/^voicetraining/i` classic route, so every VoiceTraining target answered
// UnknownOperationException 400 (A-01 candidate, "absent-no-classic-service"; stubs.js header).
//
// THE PINNED SOURCE (read through the Jibo archive MCP, cited by file):
//   jibo:server/voice-ws@a0ec047a86d6811176d0f05a6cce5a660a2cadd8
//     server.js                              the Hapi POST / dispatcher
//     lib/handlers/index.js                  handler exports (EXACTLY two)
//     lib/handlers/base.handler.js           parseCredentials (JSON x-amz-credentials; {} on error)
//     lib/handlers/upload-voice-sample.handler.js   UploadVoiceTrainingHandler
//     lib/handlers/list-voice-trainings.handler.js  ListVoiceTrainingsHandler
//     lib/client.js                          `client` = jibo-server-client -> the security gateway
//   jibo:jiborobot/srv-voice-ws-archived@0e8dc870beaad8caf1dc9ae415a5d250a580b570
//     server.js, lib/handlers/index.js       byte-identical dispatcher + the SAME two exports
//   jiborobot/srv-backup-ws-archived (the `client.Backup` the pinned handlers call)
//     lib/handlers/backup.handler.js         CreateBackup / ListBackups / GetBackup / RemoveBackup
//     lib/controllers/backup.ctrl.js         create (replace-same-path) / listBackups (prefix)
//     lib/schemes/backup.js                  {accountId, created, path} + a `url` S3 virtual
//   jiborobot/srv-jibo-server-client (historical SDK models — `apis/`)
//     voicetraining-2015-06-17.normal.json   apiVersion 2015-10-20, prefix VoiceTraining_20151020
//     voicetraining-2015-11-03.normal.json   apiVersion 2015-11-03, prefix VoiceTraining_20151103
//     voicetraining-2016-01-03.normal.json   apiVersion 2016-01-03, prefix VoiceTraining_20160103
//   https://pvindex.org/docs/latest/Jibo/VoiceTraining.html
//     identifier "voicetraining", API version 2016-01-03, getFile/listFiles/removeFile/uploadFile
//
// THE VERSIONED CONTRACT (resolved here, explicitly — this is what A-20 acceptance 1 asks for):
//   Three historical SDK models declare TEN (prefix, operation) pairs:
//     VoiceTraining_20151020: UploadVoiceTraining, ListVoiceTrainings
//     VoiceTraining_20151103: UploadFile, RemoveFile, ListFiles, GetFile
//     VoiceTraining_20160103: UploadFile, RemoveFile, ListFiles, GetFile
//   The pinned dispatcher does NOT dispatch by prefix. server.js takes
//     `var method = target.split('.')[1];
//      var Handler = handlers[method] || handlers[method + 'Handler'];`
//   and only `UploadVoiceTrainingHandler` / `ListVoiceTrainingsHandler` are exported. Therefore the
//   DEPLOYED service serves exactly the two 2015-10-20 operation NAMES under ANY VoiceTraining*
//   prefix, and every file operation — the whole 2015-11-03 and 2016-01-03 surface — is NOT served:
//   it answers `Boom.notFound('Method not found in VoiceTraining, method <Method>')` (404). The
//   alias reconciliation is therefore the observed 404, never an invented UploadFile handler.
//   (The four file-operation names are identical in both later models, so the 10 pairs collapse to
//   6 distinct method names; VOICE_TRAINING_OPERATIONS/UNSUPPORTED_OPERATIONS record both.)
//
// THE WIRE (`<Prefix>.<Operation>`, op = the segment after the LAST dot):
//   * The gateway (jiborobot/srv-security-gw@43a692fe src/controllers/auth.ctrl.ts) lists NO
//     VoiceTraining target in unauthorizedMethods/unsignedMethods/unactiveMethods, so an unsigned
//     call is rejected with MISSING_AUTH_HEADER 401 before the handler runs (A-01 attributes).
//   * UploadVoiceTraining validates `{ key: Joi.string().required(), body: Joi.required() }`; a
//     failure is `Boom.badRequest(err.message)` -> Hapi payload {statusCode, error, message}, 400.
//   * ListVoiceTrainings has NO validate (its constructor sets nothing) -> Joi is skipped.
//   * A successful call replies the raw `client.Backup` result: the legacy Backup document
//     `{_id, accountId, created, path}` (schemes/backup.js, toJSON with the `url` virtual).
//   * A failing Backup hop is `Boom.wrap(err, 400)` -> 400 with the Backup error's message (e.g.
//     'Only account can create backup'). The source calls reply() twice on error (no `return`);
//     Phoenix answers the single 400 that Hapi's first reply produced.
//   * The source Hapi route caps the request entity at maxBytes 100000000 (100 MB).
//
// DEAD DEPENDENCY (explicit seam, never faked): `client.Backup` is an HTTP hop through the security
// gateway to the legacy Backup service (`server/backup-ws-archived`). Reproduced by an injected
// `backup` seam `{ createBackup({path,body,credentials,base}), listBackups({path,credentials,base}) }`.
// The DEFAULT seam is `voiceTrainingBackup(store)` — an in-process read/write of this service's own
// durable store (there is no second HTTP hop here), the same posture Jot takes for Media. The
// source's S3-presigned `url` virtual becomes a self-hosted blob URL (see blob route below), exactly
// like backup.js's documented S3 substitution.
//
// State: one atomically replaced JSON file holds the legacy Backup records (with the uploaded bytes
// inline, base64), so a training uploaded before a restart is still listed after it.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { sendAmz, sendAmzError, accessKeyIdFromAuth } from './awsJson.js';
import { MISSING_AUTH_HEADER } from './person.js';

/** The ONLY operations the pinned dispatcher resolves (lib/handlers/index.js exports). */
export const VOICE_TRAINING_OPERATIONS = ['uploadvoicetraining', 'listvoicetrainings'];

/**
 * The operations the three historical models declare that the pinned dispatcher CANNOT resolve
 * (no `...Handler` export). Each answers Boom.notFound, observed from server.js's own fallback.
 */
export const VOICE_TRAINING_UNSUPPORTED_OPERATIONS = ['uploadfile', 'removefile', 'listfiles', 'getfile'];

/**
 * Every observed VoiceTraining target prefix. The dispatcher ignores the prefix (it splits on the
 * dot and dispatches by OPERATION NAME), so all three resolve to this one service for the two
 * supported operations. Recorded for the versioned contract; the SDK model each one comes from:
 *   VoiceTraining_20151020  apis/voicetraining-2015-06-17.normal.json (metadata apiVersion 2015-10-20)
 *   VoiceTraining_20151103  apis/voicetraining-2015-11-03.normal.json
 *   VoiceTraining_20160103  apis/voicetraining-2016-01-03.normal.json
 */
export const VOICE_TRAINING_TARGET_PREFIXES = ['VoiceTraining_20151020', 'VoiceTraining_20151103', 'VoiceTraining_20160103'];

/** upload-voice-sample.handler.js: `path: '/voiceTraining/' + request.payload.key`. */
export const VOICE_TRAINING_PATH_ROOT = '/voiceTraining/';

/** server.js `payload: { …, maxBytes: 100000000 }` — the Hapi request-entity cap. */
export const VOICE_TRAINING_MAX_BYTES = 100000000;

/** schemes/backup.js `backupSchema` members (toJSON keeps `_id`; the scheme has no id transform). */
export const VOICE_TRAINING_RECORD_FIELDS = ['_id', 'accountId', 'created', 'path'];

/** The self-hosted blob route the record `url` points at (the S3 GET substitution). */
export const VOICE_TRAINING_BLOB_ROUTE = '/voiceTraining/blob';

/** backup.ctrl.js `Boom.unauthorized('Only account can create backup')`. */
export const VOICE_TRAINING_ACCOUNT_REQUIRED = 'Only account can create backup';

// ---- Hapi/Boom envelopes (the pinned service is Hapi, not the AWS-JSON front door) -------------

const REASON = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 413: 'Request Entity Too Large', 500: 'Internal Server Error' };

/** Hapi/Boom response payload: `{statusCode, error, message}` (an optional explicit `code` last). */
function sendBoom(res, statusCode, message, code) {
  const payload = { statusCode, error: REASON[statusCode] || 'Error', message };
  if (code) payload.code = code;
  const body = JSON.stringify(payload);
  res.removeHeader?.('x-powered-by');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// ---- Joi 6 validation for the one validating handler -------------------------------------------

const joiString = (field, value, { required = false } = {}) => {
  if (value === undefined || value === null) {
    return required ? `child "${field}" fails because ["${field}" is required]` : null;
  }
  if (typeof value !== 'string') return `child "${field}" fails because ["${field}" must be a string]`;
  if (value.length === 0) return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  return null;
};

const joiRequired = (field, value) =>
  (value === undefined || value === null ? `child "${field}" fails because ["${field}" is required]` : null);

/** upload-voice-sample.handler.js `this.validate = { key: Joi.string().required(), body: Joi.required() }`.
 *  Joi validates in schema key order, so `key` is reported before `body`. */
export const VOICE_TRAINING_VALIDATORS = {
  uploadvoicetraining: (body) => joiString('key', body.key, { required: true }) || joiRequired('body', body.body),
};

// ---- identity (the gateway's verified credentials) ---------------------------------------------

/** base.handler.js `parseCredentials`: `JSON.parse(request.headers['x-amz-credentials'])`, {} on error. */
export function parseCredentials(req) {
  try {
    const parsed = JSON.parse(req?.headers?.['x-amz-credentials'] || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The credentials the source forwarded to `client.Backup`. The archived Backup service reads
 * `credentials._id` while the newer srv-backup-ws reads `credentials.id` (a version discrepancy
 * reproduced by accepting both). The gateway populated the header from the verified signature; when
 * only a SigV4 Authorization is present (no header) the resolved accountId stands in for it, which
 * is the one thing the dead gateway did that Phoenix must not lose.
 */
export function backupCredentials(req, accountId) {
  const parsed = parseCredentials(req);
  const id = parsed._id ?? parsed.id ?? accountId;
  return { ...parsed, _id: id, id };
}

/** The caller identity the gateway verified: the x-amz-credentials id, else the SigV4 accessKeyId. */
export function voiceTrainingAccountId(req) {
  const parsed = parseCredentials(req);
  if (parsed.id !== undefined && parsed.id !== null && String(parsed.id).length > 0) return String(parsed.id);
  if (parsed._id !== undefined && parsed._id !== null && String(parsed._id).length > 0) return String(parsed._id);
  return accessKeyIdFromAuth(req);
}

// ---- durable store (the legacy Backup collection, Mongoose -> one JSON file) --------------------

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** Mongo ObjectIds are 12 random bytes as 24 hex chars (the source Backup `_id`). */
function newRecordId() { return randomBytes(12).toString('hex'); }

/** The source's dataStream body -> the bytes we persist. A JSON string body is stored verbatim;
 *  any other JSON value is stored as its serialization (Phoenix has no multipart entity here). */
function toBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function normalizeRecord(record) {
  return {
    id: String(record._id ?? record.id),
    seq: Number.isFinite(record.seq) ? record.seq : 0,
    accountId: record.accountId === undefined || record.accountId === null ? undefined : String(record.accountId),
    created: Number.isFinite(record.created) ? record.created : Date.now(),
    path: record.path === undefined || record.path === null ? undefined : String(record.path),
    size: Number.isFinite(record.size) ? record.size : 0,
    body: typeof record.body === 'string' ? record.body : '',
  };
}

/**
 * The legacy Backup store, one document per upload: `{_id, accountId, created, path}` (schemes/
 * backup.js) with the uploaded bytes held alongside. `create` replaces an existing record for the
 * same `{accountId, path}` (backup.ctrl.js `create` removes the previous one), `listBackups`
 * filters by accountId and a LITERAL path prefix (`{$regex: '^' + escapeRegExp(path)}`), newest
 * first (backup.ctrl.js): a `startsWith` prefix test is exactly that escaped-regex match.
 */
export class VoiceTrainingStore {
  constructor({
    file = process.env.ETCO_classic_voiceTrainingFile || join(tmpdir(), 'phoenix-voiceTraining.json'),
    clock = Date.now,
  } = {}) {
    this.file = file;
    this.clock = clock;
    this.records = [];
    this._seq = 0;
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`voiceTraining store unreadable (${this.file}): ${error.message}`);
    }
    for (const record of raw.records || []) {
      if (record && (typeof record._id === 'string' || typeof record.id === 'string')) this.records.push(normalizeRecord(record));
    }
    this._seq = this.records.reduce((max, record) => Math.max(max, record.seq || 0), 0);
  }

  _flush() {
    const serialized = JSON.stringify({ records: this.records }, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, serialized); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  now() { return typeof this.clock === 'function' ? this.clock() : Date.now(); }

  /**
   * backup.ctrl.js `create`: resolve the existing `{accountId, path}` document, build the new
   * record, persist the bytes, drop the previous record, then save. An interrupted write throws
   * BEFORE the index is mutated, so a failed upload leaves no record.
   */
  create({ accountId, path, body }) {
    const id = newRecordId();
    const bytes = toBytes(body);
    const record = {
      id,
      seq: (this._seq += 1),
      accountId,
      created: this.now(),
      path,
      size: bytes.length,
      body: bytes.toString('base64'),
    };
    const existing = this.records.filter((row) => sameId(row.accountId, accountId) && row.path === path);
    this.records = this.records.filter((row) => !(sameId(row.accountId, accountId) && row.path === path));
    this.records.push(record);
    try {
      this._flush();
    } catch (error) {
      // Roll the in-memory index back so a failed persist is observably a no-op.
      this.records = this.records.filter((row) => row.id !== id);
      this.records.push(...existing);
      this._seq -= 1;
      throw error;
    }
    return record;
  }

  /** backup.ctrl.js `listBackups`: `find({accountId, path: {$regex:'^'+escape(path)}})` newest first. */
  list({ accountId, path }) {
    const prefix = path === undefined || path === null ? '' : String(path);
    return this.records
      .filter((record) => sameId(record.accountId, accountId) && String(record.path).startsWith(prefix))
      .sort((a, b) => (b.created - a.created) || (b.seq - a.seq));
  }

  /** backup.ctrl.js `getBackup`: the newest match, or a throw when the account has none. */
  get({ accountId, path }) {
    const found = this.list({ accountId, path });
    if (!found.length) { const err = new Error('Backup not found'); err.statusCode = 404; throw err; }
    return found[0];
  }

  findById(id) { return this.records.find((record) => sameId(record.id, id)) || null; }

  remove({ accountId, id }) {
    const record = this.findById(id);
    if (!record) { const err = new Error('Backup not found'); err.statusCode = 404; throw err; }
    if (!sameId(record.accountId, accountId)) { const err = new Error('Backup belongs to other account'); err.statusCode = 401; throw err; }
    this.records = this.records.filter((row) => row.id !== record.id);
    this._flush();
    return record;
  }

  /** The source's bytes (the S3 object behind the record `_id`). */
  bytes(id) {
    const record = this.findById(id);
    return record ? Buffer.from(record.body, 'base64') : null;
  }

  /** schemes/backup.js toJSON: `_id`, `accountId`, `created`, `path` + the `url` virtual. The S3
   *  presigned GET is substituted by this entrypoint's own blob route (self-hosting divergence). */
  view(record, base) {
    const out = { _id: record.id, accountId: record.accountId, created: record.created, path: record.path };
    if (typeof base === 'string' && base.length > 0) {
      out.url = `${base.replace(/\/$/, '')}${VOICE_TRAINING_BLOB_ROUTE}?key=${encodeURIComponent(record.id)}`;
    }
    return out;
  }
}

// ---- the `client.Backup` seam --------------------------------------------------------------

function backupFailure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * In-process stand-in for `client.Backup` over the legacy Backup store for the `/voiceTraining/`
 * prefix. `createBackup` mirrors backup.ctrl.js create (account required, replace-same-path);
 * `listBackups` mirrors the account-scoped prefix query. `base` is a Phoenix transport extra so the
 * record's `url` can be self-hosted.
 */
export function voiceTrainingBackup(store) {
  if (!store || typeof store.create !== 'function') throw new TypeError('voiceTrainingBackup requires a VoiceTrainingStore');
  const accountOf = (credentials) => {
    const id = credentials && (credentials._id ?? credentials.id);
    return id === undefined || id === null || String(id).length === 0 ? null : String(id);
  };
  return {
    async createBackup({ path, body, credentials, base }) {
      const accountId = accountOf(credentials);
      if (!accountId) throw backupFailure(VOICE_TRAINING_ACCOUNT_REQUIRED, 401);
      return store.view(store.create({ accountId, path, body }), base);
    },
    async listBackups({ path, credentials, base }) {
      const accountId = accountOf(credentials);
      if (!accountId) return [];
      return store.list({ accountId, path }).map((record) => store.view(record, base));
    },
  };
}

// ---- the X-Amz-Target handler ----------------------------------------------------------------

function baseUrlFor(baseFor, req) {
  if (typeof baseFor === 'function') return baseFor(req);
  if (typeof baseFor === 'string') return baseFor;
  return undefined;
}

/**
 * @param {object} [options]
 * @param {VoiceTrainingStore} [options.store]
 * @param {{createBackup:Function, listBackups:Function}} [options.backup]  the client.Backup seam
 * @param {Function|string} [options.baseFor]  (req) => absolute origin, for the record `url`
 * @param {number} [options.maxBytes]  the Hapi payload cap (default 100000000)
 * @param {{warn?:Function, info?:Function, error?:Function}} [options.logger]
 */
export function makeVoiceTrainingHandler({
  store = new VoiceTrainingStore(),
  backup,
  baseFor,
  maxBytes = VOICE_TRAINING_MAX_BYTES,
  logger,
} = {}) {
  const client = backup || voiceTrainingBackup(store);
  const log = logger || { warn: () => {}, info: () => {}, error: () => {} };

  return async function voiceTrainingHandler({ req, res, body, op }) {
    const name = String(op || '');
    const lower = name.toLowerCase();
    // The gateway (srv-security-gw auth.ctrl.ts) is OUTERMOST: the VoiceTraining target is absent
    // from its unsigned allow-list, so an unsigned call is rejected before the Hapi handler runs —
    // even for an operation the handler does not export.
    const accountId = voiceTrainingAccountId(req);
    if (!accountId) return void sendAmzError(res, MISSING_AUTH_HEADER);
    // server.js: `handlers[method] || handlers[method + 'Handler']` — only two exports resolve.
    if (!VOICE_TRAINING_OPERATIONS.includes(lower)) {
      return void sendBoom(res, 404, `Method not found in VoiceTraining, method ${name}`);
    }

    const payload = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const bytes = toBytes(payload.body).length;
    if (Number.isFinite(maxBytes) && bytes > maxBytes) {
      return void sendBoom(res, 413, `Payload content length greater than maximum allowed: ${maxBytes}`);
    }
    const invalid = VOICE_TRAINING_VALIDATORS[lower] ? VOICE_TRAINING_VALIDATORS[lower](payload) : null;
    if (invalid) return void sendBoom(res, 400, invalid);

    const credentials = backupCredentials(req, accountId);
    const base = baseUrlFor(baseFor, req);
    try {
      if (lower === 'uploadvoicetraining') {
        const out = await client.createBackup({ path: `${VOICE_TRAINING_PATH_ROOT}${payload.key}`, body: payload.body, credentials, base });
        log.info?.('voiceTraining upload', { accountId, path: `${VOICE_TRAINING_PATH_ROOT}${payload.key}` });
        return void sendAmz(res, 200, out === undefined ? {} : out);
      }
      const out = await client.listBackups({ path: VOICE_TRAINING_PATH_ROOT, credentials, base });
      log.info?.('voiceTraining list', { accountId, count: (out || []).length });
      return void sendAmz(res, 200, out === undefined ? [] : out);
    } catch (error) {
      // upload-voice-sample.handler.js / list-voice-trainings.handler.js: `Boom.wrap(err, 400)`
      // forces the Backup failure to 400 regardless of the Backup hop's own status code.
      return void sendBoom(res, 400, error?.message || 'Backup error');
    }
  };
}

/**
 * The self-hosted bytes behind a record's `url` virtual (the S3 GET substitution). Registered on
 * the entrypoint's HTTP server, NOT the AWS-JSON prefix router.
 */
export function voiceTrainingBlobRoutes(store) {
  return {
    [`GET ${VOICE_TRAINING_BLOB_ROUTE}`]: ({ res, url }) => {
      const key = url.searchParams.get('key');
      const bytes = key ? store.bytes(key) : null;
      if (!bytes) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('no such voice training'); }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      res.end(bytes);
    },
  };
}
