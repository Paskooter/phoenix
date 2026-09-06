// Source-compatible Settings provider graph.
//
// The original srv-settings-ws constructs Account, Hub, Person and Lasso clients from
// registry entries. Phoenix has those peers at different maturity levels, so the default
// graph selects a Phoenix HTTP client when its NET_* peer is configured and otherwise uses
// the account store/data store seams explicitly. The Settings controller remains the one
// implementation of validation, view traversal and error projection in both cases.

import { AssertionError } from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import { parse as legacyUrlParse, resolve as legacyUrlResolve } from 'node:url';
import { logger } from '@phoenix/common';

import { getSettingsData, setSettingsData } from './settingsData.js';

const REPORT_SKILL = 'report-skill';
const PERSON_JSON_MIME = /^application\/(?:[a-z0-9.]*[+-]json|json)$/i;
const personHttpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const personHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity });
const personLog = logger('account.person');
const PERSON_BOOM_STATUS_CODES = Object.freeze({
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Moved Temporarily',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Time-out',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Request Entity Too Large',
  414: 'Request-URI Too Large',
  415: 'Unsupported Media Type',
  416: 'Requested Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Unordered Collection',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Time-out',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
});

function personRequestTimeout() {
  return process.env.ETCO_server_http_timeout || 60000;
}

function personRedirectLimit() {
  return process.env.ETCO_server_http_maxredirects || 3;
}

function personError(message, options = {}) {
  const error = new Error(message);
  if (options.isBoom) error.isBoom = true;
  if (options.statusCode !== undefined) {
    error.output = {
      statusCode: options.statusCode,
      payload: { statusCode: options.statusCode, message },
    };
  }
  return error;
}

function personBoomReformat() {
  this.output.payload.statusCode = this.output.statusCode;
  this.output.payload.error = PERSON_BOOM_STATUS_CODES[this.output.statusCode] || 'Unknown';
  if (this.output.statusCode === 500) this.output.payload.message = 'An internal server error occurred';
  else if (this.message) this.output.payload.message = this.message;
}

function personInitializeBadGateway(error, message) {
  error.isBoom = true;
  error.isServer = true;
  if (!Object.prototype.hasOwnProperty.call(error, 'data')) error.data = null;
  error.output = {
    statusCode: 502,
    payload: {},
    headers: {},
  };
  error.reformat = personBoomReformat;
  if (!message && !error.message) {
    error.reformat();
    message = error.output.payload.error;
  }
  if (message) error.message = `${message}${error.message ? `: ${error.message}` : ''}`;
  error.reformat();
  return error;
}

function personBoomTypeof(message, data) {
  if (data instanceof Error && !data.isBoom) return personInitializeBadGateway(data, message);
  return personBadGateway(message, data);
}

function personGatewayTimeoutFactory(message, data) {
  return personGatewayTimeout(message, data);
}

function personGatewayTimeout(message, data) {
  const error = personError(message, { isBoom: true });
  error.isServer = true;
  error.data = data;
  error.output = {
    statusCode: 504,
    payload: {
      statusCode: 504,
      error: 'Gateway Time-out',
      message,
    },
    headers: {},
  };
  error.reformat = personBoomReformat;
  error.typeof = personGatewayTimeoutFactory;
  return error;
}

function personLogHttpError(uri, marker, error, trace) {
  personLog.error(`Error during HTTP request to URI:${uri}, Marker:${marker}`, {
    marker,
    error: {
      code: error && error.code,
      message: error && error.message,
      trace,
    },
  });
}

function personBadGateway(message, data) {
  const error = new Error(message || undefined);
  error.data = data;
  error.typeof = personBoomTypeof;
  return personInitializeBadGateway(error);
}

function personBadGatewayFromError(message, cause, trace) {
  cause.trace = trace;
  return personInitializeBadGateway(cause, message);
}

function personBadImplementation(error) {
  // Boom.badImplementation(responseError) wraps the original Error, keeping
  // its name/message while adding the standard 500 output fields.
  if (!Object.prototype.hasOwnProperty.call(error, 'data')) error.data = undefined;
  error.isBoom = true;
  error.isServer = true;
  error.isDeveloperError = true;
  error.output = {
    statusCode: 500,
    payload: {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An internal server error occurred',
    },
    headers: {},
  };
  return error;
}

function personProviderError(message, statusCode, code) {
  const error = personError(message, { isBoom: true });
  error.isServer = statusCode >= 500;
  const outputMessage = statusCode === 500 ? 'An internal server error occurred' : message;
  error.data = { code };
  error.output = {
    statusCode,
    payload: {
      statusCode,
      error: http.STATUS_CODES[statusCode] || 'Unknown',
      message: outputMessage,
      code,
    },
    headers: {},
  };
  return error;
}

