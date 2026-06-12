// example-skill (graph-traversal exerciser) + template-skill (skeleton): ports of the
// reference behavior-suite skills.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import { exampleSkill, templateSkill } from '../src/index.js';

const req = (skillId, type, { intent, memo, session } = {}) => ({
  type, msgID: 'm', ts: 1,
  data: {
    general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
    runtime: { dialog: {}, perception: {}, loop: { users: [] } },
    skill: session ? { id: skillId, session } : { id: skillId },
    result: { nlu: intent ? { intent, entities: {}, rules: [] } : null, memo },
  },
});

const esml = (r) => {
  const jcp = r.data.action.config.jcp;
  const slim = jcp.type === 'SLIM' ? jcp : jcp.children.find((c) => c.type === 'SLIM');
  return slim.config.play.esml;
};

test('example-skill: intent walk Node1 -> Node2 -> Node3 -> Done across LISTEN_UPDATEs', async () => {
  const r1 = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'doesJiboLikeThing' }));
  assert.equal(esml(r1), "SLIM: 'Node1'");
  assert.equal(r1.data.final, false);

  const r2 = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_UPDATE, { intent: 'x', session: r1.data.skill.session }));
  assert.equal(esml(r2), "SLIM: 'Node2'", 'Node1 transitions A -> Node2');

  const r3 = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_UPDATE, { intent: 'x', session: r2.data.skill.session }));
  assert.equal(esml(r3), "SLIM: 'Node3'", 'Node2 transitions B -> Node3');

  const r4 = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_UPDATE, { intent: 'x', session: r3.data.skill.session }));
  assert.equal(r4.data.action, null, 'Node3 A -> Done (terminal)');
  assert.equal(r4.data.final, true);
});

test('example-skill: memo beats intent; proactive memo takes the proactive arm', async () => {
  const r = await exampleSkill(req('example-skill', SkillRequestType.PROACTIVE_LAUNCH, { memo: 'Proactive entry 1' }));
  assert.equal(esml(r), "SLIM: 'ProactiveNode' MEMO: 'Proactive entry 1'");

  const r2 = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'jiboDislikesThing', memo: 'referenceLiveLongProsper' }));
  assert.equal(esml(r2), "SLIM: 'Node1' MEMO: 'referenceLiveLongProsper'", 'memo decided the arm (still Node1 here)');
});

test('example-skill: intent2 goes straight to Node2; unknown intent throws', async () => {
  const r = await exampleSkill(req('example-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'intent2' }));
  assert.equal(esml(r), "SLIM: 'Node2'");
  await assert.rejects(
    () => exampleSkill(req('example-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'nope' })),
    /Unknown intent/,
  );
});

test('template-skill: valid memo plays the template MIM and finishes', async () => {
  const r = await templateSkill(req('template-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'whatever', memo: { entry: 'SomeThing' } }));
  assert.equal(esml(r), 'This is a template skill');
  assert.equal(r.data.action.config.jcp.config.play.meta.mim_id, 'template-mim', 'mim_id from filename');
});

test('template-skill: unknown memo throws', async () => {
  await assert.rejects(
    () => templateSkill(req('template-skill', SkillRequestType.LISTEN_LAUNCH, { intent: 'x', memo: { entry: 'Other' } })),
    /unknown memo/,
  );
});
