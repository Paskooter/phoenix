// Domain logic — mirrors srv-account-ws semantics the handoff specifies:
// fillAccessKeys (20/40 alnum), Account/Loop/Token creation, find-or-create robot account,
// loop-name dedupe, 15-minute one-time tokens, scrypt password hashing (node:crypto, zero-dep).

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000; // token.ctrl.ts 15-min TTL

function randAlnum(n) {
  let s = '';
  for (let i = 0; i < n; i += 1) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

export const newId = () => randomBytes(12).toString('hex');

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
  if (existing) return existing;
  const robot = {
    _id: newId(),
    email: null,
    password: null,
    friendlyId,
    firstName: '', lastName: '',
    ...fillAccessKeys(),
    isActive: true,
    created: Date.now(),
  };
  store.accounts.set(robot._id, robot);
  store.flush();
  return robot;
}

// -- loops ----------------------------------------------------------------------

/** loop.ctrl.ts getLoopName dedupe: "<Owner>'s Jibo", then "<Owner>'s 2 Jibo", ... */
function loopName(store, owner) {
  const base = `${owner.firstName || owner.email || 'My'}'s`;
  const names = new Set([...store.loops.values()].map((l) => l.name));
  if (!names.has(`${base} Jibo`)) return `${base} Jibo`;
  for (let i = 2; ; i += 1) if (!names.has(`${base} ${i} Jibo`)) return `${base} ${i} Jibo`;
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
      { accountId: owner._id, status: 'ACCEPTED' },
      { accountId: robot._id, status: 'ACCEPTED' },
    ],
    isSuspended: false,
    created: Date.now(),
  };
  store.loops.set(loop._id, loop);
  store.flush();
  return { loop, robot };
}

// -- setup tokens -----------------------------------------------------------------

/** prepareRobot: mint a one-time 15-min token bound to the minting owner (loopId null = new robot). */
export function mintSetupToken(store, accountId, loopId = null, extra = {}) {
  const token = { _id: newTokenId(), accountId, loopId, created: Date.now(), ...extra };
  store.tokens.set(token._id, token);
  store.flush();
  return token;
}

export function takeValidToken(store, tokenId) {
  const token = store.tokens.get(tokenId);
  if (!token) return null;
  if (Date.now() - token.created > ACCESS_TOKEN_LIFETIME_MS) {
    store.tokens.delete(tokenId);
    store.flush();
    return null;
  }
  return token;
}

/** Purge expired tokens (housekeeping; called opportunistically). */
export function sweepTokens(store) {
  let dirty = false;
  for (const [id, t] of store.tokens) {
    if (Date.now() - t.created > ACCESS_TOKEN_LIFETIME_MS) { store.tokens.delete(id); dirty = true; }
  }
  if (dirty) store.flush();
}