function personHeaderValue(value) {
  // Both pinned Node 8 and the candidate's built-in HTTP client write
  // Latin-1 header values as their single-byte wire representation. Keep the
  // JSON string intact so an ID such as U+00E9 follows that source path.
  return value;
}

function personResponseValue(response, chunks) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return null;
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!PERSON_JSON_MIME.test(contentType)) return buffer;
  try {
    return JSON.parse(buffer.toString());
  } catch (error) {
    error.isBoom = true;
    throw error;
  }
}

function personLegacyHostnamePrefix(hostname) {
  for (let index = 0; index < hostname.length; index += 1) {
    const code = hostname.charCodeAt(index);
    const valid = (code >= 97 && code <= 122)
      || code === 46
      || (code >= 65 && code <= 90)
      || (code >= 48 && code <= 57)
      || code === 45
      || code === 43
      || code === 95
      || code > 127;
    if (!valid) return index;
  }
  return -1;
}

// Node 8's legacy url.parse accepted malformed bracket authorities and let
// http.request produce the eventual DNS error. Node 22's legacy parser throws
// before that point, so retain the old parser's bounded authority/path result
// only for this source-observable malformed-authority shape.
function personLegacyMalformedAuthority(raw) {
  const match = /^([a-z0-9.+-]+:)(\/\/)([^/?#]*)(.*)$/i.exec(raw);
  if (!match || !match[3].includes('[') || match[3].includes(']')) return null;
  const authority = match[3];
  const portMatch = /:[0-9]*$/.exec(authority);
  let host = authority;
  let port = null;
  if (portMatch) {
    if (portMatch[0] !== ':') port = portMatch[0].slice(1);
    host = host.slice(0, -portMatch[0].length);
  }
  const invalidIndex = personLegacyHostnamePrefix(host);
  if (invalidIndex === -1) return null;
  const hostname = host.slice(0, invalidIndex);
  const pathname = `/${host.slice(invalidIndex)}${match[4]}`;
  const formatted = `${match[1].toLowerCase()}//${hostname}${port ? `:${port}` : ''}${pathname}`;
  return legacyUrlParse(formatted);
}

function personLegacyUrl(raw) {
  try {
    return legacyUrlParse(raw);
  } catch (error) {
    const fallback = personLegacyMalformedAuthority(raw);
    if (fallback) return fallback;
    throw error;
  }
}

function personRequest(base, method, operation, context, payload, redirectsLeft, snapshot, deadline, trace) {
  if (redirectsLeft === undefined) redirectsLeft = personRedirectLimit();
  if (deadline === undefined) {
    // Wreck installs one timeout on the initial request.  Redirects reuse its
    // callback and options, so the same timer stays alive until the final
    // response headers arrive; the body read starts after that timer is
    // cleared.  Keep that lifecycle explicit instead of giving every hop a
    // fresh timer.
    deadline = { at: Date.now() + Number(personRequestTimeout()), started: false, timer: null };
  }
  if (trace === undefined) trace = [];
  return new Promise((resolve, reject) => {
    let url;
    let body;
    let headers;
    let client;
    let agent;
    try {
      url = personLegacyUrl(base);
      if (snapshot) {
        body = snapshot.body;
        headers = snapshot.headers;
      } else {
        body = JSON.stringify(payload);
        headers = {
          'x-amz-credentials': personHeaderValue(JSON.stringify({ id: context.userId })),
          'x-amz-target': `Person_20160801.${operation}`,
          'content-length': Buffer.byteLength(body),
        };
      }
      client = url.protocol === 'https:' ? https : http;
      agent = url.protocol === 'https:' ? personHttpsAgent : personHttpAgent;
      trace.push({ method, url: base });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timeoutId;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve(value);
    };
    let request;
    try {
      request = client.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.path || undefined,
        method,
        headers,
        agent,
        host: url.host || undefined,
      }, (response) => {
        const redirect = [301, 302, 307, 308].includes(response.statusCode);
        // Wreck clears the initial request timer when the final response
        // headers arrive. It does not reset that wall-clock budget for a
        // redirect hop, and the body read happens after this point.
        if (!redirect && deadline.timer !== null) {
          clearTimeout(deadline.timer);
          deadline.timer = null;
        }
        if (redirect) {
          const location = response.headers.location;
          response.resume();
          if (!location || redirectsLeft === 0) {
            finish(personBadGateway(location ? 'Maximum redirections reached' : 'Received redirection without location', trace));
            return;
          }
          const redirectUrl = /^https?:/i.test(location)
            ? location
            : legacyUrlResolve(url.href, location);
          personRequest(redirectUrl, method, operation, context, payload, redirectsLeft - 1, { body, headers }, deadline, trace)
            .then((value) => finish(null, value), (error) => finish(error));
          return;
        }
        const chunks = [];
        let responseFinished = false;
        const premature = () => {
          if (!responseFinished && !response.complete) {
            finish(personError('Payload stream closed prematurely', { isBoom: true }));
          }
        };
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', (error) => finish(personError(error.message, { isBoom: true })));
        response.once('aborted', premature);
        response.once('close', premature);
        response.once('end', () => {
          responseFinished = true;
          try {
            const value = personResponseValue(response, chunks);
            if (value && value.error) {
              // BaseClient/Boom.createWithCode has no own statusCode or code;
              // it stores those values in output/data. A missing statusCode
              // crashes the pinned Boom implementation; keep this process safe
              // while retaining the provider error as an explicit divergence.
              const error = value.statusCode === undefined
                ? personError(value.message, { isBoom: true })
                : personProviderError(value.message, value.statusCode, value.code);
              finish(error);
              return;
            }
            finish(null, value);
          } catch (error) {
            finish(personBadImplementation(error));
          }
        });
      });
      if (!deadline.started) {
        deadline.started = true;
        const remaining = Math.max(0, deadline.at - Date.now());
        deadline.timer = setTimeout(() => {
          request.destroy();
          const marker = Date.now();
          const timeoutError = personGatewayTimeout('Client request timeout');
          personLogHttpError(trace[0]?.url || base, marker, timeoutError, trace);
          finish(timeoutError);
        }, remaining);
        timeoutId = deadline.timer;
      }
      request.once('error', (error) => {
        if (settled) return;
        const marker = Date.now();
        personLogHttpError(trace[0]?.url || base, marker, error, trace);
        if (error.code === 'ECONNRESET') {
          finish(personGatewayTimeout(`Gateway Time-out. Log marker:${marker}`));
          return;
        }
        finish(personBadGatewayFromError('Client request error', error, trace));
      });
      request.write(body);
      request.end();
    } catch (error) {
      finish(error);
    }
  });
}

