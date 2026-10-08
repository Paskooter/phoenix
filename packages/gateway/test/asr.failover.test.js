// Synthetic provider failures only: local HTTP/WS Parakeet and in-process Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import { AsrRouter, asrSettingsFromEnv, setAsrRouter, asrStatus } from '../src/asr/asrRouter.js';
import { startSession } from '../src/asr/factory.js';
import { GoogleUsageMeter, initializeGoogleUsageFile } from '../src/asr/googleUsage.js';
import { FailoverSocket, ParakeetHealth } from '../src/asr/failoverTransport.js';
import { RecognizerSocket, parseControl } from '../src/asr/recognizerSocket.js';
import { fakeGoogleSpeech, recognizeResponse } from './fixtures/fakeGoogleSpeech.js';
import { startStubParakeet, unusedUrl, wavPcm } from './fixtures/stubParakeet.js';

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pcm(amplitude = 8000, ms = 100) {
  const buffer = Buffer.alloc(32 * ms);
  for (let i = 0; i < buffer.length / 2; i += 1) buffer.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buffer;
}
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  assert.fail('synthetic condition timed out');
}
function routerFor(t, url, google, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phx-failover-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'usage.json');
  initializeGoogleUsageFile(file);
  const settings = asrSettingsFromEnv({
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: url,
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project',
    PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: join(directory, 'synthetic-never-read.json'),
    PHOENIX_GOOGLE_STT_USAGE_FILE: file, ...env,
  });
  settings.failover = { ...settings.failover, probeTimeoutMs: 150, openTimeoutMs: 200, finalTimeoutMs: 100,
    recoveryIntervalMs: 60000, batchTimeoutMs: 200 };
  let clientCreations = 0;
  const router = new AsrRouter(settings, { createClient: async () => { clientCreations += 1; return google.client; }, log: LOG });
  t.after(() => router.close());
  return { router, settings, file, get clientCreations() { return clientCreations; } };
}
function feed(session, speechFrames = 4) {
  const frames = [...Array.from({ length: speechFrames }, () => pcm()),
    ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, () => pcm(0))];
  for (const frame of frames) session.provideAudio(frame);
  return Buffer.concat(frames);
}
async function stubFor(t, opts) {
  const stub = await startStubParakeet(opts);
  t.after(() => stub.close());
  return stub;
}

test('unset/unknown/parakeet mode uses the original session without any router or Google client', (t) => {
  const old = process.env.PHOENIX_ASR_PROVIDER;
  const oldReference = process.env.ETCO_server_asrProvider;
  t.after(() => {
    if (old === undefined) delete process.env.PHOENIX_ASR_PROVIDER; else process.env.PHOENIX_ASR_PROVIDER = old;
    if (oldReference === undefined) delete process.env.ETCO_server_asrProvider; else process.env.ETCO_server_asrProvider = oldReference;
    setAsrRouter(null);
  });
  delete process.env.ETCO_server_asrProvider;
  setAsrRouter(null);
  for (const mode of [undefined, 'unknown', 'parakeet']) {
    if (mode === undefined) delete process.env.PHOENIX_ASR_PROVIDER; else process.env.PHOENIX_ASR_PROVIDER = mode;
    const session = startSession({ lang: 'en-US' }, LOG);
    assert.ok(session instanceof ParakeetASRSession);
    assert.equal(session.transport, null);
    assert.deepEqual(asrStatus(), { mode: 'parakeet', parakeet: null, google: null });
    session.abort();
  }
});

test('auto keeps a healthy Parakeet stream completely isolated from Google', async (t) => {
  const stub = await stubFor(t, { final: { text: 'parakeet answer', confidence: 0.7 } });
  const google = fakeGoogleSpeech();
  const setup = routerFor(t, stub.url, google);
  const session = setup.router.startSession({ lang: 'en-US' }, LOG);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  feed(session);
  assert.deepEqual(await result, { text: 'parakeet answer', confidence: 0.7 });
  assert.equal(setup.clientCreations, 0);
  assert.equal(google.calls.streams.length, 0);
  assert.equal(google.calls.recognize.length, 0);
});

