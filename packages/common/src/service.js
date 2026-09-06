// Shared HTTP service boundary. The reference Pegasus BaseService is an Express
// application, so this runner deliberately keeps Express and body-parser in the
// request path. That gives Phoenix the same routing, parsing, response framing,
// limits, charset/encoding checks, and conditional ETag behavior as the source.

import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import bodyParser from 'body-parser';
import { newMsgId, now, ResponseType } from '@phoenix/contracts';
import { readTrace } from './headers.js';
import { logger } from './log.js';

const JSON_CONTENT_TYPES = ['application/json', 'application/x-amz-json-1.1'];

// body-parser gives verify the exact post-inflation bytes before decoding. Keep
// them on the request so a signed AWS-JSON proxy can forward the original
// entity instead of signing/forwarding a reserialized object.
function captureRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

/**
 * @param {{
 *   name: string,
 *   routes?: Record<string, (ctx: any) => any>,
 *   onUpgrade?: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void,
 *   jsonStrict?: boolean | ((req: import('node:http').IncomingMessage) => boolean),
 * }} opts
 */
export function createService({ name, routes = {}, onUpgrade, jsonStrict = true } = {}) {
  const log = logger(name);
  const app = express();
  const urlencoded = bodyParser.urlencoded({ extended: true, verify: captureRawBody });
  const strictJson = bodyParser.json({ type: JSON_CONTENT_TYPES, verify: captureRawBody, strict: true });
  const looseJson = bodyParser.json({ type: JSON_CONTENT_TYPES, verify: captureRawBody, strict: false });

  // The trace logger is available to body-parser errors and the final 404 in the
  // same request scope as it is to a handler.
  app.use((req, _res, next) => {
    const trace = readTrace(req);
    req._phoenixTrace = trace;
    req._phoenixLog = logger(name, trace);
    next();
  });

  // BaseService installs urlencoded parsing before the free health route. Raw
  // upload handlers are an explicit Phoenix extension and must retain the
  // request stream for their own consumer, so they bypass both parsers.
  app.use((req, res, next) => {
    if (findRoute(routes, req, { rawOnly: true })) return next();
    return urlencoded(req, res, next);
  });

  // Express's default routing is case-insensitive and ignores a trailing slash.
  // Registering the health route before JSON parsing preserves the source
  // middleware order and its health OPTIONS/404 behavior.
  app.get('/healthcheck', (_req, res) => res.status(200).send('ok'));

  // This is intentionally after healthcheck and before application handlers.
  app.use((req, res, next) => {
    if (findRoute(routes, req, { rawOnly: true })) return next();
    const strict = typeof jsonStrict === 'function' ? jsonStrict(req) : jsonStrict;
    return (strict ? strictJson : looseJson)(req, res, next);
  });

  const routeRouter = express.Router();
  for (const [key, handler] of Object.entries(routes)) {
    const separator = key.indexOf(' ');
    if (separator < 1 || typeof handler !== 'function') continue;
    const method = key.slice(0, separator).trim().toLowerCase();
    const path = key.slice(separator + 1).trim();
    const register = routeRouter[method];
    if (typeof register !== 'function') continue;
    register.call(routeRouter, path, routeMiddleware(name, handler));
  }
  app.use(routeRouter);

  // Keep the source's explicit 404/error envelope instead of Express's HTML
  // finalhandler. body-parser errors arrive here before this 404 middleware.
  app.use((req, _res, next) => {
    const reqLog = req._phoenixLog || logger(name, readTrace(req));
    reqLog.warn('no route', { method: req.method, path: req.path });
    const error = new Error(`URL not found: ${req.path}`);
    error.statusCode = 404;
    next(error);
  });

  app.use((error, req, res, next) => {
    const reqLog = req._phoenixLog || logger(name, readTrace(req));
    reqLog.error('handler threw', { error: error?.message });
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : Number.isInteger(error?.status) ? error.status : 500;
    return sendJson(res, status, serviceError(errorMessage(error, req)));
  });

  const server = http.createServer(app);
  if (onUpgrade) server.on('upgrade', onUpgrade);

  return {
    server,
    app,
    /** @param {number} port @returns {Promise<import('node:http').Server>} */
    listen(port) {
      return new Promise((resolve) => {
        server.listen(port, () => {
          log.info('listening', { port });
          resolve(server);
        });
      });
    },
  };
}