const LASSO_JSON_MIME = /^application\/(?:[a-z0-9.]*[+-]json|json)$/i;
const lassoHttpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const lassoHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity });

function lassoRequestTimeout() {
  const configured = process.env.ETCO_server_http_timeout;
  if (!configured) return 60000;
  // Wreck passes the environment string to setTimeout, which coerces numeric
  // strings and clamps zero/invalid values to its minimum timer delay. The
  // native Node request API requires a finite number instead.
  const timeout = Number(configured);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 1;
}

function lassoRedirectLimit() {
  // Preserve Wreck's raw environment value. Its redirect counter uses a
  // strict numeric zero check, so the string "0" follows one redirect and
  // decrements to -1; this is observable with finite redirect chains and can
  // recurse without a bound for a looping peer.
  return process.env.ETCO_server_http_maxredirects || 3;
}

function baseUrl(raw) {
  if (!raw) return null;
  const value = /^https?:\/\//i.test(String(raw)) ? String(raw) : `http://${raw}`;
  return value.endsWith('/') ? value : `${value}/`;
}

function configuredPeer(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value) return baseUrl(value);
  }
  return null;
}

function providerError(message, statusCode = 503, code = 'SETTINGS_PROVIDER_UNAVAILABLE') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  // BaseClient/Wreck failures are ordinary errors. Only the explicit Account membership
  // rejection below is source Boom.badRequest-shaped; the Server wrapper converts peer
  // transport failures to its generic 500 response.
  error.isBoom = false;
  return error;
}

async function readResponse(response, peer, url) {
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  if (!response.ok) {
    const message = value && typeof value === 'object' && value.message
      ? value.message
      : typeof value === 'string' && value ? value : `${peer} responded ${response.status}`;
    const error = providerError(message, response.status, value && value.code);
    error.peer = peer;
    throw error;
  }
  return value;
}

async function requestJson(fetchImpl, peer, base, path, options = {}) {
  if (!base) throw providerError(`${peer} service is not configured (set a NET_* peer)`, 503);
  const url = new URL(path, base);
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return readResponse(response, peer, url.toString());
}

function sourceLoopMemberError() {
  const error = providerError('Only loop member can query loop properties', 403, 'LOOP_MEMBER_ONLY');
  error.isBoom = true;
  return error;
}

function transactionHeaders(context) {
  return context.transactionId === undefined ? {} : { 'X-JIBO-transID': context.transactionId };
}

