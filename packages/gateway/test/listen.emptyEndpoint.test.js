// Regression: the wake-phrase-tail false endpoint (owner-reported "it does
// nothing the first time, works the second time").
//
// The robot streams the turn's audio from the moment its wake-phrase spotter
// fires, so the first energy run the hub sees is the tail of "Hey Jibo". A
// natural pause after the wake phrase satisfies the batch endpoint (700 ms
// trailing silence), the POST recognizes no words, and — before this fix — the
// hub ended the turn with an empty no-match LISTEN result. The user's real
// request, spoken after the pause, was streamed into an already-ended response
// and discarded. These tests pin the fixed behavior:
//   * an empty silence endpoint keeps the batch session listening (one POST per
//     endpoint, one wire EOS, result comes from the utterance that has words);
//   * a caller stop and a max-buffer cut still end the phase (no infinite listen);
//   * a max-speech timeout asks the batch recognizer for the words it holds
//     instead of settling the turn with an empty result;
//   * a peer close abandons the in-flight ASR phase: no recognition is posted for
//     a response that can no longer be delivered and no frame is written into it.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
import { createGateway } from '../src/index.js';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';

const SECRET = 'gateway-empty-endpoint-secret';
const token = () => jwt.sign({ id: 'acct-eos', friendlyId: 'robot-eos', accessKeyId: 'k' }, SECRET);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 100 ms of 16 kHz mono 16-bit PCM.
function pcmChunk(amplitude) {
  const buf = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
}
const SPEECH = () => pcmChunk(8000); // RMS 8000 >> the 400 threshold
const SILENCE = () => pcmChunk(0);
// Two speech frames trip SOS (>=150 ms cumulative); seven silence frames trip EOS (>=700 ms).
const wsUtteranceFrames = () => [SPEECH(), SPEECH(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE(), SILENCE()];

/** Mock recognizer that answers each POST with the next scripted transcript. */
async function startMockParakeet(transcripts) {
  const pending = [...transcripts];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests.push(Date.now());
    const transcript = pending.length > 1 ? pending.shift() : pending[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ transcript }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.requests = requests;
  return server;
}

async function startParser(t) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
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
    // A turn that ended by a peer close can leave an accepted socket behind; closing
    // the listener waits for it, so force the connections down before awaiting close.
    try { gateway.wss.closeAllConnections?.(); } catch { /* already closed */ }
    try { gateway.service.server.closeAllConnections?.(); } catch { /* already closed */ }
    await new Promise((resolve) => gateway.service.server.close(resolve));
  });
  return { gateway, port };
}

const listenServerAsr = (asr) => ({
  type: 'LISTEN', msgID: 'l', ts: Date.now(),
  data: { lang: 'en-US', rules: ['launch'], hotphrase: true, asr },
});
const contextFrame = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-eos', robotID: 'robot-eos', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: {},
  },
});

/**
 * Open a listen socket, send LISTEN + CONTEXT, then stream `steps` (each an array
 * of frames) with `stepMs` between frames. `finish` decides how the turn ends.
 */
function driveTurn(port, { listen, steps, stepMs = 20, terminalMs = 15000, finish }) {
  return new Promise((resolve, reject) => {
    const state = { frames: [], types() { return this.frames.map((f) => f.type); }, socket: null };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:eos' },
    });
    state.socket = ws;
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve(state);
    };
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      state.frames.push(frame);
      if (frame.final) setTimeout(done, 40);
    });
    ws.on('error', (err) => { if (!settled) { clearTimeout(timer); reject(err); } });
    ws.on('open', async () => {
      ws.send(JSON.stringify(listen));
      ws.send(JSON.stringify(contextFrame()));
      for (const frames of steps) {
        for (const frame of frames) {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(frame);
          await sleep(stepMs);
        }
        await (finish ? finish(ws, state) : undefined);
        // A step may end the turn itself (e.g. by closing the socket the way the
        // robot does); there is no terminal frame to wait for after that.
        if (ws.readyState !== ws.OPEN) { done(); return; }
      }
    });
    timer = setTimeout(() => {
      if (!settled) reject(new Error(`no terminal frame; got ${JSON.stringify(state.types())}`));
    }, terminalMs);
  });
}

