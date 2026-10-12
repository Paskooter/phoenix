import test from 'node:test';
import assert from 'node:assert/strict';
import * as asr from '../src/asr/parakeetSession.js';

const limits = () => asr.ASR_ENDPOINT_LIMITS || { maxUtteranceMs: 12000 };
const log = { info() {}, debug() {}, warn() {}, error() {} };
export function pcm(amplitude, ms) {
  const out = Buffer.alloc(ms * 32);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE((i % 4 ? 1 : -1) * amplitude, i);
  return out;
}
function session(t, text = 'synthetic command') {
  const requests = [];
  const transport = { probeStreaming: async () => false, recognizeWav: async wav => {
    requests.push(wav.subarray(44)); return { text, confidence: text ? 1 : 0 };
  } };
  const s = new asr.ParakeetASRSession(null, {}, log, { transport });
  const result = s.start();
  t.after(() => s.abort());
  return { s, result, requests };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('runaway VAD: sparse audio also ends at the wall-clock command cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, result, requests } = session(t);
  s.provideAudio(pcm(8000, 300));
  t.mock.timers.tick(limits().maxUtteranceMs);
  await tick();
  assert.equal(s.state, 'DONE');
  assert.equal((await result).text, 'synthetic command');
  assert.equal(requests[0].length, 300 * 32);
  assert.equal(s.utteranceTimer, null);
});

test('runaway VAD: an in-flight empty endpoint cannot renew an expired command cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  const transport = { probeStreaming: async () => false,
    recognizeWav: () => new Promise(resolve => { answer = resolve; }) };
  const s = new asr.ParakeetASRSession(null, {}, log, { transport });
  const result = s.start();
  t.after(() => s.abort());
  s.provideAudio(Buffer.concat([pcm(8000, 300), pcm(0, asr.ASR_SILENCE_TO_EOS_MS)]));
  await tick();
  t.mock.timers.tick(limits().maxUtteranceMs);
  answer({ text: '', confidence: 0 });
  await tick();
  assert.equal(s.state, 'DONE');
  assert.equal((await result).text, '');
  assert.equal(s.relistenCount, 0);
});

test('runaway VAD: uninterrupted above-gate noise ends at the command cap', async t => {
  const { s, result, requests } = session(t, '');
  const cap = limits().maxUtteranceMs;
  s.provideAudio(pcm(900, cap + 2000));
  await tick();
  assert.equal(s.state, 'DONE', 'background energy must not wait for the 30-second buffer');
  assert.equal((await result).text, '');
  assert.equal(s.finalizeReason, 'max-utterance');
  assert.ok(requests[0].length <= (cap + 200) * 32);
});

test('VAD preserves a quiet-room short command byte for byte', async t => {
  const { s, result, requests } = session(t);
  const audio = Buffer.concat([pcm(0, 200), pcm(8000, 800), pcm(0, asr.ASR_SILENCE_TO_EOS_MS)]);
  s.provideAudio(audio);
  assert.equal((await result).text, 'synthetic command');
  assert.deepEqual(requests[0], audio);
});

test('runaway VAD: a command over hot steady noise is recognized within the cap', async t => {
  const { s, result, requests } = session(t);
  s.provideAudio(Buffer.concat([pcm(900, 200), pcm(8000, 1000), pcm(900, limits().maxUtteranceMs)]));
  await tick();
  assert.equal(s.state, 'DONE', 'a noise floor never learned by the old gate is still bounded');
  assert.equal((await result).text, 'synthetic command');
  assert.ok(requests[0].includes(pcm(8000, 1000)), 'the whole short command reaches recognition');
});

test('VAD preserves a long sentence with breaths and quiet syllables below the cap', async t => {
  const { s, result, requests } = session(t, 'a long synthetic sentence');
  const sentence = Buffer.concat([pcm(300, 200), pcm(1200, 1200), pcm(500, 1800),
    pcm(300, 600), pcm(900, 2000), pcm(300, 600), pcm(500, 3000)]);
  assert.ok(sentence.length / 32 < limits().maxUtteranceMs);
  s.provideAudio(sentence);
  assert.notEqual(s.state, 'FINALIZING', 'no early clipping of a long sentence or its breaths');
  s.provideAudio(pcm(300, asr.ASR_SILENCE_TO_EOS_MS));
  assert.equal((await result).text, 'a long synthetic sentence');
  assert.deepEqual(requests[0], Buffer.concat([sentence, pcm(300, asr.ASR_SILENCE_TO_EOS_MS)]));
});