function lassoHeaders(context) {
  // srv-settings-ws/@jibo/server's BaseClient always supplies both headers. In
  // particular, retaining an undefined transaction value lets Node reject the
  // request before a peer sees it, which is the source behavior for a malformed
  // Settings context.
  return {
    'Content-Type': 'application/json',
    'X-JIBO-transID': context.transactionId,
  };
}

function sourceAssert(condition, message) {
  if (condition) return;
  const error = new AssertionError({ actual: condition, expected: true, operator: '==', message });
  // Node 8's assert module includes the error code in the observable name.
  // Keep this translation local to the source assertion boundary.
  error.name = 'AssertionError [ERR_ASSERTION]';
  // Node 22 adds this diagnostic field; the pinned Node 8 AssertionError does
  // not expose it on the wire.
  delete error.diff;
  throw error;
}

function parseLassoResponse(response) {
  if (Buffer.isBuffer(response)) throw new Error(response.toString());
  if (typeof response === 'object') return response;
  throw new Error(`Lasso response was: ${JSON.stringify(response)}`);
}

function lassoResponsePayload(response, chunks) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return null;
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!LASSO_JSON_MIME.test(contentType)) return buffer;
  return JSON.parse(buffer.toString());
}

function clearLassoTimeout(timeoutState) {
  if (!timeoutState || timeoutState.timer === null) return;
  clearTimeout(timeoutState.timer);
  timeoutState.timer = null;
}

function lassoRequest(base, method, path, context, payload, redirectsLeft, headerSnapshot, bodySnapshot, timeoutState) {
  if (redirectsLeft === undefined) redirectsLeft = lassoRedirectLimit();
  const rootRequest = timeoutState === undefined;
  const requestState = timeoutState || {
    timeoutMs: lassoRequestTimeout(),
    timer: null,
    activeRequests: new Set(),
  };
  const url = new URL(path, base);
  // BaseClient serializes requestPayload before entering Wreck. Wreck then
  // carries that serialized options.payload through redirects; re-running
  // JSON.stringify(payload) here would observe mutations between hops and
  // diverge from the source POST wire body.
  const body = bodySnapshot === undefined
    ? payload === undefined ? null : JSON.stringify(payload)
    : bodySnapshot;
  const headers = headerSnapshot || lassoHeaders(context);
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = Buffer.byteLength(body);
  }
  const client = url.protocol === 'https:' ? https : http;
  const agent = url.protocol === 'https:' ? lassoHttpsAgent : lassoHttpAgent;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) clearLassoTimeout(requestState);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = () => {
      const error = new Error('Client request timeout');
      finish(error);
      // Wreck's timeout belongs to the original request object. Redirect
      // requests are created without that timeout and continue to run after
      // the public promise has rejected; their later responses can therefore
      // produce observable follow-up requests. Aborting every active request
      // here suppresses that source-visible post-settlement sequence.
      if (request && !request.destroyed) request.destroy(error);
    };
    let request;
    try {
      request = client.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
      }, (response) => {
        const redirect = [301, 302, 307, 308].includes(response.statusCode);
        // BaseClient/Wreck clears its request timer when final response
        // headers arrive; Wreck.read then has no body timeout. Disable the
        // shared wall-clock timer at the same boundary.
        if (!redirect) clearLassoTimeout(requestState);
        if (redirect) {
          const location = response.headers.location;
          if (!location || redirectsLeft === 0) {
            response.resume();
            finish(new Error(location ? 'Maximum redirections reached' : 'Received redirection without location'));
            return;
          }
          response.resume();
          let redirectUrl;
          try {
            redirectUrl = new URL(location, url);
          } catch (error) {
            // The source legacy URL resolver leaves malformed locations inside
            // the normal Wreck failure path. Keep the async request settled so
            // the operation wrapper can expose its source-generic error rather
            // than leaking a Node 22 uncaught ERR_INVALID_URL.
            finish(error);
            return;
          }
          lassoRequest(redirectUrl.href, method, '', context, payload, redirectsLeft - 1, headers, body, requestState)
            .then((value) => finish(null, value), (error) => finish(error));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', (error) => finish(error));
        response.once('aborted', () => finish(new Error('Payload stream closed prematurely')));
        response.once('close', () => {
          if (!response.complete) finish(new Error('Payload stream closed prematurely'));
        });
        response.once('end', () => {
          try {
            const value = lassoResponsePayload(response, chunks);
            // BaseClient rejects a decoded payload carrying an error field,
            // irrespective of the HTTP status. The operation wrapper below
            // supplies the source's public error message.
            if (value && value.error) {
              const error = new Error(value.message || 'Lasso returned an error');
              error.code = value.code;
              error.statusCode = value.statusCode;
              finish(error);
              return;
            }
            finish(null, value);
          } catch (error) {
            finish(error);
          }
        });
      });
      requestState.activeRequests.add(request);
      request.once('close', () => requestState.activeRequests.delete(request));
      request.once('error', (error) => finish(error));
      if (rootRequest) requestState.timer = setTimeout(timeout, requestState.timeoutMs);
      if (body !== null) request.write(body);
      request.end();
    } catch (error) {
      finish(error);
    }
  });
}

