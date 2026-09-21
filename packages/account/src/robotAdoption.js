// Self-service adoption for a robot that already has credentials.
//
//   POST /api/adopt-robot  { accessKeyId, secretAccessKey, friendlyId?, claimCode? }
//     -> 200 { adopted: true, robotId, loopId, friendlyId, created: {...} }
//
// WHY THIS EXISTS. A robot that paired with the original Jibo cloud years ago
// still holds a working `/var/jibo/credentials.json` — an accessKeyId and a
// secretAccessKey it signs every Classic request with. Those credentials are the
// robot's identity and cannot be reissued without a factory reset, which would
// lose the household. Repointing such a robot at a Phoenix server it has never
// met leaves it authenticating against a store that has never heard of it: every
// signed call resolves to no account, so the robot reaches the server and is
// still rejected.
//
// The repoint script calls this endpoint so the operator does not have to hand
// the server a store file out of band. The robot proves possession with its own
// credentials. When the signed-in portal also supplied a one-time claimCode,
// the endpoint binds the resulting loop to that *new* Phoenix account.
//
// WHAT THIS IS NOT. This is deliberately NOT a way to claim a robot you do not
// have. The caller must present the secretAccessKey, which only ever exists on
// the robot itself and in a store that already knows it. Possession of the secret
// IS the proof — the same proof the SigV4 signature on every other robot call
// relies on. There is no path here that mints a NEW secret, so an attacker who
// guesses a friendlyId learns nothing and gains nothing. A claim code cannot
// transfer a robot already owned by another real Phoenix account; that remains
// an explicit administrator operation.
//
// IDEMPOTENCE MATTERS. A repoint script is re-run — after a failed OTA, after a
// reflash, by an operator who is not sure it worked the first time. Adopting a
// robot that is already adopted must be a successful no-op that reports what
// already exists, never a duplicate account or an error that makes a working
// setup look broken.

import { timingSafeEqual } from 'node:crypto';
import { newId } from './model.js';
import { consumeRobotClaim, resolveRobotClaim } from './robotClaim.js';

/** Mongo-style 24-hex id, matching the ids the original cloud issued. */
function badRequest(res, sendJson, message, details = {}) {
  return sendJson(res, 400, { error: message, ...details });
}

const ADOPTION_ACCESS_KEY_RE = /^[A-Za-z0-9]{20}$/;
const ADOPTION_SECRET_RE = /^[A-Za-z0-9]{40}$/;
const ADOPTION_FRIENDLY_ID_RE = /^[a-z0-9-]{3,80}$/i;

function secretsEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** Small bounded in-process limiter for the unauthenticated adoption proof. */
export function createAdoptionRateLimiter({ limit = 10, windowMs = 60 * 60 * 1000, maxKeys = 10000 } = {}) {
  const entries = new Map();
  return {
    allow(key = 'unknown') {
      const now = Date.now();
      const normalized = String(key || 'unknown').slice(0, 200);
      const current = entries.get(normalized);
      if (!current || now - current.started >= windowMs) {
        if (entries.size >= maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entries.set(normalized, { started: now, count: 1 });
        return { allowed: true, retryAfterMs: 0 };
      }
      current.count += 1;
      if (current.count > limit) {
        return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - current.started)) };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

/**
 * Adopt a robot into the store using credentials it already holds.
 *
 * @param store        the account Store
 * @param body         { accessKeyId, secretAccessKey, friendlyId? }
 * @param opts.loopName name for a loop created for a brand-new robot
 * @returns {{status:number, payload:object}}
 */
export function adoptRobot(store, body, { loopName = null } = {}) {
  const accessKeyId = typeof body?.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
  const secretAccessKey = typeof body?.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
  const friendlyId = typeof body?.friendlyId === 'string' && body.friendlyId.trim()
    ? body.friendlyId.trim()
    : null;

  if (!accessKeyId || !secretAccessKey) {
    return {
      status: 400,
      payload: { error: 'accessKeyId and secretAccessKey are required' },
    };
  }

  // Already known by key: the common case on a re-run. Report what exists rather
  // than creating a second account for the same robot.
  const existing = store.accountByAccessKeyId(accessKeyId);
  if (existing) {
    // The secret must match. A mismatch means this accessKeyId belongs to a
    // different robot (or the caller is guessing), and silently overwriting the
    // stored secret would lock the real robot out of its own account.
    if (!secretsEqual(existing.secretAccessKey, secretAccessKey)) {
      return {
        status: 403,
        payload: { error: 'accessKeyId is already registered to a different secret' },
      };
    }
    const loop = [...store.loops.values()].find((l) => l.robot === existing._id) || null;
    return {
      status: 200,
      payload: {
        adopted: true,
        alreadyAdopted: true,
        robotId: existing._id,
        friendlyId: existing.friendlyId || null,
        loopId: loop ? loop._id : null,
        created: { account: false, loop: false },
      },
    };
  }

  // A robot whose friendlyId is known but whose key is not: the store was built
  // from a backup that carried the robot record without its credentials. Bind the
  // presented credentials to that existing record instead of creating a duplicate,
  // so the household (loop, members, enrollments) is preserved.
  if (friendlyId) {
    const byFriendly = store.accountByFriendlyId(friendlyId);
    if (byFriendly) {
      const existingLoop = [...store.loops.values()].find((l) => idsEqual(l.robot, byFriendly._id)) || null;
      const existingOwner = existingLoop ? store.accounts.get(existingLoop.owner) || null : null;
      // A friendly ID is public/device-visible, not a credential.  Never let
      // it alone bind a new key pair onto a robot in somebody else's real
      // Phoenix household.  An operator can perform that exceptional recovery
      // through the explicit administrator transfer flow.
      if (existingLoop && !isBootstrapOwner(existingOwner, byFriendly)) {
        return {
          status: 409,
          payload: { error: 'friendlyId is already linked to a Phoenix household', robotId: byFriendly._id },
        };
      }
      if (byFriendly.accessKeyId && byFriendly.accessKeyId !== accessKeyId) {
        return {
          status: 409,
          payload: {
            error: 'friendlyId is already bound to different credentials',
            robotId: byFriendly._id,
          },
        };
      }
      byFriendly.accessKeyId = accessKeyId;
      byFriendly.secretAccessKey = secretAccessKey;
      byFriendly.updated = Date.now();
      store.accounts.set(byFriendly._id, byFriendly);
      store.flush();
      const loop = [...store.loops.values()].find((l) => l.robot === byFriendly._id) || null;
      return {
        status: 200,
        payload: {
          adopted: true,
          alreadyAdopted: false,
          robotId: byFriendly._id,
          friendlyId: byFriendly.friendlyId,
          loopId: loop ? loop._id : null,
          created: { account: false, loop: false, credentialsBound: true },
        },
      };
    }
  }

  // Genuinely new: create the robot account and a loop for it. The loop is what
  // the robot lists at startup (Loop_20160324.ListLoops); without one it
  // authenticates but has no household and no members.
  const now = Date.now();
  const robotId = newId();
  const robot = {
    _id: robotId,
    id: robotId,
    email: null,
    friendlyId: friendlyId || `robot-${robotId.slice(0, 8)}`,
    firstName: '',
    lastName: '',
    accessKeyId,
    secretAccessKey,
    isActive: true,
    created: now,
    updated: now,
  };
  store.accounts.set(robotId, robot);

  const loopId = newId();
  const loop = {
    _id: loopId,
    name: loopName || `${robot.friendlyId}'s Jibo`,
    owner: robotId,
    robot: robotId,
    members: [],
    isSuspended: false,
    created: now,
    updated: now,
  };
  store.loops.set(loopId, loop);
  store.flush();

  return {
    status: 200,
    payload: {
      adopted: true,
      alreadyAdopted: false,
      robotId,
      friendlyId: robot.friendlyId,
      loopId,
      created: { account: true, loop: true },
    },
  };
}

function idsEqual(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function isBootstrapOwner(owner, robot) {
  // These are the only ownership records that a possession-backed claim may
  // move automatically.  A robot that is already owned by another real
  // Phoenix account must be transferred by an administrator, rather than
  // turning disclosure of a long-lived robot key into account takeover.
  return !owner
    || idsEqual(owner._id, robot._id)
    || /^(?:owner|adopted)@phoenix\.local$/i.test(String(owner.email || ''));
}

function acceptedMember(accountId) {
  return {
    _id: newId(),
    accountId,
    status: 'accepted',
    enrolled: { face: false, voice: false },
    created: Date.now(),
  };
}

/**
 * Bind an adopted robot to a real Phoenix account.  This intentionally does
 * not import the original cloud's people/accounts: a claim replaces the
 * bootstrap placeholder membership with exactly the new Phoenix owner and
 * the robot.  The loop ID and robot credentials survive, so local robot state
 * and subsequent signed requests continue to resolve.
 */
export function linkAdoptedRobotToOwner(store, { robot, owner, allowExistingOwnerTransfer = false }) {
  let loop = [...store.loops.values()].find((entry) => idsEqual(entry.robot, robot._id)) || null;
  if (loop) {
    const currentOwner = store.accounts.get(loop.owner) || null;
    if (!idsEqual(loop.owner, owner._id) && !isBootstrapOwner(currentOwner, robot) && !allowExistingOwnerTransfer) {
      return {
        status: 409,
        payload: { error: 'robot is already linked to another Phoenix account; an administrator must transfer it' },
      };
    }
    const alreadyLinked = idsEqual(loop.owner, owner._id)
      && (loop.members || []).some((member) => idsEqual(member.accountId, owner._id));
    if (!alreadyLinked) {
      loop.owner = owner._id;
      loop.members = [acceptedMember(owner._id), acceptedMember(robot._id)];
      loop.updated = Date.now();
      store.loops.set(loop._id, loop);
      store.flush();
    }
    return {
      status: 200,
      payload: { loop, linked: !alreadyLinked, alreadyLinked },
    };
  }

  loop = {
    _id: newId(),
    name: `${owner.firstName || owner.email || 'My'}'s Jibo`,
    owner: owner._id,
    robot: robot._id,
    members: [acceptedMember(owner._id), acceptedMember(robot._id)],
    isSuspended: false,
    created: Date.now(),
  };
  store.loops.set(loop._id, loop);
  store.flush();
  return { status: 200, payload: { loop, linked: true, alreadyLinked: false } };
}

/**
 * Route table. Unauthenticated BY DESIGN: the caller's proof is the robot secret
 * in the body, which is the same secret every signed robot request already
 * relies on. Requiring a portal session here would defeat the purpose — the
 * repoint script runs on a laptop next to the robot, not in a logged-in browser.
 */
export function robotAdoptionRoutes(store, {
  sendJson,
  loopName = null,
  rateLimiter = createAdoptionRateLimiter(),
} = {}) {
  return {
    'POST /api/adopt-robot': async ({ req, res, body }) => {
      // The production nginx edge overwrites X-Real-IP after applying its
      // trusted-proxy real-IP policy.  Prefer that value so a loopback-bound
      // Account service does not collapse every public client into one rate
      // bucket; never trust a client-provided X-Forwarded-For chain here.
      const realIp = req?.headers?.['x-real-ip'];
      const key = (typeof realIp === 'string' && realIp.trim())
        || req?.socket?.remoteAddress
        || 'unknown';
      const limited = rateLimiter?.allow?.(key);
      if (limited && !limited.allowed) {
        const seconds = Math.ceil(limited.retryAfterMs / 1000);
        res.setHeader('retry-after', String(seconds));
        return sendJson(res, 429, { error: 'too many adoption attempts; try again later' });
      }
      if (!body || typeof body !== 'object') {
        return badRequest(res, sendJson, 'a JSON body is required');
      }
      // Native robot credentials are fixed-format random values.  Requiring
      // those formats on the public bootstrap route makes low-entropy guesses
      // and storage-filling attempts materially harder while leaving the pure
      // adoptRobot() migration helper backwards-compatible for old snapshots.
      if (typeof body.accessKeyId !== 'string' || !ADOPTION_ACCESS_KEY_RE.test(body.accessKeyId.trim())
        || typeof body.secretAccessKey !== 'string' || !ADOPTION_SECRET_RE.test(body.secretAccessKey.trim())) {
        return badRequest(res, sendJson, 'accessKeyId must be 20 alphanumeric characters and secretAccessKey must be 40 alphanumeric characters');
      }
      if (body.friendlyId !== undefined && body.friendlyId !== null
        && (!ADOPTION_FRIENDLY_ID_RE.test(String(body.friendlyId).trim()))) {
        return badRequest(res, sendJson, 'friendlyId must contain only letters, numbers, and hyphens (3-80 characters)');
      }
      const hasClaimCode = body.claimCode !== undefined && body.claimCode !== null && body.claimCode !== '';
      // Validate the code before mutating the store.  In particular, an
      // attacker cannot turn a mistyped/expired claim into an unowned robot
      // record merely by presenting a credential pair of their own choosing.
      const claim = hasClaimCode ? resolveRobotClaim(store, String(body.claimCode)) : null;
      if (hasClaimCode && !claim) return sendJson(res, 403, { error: 'claim code is invalid or expired' });
      const { status, payload } = adoptRobot(store, body, { loopName });
      if (status !== 200) return sendJson(res, status, payload);

      // A regular adoption only establishes the robot identity and its
      // bootstrap loop.  A claim code, issued only to a signed-in Phoenix
      // account, adds the missing human ownership link.  Resolve the claim
      // after verifying the robot secret and consume it only after the link
      // has committed, so a transient failure is safely retryable.
      if (!claim) {
        return sendJson(res, status, payload);
      }
      const robot = store.accounts.get(payload.robotId);
      if (!robot) return sendJson(res, 500, { error: 'adoption did not persist the robot identity' });
      const linked = linkAdoptedRobotToOwner(store, { robot, owner: claim.account });
      if (linked.status !== 200) return sendJson(res, linked.status, linked.payload);
      consumeRobotClaim(store, claim.token);
      return sendJson(res, 200, {
        ...payload,
        loopId: linked.payload.loop._id,
        ownerEmail: claim.account.email,
        linked: linked.payload.linked,
        alreadyLinked: linked.payload.alreadyLinked,
      });
    },
  };
}
