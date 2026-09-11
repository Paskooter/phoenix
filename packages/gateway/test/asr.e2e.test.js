// H-07: original ASR behavior through a replaceable provider — RUNTIME proof.
//
// Everything here runs over real sockets: a real `ws` robot socket into the real
// gateway, and a real TCP socket from the gateway's ASR provider to a
// recorded/fake recognizer server. The robot sends REAL PCM frames; the fake
// recognizer returns the pinned google/asr ASROutput frames. No live vendor.
//
// Covered end to end, asserting the exact frames a robot receives:
//   * Google provider: config (encoding/language/rate/hints), SOS/EOS ordering,
//     interim -> final transcript, FAST_EOS annotation, GARBAGE annotation,
//     ~3 s final-result timeout, upstream error envelope -> ERROR code ASR.
//   * Parakeet provider: real PCM VAD over the socket + post-hoc FAST_EOS.
//   * cancel: a client-supplied CLIENT_ASR supersedes the streaming ASR and the
//     recognizer connection is closed (no dangling provider).
//
// Reference citations are file:line into the pinned Pegasus tree (jiboV2/pegasus),
// packages/hub/src/asr/ and packages/hub/src/listen/ListenTransactionHandler.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
import { createGateway } from '../src/index.js';
import { createGoogleRequest } from '../src/asr/googleProvider.js';
import { cleanHintsEOS } from '../src/asr/factory.js';

const SECRET = 'h07-asr-secret';
const token = () => jwt.sign({ id: 'acct-h07', friendlyId: 'robot-h07', accessKeyId: 'k' }, SECRET);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPEECH = (amplitude = 8000) => {
  const buf = Buffer.alloc(3200); // 100 ms @ 16 kHz mono 16-bit
  for (let i = 0; i < 1600; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
};
const SILENCE = () => Buffer.alloc(3200);

const contextFrame = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-h07', robotID: 'robot-h07', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: {},
  },
});
const listenServerAsr = (asr) => ({
  type: 'LISTEN', msgID: 'l', ts: Date.now(),
  data: { lang: 'en-US', rules: ['launch'], hotphrase: true, asr },
});

const interim = (transcript, confidence = 0.5) => ({
  speechEventType: 'SPEECH_EVENT_UNSPECIFIED',
  results: [{ isFinal: false, stability: 0.1, alternatives: [{ transcript, confidence, words: [] }] }],
});
const final = (transcript, confidence = 0.9) => ({
  speechEventType: 'SPEECH_EVENT_UNSPECIFIED',
  results: [{ isFinal: true, stability: 1, alternatives: [{ transcript, confidence, words: [] }] }],
});
const END_OF_UTTERANCE = { speechEventType: 'END_OF_SINGLE_UTTERANCE', results: [] };

/** Real TCP mock recognizer. `script` fires outputs once `afterBytes` audio arrived. */
function startMockRecognizer(script = []) {
  return new Promise((resolve) => {
    const states = [];
    const server = net.createServer((sock) => {
      const state = { config: null, audioBytes: 0, frames: 0, ended: false };
      states.push(state);
      let buf = Buffer.alloc(0);
      const fired = new Set();
      sock.on('end', () => { state.ended = true; sock.end(); });
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let idx;
        while ((idx = buf.indexOf(0x0a)) !== -1) {
          const line = buf.subarray(0, idx).toString('utf8');
          buf = buf.subarray(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'config') state.config = msg.config;
          else if (msg.type === 'audio') {
            const bytes = Buffer.from(msg.data, 'base64');
            state.audioBytes += bytes.length;
            state.frames += 1;
            script.forEach((step, i) => {
              if (!fired.has(i) && state.audioBytes >= step.afterBytes) {
                fired.add(i);
                sock.write(JSON.stringify(step.output) + '\n');
              }
            });
          }
        }
      });
    });
    server.states = states;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startMockParakeet(transcript, { status = 200 } = {}) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ transcript }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function startParser(t, mode = 'nomatch') {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (mode === 'hang') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { intent: null, rules: ['launch'], entities: {} } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startGateway(t, { parserURL }) {
  const gateway = await createGateway({
    skills: [],
    parserURL,
    historyURL: 'http://127.0.0.1:1',
    disableAuth: false,
    hubTokenSecret: SECRET,
    recordLaunchHistory: false,
    recordSpeechHistory: false,
    asrProvider: 'none',
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  t.after(async () => {
    for (const socket of gateway.wss.clients) socket.terminate();
    gateway.wss.close();
    await new Promise((resolve) => gateway.service.server.close(resolve));
  });
  return { gateway, port };
}

/** Drive one turn over a real socket; resolve with every frame once one is final. */
function driveTurn(port, { listen, frames = [], stepMs = 20, terminalMs = 20000, onOpen }) {
  return new Promise((resolve, reject) => {
    const state = { frames: [], types() { return this.frames.map((f) => f.type); } };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:h07' },
    });
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve(state);
    };
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      state.frames.push(frame);
      if (frame.final) setTimeout(finish, 40);
    });
    ws.on('error', (err) => { if (!settled) { clearTimeout(timer); reject(err); } });
    ws.on('open', async () => {
      ws.send(JSON.stringify(listen));
      ws.send(JSON.stringify(contextFrame()));
      await (onOpen ? onOpen(ws, state) : undefined);
      for (const frame of frames) {
        ws.send(frame);
        await sleep(stepMs);
      }
    });
    timer = setTimeout(() => {
      if (!settled) reject(new Error(`no terminal frame; got ${JSON.stringify(state.types())}`));
    }, terminalMs);
  });
}

