// `settings` service (Settings_20160801 and Settings_20171219) — the report-skill's user-prefs
// source. Two faces:
//   - AWS-JSON (the report-skill's SettingsClient calls this at NET_settings): GetSettings /
//     UpdateSettings / DeleteSettings / GetDataForSettings, dispatched on POST / by op. The
//     caller identifies the account via `x-amz-credentials: {"id":<accountId>}` (we trust it —
//     LAN, like everything else; no SigV4 verification). Both the legacy Pegasus target and the
//     newer SDK target return the source array shape. Get requests use the source provider graph;
//     unconfigured peers are explicit local storage seams reported by createSettingsProviders.
//   - Portal REST (GET/PUT /api/settings, session-cookie auth): the friendly editor, stored under
//     the logged-in owner's account._id.
//
// Wiring this up is what turns the report-skill's SettingsFailed degradation into a real,
// per-user personal report.

import { createService, sendJson } from '@phoenix/common';
import { getSettingsData, setSettingsData, dataToFriendly, friendlyToData } from './settingsData.js';
import { isAcceptedStatus } from './model.js';
import { getSession } from './sessions.js';
import { createSettingsProviders, isPersonRequestFatal } from './settingsProviders.js';
import { getStore } from './store.js';
import { SETTINGS_PUBLIC_CONTENT_TYPE } from './settingsTransport.js';
import querystring from 'node:querystring';

const AMZ_JSON = 'application/x-amz-json-1.1';
const REPORT_SKILL = 'report-skill';
const DEFAULT_SETTINGS_PREFIX = 'Settings_20171219';
// @jibo/server's registered API route explicitly sets Hapi payload.maxBytes to
// 1000000000; keep the raw compatibility route at that source limit rather than
// inheriting Phoenix common-service's smaller JSON parser default.
const INTERNAL_MAX_BYTES = 1000000000;
const INTERNAL_METHODS = new Set(['getSettings', 'getDataForSettings', 'updateSettings', 'deleteSettings']);

function amz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sourceError(res, status, error, message, code, hapiHeaders = false, corsVary = hapiHeaders) {
  // Hapi serializes ordinary Boom errors as statusCode/error/message, while
  // its generic 500 wrapper puts message first. Preserve both source shapes.
  const payload = status === 500 && error === 'Internal Server Error' && message === 'An internal server error occurred'
    ? { message, statusCode: status, error }
    : { statusCode: status, error, message };
  // Boom keeps an explicitly empty code in its output payload. Preserve that
  // machine-readable field; an absent/undefined code is omitted by JSON.stringify
  // just as it is by the source Hapi response.
  if (code !== undefined) payload.code = code;
  const body = JSON.stringify(payload);
  if (hapiHeaders) {
    res.removeHeader?.('x-powered-by');
    res.removeHeader?.('keep-alive');
  }
  res.writeHead(status, {
    // srv-server replies Boom errors through Hapi, which uses a normal JSON response rather
    // than the AWS error envelope used by the older robot-face handlers.
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: corsVary ? 'origin,accept-encoding' : 'accept-encoding',
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
  });
  res.end(body);
}

function validationError(res, field, detail, hapiHeaders = false) {
  if (field === 'value') {
    sourceError(res, 422, 'Unprocessable Entity', `"value" ${detail}`, undefined, hapiHeaders);
    return;
  }
  sourceError(res, 422, 'Unprocessable Entity', `child "${field}" fails because ["${field}" ${detail}]`, undefined, hapiHeaders);
}

function accountIdFromCreds(req) {
  const raw = req.headers && req.headers['x-amz-credentials'];
  if (raw) {
    try {
      const credentials = JSON.parse(raw);
      if (credentials && typeof credentials.id === 'string' && credentials.id.length) return credentials.id;
    } catch { /* fall through to SigV4 */ }
  }
  // Real clients (the app, the robot) authenticate with SigV4 only and carry no
  // x-amz-credentials header — the gateway used to resolve that to an account id.
  // Read the access key from the Credential scope and let the caller map it via
  // the account store (same seam as key.js keyCallerAccountId and media.js
  // accessKeyAccountResolver). Returns the raw access key when no store is
  // available; callers compare against account ids, so without a store lookup
  // a SigV4-only caller still fails closed (LOOP_MEMBER_ONLY, not a bypass).
  const auth = (req.headers && req.headers.authorization) || '';
  const m = /Credential=([^/,\s]+)\//.exec(auth);
  return m ? m[1] : null;
}

// parseCredentials catches only JSON parsing failures. The handler then reads
// credentials.id directly: null throws, and boxed false/0/empty-string values
// yield undefined. Do not replace parsed falsy values before that access.
function credentialIdFromCreds(req) {
  const raw = req.headers && req.headers['x-amz-credentials'];
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    credentials = {};
  }
  return credentials.id;
}

