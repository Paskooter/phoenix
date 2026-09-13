// LoopController.updateMemberPhoto/removeMemberPhoto at srv-account-ws@6cea434.
import { populateLoop, LOOP_MEMBERSHIP_ERRORS } from './loopMembership.js';
import { sendAmz, sendAmzError } from './loopHttp.js';
import { Transform, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const PHOTO_MAX_BYTES = 1_000_000_000;

/** A raw account/member photo body crossed the configured cumulative byte cap. */
export class PhotoUploadTooLargeError extends Error {
  constructor(limit) {
    super(`Payload content length greater than maximum allowed: ${limit}`);
    this.name = 'PhotoUploadTooLargeError';
    this.code = 'PAYLOAD_TOO_LARGE';
    this.status = 400;
    this.statusCode = 400;
    this.limit = limit;
  }
}

export function normalizePhotoMaxBytes(value, fallback = PHOTO_MAX_BYTES) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('photoMaxBytes must be a non-negative safe integer');
  }
  return limit;
}

export function uniquePhotoPath(subjectId, clock = Date.now) {
  const timestamp = clock();
  // Keep the source-compatible `<id><clock>` prefix while adding entropy so
  // two replacements sharing a clock value can never address the same object.
  const entropy = randomBytes(8).readBigUInt64BE(0).toString(10);
  return `${String(subjectId)}${String(timestamp)}${entropy}`;
}

const photoLocks = new WeakMap();

/** Serialize replacement/removal operations for one account/member target. */
export function withPhotoLock(store, key, operation) {
  let locks = photoLocks.get(store);
  if (!locks) {
    locks = new Map();
    photoLocks.set(store, locks);
  }
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  current.finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  }).catch(() => {});
  return current;
}

// Requests without an explicit payload hash must be hashed from received bytes.
// Spool to private disk so verification and later upload do not buffer a 1 GB body.
export async function stagePhotoDigest(req, { maxBytes = PHOTO_MAX_BYTES } = {}) {
  const limit = normalizePhotoMaxBytes(maxBytes);
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-photo-request-'));
  const path = join(directory, 'body');
  const digest = createHash('sha256');
  let size = 0;
  const hashing = new Transform({
    transform(chunk, encoding, callback) {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (size + bytes.length > limit) return callback(new PhotoUploadTooLargeError(limit));
        size += bytes.length;
        digest.update(bytes);
        return callback(null, bytes);
      } catch (error) {
        return callback(error);
      }
    },
  });
  const onRequestError = (error) => hashing.destroy(error);
  req.on('error', onRequestError);
  try {
    req.pipe(hashing);
    try {
      await pipeline(hashing, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    } finally {
      req.unpipe(hashing);
    }
    req.photoBodyDigest = digest.digest('hex');
    req.photoBytes = size;
    req.photoInputStream = createReadStream(path);
    let cleaned = false;
    req.photoCleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      req.photoInputStream.destroy();
      await rm(directory, { recursive: true, force: true });
    };
  } catch (error) {
    req.unpipe(hashing);
    if (typeof req.resume === 'function') req.resume();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    req.removeListener('error', onRequestError);
  }
}

function fail(code) { throw Object.assign(new Error(code), LOOP_MEMBERSHIP_ERRORS[code]); }
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function target(store, { ownerId, loopId, id }) {
  const loop = store.loops.get(loopId);
  if (!loop || loop.isDeleted === true) fail('LOOP_NOT_FOUND');
  if (!sameId(loop.owner, ownerId) && !sameId(loop.robot, ownerId)) fail('CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT');
  const member = loop.members.find((item) => sameId(item._id, id));
  if (!member) fail('MEMBER_NOT_FOUND');
  // Neither photo method checks suspension, child status, or editability.
  return { loop, member };
}

