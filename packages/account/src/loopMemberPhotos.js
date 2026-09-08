// LoopController.updateMemberPhoto/removeMemberPhoto at srv-account-ws@6cea434.
import { populateLoop, LOOP_MEMBERSHIP_ERRORS } from './loopMembership.js';

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
