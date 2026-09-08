// Local-only migration of a preserved robot household into the Phoenix account
// store. This module reads supplied snapshots and stages a new one; it never
// replaces or writes the configured live store.  The source inputs are the local KB root
// and user-node snapshots captured by the operator.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './store.js';
import { populateLoop, MEMBER_STATUS, isMemberStatus } from './model.js';

const COLLECTIONS = Object.freeze([
  'accounts',
  'loops',
  'tokens',
  'sessions',
  'settings',
  'notificationOutbox',
]);

// A household import may copy public profile fields, but credentials and
// bearer material must come only from the already adopted robot account in the
// current store.  Rejecting these keys also prevents an accidentally supplied
// KB export from becoming a credential source.
const SENSITIVE_KEY = /(?:secret|password|token|authorization|accesskey|credential|privatekey)/i;
const PUBLIC_ACCOUNT_FIELDS = new Set([
  'birthday',
  'email',
  'firstName',
  'gender',
  // The source may include this on an accepted account.  Phoenix's
  // populateLoop projection intentionally omits it, but retaining it on the
  // local account record is harmless and avoids rejecting a source profile.
  'isChild',
  'lastName',
  'phoneNumber',
  'photoUrl',
]);
const WIRE_ACCOUNT_FIELDS = new Set([...PUBLIC_ACCOUNT_FIELDS].filter((key) => key !== 'isChild'));

export const HOUSEHOLD_COLLECTIONS = COLLECTIONS;

export class HouseholdImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HouseholdImportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HouseholdImportError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function idLabel(value) {
  const text = String(value);
  return `${sha256(text).slice(0, 16)}:${text.length}`;
}