function routeMiddleware(name, handler) {
  return (req, res, next) => {
    const trace = req._phoenixTrace || readTrace(req);
    const reqLog = req._phoenixLog || logger(name, trace);
    const url = new URL(req.originalUrl || req.url, 'http://localhost');
    const bodyDefault = Object.prototype.hasOwnProperty.call(handler, 'bodyDefault')
      ? (typeof handler.bodyDefault === 'function' ? handler.bodyDefault(req) : handler.bodyDefault)
      : {};
    // body-parser initializes req.body to {} even when a JSON request has no
    // entity. Route-specific Hapi compatibility defaults therefore need the
    // transport-level empty-body check as well as the normal undefined check.
    const emptyEntity = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.length === 0
      : req.rawBody === undefined && !requestHasEntity(req);
    const body = handler.rawBody ? null : (emptyEntity || req.body === undefined ? bodyDefault : req.body);
    Promise.resolve()
      .then(() => handler({ req, res, url, body, trace, log: reqLog }))
      .then((result) => {
        if (!res.writableEnded) sendJson(res, 200, result);
      })
      .catch(next);
  };
}

function requestHasEntity(req) {
  const length = Number(req?.headers?.['content-length']);
  if (Number.isFinite(length)) return length > 0;
  return req?.headers?.['transfer-encoding'] !== undefined;
}

/**
 * Find a route for the parser bypass only. Application routing itself is left
 * to Express, including path patterns and its case/trailing-slash rules. Raw
 * routes in Phoenix are exact upload endpoints; HEAD falls back to GET just as
 * Express does.
 */
function findRoute(routes, req, { rawOnly = false } = {}) {
  const path = requestPath(req);
  const method = String(req.method || '').toUpperCase();
  for (const [key, handler] of Object.entries(routes)) {
    if (rawOnly && !handler?.rawBody) continue;
    const separator = key.indexOf(' ');
    if (separator < 1) continue;
    const routeMethod = key.slice(0, separator).trim().toUpperCase();
    if (routeMethod !== method && !(method === 'HEAD' && routeMethod === 'GET')) continue;
    if (sameExpressPath(path, key.slice(separator + 1).trim())) return handler;
  }
  return undefined;
}

function requestPath(req) {
  return new URL(req.originalUrl || req.url, 'http://localhost').pathname;
}

function sameExpressPath(left, right) {
  return normalizeRoutePath(left).toLowerCase() === normalizeRoutePath(right).toLowerCase();
}

function normalizeRoutePath(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path || '/';
}

function serviceError(message) {
  return {
    type: ResponseType.ERROR,
    msgID: newMsgId(),
    ts: now(),
    final: true,
    data: { message },
  };
}

