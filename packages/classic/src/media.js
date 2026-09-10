// `media` service (Media_20160725) — Jibo's cloud photo/recording store. This is the surface the
// mobile app's Gallery tab reads: MediaFragment calls JiboMediaClient.list(loopIds, after, before)
// → POST / with X-Amz-Target Media_20160725.List, and the grid is built from the local rows whose
// type is 'thumb', url is non-null and reference is non-null.
//
// Pinned from the archive (not guessed):
//   apis/media-2016-07-25.normal.json          targetPrefix "Media_20160725", endpointPrefix
//                                              "media", ops Create/List/Remove/Get, shapes Media +
//                                              MediaList, Create input is headers + a streaming body
//   jiborobot/srv-media-ws src/handlers/media.handler.js
//   jiborobot/srv-media-ws src/controllers/media.ctrl.js   (list/get/create/remove + expand)
//   jiborobot/srv-media-ws src/schemes/media.js            (storage path + toJSON transform)
//   jiborobot/srv-media-ws src/schemes/media.type.js       (the 6 media types)
//   jiborobot/srv-media-ws src/errors/media.js             (status codes + error names)
//   the Android client com.jibo.aws.integration.aws.services.media.* in
//   jibo-android/jibo-aws-library-release.aar (2018-05-11): target prefix "Media_20160725.",
//   request body is a Gson dump of ListRequest{loopIds, after, before}, and the response is parsed
//   by Gson straight into Media — NOT filtered by an aws-sdk output shape, so every field the
//   server sends is visible to the client.
//
// Source semantics deliberately kept:
//   * membership gate (MEDIA_MUST_BE_MEMBER) before list/create
//   * MEDIA_ALREADY_EXISTS 409, REFERENCE_NOT_FOUND 404, REFERENCE_FOR_THUMB 422
//   * thumbnail expansion: a thumb is answered as its own row with `reference` = parent path
//   * result order: ascending by created (the source sorts descending, limits, then reverses);
//     page default 50, hard cap 200
//   * list does NOT filter soft-deleted rows, but its toJSON transform strips `url` from them, so
//     the app's `url IS NOT NULL` cursor drops them exactly as it did against the real cloud.
//
// Phoenix has no S3 (the same divergence that made Backup and the OTA packages self-host), so the
// answered `url` points back at this entrypoint and the bytes live on local disk.

