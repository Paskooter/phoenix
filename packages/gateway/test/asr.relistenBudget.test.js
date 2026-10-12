import test from 'node:test';
import assert from 'node:assert/strict';
import * as asr from '../src/asr/parakeetSession.js';
const log = { info() {}, debug() {}, warn() {}, error() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function pcm(amplitude, ms) {
  const out = Buffer.alloc(ms * 32);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE((i % 4 ? 1 : -1) * amplitude, i);
  return out;
}
const limits = () => asr.ASR_ENDPOINT_LIMITS || {};
const waitMs = () => limits().relistenWaitMs || 2500;
function setup(t, answers = ['']) {
  const requests = [];
  const pending = [...answers];
  const s = new asr.ParakeetASRSession(null, {}, log, { transport: {
    probeStreaming: async () => false,
    recognizeWav: async wav => { requests.push(wav.subarray(44)); return { text: pending.length > 1 ? pending.shift() : pending[0], confidence: 0 }; },
  } });
  const result = s.start();
  t.after(() => s.abort());
  return { s, result, requests };
}
const candidate = () => Buffer.concat([pcm(8000, 300), pcm(0, asr.ASR_SILENCE_TO_EOS_MS)]);

test('empty endpoints allow only one relisten instead of three', async t => {
  const { s, result, requests } = setup(t);
  s.provideAudio(candidate()); await tick();
  assert.equal(s.state, 'WAITING');
  s.provideAudio(candidate()); await tick();
  assert.equal(s.state, 'DONE');
  assert.equal((await result).text, '');
  assert.equal(s.relistenCount, 1);
  assert.equal(requests.length, 2);
});

test('an empty endpoint with no further audio ends within the relisten wait budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, result } = setup(t);
  s.provideAudio(candidate()); await tick();
  t.mock.timers.tick(waitMs()); await tick();
  assert.equal(s.state, 'DONE');
  assert.equal((await result).annotation, 'SOS_TIMEOUT');
  assert.equal(s.relistenTimer, null);
});

test('near-empty bursts cannot renew the false-wake relisten wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, result, requests } = setup(t);
  s.provideAudio(candidate()); await tick();
  t.mock.timers.tick(waitMs() - 100);
  s.provideAudio(pcm(8000, 40));
  t.mock.timers.tick(100); await tick();
  assert.equal(s.state, 'DONE');
  assert.equal((await result).text, '');
  assert.equal(requests.length, 1, 'do not recognize near-empty audio again at the wait deadline');
});

test('a real long request after an empty wake endpoint keeps its full speech window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, result, requests } = setup(t, ['', 'complete request']);
  s.provideAudio(candidate()); await tick();
  s.provideAudio(pcm(8000, 300));
  t.mock.timers.tick(waitMs());
  assert.equal(s.state, 'SPEAKING');
  s.provideAudio(Buffer.concat([pcm(5000, 5000), pcm(0, asr.ASR_SILENCE_TO_EOS_MS)]));
  assert.equal((await result).text, 'complete request');
  assert.equal(requests[1].length, (5300 + asr.ASR_SILENCE_TO_EOS_MS) * 32);
});
