// Robot-facing AWS-JSON-1.1 face — the OOBE half of srv-account-ws, plus an Update_* prefix
// proxy to the OTA service so the robot's single-endpoint repoint reaches both services.
//
// The robot's @jibo/jibo-server-client sends:
//   POST /                          Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <Prefix>.<Operation>     (we dispatch on the OPERATION, prefix-tolerant —
//                                           the OOBE prefix isn't in the archived API defs;
//                                           unknown prefixes are logged for field diagnosis)
//   Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/...   (the existing OOBE/Loop
//                                           compatibility handlers retain LAN trust like the
//                                           hub's DISABLE_AUTH; CreateHubToken verifies SigV4)
//
// Operations (oobe.handler.ts mapping): setupRobot, prepareRobot, getStatus;
// Account_20151111.CreateHubToken is handled by the bounded A-02 path below.
// (reconnectRobot/getServiceToken deferred — v1 is the new-robot path per the handoff).
// Error envelope: {__type:<code>, message} + x-amzn-errortype, statusCode from src/errors/*.
// Account_20151111.CreateHubToken is the bounded A-02 sensitive operation and
// never uses the public x-amz-credentials header as its identity.

import { sendJson, SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import {
  createAuthenticatedHubToken, createLoop, findOrCreateRobotAccount, mintSetupToken, findToken, deleteToken,
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

/** Legacy LAN-trust handlers extract an access key only for their compatibility lookup. */
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
    createhubtoken: issueHubToken,
  };

  const dispatch = async ({ req, res, body, log }) => {
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

    // Loop_* — the robot reads its loop here (e.g. jibo-system-backup.js: Loop.list -> loopId
    // before Backup.new). v1 implements List; other loop ops are not needed for robot revival.
    if (/^loop/i.test(prefix)) {
      log.info('loop request', { op });
      return void loopDispatch({ req, res, body: body || {}, op, log });
    }

    const handler = ops[op.toLowerCase()];
    if (!handler) {
      log.warn('unknown classic target', { target: `${prefix}.${op}` || '(none)' });
      return void sendAmzError(res, { code: 'UnknownOperationException', statusCode: 400 }, `unknown target ${prefix}.${op}`);
    }
    if (op.toLowerCase() === 'createhubtoken' && !/^account/i.test(prefix)) {
      log.warn('CreateHubToken requires the Account service prefix', { target: `${prefix}.${op}` });
      return void sendAmzError(res, { code: 'UnknownOperationException', statusCode: 400 }, `unknown target ${prefix}.${op}`);
    }
    if (prefix && !/^oobe/i.test(prefix) && !/^account/i.test(prefix)) {
      log.info('classic target with unexpected prefix (serving anyway)', { prefix, op });
    }
    // AccountHandler's Joi payload decorator sees the original value for
    // CreateHubToken: null, arrays, and primitive JSON values are validation
    // errors, while the other legacy robot handlers use an object default.
    const handlerBody = op.toLowerCase() === 'createhubtoken' ? body : (body || {});
    return handler({ req, res, body: handlerBody, log });
  };
  // Hapi presents an omitted request payload to CreateHubToken as null. Other
  // legacy robot handlers retain the service's historical object default.
  dispatch.bodyDefault = (req) => parseTarget(req).op.toLowerCase() === 'createhubtoken' ? null : {};

  return {
    'POST /': dispatch,
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

  /**
   * Account_20151111.CreateHubToken is the first sensitive robot-face
   * operation that requires a verified AWS V4 identity. Existing OOBE/Loop
   * operations intentionally retain their LAN-trust behavior until their
   * source gateway path is implemented; this operation never falls back to a
   * Credential= substring or the public x-amz-credentials forwarding header.
   */
  function issueHubToken({ req, res, body }) {
    let verification;
    try {
      verification = verifySigV4({
        method: req.method,
        path: req.originalUrl || req.url || '/',
        headers: req.headers,
        // body-parser's verify hook stores the post-inflation bytes. Reusing
        // them is required for signatures over JSON whitespace/key order.
        body: req.rawBody === undefined
          ? (body === null || body === undefined ? '' : JSON.stringify(body))
          : req.rawBody,
        resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
      });
    } catch (error) {
      if (error instanceof SigV4Error && SIGV4_ERRORS[error.code]) {
        return void sendAmzError(res, SIGV4_ERRORS[error.code]);
      }
      throw error;
    }

    const secret = process.env.ETCO_server_hubTokenSecret || process.env.HUB_TOKEN_SECRET;
    if (!secret) return void sendAmzError(res, SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);

    const validationError = validateCreateHubTokenPayload(body);
    if (validationError) return void sendValidationError(res, validationError);

    // The source handler passes an omitted payload through AccountController's
    // `payload = null` default. Explicit null is rejected by Joi.string().
    const payload = Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : null;
    const issued = createAuthenticatedHubToken(verification.credentials, secret, payload);
    return void sendAmz(res, 200, issued);
  }

  /**
   * @jibo/server validatePayload({ payload: Joi.string() }) with
   * `{allowUnknown: true}`. Boom.badData(JoiError) is Hapi's 422 JSON
   * response, rather than the AWS 400 ValidationException used by the older
   * local OOBE compatibility handlers.
   */
  function validateCreateHubTokenPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return '"value" must be an object';
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'payload')) return null;
    if (typeof body.payload !== 'string') {
      return 'child "payload" fails because ["payload" must be a string]';
    }
    if (body.payload.length === 0) {
      return 'child "payload" fails because ["payload" is not allowed to be empty]';
    }
    return null;
  }

  function sendValidationError(res, message) {
    const body = JSON.stringify({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message,
    });
    // Match Hapi 16's Boom response used by the source Account route. The
    // common Express service still supplies its normal headers elsewhere.
    res.removeHeader('x-powered-by');
    res.removeHeader('keep-alive');
    res.writeHead(422, {
      // Node 8 did not synthesize Node 22's Keep-Alive timeout header.
      // Explicitly preserve the request's connection policy to avoid it.
      connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
      vary: 'accept-encoding',
    });
    res.end(body);
  }

  // -- Loop_* ------------------------------------------------------------------

  /** loop-2016-03-24 Loop shape (members the robot's server-client reads: it needs `id`). */
  function loopToWire(loop) {
    const robot = store.accounts.get(loop.robot);
    return {
      id: loop._id,
      name: loop.name,
      owner: loop.owner,
      robot: loop.robot,
      robotFriendlyId: (robot && robot.friendlyId) || undefined,
      members: loop.members,
      created: loop.created,
      updated: loop.updated,
    };
  }

  function loopDispatch({ req, res, body, op, log }) {
    // The robot's server-client sends the operation's wire `name` (loop-2016-03-24):
    //   Loop.list()    -> "ListLoops"
    //   kb.loop.suspend -> "SuspendLoop" {loopId} / "SuspendRobotLoop" {friendlyId}  (the WIPE gate)
    const o = op.toLowerCase();
    if (o === 'listloops' || o === 'list') return void loopList({ req, res, log });
    if (o === 'suspendloop' || o === 'suspendrobotloop') return void loopSuspend({ res, body, op, log });
    log.warn('unimplemented Loop op', { op });
    return void sendAmzError(res, { code: 'UnknownOperationException', statusCode: 400 }, `unimplemented Loop op ${op}`);
  }

  /** Loop.List/ListLoops: "loops for the current account." */
  function loopList({ req, res, log }) {
    // The robot signs with its own credentials, so resolve the account from the SigV4 accessKeyId
    // and return the loop(s) it owns/belongs to. With auth disabled (dev/LAN), fall back to every
    // loop — a single-robot deployment has one, which is what jibo-system-backup.js requires.
    const accessKeyId = accessKeyIdFromAuth(req);
    const account = accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
    const loops = account
      ? [...store.loops.values()].filter((l) => l.robot === account._id || l.owner === account._id)
      : [...store.loops.values()];
    log.info('Loop.List', { accessKeyId: accessKeyId || '(none)', accountFound: !!account, returned: loops.length });
    return void sendAmz(res, 200, loops.map(loopToWire));
  }

  /**
   * Loop.SuspendLoop {loopId} / SuspendRobotLoop {friendlyId} — the robot's WipeUtil suspends its
   * loop before erasing. WipeUtil aborts the whole wipe ("wipeFail") on any suspend error that
   * isn't LOOP_NOT_FOUND, so this must succeed: mark the loop suspended (if we have it) and return
   * the CommandResponse {result}. The robot is on its way out the door — we never reject.
   */
  function loopSuspend({ res, body, op, log }) {
    let loop = null;
    if (op.toLowerCase() === 'suspendrobotloop' && body.friendlyId) {
      const robot = store.accountByFriendlyId(body.friendlyId);
      loop = robot ? [...store.loops.values()].find((l) => l.robot === robot._id) || null : null;
    } else if (body.loopId) {
      loop = store.loops.get(body.loopId) || null;
    }
    if (loop) { loop.isSuspended = true; store.flush(); }
    log.info('Loop.Suspend', { op, loopId: body.loopId, friendlyId: body.friendlyId, found: !!loop });
    return void sendAmz(res, 200, { result: 'Command accepted' });
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