export function photoObjectKey(photoUrl) {
  if (photoUrl === undefined || photoUrl === null) return null;
  const value = String(photoUrl).split(/[?#]/, 1)[0];
  return value.split('/').pop() || null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function save(store, before, memberId, photoUrl, outbox) {
  const draft = JSON.parse(JSON.stringify(before));
  const member = draft.members.find((item) => sameId(item._id, memberId));
  member.memberProperties = member.memberProperties || {};
  member.memberProperties.photoUrl = photoUrl;
  draft.updated = Date.now();
  store.loops.set(draft._id, draft);
  try { outbox.record(draft); }
  catch (error) { store.loops.set(before._id, before); throw error; }
  return draft;
}

function restoreOutbox(store, snapshot) {
  store.notificationOutbox.clear();
  for (const [key, value] of snapshot) store.notificationOutbox.set(key, value);
}

function rollbackPhotoCommit(store, committed, before, previousOutbox) {
  const committedLoop = store.loops.get(committed._id);
  const committedOutbox = new Map(store.notificationOutbox);
  store.loops.set(before._id, before);
  restoreOutbox(store, previousOutbox);
  try {
    store.flush();
  } catch (error) {
    // The first commit succeeded, so restore that committed in-memory view if
    // the best-effort cleanup rollback cannot itself be made durable.
    if (committedLoop) store.loops.set(committed._id, committedLoop);
    else store.loops.delete(committed._id);
    restoreOutbox(store, committedOutbox);
    throw error;
  }
}

export async function updateMemberPhoto(store, payload, binaryProvider, outbox, clock = Date.now) {
  const lockKey = `member:${String(payload.loopId)}:${String(payload.id)}`;
  return withPhotoLock(store, lockKey, async () => {
    const { loop, member } = target(store, payload);
    const saved = await binaryProvider.createPublic({
      dataStream: payload.dataStream,
      path: uniquePhotoPath(payload.id, clock),
    });
    const oldObject = photoObjectKey(member.memberProperties?.photoUrl);
    const newObject = photoObjectKey(saved.path || saved.url);
    const previousOutbox = new Map([...store.notificationOutbox]
      .map(([key, value]) => [key, clone(value)]));
    let committed;
    try {
      // The outbox record is the metadata commit. Do not remove the old object
      // until this call has durably committed both loop and LoopUpdated row.
      committed = save(store, loop, payload.id, saved.url, outbox);
    } catch (error) {
      if (newObject && newObject !== oldObject) {
        try { await binaryProvider.remove(newObject); } catch { /* preserve commit error */ }
      }
      throw error;
    }
    try {
      if (oldObject && oldObject !== newObject) await binaryProvider.remove(oldObject);
    } catch (error) {
      // The source rejects the request before exposing the replacement when the
      // old-object cleanup fails. Roll back the loop and its event row together.
      // Once that rollback succeeds, remove the replacement too; its unique key
      // is no longer referenced and retaining it would create an orphan.
      let rolledBack = false;
      try {
        rollbackPhotoCommit(store, committed, loop, previousOutbox);
        rolledBack = true;
      } catch { /* keep committed state if rollback is unavailable */ }
      if (rolledBack && newObject && newObject !== oldObject) {
        try { await binaryProvider.remove(newObject); } catch { /* preserve cleanup error */ }
      }
      throw error;
    }
    return populateLoop(store, committed);
  });
}

export async function removeMemberPhoto(store, payload, binaryProvider, outbox) {
  const lockKey = `member:${String(payload.loopId)}:${String(payload.id)}`;
  return withPhotoLock(store, lockKey, async () => {
    const { loop, member } = target(store, payload);
    const oldObject = photoObjectKey(member.memberProperties?.photoUrl);
    const previousOutbox = new Map([...store.notificationOutbox]
      .map(([key, value]) => [key, clone(value)]));
    const committed = save(store, loop, payload.id, null, outbox);
    try {
      if (oldObject) await binaryProvider.remove(oldObject);
    } catch (error) {
      try { rollbackPhotoCommit(store, committed, loop, previousOutbox); } catch { /* keep committed state if rollback is unavailable */ }
      throw error;
    }
    return populateLoop(store, committed);
  });
}

export function isMemberPhotoUpload(req) {
  return /^Loop[^.]*\.UpdateMemberPhoto$/i.test(String(req.headers['x-amz-target'] || ''));
}

export function handleMemberPhotos({ store, req, res, body, op, provider, outbox }) {
  const operation = String(op).toLowerCase();
  if (!['updatememberphoto', 'removememberphoto'].includes(operation)) return false;
  const upload = operation === 'updatememberphoto';
  const input = upload ? req.headers : body;
  const fields = upload ? ['x-id', 'x-loop-id'] : ['id', 'loopId'];
  const invalidObject = !input || typeof input !== 'object' || Array.isArray(input);
  const invalidField = !invalidObject && fields.find((key) => typeof input[key] !== 'string' || !input[key]);
  if (invalidObject || invalidField) {
    const message = invalidObject ? '"value" must be an object' : `Invalid or missing ${invalidField}`;
    const data = JSON.stringify({ statusCode: 422, error: 'Unprocessable Entity', message });
    res.writeHead(422, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
    if (upload) req.resume();
    return true;
  }
  const payload = { ownerId: req._phoenixVerifiedCredentials._id,
    id: input[upload ? 'x-id' : 'id'], loopId: input[upload ? 'x-loop-id' : 'loopId'] };
  let stream;
  if (upload) {
    stream = new PassThrough();
    payload.dataStream = stream;
  }
  // Start consuming only after controller ownership/member checks reach upload.
  const binary = provider && upload ? { ...provider,
    createPublic: async (args) => {
      const source = req.photoInputStream || req;
      source.on('error', (error) => stream.destroy(error));
      source.pipe(stream);
      return provider.createPublic(args);
    },
    remove: (path) => provider.remove(path),
  } : provider;
  const result = upload ? updateMemberPhoto(store, payload, binary, outbox)
    : removeMemberPhoto(store, payload, binary, outbox);
  return result.then((data) => sendAmz(res, 200, data)).catch((error) => {
    if (upload) { req.unpipe(stream); req.resume(); }
    return sendAmzError(res, error.statusCode ? error : { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
  });
}