function checkLassoRequiredProperties(data, requestType) {
  sourceAssert(data.skillId, `Missing skillId in lasso credentials ${requestType} request`);
  sourceAssert(data.serviceName, `Missing serviceName in lasso credentials ${requestType} request`);
  sourceAssert(data.serviceAccountName, `Missing serviceAccountName in lasso credentials ${requestType} request`);
  sourceAssert(data.scopes, `Missing scopes in lasso credentials ${requestType} request`);
}

function localAccount(store) {
  return {
    async checkUserBelongsToLoop(context) {
      const loop = context.loopId && store.loops.get(context.loopId);
      const member = loop && context.userId && Array.isArray(loop.members)
        && loop.members.some((item) => item.accountId === context.userId && item.status === 'ACCEPTED');
      if (!member) throw sourceLoopMemberError();
    },
    async getFriendlyId(context) {
      const loop = context.loopId && store.loops.get(context.loopId);
      const robot = loop && store.accounts.get(loop.robot);
      if (!robot || !robot.friendlyId) throw providerError(`Loop ${context.loopId} has no robot`, 404, 'LOOP_NOT_FOUND');
      return robot.friendlyId;
    },
  };
}

function localView(data) {
  const childViews = Object.entries(data || {}).map(([key, value]) => {
    if (value && Object.prototype.hasOwnProperty.call(value, 'credentialExists')) {
      const parts = key.split(':');
      return {
        type: 'oauth',
        valueDefinition: { target: 'lasso', key },
        oauthParams: {
          serviceName: parts[0] || 'unknown',
          serviceAccountName: parts[1] || 'default',
          scopes: parts.slice(2).filter(Boolean),
        },
      };
    }
    return { type: 'switch', valueDefinition: { target: 'person', key } };
  });
  return { type: 'group', childViews };
}

function localHub(store, account) {
  return {
    async getSkillConfigs(context) {
      // Keep the source Hub -> Account friendly-id dependency even when the
      // manifest itself is served by the bounded local storage adapter.
      await account.getFriendlyId(context);
      const data = getSettingsData(store, context.userId);
      return [{ id: REPORT_SKILL, settings: { view: localView(data) } }];
    },
  };
}

function localPerson(store) {
  // Person's LoopProperty model is keyed by loopId + key. The account ID only
  // records who last changed the property; it is not part of the lookup key.
  const loopRecordKey = (context) => `loop:${context.loopId}`;
  const readLoopData = (context) => {
    const record = store.settings.get(loopRecordKey(context));
    return (record && record.data) || {};
  };
  const writeLoopData = (context, data) => {
    store.settings.set(loopRecordKey(context), { _id: loopRecordKey(context), data, updated: Date.now() });
    store.flush();
  };
  return {
    async getAccountProperties(context, keys) {
      const data = getSettingsData(store, context.userId);
      return Object.fromEntries(keys.map((key) => [key, data[key]]).filter(([, value]) => value !== undefined));
    },
    async getLoopProperties(context, keys) {
      const data = readLoopData(context);
      return Object.fromEntries(keys.map((key) => [key, data[key]]).filter(([, value]) => value !== undefined));
    },
    async setAccountProperty(context, key, value) {
      const data = { ...getSettingsData(store, context.userId), [key]: value };
      setSettingsData(store, context.userId, data);
    },
    async setLoopProperty(context, key, value) {
      const data = { ...readLoopData(context), [key]: value };
      writeLoopData(context, data);
    },
  };
}

function lassoRecordKey(context) {
  return `lasso:${context.userId}`;
}

function normalizedScopes(scopes) {
  // Lasso queries scopes as Mongo `$all`, so order and repeated values do not
  // identify a different credential. Keep a deterministic set in new local
  // keys while retaining the original tuple values when reading old records.
  return [...new Set(Array.isArray(scopes) ? scopes : [])].sort();
}

function lassoCredentialKey(params) {
  // Lasso's unique Mongo index is accountId + skillId + serviceName +
  // serviceAccountName + scopes. Keep the full logical tuple in the local seam;
  // JSON avoids collisions when a scope itself contains ':' (for example an OAuth
  // URL), and canonical scope ordering follows Lasso's unordered `$all` lookup.
  return JSON.stringify([
    params.skillId,
    params.serviceName,
    params.serviceAccountName,
    normalizedScopes(params.scopes),
  ]);
}

