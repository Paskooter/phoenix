// H-02 runtime probe. Drives the real gateway over a real WebSocket and dumps the
// raw frames a robot receives, plus the in-process ASR cancellation timing.
// Run from the worktree root:  node docs/parity/evidence/2026-09-10/h02-listen-transactions/probe.mjs
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '@phoenix/gateway';
import { ListenTransaction } from '../../../../../packages/gateway/src/listenTransaction.js';
import { jwt } from '@phoenix/common';

const SECRET = 'h02-probe-secret';
const token = () => jwt.sign({ id: 'acct-h02', friendlyId: 'robot-h02', accessKeyId: 'k' }, SECRET);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const contextFrame = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-h02', robotID: 'robot-h02', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} }, skill: {},
  },
});

async function parserStub(mode) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (mode === 'hang') return;
    if (mode === 'fail') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"message":"down"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { intent: null, rules: ['launch'], entities: {} } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function gateway({ parserURL = 'http://127.0.0.1:1' } = {}) {
  const gw = await createGateway({
    skills: [], parserURL, historyURL: 'http://127.0.0.1:1', disableAuth: false,
    hubTokenSecret: SECRET, recordLaunchHistory: false, recordSpeechHistory: false, asrProvider: 'none',
  });
  await gw.service.listen(0);
  gw.port = gw.service.server.address().port;
  gw.stop = async () => {
    for (const socket of gw.wss.clients) socket.terminate();
    gw.wss.close();
    await new Promise((r) => gw.service.server.close(r));
  };
  return gw;
}

function open(gw, path = '/v1/listen') {
  const state = { frames: [], raw: [], closedAt: null, sentAt: null, sentType: null };
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}${path}`, {
    headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:h02-probe' },
  });
  ws.on('message', (d) => {
    state.frames.push({ atMs: Date.now(), json: JSON.parse(d.toString()) });
    state.raw.push(d.toString());
  });
  ws.on('close', () => { state.closedAt = Date.now(); });
  return { ws, state };
}

function terminal(state, ms = 30000) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + ms;
    const poll = () => {
      const hit = state.frames.find((f) => f.json.final);
      if (hit) return resolve(hit);
      if (Date.now() > until) return reject(new Error(`no terminal frame: ${JSON.stringify(state.raw)}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function run(name, path, frames, { parserMode = 'nomatch', proto = {}, observeMs = 0, tightTail = false } = {}) {
  const parser = await parserStub(parserMode);
  const gw = await gateway({ parserURL: parser.url });
  if (proto.asrProvider) gw.components.asrProvider = proto.asrProvider;
  const { ws, state } = open(gw, path);
  await once(ws, 'open');
  const started = Date.now();
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (typeof frame === 'string') ws.send(frame); else ws.send(JSON.stringify(frame));
    // tightTail: the final pair goes out in the same tick, so the hub processes
    // both before the first turn can finish (the wire-level duplicate case).
    if (!(tightTail && i >= frames.length - 2)) await wait(15);
  }
  let terminalFrame = null;
  let error = null;
  try { terminalFrame = await terminal(state, 30000); } catch (err) { error = err.message; }
  const result = {
    name,
    path,
    requestFrames: frames.map((f) => (typeof f === 'string' ? `<raw>${f}` : f.type)),
    observedTypes: state.frames.map((f) => f.json.type),
    finalFlags: state.frames.map((f) => f.json.final === true),
    terminalFrame: terminalFrame && terminalFrame.json,
    rawFrames: state.raw,
    elapsedMs: terminalFrame ? terminalFrame.atMs - started : null,
    error,
  };
  if (observeMs) {
    await wait(observeMs);
    result.socketOpenAfterTerminal = ws.readyState === WebSocket.OPEN;
    result.observedOpenAfterFinalMs = observeMs;
    result.serverClosedSocket = state.closedAt !== null;
  }
  try { ws.close(); } catch { /* already closed */ }
  await wait(30);
  result.clientCloseObserved = state.closedAt !== null;
  if (!state.closedAt) { try { ws.terminate(); } catch { /* ignore */ } }
  await gw.stop();
  parser.server.closeAllConnections();
  parser.server.close();
  return result;
}

// --- in-process ASR cancellation ---------------------------------------------
class FakeASRSession {
  constructor() {
    this.stopped = false;
    this.startOfSpeech = null;
    this.endOfSpeech = null;
    this._settle = null;
    this._p = new Promise((resolve, reject) => { this._settle = { resolve, reject }; });
  }
  onStartOfSpeech(fn) { this.startOfSpeech = fn; }
  onEndOfSpeech(fn) { this.endOfSpeech = fn; }
  getLastIncremental() { return null; }
  provideAudio() {}
  start() { return this._p; }
  stop() { this.stopped = true; }
  finish(data) { this._settle.resolve(data); }
}