test('manual Google selection does not probe or call Parakeet', async (t) => {
  const stub = await stubFor(t, {});
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('Manual 5.').finish() });
  const { router } = routerFor(t, stub.url, google, { PHOENIX_ASR_PROVIDER: 'google' });
  const session = router.startSession({ lang: 'en-US' }, LOG);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  feed(session);
  assert.equal((await result).text, 'manual five');
  assert.equal(stub.healthz, 0);
  assert.equal(stub.connections.length, 0);
  assert.equal(stub.transcribe.length, 0);
});

for (const scenario of ['refused', 'unhealthy']) {
  test(`Parakeet ${scenario} at start: buffered initial audio reaches Google in order`, async (t) => {
    const primary = scenario === 'refused' ? await unusedUrl() : await stubFor(t, { healthz: 500 });
    const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('Testing 1, 2, 3!').finish() });
    const { router } = routerFor(t, primary.url, google);
    const session = router.startSession({ lang: 'en-US' }, LOG);
    const result = session.start();
    const prefix = pcm(); session.provideAudio(prefix); // accepted during the probe
    await waitFor(() => session.streamingReady);
    const remainder = feed(session);
    assert.equal((await result).text, 'testing one two three');
    assert.deepEqual(google.calls.streams[0].pcm, Buffer.concat([prefix, remainder]));
    assert.equal(router.health(primary.url).state, 'down');
  });
}

test('Parakeet dies mid-stream: replay and newly arriving audio form one complete Google utterance', async (t) => {
  const stub = await stubFor(t, { onBinary: (conn, socket) => { if (conn.bytes >= 6400) socket.terminate(); } });
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('Recovered 42.').finish() });
  const { router } = routerFor(t, stub.url, google);
  const session = router.startSession({ lang: 'en-US' }, LOG);
  let eos = 0; let finals = 0;
  session.onEndOfSpeech(() => { eos += 1; });
  session.onResult(() => { finals += 1; });
  const result = session.start();
  await waitFor(() => session.streamingReady);
  const before = Buffer.concat([pcm(), pcm()]); session.provideAudio(before);
  await waitFor(() => google.calls.streams.length === 1);
  const after = feed(session);
  assert.equal((await result).text, 'recovered forty two');
  assert.deepEqual(google.calls.streams[0].pcm, Buffer.concat([before, after]));
  assert.equal(eos, 1);
  assert.equal(finals, 1);
  assert.equal(google.calls.recognize.length, 0);
});

test('Parakeet gives no final after EOS: one bounded Google batch receives the full window', async (t) => {
  const stub = await stubFor(t, { onEos() {} });
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Timed recovery') });
  const { router } = routerFor(t, stub.url, google);
  const session = router.startSession({ lang: 'en-US' }, LOG);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  const sent = feed(session);
  assert.equal((await result).text, 'timed recovery');
  assert.deepEqual(google.calls.recognize[0].request.content, sent);
  assert.equal(google.calls.streams.length, 0);
  assert.equal(google.calls.recognize.length, 1);
  assert.equal(router.health(stub.url).reason, 'parakeet-slow');
});

test('a 20-second ended turn with a primary interim uses batch without another 20-second replay', async (t) => {
  const stub = await stubFor(t, { onBinary: (conn, socket) => {
    if (!conn.interim) { conn.interim = true; socket.send(JSON.stringify({ type: 'interim', text: 'synthetic prefix' })); }
  }, onEos() {} });
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Complete synthetic utterance') });
  const { router } = routerFor(t, stub.url, google);
  const session = router.startSession({ lang: 'en-US' }, LOG);
  let finals = 0; let eos = 0;
  session.onResult(() => { finals += 1; }); session.onEndOfSpeech(() => { eos += 1; });
  const result = session.start();
  await waitFor(() => session.streamingReady);
  const started = Date.now(); const sent = feed(session, 200);
  assert.equal((await result).text, 'complete synthetic utterance');
  assert.ok(Date.now() - started < 3000, 'ended audio must not be replayed at real time');
  assert.deepEqual(google.calls.recognize[0].request.content, sent);
  assert.equal(google.calls.streams.length, 0); assert.equal(google.calls.recognize.length, 1);
  assert.equal(finals, 1); assert.equal(eos, 1);
});

