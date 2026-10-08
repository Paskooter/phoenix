import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsrRouter, asrSettingsFromEnv, setAsrRouter } from '../src/asr/asrRouter.js';
import { initializeGoogleUsageFile } from '../src/asr/googleUsage.js';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import { fakeGoogleSpeech, recognizeResponse } from './fixtures/fakeGoogleSpeech.js';

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function waitFor(fn) { for (let n = 0; n < 500; n += 1) { if (fn()) return; await sleep(5); } assert.fail('synthetic condition timed out'); }
function fixture(t, env = {}, dependencies = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-asr-router-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'usage.json'); initializeGoogleUsageFile(file);
  const settings = asrSettingsFromEnv({ PHOENIX_ASR_PROVIDER: 'google', PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project',
    PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: join(dir, 'never-read.json'), PHOENIX_GOOGLE_STT_USAGE_FILE: file, ...env });
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Synthetic result') });
  const router = new AsrRouter(settings, { createClient: async () => google.client, log: LOG, ...dependencies });
  t.after(() => router.close()); return { router, settings, google };
}
function feed(session) {
  const speech = Buffer.alloc(3200); for (let n = 0; n < 1600; n += 1) speech.writeInt16LE(n % 2 ? 8000 : -8000, n * 2);
  for (let n = 0; n < 4; n += 1) session.provideAudio(speech);
  for (let n = 0; n < Math.ceil(ASR_SILENCE_TO_EOS_MS / 100); n += 1) session.provideAudio(Buffer.alloc(3200));
}

test('defaults retain Parakeet and omitted caps; malformed explicit caps fail closed', () => {
  const plain = asrSettingsFromEnv({}); assert.equal(plain.mode, 'parakeet');
  assert.equal(plain.google.monthlyLimitSeconds, 560 * 60); assert.equal(plain.google.dailyLimitSeconds, 56 * 60);
  for (const value of ['-1', 'not-a-number', 'Infinity', '1e99']) {
    const settings = asrSettingsFromEnv({ PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: value });
    assert.equal(settings.google.configurationProblem, 'invalid-budget'); assert.equal(settings.google.monthlyLimitSeconds, 0);
  }
  assert.equal(asrSettingsFromEnv({ PHOENIX_GOOGLE_STT_DAILY_MINUTES: '-1' }).google.configurationProblem, 'invalid-budget');
  assert.equal(asrSettingsFromEnv({ PHOENIX_GOOGLE_STT_MODEL: 'chirp_2', PHOENIX_GOOGLE_STT_LOCATION: 'us' }).google.configurationProblem, 'invalid-model-or-location');
  assert.equal(asrSettingsFromEnv({ PHOENIX_GOOGLE_STT_MODEL: 'chirp_2', PHOENIX_GOOGLE_STT_LOCATION: 'us-central1' }).google.configurationProblem, null);
});

test('missing durable state prevents client construction and credential paths never enter status', (t) => {
  let created = 0;
  const { router } = fixture(t, { PHOENIX_GOOGLE_STT_USAGE_FILE: '/synthetic/nonexistent-ledger.json' }, {
    createClient: () => { created += 1; throw new Error('must not run'); },
  });
  assert.equal(router.googleUnavailable(), 'usage-file-missing');
  assert.equal(router._googleTransport({}, LOG).available(), false); assert.equal(created, 0);
  const text = JSON.stringify(router.status());
  assert.equal(text.includes('synthetic-project'), false); assert.equal(text.includes('never-read.json'), false);
});

test('configuration errors pause Google for five minutes without retrying each request', async (t) => {
  let now = Date.now(); let creations = 0; let reject = true;
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Recovered') });
  const { router } = fixture(t, {}, { now: () => now, createClient: async () => {
    creations += 1; if (reject) throw Object.assign(new Error('synthetic hidden detail'), { code: 7 }); return google.client;
  } });
  const transport = router._googleTransport({}, LOG); const wav = ParakeetASRSession.makeWav(Buffer.alloc(32000));
  await assert.rejects(transport.recognizeWav(wav)); assert.equal(router.googleUnavailable(), 'credentials');
  await assert.rejects(transport.recognizeWav(wav), { code: 'GOOGLE_STT_UNAVAILABLE' }); assert.equal(creations, 1);
  now += 5 * 60 * 1000; reject = false;
  assert.equal((await router._googleTransport({}, LOG).recognizeWav(wav)).text, 'recovered'); assert.equal(creations, 2);
});

