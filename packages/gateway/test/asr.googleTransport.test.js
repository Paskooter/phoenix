// Google Speech-to-Text V2 behind the same endpointing session as Parakeet.
//
// The turn logic is ParakeetASRSession's in both cases; these tests pin that a
// Google-backed session keeps the Parakeet contract the hub and robot rely on:
// SOS/EOS timing from the local endpointer, interim results through the
// incremental seam, FAST_EOS on interims, finals and confidence in the same
// shape, relisten on an empty endpoint, batch fallback with the whole window,
// cancellation -- and that every transcript arrives in the Parakeet text
// format. The Google client is an in-process fake: no network, no credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import { AsrRouter, asrSettingsFromEnv } from '../src/asr/asrRouter.js';
import { GoogleUsageMeter } from '../src/asr/googleUsage.js';
import { GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST, buildRecognitionConfig } from '../src/asr/googleSpeech.js';
import { PARAKEET_TEXT } from '../src/asr/transcriptNormalizer.js';
import { fakeGoogleSpeech, recognizeResponse } from './fixtures/fakeGoogleSpeech.js';

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FFMPEG = spawnSync(process.env.PHOENIX_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function pcmChunk(amplitude, ms = 100) {
  const samples = Math.floor((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
}
const SPEECH = () => pcmChunk(8000);
const silence = () => Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, () => pcmChunk(0));

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for condition');
}

function withTimeout(promise, ms = 4000) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`timed out after ${ms}ms`); })]);
}

function googleRouter(t, google, env = {}, meterOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-google-asr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const usageFile = join(dir, 'usage.json');
  const settings = asrSettingsFromEnv({
    PHOENIX_ASR_PROVIDER: 'google',
    PHOENIX_GOOGLE_STT_PROJECT: 'fixture-project',
    PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: join(dir, 'never-read.json'),
    PHOENIX_GOOGLE_STT_USAGE_FILE: usageFile,
    ...env,
  });
  const meter = new GoogleUsageMeter({
    file: usageFile,
    monthlyLimitSeconds: settings.google.monthlyLimitSeconds,
    dailyLimitSeconds: settings.google.dailyLimitSeconds,
    ...meterOptions,
  });
  const router = new AsrRouter(settings, { createClient: async () => google.client, meter, log: SILENT });
  t.after(() => router.close());
  return { router, meter, usageFile, settings };
}

// --- request shape --------------------------------------------------------------

test('the V2 request: implicit recognizer, 16 kHz LINEAR16, no punctuation, hints as phrases, interims on', async (t) => {
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('What time is it?').finish() });
  const { router } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-CA', hints: ['yes', 'no', 'jibo', '  ', 'jibo'] }, SILENT);
  const startPr = session.start();
  await waitFor(() => session.streamingReady);
  for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  const result = await withTimeout(startPr);
  assert.equal(result.text, 'what time is it');

  const [stream] = google.calls.streams;
  assert.deepEqual(stream.firstRequest, {
    recognizer: 'projects/fixture-project/locations/us/recognizers/_',
    streamingConfig: {
      config: {
        explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1 },
        // V2 has no English (Canada) model; Parakeet has one English model too.
        languageCodes: ['en-US'],
        model: 'chirp_3',
        features: { enableAutomaticPunctuation: false, profanityFilter: false, maxAlternatives: 1 },
        adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: [{ value: 'yes' }, { value: 'no' }, { value: 'jibo' }] } }] },
      },
      streamingFeatures: { interimResults: true },
    },
  });
});

test('denoiser and a hint boost are opt-in settings', () => {
  const config = buildRecognitionConfig({ model: 'chirp_3', lang: 'en-US', hints: ['jibo'], denoise: true, hintBoost: 30 });
  assert.deepEqual(config.denoiserConfig, { denoiseAudio: true, snrThreshold: 0 });
  assert.equal(config.adaptation.phraseSets[0].inlinePhraseSet.boost, 20, 'boost is capped at the API maximum');
  const plain = buildRecognitionConfig({ model: 'short', lang: 'en-US', hints: [] });
  assert.equal(plain.denoiserConfig, undefined);
  assert.equal(plain.adaptation, undefined, 'no phrase set without hints');
});

// --- the turn ---------------------------------------------------------------------

