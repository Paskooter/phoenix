import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphSkill, FnNode, GraphManager } from '../src/index.js';
import { skillRoute } from '../src/skillService.js';

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot' };

function makeSkill(name = 'fixture-skill') {
  return createGraphSkill({
    name,
    build: (gm) => gm.addNode(new FnNode('FixtureNode')),
  });
}

function context(calls = []) {
  return {
    trace: {},
    log: {
      debug() { calls.push('debug'); },
      warn() { calls.push('warn'); },
      error() { calls.push('error'); },
    },
  };
}

async function invoke(skill, body, calls = []) {
  return skillRoute('fixture-skill', skill)({ body, ...context(calls) });
}

function bodyWithData(data, type = 'NOT_A_REQUEST') {
  return { type, data };
}

test('GraphSkill follows source precondition order and error ownership', async () => {
  const skill = makeSkill();

  const missingData = await invoke(skill, {});
  assert.equal(missingData.data.message, "Cannot read property 'general' of undefined");

  const nullData = await invoke(skill, { data: null });
  assert.equal(nullData.data.message, "Cannot read property 'general' of null");

  const missingGeneral = await invoke(skill, bodyWithData({}));
  assert.equal(missingGeneral.data.message, 'Skill request without general.accountID arrived');

  const nullGeneral = await invoke(skill, bodyWithData({ general: null }));
  assert.equal(nullGeneral.data.message, 'Skill request without general.accountID arrived');

  const missingAccount = await invoke(skill, bodyWithData({ general: {} }));
  assert.equal(missingAccount.data.message, 'Skill request without general.accountID arrived');

  const missingRobot = await invoke(skill, bodyWithData({ general: { accountID: 'a' } }));
  assert.equal(missingRobot.data.message, 'Skill request without general.robotID arrived');

  const nullRobot = await invoke(skill, bodyWithData({ general: { accountID: 'a', robotID: null } }));
  assert.equal(nullRobot.data.message, 'Skill request without general.robotID arrived');

  const mismatchedSkill = await invoke(skill, bodyWithData({
    general: GENERAL,
    skill: { id: 'other-skill' },
  }));
  assert.equal(mismatchedSkill.data.message, "Incoming skill name doesn't match. This: 'fixture-skill', incoming: 'other-skill'");
});

test('GraphSkill mutates source-shaped skill fallbacks before dispatch', async () => {
  const skill = makeSkill();
  const fallbackBodies = [
    bodyWithData({ general: GENERAL }),
    bodyWithData({ general: GENERAL, skill: null }),
    bodyWithData({ general: GENERAL, skill: false }),
    bodyWithData({ general: GENERAL, skill: {} }),
    bodyWithData({ general: GENERAL, skill: { id: '' } }),
    bodyWithData({ general: GENERAL, skill: { id: 0 } }),
  ];

  for (const body of fallbackBodies) {
    const result = await invoke(skill, body);
    assert.equal(result.data.message, "Unknown request type 'NOT_A_REQUEST'");
    assert.deepEqual(body.data.skill, { id: 'fixture-skill' });
  }

  const arraySkill = bodyWithData({ general: GENERAL, skill: [] });
  const arrayResult = await invoke(skill, arraySkill);
  assert.equal(arrayResult.data.message, "Unknown request type 'NOT_A_REQUEST'");
  assert.equal(arraySkill.data.skill.id, 'fixture-skill');

  const primitiveSkill = bodyWithData({ general: GENERAL, skill: 'existing' });
  const primitiveResult = await invoke(skill, primitiveSkill);
  assert.match(primitiveResult.data.message, /property.*id.*string/);
});

test('GraphSkill preserves source debug/warning ordering before dispatch errors', async () => {
  const calls = [];
  const skill = makeSkill();
  const result = await skillRoute('fixture-skill', skill)({
    body: bodyWithData({ general: GENERAL, skill: { id: 'fixture-skill' } }),
    trace: {},
    log: {
      debug() { calls.push('debug'); },
      warn() { calls.push('warn'); },
      error() { calls.push('error'); },
    },
  });

  assert.equal(result.data.message, "Unknown request type 'NOT_A_REQUEST'");
  assert.deepEqual(calls.slice(0, 3), ['debug', 'warn', 'error']);
});

test('GraphSkill launch and proactive launch preserve truthy sessions for the source guard', async () => {
  for (const type of ['LISTEN_LAUNCH', 'PROACTIVE_LAUNCH']) {
    const skill = makeSkill();
    const session = { id: 'old-session', nodeID: 99, data: {}, trace: [] };
    const body = {
      type,
      data: {
        general: GENERAL,
        skill: { id: 'fixture-skill', session },
        result: { nlu: { intent: 'fixture', entities: {} } },
      },
    };

    await assert.rejects(() => skill(body), /Skill session should not exist here/);
    assert.deepEqual(body.data.skill.session, session);
  }
});

test('GraphSkill launch and proactive launch replace only falsy sessions through GraphManager.start', async () => {
  for (const type of ['LISTEN_LAUNCH', 'PROACTIVE_LAUNCH']) {
    for (const session of [undefined, null, false, 0, '']) {
      const skill = createGraphSkill({
        name: 'fixture-skill',
        build: (gm) => gm.addNode(new FnNode('LaunchNode', {
          enter: async () => ({ action: { type: 'FIXTURE_ACTION' }, final: false }),
        })),
      });
      const skillData = { id: 'fixture-skill' };
      if (session !== undefined) skillData.session = session;
      const body = {
        type,
        data: {
          general: GENERAL,
          skill: skillData,
          result: { nlu: { intent: 'fixture', entities: {} } },
        },
      };

      const result = await skill(body);
      assert.equal(result.type, 'SKILL_ACTION');
      assert.equal(result.data.skill.session.nodeID, 0);
      assert.notEqual(result.data.skill.session.id, session);
      assert.equal(body.data.skill.session.nodeID, 0);
    }
  }
});

test('GraphManager matches source session and transition preconditions', async () => {
  const gm = new GraphManager();
  const node = new FnNode('FixtureNode', { transitions: ['Done'] });
  node.addTransition('Done');
  gm.addNode(node);

  await assert.rejects(() => gm.enterNode({ skill: {} }), /Skill session is required/);
  await assert.rejects(() => gm.exitNode({ skill: {} }), /Skill session is required/);

  const missingNodeData = { skill: { session: { nodeID: 999, trace: [] } } };
  await assert.rejects(() => gm.enterNode(missingNodeData), /isn't a part of this graph/);
  await assert.rejects(() => gm.exitNode(missingNodeData), /isn't a part of this graph/);

  const transitionData = { skill: { session: { nodeID: node.id, trace: [] } } };
  await assert.rejects(
    () => gm._executeTransition(node, { transition: 'Unknown' }, transitionData),
    /State 'FixtureNode' returned unregistered transition 'Unknown'/,
  );
  await assert.rejects(
    () => gm._executeTransition(node, { transition: 'Done' }, transitionData),
    /Trace should exist/,
  );

  const duplicateTrace = { skill: { session: { nodeID: node.id, trace: [{ nodeID: node.id, transition: 'Done' }] } } };
  await assert.rejects(
    () => gm._executeTransition(node, { transition: 'Done' }, duplicateTrace),
    /Trace transition shouldn't exist/,
  );

  const wrongTrace = { skill: { session: { nodeID: node.id, trace: [{ nodeID: node.id + 1, transition: null }] } } };
  await assert.rejects(
    () => gm._executeTransition(node, { transition: 'Done' }, wrongTrace),
    /Unexpected trace node ID/,
  );
});