function parseLassoCredentialKey(key) {
  if (typeof key !== 'string' || key[0] !== '[') return null;
  try {
    const tuple = JSON.parse(key);
    if (!Array.isArray(tuple) || tuple.length !== 4 || !Array.isArray(tuple[3])) return null;
    if (tuple.slice(0, 3).some((part) => typeof part !== 'string')) return null;
    if (tuple[3].some((scope) => typeof scope !== 'string')) return null;
    return {
      skillId: tuple[0],
      serviceName: tuple[1],
      serviceAccountName: tuple[2],
      scopes: tuple[3],
    };
  } catch (_error) {
    return null;
  }
}

function lassoScopesContain(storedScopes, requestedScopes) {
  const stored = Array.isArray(storedScopes) ? storedScopes : [];
  const requested = Array.isArray(requestedScopes) ? requestedScopes : [];
  return requested.every((scope) => stored.includes(scope));
}

function validateLassoScopes(scopes) {
  if (!Array.isArray(scopes)) throw new Error('Scopes should be an array');
  if (!scopes.length) throw new Error('Scopes should be not empty array');
  if (!scopes.every((scope) => typeof scope === 'string')) throw new Error('Scopes should be strings');
}

function lassoScalarMatches(stored, query, allowWildcards = false) {
  return ['skillId', 'serviceName', 'serviceAccountName'].every((field) => (
    (allowWildcards && query[field] === '*') || stored[field] === query[field]
  ));
}

function lassoEntries(store, context) {
  const data = readLassoData(store, context);
  return Object.entries(data).flatMap(([key, value]) => {
    const identity = parseLassoCredentialKey(key);
    return identity ? [{ key, identity, value }] : [];
  });
}

function lassoQueryMatches(entry, params) {
  return lassoScalarMatches(entry.identity, params)
    && lassoScopesContain(entry.identity.scopes, params.scopes);
}

function lassoDeleteMatches(entry, params) {
  const scopeFilter = !Array.isArray(params.scopes) || params.scopes.length === 0
    || params.scopes[0] === '*'
    || lassoScopesContain(entry.identity.scopes, params.scopes);
  return lassoScalarMatches(entry.identity, params, true) && scopeFilter;
}

function legacyWireSafe(params) {
  // The old report wire key is service:account:scope[:scope]. It cannot encode
  // a colon-containing component injectively. Dedicated JSON records remain the
  // authoritative path for those values; only unambiguous legacy markers may
  // be read or written as a compatibility fallback.
  return [params.serviceName, params.serviceAccountName, ...(params.scopes || [])]
    .every((value) => typeof value === 'string' && !value.includes(':'));
}

function lassoWireKey(params) {
  return `${params.serviceName}:${params.serviceAccountName}:${(params.scopes || []).join(':')}`;
}

function readLassoData(store, context) {
  const record = store.settings.get(lassoRecordKey(context));
  return (record && record.data) || {};
}

function writeLassoData(store, context, data) {
  store.settings.set(lassoRecordKey(context), {
    _id: lassoRecordKey(context),
    data,
    updated: Date.now(),
  });
  store.flush();
}

function writeReportWireMarker(store, context, params, marker) {
  // Keep the existing report-skill wire representation for the portal and
  // legacy AWS view. The authoritative local Lasso identity remains the
  // skill-aware record above.
  if (params.skillId !== REPORT_SKILL || !legacyWireSafe(params)) return;
  const data = { ...getSettingsData(store, context.userId), [lassoWireKey(params)]: marker };
  setSettingsData(store, context.userId, data);
}

function deleteOtherReportCredentials(store, context, credential) {
  // Lasso's saveCredential keeps only one provider for a report calendar slot.
  // The source query deliberately omits scopes, so every active credential for
  // the same account/skill/calendar slot and another service is removed.
  if (!['workCalendar', 'personalCalendar'].includes(credential.serviceAccountName)) return;
  const data = { ...readLassoData(store, context) };
  for (const entry of lassoEntries(store, context)) {
    if (entry.identity.skillId !== REPORT_SKILL
      || entry.identity.serviceAccountName !== credential.serviceAccountName
      || entry.identity.serviceName === credential.serviceName
      || !entry.value || entry.value.credentialExists !== true) continue;
    data[entry.key] = { credentialExists: false };
  }
  writeLassoData(store, context, data);

  // Preserve the old report marker's observable false state when its safe,
  // delimiter-free representation can identify the replaced service.
  const settings = { ...getSettingsData(store, context.userId) };
  for (const [key, value] of Object.entries(settings)) {
    if (!value || value.credentialExists !== true) continue;
    const parts = key.split(':');
    if (parts.length < 3 || parts[1] !== credential.serviceAccountName || parts[0] === credential.serviceName) continue;
    settings[key] = { credentialExists: false };
  }
  setSettingsData(store, context.userId, settings);
}

