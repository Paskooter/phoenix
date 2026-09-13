// Source-shaped legacy FCS GQA service.
//
// This is the archived jiborobot/srv-gqa-ws `/structQA` boundary, which is
// separate from the Hub `/answer_skill` service.  The source route selects
// AP news, API-AI scripted MIMs, or the Bing/Wikipedia/Wolfram fallback from a
// small JSON request.  Every external dependency below is an explicit seam:
// selecting this module never contacts an account service, AP cache, API-AI,
// or a live GQA provider by itself.

import {
  createGqaAccountLookup,
  createGqaAttributionStore,
  sourceJsonDumps,
  sourceTruthy,
} from './gqaAccountAttribution.js';
import {
  cleanGqaInput,
  createGqaProviderPipeline,
  gqaPiiFilter,
} from './gqaAnswerSkill.js';
import { createApNewsProvider } from './newsAnswerSkill.js';
import { createService } from '@phoenix/common';

export const STRUCTQA_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const STRUCTQA_SOURCE_MODULE = 'gqa/gqa.py';
export const STRUCTQA_SOURCE_PATH = '/structQA';
export const STRUCTQA_SOURCE_VERSION = '5.2.15';
export const STRUCTQA_SOURCE_INTENTS = Object.freeze(['GQA', 'News', 'Scripted']);

export const STRUCTQA_COUNTRY_CODE_MAP = Object.freeze({
  usa: 'US',
  canada: 'CA',
  'american samoa': 'AS',
  guam: 'GU',
  'northern mariana islands': 'MP',
  'puerto rico': 'PR',
  'u.s. minor outlying islands': 'UM',
  'u.s. virgin islands': 'VI',
  us: 'US',
  'united states': 'US',
  '': 'US',
});

const SOURCE_JSON_TYPES = Object.freeze(['application/json', 'application/*+json']);

export const STRUCTQA_ERROR_MODES = Object.freeze(['debug', 'production']);
export const STRUCTQA_PRODUCTION_ERROR_MESSAGE = 'Fatal error.  Please see the cloud-side logs for the GQA container.';

// Flask 0.12/Werkzeug 0.12 emits this HTML for malformed JSON and an empty
// application/json entity.  The route keeps the body as text/html because
// this endpoint is a Flask-era FCS surface rather than a Phoenix JSON API.
export const STRUCTQA_BAD_REQUEST_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>The browser (or proxy) sent a request that this server could not understand.</p>\n';

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pythonStringLiteral(value) {
  const singleQuotes = [...value].filter((character) => character === "'").length;
  const doubleQuotes = [...value].filter((character) => character === '"').length;
  const quote = singleQuotes > doubleQuotes ? '"' : "'";
  const escaped = Array.from(value, (character) => {
    switch (character) {
      case '\\': return '\\\\';
      case "'": return quote === "'" ? "\\'" : character;
      case '"': return quote === '"' ? '\\"' : character;
      case '\b': return '\\b';
      case '\f': return '\\f';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\v': return '\\v';
      default: {
        const code = character.charCodeAt(0);
        return code < 0x20 ? `\\x${code.toString(16).padStart(2, '0')}` : character;
      }
    }
  }).join('');
  return `${quote}${escaped}${quote}`;
}

function pythonNumberString(value) {
  // JSON.parse has already converted the wire token to a JavaScript Number.
  // Keep the value's ordinary decimal spelling where it remains observable;
  // the original `1.0` versus `1` lexical distinction cannot be recovered.
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/** Python `str()` formatting for values that arrived through JSON.parse. */
export function formatStructQaPythonValue(value, { nested = false } = {}) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pythonNumberString(value);
  if (typeof value === 'string') return nested ? pythonStringLiteral(value) : value;
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatStructQaPythonValue(item, { nested: true })).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${pythonStringLiteral(key)}: ${formatStructQaPythonValue(item, { nested: true })}`).join(', ')}}`;
  }
  return String(value);
}

function sourceString(value) {
  return formatStructQaPythonValue(value);
}