test('empty silence endpoint keeps the batch session listening and the turn returns the real utterance', async () => {
  const parakeet = await startMockParakeet(['', 'what time is it']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  let sos = 0; let eos = 0;
  session.onStartOfSpeech(() => { sos += 1; });
  session.onEndOfSpeech(() => { eos += 1; });
  try {
    for (const frame of wsUtteranceFrames()) session.provideAudio(frame);   // wake-phrase tail + pause
    await sleep(150);                                                      // let the empty POST settle
    for (const frame of wsUtteranceFrames()) session.provideAudio(frame);   // the real request
    const result = await startPr;
    assert.equal(result.text, 'what time is it', 'the turn resolves with the utterance that had words');
    assert.equal(result.confidence, 1.0);
    assert.equal(sos, 1, 'SOS is emitted once across the empty endpoint');
    assert.equal(eos, 1, 'the wire EOS is emitted once even though two endpoints fired');
    assert.equal(parakeet.requests.length, 2, 'one recognition per endpoint');
  } finally {
    if (!session.stopped) session.stop();
    parakeet.closeAllConnections?.();
    await new Promise((resolve) => parakeet.close(resolve));
  }
});

test('a hotphrase turn ignores the wake-phrase tail as an endpoint and answers with the request', async () => {
  const parakeet = await startMockParakeet(['what time is it']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US', hotphrase: true }, console);
  const startPr = session.start();
  let sos = 0; let eos = 0;
  session.onStartOfSpeech(() => { sos += 1; });
  session.onEndOfSpeech(() => { eos += 1; });
  try {
    // 200 ms of the "-bo" in "Hey Jibo" plus the speaker's pause: far too short to
    // be an utterance, and exactly what the robot streams first.
    session.provideAudio(SPEECH());
    session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());
    assert.equal(sos, 1, 'SOS still fires on the first energy run');
    assert.equal(eos, 0, 'a 200 ms burst does not end the turn');
    assert.equal(parakeet.requests.length, 0, 'the wake-phrase tail is never recognized on its own');

    // The real request, spoken after the pause.
    for (let i = 0; i < 6; i += 1) session.provideAudio(SPEECH());
    for (let i = 0; i < 7; i += 1) session.provideAudio(SILENCE());

    const result = await startPr;
    assert.equal(result.text, 'what time is it', 'the turn returns the request, not the wake phrase');
    assert.equal(eos, 1, 'the wire EOS is emitted once, on the real endpoint');
    assert.equal(parakeet.requests.length, 1, 'exactly one recognition for the turn');
  } finally {
    if (!session.stopped) session.stop();
    parakeet.closeAllConnections?.();
    await new Promise((resolve) => parakeet.close(resolve));
  }
});

test('an empty endpoint does not relisten after a caller stop or a max-buffer cut', async () => {
  const parakeet = await startMockParakeet(['']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  for (const frame of wsUtteranceFrames()) session.provideAudio(frame);
  await sleep(150);
  session.provideAudio(SPEECH());
  session.stop(); // caller stop with an empty transcript: the turn ends here
  const result = await startPr;
  assert.equal(result.text, '', 'stop() with no recognized utterance ends the phase empty');
  assert.equal(result.confidence, 0);
  assert.equal(parakeet.requests.length, 2, 'the empty endpoint and the end-of-input finalize each recognized once');
  assert.equal(session.relistenCount, 1, 'the stop path does not relisten');
  assert.equal(session.state, 'DONE');
  parakeet.closeAllConnections?.();
  await new Promise((resolve) => parakeet.close(resolve));
});

test('a max-speech timeout returns the words the batch recognizer holds', async (t) => {
  const parserURL = await startParser(t);
  const parakeet = await startMockParakeet(['the whole request so far']);
  t.after(() => { parakeet.closeAllConnections?.(); parakeet.close(); });
  const savedUrl = process.env.ETCO_server_parakeetUrl;
  process.env.ETCO_server_parakeetUrl = `http://127.0.0.1:${parakeet.address().port}`;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.ETCO_server_parakeetUrl;
    else process.env.ETCO_server_parakeetUrl = savedUrl;
  });
  const { port } = await startGateway(t, { parserURL });

  // Speech that never reaches an endpoint: only the max-speech timer can settle it.
  const state = await driveTurn(port, {
    listen: listenServerAsr({ encoding: 'LINEAR16', maxSpeechTimeout: 400 }),
    steps: [[SPEECH(), SPEECH(), SPEECH(), SPEECH(), SPEECH()]],
    stepMs: 30,
  });

  assert.deepEqual(state.types(), ['SOS', 'LISTEN'], `frames: ${JSON.stringify(state.types())}`);
  const listen = state.frames[1];
  assert.equal(listen.data.asr.annotation, 'MAX_SPEECH_TIMEOUT');
  assert.equal(listen.data.asr.text, 'the whole request so far', 'the buffered audio is recognized instead of dropped');
});

test('a peer close abandons the ASR phase: nothing is recognized for a response that cannot be delivered', async (t) => {
  const parserURL = await startParser(t);
  const parakeet = await startMockParakeet(['tail']);
  t.after(() => { parakeet.closeAllConnections?.(); parakeet.close(); });
  const savedUrl = process.env.ETCO_server_parakeetUrl;
  process.env.ETCO_server_parakeetUrl = `http://127.0.0.1:${parakeet.address().port}`;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.ETCO_server_parakeetUrl;
    else process.env.ETCO_server_parakeetUrl = savedUrl;
  });
  const { port } = await startGateway(t, { parserURL });

  const warnings = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    const text = chunk.toString();
    if (text.includes("can't write after response ended")) warnings.push(text);
    return realWrite.call(process.stderr, chunk, ...rest);
  };
  t.after(() => { process.stderr.write = realWrite; });

  // Stream speech (SOS), then close the socket the way the robot does on a hotword
  // re-trigger / cancel_local_turn, and keep the turn's max-speech timer short so a
  // still-running phase would post a recognition and emit EOS + LISTEN into the dead
  // response within the assertion window.
  const state = await driveTurn(port, {
    listen: listenServerAsr({ encoding: 'LINEAR16', maxSpeechTimeout: 300 }),
    steps: [[SPEECH(), SPEECH(), SPEECH()]],
    stepMs: 20,
    finish: async (ws) => { ws.terminate(); },
  });
  assert.deepEqual(state.types(), ['SOS'], `frames: ${JSON.stringify(state.types())}`);

  await sleep(1200); // outlive the 300 ms max-speech timer
  assert.equal(parakeet.requests.length, 0, 'no recognition is posted after the peer closed');
  assert.deepEqual(warnings, [], "no frame is written into the ended response");
});
