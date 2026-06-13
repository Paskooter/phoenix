// Classic-service prefix router — the robot's single front door. The robot resolves EVERY
// server-client service to one host (region -> https://<region>.jibo.com) and distinguishes
// them by the X-Amz-Target prefix. This router dispatches POST / by that prefix to either an
// in-process handler (lightweight stateless services: log, robot, …) or an upstream proxy
// (stateful services that own a store: OOBE_* -> account, Update_* -> ota).
//
// A registration is { match: RegExp|string, handler?, proxyTo?: () => baseUrl }.
//   - match: tested against the target PREFIX, case-insensitively
//   - handler({ req, res, body, target, op, log }): answers in-process
//   - proxyTo: returns the upstream base URL; the request is forwarded verbatim

import { sendJson } from '@phoenix/common';
import { parseTarget, sendAmzError, UnknownOperation, AMZ_JSON } from './awsJson.js';

export function createClassicRouter(registrations) {
  const regs = registrations.map((r) => ({
    ...r,
    re: r.match instanceof RegExp ? r.match : new RegExp(`^${String(r.match)}`, 'i'),
  }));

  return {
    'POST /': async ({ req, res, body, log }) => {
      const { target, prefix, op } = parseTarget(req);
      const reg = regs.find((r) => r.re.test(prefix));
      if (!reg) {
        log.warn('classic: no service for target', { target: target || '(none)' });
        return void sendAmzError(res, UnknownOperation, `no classic service for target ${target || '(none)'}`);
      }
      if (reg.handler) return reg.handler({ req, res, body: body || {}, target, op, log });
      return proxy(reg.proxyTo(), req, res, body, log);
    },
  };
}

async function proxy(baseUrl, req, res, body, log) {
  if (!baseUrl) return void sendJson(res, 502, { error: 'classic: upstream not configured' });
  const base = /^https?:\/\//.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || AMZ_JSON,
        'x-amz-target': req.headers['x-amz-target'] || '',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    const text = await upstream.text();
    const headers = { 'content-type': upstream.headers.get('content-type') || AMZ_JSON, 'content-length': Buffer.byteLength(text) };
    const errType = upstream.headers.get('x-amzn-errortype');
    if (errType) headers['x-amzn-errortype'] = errType;
    res.writeHead(upstream.status, headers);
    res.end(text);
  } catch (err) {
    log.error('classic: proxy failed', { error: err.message, base });
    sendJson(res, 502, { error: `upstream unreachable: ${err.message}` });
  }
}
