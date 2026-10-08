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
import { GoogleUsageMeter, initializeGoogleUsageFile } from '../src/asr/googleUsage.js';
import { GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST, buildRecognitionConfig } from '../src/asr/googleSpeech.js';
import { GOOGLE_STREAM_MAX_AUDIO_BYTES } from '../src/asr/googleTransport.js';
import { once } from 'node:events';
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
  initializeGoogleUsageFile(usageFile);
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
  assert.equal(google.calls.streams[0].cancelled, true, 'the paid stream is cancelled at the trigger without sending queued audio');
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

for (const ending of ['error', 'end']) {
  test(`paced Google ${ending} before actual half-close retries the complete queued window`, async (t) => {
    const google = fakeGoogleSpeech({ onAudio: (stream) => {
      if (stream.scheduled) return; stream.scheduled = true;
      stream.interim('Synthetic prefix');
      setTimeout(() => ending === 'error' ? stream.fail(14) : stream.finish(), 50);
    }, recognize: () => recognizeResponse('Complete synthetic utterance') });
    const { router, meter } = googleRouter(t, google);
    const session = router.startSession({}, SILENT); const result = session.start();
    await waitFor(() => session.streamingReady);
    const sent = [...Array.from({ length: 5 }, () => SPEECH()), ...silence()];
    for (const frame of sent) session.provideAudio(frame);
    assert.equal((await result).text, 'complete synthetic utterance');
    assert.equal(google.calls.streams[0].halfClosed, false);
    assert.ok(google.calls.streams[0].bytes < Buffer.concat(sent).length);
    assert.deepEqual(google.calls.recognize[0].request.content, Buffer.concat(sent));
    assert.equal(google.calls.recognize.length, 1); assert.ok(meter.status().usedSeconds >= 3);
  });
}

test('a final timeout retains confirmed segments and the trailing interim hypothesis', async (t) => {
  const google = fakeGoogleSpeech({ onHalfClose: (s) => { s.final('Confirmed segment'); s.interim('Trailing 5'); } });
  const { router, settings } = googleRouter(t, google); settings.google.finalTimeoutMs = 30;
  const session = router.startSession({}, SILENT); const result = session.start();
  await waitFor(() => session.streamingReady);
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  assert.deepEqual(await result, { text: 'confirmed segment trailing five', confidence: 1 });
  assert.equal(google.calls.recognize.length, 0); assert.equal(google.calls.streams[0].cancelled, true);
});

test('queued replay is paced at PCM duration and requests remain within the conservative API limit', async (t) => {
  const wroteAt = []; const google = fakeGoogleSpeech({ onAudio: () => wroteAt.push(Date.now()), onHalfClose: (s) => s.final('Paced').finish() });
  const { router } = googleRouter(t, google);
  const session = router.startSession({}, SILENT); const result = session.start();
  await waitFor(() => session.streamingReady);
  for (let n = 0; n < 6; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await result;
  assert.ok(wroteAt.length >= 5);
  for (let n = 1; n < wroteAt.length; n += 1) assert.ok(wroteAt[n] - wroteAt[n - 1] >= 180, '200ms audio must not be replayed in a burst');
  assert.ok(google.calls.streams[0].audio.every((chunk) => chunk.length <= GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST));
});

test('audio beyond the reserved stream window is refused before writing it', async (t) => {
  const google = fakeGoogleSpeech(); const { router, meter } = googleRouter(t, google);
  const socket = router._googleTransport({}, SILENT).openStream();
  const error = once(socket, 'error'); await once(socket, 'open');
  socket.send(Buffer.alloc(GOOGLE_STREAM_MAX_AUDIO_BYTES + 2));
  assert.equal((await error)[0].code, 'GOOGLE_STT_TOO_LONG');
  assert.equal(google.calls.streams[0].bytes, 0); assert.equal(meter.status().usedSeconds, 0);
  assert.equal(meter.status().reservedSeconds, 0);
});

test('client bootstrap has a bounded deadline and releases the durable reservation', async (t) => {
  const google = fakeGoogleSpeech(); const { router, settings, meter } = googleRouter(t, google);
  settings.google.connectTimeoutMs = 25; router.createClient = () => new Promise(() => {});
  const session = router.startSession({}, SILENT); const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await assert.rejects(result, { code: 'GOOGLE_STT_TIMEOUT' });
  assert.equal(google.calls.streams.length, 0); assert.equal(google.calls.recognize.length, 0);
  assert.equal(meter.status().reservedSeconds, 0); assert.equal(meter.status().usedSeconds, 0);
});

test('a dispatched synchronous request has a deadline and counts its full audio on timeout', async (t) => {
  const google = fakeGoogleSpeech({ recognize: () => new Promise(() => {}) });
  const { router, settings, meter } = googleRouter(t, google, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '0.2' });
  settings.google.recognizeTimeoutMs = 30;
  const session = router.startSession({}, SILENT); const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await assert.rejects(result, { code: 'GOOGLE_STT_TIMEOUT' });
  assert.equal(google.calls.recognize.length, 1); assert.equal(meter.status().usedSeconds, 2);
  assert.equal(meter.status().reservedSeconds, 0);
});

