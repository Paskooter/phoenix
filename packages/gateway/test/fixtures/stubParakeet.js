// A local Parakeet stand-in for failover tests: GET /healthz, POST /transcribe
// and WS /stream, each scriptable. Same protocol as services/parakeet-asr.
//
//   opts.healthz   'streaming' (default) | 'old' (API 0.1.0) | 500 | false (404)
//   opts.streaming attach WS /stream (default true)
//   opts.batch     {text, confidence} for POST /transcribe, or {status} to fail
//   opts.final     {text, confidence} answered to a stream `eos`
//   opts.onBinary(conn, socket), opts.onEos(conn, socket)  custom behaviour

import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

export async function startStubParakeet(opts = {}, port = 0) {
  const { streaming = true, healthz = 'streaming', batch = { text: 'batch words', confidence: 0.55 } } = opts;
  const state = { healthz: 0, transcribe: [], connections: [] };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      state.healthz += 1;
      req.resume();
      req.on('end', () => {
        if (healthz === 500) { res.writeHead(500); res.end(); return; }
        if (healthz === false) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(healthz === 'old'
          ? { ok: true, api_version: '0.1.0' }
          : { ok: true, api_version: '0.2.1', sample_rate: 16000 }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/transcribe') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        state.transcribe.push(body);
        if (batch.status) { res.writeHead(batch.status); res.end('stub failure'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transcript: { text: batch.text }, confidence: batch.confidence }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let wss = null;
  if (streaming) {
    wss = new WebSocketServer({ server, path: '/stream' });
    wss.on('connection', (socket) => {
      const conn = { socket, binary: [], controls: [], bytes: 0 };
      state.connections.push(conn);
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          conn.bytes += data.length;
          conn.binary.push(Buffer.from(data));
          opts.onBinary?.(conn, socket, state);
          return;
        }
        const msg = JSON.parse(data.toString());
        conn.controls.push(msg);
        if (msg.type === 'eos') {
          if (opts.onEos) opts.onEos(conn, socket, state);
          else if (opts.final) socket.send(JSON.stringify({ type: 'final', ...opts.final }));
        }
      });
    });
  }
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  state.port = server.address().port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = async () => {
    for (const conn of state.connections) {
      try { conn.socket.terminate(); } catch { /* already gone */ }
    }
    if (wss) await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return state;
}

/** A local URL on which nothing listens (connection refused). */
export async function unusedUrl() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return { url: `http://127.0.0.1:${port}`, port };
}

/** The PCM inside the multipart WAV the session posts. */
export function wavPcm(body) {
  const offset = body.indexOf(Buffer.from('RIFF'));
  const size = body.readUInt32LE(offset + 40);
  return body.subarray(offset + 44, offset + 44 + size);
}