function localLasso(store) {
  return {
    async getCredential(context, params) {
      validateLassoScopes(params.scopes);
      const entries = lassoEntries(store, context).filter((entry) => lassoQueryMatches(entry, params));
      const active = entries.filter((entry) => entry.value && entry.value.credentialExists === true);
      // Source Credentials.find returns one record only when exactly one Mongo
      // credential satisfies the scalar identity and requested-scope subset.
      // More than one result is treated as no credential by checkCredentialExists.
      if (active.length === 1) return active[0].value;
      if (entries.length > 0) return { credentialExists: false };
      // Read records created by the pre-repair local seam for report-skill while
      // the skill-aware store is being introduced.
      if (params.skillId === REPORT_SKILL && legacyWireSafe(params)) {
        const legacy = getSettingsData(store, context.userId)[lassoWireKey(params)];
        if (legacy && Object.prototype.hasOwnProperty.call(legacy, 'credentialExists')) return legacy;
      }
      return { credentialExists: false };
    },
    async createUpdateCredential(context, credential) {
      validateLassoScopes(credential.scopes);
      const entries = lassoEntries(store, context).filter((entry) => lassoQueryMatches(entry, credential));
      // Lasso saveCredential first finds an existing credential with the same
      // scalar identity and requested scope subset, preserving its stored scope
      // set when the request uses a different order or fewer scopes.
      // DELETE leaves a local false marker so the legacy settings view can
      // report credentialExists:false, but the source Lasso document is
      // physically removed. Never reactivate a tombstone as an existing
      // credential during a later subset/permutation update.
      const activeEntries = entries.filter((entry) => entry.value && entry.value.credentialExists === true);
      const existing = activeEntries.length === 1 ? activeEntries[0] : null;
      const key = existing ? existing.key : lassoCredentialKey(credential);
      const data = { ...readLassoData(store, context), [key]: { credentialExists: true } };
      writeLassoData(store, context, data);
      writeReportWireMarker(store, context, credential, { credentialExists: true });
      deleteOtherReportCredentials(store, context, credential);
    },
    async deleteCredential(context, params) {
      const data = { ...readLassoData(store, context) };
      const entries = lassoEntries(store, context).filter((entry) => lassoDeleteMatches(entry, params));
      if (entries.length > 0) {
        // The source DELETE uses the same requested-scope subset relation and
        // removes every matching record. A false marker preserves the existing
        // local settings persistence shape while making subsequent GETs false.
        for (const entry of entries) data[entry.key] = { credentialExists: false };
      } else {
        data[lassoCredentialKey(params)] = { credentialExists: false };
      }
      writeLassoData(store, context, data);
      writeReportWireMarker(store, context, params, { credentialExists: false });
    },
  };
}

function networkAccount(fetchImpl, base) {
  return {
    async checkUserBelongsToLoop(context) {
      const url = new URL('isLoopMember', base);
      url.searchParams.set('accountId', context.userId);
      url.searchParams.set('loopId', context.loopId);
      const response = await requestJson(fetchImpl, 'Account', base, `${url.pathname}${url.search}`);
      if (!response || !response.result) throw sourceLoopMemberError();
    },
    async getFriendlyId(context) {
      const url = new URL('loopPopulated', base);
      url.searchParams.set('loopId', context.loopId);
      const response = await requestJson(fetchImpl, 'Account', base, `${url.pathname}${url.search}`);
      if (!response || !response.robotFriendlyId) throw providerError(`Loop ${context.loopId} has no robot`, 404, 'LOOP_NOT_FOUND');
      return response.robotFriendlyId;
    },
  };
}

function networkHub(fetchImpl, base, account) {
  return {
    async getSkillConfigs(context) {
      const robotFriendlyId = await account.getFriendlyId(context);
      const path = `/v1/skills/settings/${encodeURIComponent(robotFriendlyId)}`;
      const response = await requestJson(fetchImpl, 'Hub', base, path, {
        headers: transactionHeaders(context),
      });
      // The source Hub client returns response.skills directly; the Settings
      // controller owns the subsequent `.map` failure for malformed replies.
      return response && response.skills;
    },
  };
}

function networkPerson(_fetchImpl, base) {
  return {
    getAccountProperties: (context, keys) => personRequest(base, 'POST', 'GetAccountProperties', context, { keys }),
    getLoopProperties: (context, keys) => personRequest(base, 'POST', 'GetLoopProperties', context, {
      keys,
      loopId: context.loopId,
    }),
    setAccountProperty: (context, key, value) => personRequest(base, 'POST', 'SetAccountProperty', context, { key, value }),
    setLoopProperty: (context, key, value) => personRequest(base, 'POST', 'SetLoopProperty', context, {
      loopId: context.loopId,
      transId: context.transactionId,
      key,
      value,
    }),
  };
}