function timestampMs(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const number = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(number)) throw new TypeError('StructQA clock must return a finite timestamp');
  return Math.trunc(number);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  if (key === undefined) return undefined;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function requestHeaderValues(headers, name, request = {}) {
  if (Array.isArray(request.rawHeaders)) {
    const values = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === name.toLowerCase()) {
        values.push(request.rawHeaders[index + 1]);
      }
    }
    if (values.length > 0) return values;
  }
  if (!headers || typeof headers !== 'object') return [];
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (key === undefined) return [];
  const value = headers[key];
  return Array.isArray(value) ? value.slice() : value === undefined ? [] : [value];
}

function requestContentType(request) {
  const value = headerValue(request?.headers, 'content-type');
  if (value === undefined || value === null) return undefined;
  return String(value).split(';', 1)[0].trim().toLowerCase();
}

function isSourceJsonRequest(request) {
  const type = requestContentType(request);
  return type === 'application/json'
    || (type?.startsWith('application/') && type.endsWith('+json'));
}

function hasEmptyJsonEntity(request) {
  if (!isSourceJsonRequest(request)) return false;
  if (Buffer.isBuffer(request?.rawBody)) return request.rawBody.length === 0;
  const length = Number(headerValue(request?.headers, 'content-length'));
  return Number.isFinite(length) && length === 0;
}

function normalizeErrorMode(value) {
  if (value === undefined) return undefined;
  if (!STRUCTQA_ERROR_MODES.includes(value)) {
    throw new TypeError(`StructQA errorMode must be one of: ${STRUCTQA_ERROR_MODES.join(', ')}`);
  }
  return value;
}

/**
 * Mirrors the pinned Python expression `os.getenv(...) == 1` exactly. Node's
 * process.env values are strings, so the ordinary environment value `"1"`
 * intentionally resolves to debug; production is an explicit adapter mode or
 * only reachable with a non-string test/configuration object.
 */
export function structQaErrorModeFromEnv(env = process.env) {
  return env?.ETCO_gqa_production === 1 ? 'production' : 'debug';
}

function resolveErrorMode(errorMode, env) {
  return normalizeErrorMode(errorMode) || structQaErrorModeFromEnv(env);
}

function sourceError(error, mode = 'debug') {
  if (mode === 'production') {
    return {
      version: STRUCTQA_SOURCE_VERSION,
      message: STRUCTQA_PRODUCTION_ERROR_MESSAGE,
    };
  }
  return {
    version: STRUCTQA_SOURCE_VERSION,
    message: error?.message || String(error),
    // Flask's 500 body always contains a traceback string.  Keep the same
    // JSON-serializable shape when a replaceable seam rejects with a primitive.
    stacktrace: error?.stack || String(error),
  };
}

function sourceCountryCode(country) {
  // The source calls data.get('Country', '').lower(). A non-string value is
  // therefore an observable request failure rather than an implicit cast.
  if (typeof country !== 'string') throw new TypeError('Country must provide lower()');
  return STRUCTQA_COUNTRY_CODE_MAP[country.toLowerCase()] || 'XX';
}

function sourceIpAddress(request) {
  const forwarded = requestHeaderValues(request?.headers, 'x-forwarded-for', request);
  if (forwarded.length > 0) return String(forwarded[0]).split(',', 1)[0].trim();
  return request?.socket?.remoteAddress ?? request?.remoteAddress ?? null;
}

function credentialsFromRequest(request) {
  const raw = headerValue(request?.headers, 'x-amz-credentials');
  if (raw === undefined || raw === null) return undefined;
  const parsed = JSON.parse(String(raw));
  if (!isMapping(parsed)) throw new TypeError('x-amz-credentials must be a mapping');
  return parsed;
}

function configuredAccountLookup(value) {
  if (value === undefined || value === null) return async () => ({});
  if (typeof value === 'function') return value;
  if (isMapping(value)) return createGqaAccountLookup(value);
  throw new TypeError('StructQA account configuration must be a function or mapping');
}

function configuredAttribution(value) {
  if (value === undefined || value === null) return undefined;
  if (isMapping(value) && typeof value.insert === 'function') return value;
  if (isMapping(value) && value.collection) return createGqaAttributionStore(value);
  throw new TypeError('StructQA attribution configuration must provide a store or collection');
}

