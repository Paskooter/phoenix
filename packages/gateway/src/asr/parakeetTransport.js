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

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_DIAGNOSTIC_BYTES = 1024;
const UTF8_ELLIPSIS = '…';
const UTF8_ELLIPSIS_BYTES = Buffer.byteLength(UTF8_ELLIPSIS, 'utf8');

export const PARAKEET_RESPONSE_LIMITS = Object.freeze({
  maxBytes: MAX_RESPONSE_BYTES,
  maxDiagnosticBytes: MAX_RESPONSE_DIAGNOSTIC_BYTES,
});

/**
 * Return a diagnostic prefix whose UTF-8 encoding is no larger than maxBytes.
 * Decode Buffer input before measuring so malformed response bytes become the
 * same bounded replacement characters Node would expose in an Error message.
 * The cut is made on the encoded representation, never in the middle of a
 * multibyte code point.
 */
export function truncateUtf8ByBytes(value, maxBytes) {
  const limit = Math.max(0, Math.floor(Number(maxBytes)) || 0);
  if (limit === 0) return '';
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= limit) return text;

  let end = limit;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}



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
        if (res.statusCode !== 200 && res.statusCode !== 404) {
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
          resolve({ reachable: json?.ok === true, streaming, apiVersion: typeof json?.api_version === 'string' ? json.api_version : undefined,
            ...(json?.ok === true ? {} : { reason: 'not-ready' }) });
        } catch {
          resolve({ reachable: false, streaming: false, reason: 'unparseable' });
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
export function postParakeetWav(parakeetUrl, wav, { timeoutMs = POST_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let res = null;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
    };
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const fail = (err) => settle(reject, err);
    const abort = () => {
      const error = signal.reason || new Error('Parakeet request aborted');
      fail(error);
      req?.destroy(error);
      res?.destroy(error);
    };
    if (signal?.aborted) { fail(signal.reason || new Error('Parakeet request aborted')); return; }

    try {
      const parsed = new URL(parakeetUrl);
      const boundary = '----jiboparakeet' + Date.now() + Math.floor(Math.random() * 1e9).toString(16);
      const head = Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        + 'Content-Type: audio/wav\r\n\r\n');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, wav, tail]);

      req = http.request({
        method: 'POST',
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 80,
        path: '/transcribe',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (response) => {
        res = response;
        const bufs = [];
        let responseBytes = 0;
        let responseEnded = false;
        const rejectOversized = (declaredBytes) => {
          const detail = Number.isSafeInteger(declaredBytes) ? ` (declared ${declaredBytes} bytes)` : '';
          const error = new Error(`Parakeet response exceeded ${MAX_RESPONSE_BYTES} bytes${detail}`);
          error.code = 'ERR_PARAKEET_RESPONSE_TOO_LARGE';
          // Stop both directions. In particular, destroying only the response
          // leaves the request/socket alive until the peer times out.
          fail(error);
          try { req?.destroy(error); } catch { /* already closed */ }
          try { res?.destroy(error); } catch { /* already closed */ }
        };
        res.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            rejectOversized(responseBytes);
            return;
          }
          bufs.push(chunk);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Parakeet response was aborted')));
        res.on('close', () => {
          if (!responseEnded && !settled) fail(new Error('Parakeet response closed before completion'));
        });
        res.on('end', () => {
          responseEnded = true;
          const text = Buffer.concat(bufs).toString('utf8');
          if (res.statusCode !== 200) {
            const textBytes = Buffer.byteLength(text, 'utf8');
            const truncated = textBytes > MAX_RESPONSE_DIAGNOSTIC_BYTES;
            const diagnostic = truncateUtf8ByBytes(
              text,
              truncated ? MAX_RESPONSE_DIAGNOSTIC_BYTES - UTF8_ELLIPSIS_BYTES : MAX_RESPONSE_DIAGNOSTIC_BYTES,
            );
            const suffix = truncated ? UTF8_ELLIPSIS : '';
            fail(new Error(`Parakeet returned ${res.statusCode}: ${diagnostic}${suffix}`));
            return;
          }
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
            settle(resolve, { text: transcript, confidence });
          } catch (error) {
            fail(new Error('Could not parse Parakeet response: ' + error));
          }
        });
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          rejectOversized(declaredLength);
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Parakeet request timed out')); });
      req.on('error', fail);
      req.write(body);
      req.end();
    } catch (error) {
      // A synchronous write/setup failure can otherwise leave the request
      // socket alive even though the promise has rejected.
      try { if (req) req.destroy(error); } catch { /* already closed */ }
      try { if (res) res.destroy(error); } catch { /* already closed */ }
      fail(error);
    }
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
  const controller = new AbortController();
  return {
    name: 'parakeet',
    url: parakeetUrl,
    probe: () => probeParakeet(parakeetUrl, { timeoutMs: probeTimeoutMs }),
    openStream: () => openParakeetStream(parakeetUrl),
    recognizeWav: (wav) => postParakeetWav(parakeetUrl, wav, { timeoutMs: postTimeoutMs, signal: controller.signal }),
    cancel: () => controller.abort(new Error('Parakeet request aborted')),
  };
}
