// Classic GQA wire adapter (GQA_20160930).
//
// The generated client model is an AWS-JSON surface, but the pinned security gateway routes
// Question and ListAttribution to the old Flask service's /structQA and /retrieveAtt endpoints.
// The gateway changes application/x-amz-json-1.1 to application/json, forwards an
// x-amz-credentials JSON header, and returns the Flask response as application/json.  This
// module keeps that boundary explicit while leaving the /structQA provider/orchestration behind
// an injected question handler owned by the parallel Q-01 implementation.

import { accessKeyIdFromAuth } from './awsJson.js';

export const GQA_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_API_REVISION = '155d20a8102960b2aeb89c197bdf04dc1f1fc344';
export const GQA_GATEWAY_REVISION = '43a692fe7670660aaed6ab5979c6c83039eb711c';
export const GQA_TARGET_PREFIX = 'GQA_20160930';
export const GQA_OPERATIONS = Object.freeze(['Question', 'ListAttribution']);
export const GQA_VERSION = '5.2.15';

// Flask 0.12 / Werkzeug 0.12's default 400 renderer. The security gateway reads the downstream
// body and replies with application/json, but it does not replace these bytes.
export const GQA_BAD_REQUEST_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>The browser (or proxy) sent a request that this server could not understand.</p>\n';

// Flask's default 404 renderer used when the gateway maps an unknown GQA operation to
// /undefined. Supported targets never use this branch; retaining it keeps the prefix route from
// turning an unrecognised GQA operation back into Classic's generic UnknownOperationException.
export const GQA_NOT_FOUND_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>404 Not Found</title>\n<h1>Not Found</h1>\n'
  + '<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function header(req, name) {
  const headers = req?.headers || {};
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : headers[key];
}

function targetOperation(req) {
  const target = String(header(req, 'x-amz-target') || '');
  const dot = target.lastIndexOf('.');
  return dot >= 0 ? target.slice(dot + 1) : target;
}

