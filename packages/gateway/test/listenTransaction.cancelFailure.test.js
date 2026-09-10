// H-02: listen-transaction ordering, cancellation and failure behaviour.
//
// In-process against the real ListenTransaction. These cases pin the parts of the
// pinned original that a state machine alone cannot show: SOS/EOS ordering, the
// single terminal frame, and the ASR-cancellation contract of
// ListenTransactionHandler.ts:253-256/272-276 (a CLIENT_ASR/CLIENT_NLU that
// arrives while server ASR is running cancels that ASR) plus stopASR()
// (lines 439-450) and _exitCurrentState() (lines 207-226).
//
// Reference citations are file:line into the pinned Pegasus tree
// 5c0a7390539663ba749d360de348a428c088505c, packages/hub/src/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction } from '../src/listenTransaction.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Controllable ASR session: start() resolves only when finish() is called. */
class FakeASRSession {
  constructor() {
    this.started = false;
    this.stopped = false;
    this.audio = [];
    this.startOfSpeech = null;
    this.endOfSpeech = null;
    this._settle = null;
    this._startPromise = new Promise((resolve, reject) => { this._settle = { resolve, reject }; });
  }

  onStartOfSpeech(fn) { this.startOfSpeech = fn; }
  onEndOfSpeech(fn) { this.endOfSpeech = fn; }
  getLastIncremental() { return { text: 'incremental words', confidence: 0.4 }; }
  provideAudio(buffer) { this.audio.push(buffer); }
  start() { this.started = true; return this._startPromise; }
  stop() { this.stopped = true; }
  finish(result) { this._settle.resolve(result); }
  fail(error) { this._settle.reject(error); }
}

function harness(t, { asrProvider, parser, intentRouter, auth = { id: 'acct-h02', friendlyId: 'robot-h02' } } = {}) {
  const frames = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: auth, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false },
      asrProvider,
      parser: parser || { handleNLU: async () => ({ intent: null, rules: ['launch'], entities: {} }) },
      intentRouter: intentRouter || { getSkillIDFromNLU: () => null },
      skillConfigManager: { isOnRobotSkill: () => false },
    },
    { write: (frame) => frames.push(frame) },
    log,
  );
  // index.js writes the failing transaction's ERROR frame (port of
  // ListenHandler.ts:46-60); mirror it so failure codes are observable here.
  tx.done.catch((err) => frames.push({
    type: 'ERROR', final: true, ts: Date.now(), msgID: 'tx-error',
    data: { code: err.code, message: err.message },
  }));
  // Every transaction timer is unref'd (as in production), so a test that waits
  // on one needs its own referenced handle to keep the loop alive.
  const keepAlive = setTimeout(() => {}, 30_000);
  t.after(() => { clearTimeout(keepAlive); clearTimeout(tx._txTimer); });
  return { tx, frames };
}

