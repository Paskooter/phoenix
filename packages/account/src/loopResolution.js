// Trusted Account -> GQA loop resolution seam.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2,
// src/routes/loop.route.ts and src/controllers/loop.ctrl.ts.
// The source endpoint is an internal POST /listAssociatedLoops call. It
// excludes deleted/suspended loops, then includes only accepted memberships.

import { MEMBER_STATUS, isAcceptedStatus } from './model.js';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function identityKey(value) {
  // Object keys in the original response are produced by JavaScript's object
  // coercion. Account IDs are strings in production, but retaining this small
  // coercion keeps the internal seam deterministic for fixture values too.
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

function sameIdentity(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

/**
 * Source-shaped LoopController.listAssociatedLoops over Phoenix's durable
 * store. The database query first removes deleted and suspended loops; the
 * per-account pass then checks for an accepted member and returns loop IDs in
 * store/query order.
 */
export function listAssociatedLoops(store, accountIds) {
  if (!store || !store.loops || typeof store.loops.values !== 'function') {
    throw new TypeError('Account loop store is required');
  }
  if (!Array.isArray(accountIds)) throw new TypeError('accountsIds must be an array');

  const matchedLoops = [...store.loops.values()].filter((loop) => loop
    && loop.isDeleted !== true
    && loop.isSuspended !== true
    && Array.isArray(loop.members)
    && loop.members.some((member) => accountIds.some((accountId) => sameIdentity(member?.accountId, accountId))));

  const results = {};
  for (const accountId of accountIds) {
    const key = identityKey(accountId);
    const loopIds = matchedLoops.reduce((ids, loop) => {
      // Source values are lower-case through Mongoose's enum/default path.
      // Phoenix also has historical snapshots written by the OOBE model with
      // upper-case ACCEPTED; isAcceptedStatus preserves the same semantic
      // membership while allowing those already-created rows to resolve.
      if ((loop.members || []).some((member) => sameIdentity(member?.accountId, accountId)
        && isAcceptedStatus(member?.status))) {
        ids.push(String(loop._id));
      }
      return ids;
    }, []);
    results[key] = loopIds;
  }
  return results;
}

function invalidPayload(body) {
  return !body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.accountsIds);
}

/**
 * Add the original trusted internal route to an Account service route map.
 * Authentication is intentionally owned by the private Account peer network,
 * matching srv-account-ws's route (which has no parseCredentials decorator).
 */
export function listAssociatedLoopsRoute(store) {
  return {
    'POST /listAssociatedLoops': ({ body, res }) => {
      if (invalidPayload(body)) {
        const payload = {
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'child "accountsIds" fails because ["accountsIds" is required]',
        };
        const serialized = JSON.stringify(payload);
        res.writeHead(422, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(serialized),
        });
        res.end(serialized);
        return undefined;
      }
      return listAssociatedLoops(store, body.accountsIds);
    },
  };
}

/** True when a response has the exact mapping key the source caller indexes. */
export function hasAssociatedLoopKey(value, accountId) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && hasOwn(value, identityKey(accountId));
}

export { identityKey as accountIdentityKey };

// Keep the source constant visible to callers that record provenance.
export { MEMBER_STATUS };
