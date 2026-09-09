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

import http from 'node:http';
import https from 'node:https';
import { sendJson } from '@phoenix/common';
import { parseTarget, sendAmzError, UnknownOperation, AMZ_JSON } from './awsJson.js';

export function createClassicRouter(registrations) {
  const regs = registrations.map((r) => ({
    ...r,
    re: r.match instanceof RegExp ? r.match : new RegExp(`^${String(r.match)}`, 'i'),
  }));

  const dispatch = async ({ req, res, body, log }) => {
    const { target, prefix, op } = parseTarget(req);
    const reg = regs.find((r) => r.re.test(prefix));
    // Log every inbound classic call (handlers are otherwise silent on success) so a robot's
    // wipe/backup traffic is visible: what target it sent and whether we route it.
    log.info('classic request', { target: target || '(none)', op, matched: reg ? (reg.handler ? 'in-process' : 'proxy') : 'NONE' });
    if (!reg) {
      log.warn('classic: no service for target', { target: target || '(none)' });
      return void sendAmzError(res, UnknownOperation, `no classic service for target ${target || '(none)'}`);
    }
    if (reg.handler) return reg.handler({ req, res, body: reg.preserveBody ? body : (body || {}), target, op, log });
    return proxy(reg.proxyTo(), req, res, body, log);
  };
  // The Hapi-backed Account CreateHubToken route validates an omitted payload
  // as null; preserve the historical object default for other Classic routes.
  dispatch.rawBody = (req) => /^Loop[^.]*\.UpdateMemberPhoto$/i.test(String(req.headers['x-amz-target'] || ''));
  dispatch.bodyDefault = (req) => {
    const { prefix, op } = parseTarget(req);
    const reg = regs.find((entry) => entry.re.test(prefix));
    if (reg && Object.prototype.hasOwnProperty.call(reg, 'bodyDefault')) return reg.bodyDefault;
    if (/^account/i.test(prefix) || op.toLowerCase() === 'createhubtoken') return null;
    return {};
  };

  return {
    'POST /': dispatch,
  };
}

async function proxy(baseUrl, req, res, body, log) {
  if (!baseUrl) return void sendJson(res, 502, { error: 'classic: upstream not configured' });
  const base = /^https?:\/\//.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  try {
    const contentEncoding = unsupportedContentEncoding(req.headers);
    if (contentEncoding) {
      return void sendAmzError(res, {
        code: 'UnsupportedMediaTypeException',
        message: `classic: cannot forward compressed request entity (${contentEncoding}) without its original bytes`,
        statusCode: 415,
      });
    }
    const requestBody = /^Loop[^.]*\.UpdateMemberPhoto$/i.test(String(req.headers['x-amz-target'] || '')) ? req : req.rawBody === undefined
      ? (body === null || body === undefined ? '' : JSON.stringify(body))
      : req.rawBody;
    // Native http.request is used here because undici/fetch deliberately
    // rewrites the Host header to the upstream URL. The original gateway
    // verifier signs the entrypoint host; retaining it across this direct
    // Phoenix hop lets the account service verify the same signature.
    const upstream = await requestUpstream(`${base.replace(/\/$/, '')}/`, requestBody, forwardHeaders(req.headers));
    const text = upstream.body.toString('utf8');
    const headers = { 'content-type': upstream.headers['content-type'] || AMZ_JSON, 'content-length': Buffer.byteLength(text) };
    if (requestBody === req && upstream.headers.connection === 'close') headers.connection = 'close';
    if (upstream.status === 422) {
      headers.connection = res.shouldKeepAlive ? 'keep-alive' : 'close';
      if (upstream.headers['cache-control']) headers['cache-control'] = upstream.headers['cache-control'];
      if (upstream.headers.vary) headers.vary = upstream.headers.vary;
      // Account's Hapi/Boom response has no Express identity header. Remove
      // the outer Classic app's default before writing this proxied error.
      res.removeHeader('x-powered-by');
      res.removeHeader('keep-alive');
    }
    const errType = upstream.headers['x-amzn-errortype'];
    if (errType) headers['x-amzn-errortype'] = errType;
    res.writeHead(upstream.status, headers);
    res.end(text);
  } catch (err) {
    log.error('classic: proxy failed', { error: err.message, base });
    sendJson(res, 502, { error: `upstream unreachable: ${err.message}` });
  }
}

function requestUpstream(url, body, headers) {
  const target = new URL(url);
  const streaming = body && typeof body.pipe === 'function';
  const payload = streaming ? body : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const requestHeaders = streaming
    ? { ...headers, ...(body.headers?.['content-length'] !== undefined ? { 'content-length': body.headers['content-length'] } : {}) }
    : { ...headers, 'content-length': payload.length };
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMS = upstreamTimeoutMS();
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    let deadline;
    const clearDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    deadline = setTimeout(() => {
      const error = new Error(`upstream request deadline exceeded after ${timeoutMS}ms`);
      rejectOnce(error);
      if (response && !response.destroyed) response.destroy();
      if (request && !request.destroyed) request.destroy(error);
    }, timeoutMS);
    try {
      request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'POST',
        path: `${target.pathname || '/'}${target.search || ''}`,
        headers: requestHeaders,
      }, (upstreamResponse) => {
        response = upstreamResponse;
        const chunks = [];
        upstreamResponse.on('data', (chunk) => chunks.push(chunk));
        upstreamResponse.on('aborted', () => {
          upstreamResponse.destroy();
          rejectOnce(new Error('upstream response aborted'));
        });
        upstreamResponse.on('end', () => resolveOnce({
          status: upstreamResponse.statusCode || 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks),
        }));
        upstreamResponse.on('error', rejectOnce);
      });
      request.setTimeout(timeoutMS, () => {
        request.destroy(new Error(`upstream request timeout after ${timeoutMS}ms`));
      });
      request.on('error', rejectOnce);
      if (streaming) { request.flushHeaders(); payload.on('error', (error) => request.destroy(error)); payload.pipe(request); }
      else request.end(payload);
    } catch (error) {
      rejectOnce(error);
      if (response && !response.destroyed) response.destroy();
      if (request && !request.destroyed) request.destroy(error);
    }
  });
}

function upstreamTimeoutMS() {
  const configured = Number(process.env.ETCO_classic_upstreamTimeoutMS);
  if (!Number.isFinite(configured) || configured <= 0) return 10_000;
  return Math.min(Math.floor(configured), 60_000);
}

function unsupportedContentEncoding(headers = {}) {
  const value = headers['content-encoding'];
  if (value === undefined || value === null) return null;
  const encodings = (Array.isArray(value) ? value.join(',') : String(value))
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return encodings.find((encoding) => encoding !== 'identity') || null;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
  'content-length',
]);

function forwardHeaders(headers = {}) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || value === undefined) continue;
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (!forwarded['content-type'] && !forwarded['Content-Type']) forwarded['content-type'] = AMZ_JSON;
  if (!forwarded['x-amz-target'] && !forwarded['X-Amz-Target']) forwarded['x-amz-target'] = '';
  return forwarded;
}