import { createWriteStream, createReadStream, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

export const MEDIA_TYPES = ['image', 'photo_booth', 'recording', 'thumb', 'thumb_robot', 'audio'];
export const THUMB_TYPES = ['thumb', 'thumb_robot'];
export const MEDIA_PAGE_DEFAULT = 50;
export const MEDIA_PAGE_MAX = 200;
const SAFE_PATH = /^[A-Za-z0-9_-]+$/;

// jiborobot/srv-media-ws src/errors/media.js
export const MEDIA_ERRORS = {
  MEDIA_NOT_FOUND: { code: 'MEDIA_NOT_FOUND', statusCode: 404, message: 'Media not found' },
  MEDIA_ALREADY_EXISTS: { code: 'MEDIA_ALREADY_EXISTS', statusCode: 409, message: 'Media already exists' },
  MEDIA_ONLY_OWNER_CAN_REMOVE: { code: 'MEDIA_ONLY_OWNER_CAN_REMOVE', statusCode: 403, message: 'Only owner can remove media' },
  MEDIA_MUST_BE_MEMBER: { code: 'MEDIA_MUST_BE_MEMBER', statusCode: 403, message: 'You must be a member of the loop to list or create media' },
  REFERENCE_FOR_THUMB: { code: 'REFERENCE_FOR_THUMB', statusCode: 422, message: 'Reference should be present only for thumbnails' },
  REFERENCE_NOT_FOUND: { code: 'REFERENCE_NOT_FOUND', statusCode: 404, message: 'Referenced media not found' },
};

function fail(code) { const err = new Error(code); Object.assign(err, MEDIA_ERRORS[code]); throw err; }

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** srv-media-ws src/controllers/media.ctrl.js getStoragePath — accountId/<path>.<jpg|mp4>. */
export function mediaStorageName({ path, type }) {
  return `${path}${type === 'recording' || type === 'audio' ? '.mp4' : '.jpg'}`;
}

/** srv-media-ws src/schemes/media.js toJSON transform: drop _id, created -> epoch ms, strip url when deleted. */
function toJSON(record) {
  const out = {
    path: record.path,
    type: record.type,
    accountId: record.accountId,
    loopId: record.loopId,
    created: record.created,
    meta: record.meta || {},
    isEncrypted: record.isEncrypted === true,
    isDeleted: record.isDeleted === true,
    thumbs: (record.thumbs || []).map((thumb) => ({
      path: thumb.path, type: thumb.type, url: thumb.url, isEncrypted: thumb.isEncrypted === true,
    })),
  };
  if (record.url !== undefined && record.url !== null) out.url = record.url;
  if (out.isDeleted) {
    delete out.url;
    for (const thumb of out.thumbs) delete thumb.url;
  }
  return out;
}

/** srv-media-ws src/controllers/media.ctrl.js expand: parent row + one row per thumb. */
export function expandMedia(records) {
  return records
    .map((record) => {
      const media = toJSON(record);
      return [media, ...(media.thumbs || []).map((thumb) => ({ ...media, ...thumb, reference: media.path }))];
    })
    .reduce((all, rows) => all.concat(rows), []);
}

/**
 * Durable Media store: one atomically replaced JSON index plus the object bytes on disk.
 * Mongo is gone; the deployed service must still answer a photo the robot uploaded before the
 * last restart, so the index is written synchronously on every mutation (same discipline as
 * NotificationStore) and the blobs are streamed to private files.
 */
export class MediaStore {
  constructor({
    directory = process.env.ETCO_classic_mediaDir || join(tmpdir(), 'phoenix-media'),
    file = process.env.ETCO_classic_mediaFile || join(tmpdir(), 'phoenix-media.json'),
    clock = Date.now,
  } = {}) {
    this.directory = directory;
    this.file = file;
    this.clock = clock;
    this.records = new Map(); // path -> record
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const record of raw.media || []) {
        if (record && typeof record.path === 'string') this.records.set(record.path, record);
      }
    } catch (error) {
      throw new Error(`media store unreadable (${this.file}): ${error.message}`);
    }
  }

  _flush() {
    const serialized = JSON.stringify({ media: [...this.records.values()] }, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, serialized); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  fileFor(record) {
    return join(this.directory, record.accountId || 'anonymous', mediaStorageName(record));
  }

  objectFile(path) {
    const record = this.records.get(path);
    if (record) return this.fileFor(record);
    for (const candidate of this.records.values()) {
      const thumb = (candidate.thumbs || []).find((t) => t.path === path);
      if (thumb) return this.fileFor({ ...thumb, accountId: candidate.accountId });
    }
    return null;
  }

  created() { return typeof this.clock === 'function' ? this.clock() : Date.now(); }

  find(path) { return this.records.get(path) || null; }

  findByThumbPath(path) {
    for (const record of this.records.values()) {
      const thumb = (record.thumbs || []).find((t) => t.path === path);
      if (thumb) return { record, thumb };
    }
    return null;
  }

  get(paths) {
    const wanted = new Set(paths.map(String));
    return [...this.records.values()].filter((record) => wanted.has(record.path)
      || (record.thumbs || []).some((thumb) => wanted.has(thumb.path)));
  }

  /** Stream one object's bytes to private disk. Does NOT register a media document. */
  async writeBlob(record, dataStream) {
    const file = this.fileFor(record);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await pipeline(dataStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return file;
  }

  /** Upload the object bytes, then record it. Returns the stored record (blob first, like the source). */
  async putObject(record, dataStream) {
    await this.writeBlob(record, dataStream);
    this.records.set(record.path, record);
    this._flush();
    return record;
  }

  openObject(path) {
    const file = this.objectFile(path);
    if (!file || !existsSync(file)) return null;
    return createReadStream(file);
  }

  removeForLoop(loopId) {
    const removed = [...this.records.values()].filter((record) => sameId(record.loopId, loopId));
    for (const record of removed) this.records.delete(record.path);
    this._flush();
    return removed;
  }
}

/**
 * `url` for an object key, pointed back at whatever host the caller reached us on (no S3).
 *
 * Order matters: the object URL is fetched by the DEVICE that made the request (Glide on the
 * phone, the robot's own downloader), so the host it addressed us with is the only one known to
 * work for it. `ETCO_classic_mediaBaseUrl` is the explicit override for the case where that host
 * is not resolvable by the other devices in the loop — e.g. a robot that reaches Phoenix as
 * `api.jibo.com` while the phone reaches it by LAN address. Classic's static public URL is a last
 * resort, not the default, because the deployed profile pins it to https://localhost.
 */
function objectBaseUrl(baseFor, req) {
  const explicit = process.env.ETCO_classic_mediaBaseUrl;
  if (explicit) return String(explicit).replace(/\/$/, '');
  const host = req?.headers?.host;
  if (host) return `${req?.socket?.encrypted ? 'https' : 'http'}://${host}`;
  const base = typeof baseFor === 'function' ? baseFor(req) : null;
  return String(base || 'http://localhost').replace(/\/$/, '');
}

const mediaUrl = (base, path) => `${base}/media/blob/${path}`;

/**
 * The account-identity / loop-membership seams.
 *
 * The source resolved both over HTTP to the account service (`accountClient.listMembers`,
 * `.getLoops`, `.listOwnerLoops`) and threw MEDIA_MUST_BE_MEMBER when the caller was not a member.
 * Phoenix's Classic entrypoint is LAN-trust and colocated with the account store, so the deployed
 * launcher injects the real functions. When they are not injected the membership gate is skipped —
 * the same documented divergence as Backup's dropped loop-ownership check — rather than being
 * silently replaced by a fake pass.
 */
export function makeMediaHandler({ store, baseFor, accountResolver, loops } = {}) {
  if (!store) throw new TypeError('media handler requires a MediaStore');
  const accountIdOf = (req, body) => (typeof accountResolver === 'function'
    ? accountResolver(req, body)
    : accessKeyIdFromAuth(req)) || 'anon';
  const loopMemberIds = async (loopId) => (loops && typeof loops.members === 'function'
    ? (await loops.members(loopId)) || [] : null);
  const accountLoopIds = async (accountId) => (loops && typeof loops.accountLoops === 'function'
    ? (await loops.accountLoops(accountId)) || [] : null);
  const ownerLoopIds = async (accountId) => (loops && typeof loops.ownedLoops === 'function'
    ? (await loops.ownedLoops(accountId)) || [] : null);

  async function requireMembership(loopId, accountId) {
    const members = await loopMemberIds(loopId);
    if (members === null) return; // no membership source wired (LAN trust)
    if (!members.some((id) => sameId(id, accountId))) fail('MEDIA_MUST_BE_MEMBER');
  }

  function requireStringArray(body, field) {
    const value = body ? body[field] : undefined;
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) {
      return null;
    }
    return value;
  }

  const header = (req, name) => {
    const value = req?.headers?.[name];
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? String(value[0]) : String(value);
  };

  function metaFromHeaders(req) {
    const meta = {};
    for (const [name, value] of Object.entries(req?.headers || {})) {
      if (name.toLowerCase().startsWith('x-meta')) {
        meta[name.replace(/^x-meta-?/i, '')] = Array.isArray(value) ? String(value[0]) : String(value);
      }
    }
    return meta;
  }

  async function create({ req, res }) {
    const accountId = accountIdOf(req, null);
    const loopId = header(req, 'x-loop-id');
    if (!loopId) return void sendAmzError(res, ValidationException, 'Invalid or missing x-loop-id');
    const type = header(req, 'x-type') ?? 'image';
    if (!MEDIA_TYPES.includes(type)) return void sendAmzError(res, ValidationException, `Invalid or missing x-type: ${type}`);
    const encryptedHeader = header(req, 'x-encrypted');
    if (encryptedHeader !== undefined && !/^(true|false)$/i.test(encryptedHeader)) {
      return void sendAmzError(res, ValidationException, `Invalid or missing x-encrypted: ${encryptedHeader}`);
    }
    const isEncrypted = /^true$/i.test(encryptedHeader || '');
    const reference = header(req, 'x-reference') || null;
    const path = header(req, 'x-path') || randomUUID().replace(/-/g, '');
    if (!SAFE_PATH.test(path)) return void sendAmzError(res, ValidationException, 'Invalid or missing x-path');
    try {
      await requireMembership(loopId, accountId);
      if (store.find(path) || store.findByThumbPath(path)) fail('MEDIA_ALREADY_EXISTS');
      const base = objectBaseUrl(baseFor, req);
      if (reference) {
        if (!THUMB_TYPES.includes(type)) fail('REFERENCE_FOR_THUMB');
        const parent = store.find(reference);
        if (!parent) fail('REFERENCE_NOT_FOUND');
        const thumb = { path, type, url: mediaUrl(base, path), isEncrypted };
        await store.writeBlob({ ...thumb, accountId: parent.accountId }, req);
        // The source pushes the thumb onto the referenced document, saves it, and answers the
        // parent's JSON with the thumb's path/type/url plus the reference — not the thumb record.
        parent.thumbs = [...(parent.thumbs || []), thumb];
        store.records.set(parent.path, parent);
        store._flush();
        return void sendAmz(res, 200, { ...toJSON(parent), path, type, url: thumb.url, reference });
      }
      const record = {
        path, type, accountId, loopId, url: mediaUrl(base, path), created: store.created(),
        meta: metaFromHeaders(req), isEncrypted, isDeleted: false, thumbs: [],
      };
      await store.putObject(record, req);
      return void sendAmz(res, 200, toJSON(record));
    } catch (error) {
      if (typeof req?.resume === 'function' && !req.readableEnded) req.resume();
      return void sendAmzError(res, error.statusCode ? error
        : { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  }

  async function list({ req, res, body }) {
    const loopIds = requireStringArray(body, 'loopIds');
    if (!loopIds) return void sendAmzError(res, ValidationException, 'Invalid or missing loopIds');
    const after = typeof body.after === 'number' ? body.after : undefined;
    const before = typeof body.before === 'number' ? body.before : undefined;
    const limit = Math.min(typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : MEDIA_PAGE_DEFAULT, MEDIA_PAGE_MAX);
    const accountId = accountIdOf(req, body);
    try {
      for (const loopId of loopIds) await requireMembership(loopId, accountId);
      // Source: sortOrder -1 unless an `after` marker is given on its own; limit; then reverse the
      // -1 pass, so the answered page is always ascending by created.
      const sortOrder = (!before && after) ? 1 : -1;
      const wanted = new Set(loopIds.map(String));
      let rows = [...store.records.values()].filter((record) => wanted.has(String(record.loopId)));
      if (after !== undefined) rows = rows.filter((record) => record.created > after);
      if (before !== undefined) rows = rows.filter((record) => record.created < before);
      rows.sort((a, b) => sortOrder * (a.created - b.created));
      rows = rows.slice(0, limit);
      let mediaList = expandMedia(rows);
      if (sortOrder === -1) mediaList = mediaList.reverse();
      return void sendAmz(res, 200, mediaList);
    } catch (error) {
      return void sendAmzError(res, error.statusCode ? error
        : { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  }

  async function get({ req, res, body }) {
    const paths = requireStringArray(body, 'paths');
    if (!paths) return void sendAmzError(res, ValidationException, 'Invalid or missing paths');
    const accountId = accountIdOf(req, body);
    try {
      const records = store.get(paths).filter((record) => record.isDeleted !== true);
      const mediaList = expandMedia(records);
      const loops = await accountLoopIds(accountId);
      if (loops === null) return void sendAmz(res, 200, mediaList);
      const accessible = new Set(loops.map(String));
      return void sendAmz(res, 200, mediaList.filter((media) => accessible.has(String(media.loopId))));
    } catch (error) {
      return void sendAmzError(res, error.statusCode ? error
        : { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  }

  async function remove({ req, res, body }) {
    const paths = requireStringArray(body, 'paths');
    if (!paths) return void sendAmzError(res, ValidationException, 'Invalid or missing paths');
    const accountId = accountIdOf(req, body);
    try {
      const owned = await ownerLoopIds(accountId);
      const ownedSet = owned === null ? null : new Set(owned.map(String));
      const candidates = store.get(paths).filter((record) => sameId(record.accountId, accountId)
        || ownedSet === null || ownedSet.has(String(record.loopId)));
      const mediaList = expandMedia(candidates);
      for (const record of candidates) {
        record.isDeleted = true;
        store.records.set(record.path, record);
      }
      if (candidates.length) store._flush();
      return void sendAmz(res, 200, mediaList);
    } catch (error) {
      return void sendAmzError(res, error.statusCode ? error
        : { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  }

  function removeAllMediaFromLoop({ res, body }) {
    if (!body || typeof body.loopId !== 'string' || !body.loopId) {
      return void sendAmzError(res, ValidationException, 'Invalid or missing loopId');
    }
    return void sendAmz(res, 200, expandMedia(store.removeForLoop(body.loopId)));
  }

  const handlers = {
    create, list, get, remove, removeallmediafromloop: removeAllMediaFromLoop,
  };

  return function mediaHandler({ req, res, body, op, log }) {
    const handler = handlers[String(op).toLowerCase()];
    if (!handler) return void sendAmzError(res, ValidationException, `unknown media operation: ${op}`);
    if (log) log.info('media request', { op: String(op).toLowerCase() });
    return handler({ req, res, body, log });
  };
}

/** GET /media/blob/:path — the object bytes behind the `url` the app is handed (no S3). */
export function mediaBlobRoutes(store) {
  return {
    'GET /media/blob/:path': async ({ req, res }) => {
      const path = String(req.params.path || '');
      if (!SAFE_PATH.test(path)) { res.writeHead(400); res.end(); return; }
      let stream;
      try {
        stream = store.openObject(path);
      } catch {
        stream = null;
      }
      if (!stream) { res.writeHead(404); res.end(); return; }
      try {
        await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
        res.setHeader('content-type', 'application/octet-stream');
        await pipeline(stream, res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) { res.writeHead(404); res.end(); } else res.destroy(error);
      }
    },
  };
}

/** The media upload is a streaming binary body: Classic must not run a JSON parser over it. */
export function isMediaUpload(req) {
  return /^Media[^.]*\.Create$/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

/**
 * The LAN-trust account identity used by the deployed launcher: the SigV4 Credential accessKeyId
 * mapped to the owning account's `_id` so it can be compared against `loop.members[].accountId`.
 *
 * Signature verification is deliberately NOT used here: Media.Create carries the media bytes as
 * the raw request entity, so a body-over-signature check (like Classic's notification resolver)
 * cannot see those bytes. This matches the posture the other Classic stores already document —
 * "the account identity comes from the SigV4 Credential accessKeyId (LAN-trust, like the rest)".
 */
export function accessKeyAccountResolver(accountByAccessKeyId) {
  return (req) => {
    const accessKeyId = accessKeyIdFromAuth(req);
    if (!accessKeyId) return null;
    const account = typeof accountByAccessKeyId === 'function' ? accountByAccessKeyId(accessKeyId) : null;
    if (!account) return accessKeyId;
    return String(account.id ?? account._id ?? accessKeyId);
  };
}
