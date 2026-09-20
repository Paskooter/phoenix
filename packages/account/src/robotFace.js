// Robot-facing AWS-JSON-1.1 face — the OOBE half of srv-account-ws, plus an Update_* prefix
// proxy to the OTA service so the robot's single-endpoint repoint reaches both services.
//
// The robot's @jibo/jibo-server-client sends:
//   POST /                          Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <Prefix>.<Operation>     (we dispatch on the OPERATION, prefix-tolerant;
//                                           the archived API models confirm targetPrefix
//                                           OOBE_20161026 for BOTH apis/oobe-2016-10-26 and
//                                           apis/oobeadmin-2016-10-26, and unknown prefixes
//                                           are logged for field diagnosis)
//   Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/...   (the remaining OOBE/Loop
//                                           compatibility handlers retain LAN trust like the
//                                           hub's DISABLE_AUTH; the bounded suspend handlers
//                                           resolve ownership from this stored access key;
//                                           CreateHubToken verifies SigV4)
//
// Operations (oobe.handler.ts mapping): setupRobot, prepareRobot, getStatus,
// reconnectRobot, getServiceToken.
// Account_20151111.CreateHubToken is handled by the bounded A-02 path below.
// Error envelope: {__type:<code>, message} + x-amzn-errortype, statusCode from src/errors/*,
// except the @validatePayload (Joi -> Boom.badData) refusals, which keep Hapi's 422 envelope.
// Account_20151111.CreateHubToken is the bounded A-02 sensitive operation and
// never uses the public x-amz-credentials header as its identity.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sendJson, SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { parse as parseQueryString } from 'node:querystring';
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  ACCESS_TOKEN_LIFETIME_MS, MEMBER_STATUS, createAuthenticatedHubToken, createLoop, createOwnerAccount,
  findOrCreateRobotAccount, mintSetupToken, findToken, deleteToken, newId,
  populateLoop, ensureLoopMemberIds,
} from './model.js';
import { settingsAwsDispatch } from './settingsFace.js';
import { LoopUpdatedOutbox } from './loopUpdatedOutbox.js';
import { handleLoopMembership, removeRobotFromLoops, saveLoop } from './loopMembership.js';
import { dispatchLoopCreated } from './loopCreation.js';
import { handleLoopAgreements } from './loopAgreements.js';
import { EchoSignProvider } from './echoSignProvider.js';
import { handleMemberPhotos, isMemberPhotoUpload, stagePhotoDigest } from './loopMemberPhotos.js';
import { handleRobotLookup } from './robotLookup.js';
import { handleAccountIdentity, isAccountPhotoUpload } from './accountIdentity.js';
import { oauthClientsDispatch } from './oauthClients.js';
import { lpsDispatch } from './lps.js';
import { AMZ_JSON, accessKeyIdFromAuth, sendAmz, sendAmzEmpty, sendAmzError, sendValidationError } from './loopHttp.js';

export { AMZ_JSON, accessKeyIdFromAuth, sendAmz, sendAmzError };

// srv-account-ws@6cea434 src/constants.ts:
//   export const SERVICE_MODE_EMAIL_PREFIX = 'service-mode-owner-';
// The trailing "owner-" matters: getServiceToken mints accounts named
// `${SERVICE_MODE_EMAIL_PREFIX}${uuid}@jibo.com`, and getStatus decides the
// serviceMode credential flag by prefix test. A shorter prefix here would flag
// unrelated 'service-mode-*' addresses as service mode.
const SERVICE_MODE_EMAIL_PREFIX = 'service-mode-owner-';
const OOBE_MAX_PAYLOAD_BYTES = 1024 * 1024;

