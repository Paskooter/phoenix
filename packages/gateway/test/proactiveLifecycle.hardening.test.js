// Synthetic identities and held in-process peers; no external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../src/index.js';
import { ProactiveTransaction } from '../src/proactive/proactiveTransaction.js';

const log = { info() {}, debug() {}, error() {}, warn() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const context = () => ({ data: { general: { robotID: 'synthetic-robot' }, runtime: { loop: { loopId: 'synthetic-loop', users: [{ id: 'synthetic-person', accountId: 'synthetic-account' }] }, perception: { speaker: 'synthetic-person' } } } });
function make(extra = {}) {
  const frames = [];
  const tx = new ProactiveTransaction({ _jiboHeaders: {}, _auth: null }, {
    config: { recordLaunchHistory: false }, skills: [],
    skillConfigManager: { isOnRobotSkill: () => false }, ...extra,
  }, { write: frame => frames.push(frame) }, log);
  return { tx, frames };
}

test('real proactive WebSocket close aborts the transaction waiting for CONTEXT', { timeout: 3000 }, async (t) => {
  const original = ProactiveTransaction.prototype._handleTrigger;
  let tx;
  const observed = deferred();
  ProactiveTransaction.prototype._handleTrigger = function (...args) {
    tx = this;
    observed.resolve();
    return original.apply(this, args);
  };
  t.after(() => { ProactiveTransaction.prototype._handleTrigger = original; });
  const gateway = await createGateway({
    disableAuth: true, hubTokenSecret: '', skills: [], parserURL: 'http://127.0.0.1:1',
    historyURL: 'http://127.0.0.1:1', settingsURL: 'http://127.0.0.1:1',
    listenTimeout: 1000, proactiveTimeout: 1000, recordLaunchHistory: false,
  });
  await gateway.service.listen(0);
  t.after(async () => {
    tx?.abandon?.();
    for (const socket of gateway.wss.clients) socket.terminate();
    gateway.wss.close();
    await new Promise(resolve => gateway.service.server.close(resolve));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.service.server.address().port}/proactive`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'TRIGGER', data: { triggerSource: 'SURPRISE' } }));
  await observed.promise;
  const closed = once(ws, 'close');
  ws.terminate();
  await closed;
  await tx.done;
  assert.equal(tx.abortController.signal.aborted, true);
  assert.equal(await tx.contextPr.promise, null, 'close releases the CONTEXT waiter');
});

test('proactive close releases a context waiter and ignores a late trigger', async () => {
  const { tx, frames } = make();
  const pending = tx._handleTrigger({ data: { triggerSource: 'SURPRISE' } });
  tx.abandon();
  await tx.done;
  await pending;
  tx.contextPr.resolve(context());
  await tx._handleTrigger({ data: { triggerSource: 'SURPRISE' } });
  assert.deepEqual(frames, []);
  assert.equal(tx.abortController.signal.aborted, true);
});

for (const end of ['abandon', '_onTransactionTimeout']) {
  test(`proactive ${end} aborts a held cloud skill and suppresses launch history`, async () => {
    const gate = deferred();
    let signal;
    const history = [];
    const { tx, frames } = make({
      config: { recordLaunchHistory: true },
      skillClient: { proactiveLaunch(_id, _input, _trace, options) { signal = options?.signal; return gate.promise; } },
      historyClient: { writeSkillLaunch(...args) { history.push(args); return Promise.resolve(); } },
    });
    tx._getEligible = async () => [{ skillID: 'synthetic-cloud' }];
    const done = tx.done.catch(e => e);
    const work = tx._chooseAction({ data: { triggerSource: 'SURPRISE' } }, context());
    await tick();
    tx[end]();
    assert.equal(signal.aborted, true);
    const result = await done;
    if (end === '_onTransactionTimeout') assert.equal(result.code, 'TIMEOUT_TRANSACTION');
    gate.resolve({ response: { type: 'SKILL_ACTION', data: {} } });
    await work;
    assert.deepEqual(frames.map(f => f.type), ['PROACTIVE']);
    assert.deepEqual(history, []);
  });
}

test('proactive cancellation reaches the consolidated settings read', async () => {
  const gate = deferred();
  let signal;
  const { tx } = make({
    skills: [{ id: 'synthetic-cloud', proactives: [{ topics: [], settingsRules: [{ skill: 'synthetic-cloud', key: 'enabled', value: true, matchRule: 'EXACT' }] }] }],
    settingsClient: { getSettings(_a, _l, _t, _d, _log, options) { signal = options?.signal; return gate.promise; } },
  });
  const work = tx._getEligible(context(), {});
  await tick();
  tx.abandon();
  assert.equal(signal.aborted, true);
  gate.resolve(new Map());
  assert.deepEqual(await work, []);
});

test('proactive cancellation reaches the IH query', async () => {
  const gate = deferred();
  let signal;
  const { tx } = make({
    skills: [{ id: 'synthetic-cloud', IHQueries: { recent: { type: 'Count', queryRules: [] } }, proactives: [{ topics: [], IHRules: [{ query: 'recent', matchRule: 'GREATER_THAN', value: 0 }] }] }],
    historyClient: { getSkillLaunchCount(_q, _trace, options) { signal = options?.signal; return gate.promise; } },
  });
  const work = tx._getEligible(context(), {});
  await tick();
  tx.abandon();
  assert.equal(signal.aborted, true);
  gate.resolve(1);
  assert.deepEqual(await work, []);
});

test('proactive error frame preserves the skill error code', () => {
  const { tx, frames } = make();
  tx._emitSkillResult({ error: { code: 'SKILL_NOT_FOUND', message: 'synthetic missing skill' } });
  tx.resolve();
  assert.deepEqual(frames[0].data, { code: 'SKILL_NOT_FOUND', message: 'synthetic missing skill' });
});
