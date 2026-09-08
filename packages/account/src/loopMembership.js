// Loop lifecycle — membership, record, and bounded member-profile operations.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   handlers/loop.handler.ts, controllers/loop.ctrl.ts, schemes/{loop,member.status,member.type}.ts,
//   errors/loop.ts. API shapes: loop-2016-03-24.normal.json@155d20a8.
//
// This module implements the membership and bounded member-profile operations on the public
// Classic face. Identity is the
// stored access key (same as SuspendLoop); x-amz-credentials is not a caller switch.
// Invitation mail and InvitedToJoinLoop are explicit provider seams. Normal
// service construction can fill them from local SMTP/event configuration; when
// absent, the unavailable deployment boundary remains explicit and calls keep
// the source fire-and-forget behavior.

import { randomBytes } from 'node:crypto';
import { sendAmz, sendAmzError, accessKeyIdFromAuth } from './loopHttp.js';
import {
  findOrCreateRobotAccount,
  isAcceptedStatus,
  isMemberStatus,
  MEMBER_STATUS,
  MEMBER_TYPE,
  newId,
} from './model.js';
import { dispatchInvitationSideEffects } from './invitationProviders.js';
import { dispatchLoopCreated } from './loopCreation.js';
import { dispatchMembershipEvent } from './membershipEvents.js';
import { idsEqual, mapGetById } from './id.js';

const MAX_SIZE = 16;
const GENDERS = Object.freeze(['male', 'female', 'other', 'they']);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const COMMAND_RESULT = Object.freeze({ result: 'Command accepted' });

export const LOOP_MEMBERSHIP_ERRORS = Object.freeze({
  LOOP_NOT_FOUND: { code: 'LOOP_NOT_FOUND', message: 'Loop does not exist', statusCode: 404 },
  LOOP_SUSPENDED: { code: 'LOOP_SUSPENDED', message: 'Loop is suspended and cannot be modified', statusCode: 403 },
  CAN_BE_ACCESSED_BY_OWNER: {
    code: 'CAN_BE_ACCESSED_BY_OWNER',
    message: 'Only owner can manipulate this loop',
    statusCode: 403,
  },
  CAN_BE_ACCESSED_BY_OWNER_OR_SELF: {
    code: 'CAN_BE_ACCESSED_BY_OWNER_OR_SELF',
    message: 'Only owner can manipulate this loop or account himself',
    statusCode: 403,
  },
  CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT: {
    code: 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT',
    message: 'Only owner or robot can manipulate this loop',
    statusCode: 403,
  },
  CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN: {
    code: 'CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN',
    message: 'Only legal guardian can update child profile',
    statusCode: 403,
  },
  MEMBER_EXISTS: { code: 'MEMBER_EXISTS', message: 'Member already exists', statusCode: 409 },
  MEMBER_EMAIL_EXISTS: {
    code: 'MEMBER_EMAIL_EXISTS',
    message: 'Member with specified email already exists',
    statusCode: 409,
  },
  MEMBER_NOT_FOUND: { code: 'MEMBER_NOT_FOUND', message: 'Member not found', statusCode: 404 },
  ONLY_INVITED_OR_CHILD_EDITABLE: {
    code: 'ONLY_INVITED_OR_CHILD_EDITABLE',
    message: 'Only invited member or child can be edited',
    statusCode: 403,
  },
  EMAIL_CAN_BE_SET_ONCE: {
    code: 'EMAIL_CAN_BE_SET_ONCE',
    message: 'Email can only be set once for member',
    statusCode: 403,
  },
  INVITE_NOT_FOUND: { code: 'INVITE_NOT_FOUND', message: 'Invitation not found', statusCode: 404 },
  ACTIVE_LIMIT_REACHED: {
    code: 'ACTIVE_LIMIT_REACHED',
    message: 'Reached limit for active members',
    statusCode: 409,
  },
  ROBOT_REQUIRED: {
    code: 'ROBOT_REQUIRED',
    message: 'Robot is required for loop creation',
    statusCode: 422,
  },
  ROBOT_NOT_FOUND: { code: 'ROBOT_NOT_FOUND', message: 'Robot not found', statusCode: 404 },
  ROBOT_DISABLED: { code: 'ROBOT_DISABLED', message: 'Robot disabled', statusCode: 409 },
  CREDENTIALS_REQUIRED: { code: 'CREDENTIALS_REQUIRED', message: 'Credentials required', statusCode: 401 },
});

const HANDLERS = Object.freeze({
  createloop: createLoopHttp,
  create: createLoopHttp,
  inviteloopmember: inviteMemberHttp,
  invitemember: inviteMemberHttp,
  acceptloopinvitation: acceptInvitationHttp,
  acceptinvitation: acceptInvitationHttp,
  declineloopinvitation: declineInvitationHttp,
  declineinvitation: declineInvitationHttp,
  listloopmembers: listMembersHttp,
  listmembers: listMembersHttp,
  removeloopmember: removeMemberHttp,
  removemember: removeMemberHttp,
  updateloop: updateLoopHttp,
  removeloop: removeLoopHttp,
  clearrobot: clearRobotHttp,
  updateloopmember: updateMemberHttp,
  setenrollment: setEnrollmentHttp,
  updatenickname: updateNicknameHttp,
  updatephoneticname: updatePhoneticNameHttp,
});

const LOOP_RECORD_OPERATIONS = new Set(['updateloop', 'removeloop', 'clearrobot']);

export function isLoopRecordOperation(op) {
  return LOOP_RECORD_OPERATIONS.has(String(op || '').toLowerCase());
}