// errors/{token,account,loop}.ts — exact {code, statusCode} pairs.
const Errors = Object.freeze({
  TOKEN_NOT_FOUND: { code: 'TOKEN_NOT_FOUND', message: 'Token not found', statusCode: 404 },
  TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', message: 'Token expired', statusCode: 401 },
  ACCOUNT_NOT_FOUND: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', statusCode: 404 },
  // errors/account.ts ACCOUNT_IS_DELETED: accountCtrl.findById throws this for a
  // soft-deleted account before the OOBE controller can use it.
  ACCOUNT_IS_DELETED: { code: 'ACCOUNT_IS_DELETED', message: 'Account is removed', statusCode: 404 },
  // errors/loop.ts LOOP_MUST_BE_SUSPENDED, verbatim.
  LOOP_MUST_BE_SUSPENDED: { code: 'LOOP_MUST_BE_SUSPENDED', message: 'Loop must be suspended prior to robot change', statusCode: 409 },
  // Source oobe.ctrl.ts setupRobot raises this when the setup token's account
  // does not own the loop it names. Message mirrors AccountErrors.
  OWNER_CAN_MANIPULATE: {
    code: 'OWNER_CAN_MANIPULATE',
    message: 'Only owner can manipulate loop or members',
    statusCode: 401,
  },
  CREDENTIALS_REQUIRED: { code: 'CREDENTIALS_REQUIRED', message: 'Credentials required', statusCode: 401 },
  AUTHORIZED_UNDER_ADMIN: { code: 'AUTHORIZED_UNDER_ADMIN', message: 'Must be authorized under admin account', statusCode: 401 },
  LOOP_NOT_FOUND: { code: 'LOOP_NOT_FOUND', message: 'Loop does not exist', statusCode: 404 },
  // Source errors/loop.ts LOOP_SUSPENDED: "Loop is suspended and cannot be modified", statusCode 403.
  LOOP_SUSPENDED: { code: 'LOOP_SUSPENDED', message: 'Loop is suspended and cannot be modified', statusCode: 403 },
  ROBOT_NOT_FOUND: { code: 'ROBOT_NOT_FOUND', message: 'Robot not found', statusCode: 404 },
  // errors/loop.ts ROBOT_DISABLED: the robot registry reports the robot suspended.
  ROBOT_DISABLED: { code: 'ROBOT_DISABLED', message: 'Robot disabled', statusCode: 409 },
  ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND: {
    code: 'ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND',
    message: 'Only admin or robot can suspend loop',
    statusCode: 403,
  },
  LOOP_VALIDATION: { code: 'ValidationException', message: 'Invalid payload', statusCode: 422 },
  MEMBER_CAN_REQUEST: {
    code: 'MEMBER_CAN_REQUEST',
    message: 'You can only request members that are in your loops',
    statusCode: 401,
  },
});

/** "<Prefix>.<Operation>" -> { prefix, op } (op matched case-insensitively downstream). */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return { prefix: dot >= 0 ? t.slice(0, dot) : '', op: (dot >= 0 ? t.slice(dot + 1) : t) };
}

