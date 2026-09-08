// Public photo ingress for the Classic front door. Account owns the local object
// store; Classic only forwards the byte stream so a returned URL can use the
// robot-reachable TLS/public origin.
import http from 'node:http';
import https from 'node:https';
import { sendJson } from '@phoenix/common';

const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
];

function upstreamTimeoutMs() {
  const configured = Number(process.env.ETCO_classic_upstreamTimeoutMS);
  if (!Number.isFinite(configured) || configured <= 0) return 10_000;
  return Math.min(Math.floor(configured), 60_000);
}

function upstreamBaseUrl(value) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function sendFailure(res, status, message) {
  if (res.headersSent || res.destroyed) return;
  sendJson(res, status, { error: message });
}

/**
 * Forward one public photo download to Account without parsing or rewriting
 * the object bytes. The public URL is supplied by Account's configured photo
 * base URL; this hop deliberately does not forward caller authorization.
 */
export function proxyMemberPhoto({ baseUrl, key, req, res, log }) {
  const base = upstreamBaseUrl(baseUrl);
  if (!base) {
    sendFailure(res, 502, 'classic: photo upstream not configured');
    return Promise.resolve();
  }

  let target;
  try {
    target = new URL(`/member-photos/${encodeURIComponent(String(key || ''))}`, base);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`unsupported photo upstream protocol ${target.protocol}`);
  } catch (error) {
    sendFailure(res, 502, `classic: invalid photo upstream: ${error.message}`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const transport = target.protocol === 'https:' ? https : http;
    const timeout = upstreamTimeoutMs();
    let upstreamRequest;
    let upstreamResponse;
    let deadline;
    let settled = false;
    const clear = () => { if (deadline) clearTimeout(deadline); deadline = undefined; };
    const complete = () => {
      if (settled) return;
      settled = true;
      clear();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clear();
      log?.error?.('classic: photo proxy failed', { error: error?.message || String(error) });
      if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
      if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy(error);
      if (res.headersSent) {
        // The byte stream may fail after the status/headers have gone out. At
        // that point a JSON error would corrupt the object, so terminate the
        // downstream response instead of appending an error body.
        if (!res.destroyed && !res.writableEnded) res.destroy();
      } else {
        sendFailure(res, 502, `upstream photo unavailable: ${error?.message || String(error)}`);
      }
      resolve();
    };

    res.once('finish', complete);
    res.once('error', fail);
    res.once('close', () => {
      if (!res.writableEnded) fail(new Error('public photo response closed'));
    });
    deadline = setTimeout(() => fail(new Error(`photo upstream deadline exceeded after ${timeout}ms`)), timeout);
    try {
      upstreamRequest = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { accept: req.headers.accept || '*/*' },
      }, (response) => {
        upstreamResponse = response;
        const headers = {};
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          if (response.headers[name] !== undefined) headers[name] = response.headers[name];
        }
        if (res.headersSent || res.destroyed) return fail(new Error('photo response already started'));
        res.writeHead(response.statusCode || 502, headers);
        response.on('aborted', () => fail(new Error('photo upstream response aborted')));
        response.on('error', fail);
        response.on('end', clear);
        response.pipe(res);
      });
      upstreamRequest.setTimeout(timeout, () => fail(new Error(`photo upstream timeout after ${timeout}ms`)));
      upstreamRequest.on('error', fail);
      req.once('aborted', () => {
        if (!upstreamRequest.destroyed) upstreamRequest.destroy(new Error('public photo request aborted'));
      });
      upstreamRequest.end();
    } catch (error) {
      fail(error);
    }
  });
}
