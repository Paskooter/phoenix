// Robot-facing AWS-JSON-1.1 face — the OOBE half of srv-account-ws, plus an Update_* prefix
// proxy to the OTA service so the robot's single-endpoint repoint reaches both services.
//
// The robot's @jibo/jibo-server-client sends:
//   POST /                          Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <Prefix>.<Operation>     (we dispatch on the OPERATION, prefix-tolerant —
//                                           the OOBE prefix isn't in the archived API defs;
//                                           unknown prefixes are logged for field diagnosis)
//   Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/...   (SigV4 NOT verified — LAN
//                                           trust like the hub's DISABLE_AUTH; for authed ops
//                                           we parse the accessKeyId out and look the account up)
//
// Operations (oobe.handler.ts mapping): setupRobot, prepareRobot, getStatus
// (reconnectRobot/getServiceToken deferred — v1 is the new-robot path per the handoff).
// Error envelope: {__type:<code>, message} + x-amzn-errortype, statusCode from src/errors/*.

import { sendJson } from '@phoenix/common';
import {
  createLoop, findOrCreateRobotAccount, mintSetupToken, findToken, deleteToken,
} from './model.js';
import { settingsAwsDispatch } from './settingsFace.js';

export const AMZ_JSON = 'application/x-amz-json-1.1';
const SERVICE_MODE_EMAIL_PREFIX = 'service-mode-';

// errors/{token,account,loop}.ts — exact {code, statusCode} pairs.
const Errors = Object.freeze({
  TOKEN_NOT_FOUND: { code: 'TOKEN_NOT_FOUND', message: 'Token not found', statusCode: 404 },
  TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', message: 'Token expired', statusCode: 401 },
  ACCOUNT_NOT_FOUND: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', statusCode: 404 },
  LOOP_MUST_BE_SUSPENDED: { code: 'LOOP_MUST_BE_SUSPENDED', message: 'Loop must be suspended', statusCode: 409 },
  CREDENTIALS_REQUIRED: { code: 'CREDENTIALS_REQUIRED', message: 'Credentials required', statusCode: 401 },
  VALIDATION: { code: 'ValidationException', message: 'Invalid payload', statusCode: 400 },
});

export function sendAmz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendAmzError(res, err, message) {
  const body = JSON.stringify({ __type: err.code, message: message || err.message });
  res.writeHead(err.statusCode, {
    'content-type': AMZ_JSON,
    'content-length': Buffer.byteLength(body),
    'x-amzn-errortype': err.code,
  });
  res.end(body);
}

/** "<Prefix>.<Operation>" -> { prefix, op } (op matched case-insensitively downstream). */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return { prefix: dot >= 0 ? t.slice(0, dot) : '', op: (dot >= 0 ? t.slice(dot + 1) : t) };
}

/** SigV4 "Credential=<accessKeyId>/<date>/..." -> accessKeyId (the only part we trust). */
export function accessKeyIdFromAuth(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const m = /Credential=([^/,\s]+)\//.exec(auth);
  return m ? m[1] : null;
}

function otaBase() {
  const net = process.env.NET_ota || 'localhost:7015';
  return /^https?:\/\//.test(net) ? net : `http://${net}`;
}