test('abort after batch dispatch suppresses all late callbacks while retaining billed audio', async (t) => {
  let resolve; const reply = new Promise((r) => { resolve = r; });
  const google = fakeGoogleSpeech({ recognize: () => reply });
  const { router, meter } = googleRouter(t, google, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '0.2' });
  const session = router.startSession({}, SILENT); let callbacks = 0;
  session.onResult(() => { callbacks += 1; }); const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await waitFor(() => google.calls.recognize.length === 1); session.abort(); assert.equal(await result, undefined);
  resolve(recognizeResponse('Must not arrive')); await sleep(20);
  assert.equal(callbacks, 0); assert.equal(google.calls.recognize.length, 1);
  assert.equal(meter.status().usedSeconds, 2); assert.equal(meter.status().reservedSeconds, 0);
});

test('FLAC is decoded by the shared session before the Google request', { skip: !FFMPEG && 'ffmpeg is required for encoded audio' }, async (t) => {
  const pcm = Buffer.concat([...Array.from({ length: 6 }, () => SPEECH()), ...silence()]);
  const encoded = spawnSync(process.env.PHOENIX_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-f', 'flac', 'pipe:1'], { input: pcm });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('FLAC input').finish() });
  const { router } = googleRouter(t, google); const session = router.startSession({ encoding: 'FLAC' }, SILENT);
  const result = session.start();
  await waitFor(() => session.streamingReady);
  for (let offset = 0; offset < encoded.stdout.length; offset += 200) session.provideAudio(encoded.stdout.subarray(offset, offset + 200));
  await waitFor(() => session.sosFired);
  session.stop(); assert.equal((await result).text, 'flac input');
  assert.deepEqual(google.calls.streams[0].pcm, pcm);
});

test('an already ready batch response cannot deliver callbacks after an abort in the same microtask turn', async (t) => {
  let session; let finals = 0; let eosAfterAbort = 0;
  const google = fakeGoogleSpeech({ recognize: () => {
    queueMicrotask(() => session.abort()); return recognizeResponse('Must not be delivered');
  } });
  const { router, meter } = googleRouter(t, google, { PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '0.2' });
  session = router.startSession({}, SILENT); session.onResult(() => { finals += 1; });
  session.onEndOfSpeech(() => { if (session.aborted) eosAfterAbort += 1; });
  const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  assert.equal(await result, undefined); await sleep(20);
  assert.equal(finals, 0); assert.equal(eosAfterAbort, 0); assert.equal(session.lastResult, null);
  assert.equal(google.calls.recognize.length, 1); assert.equal(meter.status().usedSeconds, 2);
});

test('a late startup probe cannot open an abandoned stream while batch owns finalization', async (t) => {
  let resolveProbe; let resolveReply;
  const probe = new Promise((r) => { resolveProbe = r; }); const reply = new Promise((r) => { resolveReply = r; });
  const google = fakeGoogleSpeech({ recognize: () => reply }); const { router, meter } = googleRouter(t, google);
  const session = router.startSession({}, SILENT); session.transport.probeStreaming = () => probe;
  const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await waitFor(() => google.calls.recognize.length === 1); resolveProbe(true); await sleep(30);
  assert.equal(google.calls.streams.length, 0); assert.equal(session.state, 'FINALIZING');
  resolveReply(recognizeResponse('Batch owns window')); assert.equal((await result).text, 'batch owns window'); await sleep(30);
  assert.equal(google.calls.streams.length, 0); assert.equal(router.status().google.activeStreams, 0);
  assert.equal(meter.status().reservedSeconds, 0);
});

test('raw Google provider details never reach shared-session logs or final errors', async (t) => {
  const hidden = 'synthetic-private-provider-detail'; const captured = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => captured.push(args)]));
  const { router } = googleRouter(t, fakeGoogleSpeech());
  router.createClient = async () => { throw Object.assign(new Error(hidden), { code: 14 }); };
  const session = router.startSession({}, log); const result = session.start();
  for (let n = 0; n < 3; n += 1) session.provideAudio(SPEECH());
  for (const frame of silence()) session.provideAudio(frame);
  await assert.rejects(result, (error) => error.code === 'GOOGLE_STT_ERROR' && error.grpcCode === 14 && !error.message.includes(hidden));
  assert.equal(JSON.stringify(captured).includes(hidden), false);
});
