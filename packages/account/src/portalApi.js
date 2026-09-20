// Portal + admin REST face (we design this; session-cookie auth). Routes are exact-match
// (createService), so parameters travel as query strings or JSON bodies.
//
//   POST /api/signup {email,password,firstName?}   -> {account}              + session cookie
//   POST /api/login  {email,password}              -> {account}              + session cookie
//   POST /api/logout                               -> {}                     (clears cookie)
//   GET  /api/me                                   -> {account} | 401
//   GET  /api/robots                               -> [{friendlyId,loopName,loopId,created,lastSeen}]
//   GET  /api/robots/detail …                      -> robot record + Robot_20160225 read
//   POST /api/robots/setup …                       -> QR pairing payload (MUST be preserved)
//   POST /api/robots/claim-code                    -> one-time existing-robot ownership code
//   GET  /api/robots/setup/status?token=           -> pairing completion poll
//   GET  /api/loop  / PUT /api/loop …              -> loops + members (see portal/loops.js)
//   PUT /api/me  POST /api/me/password …           -> profile (see portal/profile.js)
//   GET/PUT /api/settings                          -> report-skill settings (settingsFace.js)
//   GET /api/media · /api/people · /api/jot · /api/push · /api/notifications · /api/update/status
//   GET /api/oauthclients · GET /api/ifttt         -> classic-fronted surfaces (portal/*)
//   POST /api/token                                -> per-robot hub token (gateway/skills contract)
//   GET  /api/verify                               -> gateway robot-authorisation (contract frozen)
//   POST /api/admin/login   (REMOVED — the admin face is per-account now)
//   GET  /api/admin/me   GET /api/admin/robots   POST /api/admin/adopt
//
// Twenty /api mounts live in src/portal/* — this file keeps the original routes and composes the
// rest. The admin face is gated by the signed-in account's `isAdmin` flag, not a shared
// ADMIN_PASSWORD: grant it with scripts/portal-grant-admin.mjs. A signed-out caller gets 401 and a
// signed-in non-admin gets 403, so the console can tell them apart.
//
// TWO CONTRACTS ARE FROZEN AND MUST NOT CHANGE: GET /api/verify (the gateway calls it to
// authorise every robot connection and the skills GQA attribution store calls it too) and
// POST /api/token (the original two-argument {accessKeyId, secretAccessKey} portal token).

import { sendJson } from '@phoenix/common';
import { randomBytes } from 'node:crypto';
import { createOwnerAccount, createLoop, mintSetupToken, findToken, ACCESS_TOKEN_LIFETIME_MS, secretMatches, createHubToken } from './model.js';
// Password comparison MUST be compareAccountPassword, not model.js's scrypt-only
// verifyPassword. A household restored from the original cloud stores
// `sha512$512$10000$<salt>$<hash>` (the source utils/password.ts pbkdf2 encoding);
// verifyPassword returns false for anything that is not `scrypt:`, so the real
// account -- the one the owner signs into on the phone -- could never log in here.
import { compareAccountPassword } from './accountIdentity.js';
import { createSession, destroySession, getSession, sessionCookie, clearCookie } from './sessions.js';
import { buildQrCodes } from './qrPayload.js';
import { userFromSession as sessionUser, portalAccount } from './portal/session.js';
import { classicBaseUrl } from './portal/classicClient.js';
import { portalLoopRoutes } from './portal/loops.js';
import { portalProfileRoutes } from './portal/profile.js';
import { portalRobotRoutes } from './portal/robots.js';
import { portalMediaRoutes } from './portal/media.js';
import { portalPeopleRoutes } from './portal/people.js';
import { portalMessagingRoutes } from './portal/messaging.js';
import { portalSystemRoutes } from './portal/system.js';
import { adminConfigRoutes } from './admin/configRoutes.js';
import { adminOpsRoutes } from './admin/adminRoutes.js';
import { adminLogRoutes } from './admin/logRoutes.js';
import { linkAdoptedRobotToOwner, robotAdoptionRoutes } from './robotAdoption.js';
import { issueRobotClaim } from './robotClaim.js';

// The region written into an adopted robot's credentials.json. A robot's native
// client builds its service hostnames from this value — `<region>.jibo.com` for
// REST and `<region>-socket.jibo.com` for the notification socket — and verifies
// each against the serving certificate. Keep this default in step with the
// scripts that point robots at Phoenix.
export const DEFAULT_ACCOUNT_REGION = 'api';

/**
 * The region for an adopted robot. An explicit ETCO_account_region (env or .env)
 * always wins; otherwise the region the certificate is built for by default.
 * @param {Record<string, string | undefined>} [env]
 */