function networkLasso(_fetchImpl, base) {
  return {
    async getCredential(context, params) {
      checkLassoRequiredProperties(params, 'get');
      const url = new URL('/v1/credential', base);
      url.searchParams.set('accountId', context.userId);
      url.searchParams.set('skillId', params.skillId);
      url.searchParams.set('serviceName', params.serviceName);
      url.searchParams.set('serviceAccountName', params.serviceAccountName);
      params.scopes.forEach((scope, index) => url.searchParams.set(`scopes[${index}]`, scope));
      try {
        const response = parseLassoResponse(await lassoRequest(
          base, 'GET', `${url.pathname}${url.search}`, context,
        ));
        // Match Lasso.getCredential: parseLassoResponse, assert non-empty, assert
        // credentialExists, then wrap every failure in its operation-specific error.
        if (!response) throw new Error('Lasso returned an empty response');
        if (!response.hasOwnProperty('credentialExists')) {
          throw new Error('Lasso returned invalid response: credentialExists is missing');
        }
        return response;
      } catch (_error) {
        throw new Error(`Failed to get ${params.serviceName} ${params.serviceAccountName} credentials`);
      }
    },
    async createUpdateCredential(context, credential) {
      checkLassoRequiredProperties(credential, 'save');
      sourceAssert(credential.authCode, 'Missing authCode in lasso value');
      const payload = {
        skillId: credential.skillId,
        accountId: context.userId,
        serviceName: credential.serviceName,
        serviceAccountName: credential.serviceAccountName,
        scopes: credential.scopes,
        authCode: credential.authCode,
      };
      if (credential.clientId) payload.clientId = credential.clientId;
      if (credential.redirectUri) payload.redirectUri = credential.redirectUri;
      try {
        return parseLassoResponse(await lassoRequest(base, 'POST', '/v1/credential', context, payload));
      } catch (_error) {
        throw new Error(`Failed to connect ${credential.serviceName} ${credential.serviceAccountName}`);
      }
    },
    async deleteCredential(context, params) {
      checkLassoRequiredProperties(params, 'delete');
      const url = new URL('/v1/credential', base);
      url.searchParams.set('accountId', context.userId);
      url.searchParams.set('skillId', params.skillId);
      url.searchParams.set('serviceName', params.serviceName);
      url.searchParams.set('serviceAccountName', params.serviceAccountName);
      params.scopes.forEach((scope, index) => url.searchParams.set(`scopes[${index}]`, scope));
      try {
        parseLassoResponse(await lassoRequest(
          base, 'DELETE', `${url.pathname}${url.search}`, context,
        ));
      } catch (_error) {
        throw new Error(`Failed to disconnect ${params.serviceName} ${params.serviceAccountName}`);
      }
    },
  };
}

/**
 * Build the production provider graph. `settingsProviders` remains an explicit injection
 * seam for tests; normal service construction always runs through this graph.
 */
export function createSettingsProviders({ store, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Settings providers require a fetch implementation');
  const accountBase = configuredPeer(env, ['NET_settings_account', 'NET_account']);
  const hubBase = configuredPeer(env, ['NET_settings_hub', 'NET_hub']);
  // NET_classic is the Classic front door, not the original Person boundary. Do not
  // silently send Person's AWS-JSON request to it: require an explicit Person peer
  // alias until the Classic registry route is proven equivalent.
  const personBase = configuredPeer(env, ['NET_settings_person', 'NET_person']);
  const dataBase = configuredPeer(env, ['NET_settings_lasso', 'NET_lasso', 'NET_data']);
  const account = accountBase ? networkAccount(fetchImpl, accountBase) : localAccount(store);
  return {
    account,
    hub: hubBase ? networkHub(fetchImpl, hubBase, account) : localHub(store, account),
    person: personBase ? networkPerson(fetchImpl, personBase) : localPerson(store),
    lasso: dataBase ? networkLasso(fetchImpl, dataBase) : localLasso(store),
    configuration: {
      account: accountBase ? 'network' : 'account-store',
      hub: hubBase ? 'network' : 'account-settings-store',
      person: personBase ? 'network' : 'account-settings-store',
      lasso: dataBase ? 'network' : 'account-settings-store',
      missingPeers: [
        ['account', accountBase], ['hub', hubBase], ['person', personBase], ['lasso', dataBase],
      ].filter(([, value]) => !value).map(([name]) => name),
    },
  };
}