function isOobeRequest(req) {
  return /^oobe[^.]*\./i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function oobePayloadLimitError() {
  return {
    statusCode: 400,
    error: 'Bad Request',
    message: `Payload content length greater than maximum allowed: ${OOBE_MAX_PAYLOAD_BYTES}`,
  };
}

function declaredContentLength(req) {
  const header = req?.headers?.['content-length'];
  if (header === undefined || header === null || String(header).trim() === '') return null;
  const length = Number.parseInt(String(header), 10);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

async function readRequestBody(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody.length > OOBE_MAX_PAYLOAD_BYTES
      ? { body: null, error: oobePayloadLimitError() }
      : { body: req.rawBody, error: null };
  }

  // The pinned source gateway authenticates before handing the entity to the
  // Account Hapi parser. Phoenix keeps the raw bytes here for that boundary,
  // but its compatibility face has no separate upstream gateway process. A
  // declared over-limit entity can therefore take the source parser response
  // immediately; absent or forged Content-Length values are checked while the
  // stream is captured. Drain the remainder without retaining it so a rejected
  // keep-alive request cannot leave the connection in an unread state.
  if (declaredContentLength(req) > OOBE_MAX_PAYLOAD_BYTES) {
    req.resume();
    return { body: null, error: oobePayloadLimitError() };
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const length = Buffer.isBuffer(chunk)
      ? chunk.length
      : typeof chunk === 'string' ? Buffer.byteLength(chunk) : Number(chunk?.byteLength || chunk?.length || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > OOBE_MAX_PAYLOAD_BYTES - total) {
      req.resume();
      return { body: null, error: oobePayloadLimitError() };
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    total += length;
  }
  return { body: Buffer.concat(chunks, total), error: null };
}

function parseOobePublicBody(req, rawBody) {
  let entity = Buffer.from(rawBody || '');
  const contentLength = Number.parseInt(String(req?.headers?.['content-length'] || ''), 10);
  if (Number.isInteger(contentLength) && contentLength > OOBE_MAX_PAYLOAD_BYTES) {
    return {
      body: null,
      error: oobePayloadLimitError(),
    };
  }
  const contentEncoding = String(req?.headers?.['content-encoding'] || '');
  if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
    try {
      // Keep the source's post-decompression Hapi limit without allowing a
      // compressed entity to expand past the bounded parser buffer first.
      entity = contentEncoding === 'gzip'
        ? gunzipSync(entity, { maxOutputLength: OOBE_MAX_PAYLOAD_BYTES })
        : inflateSync(entity, { maxOutputLength: OOBE_MAX_PAYLOAD_BYTES });
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
        return { body: null, error: oobePayloadLimitError() };
      }
      return { body: null, error: { statusCode: 400, error: 'Bad Request', message: 'Invalid compressed payload' } };
    }
  }
  if (entity.length > OOBE_MAX_PAYLOAD_BYTES) {
    return {
      body: null,
      error: oobePayloadLimitError(),
    };
  }
  const raw = entity.toString('utf8');
  const contentTypeHeader = String(req?.headers?.['content-type'] || '');
  const contentTypeMatch = contentTypeHeader.trim() === ''
    ? null
    : /^([^/\s]+\/[^\s;]+)(.*)?$/.exec(contentTypeHeader);
  if (contentTypeHeader.trim() !== '' && !contentTypeMatch) {
    return { body: null, error: { statusCode: 400, error: 'Bad Request', message: 'Invalid content-type header' } };
  }
  const contentType = contentTypeMatch ? contentTypeMatch[1].toLowerCase() : 'application/json';
  const isJson = contentTypeHeader === AMZ_JSON
    || /^application\/(?:.+\+)?json$/.test(contentType);
  const isText = /^text\/.+$/.test(contentType);
  const isForm = contentType === 'application/x-www-form-urlencoded';
  const isBinary = contentType === 'application/octet-stream';
  if (!isJson && !isText && !isForm && !isBinary) {
    return { body: null, error: { statusCode: 415, error: 'Unsupported Media Type', message: 'Unsupported Media Type' } };
  }
  if (isBinary) return { body: entity.length ? entity : null };
  if (isForm) return { body: entity.length ? parseQueryString(raw) : {} };
  if (raw.trim() === '') return { body: null };
  try {
    return { body: JSON.parse(raw) };
  } catch (error) {
    // Hapi's text/* path leaves a malformed entity as a string, which is then
    // rejected by the OOBE Joi object validator with status 422. JSON and
    // vendor+json use Hapi's parser and therefore produce status 400.
    if (isText) return { body: raw };
    return { body: null, error: { statusCode: 400, error: 'Bad Request', message: 'Invalid request payload JSON format' } };
  }
}

