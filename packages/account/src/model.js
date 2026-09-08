// Domain logic — mirrors srv-account-ws semantics the handoff specifies:
// fillAccessKeys (20/40 alnum), Account/Loop/Token creation, find-or-create robot account,
// loop-name dedupe, 15-minute one-time tokens, scrypt password hashing (node:crypto, zero-dep).

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { jwt } from '@phoenix/common';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000; // token.ctrl.ts 15-min TTL
export const HUB_TOKEN_LIFETIME_S = 3 * 60 * 60;        // token.ctrl.ts WEB_TOKEN_LIFETIME (3h)

function randAlnum(n) {
  let s = '';
  for (let i = 0; i < n; i += 1) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

export const newId = () => randomBytes(12).toString('hex');

/** schemes/member.status.ts — stored and wire values are lowercase. */
export const MEMBER_STATUS = Object.freeze({
  INVITED: 'invited',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  REMOVED: 'removed',
});

/** schemes/member.type.ts */
export const MEMBER_TYPE = Object.freeze({
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
});

export function isMemberStatus(value, expected) {
  const actual = String(value || '').toLowerCase();
  if (expected === undefined) {
    return Object.values(MEMBER_STATUS).includes(actual);
  }
  return actual === String(expected).toLowerCase();
}

export function isAcceptedStatus(status) {
  return isMemberStatus(status, MEMBER_STATUS.ACCEPTED);
}

/** account.ts fillAccessKeys: accessKeyId 20 alnum, secretAccessKey 40 alnum. */
export function fillAccessKeys() {
  return { accessKeyId: randAlnum(20), secretAccessKey: randAlnum(40) };
}

/** Setup-token id — original: bs58(crypto.randomBytes(5)), ~7 chars. Base58 alphabet, no deps. */
export function newTokenId() {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + randomBytes(5).toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s || '1';
}

// -- passwords (scrypt) -------------------------------------------------------

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Constant-time compare of a presented secret access key against the stored one. */
export function secretMatches(presented, stored) {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(String(stored || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Portal `/api/token` helper. Keep its original two-argument contract: the
 * portal token carries only the gateway identity and its public expiry is
 * aligned to the second containing the JWT `exp` claim.
 */
export function createHubToken(account, secret) {
  const nowS = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    id: account._id,
    accessKeyId: account.accessKeyId,
    friendlyId: account.friendlyId || undefined,
    iat: nowS,
    exp: nowS + HUB_TOKEN_LIFETIME_S,
  };
  return { token: jwt.sign(tokenPayload, secret), expires: (nowS + HUB_TOKEN_LIFETIME_S) * 1000 };
}

/**
 * Account_20151111.CreateHubToken / account.ctrl.ts createHubToken. The
 * controller first loads the authenticated account by credentials.id and
 * signs this object in this exact source order. Its Mongoose document exposes
 * secretAccessKey here; the gateway's later credential-envelope redaction does
 * not alter the already-issued JWT claim.
 */
export function createAuthenticatedHubToken(account, secret, payload = null) {
  const issuedMS = Date.now();
  const nowS = Math.floor(issuedMS / 1000);
  const tokenPayload = {
    accessKeyId: account.accessKeyId,
    email: account.email,
    friendlyId: account.friendlyId,
    id: String(account._id),
    payload,
    secretAccessKey: account.secretAccessKey,
    iat: nowS,
    exp: nowS + HUB_TOKEN_LIFETIME_S,
  };
  return { token: jwt.sign(tokenPayload, secret), expires: issuedMS + HUB_TOKEN_LIFETIME_S * 1000 };
}

// -- accounts -----------------------------------------------------------------

/** A human owner account. */
export function createOwnerAccount(store, { email, password, firstName = '', lastName = '' }) {
  if (store.accountByEmail(email)) throw Object.assign(new Error('An account with that email already exists'), { code: 'ACCOUNT_EXISTS' });
  const account = {
    _id: newId(),
    email: String(email).toLowerCase(),
    password: hashPassword(password),
    friendlyId: null,
    firstName, lastName,
    ...fillAccessKeys(),
    isActive: true,
    created: Date.now(),
  };
  store.accounts.set(account._id, account);
  store.flush();
  return account;
}

/** loop.ctrl.ts findOrCreateRobotAccount: a robot is an Account with a friendlyId + its own keys. */
export function findOrCreateRobotAccount(store, friendlyId) {
  const existing = store.accountByFriendlyId(friendlyId);
  const robot = existing ? { ...existing } : {
    _id: newId(),
    email: null,
    password: null,
    friendlyId,
    firstName: '', lastName: '',
    ...fillAccessKeys(),
    isActive: true,
    created: Date.now(),
  };
  // The source saves even an existing robot account, reactivating it while
  // retaining its identity and keys. Keep the draft detached until persistence
  // succeeds so a rejected save cannot activate an account only in memory.
  robot.isActive = true;
  robot.updated = Date.now();
  store.accounts.set(robot._id, robot);
  try {
    store.flush();
  } catch (error) {
    if (existing) store.accounts.set(existing._id, existing);
    else store.accounts.delete(robot._id);
    throw error;
  }
  return robot;
}

// -- loops ----------------------------------------------------------------------

/** oobe.ctrl.ts getLoopName: "<Owner>'s Jibo" ("<Owner>' Jibo" when the name ends in s), deduped. */
function loopName(store, owner) {
  const name = owner.firstName || owner.email || 'My';
  const base = name.endsWith('s') ? `${name}'` : `${name}'s`;
  const names = new Set([...store.loops.values()].map((l) => l.name));
  if (!names.has(`${base} Jibo`)) return `${base} Jibo`;
  for (let i = 2; ; i += 1) if (!names.has(`${base} ${i} Jibo`)) return `${base} ${i} Jibo`;
}

function defaultEnrollment() {
  return { face: false, voice: false };
}

function newLoopMember(accountId, status = 'ACCEPTED') {
  return {
    _id: newId(),
    accountId,
    status,
    enrolled: defaultEnrollment(),
    created: Date.now(),
  };
}

export function isAcceptedMemberStatus(status) {
  return String(status || '').toLowerCase() === 'accepted';
}

/** Assign stable member subdocument ids, matching mongoose memberSchema._id. */
export function ensureLoopMemberIds(loop) {
  if (!loop || !Array.isArray(loop.members)) return false;
  let changed = false;
  for (const member of loop.members) {
    if (!member._id && !member.id) {
      member._id = newId();
      changed = true;
    }
    if (!member.enrolled || typeof member.enrolled !== 'object') {
      member.enrolled = defaultEnrollment();
      changed = true;
    }
  }
  return changed;
}

function copyAcceptedAccount(account, { includeFacebookToken = false } = {}) {
  if (!account) return undefined;
  const copy = {};
  if (account.birthday != null) copy.birthday = Number(account.birthday);
  if (account.email != null) copy.email = account.email;
  if (includeFacebookToken) copy.facebookAccessToken = account.facebookAccessToken;
  if (account.firstName != null) copy.firstName = account.firstName;
  if (account.gender != null) copy.gender = account.gender;
  if (account.lastName != null) copy.lastName = account.lastName;
  if (account.phoneNumber != null) copy.phoneNumber = account.phoneNumber;
  if (account.photoUrl != null) copy.photoUrl = account.photoUrl;
  return copy;
}

/**
 * LoopController.populateLoop for ListLoops. Does not invent household people;
 * it only projects stored owner/robot/member accounts already on the loop.
 */
export function populateLoop(store, loop, { isRobotRequesting = false } = {}) {
  ensureLoopMemberIds(loop);
  const members = (loop.members || []).map((member) => {
    const accountId = member.accountId;
    const status = String(member.status || '').toLowerCase();
    const accepted = status === 'accepted';
    const accountRecord = accountId ? store.accounts.get(accountId) : null;
    let account;
    if (accepted && accountRecord) {
      account = copyAcceptedAccount(accountRecord, { includeFacebookToken: isRobotRequesting });
    } else if (member.memberProperties) {
      account = { ...member.memberProperties };
      if (account.birthday) account.birthday = Number(account.birthday);
    } else {
      // LoopManager._filterOutInvitedChildren reads member.account.isChild.
      // Source always assigns account (accepted account or memberProperties).
      account = {};
    }
    const wire = {
      id: member._id || member.id,
      memberId: accountId,
      accountId,
      loopId: loop._id,
      type: accountId && accountId === loop.owner ? 'incoming' : 'outgoing',
      status,
      enrolled: member.enrolled || defaultEnrollment(),
      account,
    };
    if (member.nickname !== undefined) wire.nickname = member.nickname;
    if (member.phoneticName !== undefined) wire.phoneticName = member.phoneticName;
    if (member.legalGuardianId !== undefined) wire.legalGuardianId = member.legalGuardianId;
    if (member.agreementId !== undefined) wire.agreementId = member.agreementId;
    if (member.created !== undefined) wire.created = member.created;
    return wire;
  });
  const robot = loop.robot ? store.accounts.get(loop.robot) : null;
  return {
    id: loop._id,
    name: loop.name,
    owner: loop.owner,
    robot: loop.robot,
    robotFriendlyId: (robot && robot.friendlyId) || undefined,
    members,
    isSuspended: loop.isSuspended,
    created: loop.created,
    updated: loop.updated,
  };
}

/** Account schema toJSON (safe): id from _id, no secrets, no created. */
export function accountToPublicWire(account) {
  if (!account) return null;
  const wire = {
    id: String(account._id),
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    friendlyId: account.friendlyId,
    gender: account.gender,
    isActive: !!account.isActive,
    isAdmin: !!account.isAdmin,
    messagingAllowed: account.messagingAllowed === undefined ? true : !!account.messagingAllowed,
    phoneNumber: account.phoneNumber,
    photoUrl: account.photoUrl,
    roles: account.roles || ['user'],
    facebookConnected: !!account.facebookAccessToken,
  };
  if (account.birthday != null) wire.birthday = Number(account.birthday);
  if (account.termsAccepted != null) wire.termsAccepted = Number(account.termsAccepted);
  return wire;
}

/** loops.create({owner, robotId, name?}): find-or-create the robot account and attach it. */
export function createLoop(store, { owner, robotId }) {
  const robot = findOrCreateRobotAccount(store, robotId);
  const existing = [...store.loops.values()].find((l) => l.robot === robot._id);
  if (existing) return { loop: existing, robot }; // one loop per robot (v1)
  const loop = {
    _id: newId(),
    name: loopName(store, owner),
    owner: owner._id,
    robot: robot._id,
    members: [
      newLoopMember(owner._id, 'ACCEPTED'),
      newLoopMember(robot._id, 'ACCEPTED'),
    ],
    isSuspended: false,
    created: Date.now(),
  };
  store.loops.set(loop._id, loop);
  store.flush();
  return { loop, robot };
}

// -- setup tokens -----------------------------------------------------------------

/**
 * prepareRobot / token.ctrl.ts create: REUSE a still-live token for the same accountId+loopId
 * (refreshing its created timestamp); otherwise mint a fresh one. One-time, 15-min TTL.
 */
export function mintSetupToken(store, accountId, loopId = null, extra = {}) {
  const live = [...store.tokens.values()].find((t) =>
    t.accountId === accountId && (t.loopId || null) === (loopId || null)
    && Date.now() - t.created <= ACCESS_TOKEN_LIFETIME_MS);
  if (live) {
    live.created = Date.now();
    Object.assign(live, extra);
    store.flush();
    return live;
  }
  const token = { _id: newTokenId(), accountId, loopId, created: Date.now(), ...extra };
  store.tokens.set(token._id, token);
  store.flush();
  return token;
}

/**
 * token.ctrl.ts findById semantics: missing -> {error:'TOKEN_NOT_FOUND'}, expired ->
 * {error:'TOKEN_EXPIRED'} (the original throws but does NOT delete on expiry).
 */
export function findToken(store, tokenId) {
  const token = store.tokens.get(tokenId);
  if (!token) return { error: 'TOKEN_NOT_FOUND' };
  if (Date.now() - token.created > ACCESS_TOKEN_LIFETIME_MS) return { error: 'TOKEN_EXPIRED' };
  return { token };
}

export function takeValidToken(store, tokenId) {
  const { token } = findToken(store, tokenId);
  return token || null;
}

export function deleteToken(store, tokenId) {
  const token = store.tokens.get(tokenId);
  if (!store.tokens.delete(tokenId)) return;
  try {
    store.flush();
  } catch (error) {
    // Source TokenController awaits the persisted remove before succeeding.
    // A failed write must leave the committed token available for a retry.
    store.tokens.set(tokenId, token);
    throw error;
  }
}

/** Purge expired tokens (housekeeping; called opportunistically). */
export function sweepTokens(store) {
  let dirty = false;
  for (const [id, t] of store.tokens) {
    if (Date.now() - t.created > ACCESS_TOKEN_LIFETIME_MS) { store.tokens.delete(id); dirty = true; }
  }
  if (dirty) store.flush();
}