/**
 * Resolve the Settings caller's account id. The forwarded x-amz-credentials header wins
 * (gateway seam, same as Backup/key/media). Failing that, a SigV4-only caller — the app,
 * the robot — is resolved through the account store: the Credential scope's access key
 * maps to the owning account's _id (same seam as key.js keyCallerAccountId and media.js
 * accessKeyAccountResolver). Without a store the raw access key is returned, which fails
 * closed at the membership check (LOOP_MEMBER_ONLY), never a bypass.
 */
function resolveSettingsCaller(req, store) {
  const direct = accountIdFromCreds(req);
  if (direct) {
    // A forwarded gateway identity is already an account id. A SigV4 Credential
    // scope is a 20-char access key — resolve it through the store instead of
    // comparing it against account ids (which always refused with LOOP_MEMBER_ONLY).
    const looksLikeAccessKey = /^[A-Za-z0-9]{16,40}$/.test(direct);
    if (!looksLikeAccessKey) return direct;
    if (store && typeof store.accountByAccessKeyId === 'function') {
      try {
        const account = store.accountByAccessKeyId(direct);
        if (account) return String(account.id ?? account._id ?? direct);
      } catch { /* fall through to raw key (fails closed) */ }
    }
    return direct;
  }
  return credentialIdFromCreds(req);
}

function validateGetRequest(body, requireSettings) {
  // Hapi/subtext returns text/* entities as strings. Joi 13/14 coerces a JSON
  // object string while leaving request.payload itself untouched, so validate a
  // parsed copy and let the controller continue to receive the original string.
  const value = validationValue(body);
  if (value !== body && value === undefined) return { field: 'value', detail: 'must be an object' };
  body = value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { field: 'value', detail: 'must be an object' };
  if (body.loopId === undefined) return { field: 'loopId', detail: 'is required' };
  if (typeof body.loopId !== 'string') return { field: 'loopId', detail: 'must be a string' };
  if (body.loopId.length === 0) return { field: 'loopId', detail: 'is not allowed to be empty' };
  if (body.transId !== undefined) {
    if (typeof body.transId !== 'string') return { field: 'transId', detail: 'must be a string' };
    if (body.transId.length === 0) return { field: 'transId', detail: 'is not allowed to be empty' };
  }

  // The original GetSettings decorator does not mention settings at all.
  // GetDataForSettings requires only an array with at least one item; Joi has
  // no item schema here, so malformed members reach controller code.
  if (requireSettings) {
    if (body.settings === undefined) return { field: 'settings', detail: 'is required' };
    if (!Array.isArray(body.settings)) return { field: 'settings', detail: 'must be an array' };
    if (body.settings.length < 1) return { field: 'settings', detail: 'must contain at least 1 items' };
  }
  return null;
}

