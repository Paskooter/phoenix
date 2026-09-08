// Robot-facing AWS-JSON-1.1 face — the OOBE half of srv-account-ws, plus an Update_* prefix
// proxy to the OTA service so the robot's single-endpoint repoint reaches both services.
//
// The robot's @jibo/jibo-server-client sends:
//   POST /                          Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <Prefix>.<Operation>     (we dispatch on the OPERATION, prefix-tolerant —
//                                           the OOBE prefix isn't in the archived API defs;
//                                           unknown prefixes are logged for field diagnosis)
//   Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/...   (the remaining OOBE/Loop
//                                           compatibility handlers retain LAN trust like the
//                                           hub's DISABLE_AUTH; the bounded suspend handlers
//                                           resolve ownership from this stored access key;
//                                           CreateHubToken verifies SigV4)
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
  populateLoop, ensureLoopMemberIds, isAcceptedMemberStatus, accountToPublicWire,
} from './model.js';
import { settingsAwsDispatch } from './settingsFace.js';
import { LoopUpdatedOutbox } from './loopUpdatedOutbox.js';
import { handleLoopMembership } from './loopMembership.js';
import { handleMemberPhotos, isMemberPhotoUpload, stagePhotoDigest } from './loopMemberPhotos.js';
import { handleRobotLookup } from './robotLookup.js';
import { AMZ_JSON, accessKeyIdFromAuth, sendAmz, sendAmzError } from './loopHttp.js';

export { AMZ_JSON, accessKeyIdFromAuth, sendAmz, sendAmzError };

const SERVICE_MODE_EMAIL_PREFIX = 'service-mode-';

// errors/{token,account,loop}.ts — exact {code, statusCode} pairs.
const Errors = Object.freeze({
  TOKEN_NOT_FOUND: { code: 'TOKEN_NOT_FOUND', message: 'Token not found', statusCode: 404 },
  TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', message: 'Token expired', statusCode: 401 },
  ACCOUNT_NOT_FOUND: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', statusCode: 404 },
  LOOP_MUST_BE_SUSPENDED: { code: 'LOOP_MUST_BE_SUSPENDED', message: 'Loop must be suspended', statusCode: 409 },
  CREDENTIALS_REQUIRED: { code: 'CREDENTIALS_REQUIRED', message: 'Credentials required', statusCode: 401 },
  AUTHORIZED_UNDER_ADMIN: { code: 'AUTHORIZED_UNDER_ADMIN', message: 'Must be authorized under admin account', statusCode: 401 },
  LOOP_NOT_FOUND: { code: 'LOOP_NOT_FOUND', message: 'Loop does not exist', statusCode: 404 },
  ROBOT_NOT_FOUND: { code: 'ROBOT_NOT_FOUND', message: 'Robot not found', statusCode: 404 },
  ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND: {
    code: 'ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND',
    message: 'Only admin or robot can suspend loop',
    statusCode: 403,
  },
  LOOP_VALIDATION: { code: 'ValidationException', message: 'Invalid payload', statusCode: 422 },
  VALIDATION: { code: 'ValidationException', message: 'Invalid payload', statusCode: 400 },
  MEMBER_CAN_REQUEST: {
    code: 'MEMBER_CAN_REQUEST',
    message: 'You can only request members that are in your loops',
    statusCode: 401,
  },
});

function sendAmzEmpty(res, status = 200) {
  // LoopHandler.SuspendRobotLoop does not return the delegated command result. Hapi's
  // `reply()` therefore emits a successful zero-length response (the API model declares
  // a null output), while SuspendLoop itself returns CommandResponse.
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

/** "<Prefix>.<Operation>" -> { prefix, op } (op matched case-insensitively downstream). */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return { prefix: dot >= 0 ? t.slice(0, dot) : '', op: (dot >= 0 ? t.slice(dot + 1) : t) };
}

function otaBase() {
  const net = process.env.NET_ota || 'localhost:7015';
  return /^https?:\/\//.test(net) ? net : `http://${net}`;
}

