// Shared AWS-JSON helpers for the Loop public face. Kept out of robotFace.js so
// membership handlers can send the same envelopes without a circular import.

export const AMZ_JSON = 'application/x-amz-json-1.1';

export function sendAmz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendAmzEmpty(res, status = 200) {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
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

// @jibo/server's Boom.badData response used by the source Hapi handlers.
// Keep this shared so every AWS-facing Joi boundary emits the same headers.
export function sendValidationError(res, message) {
  const body = JSON.stringify({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
  });
  res.removeHeader('x-powered-by');
  res.removeHeader('keep-alive');
  res.writeHead(422, {
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(body);
}

export function accessKeyIdFromAuth(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const m = /Credential=([^/,\s]+)\//.exec(auth);
  return m ? m[1] : null;
}
