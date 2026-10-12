import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction } from '../src/listenTransaction.js';
const log = { info() {}, warn() {}, error() {}, debug() {} };
const emptyNlu = () => ({ intent: null, rules: ['launch'], entities: {} });

function setup(t) {
  const frames = [];
  const calls = [];
  const tx = new ListenTransaction({}, {
    config: {}, parser: { handleNLU: async () => emptyNlu() },
    intentRouter: { getSkillIDFromNLU: () => null },
    skillConfigManager: { isOnRobotSkill: () => false },
    skillClient: { launchOrUpdate: async (...args) => {
      calls.push(args); return { response: { type: 'SKILL_ACTION', data: { actions: [] } } };
    } },
  }, { write: frame => { frames.push(frame); return true; } }, log);
  tx.done.catch(() => {}); t.after(() => tx.abandon());
  return { tx, frames, calls };
}

for (const input of ['CLIENT_ASR', 'CLIENT_NLU']) {
  test(`unmatched global ${input} preserves the native no-match result for either robot mode`, async t => {
    const { tx, frames, calls } = setup(t);
    tx.handleMessage({ json: { type: input, data: input === 'CLIENT_ASR' ? { text: 'synthetic unmatched request' } : emptyNlu() } });
    await tx.done;
    const final = frames.filter(f => f.final);
    assert.equal(final.length, 1); assert.equal(final[0].type, 'LISTEN');
    assert.equal(final[0].data.match, null);
    assert.deepEqual(final[0].data.nlu, emptyNlu());
    assert.equal(calls.length, 0, 'do not invent a cloud skill or an Agent handoff');
  });
}

test('unmatched non-hotphrase follow-up still updates the active skill instead of inventing a fallback', async t => {
  const { tx, frames, calls } = setup(t);
  tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false } } });
  tx.handleMessage({ json: { type: 'CONTEXT', data: { general: { lang: 'en', release: '1.9.0' }, runtime: {}, skill: { id: 'synthetic-active-skill' } } } });
  tx.handleMessage({ json: { type: 'CLIENT_NLU', data: emptyNlu() } });
  await tx.done;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'synthetic-active-skill');
  assert.equal(calls[0][3], true, 'the request is a skill update, not a launch');
  assert.equal(frames.filter(f => f.final).at(-1).type, 'SKILL_ACTION');
});