test('a primary failure just before a 30-second EOS buffers to one batch within the remaining Hub time', async (t) => {
  const stub = await stubFor(t, { onBinary: (conn, socket) => { if (conn.bytes >= 29 * 32000) socket.terminate(); } });
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Complete long window') });
  const { router } = routerFor(t, stub.url, google); let now = Date.now(); router.now = () => now;
  const session = router.startSession({}, LOG); const result = session.start();
  await waitFor(() => session.streamingReady);
  const before = pcm(8000, 29000); now += 29000; session.provideAudio(before);
  await waitFor(() => session.streamingFailed);
  const after = pcm(8000, 1000); now += 1000; session.provideAudio(after);
  assert.equal((await result).text, 'complete long window');
  assert.deepEqual(google.calls.recognize[0].request.content, Buffer.concat([before, after]));
  assert.equal(google.calls.streams.length, 0); assert.equal(google.calls.recognize.length, 1);
  assert.ok(google.calls.recognize[0].options.timeoutMs <= 9750, 'batch deadline fits remaining 40s phase');
});

test('old Parakeet batch failure sends exactly the same PCM to synchronous Google recognition', async (t) => {
  const stub = await stubFor(t, { healthz: 'old', batch: { status: 503 } });
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Batch 3') });
  const { router } = routerFor(t, stub.url, google);
  const session = router.startSession({ lang: 'en-US' }, LOG);
  const result = session.start();
  await waitFor(() => session.streamingUnsupported);
  const sent = feed(session);
  assert.equal((await result).text, 'batch three');
  assert.deepEqual(wavPcm(stub.transcribe[0]), sent);
  assert.deepEqual(google.calls.recognize[0].request.content, sent);
  assert.equal(google.calls.streams.length, 0);
});

test('auto admits a short batch near the cap even when a full stream reservation would not fit', async (t) => {
  const primary = await unusedUrl();
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Within budget') });
  const { router, file } = routerFor(t, primary.url, google, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '1', PHOENIX_GOOGLE_STT_DAILY_MINUTES: '0' });
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60 });
  meter.commit(meter.reserve(48), 48);
  const session = router.startSession({ lang: 'en-US' }, LOG);
  const result = session.start();
  await waitFor(() => session.streamingUnsupported);
  feed(session);
  assert.equal((await result).text, 'within budget');
  assert.equal(google.calls.streams.length, 0);
  assert.equal(google.calls.recognize.length, 1);
});

test('Parakeet recovery requires two consecutive health successes and backs off after a flap', async () => {
  let now = 1000;
  let reachable = false;
  const health = new ParakeetHealth({ probe: async () => ({ reachable }), now: () => now,
    recoveryIntervalMs: 10000, maxRecoveryIntervalMs: 30000, recoverySuccesses: 2, flapWindowMs: 60000 });
  try {
    health.markDown('fixture-failure');
    reachable = true;
    await health._check(); assert.equal(health.state, 'down');
    reachable = false;
    await health._check(); assert.equal(health.successes, 0);
    reachable = true;
    await health._check(); await health._check(); assert.equal(health.state, 'up');
    now += 1000; health.markDown('flap'); assert.equal(health.intervalMs, 20000);
    await health._check(); await health._check();
    now += 1000; health.markDown('flap'); assert.equal(health.intervalMs, 30000);
  } finally { health.close(); }
});