function requireObject(value, label) {
  if (!isObject(value)) fail('INVALID_SOURCE', `${label} must be a JSON object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail('INVALID_SOURCE', `${label} must be a JSON array`);
  return value;
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_SOURCE', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalId(value, label) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireId(value, label);
}

function assertNoSensitiveKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      fail('SOURCE_CREDENTIAL_FIELD', `source contains a private field at ${path}.${key}`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateStatusCounts(counts, expected) {
  if (expected === undefined) return;
  requireObject(expected, 'expected status counts');
  for (const [name, count] of Object.entries(expected)) {
    if (!Object.values(MEMBER_STATUS).includes(name) || !Number.isSafeInteger(count) || count < 0) {
      fail('INVALID_ARGUMENTS', 'expected status counts must use known statuses and nonnegative integers');
    }
    if (counts[name] !== count) fail('SOURCE_STATUS_COUNTS', 'source status counts do not match the supplied guard');
  }
}

function validateEdges(root, nodeIds) {
  const edges = requireObject(root.edges, 'root.edges');
  const userIds = requireArray(edges.user, 'root.edges.user').map((value, index) =>
    requireId(value, `root.edges.user[${index}]`));
  if (new Set(userIds).size !== userIds.length) {
    fail('INVALID_SOURCE', 'root.edges.user contains duplicate member node IDs');
  }
  if (userIds.length !== nodeIds.size || userIds.some((id) => !nodeIds.has(id))) {
    fail('INVALID_SOURCE', 'root.edges.user does not exactly enumerate the captured member nodes');
  }
  for (const name of ['owner', 'robot']) {
    const values = requireArray(edges[name], `root.edges.${name}`).map((value, index) =>
      requireId(value, `root.edges.${name}[${index}]`));
    if (values.length !== 1 || !nodeIds.has(values[0])) {
      fail('INVALID_SOURCE', `root.edges.${name} must contain one captured member node`);
    }
  }
  return { userIds, ownerNodeId: edges.owner[0], robotNodeId: edges.robot[0] };
}

function accountProfile(data, index, accountId) {
  const profile = data.account === undefined
    ? {}
    : clone(requireObject(data.account, `users[${index}].data.account`));
  // LoopManager's merge accepts these profile fields both from the nested
  // account object and from the member payload.  Apply the payload value when
  // present, matching the source's later-field-wins merge without copying
  // arbitrary member metadata into an Account.
  for (const key of PUBLIC_ACCOUNT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) profile[key] = clone(data[key]);
  }
  assertNoSensitiveKeys(profile, `users[${index}].data.account`);
  // The model's accepted-account projection has a bounded public field set.
  // An account-less member uses memberProperties and can retain the source's
  // complete profile, but a real account must be representable on its wire.
  for (const key of Object.keys(profile)) {
    if (accountId != null && !PUBLIC_ACCOUNT_FIELDS.has(key)) {
      fail('UNSUPPORTED_PROFILE_FIELD', `source account field ${key} is not supported by the account wire projection`);
    }
  }
  return clone(profile);
}

function sourceMember(rootData, node, index) {
  const data = requireObject(node.data, `users[${index}].data`);
  const nodeId = requireId(node._id, `users[${index}]._id`);
  const dataId = requireId(data.id, `users[${index}].data.id`);
  if (nodeId !== dataId) fail('INVALID_SOURCE', `users[${index}] node ID does not equal data.id`);
  if (data.loopId !== rootData.id) fail('INVALID_SOURCE', `users[${index}] belongs to a different loop`);

  const status = String(data.status || '').toLowerCase();
  if (!isMemberStatus(status)) {
    fail('INVALID_SOURCE', `users[${index}] has unsupported status ${status || '(empty)'}`);
  }
  const enrolled = requireObject(data.enrolled, `users[${index}].data.enrolled`);
  if (typeof enrolled.face !== 'boolean' || typeof enrolled.voice !== 'boolean') {
    fail('INVALID_SOURCE', `users[${index}].data.enrolled must contain boolean face and voice flags`);
  }
  const accountId = optionalId(data.accountId, `users[${index}].data.accountId`);
  const profile = accountProfile(data, index, accountId);
  const member = {
    _id: nodeId,
    // Preserve the source's accountId presence exactly.  Historical local-KB
    // members omit it; an explicit JSON null, if supplied by another capture,
    // remains null rather than becoming a generated account.
    accountId,
    // The source member schema stores its enum in lowercase; populateLoop is
    // the wire projection and preserves that spelling.
    status,
    enrolled: clone(enrolled),
    created: data.created,
  };
  // memberProperties preserves the source nested account object.  It is the
  // source-compatible fallback for an account-less member and also keeps the
  // robot's explicit empty account object available to the model contract.
  member.memberProperties = profile;
  if (Object.prototype.hasOwnProperty.call(data, 'nickName')) member.nickname = data.nickName;
  if (Object.prototype.hasOwnProperty.call(data, 'phoneticName')) member.phoneticName = data.phoneticName;
  if (Object.prototype.hasOwnProperty.call(data, 'legalGuardianId')) member.legalGuardianId = data.legalGuardianId;
  if (Object.prototype.hasOwnProperty.call(data, 'agreementId')) member.agreementId = data.agreementId;
  return {
    nodeId,
    accountId,
    profile,
    status,
    enrolled: clone(enrolled),
    sourceType: data.type,
    member,
  };
}

/**
 * Validate and normalize the captured local KB into the Store model's loop
 * representation.  Absent or null account IDs are source data, not generated
 * IDs.
 */
export function normalizeHousehold(rootSnapshot, usersSnapshot, {
  expectedStatusCounts,
} = {}) {
  const root = requireObject(rootSnapshot, 'root snapshot');
  const rootData = requireObject(root.data, 'root.data');
  const loopId = requireId(rootData.id, 'root.data.id');
  const ownerId = requireId(rootData.owner, 'root.data.owner');
  const robotId = requireId(rootData.robot, 'root.data.robot');
  const robotFriendlyId = requireId(rootData.robotFriendlyId, 'root.data.robotFriendlyId');
  if (ownerId === robotId) fail('INVALID_SOURCE', 'source owner and robot account IDs are equal');
  const users = requireArray(usersSnapshot, 'users snapshot');
  if (users.length === 0) fail('INVALID_SOURCE', 'users snapshot is empty');

  const rawNodes = users.map((node, index) => {
    requireObject(node, `users[${index}]`);
    return sourceMember(rootData, node, index);
  });
  const nodeIds = new Set(rawNodes.map((item) => item.nodeId));
  if (nodeIds.size !== rawNodes.length) fail('INVALID_SOURCE', 'users snapshot contains duplicate node IDs');
  const edges = validateEdges(root, nodeIds);
  if (edges.ownerNodeId !== rawNodes.find((item) => item.accountId === ownerId)?.nodeId) {
    fail('INVALID_SOURCE', 'root owner edge does not resolve to the owner account member');
  }
  if (edges.robotNodeId !== rawNodes.find((item) => item.accountId === robotId)?.nodeId) {
    fail('INVALID_SOURCE', 'root robot edge does not resolve to the robot account member');
  }
  const byNode = new Map(rawNodes.map((item) => [item.nodeId, item]));
  const ordered = edges.userIds.map((id) => byNode.get(id));
  const counts = ordered.reduce((result, item) => {
    result[item.status] += 1;
    return result;
  }, Object.fromEntries(Object.values(MEMBER_STATUS).map((status) => [status, 0])));
  validateStatusCounts(counts, expectedStatusCounts);

  const profiles = new Map();
  for (const item of ordered) {
    if (item.accountId == null) continue;
    if (item.accountId !== ownerId && item.accountId !== robotId && Object.keys(item.profile).length === 0) {
      fail('UNRESOLVED_ACCOUNT', `source member ${idLabel(item.nodeId)} names an account without profile data`);
    }
    if (profiles.has(item.accountId)) {
      fail('DUPLICATE_SOURCE_ACCOUNT', 'source members contain duplicate non-null account IDs');
    }
    profiles.set(item.accountId, clone(item.profile));
  }
  if (!profiles.has(ownerId) || !profiles.has(robotId)) {
    fail('INVALID_SOURCE', 'source owner and robot account members must carry account IDs');
  }
  const owner = ordered.find((item) => item.accountId === ownerId);
  const robot = ordered.find((item) => item.accountId === robotId);
  if (owner.status !== 'accepted' || robot.status !== 'accepted') {
    fail('INVALID_SOURCE', 'source owner and robot members must be accepted');
  }
  if (owner.sourceType !== undefined && String(owner.sourceType).toLowerCase() !== 'incoming') {
    fail('INVALID_SOURCE', 'source owner member type is not incoming');
  }
  for (const item of ordered) {
    if (item.sourceType !== undefined) {
      const expected = item.accountId === ownerId ? 'incoming' : 'outgoing';
      if (String(item.sourceType).toLowerCase() !== expected) {
        fail('INVALID_SOURCE', `source member ${idLabel(item.nodeId)} has an inconsistent type`);
      }
    }
  }

  const loop = {
    _id: loopId,
    name: rootData.name,
    owner: ownerId,
    robot: robotId,
    members: ordered.map((item) => item.member),
    isSuspended: rootData.isSuspended === true,
    created: rootData.created,
    updated: rootData.updated,
  };
  return {
    loop,
    loopId,
    ownerId,
    robotId,
    robotFriendlyId,
    members: ordered,
    profiles,
    counts,
    unresolvedAccountMembers: ordered.filter((item) => item.accountId == null).length,
  };
}

function validateStoreSnapshot(snapshot) {
  requireObject(snapshot, 'current store snapshot');
  if (Object.keys(snapshot).some((key) => !COLLECTIONS.includes(key))) {
    fail('UNSUPPORTED_COLLECTION', 'current store contains fields the runtime cannot preserve on save');
  }
  for (const collection of COLLECTIONS) {
    const ids = new Set();
    const values = snapshot[collection] === undefined ? [] : snapshot[collection];
    requireArray(values, `current store ${collection}`);
    for (const [index, item] of values.entries()) {
      requireObject(item, `current store ${collection}[${index}]`);
      requireId(item._id, `current store ${collection}[${index}]._id`);
      if (ids.has(item._id)) fail('DUPLICATE_STORE_ID', `current store ${collection} contains duplicate IDs`);
      ids.add(item._id);
    }
  }
}

function storeFromSnapshot(snapshot) {
  const file = resolve(tmpdir(), `.phoenix-household-import-${process.pid}-${randomUUID()}.json`);
  const store = new Store(file);
  for (const collection of COLLECTIONS) {
    store[collection].clear();
    for (const item of snapshot[collection] || []) store[collection].set(item._id, clone(item));
  }
  return store;
}

function snapshotFromStore(original, store) {
  const result = clone(original);
  for (const collection of COLLECTIONS) result[collection] = [...store[collection].values()].map(clone);
  return result;
}

function findReferences(value, needles, path, found = []) {
  if (typeof value === 'string' && needles.has(value)) found.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => findReferences(item, needles, `${path}[${index}]`, found));
  else if (isObject(value)) Object.entries(value).forEach(([key, child]) => findReferences(child, needles, `${path}.${key}`, found));
  return found;
}

function assertNoAuxiliaryReferences(snapshot, oldRobotId, oldLoopId, source) {
  const needles = new Set();
  if (oldRobotId !== source.robotId) needles.add(oldRobotId);
  if (oldLoopId !== source.loopId) needles.add(oldLoopId);
  for (const collection of ['tokens', 'sessions', 'settings', 'notificationOutbox']) {
    const paths = findReferences(snapshot[collection] || [], needles, collection);
    if (paths.length > 0) {
      fail('UNRESOLVED_REFERENCE', `current ${collection} contains a reference to the replaced robot/loop`, { paths });
    }
  }
}

function assertNoOldRobotOutsideAdoptedLoop(store, oldRobotId, adoptedLoopId) {
  for (const loop of store.loops.values()) {
    if (loop._id === adoptedLoopId) continue;
    const paths = findReferences(loop, new Set([oldRobotId]), `loops.${loop._id}`);
    if (paths.length > 0) {
      fail('CONFLICT_OLD_ROBOT_REFERENCE', 'the adopted robot is referenced by another preserved loop', { paths });
    }
  }
}

function assertMemberIdsFree(store, sourceMembers, adoptedLoopId) {
  const ids = new Set(sourceMembers.map((member) => member.nodeId));
  for (const loop of store.loops.values()) {
    if (loop._id === adoptedLoopId) continue;
    for (const member of loop.members || []) {
      if (member._id && ids.has(member._id)) {
        fail('CONFLICT_MEMBER_ID', 'a preserved loop already uses an imported member node ID', {
          memberId: idLabel(member._id), loopId: idLabel(loop._id),
        });
      }
    }
  }
}

function isPristineBootstrap(loop) {
  const members = loop.members;
  const roles = new Set([loop.owner, loop.robot]);
  const allowedFields = new Set(['_id', 'id', 'accountId', 'status', 'enrolled', 'created']);
  return roles.size === 2 && !roles.has(undefined) && !roles.has(null)
    && !loop.isSuspended && Array.isArray(members) && members.length === 2
    && new Set(members.map((m) => m.accountId)).size === 2
    && members.every((m) => roles.has(m.accountId) && isMemberStatus(m.status, MEMBER_STATUS.ACCEPTED)
      && Object.keys(m).every((key) => allowedFields.has(key))
      && (m.enrolled === undefined || (isObject(m.enrolled)
        && Object.entries(m.enrolled).every(([key, value]) => ['face', 'voice'].includes(key) && value === false))));
}

function assertSharedProfileUnchanged(store, accountId, profile, adoptedLoopId) {
  const existing = store.accounts.get(accountId);
  if (!existing || Object.entries(profile).every(([key, value]) => isDeepStrictEqual(existing[key], value))) return;
  for (const loop of store.loops.values()) {
    if (loop._id !== adoptedLoopId && findReferences(loop, new Set([accountId]), 'loop').length) {
      fail('SHARED_PROFILE_CONFLICT', 'source profile differs from an account referenced by a preserved loop');
    }
  }
}

function mergeAccount(store, accountId, profile, {
  robot = false,
  friendlyId = null,
  oldRobotAccount = null,
} = {}) {
  const existing = store.accounts.get(accountId);
  const credentialSource = robot && !existing ? oldRobotAccount : null;
  const merged = existing
    ? { ...existing }
    : (credentialSource ? { ...credentialSource } : { _id: accountId, isActive: false });
  Object.assign(merged, clone(profile));
  merged._id = accountId;
  if (robot) {
    if (!existing && !credentialSource) {
      fail('MISSING_ROBOT_CREDENTIALS', 'preserved robot account was not found in the current store');
    }
    if (!merged.accessKeyId || !merged.secretAccessKey) {
      fail('MISSING_ROBOT_CREDENTIALS', 'current adopted robot has no complete access-key pair');
    }
    merged.friendlyId = friendlyId;
    // A transferred robot may already be inactive.  Preserve that state;
    // default only when neither the existing nor credential-source record
    // contains an isActive field.
    merged.isActive = merged.isActive === undefined ? true : merged.isActive;
  }
  store.accounts.set(accountId, merged);
  return merged;
}

function verifyWire(source, wire) {
  if (!wire || wire.id !== source.loopId || wire.owner !== source.ownerId || wire.robot !== source.robotId) {
    fail('WIRE_RECONSTRUCTION', 'populateLoop did not preserve the source loop identity');
  }
  if (!Array.isArray(wire.members) || wire.members.length !== source.members.length) {
    fail('WIRE_RECONSTRUCTION', 'populateLoop changed the source member count');
  }
  for (let index = 0; index < source.members.length; index += 1) {
    const expected = source.members[index];
    const actual = wire.members[index];
    if (actual.id !== expected.nodeId
      || actual.accountId !== expected.accountId
      || actual.status !== expected.status
      || !sameJson(actual.enrolled, expected.enrolled)) {
      fail('WIRE_RECONSTRUCTION', `populateLoop changed member identity/status/enrollment at index ${index}`);
    }
    const expectedType = expected.accountId === source.ownerId ? 'incoming' : 'outgoing';
    if (actual.type !== expectedType || actual.loopId !== source.loopId) {
      fail('WIRE_RECONSTRUCTION', `populateLoop changed member type/loop ID at index ${index}`);
    }
    const expectedWireProfile = expected.accountId == null || expected.status !== MEMBER_STATUS.ACCEPTED
      ? expected.profile
      : Object.fromEntries(Object.entries(expected.profile)
        .filter(([key]) => WIRE_ACCOUNT_FIELDS.has(key)));
    for (const [key, value] of Object.entries(expectedWireProfile)) {
      if (!actual.account || !sameJson(actual.account[key], value)) {
        fail('WIRE_RECONSTRUCTION', `populateLoop dropped profile field ${key} at member index ${index}`);
      }
    }
    if (expected.member.nickname !== undefined && actual.nickname !== expected.member.nickname) {
      fail('WIRE_RECONSTRUCTION', `populateLoop dropped nickname at member index ${index}`);
    }
    if (expected.member.phoneticName !== undefined && actual.phoneticName !== expected.member.phoneticName) {
      fail('WIRE_RECONSTRUCTION', `populateLoop dropped phoneticName at member index ${index}`);
    }
  }
}

/**
 * Build a merged Store snapshot without writing it.  This is the primary
 * reusable API used by the staging CLI and synthetic tests.
 */
export function buildHouseholdImport({
  currentSnapshot,
  rootSnapshot,
  usersSnapshot,
  expectedStatusCounts,
} = {}) {
  validateStoreSnapshot(currentSnapshot);
  const source = normalizeHousehold(rootSnapshot, usersSnapshot, { expectedStatusCounts });
  const store = storeFromSnapshot(currentSnapshot);

  const robotCandidates = [...store.accounts.values()]
    .filter((account) => account.friendlyId === source.robotFriendlyId);
  if (robotCandidates.length !== 1) {
    fail('ADOPTED_ROBOT_NOT_UNIQUE', 'current store must contain exactly one adopted robot for the source friendly ID');
  }
  const oldRobot = robotCandidates[0];
  if (!oldRobot.accessKeyId || !oldRobot.secretAccessKey) {
    fail('MISSING_ROBOT_CREDENTIALS', 'current adopted robot has no complete access-key pair');
  }
  const adoptedLoops = [...store.loops.values()]
    .filter((loop) => loop.robot === oldRobot._id && loop.isDeleted !== true);
  if (adoptedLoops.length !== 1) {
    fail('ADOPTED_LOOP_NOT_UNIQUE', 'current adopted robot must have exactly one active loop');
  }
  const adoptedLoop = adoptedLoops[0];
  const pristine = isPristineBootstrap(adoptedLoop);
  const priorWire = pristine ? null : JSON.parse(JSON.stringify(populateLoop(store, adoptedLoop, { isRobotRequesting: true })));
  if (!pristine && (adoptedLoop._id !== source.loopId || oldRobot._id !== source.robotId)) {
    fail('NON_PRISTINE_LOOP', 'current household is not an unchanged bootstrap; resolve migration explicitly');
  }
  assertNoOldRobotOutsideAdoptedLoop(store, oldRobot._id, adoptedLoop._id);
  assertNoAuxiliaryReferences(currentSnapshot, oldRobot._id, adoptedLoop._id, source);
  assertMemberIdsFree(store, source.members, adoptedLoop._id);

  // A source account role may not silently reuse the other role's adopted
  // account.  Doing so would either turn the preserved robot keys into a
  // human account or transfer a human account's credentials to the robot.
  if ((source.robotId !== oldRobot._id && source.profiles.has(oldRobot._id))
    || (source.robotId !== oldRobot._id && store.accounts.has(source.robotId))) {
    fail('CONFLICT_ACCOUNT_ID', 'source owner/robot account ID conflicts with the adopted robot or another existing account', {
      role: source.profiles.has(oldRobot._id) ? 'non-robot' : 'robot',
    });
  }

  const existingLoop = store.loops.get(source.loopId);
  if (existingLoop && existingLoop._id !== adoptedLoop._id) {
    fail('CONFLICT_LOOP_ID', 'source loop ID already belongs to a preserved loop', {
      loopId: idLabel(source.loopId),
    });
  }

  // Only an account already belonging to the adopted loop may be reconciled
  // by ID.  Every other existing account collision is a hard stop.
  const adoptedAccountIds = new Set([
    adoptedLoop.owner,
    adoptedLoop.robot,
    ...(adoptedLoop.members || []).map((member) => member.accountId).filter(Boolean),
  ]);
  for (const accountId of source.profiles.keys()) {
    const existing = store.accounts.get(accountId);
    if (existing && accountId !== oldRobot._id && !adoptedAccountIds.has(accountId)) {
      fail('CONFLICT_ACCOUNT_ID', 'source account ID already belongs to an unrelated account', {
        accountId: idLabel(accountId),
      });
    }
  }

  // Source robot IDs are authoritative.  Remove the old generated ID before
  // inserting the preserved ID so accountByAccessKeyId cannot resolve a stale
  // duplicate first.  No human account credentials are ever generated.
  if (source.robotId !== oldRobot._id) store.accounts.delete(oldRobot._id);
  for (const [accountId, profile] of source.profiles) {
    assertSharedProfileUnchanged(store, accountId, profile, adoptedLoop._id);
    mergeAccount(store, accountId, profile, {
      robot: accountId === source.robotId,
      friendlyId: source.robotFriendlyId,
      oldRobotAccount: oldRobot,
    });
  }
  // A source owner with an empty profile is still a valid source account, but
  // its account record must remain credential-less unless the same ID was
  // already present in the adopted loop.
  const importedLoop = clone(source.loop);
  store.loops.delete(adoptedLoop._id);
  store.loops.set(importedLoop._id, importedLoop);

  const wire = populateLoop(store, importedLoop, { isRobotRequesting: true });
  verifyWire(source, wire);
  if (!pristine && !isDeepStrictEqual(priorWire, JSON.parse(JSON.stringify(wire)))) {
    fail('NON_PRISTINE_LOOP', 'staging would change an existing household; resolve migration explicitly');
  }
  const snapshot = snapshotFromStore(currentSnapshot, store);
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  return {
    snapshot,
    serialized,
    wire,
    source,
    stats: {
      sourceMembers: source.members.length,
      acceptedMembers: source.counts.accepted,
      removedMembers: source.counts.removed,
      unresolvedAccountMembers: source.unresolvedAccountMembers,
      sourceAccounts: source.profiles.size,
      accountCountBefore: (currentSnapshot.accounts || []).length,
      accountCountAfter: snapshot.accounts.length,
      loopCountBefore: (currentSnapshot.loops || []).length,
      loopCountAfter: snapshot.loops.length,
      oldRobotRemoved: source.robotId !== oldRobot._id,
      robotCredentialsTransferred: true,
    },
  };
}

function readJsonFile(file, label) {
  const bytes = readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('INVALID_INPUT_JSON', `${label} is not valid JSON`);
  }
  return { value, bytes };
}

function removeOwnedFile(file, identity) {
  if (!identity) return;
  try {
    const current = lstatSync(file);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(file);
  } catch { /* Preserve the original error or a competing writer's replacement. */ }
}

function writePrivateFile(file, bytes) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  let identity;
  try {
    fd = openSync(file, 'wx', 0o600);
    identity = fstatSync(fd);
    fchmodSync(fd, 0o600);
    identity = fstatSync(fd);
    // writeFileSync handles short writes; one writeSync call need not write
    // the complete snapshot even when it returns without an error.
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return identity;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve original error */ }
    }
    removeOwnedFile(file, identity);
    throw error;
  }
}

function pathIsSame(left, right) {
  return resolve(left) === resolve(right);
}

/**
 * Read the private inputs, validate and stage a new account snapshot and an
 * exact byte-for-byte backup of the current store.  Existing output paths are
 * never overwritten.  Set dryRun to avoid all writes.
 */
export function stageHouseholdImport({
  currentPath,
  rootPath,
  usersPath,
  outputPath,
  backupPath = `${outputPath}.backup`,
  dryRun = false,
  expectedStatusCounts,
} = {}) {
  if (!currentPath || !rootPath || !usersPath) fail('INVALID_ARGUMENTS', 'currentPath, rootPath and usersPath are required');
  if (!outputPath && !dryRun) fail('INVALID_ARGUMENTS', 'outputPath is required unless dryRun is true');
  const current = readJsonFile(currentPath, 'current store');
  const root = readJsonFile(rootPath, 'root snapshot');
  const users = readJsonFile(usersPath, 'users snapshot');
  const result = buildHouseholdImport({
    currentSnapshot: current.value,
    rootSnapshot: root.value,
    usersSnapshot: users.value,
    expectedStatusCounts,
  });
  const outputBytes = Buffer.from(result.serialized, 'utf8');
  const summary = {
    ...result.stats,
    dryRun,
    inputSha256: {
      current: sha256(current.bytes),
      root: sha256(root.bytes),
      users: sha256(users.bytes),
    },
    stagedSha256: sha256(outputBytes),
    stagedBytes: outputBytes.length,
    loopId: idLabel(result.source.loopId),
    ownerId: idLabel(result.source.ownerId),
    robotId: idLabel(result.source.robotId),
  };
  if (dryRun) return { ...result, summary };
  if (!backupPath || pathIsSame(outputPath, currentPath) || pathIsSame(backupPath, currentPath)
    || pathIsSame(outputPath, backupPath)) {
    fail('INVALID_ARGUMENTS', 'output and backup paths must be distinct from the current store');
  }
  if (existsSync(outputPath) || existsSync(backupPath)) {
    fail('OUTPUT_EXISTS', 'refusing to overwrite an existing staged store or backup');
  }
  // Do not stage a snapshot whose source changed while validation was running.
  // The live store is owned by the caller; a second process must retry from a
  // fresh read rather than receive a backup of a different generation.
  const currentAgain = readFileSync(currentPath);
  if (!currentAgain.equals(current.bytes)) {
    fail('CURRENT_CHANGED', 'current store changed during import; no staged files were written');
  }
  let outputIdentity;
  try {
    const outputStat = writePrivateFile(outputPath, outputBytes);
    outputIdentity = outputStat;
    const backupStat = writePrivateFile(backupPath, current.bytes);
    summary.outputPath = resolve(outputPath);
    summary.backupPath = resolve(backupPath);
    summary.outputMode = outputStat.mode & 0o777;
    summary.backupMode = backupStat.mode & 0o777;
    return { ...result, summary };
  } catch (error) {
    removeOwnedFile(outputPath, outputIdentity);
    throw error;
  }
}
