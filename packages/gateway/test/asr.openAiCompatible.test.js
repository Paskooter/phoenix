// OpenAI-compatible batch speech recognition: OpenRouter (JSON, the one shared
// OpenRouter key, openrouter.ai only) and a custom URL (multipart, its own
// optional key). Everything runs against local stub servers; no request ever
// leaves this machine and no real key is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asrFailureFields } from '@phoenix/common';
import { AsrRouter, ASR_MODES, asrMode, asrSettingsFromEnv } from '../src/asr/asrRouter.js';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import { initializeGoogleUsageFile } from '../src/asr/googleUsage.js';
import {
  OPENROUTER_DEFAULT_STT_MODEL, OPENROUTER_TRANSCRIPTIONS_URL, customTranscriptionsUrl,
} from '../src/asr/openAiCompatibleTransport.js';
import {
  TranscriptionUsageMeter, initializeTranscriptionUsageFile, transcriptionUsageFile,
} from '../src/asr/transcriptionUsage.js';
import { fakeGoogleSpeech, recognizeResponse } from './fixtures/fakeGoogleSpeech.js';
import { startStubParakeet, unusedUrl } from './fixtures/stubParakeet.js';
import { parseMultipart, redirectingFetch, startStubTranscriptions } from './fixtures/stubTranscriptions.js';

const ONE_KEY = 'fixture-openrouter-one-key';
const CUSTOM_KEY = 'fixture-custom-endpoint-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordingLog() {
  const records = [];
  const at = (level) => (message, fields) => records.push({ level, message, fields });
  return { records, debug() {}, info: at('info'), warn: at('warn'), error: at('error') };
}

function wavOf(ms = 1000) {
  const pcm = Buffer.alloc(32 * ms);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE((i % 2 ? 1 : -1) * 6000, i * 2);
  return ParakeetASRSession.makeWav(pcm);
}

async function stub(t, reply) {
  const server = await startStubTranscriptions(reply);
  t.after(() => server.close());
  return server;
}

/** A router over temporary, initialized ledgers. */
function routerFor(t, env = {}, deps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-asr-openai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const openRouterLedger = join(dir, 'openrouter-stt-usage.json');
  const customLedger = join(dir, 'custom-stt-usage.json');
  const googleLedger = join(dir, 'google-stt-usage.json');
  initializeTranscriptionUsageFile(openRouterLedger);
  initializeTranscriptionUsageFile(customLedger);
  initializeGoogleUsageFile(googleLedger);
  const settings = asrSettingsFromEnv({
    PHOENIX_ASR_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: ONE_KEY,
    PHOENIX_OPENROUTER_STT_USAGE_FILE: openRouterLedger,
    PHOENIX_CUSTOM_STT_USAGE_FILE: customLedger,
    PHOENIX_GOOGLE_STT_USAGE_FILE: googleLedger,
    ...env,
  });
  const log = deps.log || recordingLog();
  const router = new AsrRouter(settings, { log, createClient: async () => { throw new Error('Google must not be used'); }, ...deps });
  t.after(() => router.close());
  return { router, settings, log, dir, openRouterLedger, customLedger };
}

function feed(session) {
  const speech = Buffer.alloc(3200);
  for (let n = 0; n < 1600; n += 1) speech.writeInt16LE(n % 2 ? 8000 : -8000, n * 2);
  for (let n = 0; n < 4; n += 1) session.provideAudio(speech);
  for (let n = 0; n < Math.ceil(ASR_SILENCE_TO_EOS_MS / 100); n += 1) session.provideAudio(Buffer.alloc(3200));
}

