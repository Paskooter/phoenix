import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphManager, FnNode, createGraphSkill, colorSkill } from '../src/index.js';
import { validate, schemas, SkillRequestType } from '@phoenix/contracts';

test('GraphManager assigns sequential node IDs', () => {
  const gm = new GraphManager();
  const a = gm.addNode(new FnNode('A'));
  const b = gm.addNode(new FnNode('B'));
  assert.equal(a.id, 0);
  assert.equal(b.id, 1);
  assert.equal(gm.getNode(1).name, 'B');
  assert.throws(() => gm.addNode(a), /already been added/);
});

const launch = (extra = {}) => ({
  type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
  data: { general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: { dialog: {} }, skill: { id: 'color-skill' }, result: { nlu: { intent: 'favoriteColorChat', rules: ['launch'], entities: {} } }, ...extra },
});

test('color-skill multi-turn: launch asks (non-final), update replies (final) using the answer', async () => {
  // turn 1: launch
  const r1 = await colorSkill(launch());
  assert.ok(validate(schemas.skillResponse, r1).valid);
  assert.equal(r1.data.final, false, 'asks the question, stays open');
  assert.equal(r1.data.skill.id, 'color-skill');
  const session = r1.data.skill.session;
  assert.ok(session && session.id);
  assert.equal(session.nodeID, 0, 'parked on the AskColor node');

  // turn 2: update with the session + the spoken answer
  const r2 = await colorSkill({
    type: SkillRequestType.LISTEN_UPDATE, msgID: 'm2', ts: 2,
    data: { general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: { dialog: {} }, skill: { id: 'color-skill', session }, result: { asr: { text: 'blue' }, nlu: { intent: null, rules: [], entities: {} } } },
  });
  assert.equal(r2.data.final, true, 'replies and ends');
  const esml = r2.data.action.config.jcp.children[0].config.play.esml;
  assert.match(esml, /blue/);
});

test('createGraphSkill: a no-action node ends the transaction (final, fireAndForget)', async () => {
  const skill = createGraphSkill({ name: 'noop-skill', build: (gm) => gm.addNode(new FnNode('Noop')) });
  const r = await skill(launch({ skill: { id: 'noop-skill' } }));
  assert.equal(r.data.final, true);
  assert.equal(r.data.fireAndForget, true);
  assert.equal(r.data.action, null);
});
