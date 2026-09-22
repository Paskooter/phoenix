// Streaming /stream wiring for the Parakeet ASR client (DIVERGENCES H07b).
//
// The batch client buffers a whole utterance and POSTs it once, so it has no
// interim results and can never truncate at an `earlyEOS` trigger word: the hub
// hears "live long and prosper" whole, resolves referenceLiveLongProsper, and
// routes to a skill the original never reached. A streaming-capable Parakeet
// server (API >= 0.2.0, `GET /healthz` + `WS /stream`) produces interims while
// the audio is still arriving; the session surfaces them through the same
// incremental seam the Google session uses, so `fastEOSRegex` can match one and
// finalize early.
//
// These tests pin:
//   * interims are surfaced, in order, through the incremental seam;
//   * an earlyEOS trigger in an INTERIM finalizes the turn early with the
//     truncated text — the actual H07b fix;
//   * a server with no /stream (0.1.0) falls back to batch and still produces a
//     result;
//   * a socket that fails mid-session falls back to batch rather than losing the
//     turn;
//   * the server's confidence is passed through on both paths.
//
// Every server is a local stub; nothing here touches a network or a vendor.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 16 kHz mono 16-bit PCM, 100 ms per chunk. */
function pcmChunk(amplitude, ms = 100) {
  const samples = Math.floor((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
}
const SPEECH = () => pcmChunk(8000); // RMS 8000 >> the 400 VAD threshold
const SILENCE = () => pcmChunk(0);

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for condition');
}

function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`timed out after ${ms}ms`); }),
  ]);
}

/**
 * A Parakeet stand-in.
 *   opts.healthz: 'streaming' (default) | 'old' (0.1.0 payload) | false (404)
 *   opts.streaming: attach the WS /stream endpoint (default true)
 *   opts.batch: {text, confidence} answered by POST /transcribe
 *   opts.final: {text, confidence} answered to a stream `eos` control
 *   opts.onBinary(conn, socket, server): observe/answer a binary audio frame
 *   opts.onConnection(conn, socket, server): observe a new streaming socket
 */
async function startStubServer(opts = {}) {
  const {
    streaming = true,
    healthz = 'streaming',
    batch = { text: 'batch words', confidence: 0.55 },
  } = opts;
  const state = { healthz: 0, transcribe: [], connections: [] };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      state.healthz += 1;
      req.resume();
      req.on('end', () => {
        if (healthz === 'old' || healthz === false) {
          res.writeHead(healthz === 'old' ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(healthz === 'old' ? { ok: true, api_version: '0.1.0' } : {}));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, api_version: '0.2.0', sample_rate: 16000 }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/transcribe') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        state.transcribe.push(Buffer.concat(chunks));
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
      opts.onConnection?.(conn, socket, state);
    });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.url = `http://127.0.0.1:${server.address().port}`;
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

/** Send one scripted interim per 100 ms of audio the server has received. */
function scriptedInterims(script, confidences) {
  return (conn, socket) => {
    const next = conn.sent ?? 0;
    if (next >= script.length) return;
    if (conn.bytes >= (next + 1) * 3200) {
      conn.sent = next + 1;
      socket.send(JSON.stringify({ type: 'interim', text: script[next], confidence: confidences[next] }));
    }
  };
}

test('streaming: interim results are surfaced, in order, through the incremental seam', async () => {
  const script = ['just', 'just in time', 'testing testing', 'testing testing one', 'testing testing one two three'];
  const confidences = [0.3, 0.5, 0.6, 0.8, 0.9478];
  const server = await startStubServer({
    onBinary: scriptedInterims(script, confidences),
    final: { text: 'testing testing one two three', confidence: 0.9478 },
  });
  const session = new ParakeetASRSession(server.url, { lang: 'en-US' }, SILENT_LOG);
  const seen = [];
  session.onResult((result) => seen.push(result));
  const startPr = session.start();
  try {
    await waitFor(() => session.streamingReady);
    for (let i = 0; i < 5; i += 1) session.provideAudio(SPEECH());

    await waitFor(() => seen.length >= script.length);
    assert.deepEqual(seen.map((r) => r.text), script, 'interims arrive in order');
    assert.deepEqual(seen.map((r) => r.confidence), confidences, 'each interim keeps its server confidence');
    assert.equal(session.getLastIncremental().text, script[script.length - 1], 'the incremental seam tracks the latest interim');

    session.stop();
    const result = await withTimeout(startPr);
    assert.equal(result.text, 'testing testing one two three');
    assert.equal(result.confidence, 0.9478, "the server's final confidence is passed through");

    assert.equal(server.connections.length, 1, 'one streaming connection');
    assert.ok(server.connections[0].bytes > 0, 'PCM reached the /stream socket');
    assert.ok(server.connections[0].controls.some((m) => m.type === 'start'), 'sent the start control');
    assert.ok(server.connections[0].controls.some((m) => m.type === 'eos'), 'sent the eos control');
  } finally {
    if (!session.stopped) session.stop();
    await server.close();
  }
});

test('streaming: an earlyEOS trigger in an INTERIM finalizes early with the truncated text (H07b)', async () => {
  // The stub deliberately never answers `eos`: the turn can only end on the
  // matching interim, which is the behavior DIVERGENCES H07b records as missing.
  const server = await startStubServer({
    onBinary: scriptedInterims(['just in time', 'live long and prosper'], [0.4, 0.42]),
  });
  const session = new ParakeetASRSession(server.url, { lang: 'en-US', earlyEOS: ['live'] }, SILENT_LOG);
  const seen = [];
  let eos = 0;
  session.onEndOfSpeech(() => { eos += 1; });
  session.onResult((result) => seen.push(result));
  const startPr = session.start();
  try {
    await waitFor(() => session.streamingReady);
    session.provideAudio(SPEECH());
    session.provideAudio(SPEECH());

    const result = await withTimeout(startPr, 4000);
    assert.equal(result.annotation, 'FAST_EOS');
    assert.equal(result.text, 'live long and prosper', 'the interim at the trigger is the truncated transcript');
    assert.equal(result.confidence, 0.42, 'the triggering interim confidence is preserved');
    assert.equal(eos, 1, 'EOS is emitted before resolving');
    assert.deepEqual(seen, [
      { text: 'just in time', confidence: 0.4 },
      { text: 'live long and prosper', confidence: 0.42, annotation: 'FAST_EOS' },
    ]);
    assert.equal(session.state, 'DONE');
  } finally {
    if (!session.stopped) session.stop();
    await server.close();
  }
});

test('streaming: a 0.1.0 server with no /stream falls back to batch and still produces a result', async () => {
  const server = await startStubServer({
    streaming: false,
    healthz: 'old',
    batch: { text: 'what time is it', confidence: 0.31 },
  });
  const session = new ParakeetASRSession(server.url, { lang: 'en-US' }, SILENT_LOG);
  const startPr = session.start();
  try {
    await waitFor(() => server.healthz > 0, 2000);
    for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());

    const result = await withTimeout(startPr);
    assert.equal(result.text, 'what time is it');
    assert.equal(result.confidence, 0.31, "the old server's batch confidence is passed through");
    assert.equal(server.transcribe.length, 1, 'exactly one batch recognition');
    assert.equal(session.streamingReady, false, 'no stream was opened');
  } finally {
    if (!session.stopped) session.stop();
    await server.close();
  }
});