function configuredNewsProvider({ newsProvider, apStore, clock }) {
  if (newsProvider !== undefined && apStore !== undefined) {
    throw new TypeError('Configure either newsProvider or apStore, not both');
  }
  if (newsProvider !== undefined && typeof newsProvider !== 'function') {
    throw new TypeError('StructQA news provider must be a function');
  }
  if (apStore !== undefined && apStore !== null) return createApNewsProvider({ store: apStore, clock });
  // The original deployment always had Mongo/AP data. An unconfigured
  // candidate returns the source empty-news result and never invents a feed.
  return newsProvider || (async () => []);
}

function registryFunction(registry, camel, snake) {
  if (typeof registry === 'function') return registry;
  if (!registry || typeof registry !== 'object') return undefined;
  if (typeof registry[camel] === 'function') return registry[camel].bind(registry);
  if (typeof registry[snake] === 'function') return registry[snake].bind(registry);
  return undefined;
}

/**
 * Build the source Scripted branch around replaceable API-AI and MIM lookup
 * dependencies. `apiAi` may be a function or an object with `call`; the
 * registry may expose camelCase or source snake_case methods.
 */
export function createStructQaScriptedProvider({ apiAi, registry, mimRegistry } = {}) {
  const apiAiCall = typeof apiAi === 'function' ? apiAi : apiAi?.call;
  const selectedRegistry = registry || mimRegistry;
  const getIntentPattern = registryFunction(selectedRegistry, 'getIntentPattern', 'get_intent_pattern');
  const getMimPayload = registryFunction(selectedRegistry, 'getMimPayload', 'get_mim_payload');
  if (typeof apiAiCall !== 'function' || typeof getIntentPattern !== 'function'
    || typeof getMimPayload !== 'function') {
    throw new TypeError('StructQA scripted provider requires API-AI and MIM registry seams');
  }

  return async function scriptedProvider({ queryText, ipAddress } = {}) {
    let apiAiOutput;
    try {
      // gqa.api_ai.call catches transport/JSON errors and returns {}. Preserve
      // that no-answer boundary for this adapter; registry shape errors remain
      // visible to the outer HTTP 500 boundary just as source code does.
      apiAiOutput = await apiAiCall(queryText, ipAddress);
    } catch (_error) {
      // The source API-AI helper catches its transport/JSON exception and
      // returns an empty mapping. The registry still receives that mapping;
      // skipping the registry would change both its call contract and any
      // registry-specific empty-result behavior.
      apiAiOutput = {};
    }
    const pattern = await getIntentPattern(apiAiOutput);
    const payload = await getMimPayload(pattern);
    return sourceTruthy(payload) ? { type: 'mim', payload } : undefined;
  };
}

function configuredScriptedProvider({ scriptedProvider, apiAi, registry, mimRegistry }) {
  if (scriptedProvider !== undefined && typeof scriptedProvider !== 'function') {
    throw new TypeError('StructQA scripted provider must be a function');
  }
  if (scriptedProvider) return scriptedProvider;
  if (apiAi !== undefined || registry !== undefined || mimRegistry !== undefined) {
    return createStructQaScriptedProvider({ apiAi, registry, mimRegistry });
  }
  // No local copy of the archived API-AI key or 47k-entry mimid_lookup table
  // is selected implicitly. This explicit empty seam gives source no-answer
  // behavior until a deployment supplies both dependencies.
  return async () => undefined;
}

function normalizeScriptedResult(value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (!isMapping(value)) throw new TypeError('StructQA scripted provider result must be a mapping');
  if (isMapping(value.response)) return value.response;
  if (Object.prototype.hasOwnProperty.call(value, 'type')
    && Object.prototype.hasOwnProperty.call(value, 'payload')) return value;
  // A convenience for a direct registry seam: returning a MIM object is
  // equivalent to the source adapter's {type: 'mim', payload: ...} result.
  return { type: 'mim', payload: value };
}

function normalizeNewsResult(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('StructQA news provider must return an array');
  return value;
}

