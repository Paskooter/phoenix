// Minimal AWS-JSON-1.1 wire helpers — exactly what the robot's @jibo/jibo-server-client
// (an aws-sdk-js fork) emits and parses for the Update service.
//
// Request  (jibo-server-client lib/protocol/json.js buildRequest):
//   POST <endpoint>/                 (globalEndpoint = https://<region>.jibo.com)
//   Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: <targetPrefix>.<OperationName>   e.g. Update_20160301.GetUpdateFrom
//   Authorization: AWS4-HMAC-SHA256 …               (SigV4 — we do NOT verify; like the hub's DISABLE_AUTH)
//   body: JSON of the operation's input members      e.g. {"fromVersion":"3.3.4","subsystem":"os"}
//
// Response (lib/protocol/json.js extractData / extractError):
//   success: 200, body = JSON of the output shape (an Update object, or a list of them)
//   error:   non-2xx, body = {"__type": "<Code>", "message": "<msg>"} (+ x-amzn-errortype header)

export const AMZ_JSON = 'application/x-amz-json-1.1';

/** Operation name from the X-Amz-Target header: "Update_20160301.GetUpdateFrom" -> "GetUpdateFrom". */
export function parseTarget(req) {
  const t = (req.headers && req.headers['x-amz-target']) || '';
  const dot = t.lastIndexOf('.');
  return dot >= 0 ? t.slice(dot + 1) : t;
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
