import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import * as listen from '../src/listenTransaction.js';
import { recentVoiceTurns } from '@phoenix/common';
import { Timeouts } from '@phoenix/contracts';

const tick = () => new Promise(resolve => setImmediate(resolve));
// Fallback lets this regression run against the exact pre-fix source.
const idleMs = () => listen.IDLE_SPARE_TIMEOUT_MS ?? 10_000;
const context = () => ({ type: 'CONTEXT', data: {
  general: { accountID: 'synthetic-account', robotID: 'synthetic-robot', lang: 'en', release: '1.9.0' },
  runtime: {}, skill: {},
} });

function transaction(t, overrides = {}) {
  const frames = [], closes = [], records = [], saved = [];
  const socket = new EventEmitter();
  socket._jiboHeaders = { 'x-jibo-transid': 'synthetic-spare' };
  socket._auth = { id: 'synthetic-account', friendlyId: 'synthetic-robot' };
  socket.close = (...args) => { closes.push(args); socket.emit('close', args[0]); };
  const log = Object.fromEntries(['info', 'error', 'warn', 'debug'].map(level => [level, (message, fields) => records.push({ level, message, fields })]));
  const tx = new listen.ListenTransaction(socket, {
    config: { recordSpeechHistory: true, recordLaunchHistory: false },
    historyClient: { saveSpeechRecord: async data => saved.push(data) },
    intentRouter: { getSkillIDFromNLU: () => null },
    parser: { handleNLU: async () => ({ intent: null, rules: [], entities: {} }) },
    ...overrides,
  }, { write: frame => frames.push(frame) }, log);
  const errors = [];
  tx.done.catch(error => errors.push(error));
  socket.on('close', code => tx.abandon({ code, closedBy: 'server' }));
  t.after(() => tx.abandon());
  return { tx, socket, frames, closes, records, saved, errors };
}

const stored = tx => recentVoiceTurns({ turnId: tx.trace.turnId }).turns[0];

test('started client turns retain the original terminal timeout, never idle-spare settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { tx, closes, errors } = transaction(t);
  tx.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_NLU', lang: 'en-US' } } });
  t.mock.timers.tick(Timeouts.transaction);
  await tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Maximum transaction time/);
  assert.deepEqual(closes, []);
  assert.notEqual(stored(tx).outcome, 'idle_spare');
});

test('the admission grace override extends the real timer; invalid or shorter values cannot shorten it', () => {
  const module = new URL('../src/listenTransaction.js', import.meta.url).href;
  for (const [value, expected] of [['15000', 15000], ['1', 10000], ['NaN', 10000], ['60000', 10000], ['10000.5', 10000]]) {
    const code = `import { mock } from 'node:test'; import * as m from ${JSON.stringify(module)};
      mock.timers.enable({ apis: ['setTimeout'] });
      const closes = []; const log = {info(){},warn(){}};
      const tx = new m.ListenTransaction({close(...args){closes.push(args)}}, {config:{}}, {write(){}}, log);
      tx.done.catch(()=>{}); mock.timers.tick(${expected - 1});
      const before = closes.length; mock.timers.tick(1);
      console.log(JSON.stringify({before,closes})); tx.abandon(); mock.timers.reset();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PHOENIX_HUB_IDLE_SPARE_MS: value },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { before: 0, closes: [[1000, 'idle-spare']] }, value);
  }
});


test('an untouched socket expires cleanly as an idle spare, not a terminal failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { tx, closes, frames, records, saved, errors } = transaction(t);
  t.mock.timers.tick(idleMs() - 1);
  assert.equal(tx.settled, false, 'the complete admission grace is available');
  t.mock.timers.tick(1);
  await tick();
  assert.deepEqual(closes, [[1000, 'idle-spare']]);
  await tx.done;
  assert.equal(tx.settled, true);
  assert.equal(tx.abandoned, false);
  assert.equal(stored(tx).outcome, 'idle_spare');
  assert.equal(stored(tx).totalMs, idleMs());
  assert.deepEqual(stored(tx).stages, [], 'no response was prepared for a nonexistent turn');
  assert.equal(stored(tx).socketClose, undefined);
  assert.deepEqual(frames, []);
  assert.deepEqual(saved, [], 'never create a speech-history record for an unused socket');
  assert.equal(records.filter(r => r.message === 'voice_turn_idle_spare').length, 1);
  assert.equal(records.filter(r => r.message === 'voice_turn_socket_close').length, 0);
  t.mock.timers.tick(Timeouts.transaction);
  await tick();
  assert.deepEqual(errors, []);
  assert.equal(closes.length, 1);
});


for (const mode of [undefined, 'CLIENT_ASR', 'CLIENT_NLU']) {
  test(`a slow ${mode || 'audio'} LISTEN admitted just before expiry keeps its real turn budget`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { tx, closes } = transaction(t, { asrProvider: () => ({
      onStartOfSpeech() {}, onEndOfSpeech() {}, start: () => new Promise(() => {}), abort() {},
    }) });
    t.mock.timers.tick(idleMs() - 1);
    tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US', mode } } });
    t.mock.timers.tick(1);
    await tick();
    t.mock.timers.tick(15_000);
    await tick();
    assert.deepEqual(closes, []);
    assert.equal(tx.settled, false);
    assert.equal(stored(tx).outcome, null);
  });
}

for (const input of ['context', 'audio']) {
  test(`${input} before a delayed LISTEN is not an idle spare`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const delivered = [];
    let finish;
    const { tx, closes, frames } = transaction(t, { asrProvider: () => ({
      onStartOfSpeech() {}, onEndOfSpeech() {},
      start: () => new Promise(resolve => { finish = resolve; }),
      provideAudio: data => delivered.push(data), stop() {}, abort() {},
    }) });
    t.mock.timers.tick(idleMs() - 1);
    const audio = Buffer.from([1, 0, 2, 0]);
    tx.handleMessage(input === 'context' ? { json: context() } : { audio });
    t.mock.timers.tick(15_000);
    await tick();
    assert.deepEqual(closes, []);
    assert.equal(tx.settled, false);
    tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US', rules: [] } } });
    tx.handleMessage({ json: context() });
    if (input === 'audio') assert.deepEqual(Buffer.concat(delivered), audio);
    finish({ text: 'synthetic command', confidence: 1 });
    await tx.done;
    assert.equal(frames.at(-1).type, 'LISTEN');
    assert.equal(stored(tx).outcome, 'listen');
    assert.deepEqual(closes, []);
  });
}

for (const type of ['CLIENT_ASR', 'CLIENT_NLU']) {
  test(`implicit ${type} global turn disables spare expiry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { tx, closes, frames } = transaction(t);
    t.mock.timers.tick(idleMs() - 1);
    tx.handleMessage({ json: { type, data: type === 'CLIENT_ASR'
      ? { text: 'synthetic command' } : { intent: null, rules: [], entities: {} } } });
    await tx.done;
    t.mock.timers.tick(idleMs());
    await tick();
    assert.equal(stored(tx).outcome, 'listen');
    assert.equal(frames.at(-1).type, 'LISTEN');
    assert.deepEqual(closes, []);
  });
}

