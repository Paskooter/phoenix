// Synthetic loopback fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';

import { ListenTransaction } from '../src/listenTransaction.js';
import { GoogleASRSession } from '../src/asr/googleSession.js';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const withTimeout = (promise, ms = 1000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function context() {
  return {
    type: 'CONTEXT',
    data: {
      general: { accountID: 'account-lifecycle', robotID: 'robot-lifecycle', lang: 'en', release: '2.0.1' },
      runtime: { perception: { speaker: null, peoplePresent: [] }, loop: { users: [] } },
      skill: {},
    },
  };
}

function makeTransaction(overrides = {}) {
  const frames = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: { id: 'account-lifecycle', friendlyId: 'robot-lifecycle' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false, recordSpeechHistory: false },
      skillConfigManager: { isOnRobotSkill: () => false },
      intentRouter: { getSkillIDFromNLU: () => null },
      parser: { handleNLU: async () => ({ intent: null, rules: [], entities: {} }) },
      skillClient: { launchOrUpdate: async () => ({ response: { type: 'SKILL_ACTION', data: {} } }), launch: async () => ({ response: { type: 'SKILL_ACTION', data: {} } }) },
      historyClient: { writeSkillLaunch: () => Promise.resolve(), saveSpeechRecord: () => Promise.resolve() },
      ...overrides,
    },
    { write: (frame) => frames.push(frame) },
    log,
  );
  return { tx, frames };
}

function listenNoMode(data = {}) {
  return { type: 'LISTEN', data: { lang: 'en-US', rules: [], hotphrase: false, ...data } };
}

function action(skillID = 'cloud-skill') {
  return { type: 'SKILL_ACTION', data: { skill: { id: skillID, session: { id: `${skillID}-session` } } } };
}

class FakeMaxSpeechSession {
  constructor() {
    this.startOfSpeech = null;
    this.endOfSpeech = null;
    this.releaseStart = null;
    this.stopped = false;
    this.startPromise = new Promise((resolve) => { this.releaseStart = resolve; });
  }

  onStartOfSpeech(handler) { this.startOfSpeech = handler; }
  onEndOfSpeech(handler) { this.endOfSpeech = handler; }
  getLastIncremental() { return undefined; }
  provideAudio() {}
  start() { return this.startPromise; }
  stop() { this.stopped = true; }
  finalizeNow() {
    // Reproduce the race: finalization settles the provider with no result before
    // the caller's max-speech continuation has produced its fallback.
    this.releaseStart(undefined);
    return Promise.resolve(undefined);
  }
}

function fakeGoogleStream() {
  const stream = new EventEmitter();
  stream.write = () => {};
  stream.end = () => {};
  return stream;
}