export class LoopError extends Error {
  constructor({ code, message, statusCode }) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(err) {
  throw new LoopError(err);
}

function invitationCode() {
  let n = BigInt(`0x${randomBytes(5).toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s || '1';
}

function callerAccount(store, req) {
  // Public Loop requests are authenticated by the shared robot face before
  // validation. Direct source-method controls may supply a synthetic request
  // without that gateway; the fallback below is only their internal identity seam.
  if (req && req._phoenixVerifiedCredentials) return req._phoenixVerifiedCredentials;
  const accessKeyId = accessKeyIdFromAuth(req);
  return accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
}

function activeLoopById(store, loopId) {
  const loop = mapGetById(store.loops, loopId);
  return loop && loop.isDeleted !== true ? loop : null;
}

function findById(store, loopId) {
  const loop = activeLoopById(store, loopId);
  if (!loop) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_NOT_FOUND);
  return loop;
}

function snapshotLoop(loop) {
  return JSON.parse(JSON.stringify(loop));
}

/**
 * Persist a loop draft and its LoopUpdated row together.
 *
 * Mongoose gives each source request a document that is backed by the database;
 * mutating that document before save() does not change the last committed
 * snapshot when save() rejects.  Store maps contain plain shared objects, so
 * callers must pass a pre-mutation snapshot and mutate a cloned draft.  Taking
 * the snapshot here would be too late for an already-mutated map object.
 */
function saveLoop(store, loop, loopUpdatedOutbox, before = undefined) {
  const priorStoredLoop = store.loops.get(loop._id);
  const previous = before === undefined
    ? (priorStoredLoop ? snapshotLoop(priorStoredLoop) : null)
    : before;
  loop.updated = Date.now();
  store.loops.set(loop._id, loop);
  try {
    loopUpdatedOutbox.record(loop);
  } catch (error) {
    if (previous) store.loops.set(previous._id, priorStoredLoop || previous);
    else store.loops.delete(loop._id);
    throw error;
  }
  return loop;
}

/** Source LoopController.update: owner-only name change with a command result. */
export function updateLoop(store, { ownerId, loopId, name }, loopUpdatedOutbox) {
  const storedLoop = findById(store, loopId);
  if (!idsEqual(storedLoop.owner, ownerId)) {
    fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER);
  }
  // The source assigns `name` before checking suspension on the request-local
  // Mongoose document. A rejected request does not save that assignment. Use a
  // detached draft so the in-memory Store has the same externally visible
  // result when a suspended loop is rejected.
  if (storedLoop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const { before, loop } = mutationDraft(storedLoop);
  loop.name = name;
  saveLoop(store, loop, loopUpdatedOutbox, before);
  return COMMAND_RESULT;
}

function removeLoopRecord(store, { ownerId = null, loopId, isAdmin = false }, loopUpdatedOutbox) {
  const storedLoop = findById(store, loopId);
  if (!idsEqual(storedLoop.owner, ownerId) && !isAdmin) {
    fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER);
  }
  const { before, loop } = mutationDraft(storedLoop);
  // The source removes the association by assigning undefined, then soft
  // deletes the document. Do not remove the member account row.
  loop.isDeleted = true;
  loop.robot = undefined;
  saveLoop(store, loop, loopUpdatedOutbox, before);
  return loop;
}

/** Source LoopController.remove: owner-only soft deletion returning a Loop. */
export function removeLoop(store, { ownerId = null, loopId }, loopUpdatedOutbox) {
  const loop = removeLoopRecord(store, { ownerId, loopId, isAdmin: false }, loopUpdatedOutbox);
  return populateLoop(store, loop);
}

/** Source LoopController.clearRobot: one active loop found by robot account. */
export function clearRobot(store, { robotId }, loopUpdatedOutbox) {
  const robot = store.accountByFriendlyId(robotId);
  if (!robot) fail(LOOP_MEMBERSHIP_ERRORS.ROBOT_NOT_FOUND);
  const loop = [...store.loops.values()].find((item) => item.isDeleted !== true
    && idsEqual(item.robot, robot._id));
  if (!loop) fail(LOOP_MEMBERSHIP_ERRORS.ROBOT_NOT_FOUND);
  const removed = removeLoopRecord(store, { loopId: loop._id, isAdmin: true }, loopUpdatedOutbox);
  return populateLoop(store, removed);
}

function mutationDraft(loop) {
  return { before: snapshotLoop(loop), loop: snapshotLoop(loop) };
}

function newMember({ accountId, status, memberProperties, invitationCode: code, invitedAsLegalGuardian }) {
  return {
    _id: newId(),
    accountId: accountId || undefined,
    status,
    invitationCode: code,
    invitedAsLegalGuardian: invitedAsLegalGuardian === true,
    memberProperties: memberProperties || {},
    enrolled: { face: false, voice: false },
    created: Date.now(),
  };
}

function memberToJson(member) {
  const accountId = member.accountId || undefined;
  const result = {
    id: member._id,
    accountId,
    memberId: accountId,
    status: isMemberStatus(member.status) ? String(member.status).toLowerCase() : member.status,
    invitedAsLegalGuardian: member.invitedAsLegalGuardian === true,
    enrolled: member.enrolled || { face: false, voice: false },
  };
  if (member.memberProperties) result.memberProperties = { ...member.memberProperties };
  if (member.created != null) result.created = Number(member.created);
  if (member.agreementId !== undefined) result.agreementId = member.agreementId;
  if (member.legalGuardianId !== undefined) result.legalGuardianId = member.legalGuardianId;
  if (member.nickname !== undefined) result.nickname = member.nickname;
  if (member.phoneticName !== undefined) result.phoneticName = member.phoneticName;
  return result;
}

function accountPublic(account, isRobotRequesting) {
  if (!account) return undefined;
  const copy = {
    birthday: account.birthday,
    email: account.email,
    // loop.ctrl.ts: loadMembers creates this key before the remaining
    // projection fields. It is undefined for a human request (and therefore
    // omitted by JSON.stringify), but robot requests assign the raw source
    // value, including null.
    facebookAccessToken: undefined,
    firstName: account.firstName,
    gender: account.gender,
    lastName: account.lastName,
    phoneNumber: account.phoneNumber,
    photoUrl: account.photoUrl,
  };
  if (isRobotRequesting) {
    copy.facebookAccessToken = account.facebookAccessToken;
  }
  if (copy.birthday != null) copy.birthday = Number(copy.birthday);
  return copy;
}

function loadAcceptedAccounts(store, members) {
  const found = {};
  for (const member of members) {
    if (member.accountId && isAcceptedStatus(member.status)) {
      const account = store.accounts.get(member.accountId);
      if (account) found[String(account._id)] = account;
    }
  }
  return found;
}

export function populateLoop(store, loop, isRobotRequesting = false) {
  if (!loop) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_NOT_FOUND);
  const existingAccounts = loadAcceptedAccounts(store, loop.members || []);
  const members = (loop.members || []).map((member) => {
    const json = memberToJson(member);
    json.loopId = loop._id;
    json.type = member.accountId && idsEqual(member.accountId, loop.owner)
      ? MEMBER_TYPE.INCOMING
      : MEMBER_TYPE.OUTGOING;
    const acc = member.accountId && existingAccounts[String(member.accountId)];
    if (isAcceptedStatus(member.status) && acc) {
      json.account = accountPublic(acc, isRobotRequesting);
    } else {
      json.account = member.memberProperties ? { ...member.memberProperties } : undefined;
    }
    if (json.account && json.account.birthday != null) {
      json.account.birthday = Number(json.account.birthday);
    }
    json.enrolled = member.enrolled || { face: false, voice: false };
    delete json.memberProperties;
    return json;
  });
  const robot = loop.robot ? store.accounts.get(loop.robot) : null;
  const result = {
    id: loop._id,
    name: loop.name,
    owner: loop.owner,
    robot: loop.robot,
    members,
    isSuspended: !!loop.isSuspended,
    created: loop.created,
  };
  if (loop.updated != null) result.updated = loop.updated;
  if (robot && robot.friendlyId) result.robotFriendlyId = robot.friendlyId;
  return result;
}

function loopToUnpopulated(loop) {
  const result = {
    id: loop._id,
    name: loop.name,
    owner: loop.owner,
    robot: loop.robot,
    members: (loop.members || []).map(memberToJson),
    isSuspended: !!loop.isSuspended,
    created: loop.created,
  };
  if (loop.updated != null) result.updated = loop.updated;
  return result;
}

function findMemberByIdOrEmail({ loop, accountId, email }) {
  return (loop.members || []).find((member) => (member.accountId && idsEqual(member.accountId, accountId))
    || (member.memberProperties && member.memberProperties.email && member.memberProperties.email === email)) || null;
}

function loopsVisibleToAccount(store, ownerId) {
  return [...store.loops.values()].filter((loop) => {
    if (loop.isDeleted === true) return false;
    if (idsEqual(loop.owner, ownerId)) return true;
    return (loop.members || []).some((member) => member.accountId && idsEqual(member.accountId, ownerId)
      && (isAcceptedStatus(member.status) || isMemberStatus(member.status, MEMBER_STATUS.INVITED)));
  });
}

function listLoopsForAccount(store, { ownerId, friendlyId = null, loopId = null }) {
  let loops = loopsVisibleToAccount(store, ownerId);
  if (loopId) loops = loops.filter((loop) => idsEqual(loop._id, loopId));
  const isRobotRequesting = loops.some((loop) => loop.robot && idsEqual(loop.robot, ownerId)) || !!friendlyId;
  const result = [];
  for (const loop of loops) {
    if (isRobotRequesting) {
      if (loop.isSuspended || !loop.robot || !idsEqual(loop.robot, ownerId)) continue;
    }
    result.push({ loop, populated: populateLoop(store, loop, isRobotRequesting) });
  }
  return { isRobotRequesting, items: result };
}

// OOBE.SetupRobot uses the same controller helper when replacing a robot on a
// suspended loop. Keep this export narrow so the OOBE face can reuse the
// source-shaped detached mutation and LoopUpdated persistence behavior.
export function removeRobotFromLoops(store, robotAccountId, loopUpdatedOutbox) {
  // Source query is `$or: [{ robot, members.accountId }]` — a one-element $or, so AND.
  const loops = [...store.loops.values()].filter((loop) => loop.isDeleted !== true
    && idsEqual(loop.robot, robotAccountId)
    && (loop.members || []).some((member) => idsEqual(member.accountId, robotAccountId)));
  for (const storedLoop of loops) {
    const { before, loop } = mutationDraft(storedLoop);
    if (loop.robot && idsEqual(loop.robot, robotAccountId)) {
      loop.robot = undefined;
      loop.isSuspended = true;
    }
    loop.members = (loop.members || []).filter((member) => !idsEqual(member.accountId, robotAccountId));
    saveLoop(store, loop, loopUpdatedOutbox, before);
  }
}

export function createLoopFromApi(store, { ownerId, name, robotId }, loopUpdatedOutbox, { invitationProviders } = {}) {
  if (!robotId) fail(LOOP_MEMBERSHIP_ERRORS.ROBOT_REQUIRED);
  if (!ownerId) fail(LOOP_MEMBERSHIP_ERRORS.CREDENTIALS_REQUIRED);
  const robotAccount = findOrCreateRobotAccount(store, robotId);
  removeRobotFromLoops(store, robotAccount._id, loopUpdatedOutbox);
  const loop = {
    _id: newId(),
    name,
    owner: ownerId,
    robot: robotAccount._id,
    members: [
      newMember({ accountId: ownerId, status: MEMBER_STATUS.ACCEPTED }),
      newMember({ accountId: robotAccount._id, status: MEMBER_STATUS.ACCEPTED }),
    ],
    isSuspended: false,
    created: Date.now(),
  };
  saveLoop(store, loop, loopUpdatedOutbox);
  const populated = populateLoop(store, loop);
  dispatchLoopCreated(loop, invitationProviders);
  return populated;
}

function addMember(store, {
  ownerId, loopId, accountId, code, memberProperties, invitedAsLegalGuardian,
}, loopUpdatedOutbox, { coppaEnabled = true, invitationProviders } = {}) {
  const storedLoop = findById(store, loopId);
  if (storedLoop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const { before, loop } = mutationDraft(storedLoop);
  const email = memberProperties && memberProperties.email;
  const existingMember = findMemberByIdOrEmail({ loop, accountId, email });
  if (existingMember) {
    if (isAcceptedStatus(existingMember.status)) fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_EXISTS);
    existingMember.status = MEMBER_STATUS.INVITED;
    existingMember.invitationCode = code;
    saveLoop(store, loop, loopUpdatedOutbox, before);
  }
  // Source compares the filtered array with MAX_SIZE, not `.length`. Preserve that.
  const existingAffectingSize = loop.members.filter((member) => !(loop.robot && idsEqual(loop.robot, member.account))
    && (isAcceptedStatus(member.status) || isMemberStatus(member.status, MEMBER_STATUS.INVITED)));
  if (existingAffectingSize >= MAX_SIZE) fail(LOOP_MEMBERSHIP_ERRORS.ACTIVE_LIMIT_REACHED);
  const memberIsChild = coppaEnabled && memberProperties && memberProperties.isChild;
  const memberStatus = memberProperties && !memberProperties.email && !memberIsChild
    ? MEMBER_STATUS.ACCEPTED
    : MEMBER_STATUS.INVITED;
  if (!existingMember) {
    loop.members.push(newMember({
      accountId,
      status: memberStatus,
      memberProperties,
      invitationCode: code,
      invitedAsLegalGuardian,
    }));
    saveLoop(store, loop, loopUpdatedOutbox, before);
  }
  if (email) {
    dispatchInvitationSideEffects(store, {
      accountId,
      code,
      email,
      loopId,
      loopOwnerId: loop.owner,
      memberProperties,
      ownerId,
    }, invitationProviders);
  }
  return loop;
}

export function inviteMember(store, payload, loopUpdatedOutbox, {
  coppaEnabled = true,
  invitationProviders,
} = {}) {
  const loop = findById(store, payload.loopId);
  if (!idsEqual(loop.owner, payload.ownerId)) fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER);
  let targetAccount = null;
  if (payload.email) {
    targetAccount = store.accountByEmail(payload.email);
    if (targetAccount && targetAccount.isDeleted === true) targetAccount = null;
  }
  const code = invitationCode();
  addMember(store, {
    accountId: targetAccount && targetAccount._id,
    code,
    invitedAsLegalGuardian: payload.asLegalGuardian === true,
    loopId: payload.loopId,
    memberProperties: {
      email: payload.email || null,
      firstName: payload.firstName || null,
      lastName: payload.lastName || null,
      gender: payload.gender,
      birthday: payload.birthday,
      isChild: payload.isChild === true,
      phoneNumber: payload.phoneNumber || null,
    },
    ownerId: payload.ownerId,
  }, loopUpdatedOutbox, { coppaEnabled, invitationProviders });
  return populateLoop(store, findById(store, payload.loopId));
}

export function acceptInvitation(store, { loopId, accountId }, loopUpdatedOutbox, { invitationProviders } = {}) {
  const storedLoop = findById(store, loopId);
  if (storedLoop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const { before, loop } = mutationDraft(storedLoop);
  const membership = (loop.members || []).find((member) => member.accountId
    && idsEqual(member.accountId, accountId)
    && isMemberStatus(member.status, MEMBER_STATUS.INVITED));
  if (!membership) fail(LOOP_MEMBERSHIP_ERRORS.INVITE_NOT_FOUND);
  membership.status = MEMBER_STATUS.ACCEPTED;
  saveLoop(store, loop, loopUpdatedOutbox, before);
  if (loop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const firstMembership = loop.members.find((member) => member.accountId && idsEqual(member.accountId, accountId));
  dispatchMembershipEvent('InvitationToLoopAccepted', loop, { accountId, invitedAsLegalGuardian: firstMembership.invitedAsLegalGuardian }, invitationProviders);
  return loopToUnpopulated(loop);
}

export function declineInvitation(store, { loopId, accountId }, loopUpdatedOutbox, { invitationProviders } = {}) {
  const storedLoop = findById(store, loopId);
  if (storedLoop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const { before, loop } = mutationDraft(storedLoop);
  const membership = (loop.members || []).find((member) => member.accountId && idsEqual(member.accountId, accountId));
  if (!membership) fail(LOOP_MEMBERSHIP_ERRORS.INVITE_NOT_FOUND);
  membership.status = MEMBER_STATUS.DECLINED;
  saveLoop(store, loop, loopUpdatedOutbox, before);
  const populated = populateLoop(store, loop);
  dispatchMembershipEvent('InvitationToLoopDeclined', loop, { accountId }, invitationProviders);
  return populated;
}

export function listMembers(store, { ownerId, friendlyId = null, statusList = null, typeList = null }) {
  const statuses = (!statusList || statusList.length === 0)
    ? [MEMBER_STATUS.INVITED, MEMBER_STATUS.ACCEPTED, MEMBER_STATUS.DECLINED, MEMBER_STATUS.REMOVED]
    : statusList.map((item) => String(item).toLowerCase());
  const types = (!typeList || typeList.length === 0)
    ? [MEMBER_TYPE.INCOMING, MEMBER_TYPE.OUTGOING]
    : typeList.map((item) => String(item).toLowerCase());
  const { items } = listLoopsForAccount(store, { ownerId, friendlyId });
  let members = [];
  for (const item of items) {
    members = [...members, ...item.populated.members.filter((member) => statuses.includes(member.status))];
  }
  return members.filter((member) => types.includes(member.type));
}

export function removeMember(store, { ownerId, loopId, id }, loopUpdatedOutbox, { invitationProviders } = {}) {
  const storedLoop = findById(store, loopId);
  const { before, loop } = mutationDraft(storedLoop);
  const targetMember = (loop.members || []).find((member) => idsEqual(member._id, id));
  if (!targetMember) fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_NOT_FOUND);
  if (!idsEqual(loop.owner, ownerId) && !(targetMember.accountId && idsEqual(targetMember.accountId, ownerId))) {
    fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER_OR_SELF);
  }
  if (loop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  targetMember.status = MEMBER_STATUS.REMOVED;
  saveLoop(store, loop, loopUpdatedOutbox, before);
  const populated = populateLoop(store, loop);
  dispatchMembershipEvent('MemberRemovedFromLoop', loop, { targetMember }, invitationProviders);
  return populated;
}

/**
 * UpdateLoopMember / LoopController.updateMember.
 *
 * Keep this separate from profileMember. The source looks up the member before
 * checking ownership, lets a legal guardian edit a child, and does not reject
 * a suspended loop here. Work on a request-local draft so an outbox/flush
 * failure cannot expose the source document's unsaved member fields.
 */
export function updateMember(store, {
  ownerId, loopId, id, email, firstName, lastName, gender, birthday, phoneNumber,
}, loopUpdatedOutbox, { coppaEnabled = true, invitationProviders } = {}) {
  const storedLoop = findById(store, loopId);
  const storedMember = (storedLoop.members || []).find((member) => idsEqual(member._id || member.id, id));
  if (!storedMember) fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_NOT_FOUND);

  const { before, loop } = mutationDraft(storedLoop);
  const member = (loop.members || []).find((item) => idsEqual(item._id || item.id, id));
  // Mongoose materializes this nested schema object for valid members. Older
  // imported Store records can omit it, so make the detached draft equivalent
  // before evaluating the source's child/editability fields.
  member.memberProperties = member.memberProperties || {};

  if (coppaEnabled && member.memberProperties.isChild) {
    const legalGuardianMember = (loop.members || []).find((item) =>
      idsEqual(item._id || item.id, member.legalGuardianId));
    if (!legalGuardianMember || !legalGuardianMember.accountId
      || !idsEqual(legalGuardianMember.accountId, ownerId)) {
      fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN);
    }
  } else if (!idsEqual(loop.owner, ownerId) && !(loop.robot && idsEqual(loop.robot, ownerId))) {
    fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT);
  }

  const invited = isMemberStatus(member.status, MEMBER_STATUS.INVITED);
  const acceptedWithoutEmail = isMemberStatus(member.status, MEMBER_STATUS.ACCEPTED)
    && !member.memberProperties.email;
  if (!invited && !member.memberProperties.isChild && !acceptedWithoutEmail) {
    fail(LOOP_MEMBERSHIP_ERRORS.ONLY_INVITED_OR_CHILD_EDITABLE);
  }

  // The source uses `||` for these assignments. Joi has already rejected
  // false/zero/non-string values, but null/omitted values still preserve the
  // previous field in exactly this way.
  member.memberProperties.firstName = firstName || member.memberProperties.firstName;
  member.memberProperties.lastName = lastName || member.memberProperties.lastName;
  member.memberProperties.gender = gender || member.memberProperties.gender;
  member.memberProperties.birthday = birthday || member.memberProperties.birthday;
  member.memberProperties.phoneNumber = phoneNumber || member.memberProperties.phoneNumber;

  // Joi.number() accepts a numeric string, but @jibo/server's validation
  // decorator discards the converted callback value. The controller therefore
  // assigns the original string and Mongoose casts the Number schema path when
  // saveAndPopulate runs. Store uses plain objects, so perform that persistence
  // cast at the same boundary while leaving the controller's `||` assignment
  // semantics intact (notably, numeric zero still preserves the old value).
  if (member.memberProperties.birthday !== null
    && member.memberProperties.birthday !== undefined
    && member.memberProperties.birthday !== '') {
    const birthdayNumber = Number(member.memberProperties.birthday);
    if (Number.isFinite(birthdayNumber)) member.memberProperties.birthday = birthdayNumber;
  }

  // Set email only once. An incoming email is normalized by the HTTP handler,
  // matching UpdateMember's source decorator method.
  if (member.memberProperties.email && email) {
    fail(LOOP_MEMBERSHIP_ERRORS.EMAIL_CAN_BE_SET_ONCE);
  }
  if (email) {
    const existingMemberWithSameEmail = (loop.members || []).find((item) =>
      item.memberProperties && item.memberProperties.email === email);
    if (existingMemberWithSameEmail && (
      isMemberStatus(existingMemberWithSameEmail.status, MEMBER_STATUS.REMOVED)
      || isMemberStatus(existingMemberWithSameEmail.status, MEMBER_STATUS.DECLINED)
    )) {
      const duplicateId = existingMemberWithSameEmail._id || existingMemberWithSameEmail.id;
      loop.members = loop.members.filter((item) => !idsEqual(item._id || item.id, duplicateId));
    } else if (existingMemberWithSameEmail) {
      fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_EMAIL_EXISTS);
    }

    // The source Account.findOne({ email }) has no isDeleted predicate. Keep
    // Store.accountByEmail's direct lookup so this boundary does not silently
    // invent an account or alter the source query's deletion semantics.
    const existingAccountWithSameEmail = store.accountByEmail(email);
    if (existingAccountWithSameEmail) member.accountId = existingAccountWithSameEmail._id;
    member.memberProperties.email = email;
    member.memberProperties.isChild = false;
    member.status = MEMBER_STATUS.INVITED;
    member.invitationCode = invitationCode();
    // Source UpdateMember invokes the mail and event providers before its
    // final saveAndPopulate. Each source provider is fire-and-forget after
    // invocation; a malformed seam that throws before returning a Promise is
    // allowed to reject the call.
    dispatchInvitationSideEffects(store, {
      accountId: member.accountId,
      code: member.invitationCode,
      email,
      loopId,
      loopOwnerId: loop.owner,
      memberProperties: member.memberProperties,
      ownerId,
    }, invitationProviders);
  }

  saveLoop(store, loop, loopUpdatedOutbox, before);
  return populateLoop(store, loop);
}

// These three operations intentionally keep the source's duplicated ordering:
// findById -> owner/robot authorization -> suspended guard -> member lookup.
// In particular, an unauthorized caller does not learn whether a member id
// exists, and a suspended loop does not mutate profile state.
function profileMember(store, { ownerId, loopId, id }) {
  const loop = findById(store, loopId);
  if (!idsEqual(loop.owner, ownerId) && !(loop.robot && idsEqual(loop.robot, ownerId))) {
    fail(LOOP_MEMBERSHIP_ERRORS.CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT);
  }
  if (loop.isSuspended) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_SUSPENDED);
  const member = (loop.members || []).find((item) => idsEqual(item._id, id));
  if (!member) fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_NOT_FOUND);
  // Model queries in the source return a per-request document. Keep failed
  // saves from exposing unsaved fields through the shared in-memory Store.
  const detachedLoop = snapshotLoop(loop);
  return { loop: detachedLoop, member: detachedLoop.members.find((item) => idsEqual(item._id, id)) };
}

export function setEnrollment(store, { ownerId, loopId, id, face, voice }, loopUpdatedOutbox) {
  const { loop, member } = profileMember(store, { ownerId, loopId, id });
  member.enrolled = member.enrolled || {};
  if (typeof face === 'boolean') member.enrolled.face = face;
  if (typeof voice === 'boolean') member.enrolled.voice = voice;
  saveLoop(store, loop, loopUpdatedOutbox);
  return populateLoop(store, loop);
}

export function updateNickname(store, { ownerId, loopId, id, nickname }, loopUpdatedOutbox) {
  const { loop, member } = profileMember(store, { ownerId, loopId, id });
  member.nickname = nickname;
  saveLoop(store, loop, loopUpdatedOutbox);
  return COMMAND_RESULT;
}

export function updatePhoneticName(store, { ownerId, loopId, id, phoneticName }, loopUpdatedOutbox) {
  const { loop, member } = profileMember(store, { ownerId, loopId, id });
  member.phoneticName = phoneticName;
  saveLoop(store, loop, loopUpdatedOutbox);
  return COMMAND_RESULT;
}

function childFail(field, reason) {
  return `child "${field}" fails because ["${field}" ${reason}]`;
}

function objectMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
  return null;
}

function hasField(body, field) {
  return Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined;
}

function requiredString(body, field) {
  if (!hasField(body, field)) return childFail(field, 'is required');
  if (typeof body[field] !== 'string') return childFail(field, 'must be a string');
  if (body[field].length === 0) return childFail(field, 'is not allowed to be empty');
  return null;
}

function optionalString(body, field) {
  if (!hasField(body, field)) return null;
  if (typeof body[field] !== 'string') return childFail(field, 'must be a string');
  if (body[field].length === 0) return childFail(field, 'is not allowed to be empty');
  return null;
}

function optionalNullableString(body, field) {
  if (!hasField(body, field)) return null;
  if (body[field] === null) return null;
  return optionalString(body, field);
}

function optionalEmail(body, field) {
  const base = optionalString(body, field);
  if (base) return base;
  if (!hasField(body, field)) return null;
  // Joi.string().email({ minDomainAtoms: 2 }) — domain must contain a dot.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body[field])) {
    return childFail(field, 'must be a valid email');
  }
  return null;
}

function optionalBoolean(body, field) {
  if (!hasField(body, field)) return null;
  if (typeof body[field] !== 'boolean') return childFail(field, 'must be a boolean');
  return null;
}

// The original Joi decorator accepts these string forms but discards its
// converted result. Pass the original value through so the controller's
// boolean-only assignments leave enrollment unchanged while still saving.
function optionalEnrollmentBoolean(body, field) {
  if (hasField(body, field) && typeof body[field] === 'string' && /^(true|false)$/i.test(body[field])) return null;
  return optionalBoolean(body, field);
}

function optionalNumberNull(body, field) {
  if (!hasField(body, field)) return null;
  if (body[field] === null) return null;
  if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
    return childFail(field, 'must be a number');
  }
  return null;
}

// The pinned UpdateMember handler declares Joi.number().allow(null). Joi 10.5.2
// accepts numeric strings after conversion, while the validatePayload decorator
// passes the original object to the controller. Validate the source domain here
// without replacing the request value, so the subsequent controller assignment
// and persistence cast remain observable separately.
function optionalSourceNumberNull(body, field) {
  if (!hasField(body, field)) return null;
  if (body[field] === null) return null;
  if (typeof body[field] === 'number') {
    return Number.isFinite(body[field]) ? null : childFail(field, 'must be a number');
  }
  if (typeof body[field] === 'string') {
    // Joi 10.5.2 does not accept an empty numeric string for this schema.
    if (body[field].trim().length === 0) return childFail(field, 'must be a number');
    const converted = Number(body[field]);
    return Number.isFinite(converted) ? null : childFail(field, 'must be a number');
  }
  return childFail(field, 'must be a number');
}

function optionalEnum(body, field, values) {
  const base = optionalString(body, field);
  if (base) return base;
  if (!hasField(body, field)) return null;
  if (!values.includes(body[field])) {
    return childFail(field, `must be one of [${values.join(', ')}]`);
  }
  return null;
}

function optionalStringArrayEnum(body, field, values) {
  if (!hasField(body, field)) return null;
  if (!Array.isArray(body[field])) return childFail(field, 'must be an array');
  for (let i = 0; i < body[field].length; i += 1) {
    const item = body[field][i];
    if (typeof item !== 'string') {
      return `child "${field}" fails because ["${field}" at position ${i} fails because ["${i}" must be a string]]`;
    }
    if (item.length === 0) {
      return `child "${field}" fails because ["${field}" at position ${i} fails because ["${i}" is not allowed to be empty]]`;
    }
    if (!values.includes(item)) {
      return `child "${field}" fails because ["${field}" at position ${i} fails because ["${i}" must be one of [${values.join(', ')}]]]`;
    }
  }
  return null;
}

function firstError(body, checks) {
  const objectErr = objectMessage(body);
  if (objectErr) return objectErr;
  for (const check of checks) {
    const err = check();
    if (err) return err;
  }
  return null;
}

function sendValidationError(res, message) {
  const body = JSON.stringify({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
  });
  res.removeHeader('x-powered-by');
  res.removeHeader('keep-alive');
  res.writeHead(422, {
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(body);
}

function respond(res, fn) {
  try {
    const result = fn();
    return void sendAmz(res, 200, result);
  } catch (error) {
    if (error instanceof LoopError) return void sendAmzError(res, error);
    throw error;
  }
}

async function createLoopHttp({ store, req, res, body, loopUpdatedOutbox, invitationProviders, robotReadClient }) {
  const message = firstError(body, [
    () => requiredString(body, 'name'),
    () => requiredString(body, 'robotId'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  let robot;
  try { robot = await robotReadClient.getRobot(body.robotId); } catch { /* Source tolerates lookup failure. */ }
  return respond(res, () => {
    if (robot?.payload?.suspended === true) fail(LOOP_MEMBERSHIP_ERRORS.ROBOT_DISABLED);
    return createLoopFromApi(store, {
    ownerId: caller && caller._id,
    name: body.name,
    robotId: body.robotId,
  }, loopUpdatedOutbox, { invitationProviders });
  });
}

function inviteMemberHttp({ store, req, res, body, loopUpdatedOutbox, coppaEnabled, invitationProviders }) {
  const message = firstError(body, [
    () => optionalBoolean(body, 'asLegalGuardian'),
    () => optionalNumberNull(body, 'birthday'),
    () => optionalEmail(body, 'email'),
    () => optionalString(body, 'firstName'),
    () => optionalEnum(body, 'gender', GENDERS),
    () => optionalBoolean(body, 'isChild'),
    () => optionalString(body, 'lastName'),
    () => requiredString(body, 'loopId'),
    () => optionalString(body, 'phoneNumber'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => inviteMember(store, {
    asLegalGuardian: body.asLegalGuardian,
    birthday: body.birthday,
    email: body.email ? String(body.email).toLowerCase() : null,
    firstName: body.firstName ? String(body.firstName).trim() : null,
    gender: body.gender,
    isChild: body.isChild,
    lastName: body.lastName ? String(body.lastName).trim() : null,
    loopId: body.loopId,
    ownerId: caller && caller._id,
    phoneNumber: body.phoneNumber,
  }, loopUpdatedOutbox, { coppaEnabled, invitationProviders }));
}

function acceptInvitationHttp({ store, req, res, body, loopUpdatedOutbox, invitationProviders }) {
  const message = firstError(body, [() => requiredString(body, 'loopId')]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => acceptInvitation(store, {
    accountId: caller && caller._id,
    loopId: body.loopId,
  }, loopUpdatedOutbox, { invitationProviders }));
}

function declineInvitationHttp({ store, req, res, body, loopUpdatedOutbox, invitationProviders }) {
  const message = firstError(body, [() => requiredString(body, 'loopId')]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => declineInvitation(store, {
    accountId: caller && caller._id,
    loopId: body.loopId,
  }, loopUpdatedOutbox, { invitationProviders }));
}

function listMembersHttp({ store, req, res, body }) {
  const message = firstError(body, [
    () => optionalStringArrayEnum(body, 'statusList', [
      MEMBER_STATUS.ACCEPTED, MEMBER_STATUS.DECLINED, MEMBER_STATUS.REMOVED, MEMBER_STATUS.INVITED,
    ]),
    () => optionalStringArrayEnum(body, 'typeList', [MEMBER_TYPE.INCOMING, MEMBER_TYPE.OUTGOING]),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => listMembers(store, {
    friendlyId: caller && caller.friendlyId,
    ownerId: caller && caller._id,
    statusList: body.statusList,
    typeList: body.typeList,
  }));
}

function removeMemberHttp({ store, req, res, body, loopUpdatedOutbox, invitationProviders }) {
  const message = firstError(body, [
    () => requiredString(body, 'id'),
    () => requiredString(body, 'loopId'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => removeMember(store, {
    id: body.id,
    loopId: body.loopId,
    ownerId: caller && caller._id,
  }, loopUpdatedOutbox, { invitationProviders }));
}

function updateMemberHttp({ store, req, res, body, loopUpdatedOutbox, coppaEnabled, invitationProviders }) {
  const message = firstError(body, [
    () => optionalSourceNumberNull(body, 'birthday'),
    () => optionalEmail(body, 'email'),
    () => optionalString(body, 'firstName'),
    () => optionalEnum(body, 'gender', GENDERS),
    () => requiredString(body, 'id'),
    () => optionalString(body, 'lastName'),
    () => requiredString(body, 'loopId'),
    () => optionalString(body, 'phoneNumber'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => updateMember(store, {
    birthday: body.birthday,
    email: body.email ? String(body.email).toLowerCase() : null,
    firstName: body.firstName ? String(body.firstName).trim() : null,
    gender: body.gender,
    id: body.id,
    lastName: body.lastName ? String(body.lastName).trim() : null,
    loopId: body.loopId,
    ownerId: caller && caller._id,
    phoneNumber: body.phoneNumber,
  }, loopUpdatedOutbox, { coppaEnabled, invitationProviders }));
}

function setEnrollmentHttp({ store, req, res, body, loopUpdatedOutbox }) {
  const message = firstError(body, [
    () => optionalEnrollmentBoolean(body, 'face'),
    () => requiredString(body, 'id'),
    () => requiredString(body, 'loopId'),
    () => optionalEnrollmentBoolean(body, 'voice'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => setEnrollment(store, {
    face: body.face,
    id: body.id,
    loopId: body.loopId,
    ownerId: caller && caller._id,
    voice: body.voice,
  }, loopUpdatedOutbox));
}

function updateNicknameHttp({ store, req, res, body, loopUpdatedOutbox }) {
  const message = firstError(body, [
    () => requiredString(body, 'id'),
    () => requiredString(body, 'loopId'),
    () => optionalNullableString(body, 'nickname'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => updateNickname(store, {
    id: body.id,
    loopId: body.loopId,
    nickname: body.nickname,
    ownerId: caller && caller._id,
  }, loopUpdatedOutbox));
}

function updatePhoneticNameHttp({ store, req, res, body, loopUpdatedOutbox }) {
  const message = firstError(body, [
    () => requiredString(body, 'id'),
    () => requiredString(body, 'loopId'),
    () => optionalNullableString(body, 'phoneticName'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => updatePhoneticName(store, {
    id: body.id,
    loopId: body.loopId,
    phoneticName: body.phoneticName,
    ownerId: caller && caller._id,
  }, loopUpdatedOutbox));
}

function updateLoopHttp({ store, req, res, body, loopUpdatedOutbox }) {
  // Handler schema order is loopId, then name (loop.handler.ts:53-56).
  const message = firstError(body, [
    () => requiredString(body, 'loopId'),
    () => requiredString(body, 'name'),
  ]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => updateLoop(store, {
    loopId: body.loopId,
    name: body.name,
    ownerId: caller && caller._id,
  }, loopUpdatedOutbox));
}

function removeLoopHttp({ store, req, res, body, loopUpdatedOutbox }) {
  const message = firstError(body, [() => requiredString(body, 'loopId')]);
  if (message) return void sendValidationError(res, message);
  const caller = callerAccount(store, req);
  return respond(res, () => removeLoop(store, {
    loopId: body.loopId,
    ownerId: caller && caller._id,
  }, loopUpdatedOutbox));
}

function clearRobotHttp({ store, req, res, body, loopUpdatedOutbox }) {
  const caller = callerAccount(store, req);
  // @parseCredentials({ adminOnly: true }) runs before @validatePayload in
  // the source handler. The public face resolves this from the signed access
  // key; x-amz-credentials cannot turn an ordinary account into an admin.
  if (!caller || !caller.isAdmin) {
    return void sendAmzError(res, {
      code: 'AUTHORIZED_UNDER_ADMIN',
      message: 'Must be authorized under admin account',
      statusCode: 401,
    });
  }
  const message = firstError(body, [() => requiredString(body, 'robotId')]);
  if (message) return void sendValidationError(res, message);
  return respond(res, () => clearRobot(store, { robotId: body.robotId }, loopUpdatedOutbox));
}

/** @returns {boolean} true when this Loop operation is a membership-lifecycle handler. */
export function handleLoopMembership({
  store, req, res, body, op, log, loopUpdatedOutbox, coppaEnabled = true, invitationProviders, robotReadClient,
}) {
  const handler = HANDLERS[String(op || '').toLowerCase()];
  if (!handler) return false;
  log?.info?.('loop membership request', { op });
  const result = handler({
    store,
    req,
    res,
    body: body === undefined ? {} : body,
    loopUpdatedOutbox,
    coppaEnabled,
    invitationProviders,
    robotReadClient,
  });
  return result && typeof result.then === 'function' ? result.then(() => true) : true;
}
