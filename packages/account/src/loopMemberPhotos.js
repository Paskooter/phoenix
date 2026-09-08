// LoopController.updateMemberPhoto/removeMemberPhoto at srv-account-ws@6cea434.
import { populateLoop, LOOP_MEMBERSHIP_ERRORS } from './loopMembership.js';
import { sendAmz, sendAmzError } from './loopHttp.js';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Requests without an explicit payload hash must be hashed from received bytes.
// Spool to private disk so verification and later upload do not buffer a 1 GB body.
export async function stagePhotoDigest(req) {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-photo-request-'));
  const path = join(directory, 'body');
  const digest = createHash('sha256');
  let size = 0;
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      digest.update(chunk);
      callback(size > 1000000000 ? new Error('Payload too large') : null, chunk);
    } }), createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    req.photoBodyDigest = digest.digest('hex');
    req.photoInputStream = createReadStream(path);
    req.photoCleanup = async () => { req.photoInputStream.destroy(); await rm(directory, { recursive: true, force: true }); };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
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

function save(store, before, memberId, photoUrl, outbox) {
  const draft = JSON.parse(JSON.stringify(before));
  draft.members.find((member) => sameId(member._id, memberId)).memberProperties.photoUrl = photoUrl;
  draft.updated = Date.now();
  store.loops.set(draft._id, draft);
  try { outbox.record(draft); }
  catch (error) { store.loops.set(before._id, before); throw error; }
  return populateLoop(store, draft);
}

export async function updateMemberPhoto(store, payload, binaryProvider, outbox, clock = Date.now) {
  const { loop, member } = target(store, payload);
  const saved = await binaryProvider.createPublic({ dataStream: payload.dataStream, path: payload.id + clock() });
  // Source uploads first, then removes the previous object, then saves the Loop.
  // Failure of removal/save does not roll back already completed binary effects.
  if (member.memberProperties.photoUrl) await binaryProvider.remove(member.memberProperties.photoUrl.split('/').pop());
  return save(store, loop, payload.id, saved.url, outbox);
}

export async function removeMemberPhoto(store, payload, binaryProvider, outbox) {
  const { loop, member } = target(store, payload);
  if (member.memberProperties.photoUrl) await binaryProvider.remove(member.memberProperties.photoUrl.split('/').pop());
  return save(store, loop, payload.id, null, outbox);
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
    let bytes = 0;
    stream = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 1000000000 ? Object.assign(new Error('Payload too large'), { code: 'RequestEntityTooLarge', statusCode: 413 }) : null, chunk);
    } });
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
