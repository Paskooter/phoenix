// Shared AWS-JSON helpers for the Loop public face. Kept out of robotFace.js so
// membership handlers can send the same envelopes without a circular import.

export const AMZ_JSON = 'application/x-amz-json-1.1';

export function sendAmz(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': AMZ_JSON, 'content-length': Buffer.byteLength(body) });
  res.end(body);
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

export function accessKeyIdFromAuth(req) {
  const auth = (req.headers && req.headers.authorization) || '';
  const m = /Credential=([^/,\s]+)\//.exec(auth);
  return m ? m[1] : null;
}
