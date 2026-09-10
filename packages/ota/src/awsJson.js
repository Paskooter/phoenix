// Minimal AWS-JSON-1.1 wire helpers — exactly what the robot's @jibo/jibo-server-client
// (an aws-sdk-js fork) emits and parses for the Update service.
//
// Request  (jibo-server-client lib/protocol/json.js buildRequest):
//   POST <endpoint>/                 (globalEndpoint = https://<region>.jibo.com)
//   Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <targetPrefix>.<OperationName>   e.g. Update_20160301.GetUpdateFrom
//   Authorization: AWS4-HMAC-SHA256 ***               (SigV4 — we do NOT verify; like the hub's DISABLE_AUTH)
//   body: JSON of the operation's input members      e.g. {"fromVersion":"3.3.4","subsystem":"os"}
//   CreateUpdate carries the package bytes as the request ENTITY instead (a blob payload);
//   the source routed it to a stream-output handler (srv-server src/server.ts:187-208).
//
// Response (lib/protocol/json.js extractData / extractError):
//   success: 200, body = JSON of the output shape (an Update object, or a list of them)
//   error:   non-2xx, body = {"__type": "<Code>", "message": "<msg>"} (+ x-amzn-errortype header)
//
//   The source's coded errors came from Boom.createWithCode, which sets the code on the
//   payload itself (`error.output.payload.code`). extractError resolves the client code as
//   `body.__type || body.code || body.error` (body beats the header), so a coded envelope is
//   equivalent either way. Its VALIDATION errors (Joi -> Boom.badData) carry no code at all:
//   the client then reads `body.error` = the HTTP reason phrase, so those must NOT be sent as
//   `__type` — see sendBoom().

import { STATUS_CODES } from 'node:http';

export const AMZ_JSON = 'application/x-amz-json-1.1';

/** Operation name from the X-Amz-Target header: "Update_20160301.GetUpdateFrom" -> "GetUpdateFrom". */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return dot >= 0 ? t.slice(dot + 1) : t;
}

/**
 * The security gateway's internal identity header (srv-server src/parseCredentials.ts:17).
 * The gateway injects it from the verified SigV4 caller; the Update service never reads the
 * raw Authorization value itself. A malformed/absent header yields {} — exactly the source's
 * `try { JSON.parse(...) } catch { credentials = {} }`.
 */
export function credentialsFrom(req) {
  try {
    const parsed = JSON.parse((req.headers && req.headers['x-amz-credentials']) || '');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function sendAmz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendAmzError(res, status, type, message) {
  const body = JSON.stringify({ __type: type, message });
  res.writeHead(status, {
    'content-type': AMZ_JSON,
    'content-length': Buffer.byteLength(body),
    'x-amzn-errortype': type,
  });
  res.end(body);
}

/**
 * A framework-native (Hapi/Boom) failure: `{statusCode, error, message}` with NO error
 * `code`, so the client's extractError falls through to `body.error` — the HTTP reason
 * phrase. Joi validation failures reach the source as `Boom.badData(err)` -> HTTP 422
 * (srv-server src/validate.ts:28). Emitted without an `x-amzn-errortype` header, matching
 * Hapi; log.js reproduces the same shape for the Log surface.
 */
export function sendBoom(res, statusCode, message) {
  const body = JSON.stringify({ statusCode, error: STATUS_CODES[statusCode], message });
  res.writeHead(statusCode, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Collect a raw request entity (the CreateUpdate package upload) into one Buffer. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
