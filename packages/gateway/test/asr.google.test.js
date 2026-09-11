// H-07: original ASR behavior through a replaceable provider.
//
// Unit coverage for the Google streaming provider port and the shared FastEOS
// utility. The recognizer stream is a recorded/fake in-process stream, so the
// full client-visible contract (interim/final transcripts, SOS/EOS, FAST_EOS and
// GARBAGE annotations, the 3 s final-result timeout and the error envelope) is
// exercised with no live vendor. Reference citations are file:line into the
// pinned Pegasus tree (jiboV2/pegasus), packages/hub/src/asr/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FastEOS } from '../src/asr/fastEOS.js';
import { GoogleASRSession } from '../src/asr/googleSession.js';
import { createGoogleRequest, startSession, GoogleASRProvider, setRecognizerFactory } from '../src/asr/googleProvider.js';
import { startSession as factoryStartSession, setASRProvider } from '../src/asr/factory.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** In-process fake recognizer stream: records writes, emits ASROutput frames. */
function fakeRecognizer() {
  const stream = new EventEmitter();
  stream.written = [];
  stream.ended = false;
  stream.write = (buf) => stream.written.push(Buffer.from(buf));
  stream.end = () => { stream.ended = true; setImmediate(() => stream.emit('end')); };
  return stream;
}

function session(recStream, config = {}) {
  return new GoogleASRSession(recStream, { lang: 'en-US', ...config }, log);
}

const interim = (transcript, confidence = 0.5) => ({
  speechEventType: 'SPEECH_EVENT_UNSPECIFIED',
  results: [{ isFinal: false, stability: 0.1, alternatives: [{ transcript, confidence, words: [] }] }],
});
const final = (transcript, confidence = 0.9) => ({
  speechEventType: 'SPEECH_EVENT_UNSPECIFIED',
  results: [{ isFinal: true, stability: 1, alternatives: [{ transcript, confidence, words: [] }] }],
});
const END_OF_UTTERANCE = { speechEventType: 'END_OF_SINGLE_UTTERANCE', results: [] };

// --- FastEOS (utils/FastEOS.ts:1-19) ----------------------------------------

test('FastEOS: null for empty/invalid, word-boundary case-insensitive regex otherwise', () => {
  assert.equal(FastEOS.buildRegex([]), null);
  assert.equal(FastEOS.buildRegex(['   ', '']), null);
  assert.equal(FastEOS.buildRegex(null), null);
  assert.equal(FastEOS.buildRegex('stop'), null, 'a bare string is not a phrase array');

  const re = FastEOS.buildRegex(['yes', ' no ', '']);
  assert.ok(re instanceof RegExp);
  assert.equal(re.flags, 'i');
  assert.ok(re.test('YES'));
  assert.ok(re.test('say no now'));
  assert.ok(!re.test('nope'), 'word boundaries: "no" must not match inside "nope"');
});

// --- createGoogleRequest (GoogleASRProvider.ts:67-79) ------------------------

test('createGoogleRequest: exact original config fields, defaults and hint contexts', () => {
  assert.deepEqual(createGoogleRequest({ lang: 'en-CA' }), {
    config: {
      encoding: 'LINEAR16',
      languageCode: 'en-CA',
      sampleRateHertz: 16000,
      speechContexts: [],
    },
    singleUtterance: true,
    interimResults: true,
  });

  const withHints = createGoogleRequest({ lang: 'en-US', encoding: 'OGG_OPUS', hints: ['yes', 'jibo'] });
  assert.equal(withHints.config.encoding, 'OGG_OPUS');
  assert.deepEqual(withHints.config.speechContexts, [{ phrases: ['yes', 'jibo'] }]);
});

// --- GoogleASRSession (GoogleASRSession.ts) ---------------------------------

