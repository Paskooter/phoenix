// Synthetic test credentials come from the test's own Store.
import { signSigV4 } from '@phoenix/common';
export function signedLoopHeaders(store, base, target, body, accessKeyId, extraHeaders = {}) {
  const headers = {
    host: new URL(base).host,
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...extraHeaders,
  };
  if (!accessKeyId) return headers;
  const account = store.accountByAccessKeyId(accessKeyId);
  return signSigV4({
    method: 'POST', path: '/', body: body === undefined ? '' : JSON.stringify(body), headers,
    accessKeyId, secretAccessKey: account?.secretAccessKey || 'invented-unknown-key-secret',
    region: 'global', service: 'jibo',
  }).headers;
}