function sendOobeParserError(res, error) {
  const payload = JSON.stringify({
    statusCode: error.statusCode,
    error: error.error,
    message: error.message,
  });
  res.removeHeader('x-powered-by');
  res.removeHeader('keep-alive');
  res.writeHead(error.statusCode, {
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(payload);
}

function otaBase() {
  const net = process.env.NET_ota || 'localhost:7015';
  return /^https?:\/\//.test(net) ? net : `http://${net}`;
}

/** @param {import('./store.js').Store} store */
export function robotFaceRoutes(store, { settingsProviders = null, loopUpdatedOutbox = new LoopUpdatedOutbox(store), loopConfig = {}, agreementProvider = new EchoSignProvider(loopConfig), invitationProviders, identityProviders, robotReadClient, memberPhotoProvider, stsProvider } = {}) {
  // LoopController snapshots this feature flag at construction; only literal
  // lowercase 'off' disables COPPA, matching the source configuration.
  const coppaEnabled = !loopConfig.features || loopConfig.features.coppa !== 'off';
  // SetupRobot performs asynchronous robot-registry work before consuming its
  // one-time token.  Serialize redemption in this process so two concurrent
  // requests cannot both pass findToken() and create two loops/credentials.
  // The persisted token deletion remains the authoritative one-time check for
  // subsequent requests and for other workers.
  const setupTokensInFlight = new Set();
  // oobe.handler.ts mapping keys (lowercased for the prefix-tolerant match).
  const ops = {
    setuprobot: setupRobotGuarded,
    preparerobot: prepareRobot,
    getstatus: getStatus,
    reconnectrobot: reconnectRobot,
    getservicetoken: getServiceToken,
    createhubtoken: issueHubToken,
  };

  const dispatch = async ({ req, res, body: initialBody, log }) => {
    const { prefix, op } = parseTarget(req);
    let body = initialBody;
    let parserFailure = null;
    // The public OOBE boundary owns the request entity before the downstream
    // Hapi parser. Keep those original bytes available to the source-compatible
    // parser, including when no Content-Type header was sent.
    if (isOobeRequest(req)) {
      const captured = await readRequestBody(req);
      req.rawBody = captured.body;
      if (captured.error) {
        body = null;
        parserFailure = captured.error;
      } else {
        const parsed = parseOobePublicBody(req, req.rawBody);
        body = parsed.body;
        parserFailure = parsed.error;
      }
    }
    // Hapi's binary stream route checks the declared length before dispatch.
    // Its stream output does not impose a cumulative limit on chunked bodies.
    // Account UpdatePhoto uses the same POST /binary maxBytes: 1000000000.
    if ((isMemberPhotoUpload(req) || isAccountPhotoUpload(req)) && Number(req.headers['content-length']) > 1000000000) {
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
      // The old implementation trusted x-amz-credentials.id directly.  A
      // public caller could therefore read or overwrite another account's
      // settings by changing one JSON header.  Settings robot requests are
      // signed just like the other account faces; only the verified account is
      // forwarded to the compatibility dispatcher.
      const caller = settingsCaller(store, req, res, body);
      if (!caller) return;
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
          // Stage every signed raw upload, including one that carries an
          // explicit x-amz-content-sha256.  The staged digest is what proves
          // that header matches the bytes we actually received; skipping this
          // for explicit hashes both rejected valid binary requests and would
          // leave the verifier unable to enforce body integrity.
          if (isMemberPhotoUpload(req) && req.headers.authorization) await stagePhotoDigest(req);
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
      const validated = /^(removememberphoto|setlegalguardian|updateagreementstatus|listmembers|listloopmembers|listloops|list|setenrollment|updatenickname|updatephoneticname|getrobot|findowner|listownerrobots|updateloop|removeloop|clearrobot|updateloopmember)$/i.test(op);
      try { return await loopDispatch({ req, res, body: validated ? body : (body || {}), op, log }); }
      finally { if (req.photoCleanup) await req.photoCleanup(); }
    }

    // Account identity core plus activation/recovery, email/phone/terms, and
    // CreateAccessToken / GetAccountByAccessToken / ResetKeys. CreateHubToken
    // stays on the bounded A-02 SigV4 path below.
    // Unimplemented Account operations keep the existing unknown-target
    // response so Classic still proxies them without a local handler.
    if (/^account/i.test(prefix)) {
      try {
        const identity = await handleAccountIdentity({
          store, req, res, body, log,
          mailProviders: invitationProviders,
          loopConfig,
          identityProviders,
          memberPhotoProvider,
          // Account_20151111.Remove emits LoopUpdated for every loop the
          // removed account belonged to, so the outbox has to reach the
          // identity handler alongside the photo/mail providers.
          loopUpdatedOutbox,
        });
        if (identity !== false) return identity;
      } finally {
        if (req.photoCleanup) await req.photoCleanup();
      }
    }

    // OauthClients_20171108 — admin OAuth-client registry (srv-oauth-clients-ws).
    // Gateway: none of the four targets is anonymous/signed-exempt; the handler is
    // @parseCredentials({adminOnly:true}). Verify the request's AWS V4 signature and
    // present the resolved account as the caller so the adminOnly gate is not a
    // caller-controlled header.
    if (/^oauthclients/i.test(prefix)) {
      const caller = await verifiedClassicCaller(store, req, res, body);
      if (caller === undefined) return; // signature error already sent
      return oauthClientsDispatch(store, { req, res, body, op, caller, log });
    }

    // Lps_20171201 — log-upload credentials (srv-lps-ws). Signed only; the handler
    // requires a robot identity (credentials.friendlyId) or ROBOT_ONLY 403.
    if (/^lps/i.test(prefix)) {
      const caller = await verifiedClassicCaller(store, req, res, body);
      if (caller === undefined) return; // signature error already sent
      return lpsDispatch(store, { req, res, body, op, caller, log, stsProvider });
    }

    if (parserFailure) return void sendOobeParserError(res, parserFailure);
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
    // Source Joi decorators validate the original JSON value, including null,
    // arrays and primitives, before the controller executes. GetServiceToken
    // carries no payload schema and retains the historical object default.
    const sourceValidated = ['createhubtoken', 'setuprobot', 'getstatus', 'preparerobot', 'reconnectrobot']
      .includes(op.toLowerCase());
    const handlerBody = sourceValidated ? body : (body || {});
    return handler({ req, res, body: handlerBody, log });
  };
  // Hapi presents an omitted request payload as null to source-validated
  // handlers. Other legacy robot handlers retain the service's object default.
  dispatch.rawBody = (req) => isMemberPhotoUpload(req) || isAccountPhotoUpload(req);
  dispatch.rawRequest = isOobeRequest;
  dispatch.bodyDefault = (req) => {
    const target = parseTarget(req);
    if (target.op.toLowerCase() === 'createhubtoken') return null;
    if (['setuprobot', 'getstatus', 'preparerobot', 'reconnectrobot'].includes(target.op.toLowerCase())) return null;
    if (/^account/i.test(target.prefix)) return null;
    if (/^settings/i.test(target.prefix)) return null;
    return {};
  };

  return {
    'POST /': dispatch,
  };

  // -- operations -------------------------------------------------------------

  /**
   * oobe.ctrl.ts setupRobot — the robot's one OOBE call: new-robot setup,
   * same-robot re-issue, and suspended-loop robot replacement.
   *
   * Check order (oobe.handler.ts decorators, then oobe.ctrl.ts):
   *   @parseCredentials({})            — SetupRobot is in the gateway's
   *                                      unauthorizedMethods list, so an unsigned
   *                                      request reaches the handler with `{}`.
   *   @validatePayload{id, token}      — required non-empty strings -> 422.
   *   tokenCtrl.findById               — TOKEN_NOT_FOUND / TOKEN_EXPIRED.
   *   accountCtrl.findById             — ACCOUNT_NOT_FOUND / ACCOUNT_IS_DELETED.
   *   loopCtrl.findById (token.loopId) — LOOP_NOT_FOUND (soft-deleted excluded).
   *   !loop.owner.equals(account._id)  — OWNER_CAN_MANIPULATE.
   *   loop.isSuspended                 — replace the robot and unsuspend; else a
   *                                      different robot is LOOP_MUST_BE_SUSPENDED.
   *   getRobot / deleteToken           — ONE-TIME token, RobotCredentials.
   */
  async function setupRobotGuarded(args) {
    const body = args?.body;
    const tokenId = body && typeof body === 'object' && !Array.isArray(body) && typeof body.token === 'string'
      ? body.token
      : null;
    if (!tokenId) return setupRobot(args);
    if (setupTokensInFlight.has(tokenId)) {
      return void sendAmzError(args.res, Errors.TOKEN_NOT_FOUND);
    }
    setupTokensInFlight.add(tokenId);
    try {
      return await setupRobot(args);
    } finally {
      setupTokensInFlight.delete(tokenId);
    }
  }

  async function setupRobot({ res, body, log }) {
    const validationMessage = oobeTokenValidationMessage(body, { requiredId: true });
    if (validationMessage) return void sendValidationError(res, validationMessage);
    const { token: tokenId, id } = body;

    const { token, error } = findToken(store, tokenId);
    if (error) return void sendAmzError(res, Errors[error]);

    const account = store.accounts.get(token.accountId);
    if (!account) return void sendAmzError(res, Errors.ACCOUNT_NOT_FOUND);
    if (account.isDeleted === true) return void sendAmzError(res, Errors.ACCOUNT_IS_DELETED);

    let loop;
    if (token.loopId) {
      // BaseLoopController.findById -> Loop.findById, behind the schema's
      // not-deleted find middleware: a soft-deleted loop is LOOP_NOT_FOUND.
      loop = activeLoopById(token.loopId);
      if (!loop) return void sendAmzError(res, Errors.LOOP_NOT_FOUND);
      // Source oobe.ctrl.ts setupRobot:
      //   if (!loop.owner.equals(account._id)) throw OWNER_CAN_MANIPULATE;
      // Phoenix compares ids as strings rather than ObjectIds.
      if (String(loop.owner) !== String(account._id)) {
        return void sendAmzError(res, Errors.OWNER_CAN_MANIPULATE);
      }
      if (loop.isSuspended) {
        // ROBOT REPLACEMENT. Source order is exact:
        //   newRobotAccount = findOrCreateRobotAccount({ robotId: id })
        //   removeRobotFromLoops(loop.robot)          // old robot -> suspends its loop
        //   removeRobotFromLoops(newRobotAccount._id) // new robot leaves any other loop
        //   loop = findById(tokenObj.loopId)          // reread the committed state
        //   loop.isSuspended = false; loop.robot = newRobotAccount._id
        //   loop.members.push({ accountId, status: ACCEPTED }); loop.save()
        const replacement = findOrCreateRobotAccount(store, id);
        removeRobotFromLoops(store, loop.robot, loopUpdatedOutbox);
        removeRobotFromLoops(store, replacement._id, loopUpdatedOutbox);
        loop = activeLoopById(token.loopId);
        if (!loop) return void sendAmzError(res, Errors.LOOP_NOT_FOUND);
        // Mutate a detached draft: saveLoop must be able to leave the stored
        // object untouched when the LoopUpdated write is rejected.
        const before = JSON.parse(JSON.stringify(loop));
        const draft = JSON.parse(JSON.stringify(loop));
        draft.isSuspended = false;
        draft.robot = replacement._id;
        draft.members = Array.isArray(draft.members) ? draft.members : [];
        // Mongoose applies memberSchema defaults to the pushed
        // `{ accountId, status }`: created, enrolled, invitedAsLegalGuardian and
        // memberProperties.isChild. Keep the persisted subdocument shaped the
        // same way so a reopened Store projects identically.
        draft.members.push({
          _id: newId(),
          accountId: replacement._id,
          status: MEMBER_STATUS.ACCEPTED,
          created: Date.now(),
          invitedAsLegalGuardian: false,
          enrolled: { face: false, voice: false },
          memberProperties: { isChild: false },
        });
        saveLoop(store, draft, loopUpdatedOutbox, before);
        loop = draft;
      } else {
        // Same robot after a reset reconnects its live loop and receives its
        // existing credentials. A different robot needs the loop suspended.
        const currentRobot = store.accounts.get(loop.robot);
        if (!currentRobot) return void sendAmzError(res, Errors.ACCOUNT_NOT_FOUND);
        if (currentRobot.isDeleted === true) return void sendAmzError(res, Errors.ACCOUNT_IS_DELETED);
        if (currentRobot.friendlyId !== id) {
          return void sendAmzError(res, Errors.LOOP_MUST_BE_SUSPENDED);
        }
      }
    } else {
      // Source loop.ctrl.ts create({ ownerId, name, robotId }):
      //   robot = await robotClient.getRobot(robotId)   // failure is tolerated
      //   if (robot.payload.suspended) throw ROBOT_DISABLED
      //   robotAccount = findOrCreateRobotAccount({ robotId })
      //   removeRobotFromLoops(robotAccount._id)        // leave any previous loop
      //   new Loop({ members, name, owner, robot }).save()  -> LoopUpdated
      //   eventSender.send(new LoopCreated({ loopId, ownerId, robotId }))
      let lookup = null;
      try { lookup = await robotReadClient.getRobot(id); } catch { /* Source tolerates lookup failure. */ }
      if (lookup && lookup.payload && lookup.payload.suspended === true) {
        return void sendAmzError(res, Errors.ROBOT_DISABLED);
      }
      const robotAccount = findOrCreateRobotAccount(store, id);
      removeRobotFromLoops(store, robotAccount._id, loopUpdatedOutbox);
      ({ loop } = createLoop(store, { owner: account, robotId: id }));
      loopUpdatedOutbox.record(loop);
      dispatchLoopCreated(loop, invitationProviders);
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
    // Credential= is only an identifier, not proof.  Verify the complete
    // signature before minting a setup token; otherwise anyone who learns an
    // access-key id can mint tokens for that household.
    const account = verifiedClassicCaller(store, req, res, body);
    if (!account) return;
    // @parseCredentials({}) runs before @validatePayload({ loopId: Joi.string() }).
    const validationMessage = oobeLoopIdValidationMessage(body);
    if (validationMessage) return void sendValidationError(res, validationMessage);
    const token = mintSetupToken(store, account._id, (body && body.loopId) || null);
    return void sendAmz(res, 200, { token: token._id, expires: token.created + ACCESS_TOKEN_LIFETIME_MS });
  }

  /** oobe.ctrl.ts getStatus: complete = the token no longer exists/is invalid. */
  function getStatus({ res, body }) {
    const validationMessage = oobeTokenValidationMessage(body);
    if (validationMessage) return void sendValidationError(res, validationMessage);
    const { token } = findToken(store, body.token);
    return void sendAmz(res, 200, { complete: !token });
  }

  /**
   * oobe.ctrl.ts getServiceToken — mints a fresh service-mode owner account and
   * returns a setup token bound to it with loopId null.
   *
   *   public async getServiceToken() {
   *     const postfix = uuid.v4();
   *     const ownerAccount = await this.accountCtrl.create({
   *       email: `${SERVICE_MODE_EMAIL_PREFIX}${postfix}@jibo.com`,
   *       isActive: true,
   *       password: postfix,
   *     });
   *     return await this.tokenCtrl.create({ accountId: ownerAccount._id, loopId: null });
   *   }
   *
   * The handler decorator is `@parseCredentials({ adminOnly: true })` with no
   * @validatePayload, so the body is ignored and a non-admin caller is rejected
   * before any account is created. The gateway lists at srv-security-gw@43a692fe
   * do not contain this target, so an unsigned call never reaches here.
   *
   * Each call creates a NEW account, so tokens are never shared between callers
   * even though mintSetupToken reuses a live token for the same (account, loop)
   * pair — the account differs every time.
   */
  function getServiceToken({ req, res, log }) {
    const caller = verifiedClassicCaller(store, req, res, null);
    if (!caller) return;
    if (!caller || !caller.isAdmin) {
      return void sendAmzError(res, Errors.AUTHORIZED_UNDER_ADMIN);
    }

    const postfix = randomUUID();
    const account = createOwnerAccount(store, {
      email: `${SERVICE_MODE_EMAIL_PREFIX}${postfix}@jibo.com`,
      password: postfix,
    });
    const token = mintSetupToken(store, account._id, null);
    log.info('getServiceToken complete', { account: account._id, token: token._id });
    // tokenCtrl.create returns TokenContainer ({token, expires}), not the token
    // document: the generated client maps only the declared output shape, so a
    // raw `{_id, accountId, loopId, created}` body would leave `token` undefined.
    return void sendAmz(res, 200, { token: token._id, expires: token.created + ACCESS_TOKEN_LIFETIME_MS });
  }

  /**
   * oobe.ctrl.ts reconnectRobot — the factory-reset robot consumes a live
   * portal token. The pinned source controller takes only `token`; it does not
   * inspect loop membership, suspension, or robot identity.
   *
   * The surrounding compatibility face still requires an Authorization
   * Credential, matching the current gateway-facing boundary, then applies the
   * source controller's token validation and one-time deletion.
   */
  function reconnectRobot({ req, res, body, log }) {
    const caller = verifiedClassicCaller(store, req, res, body);
    if (!caller) return;
    // @parseCredentials({}) then @validatePayload({ id: Joi.string(), token: Joi.string().required() }).
    const validationMessage = oobeTokenValidationMessage(body, { optionalId: true });
    if (validationMessage) return void sendValidationError(res, validationMessage);

    // token.ctrl.ts findById: missing -> TOKEN_NOT_FOUND, past TTL -> TOKEN_EXPIRED (no delete).
    const { token, error } = findToken(store, body.token);
    if (error) return void sendAmzError(res, Errors[error]);

    deleteToken(store, token._id); // ONE-TIME
    log.info('reconnectRobot complete', { robot: caller._id });
    return void sendAmz(res, 200, { result: 'Command accepted' });
  }

  /**
   * Account_20151111.CreateHubToken independently verifies AWS V4 at the
   * Account proxy boundary as defence in depth. Public Classic requests have
   * already passed the entrypoint caller boundary; this operation never falls
   * back to a Credential= substring or a public x-amz-credentials assertion.
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
    const agreement = handleLoopAgreements({ store, req, res, body, op, provider: agreementProvider, outbox: loopUpdatedOutbox });
    if (agreement !== false) return agreement;
    const photo = handleMemberPhotos({ store, req, res, body, op, provider: memberPhotoProvider, outbox: loopUpdatedOutbox });
    if (photo !== false) return photo;
    const membership = handleLoopMembership({
      store,
      req,
      res,
      body,
      op,
      log,
      loopUpdatedOutbox,
      coppaEnabled,
      invitationProviders,
      robotReadClient,
    });
    if (membership !== false) return membership;
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
    if (req?._phoenixVerifiedCredentials) return req._phoenixVerifiedCredentials;
    const accessKeyId = accessKeyIdFromAuth(req);
    return accessKeyId ? store.accountByAccessKeyId(accessKeyId) : null;
  }

  function settingsCaller(store, req, res, body) {
    if (req?.headers?.authorization) return verifiedClassicCaller(store, req, res, body);
    // The report-skill is an internal peer rather than an AWS signer.  It may
    // use the explicitly configured shared service token, but the account id
    // still has to resolve to a real account; a caller cannot choose an
    // arbitrary identity with an unsigned header alone.
    const expected = process.env.ETCO_account_internalPeerToken;
    const presented = req?.headers?.['x-phoenix-internal-token'];
    if (!expected || typeof presented !== 'string') {
      return void sendAmzError(res, Errors.CREDENTIALS_REQUIRED);
    }
    const left = Buffer.from(String(expected));
    const right = Buffer.from(presented);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return void sendAmzError(res, Errors.CREDENTIALS_REQUIRED);
    }
    let forwarded;
    try { forwarded = JSON.parse(req.headers['x-amz-credentials'] || 'null'); } catch { forwarded = null; }
    const accountId = forwarded && (forwarded.id || forwarded._id);
    const account = accountId ? store.accounts.get(String(accountId)) : null;
    if (!account || account.isDeleted === true || account.isActive === false) {
      return void sendAmzError(res, Errors.CREDENTIALS_REQUIRED);
    }
    req._phoenixVerifiedCredentials = account;
    return account;
  }

  /**
   * Verify the request's AWS V4 signature and resolve the caller account for
   * the signed-only OAuthClients and LPS faces. Every target in those families
   * is absent from the gateway anonymous/unsigned lists, so a missing or bad
   * signature is a hard rejection; returns undefined after sending the error.
   */
  function verifiedClassicCaller(store, req, res, body) {
    try {
      const verification = verifySigV4({
        method: req.method,
        path: req.originalUrl || req.url || '/',
        headers: req.headers,
        body: req.rawBody === undefined
          ? (body === null || body === undefined ? '' : JSON.stringify(body))
          : req.rawBody,
        resolveCredentials: (accessKeyId) => {
          const account = store.accountByAccessKeyId(accessKeyId);
          return account && account.isDeleted !== true ? account : null;
        },
      });
      req._phoenixVerifiedCredentials = verification.credentials;
      return verification.credentials;
    } catch (error) {
      if (error instanceof SigV4Error && SIGV4_ERRORS[error.code]) {
        sendAmzError(res, SIGV4_ERRORS[error.code]);
        return undefined;
      }
      throw error;
    }
  }

  function activeLoopById(loopId) {
    const loop = store.loops.get(loopId);
    return loop && loop.isDeleted !== true ? loop : null;
  }

  function activeLoopForRobot(robotId) {
    return [...store.loops.values()].find((loop) => loop.isDeleted !== true && loop.robot === robotId) || null;
  }

  /**
   * oobe.handler.ts @validatePayload Joi schemas, in Joi 8 message form. The
   * decorator raises Boom.badData, i.e. Hapi's 422 envelope — not the AWS
   * 400 ValidationException used elsewhere on this legacy compatibility face.
   *   SetupRobot    { id: Joi.string().required(), token: Joi.string().required() }
   *   ReconnectRobot{ id: Joi.string(),            token: Joi.string().required() }
   *   GetStatus     { token: Joi.string().required() }
   *   PrepareRobot  { loopId: Joi.string() }
   */
  function oobeTokenValidationMessage(body, { optionalId = false, requiredId = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
    if (!Object.prototype.hasOwnProperty.call(body, 'token') || body.token === undefined) {
      return 'child "token" fails because ["token" is required]';
    }
    if (typeof body.token !== 'string') return 'child "token" fails because ["token" must be a string]';
    if (body.token.length === 0) return 'child "token" fails because ["token" is not allowed to be empty]';
    const hasId = Object.prototype.hasOwnProperty.call(body, 'id') && body.id !== undefined;
    if (requiredId && !hasId) return 'child "id" fails because ["id" is required]';
    if ((optionalId || requiredId) && hasId) {
      if (typeof body.id !== 'string') return 'child "id" fails because ["id" must be a string]';
      if (body.id.length === 0) return 'child "id" fails because ["id" is not allowed to be empty]';
    }
    return null;
  }

  /** PrepareRobot's own schema: { loopId: Joi.string() } — optional, non-empty. */
  function oobeLoopIdValidationMessage(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
    if (!Object.prototype.hasOwnProperty.call(body, 'loopId') || body.loopId === undefined) return null;
    if (typeof body.loopId !== 'string') return 'child "loopId" fails because ["loopId" must be a string]';
    if (body.loopId.length === 0) return 'child "loopId" fails because ["loopId" is not allowed to be empty]';
    return null;
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