test('Google: SOS on first interim, getLastIncremental tracks it, final resolves + onResult', async () => {
  const stream = fakeRecognizer();
  const s = session(stream, { earlyEOS: [] });
  let sos = 0; let eos = 0; const results = [];
  s.onStartOfSpeech(() => { sos += 1; });
  s.onEndOfSpeech(() => { eos += 1; });
  s.onResult((r) => results.push(r));

  const startPr = s.start();
  assert.deepEqual(s.getLastIncremental(), { text: '', confidence: 0 }, 'empty result before audio');

  s.provideAudio(Buffer.from([1, 2, 3, 4]));
  stream.emit('data', interim('what time'));
  assert.equal(sos, 1, 'SOS fires on the first incremental transcript');
  assert.equal(eos, 0, 'no EOS without an utterance-end event');
  assert.deepEqual(s.getLastIncremental(), { text: 'what time', confidence: 0.5 });

  stream.emit('data', interim('what time is', 0.7));
  assert.deepEqual(s.getLastIncremental(), { text: 'what time is', confidence: 0.7 }, 'higher-confidence interim replaces');
  assert.equal(sos, 1, 'SOS fires once');

  stream.emit('data', final('what time is it', 0.95));
  const result = await startPr;
  assert.deepEqual(result, { text: 'what time is it', confidence: 0.95 });
  assert.equal(sos, 1);
  assert.equal(stream.written.length, 1, 'provideAudio wrote the audio buffer to the recognizer');
  assert.equal(stream.ended, true, 'start() settles and closes the recognizer');
  assert.deepEqual(results, [{ text: 'what time is it', confidence: 0.95 }], 'onResult receives the final result');
});

test('Google: lower-confidence interim does NOT overwrite getLastIncremental', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  const startPr = s.start();
  stream.emit('data', interim('hello there', 0.8));
  stream.emit('data', interim('hell', 0.2));
  assert.deepEqual(s.getLastIncremental(), { text: 'hello there', confidence: 0.8 });
  stream.emit('data', END_OF_UTTERANCE);
  s.stop();
  await startPr;
});

test('Google: earlyEOS incremental resolves immediately with FAST_EOS annotation + EOS', async () => {
  const stream = fakeRecognizer();
  const s = session(stream, { earlyEOS: ['stop'] });
  let eos = 0; const results = [];
  s.onEndOfSpeech(() => { eos += 1; });
  s.onResult((r) => results.push(r));

  const startPr = s.start();
  stream.emit('data', interim('no please stop now', 0.6));
  const result = await startPr;
  assert.equal(result.annotation, 'FAST_EOS');
  assert.equal(result.text, 'no please stop now');
  assert.equal(eos, 1, 'EOS is emitted before resolving');
  assert.deepEqual(results, [{ text: 'no please stop now', confidence: 0.6, annotation: 'FAST_EOS' }]);
});

test('Google: over-13-word non-question incremental resolves as GARBAGE', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  let eos = 0;
  s.onEndOfSpeech(() => { eos += 1; });
  const startPr = s.start();
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
  stream.emit('data', interim(words, 0.4));
  const result = await startPr;
  assert.equal(result.annotation, 'GARBAGE');
  assert.equal(eos, 1);
});

test('Google: a long question is NOT garbage (isQuestionRegex exemption)', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  const startPr = s.start();
  stream.emit('data', interim('what are alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron', 0.4));
  stream.emit('data', final('what are alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron', 0.9));
  const result = await startPr;
  assert.equal(result.annotation, undefined);
  assert.ok(result.text.startsWith('what are'));
});

test('Google: END_OF_SINGLE_UTTERANCE emits SOS+EOS then resolves with the last interim after the final-result timeout', { timeout: 10000 }, async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  let sos = 0; let eos = 0;
  s.onStartOfSpeech(() => { sos += 1; });
  s.onEndOfSpeech(() => { eos += 1; });
  const startPr = s.start();
  stream.emit('data', interim('set a timer', 0.6));   // SOS + last incremental
  const t0 = Date.now();
  stream.emit('data', END_OF_UTTERANCE);              // EOS, then 3 s wait
  assert.equal(sos, 1);
  assert.equal(eos, 1);

  const result = await startPr;
  const waited = Date.now() - t0;
  assert.deepEqual(result, { text: 'set a timer', confidence: 0.6 }, 'timeout returns last good incremental');
  assert.ok(waited >= 2900 && waited < 5000, `final-result timeout is ~3 s (waited ${waited}ms)`);
});