async function cancelProbe() {
  const session = new FakeASRSession();
  let releaseParser;
  const parserGate = new Promise((r) => { releaseParser = r; });
  const frames = [];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: { id: 'acct-h02', friendlyId: 'robot-h02' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false },
      asrProvider: () => session,
      parser: { handleNLU: () => parserGate },
      intentRouter: { getSkillIDFromNLU: () => null },
      skillConfigManager: { isOnRobotSkill: () => false },
    },
    { write: (f) => frames.push(f) },
    log,
  );
  const keepAlive = setTimeout(() => {}, 10000);
  tx.done.catch((err) => frames.push({ type: 'ERROR', final: true, data: { code: err.code, message: err.message } }));
  const listen = (mode) => ({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], ...(mode ? { mode } : {}) } });
  tx.handleMessage({ json: listen(null) });
  await wait(5);
  const stateAtStart = tx.state;
  tx.handleMessage({ json: contextFrame() });
  tx.handleMessage({ json: { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'client words' } } });
  await wait(5);
  const stoppedOnClientASR = session.stopped;
  const cancelledFlag = tx.asrCancelled === true;
  session.startOfSpeech && session.startOfSpeech();
  session.endOfSpeech && session.endOfSpeech();
  await wait(5);
  const typesAfterLateCallbacks = frames.map((f) => f.type);
  session.finish({ text: 'stale server words', confidence: 0.9 });
  await wait(5);
  releaseParser({ intent: null, rules: ['launch'], entities: {} });
  await tx.done;
  clearTimeout(keepAlive);
  clearTimeout(tx._txTimer);
  return {
    stateAtStart,
    stoppedOnClientASR,
    cancelledFlag,
    typesAfterLateCallbacks,
    observedTypes: frames.map((f) => f.type),
    finalAsrText: frames.at(-1).data.asr.text,
    terminalFinal: frames.at(-1).final === true,
    stateTrace: tx.stateTrace,
  };
}

const report = {
  capturedAt: new Date().toISOString(),
  revision: process.env.H02_REVISION || null,
  orderingAndClose: await run(
    'CLIENT_ASR turn, socket kept under observation 3s past the terminal frame',
    '/v1/listen',
    [
      { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
      contextFrame(),
      { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'blurf gnax' } },
    ],
    { observeMs: 3000 },
  ),
  aliasListen: await run('plain /listen alias', '/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'blurf gnax' } },
  ]),
  duplicateClientAsrTight: await run('duplicate CLIENT_ASR, same tick', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a1', ts: Date.now(), data: { text: 'first words' } },
    { type: 'CLIENT_ASR', msgID: 'a2', ts: Date.now(), data: { text: 'second words' } },
  ], { tightTail: true }),
  duplicateClientAsr: await run('duplicate CLIENT_ASR', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a1', ts: Date.now(), data: { text: 'first words' } },
    { type: 'CLIENT_ASR', msgID: 'a2', ts: Date.now(), data: { text: 'second words' } },
  ]),
  duplicateContext: await run('duplicate CONTEXT', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'duplicate context' } },
  ]),
  reorderedContext: await run('CONTEXT arriving after CLIENT_ASR', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'context came late' } },
    contextFrame(),
  ]),
  globalTurn: await run('bare CLIENT_ASR with no LISTEN (simulator framing)', '/v1/listen', [
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'global words' } },
  ]),
  malformedJson: await run('malformed JSON', '/v1/listen', ['THIS IS NOT A JSON']),
  unknownType: await run('unknown message type', '/v1/listen', [{ type: 'LISTEN_ME', msgID: 'x', ts: Date.now(), data: {} }]),
  badMode: await run('invalid LISTEN mode', '/v1/listen', [{ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], mode: 'WHATEVER' } }]),
  parserFailure: await run('parser 503', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'provider failure' } },
  ], { parserMode: 'fail' }),
  parserTimeout: await run('parser never answers (10s budget)', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } },
    contextFrame(),
    { type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'slow parser' } },
  ], { parserMode: 'hang' }),
  contextTimeout: await run('CLIENT_NLU with no CONTEXT (5s budget)', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], mode: 'CLIENT_NLU' } },
    { type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { intent: null, rules: ['launch'], entities: {} } },
  ]),
  asrFailure: await run('server ASR provider rejects', '/v1/listen', [
    { type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'] } },
  ], {
    proto: {
      asrProvider: () => ({
        onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {}, getLastIncremental() { return null; },
        start: async () => { throw new Error('asr backend exploded'); },
      }),
    },
  }),
  asrCancellation: await cancelProbe(),
};

const out = process.env.H02_OUT;
if (!out) throw new Error('set H02_OUT to the report path');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