test('Google turn: SOS/EOS from the local endpointer, normalized interims and final, every PCM byte sent', async (t) => {
  const google = fakeGoogleSpeech({
    onAudio: (s) => {
      if (s.bytes >= 6400 && !s.sentInterim) { s.sentInterim = true; s.interim('Set a timer for 5'); }
    },
    onHalfClose: (s) => s.final('Set a timer for 5 minutes.').billed(2).finish(),
  });
  const { router, meter } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  let sos = 0; let eos = 0; const seen = [];
  session.onStartOfSpeech(() => { sos += 1; });
  session.onEndOfSpeech(() => { eos += 1; });
  session.onResult((r) => seen.push(r));
  const startPr = session.start();
  await waitFor(() => session.streamingReady);
  const sent = [];
  for (let i = 0; i < 5; i += 1) { const f = SPEECH(); sent.push(f); session.provideAudio(f); }
  await waitFor(() => seen.length > 0);
  assert.deepEqual(seen[0], { text: 'set a timer for five', confidence: null }, 'interims reach the incremental seam in Parakeet format');
  assert.equal(session.getLastIncremental().text, 'set a timer for five');
  assert.equal(sos, 1);
  assert.equal(eos, 0, 'no EOS before the local endpoint');
  for (const f of silence()) { sent.push(f); session.provideAudio(f); }

  const result = await withTimeout(startPr);
  assert.deepEqual(result, { text: 'set a timer for five minutes', confidence: 1 },
    'chirp_3 reports no real confidence, so the session synthesizes it exactly as for a Parakeet server without one');
  assert.match(result.text, PARAKEET_TEXT);
  assert.equal(eos, 1, 'one wire EOS');

  const [stream] = google.calls.streams;
  assert.deepEqual(stream.pcm, Buffer.concat(sent), 'Google received exactly the accepted PCM, in order');
  assert.ok(stream.audio.every((chunk) => chunk.length <= GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST), 'every request is within 25 KB');
  assert.ok(stream.audio.slice(0, -1).every((chunk) => chunk.length === 6400), 'audio is coalesced to 200 ms requests');
  assert.equal(stream.halfClosed, true);
  assert.equal(meter.status().usedSeconds, 2, 'billed seconds are recorded');
});

test('FAST_EOS fires on a normalized interim ("5" matches the earlyEOS word "five")', async (t) => {
  const google = fakeGoogleSpeech({
    onAudio: (s) => { if (s.bytes >= 6400 && !s.done) { s.done = true; s.interim('5'); } },
  });
  const { router } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US', earlyEOS: ['five'] }, SILENT);
  let eos = 0;
  session.onEndOfSpeech(() => { eos += 1; });
  const startPr = session.start();
  for (let i = 0; i < 4; i += 1) session.provideAudio(SPEECH());
  const result = await withTimeout(startPr);
  assert.deepEqual(result, { text: 'five', confidence: 1, annotation: 'FAST_EOS' });
  assert.equal(eos, 1, 'EOS is emitted before resolving, without waiting for silence');
  assert.equal(google.calls.streams[0].halfClosed, true, 'the stream is ended at the trigger');
});

