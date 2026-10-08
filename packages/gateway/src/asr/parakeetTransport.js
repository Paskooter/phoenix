// The Parakeet recognizer transport: how ParakeetASRSession reaches the
// Parakeet server. Moved out of parakeetSession.js unchanged so that a
// failover transport can drive the same three operations:
//
//   GET  /healthz     capability probe (API >= 0.2.0 offers WS /stream)
//   WS   /stream      streaming recognition: {"type":"start"}, PCM, {"type":"eos"}
//   POST /transcribe  batch recognition of a WAV, multipart field "file"
//
// probeParakeet() reports more than the boolean the session needs: whether the
// server answered at all. A 0.1.0 server (no /healthz) is reachable but cannot
// stream; a refused connection, a timeout or a 5xx is unreachable, which is what
// a failover transport treats as "Parakeet is down".

import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';

export const STREAMING_API_VERSION = '0.2.0';
export const HEALTH_TIMEOUT_MS = 3000;
export const POST_TIMEOUT_MS = 30000;

/** True when `version` (e.g. "0.2.0") is at least `minimum` (e.g. "0.2.0"). */
export function apiVersionAtLeast(version, minimum) {
  const parse = (value) => String(value).split('.').map((part) => parseInt(part, 10) || 0);
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(actual.length, required.length); i += 1) {
    const a = actual[i] || 0;
    const b = required[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Probe `/healthz` once.
 * @returns {Promise<{reachable: boolean, streaming: boolean, apiVersion?: string, reason?: string}>}
 *   `streaming` is true only for a 200 `{ok:true, api_version >= 0.2.0}` answer --
 *   exactly the condition the session has always used.
 */
export function probeParakeet(parakeetUrl, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(parakeetUrl);
    } catch {
      resolve({ reachable: false, streaming: false, reason: 'invalid-url' });
      return;
    }
    const secure = parsed.protocol === 'https:';
    const transport = secure ? https : http;
    const port = parsed.port ? parseInt(parsed.port, 10) : (secure ? 443 : 80);
    const req = transport.request({
      method: 'GET',
      host: parsed.hostname,
      port,
      path: '/healthz',
      timeout: timeoutMs,
      agent: false,
      headers: { connection: 'close' },
    }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode >= 500) {
          resolve({ reachable: false, streaming: false, reason: `status-${res.statusCode}` });
          return;
        }
        if (res.statusCode !== 200) {
          // A 0.1.0 server has no /healthz: it answers, it just cannot stream.
          resolve({ reachable: true, streaming: false, reason: `status-${res.statusCode}` });
          return;
        }
        try {
          const json = JSON.parse(Buffer.concat(bufs).toString('utf8'));
          const streaming = json?.ok === true
            && typeof json?.api_version === 'string'
            && apiVersionAtLeast(json.api_version, STREAMING_API_VERSION);
          resolve({ reachable: true, streaming, apiVersion: typeof json?.api_version === 'string' ? json.api_version : undefined });
        } catch {
          resolve({ reachable: true, streaming: false, reason: 'unparseable' });
        }
      });
      res.on('error', () => resolve({ reachable: false, streaming: false, reason: 'response-error' }));
    });
    req.on('timeout', () => { req.destroy(new Error('Parakeet /healthz timed out')); });
    req.on('error', (err) => resolve({
      reachable: false,
      streaming: false,
      reason: /timed out/.test(err?.message || '') ? 'timeout' : (err?.code || 'error'),
    }));
    req.end();
  });
}

/** Open the `/stream` WebSocket. Throws when the URL cannot be used. */
export function openParakeetStream(parakeetUrl) {
  const url = new URL(parakeetUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/stream';
  url.search = '';
  url.hash = '';
  return new WebSocket(url.toString());
}

/**
 * POST a WAV to `/transcribe`. Resolves `{text, confidence}`; confidence is
 * null when the server reports none (API 0.1.0, or NeMo without confidence).
 */
export function postParakeetWav(parakeetUrl, wav, { timeoutMs = POST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(parakeetUrl);
    const boundary = '----jiboparakeet' + Date.now() + Math.floor(Math.random() * 1e9).toString(16);
    const head = Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
      + 'Content-Type: audio/wav\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, wav, tail]);

    const req = http.request({
      method: 'POST',
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 80,
      path: '/transcribe',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`Parakeet returned ${res.statusCode}: ${text}`));
        try {
          const json = JSON.parse(text);
          let transcript = json.transcript;
          // The server may report a real decoder confidence. Older
          // deployments (API 0.1.0) do not, and NeMo leaves every confidence
          // field null unless the decoding config asks for them, which is why
          // this client used to invent 1.0 -- a constant that reached the
          // robot looking like a measurement (DIVERGENCES H07c).
          let confidence = typeof json.confidence === 'number' ? json.confidence : null;
          if (transcript && typeof transcript === 'object') {
            if (confidence === null && typeof transcript.confidence === 'number') {
              confidence = transcript.confidence;
            }
            transcript = transcript.text;
          }
          if (typeof transcript !== 'string') transcript = '';
          resolve({ text: transcript, confidence });
        } catch (e) {
          reject(new Error('Could not parse Parakeet response: ' + e));
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Parakeet request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * A transport object over one Parakeet server, for composition (failover).
 * ParakeetASRSession's default path calls the functions above directly.
 */
export function createParakeetTransport(parakeetUrl, {
  probeTimeoutMs = HEALTH_TIMEOUT_MS,
  postTimeoutMs = POST_TIMEOUT_MS,
} = {}) {
  return {
    name: 'parakeet',
    url: parakeetUrl,
    probe: () => probeParakeet(parakeetUrl, { timeoutMs: probeTimeoutMs }),
    openStream: () => openParakeetStream(parakeetUrl),
    recognizeWav: (wav) => postParakeetWav(parakeetUrl, wav, { timeoutMs: postTimeoutMs }),
  };
}