test('Google: data.error rejects start() with the upstream error envelope', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  const startPr = s.start();
  const envelope = { code: 14, message: 'unavailable', details: ['upstream UNAVAILABLE'] };
  stream.emit('data', { error: envelope });
  await assert.rejects(startPr, (err) => {
    assert.deepEqual(err, envelope);
    return true;
  });
  assert.equal(stream.ended, true, 'the recognizer stream is closed on failure');
});

test('Google: a recognizer stream transport error rejects start()', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  const startPr = s.start();
  stream.emit('error', new Error('speech backend unreachable'));
  await assert.rejects(startPr, /speech backend unreachable/);
});

test('Google: stop() before any result resolves undefined and closes the stream', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  const startPr = s.start();
  s.stop();
  assert.equal(stream.ended, true);
  assert.equal(await startPr, undefined);
});

test('Google: an empty results frame is tolerated (no SOS, no crash)', async () => {
  const stream = fakeRecognizer();
  const s = session(stream);
  let sos = 0;
  s.onStartOfSpeech(() => { sos += 1; });
  const startPr = s.start();
  stream.emit('data', { speechEventType: 'SPEECH_EVENT_UNSPECIFIED', results: [] });
  assert.equal(sos, 0);
  s.stop();
  await startPr;
});

// --- provider + factory seam ------------------------------------------------

test('GoogleASRProvider.startSession without a recognizer seam throws loudly (dead-era creds)', () => {
  const saved = { a: process.env.ETCO_server_gspeechMockAddress, p: process.env.ETCO_server_gspeechMockPort };
  delete process.env.ETCO_server_gspeechMockAddress;
  delete process.env.ETCO_server_gspeechMockPort;
  try {
    assert.throws(() => GoogleASRProvider.startSession({ lang: 'en-US' }, log), /dead-era credentials/);
  } finally {
    if (saved.a !== undefined) process.env.ETCO_server_gspeechMockAddress = saved.a;
    if (saved.p !== undefined) process.env.ETCO_server_gspeechMockPort = saved.p;
  }
});

test('factory: ETCO_server_asrProvider=google selects the Google provider through the seam', () => {
  const savedEnv = process.env.ETCO_server_asrProvider;
  process.env.ETCO_server_asrProvider = 'google';
  const stream = fakeRecognizer();
  setRecognizerFactory(() => stream);
  try {
    const s = factoryStartSession({ lang: 'en-US', hints: ['jibo'] }, log);
    assert.ok(s instanceof GoogleASRSession);
  } finally {
    setRecognizerFactory(null);
    setASRProvider(null);
    if (savedEnv === undefined) delete process.env.ETCO_server_asrProvider;
    else process.env.ETCO_server_asrProvider = savedEnv;
  }
});

test('factory: setASRProvider still overrides the default (reference ASRFactory.setASRProvider)', () => {
  const sentinel = { onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {}, getLastIncremental() { return null; }, start() { return Promise.resolve(); } };
  setASRProvider(() => sentinel);
  try {
    assert.equal(factoryStartSession({ lang: 'en-US' }, log), sentinel);
  } finally {
    setASRProvider(null);
  }
});

test('startSession (provider index) builds a session over an injected recognizer factory', async () => {
  const stream = fakeRecognizer();
  setRecognizerFactory(() => stream);
  const s = startSession({ lang: 'en-US' }, log);
  assert.ok(s instanceof GoogleASRSession);
  const startPr = s.start();
  stream.emit('data', final('hello', 0.9));
  assert.equal((await startPr).text, 'hello');
  setRecognizerFactory(null);
});