export function accountRegion(env = process.env) {
  return env.ETCO_account_region || DEFAULT_ACCOUNT_REGION;
}

const robotView = ({ robot, loop, owner }) => ({
  friendlyId: robot.friendlyId,
  accessKeyId: robot.accessKeyId,
  loopId: loop ? loop._id : null,
  loopName: loop ? loop.name : null,
  ownerEmail: owner ? owner.email : null,
  created: robot.created,
  lastSeen: robot.lastSeen || null,
});

function withCookie(res, cookie, status, body) {
  res.setHeader('Set-Cookie', cookie);
  sendJson(res, status, body);
}

const portalAuthAttempts = new Map();
const PORTAL_AUTH_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_AUTH_LIMIT = 10;

function portalAuthKey(req, email) {
  const address = req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
  return `${address}:${String(email || '').trim().toLowerCase().slice(0, 320)}`;
}

function checkPortalAuthRate(req, email) {
  const key = portalAuthKey(req, email);
  const now = Date.now();
  if (portalAuthAttempts.size > 10000) {
    for (const [candidate, row] of portalAuthAttempts) {
      if (now - row.started >= PORTAL_AUTH_WINDOW_MS) portalAuthAttempts.delete(candidate);
      if (portalAuthAttempts.size <= 10000) break;
    }
  }
  const row = portalAuthAttempts.get(key);
  if (!row || now - row.started >= PORTAL_AUTH_WINDOW_MS) {
    portalAuthAttempts.set(key, { started: now, count: 1 });
    return { allowed: true, key };
  }
  row.count += 1;
  return {
    allowed: row.count <= PORTAL_AUTH_LIMIT,
    key,
    retryAfterMs: Math.max(1, PORTAL_AUTH_WINDOW_MS - (now - row.started)),
  };
}

function clearPortalAuthRate(key) {
  portalAuthAttempts.delete(key);
}