test('recovery sends new turns back to Parakeet while the existing Google turn stays on Google', async (t) => {
  const primary = await unusedUrl();
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('Existing Google turn').finish() });
  const { router } = routerFor(t, primary.url, google);
  const existing = router.startSession({ lang: 'en-US' }, LOG);
  const oldResult = existing.start();
  await waitFor(() => existing.streamingReady);
  existing.provideAudio(pcm());
  const stub = await startStubParakeet({ final: { text: 'new parakeet turn', confidence: 0.8 } }, primary.port);
  t.after(() => stub.close());
  const health = router.health(primary.url);
  await health._check(); assert.equal(health.state, 'down');
  await health._check(); assert.equal(health.state, 'up');
  const fresh = router.startSession({ lang: 'en-US' }, LOG);
  const freshResult = fresh.start();
  await waitFor(() => fresh.streamingReady);
  feed(fresh); feed(existing);
  assert.equal((await freshResult).text, 'new parakeet turn');
  assert.equal((await oldResult).text, 'existing google turn');
  assert.equal(google.calls.streams.length, 1);
});

class SyntheticSocket extends RecognizerSocket {
  constructor({ open = true } = {}) {
    super(); this.sent = [];
    if (open) setImmediate(() => this._emitOpen());
  }
  send(value) { this.sent.push(value); }
  terminate() { this._emitClose(); } // deliberately synchronous teardown
  close() { this._emitClose(); }
}

test('synchronous primary teardown cannot close the replacement; stale and duplicate finals are suppressed', async () => {
  const primary = new SyntheticSocket();
  const secondary = new SyntheticSocket({ open: false });
  const socket = new FailoverSocket({ openPrimary: () => primary, openSecondary: () => secondary });
  const messages = []; let closed = 0;
  socket.on('message', (b) => messages.push(parseControl(b)));
  socket.on('close', () => { closed += 1; });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'start' })); socket.send(pcm());
  primary._emitError(new Error('synthetic failure'));
  assert.equal(closed, 0);
  socket.send(pcm()); socket.send(JSON.stringify({ type: 'eos' }));
  secondary._emitOpen();
  assert.equal(secondary.sent.filter(Buffer.isBuffer).length, 2);
  assert.equal(parseControl(secondary.sent.at(-1)).type, 'eos');
  primary._emitMessage({ type: 'final', text: 'stale' });
  secondary._emitMessage({ type: 'final', text: 'once' });
  secondary._emitMessage({ type: 'final', text: 'duplicate' });
  assert.deepEqual(messages.map((m) => m.text), ['once']);
  socket.terminate();
  await sleep(5);
  assert.equal(closed, 1, 'caller termination emits close once even with synchronous inner teardown');
});

test('an unopened primary switches within its connect deadline; cancellation prevents late replacement writes', async () => {
  const primary = new SyntheticSocket({ open: false });
  const secondary = new SyntheticSocket({ open: false });
  let switches = 0;
  const socket = new FailoverSocket({ openPrimary: () => primary, openSecondary: () => { switches += 1; return secondary; }, openTimeoutMs: 20 });
  await waitFor(() => switches === 1);
  socket.terminate();
  secondary._emitOpen();
  await sleep(10);
  assert.equal(socket.readyState, 3);
  assert.equal(secondary.sent.length, 0);
});

test('secondary failure closes once and cannot bounce to another provider', async () => {
  const primary = new SyntheticSocket();
  const secondary = new SyntheticSocket({ open: false });
  let switches = 0; let errors = 0; let closes = 0;
  const socket = new FailoverSocket({ openPrimary: () => primary, openSecondary: () => { switches += 1; return secondary; } });
  socket.on('error', () => { errors += 1; }); socket.on('close', () => { closes += 1; });
  await once(socket, 'open');
  primary._emitError(new Error('synthetic primary failure'));
  secondary._emitOpen();
  secondary._emitError(new Error('synthetic secondary failure'));
  secondary._emitError(new Error('late duplicate failure'));
  assert.equal(switches, 1); assert.equal(errors, 1); assert.equal(closes, 1);
});
