// Zero-dependency HTTP service runner — the Phoenix equivalent of the reference BaseService
// (docs/atlas/message-protocol.md §1, BaseService.ts:41-126).
//
// Every service gets:
//   - GET /healthcheck -> 200 "ok" (free, BaseService.ts:123-126)
//   - JSON request body parsing
//   - trace-header extraction + a request-scoped logger
//   - a uniform ERROR envelope on unknown routes (404) and thrown handlers (500)
//
// Routes are keyed "METHOD /path". A handler receives { req, res, url, body, trace, log }
// and returns a JSON-serializable value (sent as 200) — or writes to `res` itself and
// returns undefined. WebSocket support (the gateway's /v1/listen, /v1/proactive) arrives in
// milestone M6 via the optional `onUpgrade` hook; it is intentionally not built in yet.

import http from 'node:http';
import { errorResponse, HubErrorCode } from '@phoenix/contracts';
import { readTrace } from './headers.js';
import { logger } from './log.js';

/**
 * @param {{
 *   name: string,
 *   routes?: Record<string, (ctx: any) => any>,
 *   onUpgrade?: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void,
 * }} opts
 */
export function createService({ name, routes = {}, onUpgrade } = {}) {
  const log = logger(name);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthcheck') return sendText(res, 200, 'ok');

    const trace = readTrace(req);
    const reqLog = logger(name, trace);
    const handler = routes[`${req.method} ${url.pathname}`];

    if (!handler) {
      reqLog.warn('no route', { method: req.method, path: url.pathname });
      return sendJson(res, 404, errorResponse(`no route ${req.method} ${url.pathname}`, HubErrorCode.NOT_FOUND));
    }

    try {
      const body = await readJson(req);
      const result = await handler({ req, res, url, body, trace, log: reqLog });
      if (!res.writableEnded) sendJson(res, 200, result ?? {});
    } catch (err) {
      reqLog.error('handler threw', { error: err.message });
      if (!res.writableEnded) sendJson(res, 500, errorResponse(err.message, HubErrorCode.INTERNAL));
    }
  });

  if (onUpgrade) server.on('upgrade', onUpgrade);

  return {
    server,
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

// --- response helpers -------------------------------------------------------

export function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Read and JSON-parse a request body (empty body -> null). */
export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}