/** @param {import('./store.js').Store} store */
export function robotFaceRoutes(store, { settingsProviders = null, loopUpdatedOutbox = new LoopUpdatedOutbox(store), loopConfig = {}, memberPhotoProvider } = {}) {
  // LoopController snapshots this feature flag at construction; only literal
  // lowercase 'off' disables COPPA, matching the source configuration.
  const coppaEnabled = !loopConfig.features || loopConfig.features.coppa !== 'off';
  // oobe.handler.ts mapping keys (lowercased for the prefix-tolerant match).
  const ops = {
    setuprobot: setupRobot,
    preparerobot: prepareRobot,
    getstatus: getStatus,
    createhubtoken: issueHubToken,
  };

  const dispatch = async ({ req, res, body, log }) => {
    const { prefix, op } = parseTarget(req);
    // Hapi's binary stream route checks the declared length before dispatch.
    // Its stream output does not impose a cumulative limit on chunked bodies.
    if (isMemberPhotoUpload(req) && Number(req.headers['content-length']) > 1000000000) {
      const data = JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'Payload content length greater than maximum allowed: 1000000000' });
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), connection: 'close' });
      res.end(data);
      req.resume();
      return;
    }


    // Update_* (and any future classic prefix we host elsewhere) -> proxy to OTA, so the
    // robot's region_config can point every service at this one endpoint.
    if (/^update/i.test(prefix)) {
      return proxyToOta(req, res, body, log);
    }

    // Settings_* — the report-skill's user-prefs source (NET_settings points here).
    if (/^settings/i.test(prefix)) {
      return settingsAwsDispatch(store, { req, res, body, op, prefix, log, providers: settingsProviders });
    }

    // Loop_* — the robot reads its loop here (e.g. jibo-system-backup.js: Loop.list -> loopId
    // before Backup.new). ListLoops emits LoopController.populateLoop so SSM LoopManager
    // can sync /jibo/loop. Membership lifecycle (Create/Invite/Accept/Decline/ListMembers/
    // RemoveMember), bounded member-profile operations, and the record operations
    // UpdateLoop/RemoveLoop/ClearRobot are A-04 increments; the remaining loop ops
    // are unimplemented.
    if (/^loop/i.test(prefix)) {
      // Source security gateway authenticates Loop operations before forwarding
      // to Account. Only the exact invitation/agreement targets below permit
      // an absent Authorization header; a supplied header is always verified.
      const anonymousTarget = [
        'Loop_20160324.AcceptInvitationByCode',
        'Loop_20160324.DeclineInvitationByCode',
        'Loop_20160324.UpdateAgreementStatus',
      ].includes(String(req.headers['x-amz-target'] || ''));
      if (!anonymousTarget || req.headers.authorization) {
        try {
          if (isMemberPhotoUpload(req) && req.headers.authorization && !req.headers['x-amz-content-sha256']) await stagePhotoDigest(req);
          const verification = verifySigV4({
            method: req.method,
            path: req.originalUrl || req.url || '/',
            headers: req.headers,
            bodyDigest: req.photoBodyDigest,
            body: req.rawBody === undefined
              ? (body == null ? '' : JSON.stringify(body)) : req.rawBody,
            resolveCredentials: (accessKeyId) => {
              const account = store.accountByAccessKeyId(accessKeyId);
              return account && account.isDeleted !== true ? account : null;
            },
          });
          req._phoenixVerifiedCredentials = verification.credentials;
        } catch (error) {
          if (req.photoCleanup) await req.photoCleanup();
          if (!(error instanceof SigV4Error) || !SIGV4_ERRORS[error.code]) throw error;
          return void sendAmzError(res, SIGV4_ERRORS[error.code]);
        }
      }
      log.info('loop request', { op });
      // Preserve primitive payloads for the source-validated Loop handlers.
      const validated = /^(removememberphoto|listloops|list|setenrollment|updatenickname|updatephoneticname|getrobot|findowner|listownerrobots|updateloop|removeloop|clearrobot|updateloopmember)$/i.test(op);
      try { return await loopDispatch({ req, res, body: validated ? body : (body || {}), op, log }); }
      finally { if (req.photoCleanup) await req.photoCleanup(); }
    }

    // Account_20151111.Get is the LoopManager fallback when the local KB root
    // has no robot id yet: Account.get({}) returns the caller's account.
    if (/^account/i.test(prefix) && op.toLowerCase() === 'get') {
      return void accountGet({ req, res, body: body || {}, log });
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
  dispatch.rawBody = isMemberPhotoUpload;
  dispatch.bodyDefault = (req) => {
    const target = parseTarget(req);
    if (target.op.toLowerCase() === 'createhubtoken') return null;
    if (/^settings/i.test(target.prefix)) return null;
    return {};
  };

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

  /** LoopController.populateLoop: ListLoops members carry id/accountId/account/status. */
  function loopToWire(loop, { isRobotRequesting = false } = {}) {
    return populateLoop(store, loop, { isRobotRequesting });
  }

  function loopDispatch({ req, res, body, op, log }) {
    // The robot's server-client sends the operation's wire `name` (loop-2016-03-24):
    //   Loop.list()    -> "ListLoops"
    //   kb.loop.suspend -> "SuspendLoop" {loopId} / "SuspendRobotLoop" {friendlyId}  (the WIPE gate)
    const o = op.toLowerCase();
    const photo = handleMemberPhotos({ store, req, res, body, op, provider: memberPhotoProvider, outbox: loopUpdatedOutbox });
    if (photo !== false) return photo;
    if (handleLoopMembership({ store, req, res, body, op, log, loopUpdatedOutbox, coppaEnabled })) return;
    if (handleRobotLookup({ store, req, res, body, op })) return;
    if (o === 'listloops' || o === 'list') return void loopList({ req, res, body, log });
    if (o === 'suspendloop' || o === 'suspendrobotloop') {
      return void loopSuspend({ req, res, body, op, log });
    }
    log.warn('unimplemented Loop op', { op });
    return void sendAmzError(res, { code: 'UnknownOperationException', statusCode: 400 }, `unimplemented Loop op ${op}`);
  }

  /** Loop.List/ListLoops: "loops for the current account." */
  function loopList({ req, res, body, log }) {
    // srv-account-ws@6cea434's ListLoops decorator validates
    // Joi.validate(request.payload, { loopId: Joi.string() },
    // { allowUnknown: true }) and discards the converted value. The handler
    // still reads the original request.payload, so unknown properties are
    // accepted and loopId must remain an optional, non-empty string.
    const validation = listLoopsValidationMessage(body);
    if (validation) return void sendValidationError(res, validation);

    // LoopController.list first selects owner or accepted/invited membership,
    // then infers robot mode from that selection (or the credential hint).
    const accessKeyId = accessKeyIdFromAuth(req);
    const account = req._phoenixVerifiedCredentials;
    const visible = [...store.loops.values()].filter((loop) => loop.isDeleted !== true
      && (loop.owner === account._id || (loop.members || []).some((member) =>
        member.accountId === account._id
        && ['accepted', 'invited'].includes(String(member.status || '').toLowerCase()))));
    const requested = body.loopId
      ? visible.filter((loop) => String(loop._id) === body.loopId)
      : visible;
    const isRobotRequesting = !!account.friendlyId
      || requested.some((loop) => loop.robot && loop.robot === account._id);
    const loops = isRobotRequesting
      ? requested.filter((loop) => loop.robot === account._id && !loop.isSuspended)
      : requested;
    let persisted = false;
    const wired = loops.map((loop) => {
      if (ensureLoopMemberIds(loop)) persisted = true;
      return loopToWire(loop, { isRobotRequesting });
    });
    if (persisted) store.flush();
    log.info('Loop.List', { accessKeyId: accessKeyId || '(none)', accountFound: !!account, returned: loops.length });
    return void sendAmz(res, 200, wired);
  }

  /**
   * AccountHandler.Get: empty ids means the caller. LoopManager uses this when
   * the local /jibo/loop root has no robot id yet.
   */
  function accountGet({ req, res, body, log }) {
    const caller = accountForClassicRequest(req);
    if (!caller) return void sendAmzError(res, Errors.CREDENTIALS_REQUIRED);
    if (body.ids !== undefined && !Array.isArray(body.ids)) {
      return void sendValidationError(res, 'child "ids" fails because ["ids" must be an array]');
    }
    const ids = body.ids && body.ids.length ? body.ids.map(String) : [caller._id];
    if (!caller.isAdmin && !idsBelongToCallerLoops(caller._id, ids)) {
      log.info('Account.Get', { ownerId: caller._id, requested: ids.length, authorized: false });
      return void sendAmzError(res, Errors.MEMBER_CAN_REQUEST);
    }
    const accounts = ids
      .map((id) => store.accounts.get(id))
      .filter((account) => account && account.isDeleted !== true)
      .map(accountToPublicWire);
    log.info('Account.Get', { ownerId: caller._id, requested: ids.length, returned: accounts.length });
    return void sendAmz(res, 200, accounts);
  }

  function idsBelongToCallerLoops(ownerId, ids) {
    const allowed = new Set([ownerId]);
    for (const loop of store.loops.values()) {
      if (loop.isDeleted === true) continue;
      const visible = loop.owner === ownerId
        || (Array.isArray(loop.members)
          && loop.members.some((member) => member.accountId === ownerId
            && isAcceptedMemberStatus(member.status)));
      if (!visible) continue;
      for (const member of loop.members || []) {
        if (member.accountId && isAcceptedMemberStatus(member.status)) {
          allowed.add(member.accountId);
        }
      }
    }
    return ids.every((id) => allowed.has(id));
  }

  /**
   * Loop.SuspendLoop {loopId} / SuspendRobotLoop {friendlyId}.
   *
   * The source handler parses credentials before validation. SuspendLoop then looks up the
   * loop and permits only that loop's robot or an administrator. SuspendRobotLoop is
   * admin-only at the handler boundary, looks up the robot by friendlyId, and delegates to
   * suspendLoop with an admin identity. Resolve the caller from the signed-request access key
   * used by this public Classic compatibility face; the x-amz-credentials header is an
   * internal source-service convention and must not become a caller-controlled admin switch.
   */
  function loopSuspend({ req, res, body, op, log }) {
    const isRobotLookup = op.toLowerCase() === 'suspendrobotloop';
    const caller = accountForClassicRequest(req);

    // @parseCredentials({ adminOnly: true }) runs before @validatePayload for this method.
    if (isRobotLookup && (!caller || !caller.isAdmin)) {
      return void sendAmzError(res, Errors.AUTHORIZED_UNDER_ADMIN);
    }

    const field = isRobotLookup ? 'friendlyId' : 'loopId';
    const validationMessage = requiredStringValidationMessage(body, field);
    if (validationMessage) {
      // LoopHandler's @validatePayload decorator rejects these values with
      // Boom.badData (HTTP 422).  Keep this branch on the source Hapi
      // envelope; the AWS JSON envelope remains the contract for the other
      // Loop/controller failures below.
      return void sendValidationError(res, validationMessage);
    }

    let loop = null;
    if (isRobotLookup) {
      const robot = store.accountByFriendlyId(body.friendlyId);
      if (!robot) {
        log.info('Loop.Suspend', { op, friendlyId: body.friendlyId, found: false, reason: 'robot-not-found' });
        return void sendAmzError(res, Errors.ROBOT_NOT_FOUND);
      }
      loop = activeLoopForRobot(robot._id);
      if (!loop) {
        log.info('Loop.Suspend', { op, friendlyId: body.friendlyId, found: false, reason: 'loop-not-found' });
        return void sendAmzError(res, Errors.LOOP_NOT_FOUND);
      }
      // The source delegates with `{isAdmin: true}` after the admin-only gate. Keep the
      // resulting controller check explicit in this compatibility implementation.
    } else {
      // BaseLoopController.findById runs before the source ownership check.
      loop = activeLoopById(body.loopId);
      if (!loop) {
        log.info('Loop.Suspend', { op, loopId: body.loopId, found: false, reason: 'loop-not-found' });
        return void sendAmzError(res, Errors.LOOP_NOT_FOUND);
      }
      if (!caller || (loop.robot !== caller._id && !caller.isAdmin)) {
        log.info('Loop.Suspend', { op, loopId: body.loopId, found: true, authorized: false });
        return void sendAmzError(res, Errors.ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND);
      }
    }

    const previousSuspended = loop.isSuspended;
    const previousUpdated = loop.updated;
    loop.isSuspended = true;
    // Mongoose's Loop pre-save hook writes updated on every save. Persist the same durable
    // field so a restart and a subsequent List call observe the state transition.
    loop.updated = Date.now();
    try {
      loopUpdatedOutbox.record(loop);
    } catch (error) {
      // The source save and its post-save event are one successful operation
      // from this boundary's perspective. If the local snapshot cannot be
      // committed, keep the in-memory loop aligned with the rejected write.
      if (previousSuspended === undefined) delete loop.isSuspended;
      else loop.isSuspended = previousSuspended;
      if (previousUpdated === undefined) delete loop.updated;
      else loop.updated = previousUpdated;
      throw error;
    }
    log.info('Loop.Suspend', {
      op,
      loopId: loop._id,
      friendlyId: body.friendlyId,
      found: true,
      authorized: true,
    });
    if (isRobotLookup) return void sendAmzEmpty(res);
    return void sendAmz(res, 200, { result: 'Command accepted' });
  }

  function accountForClassicRequest(req) {
    const accessKeyId = accessKeyIdFromAuth(req);
    return accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
  }

  function activeLoopById(loopId) {
    const loop = store.loops.get(loopId);
    return loop && loop.isDeleted !== true ? loop : null;
  }

  function activeLoopForRobot(robotId) {
    return [...store.loops.values()].find((loop) => loop.isDeleted !== true && loop.robot === robotId) || null;
  }

  function requiredStringValidationMessage(body, field) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      return `child "${field}" fails because ["${field}" is required]`;
    }
    if (typeof body[field] !== 'string') {
      return `child "${field}" fails because ["${field}" must be a string]`;
    }
    if (body[field].length === 0) {
      return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
    }
    return null;
  }

  function listLoopsValidationMessage(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
    // Joi treats an explicit undefined as an omitted optional property. JSON
    // cannot carry undefined, but retaining the rule keeps this helper aligned
    // with the source decorator for direct callers.
    if (!Object.prototype.hasOwnProperty.call(body, 'loopId') || body.loopId === undefined) return null;
    if (typeof body.loopId !== 'string') return 'child "loopId" fails because ["loopId" must be a string]';
    if (body.loopId.length === 0) return 'child "loopId" fails because ["loopId" is not allowed to be empty]';
    return null;
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