function providerContext(body, request, input, loopId, accountId, clock) {
  const country = Object.prototype.hasOwnProperty.call(body, 'Country') ? body.Country : '';
  const location = {
    latitude: sourceString(Object.prototype.hasOwnProperty.call(body, 'Latitude') ? body.Latitude : ''),
    longitude: sourceString(Object.prototype.hasOwnProperty.call(body, 'Longitude') ? body.Longitude : ''),
  };
  return {
    request: body,
    queryText: input,
    input,
    ipAddress: sourceIpAddress(request),
    latitude: location.latitude,
    longitude: location.longitude,
    countryCode: sourceCountryCode(country),
    accountId,
    loopId,
    clock,
  };
}

function sourceResponsePayload(output) {
  const response = Object.prototype.hasOwnProperty.call(output, 'response') ? output.response : {};
  if (!isMapping(response)) throw new TypeError('StructQA provider response must be a mapping');
  return sourceTruthy(response.payload) ? response.payload : undefined;
}

function mergeProviderTimestamps(output, timestamps) {
  const providerTimestamps = isMapping(output?.timestamps) ? output.timestamps : {};
  return {
    ...output,
    timestamps: { ...timestamps, ...providerTimestamps },
  };
}

async function finalizeStructQa(output, start, loopId, attribution, clock) {
  output.version = STRUCTQA_SOURCE_VERSION;
  if (sourceTruthy(output.message)) {
    output.success = false;
  } else {
    const payload = sourceResponsePayload(output);
    if (sourceTruthy(payload)) {
      if (!Object.prototype.hasOwnProperty.call(output, 'source')) {
        // finalize_fcs indexes output["source"] for every successful branch,
        // even when no attribution store is configured.
        throw new TypeError('StructQA provider success is missing source');
      }
      output.success = true;
      const attributedSource = output.source === 'Bing' || output.source === 'Wolfram Alpha';
      // In finalize_fcs, attribution is outside the string-response branch
      // and still uses `answer`. A truthy non-string payload from either
      // attributed provider therefore raises when the response type is not
      // string (the source `answer` local is unbound). A list under the
      // string type remains source-valid: Python list += "." extends it by
      // one element and the attribution store receives that list.
      if (attributedSource && output.response.type !== 'string') {
        throw new TypeError('StructQA attributed provider response type must be string');
      }
      if (output.response.type === 'string') {
        let answer;
        if (typeof payload === 'string') {
          answer = payload;
          if (!answer.endsWith('.')) answer += '.';
        } else if (Array.isArray(payload)) {
          // `sourceTruthy` already excludes an empty list. Python's
          // `answer[-1]` and `answer += "."` are represented explicitly so
          // Wikipedia and attributed providers retain the source list edge.
          answer = payload[payload.length - 1] === '.' ? payload : [...payload, '.'];
        } else {
          throw new TypeError('StructQA string response payload must be subscriptable');
        }
        output.response.payload = answer;
        if (attributedSource) {
          if (!Object.prototype.hasOwnProperty.call(output, 'url')) {
            throw new TypeError('StructQA attributed result is missing url');
          }
          if (attribution) {
            await attribution.insert(
              output.source,
              answer,
              output.url,
              output.image_url ?? null,
              loopId,
            );
          }
        }
      }
    } else {
      output.success = false;
    }
  }
  output.timestamps.return_response = timestampMs(clock);
  return output;
}

/**
 * Construct a direct `/structQA` request handler. The returned function
 * resolves to the source response object; `createStructQaHttpRoute` adds the
 * Flask-era status/body framing for a real HTTP service.
 */