test('configuration pause is checked again after delayed client bootstrap', async (t) => {
  const bootstrap = deferred();
  const { router, google } = fixture(t, {}, { createClient: () => bootstrap.promise });
  const transport = router._googleTransport({}, LOG);
  const result = transport.recognizeWav(ParakeetASRSession.makeWav(Buffer.alloc(32000)));
  await sleep(10); router._recordGoogleFailure('credentials', { code: 7 }); bootstrap.resolve(google.client);
  await assert.rejects(result, { code: 'GOOGLE_STT_UNAVAILABLE' });
  assert.equal(google.calls.recognize.length, 0); assert.equal(router.googleUnavailable(), 'credentials');
  assert.equal(router._meter().status().reservedSeconds, 0); assert.equal(router._meter().status().usedSeconds, 0);
});

test('retiring a router lets an already dispatched batch drain before closing its client', async (t) => {
  const reply = deferred(); const google = fakeGoogleSpeech({ recognize: () => reply.promise });
  const { router } = fixture(t, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '0.2' }, { createClient: async () => google.client });
  setAsrRouter(router); t.after(() => setAsrRouter(null));
  const session = router.startSession({}, LOG); const result = session.start(); feed(session);
  await waitFor(() => google.calls.recognize.length === 1);
  const replacement = fixture(t).router; setAsrRouter(replacement);
  assert.equal(google.calls.closed, 0); assert.equal(router.retired, true);
  reply.resolve(recognizeResponse('Uninterrupted result'));
  assert.equal((await result).text, 'uninterrupted result');
  await waitFor(() => google.calls.closed === 1); assert.equal(google.calls.recognize.length, 1);
  assert.throws(() => router.startSession({}, LOG), /retired/);
});

test('router generations share stream admission while retired sessions are draining', async (t) => {
  const first = fixture(t, { PHOENIX_GOOGLE_STT_MAX_STREAMS: '1' });
  const oldSession = first.router.startSession({}, LOG); const oldResult = oldSession.start();
  await waitFor(() => first.google.calls.streams.length === 1); first.router.close();
  const second = fixture(t, { PHOENIX_GOOGLE_STT_MAX_STREAMS: '1' });
  const nextSession = second.router.startSession({}, LOG); const nextResult = nextSession.start();
  await waitFor(() => nextSession.streamingFailed);
  assert.equal(second.google.calls.streams.length, 0); assert.equal(second.router.status().google.activeStreams, 1);
  nextSession.abort(); oldSession.abort(); await Promise.all([nextResult, oldResult]);
  await waitFor(() => first.google.calls.closed === 1);
  assert.equal(second.router.status().google.activeStreams, 0);
});

test('abort before delayed bootstrap dispatches no paid request and retired bootstrap closes', async (t) => {
  const bootstrap = deferred(); const { router, google } = fixture(t, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '0.2' }, { createClient: () => bootstrap.promise });
  const session = router.startSession({}, LOG); const result = session.start(); feed(session);
  await waitFor(() => router.clientPromise !== null); session.abort(); router.close();
  assert.equal(await result, undefined); bootstrap.resolve(google.client);
  await waitFor(() => google.calls.closed === 1); assert.equal(google.calls.recognize.length, 0);
  assert.equal(router._meter().status().usedSeconds, 0); assert.equal(router._meter().status().reservedSeconds, 0);
});

test('an almost exhausted Hub deadline refuses new paid dispatch and leaves no reservation', async (t) => {
  let now = Date.now(); let created = 0;
  const { router, google } = fixture(t, {}, { now: () => now, createClient: async () => { created++; return google.client; } });
  const transport = router._googleTransport({}, LOG); now += 39000;
  await assert.rejects(transport.recognizeWav(ParakeetASRSession.makeWav(Buffer.alloc(32000))), { code: 'GOOGLE_STT_TIMEOUT' });
  assert.equal(created, 0); assert.equal(google.calls.recognize.length, 0); assert.equal(router._meter().status().reservedSeconds, 0);
});
