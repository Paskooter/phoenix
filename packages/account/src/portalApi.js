// Portal + admin REST face (we design this; session-cookie auth). Routes are exact-match
// (createService), so parameters travel as query strings or JSON bodies.
//
//   POST /api/signup {email,password,firstName?}   -> {account}        + session cookie
//   POST /api/login  {email,password}              -> {account}        + session cookie
//   POST /api/logout                               -> {}               (clears cookie)
//   GET  /api/me                                   -> {account} | 401
//   GET  /api/robots                               -> [{friendlyId,loopName,loopId,created,lastSeen}]
//   POST /api/admin/login {password}               -> {admin:true}     + admin session cookie
//   GET  /api/admin/me                             -> {admin:true} | 401
//   GET  /api/admin/robots                         -> all adopted robots (across every account)
//   POST /api/admin/adopt {friendlyId, ownerEmail?} -> credentials + repoint instructions
//
// ADMIN_PASSWORD comes from .env; when unset the admin face is disabled entirely.

import { sendJson } from '@phoenix/common';
import { createOwnerAccount, verifyPassword, createLoop, mintSetupToken, findToken, ACCESS_TOKEN_LIFETIME_MS } from './model.js';
import { createSession, destroySession, getSession, sessionCookie, clearCookie, checkAdminPassword } from './sessions.js';
import { buildQrCodes } from './qrPayload.js';

const publicAccount = (a) => ({
  id: a._id, email: a.email, firstName: a.firstName, lastName: a.lastName, created: a.created,
});

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

export function userFromSession(store, req) {
  const session = getSession(store, req);
  if (!session || session.kind !== 'user') return null;
  return store.accounts.get(session.accountId) || null;
}

export function isAdmin(store, req) {
  const session = getSession(store, req);
  return !!(session && session.kind === 'admin');
}

/** @param {import('./store.js').Store} store @returns route map fragment for createService */
export function portalRoutes(store) {
  return {
    'POST /api/signup': ({ res, body }) => {
      const { email, password, firstName = '' } = body || {};
      if (!email || !password || String(password).length < 8) {
        return sendJson(res, 400, { error: 'email and a password of at least 8 characters are required' });
      }
      let account;
      try {
        account = createOwnerAccount(store, { email, password, firstName });
      } catch (err) {
        return sendJson(res, err.code === 'ACCOUNT_EXISTS' ? 409 : 500, { error: err.message });
      }
      const session = createSession(store, { kind: 'user', accountId: account._id });
      return withCookie(res, sessionCookie(session), 200, { account: publicAccount(account) });
    },

    'POST /api/login': ({ res, body }) => {
      const { email, password } = body || {};
      const account = email ? store.accountByEmail(email) : null;
      if (!account || !account.isActive || !verifyPassword(password, account.password)) {
        return sendJson(res, 401, { error: 'invalid email or password' });
      }
      const session = createSession(store, { kind: 'user', accountId: account._id });
      return withCookie(res, sessionCookie(session), 200, { account: publicAccount(account) });
    },

    'POST /api/logout': ({ req, res }) => {
      const session = getSession(store, req);
      if (session) destroySession(store, session._id);
      return withCookie(res, clearCookie(), 200, {});
    },

    'GET /api/me': ({ req, res }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      return { account: publicAccount(account) };
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

    // Poll: complete once the robot has redeemed the token (setupRobot deletes it).
    'GET /api/robots/setup/status': ({ req, res, url }) => {
      const account = userFromSession(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const tokenId = url.searchParams.get('token');
      if (!tokenId) return sendJson(res, 400, { error: 'token query param required' });
      const { token } = findToken(store, tokenId);
      return { complete: !token, expires: token ? token.created + ACCESS_TOKEN_LIFETIME_MS : null };
    },

    // -- admin face (ADMIN_PASSWORD from .env) --------------------------------

    'POST /api/admin/login': ({ res, body }) => {
      if (!process.env.ADMIN_PASSWORD) return sendJson(res, 503, { error: 'admin UI disabled: ADMIN_PASSWORD is not set' });
      if (!checkAdminPassword(body && body.password)) return sendJson(res, 401, { error: 'wrong admin password' });
      const session = createSession(store, { kind: 'admin' });
      return withCookie(res, sessionCookie(session), 200, { admin: true });
    },

    'GET /api/admin/me': ({ req, res }) => {
      if (!isAdmin(store, req)) return sendJson(res, 401, { error: 'not admin' });
      return { admin: true };
    },

    'GET /api/admin/robots': ({ req, res }) => {
      if (!isAdmin(store, req)) return sendJson(res, 401, { error: 'not admin' });
      return store.allRobots().map(robotView);
    },

    /**
     * Manual adoption — for robots that completed OOBE against the original cloud years ago.
     * Mints fresh keys + a loop, and returns exactly what to write to the robot
     * (/var/jibo/credentials.json) plus the repoint command. ownerEmail optional: defaults to
     * a synthetic "adopted@phoenix.local" owner account so admin-only setups need no signup.
     */
    'POST /api/admin/adopt': ({ req, res, body }) => {
      if (!isAdmin(store, req)) return sendJson(res, 401, { error: 'not admin' });
      const { friendlyId, ownerEmail } = body || {};
      if (!friendlyId || !/^[a-z0-9-]{3,80}$/i.test(friendlyId)) {
        return sendJson(res, 400, { error: 'friendlyId required (the robot\'s name, e.g. castle-cylinder-fig-quilt)' });
      }
      let owner = ownerEmail ? store.accountByEmail(ownerEmail) : store.accountByEmail('adopted@phoenix.local');
      if (!owner) {
        if (ownerEmail) return sendJson(res, 404, { error: `no account with email ${ownerEmail}` });
        owner = createOwnerAccount(store, { email: 'adopted@phoenix.local', password: cryptoRandomPassword(), firstName: 'Adopted' });
      }
      const { loop, robot } = createLoop(store, { owner, robotId: friendlyId });
      const region = process.env.ETCO_account_region || 'phx';
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
  };
}

function cryptoRandomPassword() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