function validationValue(body) {
  if (typeof body !== 'string') return body;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// -- source-shaped provider seam ------------------------------------------------
//
// The recovered SettingsController/GetController operate over Account, Hub, Person and Lasso
// clients. The same traversal below is used in normal service construction; an explicit
// settingsProviders object is only a test seam for replacing the network/storage edges.

function sourceOptions(body) {
  const skills = body.skills && body.skills.length ? body.skills : null;
  const getView = typeof body.getView === 'boolean' ? body.getView : true;
  // Deliberately mirrors readGetSettingsOptionsFromPayload. In particular,
  // truthy values without .map throw here, as they do in the source handler.
  const settings = body.settings
    ? body.settings.map((item) => ({ skillId: item.skillId, view: item.view }))
    : null;
  return { getView, settings, skills };
}

function fixOauthParamsInView(view) {
  // Accessing .type is intentional: null/undefined views produce the same
  // source TypeError and are converted by the wrapper into a generic 500.
  if (view.type === 'oauth') {
    const key = view.valueDefinition.key;
    if (view.oauthParams) {
      if (!view.oauthParams.serviceName) throw new Error(`Missing serviceName in ${key} oauthParams`);
      if (!view.oauthParams.serviceAccountName) throw new Error(`Missing serviceAccountName in ${key} oauthParams`);
      if (!view.oauthParams.scopes) throw new Error(`Missing scopes in ${key} oauthParams`);
    } else {
      if (!view.serviceName) throw new Error(`Missing serviceName in ${key} view`);
      if (!view.serviceAccountName) throw new Error(`Missing serviceAccountName in ${key} view`);
      if (!view.scopes) throw new Error(`Missing scopes in ${key} view`);
      view.oauthParams = {
        serviceName: view.serviceName,
        serviceAccountName: view.serviceAccountName,
        scopes: view.scopes,
        authorizationUri: view.authorizationUri,
        iosClientId: view.iosClientId,
        serverClientId: view.serverClientId,
        iosCallbackUri: view.iosCallbackUri,
      };
    }
  }
  if (view.hasOwnProperty('childViews')) {
    view.childViews.forEach((childView) => fixOauthParamsInView(childView));
  }
}

function collectSourceNodes(skillId, view, parentView, result) {
  if (view.hasOwnProperty('valueDefinition')) {
    const node = {
      skillId,
      key: view.valueDefinition.key,
      dataService: view.valueDefinition.target,
      view: { type: view.type },
    };
    if (typeof view.valueDefinition.default !== 'undefined') node.defaultValue = view.valueDefinition.default;
    if (view.type === 'oauth') {
      node.view.oauthParams = view.oauthParams;
      if (parentView && parentView.type === 'connectable') {
        node.view.connectableParentKey = parentView.valueDefinition.key;
      }
    }
    result.push(node);
  }
  if (view.hasOwnProperty('childViews')) {
    view.childViews.forEach((childView) => collectSourceNodes(skillId, childView, view, result));
  }
}

// Node 8 (the pinned source runtime) reports null/undefined property access as
// `Cannot read property 'key' of null/undefined`; newer V8 says `Cannot read
// properties of ...`. Keep the source diagnostic when a peer returns a malformed
// nullish map, while leaving normal property access untouched.
function sourcePropertyValue(properties, key) {
  if (properties === null) throw new Error(`Cannot read property '${key}' of null`);
  if (properties === undefined) throw new Error(`Cannot read property '${key}' of undefined`);
  return properties[key];
}

function sourceDataNodes(configs) {
  configs.forEach((config) => fixOauthParamsInView(config.view));
  const nodes = [];
  configs.forEach((config) => collectSourceNodes(config.skillId, config.view, null, nodes));
  return nodes;
}

function sourceErrorInfo(error) {
  const payload = error && error.output && error.output.payload;
  const source = payload || error || {};
  const status = error && error.isBoom && Number.isInteger(source.statusCode)
    ? source.statusCode
    : error && error.isBoom && Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const hasSourceCode = Object.prototype.hasOwnProperty.call(source, 'code');
  const hasErrorCode = Boolean(error && Object.prototype.hasOwnProperty.call(error, 'code'));
  // A provider Boom may carry a meaningful machine code in its output even
  // when the HTTP status is 500 (for example HUB_DOWN). Preserve that code.
  // Transport errors can retain a low-level `error.code` such as
  // ECONNREFUSED on the Error object, but the source Hapi envelope does not
  // expose that implementation detail when the Boom output has no code.
  // @jibo/server wraps ordinary errors in a new generic Boom response. Their
  // own diagnostic code never becomes part of that public output payload.
  const code = !(error && error.isBoom) ? undefined
    : hasSourceCode ? source.code
    : payload ? undefined
      : hasErrorCode ? error.code : undefined;
  const message = source.message || (error && error.message) || 'An internal server error occurred';
  const errorName = status !== 500 && source.error ? source.error
    : status === 403 ? 'Forbidden'
    : status === 422 ? 'Unprocessable Entity'
      : status === 404 ? 'Not Found'
        : 'Internal Server Error';
  return { status, code, message, errorName };
}

function sourceJson(res, status, value) {
  const body = JSON.stringify(value);
  res.removeHeader?.('x-powered-by');
  res.removeHeader?.('keep-alive');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: 'origin,accept-encoding',
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
  });
  res.end(body);
}

function applyInternalCors(res, req) {
  const origin = req?.headers?.origin;
  if (!origin) return;
  // @jibo/server's connection-level CORS defaults are origin:* with the two
  // standard exposed headers. Hapi echoes a present origin rather than sending
  // '*', including on Boom/error responses.
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-expose-headers', 'WWW-Authenticate,Server-Authorization');
}

