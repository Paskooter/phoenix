import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChitchatSkill } from '../src/chitchatSkill.js';

// Source control: Pegasus 5c0a7390539663ba749d360de348a428c088505c,
// packages/chitchat-skill/src/nodes/ProcessQueryNode.ts.  The source calls
// addPromptData only for a valid MIM; the fallback branch therefore does not
// construct Dice/Coin before Slimmer samples CC_Fallback.  This is the frozen
// production residual case chitchat:2250:0:base (index 4434), whose request
// and seed are retained in the root compiled-corpus review.
const TARGET_SEED = 2593396555;
function lcg(seed) {
  let state = seed >>> 0;
  let calls = 0;
  const rng = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    calls++;
    return state / 0x100000000;
  };
  Object.defineProperty(rng, 'calls', { get: () => calls });
  return rng;
}

const runtime = {
  location: { iso: '2018-05-30T12:00:00+00:00' },
  perception: { speaker: 'test-looper-id-3' },
  loop: { users: [], jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'WHITE' } },
  character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 } },
  dialog: { referent: null },
};

function request() {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'chitchat:2250:0:base',
    ts: Date.parse('2018-05-30T12:00:00Z'),
    data: {
      general: { accountID: 'fixture-account', robotID: 'fixture-robot' },
      runtime,
      skill: { id: 'chitchat-skill' },
      result: {
        nlu: {
          intent: 'isJiboDescriptor',
          entities: { Occupation: 'Jedi', union_original_fst_name: 'handle:chitchat/launch' },
          rules: ['launch'],
        },
        asr: { text: 'are you a jedi', confidence: 1 },
        memo: { mim: 'RI_JBO_IsAJedi', type: 'SpecificEmotionQuery' },
      },
    },
  };
}

function playOf(response) {
  const jcp = response.data.action.config.jcp;
  const slim = jcp.type === 'SLIM' ? jcp : jcp.children.find((child) => child.type === 'SLIM');
  return slim.config.play;
}

test('fallback prompt keeps the source random stream after an invalid memo', async () => {
  const rng = lcg(TARGET_SEED);
  const skill = createChitchatSkill({ rng });
  const play = playOf(await skill(request()));

  assert.equal(rng.calls, 1, 'source fallback constructs no Dice/Coin before sampling');
  assert.equal(play.meta.mim_id, 'CC_Fallback');
  assert.equal(play.meta.prompt_id, 'CC_GQA_Failure_scripted_AN_06');
  assert.equal(play.autoRuleConfig, true);
  assert.equal(play.esml, 'Honestly I <phoneme ph="th iy ng k ai">thinki</phoneme>don\'t know enough to answer that.');
});