function pcmChunk(amplitude, ms = 100) {
  const samples = Math.floor(16000 * ms / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
}

const SPEECH = () => pcmChunk(8000);
const SILENCE = () => pcmChunk(0);

async function withServerClose(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test('ListenTransaction.reject aborts ASR and clears ASR timers', async (t) => {
  let aborts = 0;
  const session = {
    abort() { aborts += 1; },
    stop() { throw new Error('stop must not be used for rejection cleanup'); },
  };
  const { tx } = makeTransaction({ asrProvider: () => session });
  tx.state = 'ASR';
  tx.asrSession = session;
  tx.sosTimer = setTimeout(() => {}, 10_000);
  tx.maxSpeechTimer = setTimeout(() => {}, 10_000);
  t.after(() => { clearTimeout(tx._txTimer); clearTimeout(tx.sosTimer); clearTimeout(tx.maxSpeechTimer); });

  const done = tx.done.catch((error) => error);
  tx.reject(new Error('transaction failed'));
  assert.equal((await done).message, 'transaction failed');
  assert.equal(aborts, 1);
  assert.equal(tx.asrSession, null);
  assert.equal(tx.sosTimer, null);
  assert.equal(tx.maxSpeechTimer, null);
});

test('_stopASR retains the session reference when stop throws', (t) => {
  const session = { stop() { throw new Error('stop failed'); } };
  const { tx } = makeTransaction();
  tx.asrSession = session;
  t.after(() => clearTimeout(tx._txTimer));

  tx._stopASR();
  assert.strictEqual(tx.asrSession, session);
});

test('abandon aborts a held parser and suppresses its late continuation', async (t) => {
  const gate = deferred();
  let signal;
  const { tx, frames } = makeTransaction({
    parser: { handleNLU: (_data, _trace, options) => { signal = options && options.signal; return gate.promise; } },
  });
  tx.listenMessage = { data: { rules: [] } };
  tx.asrData = { text: 'held parser input', confidence: 1 };
  tx.contextPr.resolve(context());
  tx.state = 'WAIT_CLIENT_ASR';
  tx._gotoState('NLU');
  await tick();

  tx.abandon();
  assert.equal(signal.aborted, true);
  await tx.done;
  gate.resolve({ intent: 'late', rules: [], entities: {} });
  await tick();

  assert.equal(tx.nluData, null);
  assert.deepEqual(frames, []);
  t.after(() => clearTimeout(tx._txTimer));
});

test('abandon aborts a held skill and suppresses late skill and history output', async (t) => {
  const gate = deferred();
  let signal;
  const writes = [];
  const { tx, frames } = makeTransaction({
    skillClient: { launchOrUpdate: (_id, _input, _trace, _update, options) => { signal = options && options.signal; return gate.promise; } },
    config: { recordLaunchHistory: true, recordSpeechHistory: false },
    historyClient: { writeSkillLaunch: (...args) => { writes.push(args); return Promise.resolve(); } },
  });
  tx.nluData = { intent: 'held' };
  tx.asrData = { text: 'held skill input', confidence: 1 };

  const operation = tx._onSkillMatch('cloud-skill', context());
  await tick();
  assert.deepEqual(frames.map((frame) => frame.type), ['LISTEN']);
  tx.abandon();
  assert.equal(signal.aborted, true);
  await tx.done;
  gate.resolve({ skillID: 'cloud-skill', response: action() });
  await operation;

  assert.deepEqual(frames.map((frame) => frame.type), ['LISTEN']);
  assert.equal(writes.length, 0);
  t.after(() => clearTimeout(tx._txTimer));
});

test('abandon aborts an in-flight history write', async (t) => {
  const gate = deferred();
  let signal;
  const { tx } = makeTransaction({
    config: { recordLaunchHistory: true, recordSpeechHistory: false },
    historyClient: { writeSkillLaunch: (_data, _trace, options) => { signal = options && options.signal; return gate.promise; } },
  });
  tx._record('cloud-skill', context(), action());
  assert.ok(signal);
  tx.abandon();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await tx.done;
  t.after(() => clearTimeout(tx._txTimer));
});

test('transaction timeout aborts a held skill and suppresses late output', async (t) => {
  const gate = deferred();
  let signal;
  const { tx, frames } = makeTransaction({
    skillClient: { launchOrUpdate: (_id, _input, _trace, _update, options) => { signal = options && options.signal; return gate.promise; } },
  });
  tx.nluData = { intent: 'held' };
  tx.asrData = { text: 'held skill input', confidence: 1 };
  const operation = tx._onSkillMatch('cloud-skill', context());
  await tick();
  tx._onTransactionTimeout();
  const error = await tx.done.catch((value) => value);
  assert.equal(error instanceof Error, true);
  assert.equal(signal.aborted, true);
  gate.resolve({ skillID: 'cloud-skill', response: action() });
  await operation;
  assert.deepEqual(frames.map((frame) => frame.type), ['LISTEN']);
  t.after(() => clearTimeout(tx._txTimer));
});

test('audio is ignored outside an ASR-capable state and empty chunks do not accumulate', () => {
  const { tx } = makeTransaction();
  clearTimeout(tx._txTimer);
  tx.handleMessage({ audio: Buffer.alloc(0) });
  assert.equal(tx.audioChunks.length, 0);

  tx.state = 'WAIT_CLIENT_NLU';
  tx.handleMessage({ audio: Buffer.from('not for client nlu') });
  tx.handleMessage({ audio: Buffer.alloc(0) });
  assert.equal(tx.audioChunks.length, 0);
  assert.equal(tx.audioBufferedBytes, 0);

  tx.state = 'DONE';
  tx.handleMessage({ audio: Buffer.from('after done') });
  assert.equal(tx.audioChunks.length, 0);
});

test('Google remote end emits EOS and always supplies a usable empty result', async () => {
  const withSpeech = fakeGoogleStream();
  const speechSession = new GoogleASRSession(withSpeech, { lang: 'en-US' }, log);
  let eos = 0;
  speechSession.onEndOfSpeech(() => { eos += 1; });
  const speechStart = speechSession.start();
  withSpeech.emit('data', {
    speechEventType: 'SPEECH_EVENT_UNSPECIFIED',
    results: [{ isFinal: false, alternatives: [{ transcript: 'remote end words', confidence: 0.7 }] }],
  });
  withSpeech.emit('end');
  assert.deepEqual(await speechStart, { text: 'remote end words', confidence: 0.7 });
  assert.equal(eos, 1);

  const emptyStream = fakeGoogleStream();
  const emptySession = new GoogleASRSession(emptyStream, { lang: 'en-US' }, log);
  const emptyStart = emptySession.start();
  emptyStream.emit('end');
  assert.deepEqual(await emptyStart, { text: '', confidence: 0 });
});

test('ListenTransaction turns an undefined ASR result into empty NLU input', async (t) => {
  const { tx, frames } = makeTransaction({
    asrProvider: () => ({
      onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {},
      getLastIncremental() { return undefined; }, start() { return Promise.resolve(undefined); },
    }),
  });
  tx.handleMessage({ json: listenNoMode() });
  await tick();
  tx.handleMessage({ json: context() });
  await tx.done;
  assert.equal(frames.at(-1).type, 'LISTEN');
  assert.equal(frames.at(-1).data.asr.text, '');
  t.after(() => clearTimeout(tx._txTimer));
});

test('empty-buffer max-speech finalization cannot settle ASR as undefined', async (t) => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const session = new FakeMaxSpeechSession();
  const { tx, frames } = makeTransaction({ asrProvider: () => session });
  tx.handleMessage({ json: listenNoMode({ asr: { maxSpeechTimeout: 5 } }) });
  await tick();
  tx.handleMessage({ json: context() });
  session.startOfSpeech();
  await tx.done;
  assert.equal(frames.at(-1).type, 'LISTEN');
  assert.equal(frames.at(-1).data.asr.text, '');
  assert.equal(frames.at(-1).data.asr.annotation, 'MAX_SPEECH_TIMEOUT');
  t.after(() => clearTimeout(tx._txTimer));
});
test('client cancellation aborts a Parakeet request already in FINALIZING', async (t) => {
  const requestSeen = deferred();
  const responseClosed = deferred();
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(404); res.end(); return; }
    req.on('data', () => {});
    req.on('end', () => {
      requestSeen.resolve();
      res.once('close', () => responseClosed.resolve());
      // Hold the response until the client aborts it.
    });
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => withServerClose(server));

  const session = new ParakeetASRSession(`http://127.0.0.1:${server.address().port}`, { lang: 'en-US' }, log);
  const start = session.start();
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE)]);
  session.provideAudio(burst);
  await requestSeen.promise;
  assert.equal(session.state, 'FINALIZING');

  const { tx } = makeTransaction();
  tx.state = 'ASR';
  tx.asrSession = session;
  tx._cancelASR();
  await withTimeout(responseClosed.promise);
  assert.equal(await start, undefined);
  assert.equal(tx.asrSession, null);
  t.after(() => clearTimeout(tx._txTimer));
});