function errorMessage(error, req) {
  const message = error?.message || String(error);
  // The frozen source ran on Node 8. body-parser remains the parser of record,
  // but Node 22 changed SyntaxError wording. Keep the source's wire-visible
  // message while retaining body-parser's actual strictness and error classes.
  const contentType = String(req?.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (error?.type === 'entity.parse.failed' && JSON_CONTENT_TYPES.includes(contentType) && typeof error.body === 'string') {
    return legacyJsonError(error.body, message);
  }
  return message;
}

function legacyJsonError(raw, message) {
  if (message === 'Unexpected end of JSON input') return message;

  // Node 8 reported the offending token and UTF-16 position. Newer V8 releases
  // split that information across several diagnostics, sometimes adding line
  // and column text and sometimes omitting the position from token errors.
  // Translate only those parser diagnostics; body-parser remains responsible
  // for deciding whether the entity is valid JSON.
  const position = message.match(/ in JSON at position (\d+)/)?.[1];
  const token = message.match(/^Unexpected token ['"](.+?)['"]/)?.[1];
  if (token !== undefined) {
    const index = position === undefined ? jsonSyntaxPosition(raw) : Number(position);
    if (index >= 0) return `Unexpected token ${token} in JSON at position ${index}`;
  }

  const noNumber = message.match(/^No number after minus sign in JSON at position (\d+)/);
  if (noNumber) return legacyToken(raw, Number(noNumber[1]));

  const after = message.match(/^Unexpected non-whitespace character after JSON at position (\d+)/);
  if (after) return legacyToken(raw, Number(after[1]));

  const number = message.match(/^Unexpected number in JSON at position (\d+)/);
  if (number) return `Unexpected number in JSON at position ${number[1]}`;

  const property = message.match(/^Expected ':' after property name in JSON at position (\d+)/);
  if (property) return legacyToken(raw, Number(property[1]));

  const array = message.match(/^Expected ',' or ']' after array element in JSON at position (\d+)/);
  if (array) return legacyValueSeparatorToken(raw, Number(array[1]));

  const value = message.match(/^Expected ',' or '}' after property value in JSON at position (\d+)/);
  if (value) return legacyValueSeparatorToken(raw, Number(value[1]));

  const propertyName = message.match(/^Expected property name or '}' in JSON at position (\d+)/);
  if (propertyName) return legacyToken(raw, Number(propertyName[1]));

  const quotedProperty = message.match(/^Expected double-quoted property name in JSON at position (\d+)/);
  if (quotedProperty) return legacyToken(raw, Number(quotedProperty[1]));

  const unterminatedString = message.match(/^Unterminated string in JSON at position (\d+)/);
  if (unterminatedString) return 'Unexpected end of JSON input';

  const escaped = message.match(/^Bad escaped character in JSON at position (\d+)/);
  if (escaped) return legacyToken(raw, Number(escaped[1]));

  const unicode = message.match(/^Bad Unicode escape in JSON at position (\d+)/);
  if (unicode) return legacyToken(raw, Number(unicode[1]));

  const fraction = message.match(/^Unterminated fractional number in JSON at position (\d+)/);
  if (fraction) return legacyToken(raw, Number(fraction[1]));

  const exponent = message.match(/^Exponent part is missing a number in JSON at position (\d+)/);
  if (exponent) return legacyToken(raw, Number(exponent[1]));

  const control = message.match(/^Bad control character in string literal in JSON at position (\d+)/);
  if (control) return legacyToken(raw, Number(control[1]));

  return message;
}

function legacyToken(raw, position) {
  const token = raw[position];
  if (token === undefined) return 'Unexpected end of JSON input';
  if (/\d/.test(token)) return `Unexpected number in JSON at position ${position}`;
  if (token === '"') return `Unexpected string in JSON at position ${position}`;
  return `Unexpected token ${token} in JSON at position ${position}`;
}

function legacyValueSeparatorToken(raw, position) {
  if (raw[position] === '-') return `Unexpected number in JSON at position ${position}`;
  return legacyToken(raw, position);
}

/**
 * Find a modern V8 token diagnostic's position without deciding JSON validity.
 * body-parser/JSON.parse remains authoritative; this bounded scanner only
 * walks enough grammar to locate the first offending UTF-16 code unit when
 * modern V8 omits the position from an `Unexpected token` message.
 */
function jsonSyntaxPosition(raw) {
  let start = skipJsonWhitespace(raw, 0);
  if (start >= raw.length) return start;
  // body-parser's strict JSON mode rejects primitive top-level values after
  // reading them, so their legacy position is the first non-whitespace unit.
  if (raw[start] !== '{' && raw[start] !== '[') return start;
  // Use an explicit grammar stack rather than recursive descent. Each frame
  // consumes an opening byte, so body-parser's 100 KiB limit bounds memory
  // used by this diagnostic-only walk even for deeply nested input.
  const stack = [{
    type: raw[start] === '{' ? 'object' : 'array',
    state: raw[start] === '{' ? 'key' : 'value',
  }];
  let index = start + 1;

  while (stack.length > 0) {
    index = skipJsonWhitespace(raw, index);
    const frame = stack[stack.length - 1];

    if (frame.type === 'object') {
      if (frame.state === 'key' || frame.state === 'keyAfterComma') {
        if (raw[index] === '}') {
          if (frame.state === 'keyAfterComma') return index;
          stack.pop();
          index++;
          if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
          continue;
        }
        if (raw[index] !== '"') return index;
        const key = scanJsonString(raw, index);
        if (key.error !== undefined) return key.error;
        index = key.end;
        frame.state = 'colon';
        continue;
      }

      if (frame.state === 'colon') {
        if (raw[index] !== ':') return index;
        index++;
        frame.state = 'value';
        continue;
      }

      if (frame.state === 'value') {
        if (raw[index] === '{' || raw[index] === '[') {
          stack.push({
            type: raw[index] === '{' ? 'object' : 'array',
            state: raw[index] === '{' ? 'key' : 'value',
          });
          index++;
          continue;
        }
        const value = scanJsonPrimitive(raw, index);
        if (value.error !== undefined) return value.error;
        index = value.end;
        frame.state = 'afterValue';
        continue;
      }

      if (raw[index] === '}') {
        stack.pop();
        index++;
        if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
        continue;
      }
      if (raw[index] === ',') {
        index++;
        frame.state = 'keyAfterComma';
        continue;
      }
      return index;
    }

    if (frame.state === 'value' || frame.state === 'valueAfterComma') {
      if (raw[index] === ']') {
        if (frame.state === 'valueAfterComma') return index;
        stack.pop();
        index++;
        if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
        continue;
      }
      if (raw[index] === '{' || raw[index] === '[') {
        stack.push({
          type: raw[index] === '{' ? 'object' : 'array',
          state: raw[index] === '{' ? 'key' : 'value',
        });
        index++;
        continue;
      }
      const value = scanJsonPrimitive(raw, index);
      if (value.error !== undefined) return value.error;
      index = value.end;
      frame.state = 'afterValue';
      continue;
    }

    if (raw[index] === ']') {
      stack.pop();
      index++;
      if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
      continue;
    }
    if (raw[index] === ',') {
      index++;
      frame.state = 'valueAfterComma';
      continue;
    }
    return index;
  }

  index = skipJsonWhitespace(raw, index);
  return index < raw.length ? index : -1;
}

function scanJsonPrimitive(raw, position) {
  const character = raw[position];
  if (character === undefined) return { error: position };
  if (character === '"') return scanJsonString(raw, position);
  if (character === 't') return scanJsonLiteral(raw, position, 'true');
  if (character === 'f') return scanJsonLiteral(raw, position, 'false');
  if (character === 'n') return scanJsonLiteral(raw, position, 'null');
  if (character === '-' || /\d/.test(character)) return scanJsonNumber(raw, position);
  return { error: position };
}

function scanJsonLiteral(raw, position, literal) {
  for (let offset = 0; offset < literal.length; offset++) {
    const index = position + offset;
    if (raw[index] === undefined) return { error: index };
    if (raw[index] !== literal[offset]) return { error: index };
  }
  return { end: position + literal.length };
}

function scanJsonNumber(raw, position) {
  let index = position;
  if (raw[index] === '-') {
    index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
  }
  if (raw[index] === '0') {
    index++;
    if (/\d/.test(raw[index] || '')) return { error: index };
  } else {
    while (/\d/.test(raw[index] || '')) index++;
  }
  if (raw[index] === '.') {
    index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
    while (/\d/.test(raw[index] || '')) index++;
  }
  if (raw[index] === 'e' || raw[index] === 'E') {
    index++;
    if (raw[index] === '+' || raw[index] === '-') index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
    while (/\d/.test(raw[index] || '')) index++;
  }
  return { end: index };
}

function scanJsonString(raw, position) {
  for (let index = position + 1; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') return { end: index + 1 };
    if (character.charCodeAt(0) < 0x20) return { error: index };
    if (character !== '\\') continue;
    const escaped = raw[++index];
    if (escaped === undefined) return { error: index };
    if (escaped === 'u') {
      for (let digit = 0; digit < 4; digit++) {
        const code = raw[index + 1 + digit];
        if (code === undefined) return { error: index + 1 + digit };
        if (!/[0-9a-f]/i.test(code)) return { error: index + 1 + digit };
      }
      index += 4;
    } else if (!/["\\/bfnrt]/.test(escaped)) {
      return { error: index };
    }
  }
  return { error: raw.length };
}

function skipJsonWhitespace(raw, position) {
  while (position < raw.length && /[\u0020\u0009\u000a\u000d]/.test(raw[position])) position++;
  return position;
}

// --- response helpers -------------------------------------------------------

/**
 * Use Express's response implementation when available. The native fallback is
 * retained for the small set of Phoenix stream interceptors that deliberately
 * replace the service request listener (history's speech update path).
 */
export function sendText(res, status, text, extraHeaders = {}) {
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    for (const [name, value] of Object.entries(extraHeaders)) res.set(name, value);
    return res.status(status).send(text === undefined || text === null ? '' : String(text));
  }
  const body = text === undefined || text === null ? '' : String(text);
  writeBody(res, status, 'text/html; charset=utf-8', body, extraHeaders);
}

export function sendJson(res, status, obj) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(obj);
  }
  const body = JSON.stringify(obj);
  writeBody(res, status, 'application/json; charset=utf-8', body === undefined ? '' : body);
}

/** Native response fallback with the same ETag entity format as Express. */
function writeBody(res, status, contentType, body, extraHeaders = {}) {
  const length = Buffer.byteLength(body);
  const headers = {
    ...extraHeaders,
    'x-powered-by': 'Express',
    'content-type': contentType,
    'content-length': length,
  };
  if (length) {
    const digest = createHash('sha1').update(body).digest('base64').slice(0, 27);
    headers.etag = `W/"${length.toString(16)}-${digest}"`;
  }
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Standalone compatibility helper. Service requests use the middleware
 * instances above; this export applies the same parsers to a supplied request.
 */
export function readJson(req) {
  const urlencoded = bodyParser.urlencoded({ extended: true, verify: captureRawBody });
  const json = bodyParser.json({ type: JSON_CONTENT_TYPES, verify: captureRawBody });
  const res = {};
  return new Promise((resolve, reject) => {
    urlencoded(req, res, (firstError) => {
      if (firstError) return reject(firstError);
      json(req, res, (secondError) => {
        if (secondError) return reject(secondError);
        resolve(req.body === undefined ? {} : req.body);
      });
    });
  });
}