test('expiring a concurrent spare cannot cancel its real sibling, even with the same trace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const spare = transaction(t);
  const real = transaction(t);
  real.tx.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_NLU', lang: 'en-US' } } });
  real.tx.handleMessage({ json: context() });
  t.mock.timers.tick(idleMs());
  await tick();
  assert.deepEqual(spare.closes, [[1000, 'idle-spare']]);
  assert.equal(real.tx.settled, false);
  assert.deepEqual(real.closes, []);
  real.tx.handleMessage({ json: { type: 'CLIENT_NLU', data: { intent: null, rules: [], entities: {} } } });
  await real.tx.done;
  assert.equal(stored(real.tx).outcome, 'listen');
  assert.equal(stored(spare.tx).outcome, 'idle_spare');
  assert.notEqual(real.tx.trace.turnId, spare.tx.trace.turnId);
});

test('reconnection receives its own full grace and cannot be closed by the previous timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const old = transaction(t);
  t.mock.timers.tick(idleMs() - 1);
  old.tx.abandon({ code: 1006, closedBy: 'unknown' });
  const next = transaction(t);
  t.mock.timers.tick(idleMs() - 1);
  await tick();
  assert.deepEqual(next.closes, []);
  assert.deepEqual(old.closes, []);
  assert.equal(stored(old.tx).outcome, 'abandoned');
  t.mock.timers.tick(1);
  await tick();
  assert.deepEqual(next.closes, [[1000, 'idle-spare']]);
  assert.equal(stored(next.tx).outcome, 'idle_spare');
});

test('empty audio and deprecated frames cannot renew an unused socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { tx, closes, frames } = transaction(t);
  t.mock.timers.tick(idleMs() - 1);
  tx.handleMessage({ audio: Buffer.alloc(0) });
  tx.handleMessage({ json: { type: 'SPEAKER_ID', data: {} } });
  t.mock.timers.tick(1);
  await tick();
  assert.deepEqual(closes, [[1000, 'idle-spare']]);
  tx.handleMessage({ json: { type: 'CLIENT_NLU', data: { intent: null, rules: [], entities: {} } } });
  await tick();
  assert.deepEqual(frames, [], 'a frame after expiry cannot resurrect the old socket');
  assert.equal(stored(tx).outcome, 'idle_spare');
});

for (const end of ['resolve', 'reject', 'abandon']) {
  test(`${end} clears the idle timer without a second completion or close`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { tx, closes, records } = transaction(t);
    if (end === 'reject') tx.reject(new Error('synthetic protocol failure'), { saveHistory: false });
    else tx[end]();
    await tx.done.catch(() => {});
    t.mock.timers.tick(Timeouts.transaction);
    await tick();
    assert.deepEqual(closes, []);
    assert.equal(records.filter(r => r.message === 'voice_turn_idle_spare').length, 0);
  });
}
