import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction } from '../src/listenTransaction.js';
import { recentVoiceTurns } from '@phoenix/common';
const tick = () => new Promise(resolve => setImmediate(resolve));
function transaction(t, asrProvider) {
  const records = [];
  const log = Object.fromEntries(['info', 'error', 'warn', 'debug'].map(level => [level, (message, fields) => records.push({ level, message, fields })]));
  const tx = new ListenTransaction({ _jiboHeaders: { 'x-jibo-transid': 'synthetic-turn' } },
    { config: {}, asrProvider }, { write() {} }, log);
  tx.done.catch(() => {});
  t.after(() => tx.abandon());
  return { tx, records };
}
function failingSession(provider, error, failover) {
  return { onStartOfSpeech() {}, onEndOfSpeech() {}, start: () => Promise.reject(error), abort() {}, stop() {},
    describe: () => ({ provider, ...(failover ? { failover } : {}), url: 'private-url', transcript: 'private-words' }) };
}
for (const [provider, error, expectedCode, failover] of [
  ['parakeet', Object.assign(new Error('private-words private-url'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED', null],
  ['google', Object.assign(new Error('private-words private-url'), { code: 'GOOGLE_STT_ERROR', grpcCode: 14 }), 'GOOGLE_STT_ERROR', 'parakeet-batch-failed'],
  ['parakeet', Object.assign(new Error('private-words'), { code: 'secret-token=private-words' }), 'ASR_UNKNOWN', null],
]) {
  test(`terminal ${provider} ASR failure records safe provider and ${expectedCode}`, async t => {
    const { tx, records } = transaction(t, () => failingSession(provider, error, failover));
    tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US' } } });
    const failure = await tx.done.catch(e => e);
    assert.equal(failure.code, 'ASR', 'keep the robot-facing ASR error code');
    assert.equal(failure.asrDiagnostics?.provider, provider);
    assert.equal(failure.asrDiagnostics?.errorCode, expectedCode);
    assert.equal(failure.safeLogMessage, 'ASR failed');
    const stored = recentVoiceTurns({ turnId: tx.trace.turnId }).turns[0];
    assert.deepEqual(stored.failure, failure.asrDiagnostics);
    if (failover) {
      assert.equal(stored.failure.failover, failover);
      assert.equal(stored.failure.grpcCode, 14);
    }
    assert.ok(!JSON.stringify(records).includes('private-words'));
    assert.ok(!JSON.stringify(stored).includes('private-url'));
  });
}

test('client socket abandonment records close class and current ASR stage without raw reason', async t => {
  const pending = new Promise(() => {});
  const { tx, records } = transaction(t, () => ({ onStartOfSpeech() {}, onEndOfSpeech() {}, start: () => pending, abort() {} }));
  tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US' } } });
  await tick();
  tx.abandon({ code: 1001, closedBy: 'peer', reason: 'private-words private-url', transcript: 'private-words' });
  await tx.done;
  const record = records.find(r => r.message === 'voice_turn_socket_close');
  assert.deepEqual(record?.fields, { stage: 'asr', closedBy: 'peer', closeCode: 1001, reason: 'going-away' });
  assert.deepEqual(recentVoiceTurns({ turnId: tx.trace.turnId }).turns[0].socketClose, record.fields);
  assert.ok(!JSON.stringify(records).includes('private-words'));
  tx.abandon({ code: 1000, closedBy: 'server' });
  assert.equal(records.filter(r => r.message === 'voice_turn_socket_close').length, 1);
});

test('socket attribution does not call an abnormal transport close a deliberate peer cancel', async t => {
  const { tx, records } = transaction(t);
  tx.abandon({ code: 1006, closedBy: 'unknown', transportError: true, reason: 'private-words' });
  assert.deepEqual(records.find(r => r.message === 'voice_turn_socket_close')?.fields,
    { stage: 'wait_listen', closedBy: 'unknown', closeCode: 1006, reason: 'transport-error' });
});

test('closing after a terminal response is not logged as a mid-turn abandonment', async t => {
  const { tx, records } = transaction(t);
  tx.resolve();
  tx.abandon({ code: 1000, closedBy: 'peer' });
  assert.equal(records.filter(r => r.message === 'voice_turn_socket_close').length, 0);
});