function escapeNonAscii(json) {
  // Python json.dumps defaults to ensure_ascii=True. Iterate UTF-16 code units so
  // astral characters become the same pair of \\u escapes as Python.
  return json.replace(/[\u0080-\uFFFF]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

/** The JSON subset returned by Flask's Python json.dumps (spacing and ASCII included). */
export function sourceJsonDumps(value) {
  if (value === undefined) throw new TypeError('undefined is not JSON serializable');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const json = JSON.stringify(value);
    return typeof value === 'string' ? escapeNonAscii(json) : json;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number is not JSON serializable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(sourceJsonDumps).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => (
      `${escapeNonAscii(JSON.stringify(key))}: ${sourceJsonDumps(item)}`
    )).join(', ')}}`;
  }
  throw new TypeError(`${typeof value} is not JSON serializable`);
}

/** Python truthiness for the account lookup result used by gqa.account.get_loop_id. */
export function sourceTruthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Read the identity that srv-security-gw injects before forwarding to Flask.
 *
 * The public Classic router authenticates before this handler runs. When a
 * compatibility fixture has no gateway-injected credentials, the access key is
 * retained only as the source-shaped downstream identity fallback.
 */
export function gqaCredentials(req, { required = false } = {}) {
  const raw = header(req, 'x-amz-credentials');
  if (raw === undefined) {
    const accessKeyId = accessKeyIdFromAuth(req);
    if (accessKeyId) return { id: accessKeyId, accessKeyId };
    if (required) throw new Error("Missing 'x-amz-credentials' header");
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(Array.isArray(raw) ? raw[0] : raw);
  } catch (error) {
    // A source-shaped fallback for unguarded compatibility fixtures; production
    // requests have already passed the Classic caller boundary.
    const accessKeyId = accessKeyIdFromAuth(req);
    if (accessKeyId) {
      const credentials = { id: accessKeyId, accessKeyId };
      if (req?.headers) req.headers['x-amz-credentials'] = JSON.stringify(credentials);
      return credentials;
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError("x-amz-credentials must be a JSON object");
  }
  if (required && !hasOwn(parsed, 'id')) throw new Error("x-amz-credentials is missing 'id'");
  return parsed;
}

function requestContentType(req) {
  const value = header(req, 'content-type');
  return value === undefined || value === null ? undefined : String(value).split(';', 1)[0].trim().toLowerCase();
}

function hasRequestEntity(req) {
  const length = Number(header(req, 'content-length'));
  if (Number.isFinite(length)) return length > 0;
  return header(req, 'transfer-encoding') !== undefined;
}

/** Empty JSON is rejected by Flask's request.json before either GQA view runs. */
export function gqaEmptyJsonEntity(req) {
  const contentType = requestContentType(req);
  if (contentType !== 'application/json'
    && contentType !== 'application/x-amz-json-1.1'
    && !(contentType?.startsWith('application/') && contentType.endsWith('+json'))) return false;
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody.length === 0;
  return !hasRequestEntity(req);
}

/** The security gateway's downstream reply is application/json, including Flask error bodies. */
export function sendGqaJson(res, status, value) {
  const body = sourceJsonDumps(value === undefined ? null : value);
  if (typeof res.status === 'function') res.status(status);
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(body)));
  }
  return res.end(body);
}

export function sendGqaHtml(res, status, body) {
  if (typeof res.status === 'function') res.status(status);
  if (typeof res.setHeader === 'function') {
    // srv-security-gw's Wreck reply forwards body.toString() and then forces
    // application/json. Preserve the Flask HTML bytes while matching that
    // outer wire media type.
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(body)));
  }
  return res.end(body);
}

function sourceError(error) {
  return {
    version: GQA_VERSION,
    message: error?.message || String(error),
    // The original Flask error handler serialises traceback.format_exc(). A stack string keeps
    // this placeholder/adapter failure source-shaped without pretending to reproduce its stack.
    stacktrace: error?.stack || String(error),
  };
}

function sourceObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('request JSON does not provide mapping methods');
  }
  return value;
}

function handlerFunction(value, label) {
  if (typeof value === 'function') return value;
  if (value && typeof value.handle === 'function') return value.handle.bind(value);
  if (value && typeof value.handler === 'function') return value.handler.bind(value);
  if (value !== undefined && value !== null) throw new TypeError(`${label} handler must be a function`);
  return null;
}

function injectGqaCredentialsHeader(req, credentials) {
  if (!credentials || header(req, 'x-amz-credentials') !== undefined || !req?.headers) return;
  // The source /structQA implementation reads request.headers. Keep the original header object
  // identity required by the explicit source-handler seam while making the Classic SigV4
  // fallback visible to that implementation.
  req.headers['x-amz-credentials'] = JSON.stringify(credentials);
}

function unavailableQuestion() {
  throw new Error('GQA Question handler not configured; inject the /structQA implementation');
}

function unavailableAttribution() {
  throw new Error('GQA attribution service not configured');
}

function parserError({ req, res }) {
  // The gateway changes the media type before Flask sees malformed input. The Classic adapter
  // accepts both direct AWS JSON and already-rewritten application/json, so both reach this
  // source error body.
  if (!GQA_OPERATIONS.includes(targetOperation(req))) return sendGqaHtml(res, 404, GQA_NOT_FOUND_HTML);
  if (gqaEmptyJsonEntity(req) || req?.headers?.['content-type']) return sendGqaHtml(res, 400, GQA_BAD_REQUEST_HTML);
  return undefined;
}

async function runSourceHandler(context, handler) {
  const { req, res } = context;
  if (gqaEmptyJsonEntity(req)) return sendGqaHtml(res, 400, GQA_BAD_REQUEST_HTML);
  try {
    const result = await handler(context);
    if (!res.writableEnded) return sendGqaJson(res, 200, result === undefined ? {} : result);
    return undefined;
  } catch (error) {
    if (!res.writableEnded) return sendGqaJson(res, 500, sourceError(error));
    return undefined;
  }
}

function listAttributionHandler({ accountLookup, attribution }) {
  const search = typeof attribution?.search === 'function' ? attribution.search.bind(attribution) : null;
  const account = handlerFunction(accountLookup, 'GQA account lookup');
  if (!search || !account) return unavailableAttribution;
  return async ({ req, body }) => {
    // /retrieveAtt parses credentials and resolves the account before it calls data.get(). This
    // ordering is observable for malformed top-level JSON and is retained by the adapter.
    const credentials = gqaCredentials(req, { required: true });
    const loopId = await account(credentials.id, { credentials, req });
    if (!sourceTruthy(loopId)) throw new Error('No robot ID!');
    const data = sourceObject(body);
    return { data: await search(loopId, data.Service, data.before, data.after) };
  };
}

/**
 * Build the GQA Classic handler.
 *
 * `structQaHandler` is deliberately a replaceable function with the source implementation's
 * explicit `(body, { req, headers })` shape. The metadata object also carries parsed forwarded
 * credentials, the request logger, and a `send` helper if the implementation needs to own a
 * source response. It may return a response object, or end `res` itself. Keeping one call shape
 * prevents a bare handler from silently being invoked as either `(context)` or `(body, meta)`.
 *
 * Attribution can be a handler function/object, or `{ accountLookup, search }` where `search`
 * has the source `gqa.attribute.search_db(loopId, service, before, after)` signature.
 */
export function makeGqaHandler(options = {}) {
  const structQaHandler = handlerFunction(
    options.structQaHandler ?? options.question ?? options.questionHandler ?? options.structQA,
    'GQA structQA',
  )
    || unavailableQuestion;
  const accountLookup = handlerFunction(
    options.accountLookup || options.account?.getLoopId || options.account?.get_loop_id,
    'GQA account lookup',
  );
  const directAttribution = handlerFunction(options.attributionHandler, 'GQA attribution');
  const attribution = directAttribution
    || (typeof options.attribution === 'function' ? options.attribution : null)
    || listAttributionHandler({
      accountLookup,
      attribution: options.attribution || options.store,
    });

  return async function gqaHandler(context) {
    const name = context.op;
    if (name === 'Question') {
      return runSourceHandler({
        ...context,
        send: (status, value) => sendGqaJson(context.res, status, value),
      }, async (questionContext) => {
        const credentials = gqaCredentials(questionContext.req);
        injectGqaCredentialsHeader(questionContext.req, credentials);
        return structQaHandler(questionContext.body, {
          req: questionContext.req,
          headers: questionContext.req?.headers || {},
          credentials,
          accountLookup,
          log: questionContext.log,
          send: questionContext.send,
        });
      });
    }
    if (name === 'ListAttribution') {
      return runSourceHandler(context, attribution);
    }
    return sendGqaHtml(context.res, 404, GQA_NOT_FOUND_HTML);
  };
}

// Metadata consumed by the Classic router/service boundary. Flask accepts primitive JSON and
// lets each view decide how to fail, while malformed/empty entities are its 400 HTML response.
export const GQA_ROUTE_OPTIONS = Object.freeze({
  jsonStrict: false,
  jsonTypes: Object.freeze(['application/json', 'application/x-amz-json-1.1', 'application/*+json']),
  bodyDefault: null,
  // Classic's generic dispatch historically replaces a null body with {}. The
  // Flask views receive request.json verbatim, so this family must retain null,
  // arrays, and primitives for their source-defined error precedence.
  preserveBody: true,
  parserError,
});
