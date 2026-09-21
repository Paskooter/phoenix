// One-time bridge between a signed-in Phoenix account and an already-paired
// robot.  The robot's existing AWS key pair proves possession at redemption;
// the short-lived code proves which newly-created Phoenix account should own
// the resulting household.  We store only a hash of the code in the account
// snapshot, never the redeemable value itself.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from './model.js';

export const ROBOT_CLAIM_LIFETIME_MS = 15 * 60 * 1000;
const ROBOT_CLAIM_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_KIND = 'robot-claim-v1';

function codeHash(code) {
  return createHash('sha256').update(code).digest();
}

function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function removeExpiredClaims(store, now) {
  let changed = false;
  for (const [id, token] of store.tokens) {
    if (token?.kind === CLAIM_KIND && (!Number.isSafeInteger(token.expires) || token.expires <= now)) {
      store.tokens.delete(id);
      changed = true;
    }
  }
  return changed;
}

/** Issue a high-entropy, one-time robot-ownership claim for a signed-in user. */
export function issueRobotClaim(store, account, { now = Date.now() } = {}) {
  // A new code supersedes outstanding codes for this account.  This keeps a
  // lost terminal scrollback from remaining a valid household-claim ability.
  removeExpiredClaims(store, now);
  for (const [id, token] of store.tokens) {
    if (token?.kind === CLAIM_KIND && String(token.accountId) === String(account._id)) store.tokens.delete(id);
  }
  const code = randomBytes(32).toString('base64url');
  const token = {
    _id: newId(),
    kind: CLAIM_KIND,
    accountId: account._id,
    codeHash: codeHash(code).toString('hex'),
    created: now,
    expires: now + ROBOT_CLAIM_LIFETIME_MS,
  };
  store.tokens.set(token._id, token);
  store.flush();
  return { code, expires: token.expires };
}

/** Resolve, but do not consume, a claim code.  Call consumeRobotClaim only after adoption succeeds. */
export function resolveRobotClaim(store, code, { now = Date.now() } = {}) {
  const validShape = typeof code === 'string' && ROBOT_CLAIM_CODE_RE.test(code);
  const digest = validShape ? codeHash(code).toString('hex') : null;
  const expiredChanged = removeExpiredClaims(store, now);
  let token = null;
  if (digest) {
    for (const candidate of store.tokens.values()) {
      if (candidate?.kind === CLAIM_KIND && candidate.expires > now && hashesEqual(candidate.codeHash, digest)) {
        token = candidate;
        break;
      }
    }
  }
  if (expiredChanged) store.flush();
  const account = token ? store.accounts.get(token.accountId) : null;
  if (!account || account.isDeleted === true || account.isActive === false) return null;
  return { token, account };
}

export function consumeRobotClaim(store, token) {
  if (!token || token.kind !== CLAIM_KIND) return false;
  const removed = store.tokens.delete(token._id);
  if (removed) store.flush();
  return removed;
}