async function getWithProviders({ req, body, providers, store = null }) {
  const context = {
    loopId: body.loopId,
    transactionId: body.transId,
    userId: resolveSettingsCaller(req, store),
  };
  const options = sourceOptions(body);
  // The handler builds options before entering SettingsController, so a
  // truthy malformed GetSettings.settings value fails before membership.
  await providers.account.checkUserBelongsToLoop(context);
  let settings = options.settings || (await providers.hub.getSkillConfigs(context)).map((item) => ({
    skillId: item.id,
    view: item.settings.view,
  }));
  if (options.skills) settings = settings.filter((item) => options.skills.indexOf(item.skillId) > -1);

  const nodes = sourceDataNodes(settings);
  const nodesByService = {};
  nodes.forEach((node) => {
    nodesByService[node.dataService] = nodesByService[node.dataService] || [];
    nodesByService[node.dataService].push(node);
  });
  const results = {};
  const errors = {};
  settings.forEach((config) => {
    results[config.skillId] = {};
    errors[config.skillId] = {};
  });

  const serviceIDs = Object.keys(nodesByService);
  // Source GetController starts every data-service request with Promise.all. Preserve that
  // concurrency and let per-service failures be projected onto only that service's nodes.
  await Promise.all(serviceIDs.map(async (serviceID) => {
    if (!['lasso', 'loop', 'person'].includes(serviceID)) {
      const error = new Error(`Unknown data service: ${serviceID}`);
      error.statusCode = 422;
      error.code = 'UNKNOWN_DATA_SERVICE';
      error.isBoom = true;
      throw error;
    }
    const serviceNodes = nodesByService[serviceID];
    try {
      if (serviceID === 'person' || serviceID === 'loop') {
        const method = serviceID === 'person' ? 'getAccountProperties' : 'getLoopProperties';
        const properties = await providers.person[method](context, serviceNodes.map((node) => node.key));
        serviceNodes.forEach((node) => {
          if (node.view.type === 'connectable') return;
          const value = sourcePropertyValue(properties, node.key);
          results[node.skillId][node.key] = value;
          if (typeof value === 'undefined' && typeof node.defaultValue !== 'undefined') {
            results[node.skillId][node.key] = { value: node.defaultValue };
          }
        });
      } else {
        await Promise.all(serviceNodes.map(async (node) => {
          if (node.view.type !== 'oauth') return;
          const params = {
            scopes: node.view.oauthParams.scopes,
            serviceAccountName: node.view.oauthParams.serviceAccountName,
            serviceName: node.view.oauthParams.serviceName,
            skillId: node.skillId,
          };
          try {
            const credential = await providers.lasso.getCredential(context, params);
            results[node.skillId][node.key] = credential;
            if (node.view.connectableParentKey) {
              const parent = results[node.skillId][node.view.connectableParentKey];
              if (!(parent && parent.value === true)) {
                results[node.skillId][node.view.connectableParentKey] = {
                  value: Boolean(credential && credential.credentialExists),
                };
              }
            }
          } catch (error) {
            errors[node.skillId][node.key] = { message: `lasso request error: ${error.message}` };
          }
        }));
      }
    } catch (error) {
      // Source Wreck/Boom raises incomplete response and invalid status
      // assertions from its response callback. Hapi's request domain turns
      // those into one generic request 500; do not project them onto each
      // Person key as an ordinary provider error. Valid provider statuses keep
      // the per-service/per-key error behavior below.
      if (isPersonRequestFatal(error)) throw error;
      serviceNodes.forEach((node) => {
        errors[node.skillId][node.key] = { message: `${serviceID} request error: ${error.message}` };
      });
    }
  }));

  return settings.map((config) => {
    const result = { skillId: config.skillId, view: config.view, data: results[config.skillId], errors: errors[config.skillId] };
    if (!Object.keys(result.errors).length) delete result.errors;
    return result;
  }).map((result) => {
    if (options.getView === false) delete result.view;
    return result;
  });
}

function dispatchWithProviders(res, req, body, providers, store = null) {
  return getWithProviders({ req, body, providers, store })
    .then((result) => sourceJson(res, 200, result))
    .catch((error) => {
      const info = sourceErrorInfo(error);
      if (info.status === 500) {
        sourceError(res, 500, 'Internal Server Error', 'An internal server error occurred', info.code, true);
      } else {
        sourceError(res, info.status, info.errorName, info.message, info.code, true);
      }
    });
}

/**
 * AWS-JSON dispatch for the Settings_* prefix — called from robotFace's POST / router.
 * @returns true if it handled the op (so the caller stops), false to fall through.
 */
export function settingsAwsDispatch(store, {
  req, res, body, op, prefix = DEFAULT_SETTINGS_PREFIX, log, providers = null,
}) {
  const accountId = accountIdFromCreds(req);
  const effectiveProviders = providers || createSettingsProviders({ store });
  switch (op.toLowerCase()) {
    case 'getsettings': {
      const validation = validateGetRequest(body, false);
      if (validation) {
        validationError(res, validation.field, validation.detail, true);
        return true;
      }
      void prefix;
      return dispatchWithProviders(res, req, body, effectiveProviders, store);
    }
    case 'getdataforsettings': {
      const validation = validateGetRequest(body, true);
      if (validation) {
        validationError(res, validation.field, validation.detail, true);
        return true;
      }
      return dispatchWithProviders(res, req, body, effectiveProviders, store);
    }
    case 'updatesettings': {
      if (!accountId) { amz(res, 401, { __type: 'CREDENTIALS_REQUIRED', message: 'x-amz-credentials required' }); return true; }
      // body.data may be the wire shape directly, or [{skillId,data}]. Accept both.
      const incoming = Array.isArray(body.data)
        ? (body.data.find((s) => s.skillId === REPORT_SKILL) || {}).data
        : body.data;
      const data = setSettingsData(store, accountId, incoming || getSettingsData(store, accountId));
      amz(res, 200, { data: [{ skillId: REPORT_SKILL, data }] });
      return true;
    }
    case 'deletesettings': {
      if (accountId) { store.settings.delete(accountId); store.flush(); }
      amz(res, 200, { data: [] });
      return true;
    }
    default:
      log?.warn?.('unknown Settings operation', { op });
      amz(res, 400, { __type: 'ValidationException', message: `unknown Settings operation: ${op}` });
      return true;
  }
}

/**
 * Settings' actual internal listener boundary.
 *
 * The account robot face intentionally remains an AWS-JSON compatibility endpoint. The
 * source Settings server is a separate Hapi listener: its peer clients send ordinary
 * JSON, while an unadapted public AWS-JSON request is rejected by Hapi before the
 * handler. Keep that check here, at the Settings listener boundary, rather than making
 * the aggregate account service reject its robot-facing content type.
 */
