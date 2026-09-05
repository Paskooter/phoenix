import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJcpAction, buildJcpFromSlim, buildSkillAction } from '../src/jcp.js';
import { buildPromptData, generateSlimFromMim } from '../src/index.js';
import { parallelProtocol } from '../src/graph/nodes.js';

const jcpId = /^[0-9a-f]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertGeneratedJcpId(node) {
  assert.match(node.id, jcpId, `${node.type} must use the requester 32-hex ID contract`);
}

test('JCP builders keep command IDs distinct from response/session UUIDs', () => {
  const action = buildJcpAction({ esmlText: 'question', listenRule: 'clock/timer_set_value' });
  const sequence = action.config.jcp;
  const slim = sequence.children[0];
  assertGeneratedJcpId(sequence);
  assertGeneratedJcpId(slim);
  assertGeneratedJcpId(slim.config.play);
  assertGeneratedJcpId(slim.config.listen);
  assert.deepEqual(slim.config.listen.contexts, ['clock/timer_set_value']);
  assert.equal(Object.hasOwn(slim.config.listen, 'rule'), false);
  const rules = ['clock/timer_set_value', 'globals/gui_nav'];
  const multiple = buildJcpAction({ esmlText: 'question', listenRule: rules });
  assert.deepEqual(multiple.config.jcp.children[0].config.listen.contexts, rules);

  const wrapped = buildJcpFromSlim({ play: slim.config.play, listen: slim.config.listen });
  assertGeneratedJcpId(wrapped.config.jcp);
  assertGeneratedJcpId(wrapped.config.jcp.children[0]);
  assert.match(JSON.stringify(wrapped), /"contexts":\["clock\/timer_set_value"\]/);
});

test('supplemental Parallel uses the requester default succeedOnFirst field', () => {
  const parallel = parallelProtocol([{ id: 'child', type: 'NOOP' }]);
  assertGeneratedJcpId(parallel);
  assert.deepEqual(parallel.children, [{ id: 'child', type: 'NOOP' }]);
  assert.equal(parallel.succeedOnFirst, false);
});

test('Slimmer preserves null versus omitted auto-rule overrides', () => {
  const base = {
    mim_id: 'auto-rules', mim_type: 'announcement', es_auto_tagging: 'base-rules',
    prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 1, prompt: 'hello', weight: 1 }],
  };
  const render = prompt => generateSlimFromMim({ ...base, prompts: [prompt] }, {
    category: 'Entry-Core', subCategory: 'AN', index: 1,
  }, buildPromptData({}), { rng: () => 0 });

  assert.equal(render({ ...base.prompts[0], auto_rule_override: null }).play.autoRuleConfig, 'base-rules');
  assert.equal(render({ ...base.prompts[0], auto_rule_override: false }).play.autoRuleConfig, false);
  const omitted = render({ ...base.prompts[0] }).play;
  assert.equal(omitted.autoRuleConfig, undefined);
  assert.equal(JSON.parse(JSON.stringify(omitted)).autoRuleConfig, undefined);
});

test('GraphSkill records the framework Skill Entry analytics event on launch', async () => {
  const { createGraphSkill, FnNode } = await import('../src/index.js');
  const skill = createGraphSkill({
    name: 's04-entry',
    build: gm => gm.addNode(new FnNode('Done')),
  });
  const response = await skill({
    type: 'LISTEN_LAUNCH',
    msgID: 'request',
    ts: 1,
    data: {
      general: { accountID: 'account', robotID: 'robot', lang: 'en-US' },
      runtime: { dialog: {} },
      skill: { id: 's04-entry' },
      result: { nlu: { intent: null, rules: [], entities: {} }, asr: { text: '' } },
    },
  });
  assert.deepEqual(response.data.analytics, {
    's04-entry': [{
      event: 'Skill Entry',
      properties: {
        initial_intent: 'n/a', domain: '', was_hey_jibo_launch: true,
        user_initiated: true, last_skill: 'n/a',
      },
    }],
  });
});

test('JCP command IDs do not change the UUID contract of the response envelope', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const response = buildSkillAction({ skillId: 's04', esmlText: 'hello', sessionId });
  assert.match(response.msgID, uuid);
  assert.equal(response.data.skill.session.id, sessionId);
  assertGeneratedJcpId(response.data.action.config.jcp);
});
