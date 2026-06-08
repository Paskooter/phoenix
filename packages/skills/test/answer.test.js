import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, schemas, SkillRequestType } from '@phoenix/contracts';
import { answerSkill } from '../src/answerSkill.js';
import { escapeForEsml } from '../src/jcp.js';

function listenLaunch(text, entities = {}) {
  return {
    type: SkillRequestType.LISTEN_LAUNCH,
    msgID: 'm',
    ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: { dialog: {} },
      skill: { id: 'answer-skill' },
      result: { asr: { text }, nlu: { intent: 'generalWhoQuestions', rules: ['launch'], entities }, memo: { type: 'who' } },
    },
  };
}

test('answer-skill returns a wire-valid SKILL_ACTION', async () => {
  const resp = await answerSkill(listenLaunch('who is ada lovelace'));
  const { valid, errors } = validate(schemas.skillResponse, resp);
  assert.ok(valid, errors.join('; '));
  assert.equal(resp.type, 'SKILL_ACTION');
  assert.equal(resp.data.final, true);
  assert.equal(resp.data.skill.id, 'answer-skill');
  assert.equal(resp.data.skill.session.nodeID, 1);
});

test('SKILL_ACTION carries a JCP SEQUENCE -> SLIM -> PLAY with esml + mim meta', async () => {
  const resp = await answerSkill(listenLaunch('who is ada lovelace'));
  const jcp = resp.data.action.config.jcp;
  assert.equal(resp.data.action.type, 'JCP');
  assert.equal(jcp.type, 'SEQUENCE');
  const slim = jcp.children[0];
  assert.equal(slim.type, 'SLIM');
  assert.equal(slim.config.play.type, 'PLAY');
  assert.equal(typeof slim.config.play.esml, 'string');
  assert.equal(slim.config.play.meta.mim_id, 'AnswerReply');
});

test('the session round-trips the question (stateless skill contract)', async () => {
  const resp = await answerSkill(listenLaunch('who is ada lovelace'));
  assert.equal(resp.data.skill.session.data._answerSkill.question, 'who is ada lovelace');
});

test('esml escaping escapes entities then strips leftover braces (answer-skill/server.js:188-200)', () => {
  // & -> &amp;, < -> &lt;, > -> &gt;, " -> &quot;, then any remaining <>{} are removed.
  assert.equal(escapeForEsml('a <rule> {x} "q" & b'), 'a &lt;rule&gt; x &quot;q&quot; &amp; b');
});