export function createStructQaHandler({
  accountLookup,
  newsProvider,
  apStore,
  scriptedProvider,
  apiAi,
  registry,
  mimRegistry,
  gqaProvider,
  providers,
  timeouts,
  attribution,
  clock = Date.now,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('StructQA clock must be a function');
  const lookup = configuredAccountLookup(accountLookup);
  const news = configuredNewsProvider({ newsProvider, apStore, clock });
  const scripted = configuredScriptedProvider({ scriptedProvider, apiAi, registry, mimRegistry });
  const store = configuredAttribution(attribution);
  let gqa = gqaProvider;
  let gqaUsesPipeline = false;
  if (gqa !== undefined && typeof gqa !== 'function') throw new TypeError('StructQA GQA provider must be a function');
  if (gqa === undefined && providers !== undefined) {
    gqa = createGqaProviderPipeline({ providers, timeouts, clock });
    gqaUsesPipeline = true;
  }
  if (gqa === undefined) gqa = async () => ({});

  return async function structQaHandler(body, { req = {}, headers } = {}) {
    const request = { ...req, headers: headers || req.headers || {} };
    const start = timestampMs(clock);
    const output = { timestamps: { receive_request: start } };
    const credentials = credentialsFromRequest(request);
    let loopId;
    let accountId;
    if (credentials && Object.prototype.hasOwnProperty.call(credentials, 'id')) {
      accountId = credentials.id;
      loopId = await lookup(accountId);
    }
    if (!sourceTruthy(loopId)) {
      output.message = 'Missing robot_id!';
      return finalizeStructQa(output, start, loopId, store, clock);
    }

    // Source Flask uses data.get only after account context is established.
    // Retain that failure boundary for a malformed top-level JSON value.
    if (!isMapping(body)) throw new TypeError('StructQA request JSON must be a mapping');
    const data = body;
    const intent = data.Intent;

    if (intent === 'News') {
      const isKid = sourceTruthy(data.HasKid);
      const result = normalizeNewsResult(await news({ isKid, request: data, body: data }));
      if (result.length > 0) {
        output.success = true;
        output.source = 'AP';
        output.response = { type: 'array', payload: result };
      } else {
        output.success = false;
        output.message = 'Empty news DB';
      }
      return finalizeStructQa(output, start, loopId, store, clock);
    }

    if (!Object.prototype.hasOwnProperty.call(data, 'Input')) {
      output.message = 'No Input field supplied in query';
      return finalizeStructQa(output, start, loopId, store, clock);
    }
    const rawInput = data.Input;
    if (typeof rawInput !== 'string') throw new TypeError('StructQA Input must be a string');
    output.input = rawInput;
    if (gqaPiiFilter(rawInput)) {
      output.message = 'Filtered by PII filter';
      return finalizeStructQa(output, start, loopId, store, clock);
    }
    const text = cleanGqaInput(rawInput);
    const ipAddress = sourceIpAddress(request);

    if (intent === 'Scripted') {
      output.source = 'Scripted Response';
      output.timestamps.api_ai_request = timestampMs(clock);
      const scriptedResult = await scripted({
        queryText: text,
        ipAddress,
        request: data,
        accountId,
        loopId,
      });
      output.timestamps.api_ai_response = timestampMs(clock);
      const response = normalizeScriptedResult(scriptedResult);
      if (response !== undefined) output.response = response;
      return finalizeStructQa(output, start, loopId, store, clock);
    }

    if (intent === 'GQA') {
      const context = providerContext(data, request, text, loopId, accountId, clock);
      let asyncOutput;
      try {
        asyncOutput = await gqa(context);
      } catch (_error) {
        // GqaParallelQuery catches each provider exception and presents an
        // ordinary no-answer result at the FCS boundary.
        // Orchestration/response-shape failures escape GqaParallelQuery and
        // must retain the source HTTP 500 boundary.
        if (gqaUsesPipeline) throw _error;
        asyncOutput = {};
      }
      if (asyncOutput === null || typeof asyncOutput !== 'object' || Array.isArray(asyncOutput)) {
        throw new TypeError('StructQA GQA provider must return a mapping');
      }
      const requestTimestamps = output.timestamps;
      const { timings: _timings, ...withoutHubTimings } = asyncOutput;
      // GqaParallelQuery returns a response only for a truthy provider answer.
      // Preserve its ordinary no-answer boundary when a direct seam returns a
      // provider diagnostic or an empty response object.
      if (!sourceTruthy(sourceResponsePayload(withoutHubTimings))) {
        delete withoutHubTimings.response;
        delete withoutHubTimings.message;
        delete withoutHubTimings.source;
      }
      Object.assign(output, withoutHubTimings);
      output.timestamps = mergeProviderTimestamps(withoutHubTimings, requestTimestamps).timestamps;
      return finalizeStructQa(output, start, loopId, store, clock);
    }

    output.message = `Unknown Intent '${sourceString(intent)}'`;
    return finalizeStructQa(output, start, loopId, store, clock);
  };
}

function sendSourceBody(context, status, body, html = false) {
  const response = context?.res;
  if (!response) return undefined;
  if (html && typeof response.status === 'function'
    && typeof response.setHeader === 'function' && typeof response.end === 'function') {
    response.status(status);
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Length', String(Buffer.byteLength(body)));
    response.end(body);
    return undefined;
  }
  if (typeof response.status === 'function' && typeof response.type === 'function'
    && typeof response.send === 'function') {
    response.status(status).type('html').send(body);
    return undefined;
  }
  return undefined;
}

function sendSourceError(context, error, errorMode) {
  const body = sourceJsonDumps(sourceError(error, errorMode));
  if (context?.res) return sendSourceBody(context, 500, body);
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.statusCode = 500;
  throw wrapped;
}

/** Preserve source parser and 500 envelopes around a selected handler. */
export function createStructQaHttpRoute({ handler, errorMode, env } = {}) {
  if (typeof handler !== 'function') throw new TypeError('StructQA HTTP handler must be a function');
  const selectedErrorMode = resolveErrorMode(errorMode, env);
  const route = async function structQaHttpRoute(context = {}) {
    const request = context.req || {};
    if (hasEmptyJsonEntity(request)) return sendSourceBody(context, 400, STRUCTQA_BAD_REQUEST_HTML, true);
    try {
      const result = await handler(context.body, { req: request, headers: request.headers });
      if (context.res) return sendSourceBody(context, 200, sourceJsonDumps(result));
      return result;
    } catch (error) {
      context.log?.error?.('StructQA handler failed', { error });
      return sendSourceError(context, error, selectedErrorMode);
    }
  };
  route.jsonStrict = false;
  route.jsonTypes = SOURCE_JSON_TYPES;
  route.errorMode = selectedErrorMode;
  route.parserError = (context) => sendSourceBody(context, 400, STRUCTQA_BAD_REQUEST_HTML, true);
  route.bodyDefault = {};
  return route;
}

/**
 * Explicit Classic-compatible context adapter for the source handler.
 *
 * Classic calls routes with `{ req, res, body, ... }`; the source-shaped
 * handler itself remains the stable `(body, { req, headers })` seam. Keeping
 * this adapter as a thin route wrapper lets the wire layer select `/structQA`
 * without copying branch, provider, or response logic.
 */
export function createStructQaClassicHandler(options = {}) {
  const { handler = createStructQaHandler(options), errorMode, env } = options;
  return createStructQaHttpRoute({ handler, errorMode, env });
}

/** Create the opt-in service; Classic/router registration is intentionally left to another seam. */
export function createStructQaService(options = {}) {
  const {
    name = 'gqa-structqa',
    handler = createStructQaHandler(options),
    path = STRUCTQA_SOURCE_PATH,
    errorMode,
    env,
  } = options;
  return createService({
    name,
    routes: { [`POST ${path}`]: createStructQaClassicHandler({ handler, errorMode, env }) },
  });
}

export const structQaContract = Object.freeze({
  source: 'jiborobot/srv-gqa-ws',
  revision: STRUCTQA_SOURCE_REVISION,
  path: STRUCTQA_SOURCE_PATH,
  intents: STRUCTQA_SOURCE_INTENTS,
  account: 'x-amz-credentials.id -> account.get_loop_id before body field routing',
  sourceHandler: '(body, { req, headers }) => response object',
  classicAdapter: 'createStructQaClassicHandler({ handler }) -> (context) => Flask-shaped HTTP response',
  noAnswer: 'HTTP 200 {success:false,timestamps,version} with no response payload',
  error: 'HTTP 500 debug {version,message,stacktrace}; explicit production mode emits {version,message} (the pinned env comparison keeps ordinary env "1" in debug)',
});