/** @param {import('./store.js').Store} store */
export function robotFaceRoutes(store) {
  // oobe.handler.ts mapping keys (lowercased for the prefix-tolerant match).
  const ops = {
    setuprobot: setupRobot,
    preparerobot: prepareRobot,
    getstatus: getStatus,
  };

  return {
    'POST /': async ({ req, res, body, log }) => {
      const { prefix, op } = parseTarget(req);

      // Update_* (and any future classic prefix we host elsewhere) -> proxy to OTA, so the
      // robot's region_config can point every service at this one endpoint.
      if (/^update/i.test(prefix)) {
        return proxyToOta(req, res, body, log);
      }

      // Settings_* — the report-skill's user-prefs source (NET_settings points here).
      if (/^settings/i.test(prefix)) {
        return void settingsAwsDispatch(store, { req, res, body: body || {}, op, log });
      }

      const handler = ops[op.toLowerCase()];
      if (!handler) {
        log.warn('unknown classic target', { target: `${prefix}.${op}` || '(none)' });
        return void sendAmzError(res, { code: 'UnknownOperationException', statusCode: 400 }, `unknown target ${prefix}.${op}`);
      }
      if (prefix && !/^oobe/i.test(prefix) && !/^account/i.test(prefix)) {
        log.info('classic target with unexpected prefix (serving anyway)', { prefix, op });
      }
      return handler({ req, res, body: body || {}, log });
    },
  };

  // -- operations -------------------------------------------------------------

  /** oobe.ctrl.ts setupRobot — the robot's one OOBE call. v1: new-robot + same-robot-reissue. */
  function setupRobot({ res, body, log }) {
    const { token: tokenId, id } = body;
    if (!tokenId || !id) return void sendAmzError(res, Errors.VALIDATION, 'token and id are required');

    const { token, error } = findToken(store, tokenId);
    if (error) return void sendAmzError(res, Errors[error]);

    const account = store.accounts.get(token.accountId);
    if (!account) return void sendAmzError(res, Errors.ACCOUNT_NOT_FOUND);

    let loop;
    if (token.loopId) {
      // Re-setup of an existing loop. v1 supports the same-robot-reconnect path; a different
      // robot against a live loop is rejected exactly like the original.
      loop = store.loops.get(token.loopId);
      if (!loop) return void sendAmzError(res, { code: 'LOOP_NOT_FOUND', message: 'Loop not found', statusCode: 404 });
      const currentRobot = store.accounts.get(loop.robot);
      if (!currentRobot || currentRobot.friendlyId !== id) {
        return void sendAmzError(res, Errors.LOOP_MUST_BE_SUSPENDED);
      }
    } else {
      ({ loop } = createLoop(store, { owner: account, robotId: id }));
    }

    const robot = store.accounts.get(loop.robot) || findOrCreateRobotAccount(store, id);
    deleteToken(store, token._id); // ONE-TIME

    const credentials = {
      accessKeyId: robot.accessKeyId,
      secretAccessKey: robot.secretAccessKey,
      serviceMode: (account.email && account.email.startsWith(SERVICE_MODE_EMAIL_PREFIX)) ? true : undefined,
    };
    log.info('setupRobot complete', { friendlyId: id, loop: loop._id });
    return void sendAmz(res, 200, credentials);
  }

  /** oobe.handler.ts PrepareRobot — authed: accountId from the SigV4 Credential accessKeyId. */
  function prepareRobot({ req, res, body }) {
    const accessKeyId = accessKeyIdFromAuth(req);
    const account = accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
    if (!account) return void sendAmzError(res, Errors.CREDENTIALS_REQUIRED);
    const token = mintSetupToken(store, account._id, (body && body.loopId) || null);
    return void sendAmz(res, 200, { token: token._id, expires: token.created + 15 * 60 * 1000 });
  }

  /** oobe.ctrl.ts getStatus: complete = the token no longer exists/is invalid. */
  function getStatus({ res, body }) {
    if (!body || !body.token) return void sendAmzError(res, Errors.VALIDATION, 'token is required');
    const { token } = findToken(store, body.token);
    return void sendAmz(res, 200, { complete: !token });
  }

  // -- Update_* proxy ----------------------------------------------------------

  async function proxyToOta(req, res, body, log) {
    try {
      const upstream = await fetch(`${otaBase()}/`, {
        method: 'POST',
        headers: {
          'content-type': req.headers['content-type'] || AMZ_JSON,
          'x-amz-target': req.headers['x-amz-target'],
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const text = await upstream.text();
      const headers = { 'content-type': upstream.headers.get('content-type') || AMZ_JSON, 'content-length': Buffer.byteLength(text) };
      const errType = upstream.headers.get('x-amzn-errortype');
      if (errType) headers['x-amzn-errortype'] = errType;
      res.writeHead(upstream.status, headers);
      res.end(text);
    } catch (err) {
      log.error('OTA proxy failed', { error: err.message, ota: otaBase() });
      sendJson(res, 502, { error: `OTA service unreachable: ${err.message}` });
    }
  }
}