test('streaming: an empty silence endpoint keeps listening on a reopened stream', async () => {
  // The wake-phrase-tail / empty-endpoint fix must survive the streaming path:
  // a silence endpoint that recognizes no words is a false endpoint, so the
  // session reopens /stream and the real request is still recognized.
  let endings = 0;
  const server = await startStubServer({
    onEos(conn, socket) {
      endings += 1;
      const payload = endings === 1
        ? { type: 'final', text: '', confidence: 0 }
        : { type: 'final', text: 'what time is it', confidence: 0.9 };
      socket.send(JSON.stringify(payload));
    },
  });
  const session = new ParakeetASRSession(server.url, { lang: 'en-US' }, SILENT_LOG);
  let wireEos = 0;
  session.onEndOfSpeech(() => { wireEos += 1; });
  const startPr = session.start();
  try {
    await waitFor(() => session.streamingReady);
    // False endpoint: speech that recognizes nothing, then trailing silence.
    for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());
    await waitFor(() => session.relistenCount === 1, 3000);
    assert.equal(wireEos, 0, 'a false endpoint must not tell the robot to stop streaming');
    await waitFor(() => session.streamingReady, 3000);

    // The real request, spoken after the pause.
    for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());

    const result = await withTimeout(startPr);
    assert.equal(result.text, 'what time is it', 'the turn resolves with the utterance that had words');
    assert.equal(result.confidence, 0.9);
    assert.equal(wireEos, 1, 'the confirmed utterance sends one EOS');
    assert.ok(server.connections.length >= 2, 'a fresh stream was opened after the empty endpoint');
  } finally {
    if (!session.stopped) session.stop();
    await server.close();
  }
});

test('streaming: a socket that fails mid-session falls back to batch rather than losing the turn', async () => {
  const server = await startStubServer({
    batch: { text: 'recovered utterance', confidence: 0.66 },
    onBinary(conn, socket) {
      if (conn.bytes >= 3200 && !conn.killed) {
        conn.killed = true;
        socket.terminate(); // the /stream socket dies after 100 ms of audio
      }
    },
  });
  const session = new ParakeetASRSession(server.url, { lang: 'en-US' }, SILENT_LOG);
  const startPr = session.start();
  try {
    await waitFor(() => session.streamingReady);
    session.provideAudio(SPEECH());
    session.provideAudio(SPEECH());
    await waitFor(() => session.streamingFailed, 2000);

    // Finish the utterance; the buffered PCM must still be recognizable.
    session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());

    const result = await withTimeout(startPr);
    assert.equal(result.text, 'recovered utterance');
    assert.equal(result.confidence, 0.66, 'batch confidence is passed through after the stream fails');
    assert.equal(server.transcribe.length, 1, 'the fallback used batch /transcribe');
  } finally {
    if (!session.stopped) session.stop();
    await server.close();
  }
});