function useGoogleProvider(t, recognizer) {
  const saved = {
    provider: process.env.ETCO_server_asrProvider,
    address: process.env.ETCO_server_gspeechMockAddress,
    port: process.env.ETCO_server_gspeechMockPort,
  };
  process.env.ETCO_server_asrProvider = 'google';
  process.env.ETCO_server_gspeechMockAddress = '127.0.0.1';
  process.env.ETCO_server_gspeechMockPort = String(recognizer.address().port);
  t.after(() => {
    for (const [key, value] of Object.entries({
      ETCO_server_asrProvider: saved.provider,
      ETCO_server_gspeechMockAddress: saved.address,
      ETCO_server_gspeechMockPort: saved.port,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('Google streaming ASR over a real socket: config, SOS/EOS, interim -> final, FAST_EOS, GARBAGE, timeout, error, cancel', { concurrency: false }, async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim('what time', 0.5) },
    { afterBytes: 6400, output: END_OF_UTTERANCE },
    { afterBytes: 9600, output: final('what time is it', 0.9) },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({ encoding: 'LINEAR16', hints: ['$YESNO', 'time'], earlyEOS: ['stop'] }),
    frames: [SPEECH(), SPEECH(), SPEECH()],
  });

  // Robot-visible frame sequence and payloads.
  assert.deepEqual(state.types(), ['SOS', 'EOS', 'LISTEN'], `frames: ${JSON.stringify(state.types())}`);
  assert.notEqual(state.frames[0].final, true, 'SOS is not final');
  assert.notEqual(state.frames[1].final, true, 'EOS is not final');
  assert.equal(state.frames[2].final, true, 'LISTEN is terminal');
  assert.equal(state.frames[0].data, null);
  assert.equal(state.frames[1].data, null);
  const listen = state.frames[2];
  assert.equal(listen.data.asr.text, 'what time is it');
  assert.equal(listen.data.asr.confidence, 0.9);
  assert.equal(listen.data.match, null);
  assert.equal(listen.data.nlu.intent, null);

  // The fake recognizer received the REAL audio and the exact original request.
  await sleep(60);
  const rec = recognizer.states[0];
  assert.ok(rec, 'the provider opened a recognizer connection');
  assert.equal(rec.frames, 3, 'all three robot PCM frames reached the recognizer');
  assert.equal(rec.audioBytes, 9600, 'raw audio bytes arrived intact over the socket');
  assert.deepEqual(rec.config, createGoogleRequest({
    lang: 'en-US',
    encoding: 'LINEAR16',
    hints: cleanHintsEOS(['$YESNO', 'time'], true),
  }));
  assert.deepEqual(rec.config.config.speechContexts, [{
    phrases: ['yes', 'yeap', 'yeah', 'no', 'nah', 'nope', 'sure', 'time', 'jibo'],
  }]);
  assert.equal(rec.ended, true, 'the recognizer connection is closed after the turn');
});

test('Google streaming ASR: earlyEOS incremental yields a robot-visible FAST_EOS annotation', async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim('ok stop', 0.6) },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({ earlyEOS: ['stop'] }),
    frames: [SPEECH()],
  });

  assert.deepEqual(state.types(), ['SOS', 'EOS', 'LISTEN']);
  const listen = state.frames[2];
  assert.equal(listen.data.asr.annotation, 'FAST_EOS');
  assert.equal(listen.data.asr.text, 'ok stop');
});

test('Google streaming ASR: a 14-word non-question incremental short-circuits as GARBAGE', async (t) => {
  const parserURL = await startParser(t);
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim(words, 0.4) },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({}),
    frames: [SPEECH()],
  });

  assert.deepEqual(state.types(), ['SOS', 'EOS', 'LISTEN']);
  const listen = state.frames[2];
  assert.equal(listen.final, true);
  assert.equal(listen.data.asr.annotation, 'GARBAGE');
  assert.equal(listen.data.match, null);
  assert.equal(listen.data.nlu.intent, null);
});

test('Google streaming ASR: END_OF_SINGLE_UTTERANCE with no final resolves the last interim after ~3 s', { timeout: 15000 }, async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim('set a timer', 0.6) },
    { afterBytes: 6400, output: END_OF_UTTERANCE },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const t0 = Date.now();
  const state = await driveTurn(port, {
    listen: listenServerAsr({}),
    frames: [SPEECH(), SPEECH()],
    terminalMs: 12000,
  });
  const waited = Date.now() - t0;

  assert.deepEqual(state.types(), ['SOS', 'EOS', 'LISTEN']);
  assert.equal(state.frames[2].data.asr.text, 'set a timer');
  assert.equal(state.frames[2].data.asr.confidence, 0.6);
  assert.ok(waited >= 2900 && waited < 8000, `final-result wait is ~3 s (waited ${waited}ms)`);
});