test('several final segments become one utterance; a model with real confidence passes it on', async (t) => {
  const google = fakeGoogleSpeech({
    onAudio: (s) => { if (s.bytes >= 9600 && !s.done) { s.done = true; s.final('Turn on the lights', 0.9); } },
    onHalfClose: (s) => s.final('in the kitchen.', 0.6).finish(),
  });
  const { router } = googleRouter(t, google, { PHOENIX_GOOGLE_STT_MODEL: 'short' });
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  await waitFor(() => session.streamingReady);
  for (let i = 0; i < 6; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  const result = await withTimeout(startPr);
  assert.equal(result.text, 'turn on the lights in the kitchen');
  // Word-weighted: 4 words at 0.9 and 3 at 0.6.
  assert.ok(Math.abs(result.confidence - (4 * 0.9 + 3 * 0.6) / 7) < 1e-9, `confidence ${result.confidence}`);
});

test('an empty Google final on a silence endpoint relistens on a fresh stream; one EOS', async (t) => {
  let streams = 0;
  const google = fakeGoogleSpeech({
    onStream: () => { streams += 1; },
    onHalfClose: (s) => (streams === 1 ? s.finish() : s.final('What time is it').finish()),
  });
  const { router } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  let eos = 0;
  session.onEndOfSpeech(() => { eos += 1; });
  const startPr = session.start();
  await waitFor(() => session.streamingReady);
  for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await waitFor(() => session.relistenCount === 1);
  assert.equal(eos, 0, 'a false endpoint does not tell the robot to stop');
  await waitFor(() => session.streamingReady);
  for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  const result = await withTimeout(startPr);
  assert.equal(result.text, 'what time is it');
  assert.equal(eos, 1);
  assert.equal(google.calls.streams.length, 2, 'each recognition window is its own Google request');
});

test('a Google stream error falls back to synchronous Recognize with the whole window', async (t) => {
  const google = fakeGoogleSpeech({
    onAudio: (s) => { if (s.bytes >= 6400 && !s.failed) { s.failed = true; s.fail(14, 'unavailable'); } },
    recognize: () => recognizeResponse('Recovered utterance', 0, 3),
  });
  const { router, meter } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  const sent = [];
  for (let i = 0; i < 4; i += 1) { const f = SPEECH(); sent.push(f); session.provideAudio(f); }
  await waitFor(() => session.streamingFailed);
  for (const f of silence()) { sent.push(f); session.provideAudio(f); }
  const result = await withTimeout(startPr);
  assert.equal(result.text, 'recovered utterance');
  assert.equal(google.calls.recognize.length, 1);
  const request = google.calls.recognize[0].request;
  assert.deepEqual(request.content, Buffer.concat(sent), 'the batch request carries the complete window as PCM');
  assert.equal(request.recognizer, 'projects/fixture-project/locations/us/recognizers/_');
  assert.ok(meter.status().usedSeconds >= 3, 'both requests are counted');
});

test('cancellation: abort() cancels the Google stream and still counts the audio sent', async (t) => {
  const google = fakeGoogleSpeech();
  const { router, meter } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  for (let i = 0; i < 12; i += 1) session.provideAudio(SPEECH());
  await waitFor(() => google.calls.streams[0]?.bytes >= 32000);
  session.abort();
  assert.equal(await withTimeout(startPr), undefined);
  await waitFor(() => google.calls.streams[0].cancelled);
  await waitFor(() => meter.status().usedSeconds > 0);
  assert.equal(meter.status().reservedSeconds, 0, 'the reservation is released');
});

test('stop() before speech resolves undefined and opens no paid request beyond the reservation', async (t) => {
  const google = fakeGoogleSpeech();
  const { router, meter } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  session.provideAudio(pcmChunk(0));
  session.stop();
  assert.equal(await withTimeout(startPr), undefined);
  await sleep(20);
  assert.equal(meter.status().usedSeconds, 0, 'silence that was never sent costs nothing');
  assert.equal(meter.status().reservedSeconds, 0);
});

// --- budget ------------------------------------------------------------------------

test('a spent monthly budget means Google is never called and the turn fails like an unreachable recognizer', async (t) => {
  const google = fakeGoogleSpeech();
  const { router, meter } = googleRouter(t, google, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '1' });
  const used = meter.reserve(60);
  meter.commit(used, 60);
  assert.equal(meter.status().exhausted, 'month');
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await assert.rejects(withTimeout(startPr), (err) => err.code === 'GOOGLE_STT_BUDGET');
  assert.equal(google.calls.streams.length, 0);
  assert.equal(google.calls.recognize.length, 0);
});

test('the usage ledger survives a restart', async (t) => {
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('hello').billed(4).finish() });
  const { router, usageFile, settings } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  const startPr = session.start();
  await waitFor(() => session.streamingReady);
  for (let i = 0; i < 3; i += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await withTimeout(startPr);
  const saved = JSON.parse(readFileSync(usageFile, 'utf8'));
  assert.equal(saved.monthSeconds, 4);
  const reloaded = new GoogleUsageMeter({ file: usageFile, monthlyLimitSeconds: settings.google.monthlyLimitSeconds });
  assert.equal(reloaded.status().usedSeconds, 4);
});

// --- encoded audio -----------------------------------------------------------------

test('OGG_OPUS from the robot is decoded locally and Google receives 16 kHz PCM', { skip: !FFMPEG && 'ffmpeg is required for encoded audio' }, async (t) => {
  const pcm = Buffer.concat([pcmChunk(0, 200), ...Array.from({ length: 8 }, () => {
    const b = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i += 1) b.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), i * 2);
    return b;
  }), pcmChunk(0, ASR_SILENCE_TO_EOS_MS + 400)]);
  const encoded = spawnSync(process.env.PHOENIX_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-page_duration', '20000', '-f', 'ogg', 'pipe:1'], { input: pcm });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('A tone').finish() });
  const { router } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US', encoding: 'OGG_OPUS' }, SILENT);
  const startPr = session.start();
  for (let offset = 0; offset < encoded.stdout.length; offset += 400) {
    session.provideAudio(encoded.stdout.subarray(offset, offset + 400));
    await sleep(1);
  }
  const result = await withTimeout(startPr, 8000);
  assert.equal(result.text, 'a tone');
  const sentBytes = google.calls.streams[0].bytes;
  assert.ok(sentBytes > 16000 && sentBytes % 2 === 0, `Google received decoded PCM (${sentBytes} bytes)`);
});

test('a Google session is the same endpointing session class the Parakeet path uses', (t) => {
  const google = fakeGoogleSpeech();
  const { router } = googleRouter(t, google);
  const session = router.startSession({ lang: 'en-US' }, SILENT);
  assert.ok(session instanceof ParakeetASRSession);
  assert.equal(session.transport.name, 'google');
  session.abort();
});
