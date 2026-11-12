// A local stand-in for OpenAI-compatible transcription servers: OpenRouter's
// JSON `/api/v1/audio/transcriptions` and a self-hosted multipart
// `/v1/audio/transcriptions`. Synthetic only; it never contacts a provider.
//
//   reply(request, state) -> {status=200, json, raw, headers, delayMs}
//
// Every request is recorded with its headers and raw body so tests can check
// the exact body shape and which key (if any) was sent.

import http from 'node:http';
import { once } from 'node:events';

export async function startStubTranscriptions(reply = () => ({ json: { text: '' } })) {
  const state = { requests: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      state.requests.push(request);
      const answer = reply(request, state) || {};
      const send = () => {
        if (res.destroyed) return;
        const body = answer.raw !== undefined ? Buffer.from(answer.raw) : Buffer.from(JSON.stringify(answer.json ?? {}));
        res.writeHead(answer.status || 200, { 'content-type': 'application/json', ...(answer.headers || {}) });
        res.end(body);
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs).unref?.();
      else send();
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    get requests() { return state.requests; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Parse a multipart/form-data body into {name: {filename, contentType, value:Buffer}}. */
export function parseMultipart(request) {
  const type = String(request.headers['content-type'] || '');
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!boundary) throw new Error(`not multipart: ${type}`);
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const parts = {};
  let start = request.body.indexOf(marker);
  while (start !== -1) {
    const next = request.body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = request.body.subarray(start + marker.length + 2, next - 2); // skip CRLF after marker, CRLF before next
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const value = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? null;
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
    if (name) parts[name] = { filename, contentType, value };
    start = next;
  }
  return parts;
}

/**
 * fetch() that sends requests addressed to https://openrouter.ai to the stub,
 * keeping method, headers and body. Records every URL the transport chose.
 */
export function redirectingFetch(stubUrl) {
  const urls = [];
  const fetchImpl = (url, init) => {
    urls.push(String(url));
    const parsed = new URL(url);
    if (parsed.hostname !== 'openrouter.ai') throw new Error(`unexpected destination ${parsed.origin}`);
    return fetch(`${stubUrl}${parsed.pathname}${parsed.search}`, init);
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}