export function settingsInternalDispatch(store, {
  req, res, body, op, prefix = DEFAULT_SETTINGS_PREFIX, log, providers = null,
}) {
  applyInternalCors(res, req);
  const methodName = sourceSettingsMethod(op);
  if (methodName === null) {
    if (!op) {
      sourceError(res, 500, 'Internal Server Error', 'An internal server error occurred', undefined, true);
    } else {
      sourceError(res, 404, 'Not Found', `Method ${op[0].toLowerCase()}${op.slice(1)} not found.`, undefined, true);
    }
    return true;
  }
  if (isPublicSettingsContentType(req)) {
    sourceError(res, 415, 'Unsupported Media Type', 'Unsupported Media Type', undefined, true);
    return true;
  }
  if (methodName === 'updateSettings' || methodName === 'deleteSettings') {
    const validation = validateMutationRequest(body);
    if (validation) {
      validationError(res, validation.field, validation.detail, true);
      return true;
    }
    const effectiveProviders = providers || createSettingsProviders({ store });
    return dispatchMutationWithProviders(res, req, body, effectiveProviders, methodName);
  }
  return settingsAwsDispatch(store, { req, res, body, op: methodName, prefix, log, providers });
}

/**
 * Build the standalone POST / route used by the internal Settings service.
 *
 * This route is raw so the Settings listener can reproduce the source Hapi boundary:
 * `text/plain` is still parsed by the source handler, ordinary JSON reaches the
 * decorators, malformed JSON gets Hapi's 400 response, and the AWS JSON content type
 * gets a 415 before provider dispatch. It is not added to createAccountService's
 * robot-facing routes; callers must select this service explicitly.
 */
export function settingsInternalRoutes(store, { providers = null } = {}) {
  const dispatch = async ({ req, res, log }) => {
    const target = parseSettingsTarget(req);
    if (target.op === undefined || target.op === '') {
      // The original Server.lowerMethodName indexes methodName[0]. Missing or
      // empty operation therefore reaches its generic 500 wrapper before Hapi
      // consumes/parses the payload.
      req.resume?.();
      sourceError(res, 500, 'Internal Server Error', 'An internal server error occurred', undefined, true, false);
      return true;
    }
    if (sourceSettingsMethod(target.op) === null) {
      req.resume?.();
      const methodName = `${target.op[0].toLowerCase()}${target.op.slice(1)}`;
      sourceError(res, 404, 'Not Found', `Method ${methodName} not found.`, undefined, true, false);
      return true;
    }

    applyInternalCors(res, req);
    try {
      const body = await readInternalPayload(req);
      return settingsInternalDispatch(store, {
        req, res, body, op: target.op, prefix: target.prefix, log, providers,
      });
    } catch (error) {
      if (error.code === 'UNSUPPORTED_MEDIA_TYPE') {
        sourceError(res, 415, 'Unsupported Media Type', 'Unsupported Media Type', undefined, true);
      } else if (error.code === 'INVALID_CONTENT_TYPE') {
        sourceError(res, 400, 'Bad Request', error.message, undefined, true);
      } else if (error.code === 'PAYLOAD_TOO_LARGE') {
        sourceError(res, 400, 'Bad Request', error.message, undefined, true);
      } else {
        sourceError(res, 400, 'Bad Request', 'Invalid request payload JSON format', undefined, true);
      }
      return true;
    }
  };
  dispatch.rawBody = true;
  dispatch.bodyDefault = () => null;
  return { 'POST /': dispatch };
}

/**
 * Construct the explicitly selected internal Settings service. Public AWS requests must
 * enter through a separately authenticated gateway adapter; this service does not expose
 * a public authentication fallback.
 */
export function createSettingsInternalService({ store = getStore(), settingsProviders } = {}) {
  const providers = settingsProviders === undefined
    ? createSettingsProviders({ store }) : settingsProviders;
  return createService({
    name: 'settings',
    routes: settingsInternalRoutes(store, { providers }),
  });
}

// -- source-shaped UpdateSettings/DeleteSettings -----------------------------
//
// The robot-facing AWS-JSON compatibility route retains its historical envelope and
// store adapter.  The internal Settings listener, however, exposes the srv-settings-ws
// handler contract: membership and Hub are consulted first, then the controller routes
// each requested data node to Person or Lasso and returns { data: ... }.  Keep this path
// separate so an internal peer request cannot silently change the public robot face.

function sourceBoom(statusCode, message, code) {
  const error = new Error(message);
  error.isBoom = true;
  error.statusCode = statusCode;
  error.output = {
    payload: {
      statusCode,
      error: statusCode === 403 ? 'Forbidden' : statusCode === 422 ? 'Unprocessable Entity' : 'Error',
      message,
      ...(code ? { code } : {}),
    },
  };
  return error;
}

function validateMutationRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { field: 'value', detail: 'must be an object' };
  if (body.data === undefined) return { field: 'data', detail: 'is required' };
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return { field: 'data', detail: 'must be an object' };
  }
  if (body.loopId === undefined) return { field: 'loopId', detail: 'is required' };
  if (typeof body.loopId !== 'string') return { field: 'loopId', detail: 'must be a string' };
  if (body.loopId.length === 0) return { field: 'loopId', detail: 'is not allowed to be empty' };
  if (body.transId !== undefined) {
    if (typeof body.transId !== 'string') return { field: 'transId', detail: 'must be a string' };
    if (body.transId.length === 0) return { field: 'transId', detail: 'is not allowed to be empty' };
  }
  return null;
}

function sourceMutationConfig(configs) {
  const settings = configs.map((item) => ({ skillId: item.id, view: item.settings.view }));
  const nodes = sourceDataNodes(settings);
  const dataNodes = {};
  nodes.forEach((node) => { dataNodes[node.key] = node; });
  return dataNodes;
}

function validateSourceDataNode(node, value) {
  if (typeof value !== 'object') throw new Error(`Invalid value in "${node.key}": must be an object`);
  if (node.view.type === 'oauth') {
    if (value === null) throw new TypeError(`Cannot read property 'serviceName' of null`);
    if (!value.serviceName) throw new Error(`Missing serviceName in "${node.key}"`);
    if (!value.serviceAccountName) throw new Error(`Missing serviceAccountName in "${node.key}"`);
    if (!value.authCode) throw new Error(`Missing authCode in "${node.key}"`);
    if (!value.scopes) throw new Error(`Missing scopes in "${node.key}"`);
    if (!value.clientId) value.clientId = node.view.oauthParams.iosClientId;
    if (!value.redirectUri && value.clientId === node.view.oauthParams.iosClientId) {
      value.redirectUri = node.view.oauthParams.iosCallbackUri;
    }
    return;
  }
  if (node.view.type === 'switch' || node.view.type === 'toggle') {
    if (value === null) throw new TypeError(`Cannot read property 'value' of null`);
    if (value.value === 1) value.value = true;
    if (value.value === 0) value.value = false;
    if (typeof value.value !== 'boolean') {
      throw new Error(`Value in "${node.key}" must be in format {"value": boolean}`);
    }
  }
}

function sourceMutationContext(req, body) {
  return {
    loopId: body.loopId,
    transactionId: body.transId,
    userId: credentialIdFromCreds(req),
  };
}

async function sourceSkillConfigs(context, providers) {
  const configs = await providers.hub.getSkillConfigs(context);
  return { configs, dataNodes: sourceMutationConfig(configs) };
}

// Keep missing injected peer methods source-visible. The original controller calls its
// `this.clients` object directly, so a missing seam reports that object path in the
// TypeError. Phoenix's provider graph has a different local variable name; translate the
// failure at the call boundary instead of rewriting error output after the operation.
function sourceProviderCall(client, method, sourcePath, args) {
  if (!client || typeof client[method] !== 'function') {
    throw new TypeError(`this.clients.${sourcePath} is not a function`);
  }
  return client[method](...args);
}

async function updateWithProviders({ req, body, providers }) {
  const context = sourceMutationContext(req, body);
  await providers.account.checkUserBelongsToLoop(context);
  const { dataNodes } = await sourceSkillConfigs(context, providers);
  const requestData = body.data;
  const results = {};
  const connectableValues = {};
  const errors = {};
  const dataByService = {};

  Object.keys(requestData).forEach((key) => {
    const item = requestData[key];
    const serviceName = item && item.dataService;
    if (dataNodes[key]) {
      validateSourceDataNode(dataNodes[key], item.value);
      dataByService[serviceName] = dataByService[serviceName] || {};
      dataByService[serviceName][key] = item;
    } else {
      results[key] = undefined;
      errors[key] = { message: `Property ${key} is not found in ${item && item.skillId} manifest` };
    }
  });

  const services = {
    person: async (data) => {
      const keys = Object.keys(data);
      await Promise.all(keys.map((key) => sourceProviderCall(
        providers.person, 'setAccountProperty', 'person.setAccountProperty',
        [context, key, data[key].value],
      )));
      Object.assign(results, await sourceProviderCall(
        providers.person, 'getAccountProperties', 'person.getAccountProperties', [context, keys],
      ));
    },
    loop: async (data) => {
      const keys = Object.keys(data);
      await Promise.all(keys.map((key) => sourceProviderCall(
        providers.person, 'setLoopProperty', 'person.setLoopProperty',
        [context, key, data[key].value],
      )));
      Object.assign(results, await sourceProviderCall(
        providers.person, 'getLoopProperties', 'person.getLoopProperties', [context, keys],
      ));
    },
    lasso: async (data) => {
      await Promise.all(Object.keys(data).map(async (key) => {
        const node = dataNodes[key];
        if (!node || node.view.type !== 'oauth') return;
        const value = data[key].value;
        const credential = {
          skillId: data[key].skillId,
          serviceName: value.serviceName,
          serviceAccountName: value.serviceAccountName,
          scopes: value.scopes,
          clientId: value.clientId,
          authCode: value.authCode,
          redirectUri: value.redirectUri,
        };
        try {
          await providers.lasso.createUpdateCredential(context, credential);
        } catch (error) {
          errors[key] = { message: error.message };
        }
        // The transpiled source continuation yields once after the create/update
        // await, allowing already-ready Person/loop service continuations to start
        // their reads before Lasso's read begins. Preserve that scheduling boundary
        // as an execution rule; provider call traces remain observable evidence.
        await Promise.resolve();
        results[key] = await sourceProviderCall(
          providers.lasso, 'getCredential', 'lasso.getCredential', [context, credential],
        );
        if (node.view.connectableParentKey) {
          const current = results[node.view.connectableParentKey];
          if (!(current && current.value === true)) {
            connectableValues[node.view.connectableParentKey] = {
              value: Boolean(results[key] && results[key].credentialExists),
            };
          }
        }
      }));
    },
  };

  await Promise.all(Object.keys(dataByService).map(async (serviceID) => {
    if (!services[serviceID]) throw sourceBoom(422, `Unknown data service: ${serviceID}`, 'UNKNOWN_DATA_SERVICE');
    await services[serviceID](dataByService[serviceID]);
  }));

  const result = { data: {} };
  Object.keys(requestData).forEach((key) => {
    const item = requestData[key] || dataNodes[key];
    result.data[key] = {
      skillId: item.skillId,
      dataService: item.dataService,
      value: results[key],
    };
    if (errors[key]) result.data[key].error = errors[key];
    if (typeof result.data[key].value === 'undefined') delete result.data[key].value;
  });
  Object.keys(connectableValues).forEach((key) => {
    result.data[key] = {
      skillId: dataNodes[key].skillId,
      dataService: dataNodes[key].dataService,
      value: connectableValues[key],
    };
  });
  return result;
}