const listenNoMode = (data = {}) => ({ type: 'LISTEN', msgID: 'l', ts: 1, data: { lang: 'en-US', rules: ['launch'], hotphrase: false, ...data } });
const listenClientAsr = () => ({ type: 'LISTEN', msgID: 'l', ts: 1, data: { lang: 'en-US', rules: ['launch'], hotphrase: false, mode: 'CLIENT_ASR' } });
const contextFrame = (skill = {}) => ({
  type: 'CONTEXT', msgID: 'c', ts: 1,
  data: {
    general: { accountID: 'acct-h02', robotID: 'robot-h02', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill,
  },
});
const clientAsr = (text) => ({ type: 'CLIENT_ASR', msgID: 'a', ts: 1, data: { text } });
const types = (frames) => frames.map((frame) => frame.type);

test('server ASR: SOS then EOS then the single terminal LISTEN frame', async (t) => {
  const session = new FakeASRSession();
  const parsed = [];
  const { tx, frames } = harness(t, {
    asrProvider: () => session,
    parser: { handleNLU: async (data) => { parsed.push(data); return { intent: null, rules: ['launch'], entities: {} }; } },
  });

  tx.handleMessage({ json: listenNoMode() });
  await tick();
  assert.equal(tx.state, 'ASR');

  session.startOfSpeech();
  assert.deepEqual(types(frames), ['SOS']);
  assert.equal(frames[0].data, null);
  session.endOfSpeech();
  assert.deepEqual(types(frames), ['SOS', 'EOS']);

  tx.handleMessage({ json: contextFrame() });
  session.finish({ text: 'do you like dogs', confidence: 0.9 });
  await tx.done;

  assert.deepEqual(types(frames), ['SOS', 'EOS', 'LISTEN']);
  assert.deepEqual(frames.map((frame) => frame.final), [undefined, undefined, true], 'exactly one terminal frame');
  assert.equal(frames[0].timings.total >= 0, true, 'real SOS carries measured timings');
  assert.notEqual(frames[1].timings.total, -1, 'real EOS carries measured timings, not the client -1');
  assert.equal(frames[2].data.asr.text, 'do you like dogs');
  assert.equal(frames[2].data.match, null);
  assert.deepEqual(parsed.map((request) => request.text), ['do you like dogs']);
  assert.equal(session.stopped, true, 'the ASR session is stopped when the phase settles (stopASR in the finally)');
});

test('CLIENT_ASR cancels the in-flight server ASR phase and keeps the client transcript', async (t) => {
  const session = new FakeASRSession();
  let releaseParser;
  const parserGate = new Promise((resolve) => { releaseParser = resolve; });
  const { tx, frames } = harness(t, { asrProvider: () => session, parser: { handleNLU: () => parserGate } });

  tx.handleMessage({ json: listenNoMode() });
  await tick();
  assert.equal(tx.state, 'ASR');
  assert.equal(session.started, true);
  assert.equal(session.stopped, false);

  tx.handleMessage({ json: contextFrame() });
  tx.handleMessage({ json: clientAsr('client words') });
  await tick();

  // ListenTransactionHandler.ts:253-256 — "If we're already doing ASR then we cancel that".
  assert.equal(session.stopped, true, 'CLIENT_ASR stops the running ASR session immediately');
  assert.equal(tx.asrCancelled, true);
  assert.equal(tx.state, 'NLU');
  assert.deepEqual(types(frames), ['EOS']);

  // A provider that keeps emitting or answers late must not resurrect the phase.
  session.startOfSpeech();
  session.endOfSpeech();
  await tick();
  assert.deepEqual(types(frames), ['EOS'], 'no SOS/EOS from a cancelled phase');

  session.finish({ text: 'stale server words', confidence: 0.9 });
  await tick();
  releaseParser({ intent: null, rules: ['launch'], entities: {} });
  await tx.done;

  assert.deepEqual(types(frames), ['EOS', 'LISTEN']);
  assert.equal(frames.at(-1).final, true);
  assert.equal(frames.at(-1).data.asr.text, 'client words', 'the stale server result cannot overwrite the client transcript');
});

test('CLIENT_NLU cancels the in-flight server ASR phase', async (t) => {
  const session = new FakeASRSession();
  const { tx, frames } = harness(t, { asrProvider: () => session });

  tx.handleMessage({ json: listenNoMode() });
  await tick();
  assert.equal(tx.state, 'ASR');

  tx.handleMessage({ json: contextFrame() });
  tx.handleMessage({ json: { type: 'CLIENT_NLU', msgID: 'n', ts: 1, data: { intent: null, rules: ['launch'], entities: {} } } });
  await tick();
  assert.equal(session.stopped, true, 'CLIENT_NLU stops the running ASR session too (ListenTransactionHandler.ts:272-276)');

  tx.handleMessage({ json: contextFrame() });
  await tx.done;
  assert.equal(types(frames).at(-1), 'LISTEN');
  assert.equal(frames.at(-1).final, true);
  assert.equal(frames.at(-1).data.asr.text, '', 'CLIENT_NLU supplies an empty ASR result');
});

test('GARBAGE annotation short-circuits to a terminal LISTEN without calling the parser', async (t) => {
  const session = new FakeASRSession();
  let parserCalls = 0;
  const { tx, frames } = harness(t, {
    asrProvider: () => session,
    parser: { handleNLU: async () => { parserCalls += 1; return { intent: null, rules: [], entities: {} }; } },
  });

  tx.handleMessage({ json: listenNoMode() });
  await tick();
  tx.handleMessage({ json: contextFrame() });
  session.startOfSpeech();
  session.endOfSpeech();
  session.finish({ text: 'blurf', confidence: 0.1, annotation: 'GARBAGE' });
  await tx.done;

  assert.deepEqual(types(frames), ['SOS', 'EOS', 'LISTEN']);
  assert.equal(frames.at(-1).final, true);
  assert.equal(frames.at(-1).data.match, null);
  assert.deepEqual(frames.at(-1).data.nlu, { intent: null, rules: [], entities: {} });
  assert.equal(parserCalls, 0, 'the GARBAGE short-circuit skips the parser');
});

test('empty audio: SOS timeout yields empty ASR with no SOS/EOS pair', async (t) => {
  const session = new FakeASRSession();
  const parsed = [];
  const { tx, frames } = harness(t, {
    asrProvider: () => session,
    parser: { handleNLU: async (data) => { parsed.push(data); return { intent: null, rules: ['launch'], entities: {} }; } },
  });

  tx.handleMessage({ json: listenNoMode({ asr: { sosTimeout: 5 } }) });
  await tick();
  tx.handleMessage({ json: contextFrame() });
  await tx.done;

  assert.deepEqual(types(frames), ['LISTEN'], 'no SOS was ever emitted, so no EOS follows');
  assert.equal(frames[0].final, true);
  assert.equal(frames[0].data.asr.text, '');
  assert.equal(frames[0].data.asr.annotation, 'SOS_TIMEOUT');
  assert.deepEqual(frames[0].data.nlu, { intent: null, rules: ['launch'], entities: {} });
  assert.deepEqual(parsed.map((request) => request.text), ['']);
});

test('an ASR provider failure surfaces as HubErrorCode.ASR', async (t) => {
  const session = new FakeASRSession();
  const { tx, frames } = harness(t, { asrProvider: () => session });

  tx.handleMessage({ json: listenNoMode() });
  await tick();
  tx.handleMessage({ json: contextFrame() });
  session.fail(new Error('asr backend exploded'));
  await tx.done.catch(() => {});

  const error = frames.at(-1);
  assert.equal(error.type, 'ERROR');
  assert.equal(error.final, true);
  assert.equal(error.data.code, 'ASR');
  assert.equal(error.data.message, 'asr backend exploded');
  assert.deepEqual(types(frames), ['ERROR']);
});

test('a duplicate CLIENT_ASR cannot produce a second terminal outcome', async (t) => {
  let parserCalls = 0;
  const { tx, frames } = harness(t, {
    parser: { handleNLU: async () => { parserCalls += 1; return { intent: null, rules: ['launch'], entities: {} }; } },
  });

  tx.handleMessage({ json: listenClientAsr() });
  tx.handleMessage({ json: contextFrame() });
  tx.handleMessage({ json: clientAsr('first') });
  tx.handleMessage({ json: clientAsr('second') });
  await tx.done;

  // The pinned handler has no duplicate guard either: handleClientASRMessage
  // (ListenTransactionHandler.ts:252-267) only cancels when state === ASR, so a
  // repeat emits a repeat EOS and its NLU transition is rejected as invalid.
  assert.deepEqual(types(frames), ['SOS', 'EOS', 'EOS', 'LISTEN']);
  assert.equal(frames.filter((frame) => frame.final).length, 1, 'exactly one terminal frame');
  assert.equal(parserCalls, 1, 'the turn is routed once');
  assert.equal(frames.at(-1).data.asr.text, 'second');
});

test('a bare CLIENT_ASR synthesizes a global turn (Phoenix extension over the pinned handler)', async (t) => {
  const { tx, frames } = harness(t);

  tx.handleMessage({ json: clientAsr('global words') });
  await tx.done;

  assert.deepEqual(types(frames), ['EOS', 'LISTEN']);
  assert.equal(frames.at(-1).final, true);
  assert.equal(frames.at(-1).data.asr.text, 'global words');
  assert.equal(tx.global, true);
  // _beginGlobalTurn assigns `this.state` directly, so the synthesized
  // WAIT_CLIENT_ASR never enters stateTrace; only real transitions do.
  assert.deepEqual(tx.stateTrace, ['WAIT_LISTEN', 'NLU', 'ROUTE', 'DONE']);
});