test('Google streaming ASR: an upstream error envelope reaches the robot as ERROR code ASR', async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: { error: { code: 14, message: 'upstream unavailable', details: ['UNAVAILABLE'] } } },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({}),
    frames: [SPEECH()],
  });

  assert.deepEqual(state.types(), ['ERROR']);
  const error = state.frames[0];
  assert.equal(error.final, true);
  assert.equal(error.data.code, 'ASR');
  assert.equal(error.data.message, 'upstream unavailable');
});

test('Google streaming ASR: a CLIENT_ASR cancel supersedes the stream and closes the recognizer', async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim('first words', 0.5) },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({}),
    frames: [],
    terminalMs: 15000,
    onOpen: async (ws, turn) => {
      // Reach SOS on the streaming session, THEN supersede it with client ASR.
      ws.send(SPEECH());
      const deadline = Date.now() + 5000;
      while (!turn.frames.some((f) => f.type === 'SOS') && Date.now() < deadline) await sleep(20);
      ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'client words win' } }));
    },
  });

  assert.equal(state.types()[0], 'SOS', 'the streaming session reached the socket first');
  const listen = state.frames.find((f) => f.type === 'LISTEN');
  assert.ok(listen, `expected a LISTEN frame, got ${JSON.stringify(state.types())}`);
  assert.equal(listen.data.asr.text, 'client words win');
  await sleep(80);
  const rec = recognizer.states[0];
  assert.ok(rec, 'the recognizer connection existed');
  assert.equal(rec.ended, true, 'the cancelled ASR provider closed its recognizer connection');
});

test('Google streaming ASR: maxSpeechTimeout resolves the last interim as a robot-visible MAX_SPEECH_TIMEOUT', { timeout: 15000 }, async (t) => {
  const parserURL = await startParser(t);
  const recognizer = await startMockRecognizer([
    { afterBytes: 3200, output: interim('and then and then and then', 0.7) },
  ]);
  t.after(() => recognizer.close());
  useGoogleProvider(t, recognizer);
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({ maxSpeechTimeout: 300 }),
    frames: [SPEECH()],
    terminalMs: 10000,
  });

  // The provider is batch-free but never reaches EOS, so the transaction's
  // max-speech timer settles the phase with the last incremental transcript
  // (ListenTransactionHandler.ts:503-517).
  assert.equal(state.types()[0], 'SOS');
  const listen = state.frames.find((f) => f.type === 'LISTEN');
  assert.ok(listen, `expected a LISTEN frame, got ${JSON.stringify(state.types())}`);
  assert.equal(listen.data.asr.annotation, 'MAX_SPEECH_TIMEOUT');
  assert.equal(listen.data.asr.text, 'and then and then and then');
  assert.equal(listen.data.asr.confidence, 0.7);
});

test('Parakeet provider over a real socket: real PCM VAD + post-hoc FAST_EOS annotation', async (t) => {
  const parserURL = await startParser(t);
  const parakeet = await startMockParakeet('yes please');
  t.after(() => { parakeet.closeAllConnections?.(); parakeet.close(); });
  const savedUrl = process.env.ETCO_server_parakeetUrl;
  const savedProvider = process.env.ETCO_server_asrProvider;
  delete process.env.ETCO_server_asrProvider; // default = Parakeet
  process.env.ETCO_server_parakeetUrl = `http://127.0.0.1:${parakeet.address().port}`;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.ETCO_server_parakeetUrl;
    else process.env.ETCO_server_parakeetUrl = savedUrl;
    if (savedProvider === undefined) delete process.env.ETCO_server_asrProvider;
    else process.env.ETCO_server_asrProvider = savedProvider;
  });
  const { port } = await startGateway(t, { parserURL });

  const state = await driveTurn(port, {
    listen: listenServerAsr({ encoding: 'LINEAR16', earlyEOS: ['yes'] }),
    // 500 ms of speech, not 200 ms: on a hotphrase turn the turn's audio opens with
    // the wake phrase's own tail (150-300 ms observed on the robot), which the
    // gateway now refuses to treat as an endpoint (see listen.emptyEndpoint.test.js),
    // so the fixture utterance has to be longer than that tail.
    frames: [SPEECH(), SPEECH(), SPEECH(), SPEECH(), SPEECH(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE()],
  });

  assert.deepEqual(state.types(), ['SOS', 'EOS', 'LISTEN'], `frames: ${JSON.stringify(state.types())}`);
  const listen = state.frames[2];
  assert.equal(listen.data.asr.text, 'yes please');
  assert.equal(listen.data.asr.annotation, 'FAST_EOS');
});