function wildcardKeyRegExp(wildcardKey) {
  const pieces = wildcardKey.split(':').map((piece) => piece === '*' ? '([a-zA-Z-]+?)' : piece);
  if (pieces.length !== 3) throw new Error(`Invalid key: ${wildcardKey}`);
  return new RegExp(`^${pieces.join(':')}$`);
}

async function deleteWithProviders({ req, body, providers }) {
  const context = sourceMutationContext(req, body);
  await providers.account.checkUserBelongsToLoop(context);
  const { dataNodes } = await sourceSkillConfigs(context, providers);
  const requestData = body.data;
  const results = {};
  const errors = {};
  const dataByService = {};
  Object.keys(requestData).forEach((key) => {
    // The original controller dereferences each request item while grouping. A null
    // item therefore reaches the generic internal-error boundary before service
    // dispatch; retaining the direct access is part of the wire contract.
    const serviceName = requestData[key].dataService;
    dataByService[serviceName] = dataByService[serviceName] || {};
    dataByService[serviceName][key] = requestData[key];
  });

  const deleteLassoCredential = async (key, skillId, oauthParams) => {
    const params = {
      skillId,
      serviceAccountName: oauthParams.serviceAccountName,
      serviceName: oauthParams.serviceName,
      scopes: oauthParams.scopes,
    };
    try {
      await sourceProviderCall(
        providers.lasso, 'deleteCredential', 'lasso.deleteCredential', [context, params],
      );
      results[key] = { deleted: true };
    } catch (error) {
      errors[key] = { message: error.message };
      results[key] = { deleted: false };
    }
  };
  const deleteAll = async (wildcardKey, skillId) => {
    const regexp = wildcardKeyRegExp(wildcardKey);
    const foundKeys = Object.keys(dataNodes).filter((key) => regexp.test(key)
      && dataNodes[key].skillId === skillId && dataNodes[key].dataService === 'lasso');
    try {
      if (foundKeys.length === 0) throw new Error(`Properties matching ${wildcardKey} are not found in skill manifests`);
      await Promise.all(foundKeys.map((key) => deleteLassoCredential(key, dataNodes[key].skillId, dataNodes[key].view.oauthParams)));
      results[wildcardKey] = { deleted: true };
    } catch (error) {
      results[wildcardKey] = { deleted: false };
      errors[wildcardKey] = { message: error.message };
    }
  };

  await Promise.all(Object.keys(dataByService).map(async (serviceID) => {
    if (serviceID !== 'lasso') {
      throw sourceBoom(422, `Remove operation for ${serviceID} is not supported`, 'REMOVE_FOR_TARGET_NOT_SUPPORTED');
    }
    await Promise.all(Object.keys(dataByService[serviceID]).map((key) => {
      const item = dataByService[serviceID][key];
      if (item && item.oauthParams) return deleteLassoCredential(key, item.skillId, item.oauthParams);
      if (dataNodes[key]) return deleteLassoCredential(dataNodes[key].key, dataNodes[key].skillId, dataNodes[key].view.oauthParams);
      if (key.indexOf('*') > -1) return deleteAll(key, item && item.skillId);
      errors[key] = { message: `${key} is not found in skill manifests` };
      return undefined;
    }));
  }));

  const result = { data: {} };
  Object.keys(requestData).forEach((key) => {
    const item = requestData[key];
    result.data[key] = {
      skillId: item.skillId,
      dataService: item.dataService,
      deleted: Boolean(results[key] && results[key].deleted),
    };
    if (errors[key]) result.data[key].error = errors[key];
  });
  return result;
}