function noSecrets(t, value, ...secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 12)}…`);
}

// --- settings ---------------------------------------------------------------

test('new modes and the Parakeet -> OpenRouter -> Google fallback order', () => {
  assert.deepEqual(ASR_MODES, ['parakeet', 'auto', 'google', 'openrouter', 'custom']);
  assert.equal(asrMode('OpenRouter'), 'openrouter');
  assert.equal(asrMode('custom'), 'custom');
  const plain = asrSettingsFromEnv({});
  assert.equal(plain.mode, 'parakeet');
  assert.deepEqual(plain.fallbackOrder, ['openrouter', 'google']);
  assert.equal(plain.openrouter.model, OPENROUTER_DEFAULT_STT_MODEL);
  assert.equal(plain.openrouter.model, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.equal(plain.openrouter.language, 'en');
  assert.equal(plain.openrouter.configurationProblem, 'no-key');
  assert.equal(plain.custom.configurationProblem, 'no-url');
  assert.deepEqual(asrSettingsFromEnv({ PHOENIX_ASR_FALLBACK_ORDER: 'parakeet, google ,openrouter' }).fallbackOrder, ['google', 'openrouter']);
  assert.deepEqual(asrSettingsFromEnv({ PHOENIX_ASR_FALLBACK_ORDER: 'custom,google' }).fallbackOrder, ['custom', 'google']);
  const bad = asrSettingsFromEnv({ PHOENIX_ASR_FALLBACK_ORDER: 'google,whisper' });
  assert.deepEqual(bad.fallbackOrder, ['openrouter', 'google']);
  assert.equal(bad.fallbackOrderProblem, 'invalid-fallback-order');
  for (const value of ['-1', 'abc', 'Infinity']) {
    assert.equal(asrSettingsFromEnv({ OPENROUTER_API_KEY: ONE_KEY, PHOENIX_OPENROUTER_STT_MONTHLY_USD: value }).openrouter.configurationProblem, 'invalid-budget');
  }
});

test('the OpenRouter key is the one shared key and never appears in settings or status', (t) => {
  const settings = asrSettingsFromEnv({ OPENROUTER_API_KEY: ` ${ONE_KEY} `, PHOENIX_CUSTOM_STT_URL: 'http://192.0.2.7:8000' });
  assert.equal(settings.openrouter.apiKey(), ONE_KEY);
  // A custom endpoint never inherits the OpenRouter key.
  assert.equal(settings.custom.apiKey(), '');
  noSecrets(t, settings, ONE_KEY);
  // An older server whose shared LLM endpoint is OpenRouter keeps working.
  assert.equal(asrSettingsFromEnv({ PHOENIX_LLM_URL: 'https://openrouter.ai/api/v1', PHOENIX_LLM_API_KEY: 'fixture-shared' }).openrouter.apiKey(), 'fixture-shared');
  assert.equal(asrSettingsFromEnv({ PHOENIX_LLM_URL: 'http://192.0.2.9/v1', PHOENIX_LLM_API_KEY: 'fixture-shared' }).openrouter.apiKey(), '');
});

test('custom URLs: base, /v1 or full path; never openrouter.ai, credentials or other schemes', () => {
  assert.equal(customTranscriptionsUrl('http://192.0.2.7:8000'), 'http://192.0.2.7:8000/v1/audio/transcriptions');
  assert.equal(customTranscriptionsUrl('http://192.0.2.7:8000/v1/'), 'http://192.0.2.7:8000/v1/audio/transcriptions');
  assert.equal(customTranscriptionsUrl('https://asr.example.invalid/openai/v1/audio/transcriptions'), 'https://asr.example.invalid/openai/v1/audio/transcriptions');
  assert.equal(customTranscriptionsUrl('https://asr.example.invalid/api'), 'https://asr.example.invalid/api/v1/audio/transcriptions');
  for (const bad of ['', 'not a url', 'ftp://192.0.2.7/v1', 'http://user:pass@192.0.2.7/v1', 'https://openrouter.ai/api/v1', 'https://www.openrouter.ai/api/v1']) {
    assert.equal(customTranscriptionsUrl(bad), null, bad);
  }
  assert.equal(asrSettingsFromEnv({ PHOENIX_CUSTOM_STT_URL: 'https://openrouter.ai/api/v1' }).custom.configurationProblem, 'invalid-url');
  assert.equal(OPENROUTER_TRANSCRIPTIONS_URL, 'https://openrouter.ai/api/v1/audio/transcriptions');
});

// --- body shapes ------------------------------------------------------------

test('OpenRouter: JSON base64 body with the one key, sent only to openrouter.ai, normalized text, cost recorded', async (t) => {
  const server = await stub(t, () => ({ json: { text: 'Hey, Jibo! Set a timer for 5 minutes.', usage: { seconds: 1, cost: 0.000123 } } }));
  const fetchImpl = redirectingFetch(server.url);
  const { router, log, openRouterLedger } = routerFor(t, {}, { fetch: fetchImpl });
  const wav = wavOf(1000);
  const result = await router._openAiTransport('openrouter', { lang: 'en-US', hints: ['jibo'] }, log).recognizeWav(wav);
  assert.deepEqual(result, { text: 'hey jibo set a timer for five minutes', confidence: null });
  assert.deepEqual(fetchImpl.urls, ['https://openrouter.ai/api/v1/audio/transcriptions']);
  const [request] = server.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/audio/transcriptions');
  assert.equal(request.headers.authorization, `Bearer ${ONE_KEY}`);
  assert.match(request.headers['content-type'], /^application\/json/);
  const body = JSON.parse(request.body.toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['input_audio', 'language', 'model']);
  assert.equal(body.model, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.equal(body.language, 'en');
  assert.equal(body.input_audio.format, 'wav');
  assert.deepEqual(Buffer.from(body.input_audio.data, 'base64'), wav);
  // Hints are not sent: OpenRouter drops `prompt` silently.
  assert.equal(request.body.includes('jibo'), false);
  const usage = new TranscriptionUsageMeter({ file: openRouterLedger, monthlyLimitMicroUsd: 1 }).status();
  assert.equal(usage.usedMicroUsd, 123);
  assert.equal(usage.usedSeconds, 1);
  assert.equal(usage.requests, 1);
  assert.equal(usage.reservedMicroUsd, 0);
  noSecrets(t, log.records, ONE_KEY);
  noSecrets(t, router.status(), ONE_KEY);
});

test('OpenRouter refuses any destination other than https://openrouter.ai before sending the key', async (t) => {
  let called = 0;
  const { router, log } = routerFor(t, {}, { fetch: () => { called += 1; throw new Error('must not run'); } });
  router.settings.openrouter.endpoint = 'http://192.0.2.10/api/v1/audio/transcriptions';
  await assert.rejects(router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf()), { code: 'OPENAI_STT_UNAVAILABLE' });
  assert.equal(called, 0);
});

test('custom: multipart /v1/audio/transcriptions with its own key, never the OpenRouter key', async (t) => {
  const server = await stub(t, () => ({ json: { text: "It's 3:30 PM." } }));
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'custom', PHOENIX_CUSTOM_STT_URL: `${server.url}/v1`, PHOENIX_CUSTOM_STT_API_KEY: CUSTOM_KEY,
    PHOENIX_CUSTOM_STT_MODEL: 'parakeet-tdt-0.6b-v3',
  });
  const wav = wavOf(500);
  assert.deepEqual(await router._openAiTransport('custom', {}, log).recognizeWav(wav), { text: "it's three thirty pm", confidence: null });
  const [request] = server.requests;
  assert.equal(request.url, '/v1/audio/transcriptions');
  assert.equal(request.headers.authorization, `Bearer ${CUSTOM_KEY}`);
  assert.equal(request.body.includes(ONE_KEY), false);
  const parts = parseMultipart(request);
  assert.deepEqual(Object.keys(parts).sort(), ['file', 'language', 'model', 'response_format']);
  assert.equal(parts.file.filename, 'audio.wav');
  assert.equal(parts.file.contentType, 'audio/wav');
  assert.deepEqual(parts.file.value, wav);
  assert.equal(parts.model.value.toString(), 'parakeet-tdt-0.6b-v3');
  assert.equal(parts.language.value.toString(), 'en');
  assert.equal(parts.response_format.value.toString(), 'json');
  noSecrets(t, log.records, ONE_KEY, CUSTOM_KEY);
});

test('custom without its own key sends no Authorization at all, even with the OpenRouter key set', async (t) => {
  const server = await stub(t, () => ({ json: { text: 'hello' } }));
  const { router, log } = routerFor(t, { PHOENIX_ASR_PROVIDER: 'custom', PHOENIX_CUSTOM_STT_URL: server.url });
  assert.equal((await router._openAiTransport('custom', {}, log).recognizeWav(wavOf())).text, 'hello');
  assert.equal(server.requests[0].headers.authorization, undefined);
  assert.equal(parseMultipart(server.requests[0]).model, undefined, 'no model field when none is configured');
  // No cap configured: a self-hosted endpoint runs unmetered and needs no ledger.
  assert.equal(router.status().custom.usage, null);
});

// --- failures pause the provider -------------------------------------------

for (const [status, kind, pauseMs] of [[401, 'credentials', 5 * 60 * 1000], [402, 'payment', 5 * 60 * 1000],
  [400, 'configuration', 5 * 60 * 1000], [500, 'server', 30 * 1000], [503, 'server', 30 * 1000]]) {
  test(`HTTP ${status} rejects, pauses OpenRouter (${kind}) and logs no key or body`, async (t) => {
    let now = Date.now();
    const server = await stub(t, (_req, state) => (state.requests.length === 1
      ? { status, json: { error: { message: 'synthetic provider detail' } } }
      : { json: { text: 'Back again.' } }));
    const { router, log, openRouterLedger } = routerFor(t, {}, { fetch: redirectingFetch(server.url), now: () => now });
    const transport = router._openAiTransport('openrouter', {}, log);
    await assert.rejects(transport.recognizeWav(wavOf()), (err) => {
      assert.equal(err.httpStatus, status);
      assert.equal(err.message.includes('synthetic provider detail'), false);
      return true;
    });
    assert.equal(router.providerUnavailable('openrouter'), kind);
    await assert.rejects(router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf()), { code: 'OPENAI_STT_UNAVAILABLE' });
    assert.equal(server.requests.length, 1, 'a paused provider is not called');
    const record = log.records.find((r) => r.level === (pauseMs > 60000 ? 'error' : 'warn'));
    assert.ok(record, 'the failure is logged');
    assert.equal(record.fields.provider, 'openrouter');
    assert.equal(record.fields.errorCode, `HTTP_${status}`);
    assert.equal(record.fields.kind, kind);
    assert.equal(record.fields.pauseMs, pauseMs);
    noSecrets(t, log.records, ONE_KEY, 'synthetic provider detail');
    // A refused request is not billed.
    const usage = new TranscriptionUsageMeter({ file: openRouterLedger, monthlyLimitMicroUsd: 1 }).status();
    assert.equal(usage.usedMicroUsd, 0); assert.equal(usage.reservedMicroUsd, 0);
    now += pauseMs;
    assert.equal(router.providerUnavailable('openrouter'), null);
    assert.equal((await router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf())).text, 'back again');
    assert.equal(router.status().openrouter.lastFailure.kind, kind);
  });
}

test('HTTP 429 pauses for the Retry-After the provider asked for', async (t) => {
  let now = Date.now();
  const server = await stub(t, () => ({ status: 429, headers: { 'retry-after': '7' }, json: {} }));
  const { router, log } = routerFor(t, {}, { fetch: redirectingFetch(server.url), now: () => now });
  await assert.rejects(router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf()), { httpStatus: 429 });
  assert.equal(router.providerUnavailable('openrouter'), 'rate-limited');
  now += 6999; assert.equal(router.providerUnavailable('openrouter'), 'rate-limited');
  now += 1; assert.equal(router.providerUnavailable('openrouter'), null);
});

test('a request that outlives its timeout is abandoned, counted conservatively and pauses the provider', async (t) => {
  const server = await stub(t, () => ({ delayMs: 2000, json: { text: 'too late' } }));
  const { router, log, openRouterLedger } = routerFor(t, { PHOENIX_OPENROUTER_STT_TIMEOUT_MS: '150' }, { fetch: redirectingFetch(server.url) });
  const started = Date.now();
  await assert.rejects(router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf(1000)), { code: 'OPENAI_STT_TIMEOUT' });
  assert.ok(Date.now() - started < 1500, 'gave up at the timeout');
  assert.equal(router.providerUnavailable('openrouter'), 'timeout');
  const usage = new TranscriptionUsageMeter({ file: openRouterLedger, monthlyLimitMicroUsd: 1 }).status();
  assert.ok(usage.usedMicroUsd > 0, 'an unanswered request may have been billed');
  assert.equal(usage.reservedMicroUsd, 0);
  assert.equal(log.records.at(-1).fields.errorCode, 'OPENAI_STT_TIMEOUT');
});

test('an unreachable custom endpoint is a logged, pausing error', async (t) => {
  const { url } = await unusedUrl();
  const { router, log } = routerFor(t, { PHOENIX_ASR_PROVIDER: 'custom', PHOENIX_CUSTOM_STT_URL: url });
  await assert.rejects(router._openAiTransport('custom', {}, log).recognizeWav(wavOf()), { code: 'ECONNREFUSED' });
  assert.equal(router.providerUnavailable('custom'), 'unreachable');
  assert.equal(log.records.at(-1).fields.provider, 'custom');
});

// --- results ----------------------------------------------------------------

test('an empty transcript is a real "no speech" result; a missing or broken one is an error', async (t) => {
  const replies = [
    { json: { text: '', usage: { cost: 0.00001 } } },
    { json: { text: '  ...  ' } },
    { json: { text: '[BLANK_AUDIO]' } },
    { json: { usage: { cost: 0.00001 } } },
    { raw: 'not json' },
    { json: { text: 42 } },
  ];
  const server = await stub(t, (_req, state) => replies[state.requests.length - 1]);
  let now = Date.now();
  const { router, log } = routerFor(t, {}, { fetch: redirectingFetch(server.url), now: () => now });
  const recognize = () => router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf());
  for (let n = 0; n < 3; n += 1) {
    assert.deepEqual(await recognize(), { text: '', confidence: null });
    assert.equal(router.providerUnavailable('openrouter'), null, 'silence is not a failure');
  }
  for (let n = 0; n < 3; n += 1) {
    await assert.rejects(recognize(), { code: 'OPENAI_STT_INVALID_RESPONSE' });
    assert.equal(router.providerUnavailable('openrouter'), 'invalid-response');
    now += 30 * 1000;
  }
  assert.equal(server.requests.length, 6);
});

test('punctuation, digits and symbols are normalized to the Parakeet format', async (t) => {
  const texts = ['What’s 2 + 2?', 'Play “Daisy Bell”, please…', 'Turn it up to 11%!', 'HELLO JIBO.'];
  const server = await stub(t, (_req, state) => ({ json: { text: texts[state.requests.length - 1] } }));
  const { router, log } = routerFor(t, {}, { fetch: redirectingFetch(server.url) });
  const got = [];
  for (let n = 0; n < texts.length; n += 1) got.push((await router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf())).text);
  assert.deepEqual(got, ["what's two plus two", 'play daisy bell please', 'turn it up to eleven percent', 'hello jibo']);
  for (const text of got) assert.match(text, /^(?:[a-z']+(?: [a-z']+)*)?$/);
});

// --- usage ledger -----------------------------------------------------------

test('the monthly dollar cap refuses dispatch before any request; a missing ledger keeps OpenRouter off', async (t) => {
  const server = await stub(t, () => ({ json: { text: 'expensive', usage: { cost: 0.004 } } }));
  const { router, log } = routerFor(t, { PHOENIX_OPENROUTER_STT_MONTHLY_USD: '0.005', PHOENIX_OPENROUTER_STT_DAILY_USD: '1' },
    { fetch: redirectingFetch(server.url) });
  assert.equal((await router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf(1000))).text, 'expensive');
  await assert.rejects(router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf(5000)), { code: 'OPENAI_STT_BUDGET' });
  assert.equal(server.requests.length, 1);
  assert.equal(router.status().openrouter.usage.usedMicroUsd, 4000);
  assert.equal(router.providerUnavailable('openrouter'), null, 'a budget refusal is not a provider failure');

  const missing = routerFor(t, { PHOENIX_OPENROUTER_STT_USAGE_FILE: join(tmpdir(), 'phx-never-created', 'ledger.json') },
    { fetch: redirectingFetch(server.url) });
  assert.equal(missing.router.providerUnavailable('openrouter'), 'usage-file-missing');
  await assert.rejects(missing.router._openAiTransport('openrouter', {}, log).recognizeWav(wavOf()), { code: 'OPENAI_STT_UNAVAILABLE' });
  assert.equal(server.requests.length, 1);
});

test('ledger: reserve, commit actual cost, daily and minute caps, refusal on damage, threshold warnings', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-stt-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  assert.equal(transcriptionUsageFile({ PHOENIX_DATA_DIR: '/var/lib/phx' }, 'openrouter'), '/var/lib/phx/asr/openrouter-stt-usage.json');
  assert.equal(transcriptionUsageFile({ PHOENIX_OPENROUTER_STT_USAGE_FILE: '/x.json' }, 'openrouter'), '/x.json');
  assert.equal(transcriptionUsageFile({}, 'custom'), null);
  initializeTranscriptionUsageFile(file);
  assert.throws(() => initializeTranscriptionUsageFile(file), { code: 'EEXIST' });
  const log = recordingLog();
  const meter = new TranscriptionUsageMeter({ file, monthlyLimitMicroUsd: 10000, dailyLimitMicroUsd: 6000, monthlyLimitSeconds: 600, log });
  const a = meter.reserve({ microUsd: 3000, seconds: 10 });
  assert.equal(meter.status().reservedMicroUsd, 3000);
  meter.commit(a, { microUsd: 5000, seconds: 10 });
  assert.equal(meter.status().usedMicroUsd, 5000);
  assert.ok(log.records.some((r) => r.level === 'warn' && /50%/.test(r.message)));
  assert.equal(meter.refusal({ microUsd: 1001 }), 'daily-limit');
  assert.equal(meter.refusal({ microUsd: 1, seconds: 591 }), 'monthly-minutes');
  assert.equal(meter.reserve({ microUsd: 1001, seconds: 1 }), null);
  const b = meter.reserve({ microUsd: 100, seconds: 1 });
  meter.commit(b, { microUsd: 0, seconds: 0 });
  assert.equal(meter.status().requests, 1, 'an unbilled request is not counted');
  new TranscriptionUsageMeter({ file, monthlyLimitMicroUsd: 1 }).fs.writeFileSync(file, '{"broken":');
  assert.equal(new TranscriptionUsageMeter({ file, monthlyLimitMicroUsd: 10000 }).refusal({ microUsd: 1 }), 'usage-file-invalid');
  assert.equal(new TranscriptionUsageMeter({ file: null, monthlyLimitMicroUsd: 10000 }).refusal({ microUsd: 1 }), 'no-usage-file');
  assert.equal(existsSync(`${file}.lock`), false);
});

// --- router modes -----------------------------------------------------------

test('openrouter mode: a whole robot turn is recognized in one batch request', async (t) => {
  const server = await stub(t, () => ({ json: { text: 'What time is it?', usage: { cost: 0.00002 } } }));
  const { router, log } = routerFor(t, {}, { fetch: redirectingFetch(server.url) });
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  feed(session);
  // The session supplies its historical 1.0 when a recognizer reports no confidence.
  assert.deepEqual(await result, { text: 'what time is it', confidence: 1 });
  assert.equal(server.requests.length, 1);
  assert.deepEqual(session.describe(), { provider: 'openrouter', model: 'nvidia/parakeet-tdt-0.6b-v3' });
  const status = router.status();
  assert.equal(status.mode, 'openrouter');
  assert.equal(status.openrouter.configured, true);
  assert.equal(status.openrouter.model, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.equal(status.openrouter.usage.usedMicroUsd, 20);
  noSecrets(t, status, ONE_KEY, server.url);
});

test('custom mode: a whole robot turn goes to the custom URL', async (t) => {
  const server = await stub(t, () => ({ json: { text: 'Good morning.' } }));
  const { router, log } = routerFor(t, { PHOENIX_ASR_PROVIDER: 'custom', PHOENIX_CUSTOM_STT_URL: server.url });
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  feed(session);
  assert.equal((await result).text, 'good morning');
  assert.equal(session.describe().provider, 'custom');
  noSecrets(t, router.status(), server.url);
});

test('a provider failure in a single-provider mode fails the turn; it never succeeds with empty text', async (t) => {
  const server = await stub(t, () => ({ status: 502, json: {} }));
  const { router, log } = routerFor(t, {}, { fetch: redirectingFetch(server.url) });
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  feed(session);
  await assert.rejects(result, { httpStatus: 502 });
});

test('auto: Parakeet down -> OpenRouter answers; Google is not touched', async (t) => {
  const parakeet = await unusedUrl();
  const server = await stub(t, () => ({ json: { text: 'From OpenRouter.' } }));
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('From Google.') });
  let googleClients = 0;
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeet.url,
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/never-read.json',
  }, { fetch: redirectingFetch(server.url), createClient: async () => { googleClients += 1; return google.client; } });
  router.settings.failover = { ...router.settings.failover, probeTimeoutMs: 150, batchTimeoutMs: 300 };
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  feed(session);
  assert.equal((await result).text, 'from openrouter');
  assert.equal(server.requests.length, 1);
  assert.equal(googleClients, 0);
  assert.equal(session.describe().provider, 'openrouter');
});

test('auto: OpenRouter fails -> the same window goes to Google, and OpenRouter is paused for the next turn', async (t) => {
  const parakeet = await unusedUrl();
  const server = await stub(t, () => ({ status: 500, json: {} }));
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('From Google 2.') });
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeet.url,
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/never-read.json',
  }, { fetch: redirectingFetch(server.url), createClient: async () => google.client });
  router.settings.failover = { ...router.settings.failover, probeTimeoutMs: 150, batchTimeoutMs: 300 };
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  feed(session);
  assert.equal((await result).text, 'from google two');
  assert.equal(server.requests.length, 1);
  assert.equal(router.providerUnavailable('openrouter'), 'server');
  assert.ok(google.calls.recognize.length + google.calls.streams.length >= 1);
});

test('auto honors a configured order: Google before OpenRouter', async (t) => {
  const parakeet = await unusedUrl();
  const server = await stub(t, () => ({ json: { text: 'From OpenRouter.' } }));
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('From Google.'), onHalfClose: (s) => s.final('From Google.').finish() });
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeet.url, PHOENIX_ASR_FALLBACK_ORDER: 'parakeet,google,openrouter',
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/never-read.json',
  }, { fetch: redirectingFetch(server.url), createClient: async () => google.client });
  router.settings.failover = { ...router.settings.failover, probeTimeoutMs: 150, batchTimeoutMs: 300 };
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  await sleep(250);
  feed(session);
  assert.equal((await result).text, 'from google');
  assert.equal(server.requests.length, 0);
});

test('auto without an OpenRouter key behaves exactly as before: Parakeet, then Google', async (t) => {
  const parakeet = await unusedUrl();
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Only Google.'), onHalfClose: (s) => s.final('Only Google.').finish() });
  let fetched = 0;
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeet.url, OPENROUTER_API_KEY: '',
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/never-read.json',
  }, { fetch: () => { fetched += 1; throw new Error('must not run'); }, createClient: async () => google.client });
  router.settings.failover = { ...router.settings.failover, probeTimeoutMs: 150, batchTimeoutMs: 300 };
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  await sleep(250);
  feed(session);
  assert.equal((await result).text, 'only google');
  assert.equal(fetched, 0);
  assert.equal(router.status().openrouter.configured, false);
});

function pcmFrame(amplitude = 8000, ms = 100) {
  const buffer = Buffer.alloc(32 * ms);
  for (let i = 0; i < buffer.length / 2; i += 1) buffer.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buffer;
}
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  assert.fail('synthetic condition timed out');
}
function autoWithParakeet(t, parakeetUrl, server) {
  const setup = routerFor(t, { PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeetUrl }, { fetch: redirectingFetch(server.url) });
  setup.router.settings.failover = { ...setup.router.settings.failover, probeTimeoutMs: 150, openTimeoutMs: 200, finalTimeoutMs: 100,
    recoveryIntervalMs: 60000, batchTimeoutMs: 200 };
  return setup;
}
function sentPcm(request) {
  const body = JSON.parse(request.body.toString('utf8'));
  return Buffer.from(body.input_audio.data, 'base64').subarray(44);
}

test('auto: Parakeet dies mid-stream -> the whole window (replay + new audio) is one OpenRouter request', async (t) => {
  const parakeet = await startStubParakeet({ onBinary: (conn, socket) => { if (conn.bytes >= 6400) socket.terminate(); } });
  t.after(() => parakeet.close());
  const server = await stub(t, () => ({ json: { text: 'Recovered 42.' } }));
  const { router, log } = autoWithParakeet(t, parakeet.url, server);
  const session = router.startSession({ lang: 'en-US' }, log);
  let finals = 0;
  session.onResult(() => { finals += 1; });
  const result = session.start();
  await waitFor(() => session.streamingReady);
  const before = Buffer.concat([pcmFrame(), pcmFrame()]);
  session.provideAudio(before);
  await sleep(100);
  const frames = [...Array.from({ length: 4 }, () => pcmFrame()),
    ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, () => pcmFrame(0))];
  for (const frame of frames) session.provideAudio(frame);
  assert.equal((await result).text, 'recovered forty two');
  assert.equal(server.requests.length, 1);
  assert.deepEqual(sentPcm(server.requests[0]), Buffer.concat([before, ...frames]));
  assert.equal(finals, 1);
  assert.equal(router.health(parakeet.url).state, 'down');
});

test('auto: Parakeet dies mid-stream, OpenRouter fails at end of speech -> Google recognizes the same window', async (t) => {
  const parakeet = await startStubParakeet({ onBinary: (conn, socket) => { if (conn.bytes >= 6400) socket.terminate(); } });
  t.after(() => parakeet.close());
  const server = await stub(t, () => ({ status: 503, json: {} }));
  const google = fakeGoogleSpeech({ recognize: () => recognizeResponse('Google kept it.') });
  const { router, log } = routerFor(t, {
    PHOENIX_ASR_PROVIDER: 'auto', PARAKEET_URL: parakeet.url,
    PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/never-read.json',
  }, { fetch: redirectingFetch(server.url), createClient: async () => google.client });
  router.settings.failover = { ...router.settings.failover, probeTimeoutMs: 150, openTimeoutMs: 200, finalTimeoutMs: 100,
    recoveryIntervalMs: 60000, batchTimeoutMs: 200 };
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  const before = Buffer.concat([pcmFrame(), pcmFrame()]);
  session.provideAudio(before);
  await sleep(100);
  const frames = [...Array.from({ length: 4 }, () => pcmFrame()),
    ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, () => pcmFrame(0))];
  for (const frame of frames) session.provideAudio(frame);
  assert.equal((await result).text, 'google kept it');
  assert.equal(server.requests.length, 1);
  assert.deepEqual(sentPcm(server.requests[0]), Buffer.concat([before, ...frames]));
  assert.equal(google.calls.recognize.length, 1);
  assert.deepEqual(google.calls.recognize[0].request.content, Buffer.concat([before, ...frames]));
  assert.equal(google.calls.streams.length, 0);
  assert.equal(router.providerUnavailable('openrouter'), 'server');
});

test('auto: Parakeet gives no final after end of speech -> one OpenRouter batch gets the full window', async (t) => {
  const parakeet = await startStubParakeet({ onEos() {} });
  t.after(() => parakeet.close());
  const server = await stub(t, () => ({ json: { text: 'Timed recovery.' } }));
  const { router, log } = autoWithParakeet(t, parakeet.url, server);
  const session = router.startSession({ lang: 'en-US' }, log);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  feed(session);
  assert.equal((await result).text, 'timed recovery');
  assert.equal(server.requests.length, 1);
  assert.equal(router.health(parakeet.url).reason, 'parakeet-slow');
});

test('failure records name the new providers instead of "unknown"', () => {
  assert.equal(asrFailureFields({ httpStatus: 401 }, { provider: 'openrouter' }).provider, 'openrouter');
  assert.equal(asrFailureFields({ code: 'OPENAI_STT_TIMEOUT' }, { provider: 'custom' }).errorCode, 'OPENAI_STT_TIMEOUT');
  for (const code of ['OPENAI_STT_BUDGET', 'OPENAI_STT_UNAVAILABLE', 'OPENAI_STT_INVALID_RESPONSE', 'OPENAI_STT_CANCELLED', 'OPENAI_STT_ERROR']) {
    assert.equal(asrFailureFields({ code }, {}).errorCode, code);
  }
});
