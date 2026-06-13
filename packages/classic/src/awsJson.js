// AWS-JSON-1.1 wire helpers shared by the classic-service entrypoint — the canonical home of
// the envelope pattern first written in packages/ota and packages/account. The robot's
// @jibo/jibo-server-client (an aws-sdk-js fork) speaks this for every classic service:
//
//   POST /                                   Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <Prefix>.<Operation>       e.g. Log_20150309.PutEvents
//   Authorization: AWS4-HMAC-SHA256 …        (SigV4 — NOT verified; LAN trust like the hub)
//   body: JSON of the operation input members
//
//   success: 200, JSON of the output shape
//   error:   non-2xx, {"__type":"<Code>","message":"…"} + x-amzn-errortype header

export const AMZ_JSON = 'application/x-amz-json-1.1';

/** "<Prefix>.<Operation>" -> { prefix, op } ('' when the header is absent/odd). */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return { target: t, prefix: dot >= 0 ? t.slice(0, dot) : '', op: dot >= 0 ? t.slice(dot + 1) : t };
}

/** SigV4 "Credential=<accessKeyId>/<date>/…" -> accessKeyId (the only part we read). */
export function accessKeyIdFromAuth(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const m = /Credential=([^/,\s]+)\//.exec(auth);
  return m ? m[1] : null;
}

export function sendAmz(res, status, obj) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** @param {{code:string, statusCode:number, message?:string}} err */
export function sendAmzError(res, err, message) {
  const body = JSON.stringify({ __type: err.code, message: message || err.message || err.code });
  res.writeHead(err.statusCode || 400, {
    'content-type': AMZ_JSON,
    'content-length': Buffer.byteLength(body),
    'x-amzn-errortype': err.code,
  });
  res.end(body);
}

export const UnknownOperation = { code: 'UnknownOperationException', statusCode: 400 };
export const ValidationException = { code: 'ValidationException', statusCode: 400 };