function dispatchMutationWithProviders(res, req, body, providers, operation) {
  const action = operation === 'updateSettings' ? updateWithProviders : deleteWithProviders;
  return action({ req, body, providers })
    .then((result) => sourceJson(res, 200, result))
    .catch((error) => {
      const info = sourceErrorInfo(error);
      if (info.status === 500) {
        sourceError(res, 500, 'Internal Server Error', 'An internal server error occurred', info.code, true);
      } else {
        sourceError(res, info.status, info.errorName, info.message, info.code, true);
      }
    });
}

function parseSettingsTarget(req) {
  const target = String(req?.headers?.['x-amz-target'] || '');
  const parts = target.split('.');
  return { prefix: parts[0], op: parts[1] };
}

function sourceSettingsMethod(operation) {
  if (typeof operation !== 'string' || operation.length === 0) return null;
  const methodName = `${operation[0].toLowerCase()}${operation.slice(1)}`;
  return INTERNAL_METHODS.has(methodName) ? methodName : null;
}

function contentType(req) {
  const header = req?.headers?.['content-type'];
  if (!header) return 'application/json';
  const match = /^([^\/\s]+\/[^\s;]+)(?:.*)?$/.exec(String(header));
  if (!match) {
    const error = new Error('Invalid content-type header');
    error.code = 'INVALID_CONTENT_TYPE';
    throw error;
  }
  return match[1].toLowerCase();
}

function isPublicSettingsContentType(req) {
  try {
    return contentType(req) === SETTINGS_PUBLIC_CONTENT_TYPE;
  } catch {
    return false;
  }
}

function readInternalPayload(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    const declared = Number(req?.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > INTERNAL_MAX_BYTES) {
      const error = new Error(`Payload content length greater than maximum allowed: ${INTERNAL_MAX_BYTES}`);
      error.code = 'PAYLOAD_TOO_LARGE';
      fail(error);
      req.resume?.();
      return;
    }
    req.on('data', (chunk) => {
      if (failed) return;
      const part = Buffer.from(chunk);
      bytes += part.length;
      if (bytes > INTERNAL_MAX_BYTES) {
        const error = new Error(`Payload content length greater than maximum allowed: ${INTERNAL_MAX_BYTES}`);
        error.code = 'PAYLOAD_TOO_LARGE';
        fail(error);
        req.resume?.();
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const raw = Buffer.concat(chunks);
        const type = contentType(req);
        if (type === SETTINGS_PUBLIC_CONTENT_TYPE) {
          const error = new Error('Unsupported Media Type');
          error.code = 'UNSUPPORTED_MEDIA_TYPE';
          throw error;
        }
        if (type.startsWith('text/')) return resolve(raw.toString('utf8'));
        if (type === 'application/octet-stream') return resolve(raw.length ? raw : null);
        if (type === 'application/x-www-form-urlencoded') {
          return resolve(raw.length ? querystring.parse(raw.toString('utf8')) : {});
        }
        if (!/^application\/(?:.+\+)?json$/.test(type)) {
          const error = new Error('Unsupported Media Type');
          error.code = 'UNSUPPORTED_MEDIA_TYPE';
          throw error;
        }
        return resolve(raw.length ? JSON.parse(raw.toString('utf8')) : null);
      } catch (error) {
        fail(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Internal Settings peer routes matching the original Account client. They deliberately return
 * only the source client fields; callers still apply SettingsController's LOOP_MEMBER_ONLY and
 * LOOP_NOT_FOUND handling at the Settings boundary.
 */
export function settingsPeerRoutes(store) {
  return {
    'GET /isLoopMember': ({ url }) => {
      const accountId = url.searchParams.get('accountId');
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      const result = Boolean(loop && accountId && Array.isArray(loop.members)
        && loop.members.some((item) => item.accountId === accountId && isAcceptedStatus(item.status)));
      return { result };
    },
    'GET /loopPopulated': ({ url, res }) => {
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      const robot = loop ? store.accounts.get(loop.robot) : null;
      if (!loop || !robot) return sendJson(res, 404, { message: 'Loop not found' });
      return { id: loop._id, robotFriendlyId: robot.friendlyId || undefined };
    },
  };
}

/** Portal REST: the friendly settings editor (session-cookie auth, keyed by the owner's _id). */
export function settingsPortalRoutes(store) {
  const owner = (req) => {
    const s = getSession(store, req);
    return (s && s.kind === 'user') ? store.accounts.get(s.accountId) : null;
  };
  return {
    'GET /api/settings': ({ req, res }) => {
      const account = owner(req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      return { accountId: account._id, settings: dataToFriendly(getSettingsData(store, account._id)) };
    },
    'PUT /api/settings': ({ req, res, body }) => {
      const account = owner(req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const data = friendlyToData(body || {}, getSettingsData(store, account._id));
      setSettingsData(store, account._id, data);
      return { accountId: account._id, settings: dataToFriendly(data) };
    },
  };
}
