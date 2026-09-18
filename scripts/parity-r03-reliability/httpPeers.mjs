import http from 'node:http';
import { once } from 'node:events';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeoutMs = 3000, pollMs = 5, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A real loopback HTTP peer. A held response keeps the fetch promise and its
 * TCP connection observable after Phoenix's wall-clock timeout or WS close.
 */
export async function startJsonPeer({
  name,
  response,
  responseStatus = 200,
  hold = false,
  path,
  responseDelayMs = 0,
} = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const record = {
      name,
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      startedAt: Date.now(),
      body: null,
      requestEndedAt: null,
      responseSentAt: null,
      responseFinishedAt: null,
      responseClosedAt: null,
      requestAbortedAt: null,
      socketClosedAt: null,
      releasedAt: null,
      release: null,
      socketOpenAtStart: !req.socket.destroyed,
    };
    record.socket = req.socket;
    requests.push(record);

    const chunks = [];
    let settled = false;
    const release = deferred();
    record.release = () => {
      record.releasedAt = Date.now();
      release.resolve();
    };
    req.on('aborted', () => { record.requestAbortedAt = Date.now(); });
    req.on('close', () => {
      if (req.aborted) record.requestAbortedAt ||= Date.now();
    });
    res.on('finish', () => { record.responseFinishedAt = Date.now(); });
    res.on('close', () => { record.responseClosedAt ||= Date.now(); });
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      record.requestEndedAt = Date.now();
      const raw = Buffer.concat(chunks).toString('utf8');
      try { record.body = raw ? JSON.parse(raw) : null; }
      catch (error) { record.bodyError = error.message; }
      try {
        const shouldHold = typeof hold === 'function' ? await hold(record) : hold;
        if (shouldHold) await release.promise;
        if (responseDelayMs) await sleep(responseDelayMs);
        if (res.destroyed || res.writableEnded) return;
        const value = typeof response === 'function' ? await response(record) : response;
        const encoded = Buffer.from(JSON.stringify(value));
        res.writeHead(responseStatus, {
          'content-type': 'application/json',
          'content-length': String(encoded.length),
          connection: 'close',
        });
        record.responseSentAt = Date.now();
        res.end(encoded);
      } catch (error) {
        if (!settled && !res.destroyed && !res.writableEnded) {
          settled = true;
          res.destroy(error);
        }
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      for (const record of requests) {
        if (record.socket === socket) record.socketClosedAt ||= Date.now();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    name,
    server,
    requests,
    sockets,
    url: `http://127.0.0.1:${port}${path || '/v1/peer'}`,
    get activeSocketCount() { return sockets.size; },
    release(index = 0) {
      const record = requests[index];
      if (!record) throw new Error(`${name}: no request ${index} to release`);
      record.release();
    },
    async close() {
      for (const record of requests) record.release?.();
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };
}

export function parserResponse(intent = 'launchTest') {
  return { data: { intent, rules: ['launch'], entities: {} } };
}

export function skillResponse(skillID = 'fixture-skill') {
  return {
    type: 'SKILL_ACTION',
    msgID: 'r03-http-peer',
    ts: 1700000000000,
    data: { skill: { id: skillID, session: { id: 'r03-http-session' } }, action: { kind: 'held' } },
  };
}