function tooManyPortalAuth(res, result) {
  if (result.allowed) return false;
  res.setHeader('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
  sendJson(res, 429, { error: 'too many login attempts; try again later' });
  return true;
}

export function userFromSession(store, req) {
  return sessionUser(store, req);
}

/**
 * Administrator access is a property of the signed-in account, not a shared
 * password. An account with `isAdmin` set is an administrator; anyone else is
 * not, and a signed-out visitor is nobody.
 *
 * This replaced a single shared ADMIN_PASSWORD because that gave every operator
 * the same credential, left no per-person audit trail, and could not be revoked
 * for one person without changing it for all of them.
 */
export function isAdmin(store, req) {
  const account = sessionUser(store, req);
  return !!(account && account.isAdmin);
}

/**
 * Answer 401/403 and return false unless the caller is an administrator.
 * Distinguishing the two matters: the console renders "sign in" for 401 and
 * "this account is not an administrator" for 403, so a signed-in non-admin is
 * never told to sign in again.
 */
function requireAdmin(store, req, res) {
  const account = sessionUser(store, req);
  if (!account) {
    sendJson(res, 401, { error: 'sign in to use the admin surface' });
    return false;
  }
  if (!account.isAdmin) {
    sendJson(res, 403, { error: 'this account is not an administrator' });
    return false;
  }
  return true;
}

/** @param {import('./store.js').Store} store @returns route map fragment for createService */
export function portalRoutes(store, options = {}) {
  const portal = {
    loopUpdatedOutbox: options.loopUpdatedOutbox,
    invitationProviders: options.invitationProviders,
    classicBase: options.classicBase || classicBaseUrl(),
    classicCall: options.classicCall,
  };
  const repointHost = String(options.repointHost || process.env.ETCO_account_repointHost || '').trim();
  return {
    'POST /api/signup': ({ req, res, body }) => {
      const { email, password, firstName = '' } = body || {};
      const rate = checkPortalAuthRate(req, email);
      if (tooManyPortalAuth(res, rate)) return;
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || email.length > 320 || typeof password !== 'string' || password.length < 8
        || password.length > 1024 || typeof firstName !== 'string' || firstName.length > 200) {
        return sendJson(res, 400, { error: 'a valid email and a password of 8-1024 characters are required' });
      }
      let account;
      try {
        account = createOwnerAccount(store, { email, password, firstName });
      } catch (err) {
        return sendJson(res, err.code === 'ACCOUNT_EXISTS' ? 409 : 500, { error: err.message });
      }
      clearPortalAuthRate(rate.key);
      const session = createSession(store, { kind: 'user', accountId: account._id });
      return withCookie(res, sessionCookie(session), 200, { account: portalAccount(account) });
    },

    'POST /api/login': ({ req, res, body }) => {
      const { email, password } = body || {};
      const rate = checkPortalAuthRate(req, email);
      if (tooManyPortalAuth(res, rate)) return;
      const account = email ? store.accountByEmail(email) : null;
      if (!account || account.isDeleted === true || !account.isActive
        || !compareAccountPassword(password, account.password)) {
        return sendJson(res, 401, { error: 'invalid email or password' });
      }
      clearPortalAuthRate(rate.key);
      const session = createSession(store, { kind: 'user', accountId: account._id });
      return withCookie(res, sessionCookie(session), 200, { account: portalAccount(account) });
    },

    'POST /api/logout': ({ req, res }) => {
      const session = getSession(store, req);
      if (session) destroySession(store, session._id);
      return withCookie(res, clearCookie(), 200, {});
    },

    'GET /api/me': ({ req, res }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      return { account: portalAccount(account) };
    },

    'GET /api/robots': ({ req, res }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const robots = store.allRobots().filter(({ loop }) => loop && loop.owner === account._id);
      return robots.map(robotView);
    },

    // Add-a-robot: mint a setup token, build the WiFi+token QR payload (the robot scans it,
    // joins WiFi, and redeems the token via OOBE.setupRobot). loopId null = brand-new robot.
    'POST /api/robots/setup': ({ req, res, body }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const { ssid, password = '', static: staticConfig = null } = body || {};
      if (!ssid) return sendJson(res, 400, { error: 'WiFi ssid is required' });

      const token = mintSetupToken(store, account._id, null);
      const { payload, codes } = buildQrCodes({ ssid, password, staticConfig, token: token._id });
      return {
        token: token._id,
        expires: token.created + ACCESS_TOKEN_LIFETIME_MS,
        qr: { payload, codes }, // codes[] = one string per QR frame; the portal renders them
      };
    },

    // Existing (non-reset) robots prove possession from the SSH repoint
    // command by presenting the AWS key pair already on the device.  This
    // endpoint supplies the other half of that proof: a one-time code bound to
    // the signed-in *new* Phoenix account.  No original-cloud account data is
    // read or imported.
    'POST /api/robots/claim-code': ({ req, res }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const claim = issueRobotClaim(store, account);
      return {
        code: claim.code,
        expires: claim.expires,
        // The host is deliberately deployment-configured: this address is
        // written into a robot's /etc/hosts, so guessing from the browser Host
        // header would allow a poisoned reverse-proxy request to repoint it.
        repointHost: repointHost || null,
        adoptionPath: '/api/adopt-robot',
      };
    },

    // Poll: complete once the robot has redeemed the token (setupRobot deletes it).
    'GET /api/robots/setup/status': ({ req, res, url }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const tokenId = url.searchParams.get('token');
      if (!tokenId) return sendJson(res, 400, { error: 'token query param required' });
      const { token } = findToken(store, tokenId);
      if (token && String(token.accountId) !== String(account._id)) {
        // Do not turn a setup token into a cross-account completion oracle.
        return sendJson(res, 404, { error: 'setup token not found' });
      }
      return { complete: !token, expires: token ? token.created + ACCESS_TOKEN_LIFETIME_MS : null };
    },

    // -- per-robot hub auth ---------------------------------------------------

    // A robot exchanges its long-lived AWS keys for a short-lived hub token. This is the
    // server-held-secret path: the HUB_TOKEN_SECRET never leaves the server (unlike the robot
    // signing locally). Mints exactly the IAuthDetails the gateway verifies — minus the secret.
    'POST /api/token': ({ req, res, body }) => {
      const secret = process.env.HUB_TOKEN_SECRET;
      if (!secret) return sendJson(res, 503, { error: 'token issuance disabled: HUB_TOKEN_SECRET is not set' });
      const { accessKeyId, secretAccessKey } = body || {};
      const rate = checkPortalAuthRate(req, accessKeyId);
      if (tooManyPortalAuth(res, rate)) return;
      const account = accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
      if (!account || account.isDeleted === true || !account.isActive
        || !secretMatches(secretAccessKey, account.secretAccessKey)) {
        return sendJson(res, 401, { error: 'invalid credentials' });
      }
      clearPortalAuthRate(rate.key);
      account.lastSeen = Date.now();
      store.flush();
      const { token, expires } = createHubToken(account, secret);
      return { token, expires };
    },

    // The gateway calls this to validate a hub token's accessKeyId claim against a live account.
    // Never returns the secret — identity only. CONTRACT FROZEN.
    'GET /api/verify': ({ res, url }) => {
      const accessKeyId = url.searchParams.get('accessKeyId');
      const account = accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
      if (!account || account.isDeleted === true || !account.isActive) return { valid: false };
      return { valid: true, id: account._id, friendlyId: account.friendlyId || null };
    },

    // -- admin face (per-account isAdmin; there is no shared password) --------

    'GET /api/admin/me': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;
      return { admin: true, account: portalAccount(userFromSession(store, req)) };
    },

    'GET /api/admin/robots': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;
      return store.allRobots().map(robotView);
    },

    /**
     * Manual adoption — for robots that completed OOBE against the original cloud years ago.
     * Mints fresh keys + a loop, and returns exactly what to write to the robot
     * (/var/jibo/credentials.json) plus the repoint command. ownerEmail optional: defaults to
     * a synthetic "adopted@phoenix.local" owner account so admin-only setups need no signup.
     * A real existing Phoenix household is never silently transferred: an
     * administrator must set transferExisting=true after reviewing the owner.
     */
    'POST /api/admin/adopt': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return;
      const { friendlyId, ownerEmail, transferExisting = false } = body || {};
      if (!friendlyId || !/^[a-z0-9-]{3,80}$/i.test(friendlyId)) {
        return sendJson(res, 400, { error: 'friendlyId required (the robot\'s name, e.g. castle-cylinder-fig-quilt)' });
      }
      let owner = ownerEmail ? store.accountByEmail(ownerEmail) : store.accountByEmail('adopted@phoenix.local');
      if (!owner) {
        if (ownerEmail) return sendJson(res, 404, { error: `no account with email ${ownerEmail}` });
        owner = createOwnerAccount(store, { email: 'adopted@phoenix.local', password: cryptoRandomPassword(), firstName: 'Adopted' });
      }
      const existingRobot = store.accountByFriendlyId(friendlyId);
      if (existingRobot) {
        const linked = linkAdoptedRobotToOwner(store, {
          robot: existingRobot,
          owner,
          allowExistingOwnerTransfer: transferExisting === true,
        });
        if (linked.status !== 200) {
          return sendJson(res, 409, {
            ...linked.payload,
            error: 'robot is already linked to another Phoenix account; resubmit with transferExisting=true only after confirming the transfer',
          });
        }
        return {
          robot: robotView({ robot: existingRobot, loop: linked.payload.loop, owner }),
          existing: true,
          transferred: linked.payload.linked,
          instructions: [
            'The existing robot credentials were retained. Do not overwrite /var/jibo/credentials.json.',
          ],
        };
      }
      const { loop, robot } = createLoop(store, { owner, robotId: friendlyId });
      const region = accountRegion();
      return {
        robot: robotView({ robot, loop, owner }),
        secretAccessKey: robot.secretAccessKey, // shown once at adoption; needed for the robot file
        credentialsJson: { accessKeyId: robot.accessKeyId, secretAccessKey: robot.secretAccessKey, region },
        instructions: [
          `Write the credentialsJson object to /var/jibo/credentials.json on the robot (jibo-mount --rw first).`,
          `Point the robot at this server: scripts/point-robot-at-phoenix.sh --robot <robot-ip> --server http://<this-host>:<port>`,
        ],
      };
    },

    // -- the rest of the mobile-app surface ------------------------------------
    ...portalLoopRoutes(store, portal),
    ...portalProfileRoutes(store),
    ...portalRobotRoutes(store, portal),
    ...portalMediaRoutes(store, portal),
    ...portalPeopleRoutes(store, portal),
    ...portalMessagingRoutes(store, portal),
    ...portalSystemRoutes(store, portal),

    // The admin surface's configuration and operations routes. Each re-checks
    // requireAdmin itself, exactly as the routes above do — being mounted here
    // grants nothing on its own.
    ...adminConfigRoutes(store, { requireAdmin, sendJson }),
    ...adminOpsRoutes(store, { requireAdmin, sendJson, currentAccount: sessionUser }),
    ...adminLogRoutes(store, { requireAdmin, sendJson }),

    // Self-service adoption for a robot that already holds credentials. This one
    // is deliberately NOT session-guarded: the caller is the repoint script
    // running next to the robot, not a signed-in browser, and its proof is the
    // robot's own secretAccessKey in the body — the same secret every signed
    // robot request already depends on.
    ...robotAdoptionRoutes(store, { sendJson }),
  };
}

function cryptoRandomPassword() {
  return randomBytes(32).toString('base64url');
}
