// SkillConversation behavior tests — frozen-world (Jetsons loop) conversations against the REAL
// skills service over HTTP, mirroring the reference behavior-suite pattern
// (baseskill/tests/*.test.ts drive skills through SkillConversation the same way).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as skillsService from '@phoenix/skills';
import { SkillConversation, DEFAULT_SPEAKER } from '../src/index.js';

let server;
let baseUrl;
before(async () => {
  server = await skillsService.start(0);
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const slimsOf = (resp) => {
  const jcp = resp.data.action.config.jcp;
  return jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((c) => c.type === 'SLIM');
};
const esmlOf = (resp) => slimsOf(resp).map((s) => s.config.play.esml).join(' ');

test('example-skill: full conversation walk over the wire', async () => {
  const c = new SkillConversation(baseUrl, 'example-skill');
  await c.init();

  await c.launch('doesJiboLikeThing');
  assert.equal(c.response.type, 'SKILL_ACTION');
  assert.match(esmlOf(c.response), /SLIM: 'Node1'/);
  assert.equal(c.response.data.final, false);

  await c.actionResult(); // session tracked automatically, like the reference driver
  assert.match(esmlOf(c.response), /SLIM: 'Node2'/);
  await c.actionResult();
  assert.match(esmlOf(c.response), /SLIM: 'Node3'/);
  await c.actionResult();
  assert.equal(c.response.data.action, null, 'terminal');
  assert.equal(c.response.data.final, true);
});

test('report-skill: Jetsons speaker -> full report degradation MAN; no speaker -> WhoIsThis', async () => {
  // Jane Jetson speaks (adult, born 1984): settings dead -> SettingsFailed + ServiceDowns + outro.
  const withJane = new SkillConversation(baseUrl, 'report-skill');
  await withJane.init();
  await withJane.launch('launchPersonalReport', undefined, { memo: 'Reactive' });
  assert.equal(withJane.response.data.final, true);
  const mims = slimsOf(withJane.response).map((s) => s.config.play.meta.mim_id);
  assert.deepEqual(mims, ['PersonalReportSettingsFailed', 'WeatherServiceDown', 'NewsServiceDown', 'PersonalReportOutroConfigured']);
  assert.ok(esmlOf(withJane.response).length > 50, 'all four MIMs rendered prompts');

  // No speaker: the UserID subgraph asks WhoIsThis first.
  const anon = new SkillConversation(baseUrl, 'report-skill');
  await anon.init();
  await anon.withSpeakerId(false).launch('launchPersonalReport', undefined, { memo: 'Reactive' });
  assert.equal(anon.response.data.final, false);
  assert.equal(slimsOf(anon.response)[0].config.play.meta.mim_id, 'PersonalReportWhoIsThis');

  // ... and a notInLoop answer exits via the MaxNI-style flow into MustBeLooper-free full report
  // (weather/news don't need an ID; prefs default).
  await anon.actionResult(undefined, { nlu: { intent: 'notInLoop', entities: {} }, asr: { text: "that's not me" } });
  assert.equal(anon.response.data.final, true);
  const anonMims = slimsOf(anon.response).map((s) => s.config.play.meta.mim_id);
  assert.ok(anonMims.includes('WeatherServiceDown'), JSON.stringify(anonMims));
});

test('chitchat-skill: memo-driven MIM over the wire; missing memo is an ERROR envelope', async () => {
  const c = new SkillConversation(baseUrl, 'chitchat-skill');
  await c.init();
  await c.launch({ intent: 'requestDance', entities: {} }, undefined, { memo: { mim: 'RA_JBO_SpecificDance', type: 'ScriptedResponse' } });
  assert.equal(c.response.type, 'SKILL_ACTION');
  assert.match(esmlOf(c.response), /<anim cat='dance'/);

  const noMemo = new SkillConversation(baseUrl, 'chitchat-skill');
  await noMemo.init();
  await noMemo.launch('someIntent');
  assert.equal(noMemo.response.type, 'ERROR');
  assert.match(noMemo.errorMessage, /without required memo/);
});

test('template-skill: memo gate over the wire', async () => {
  const c = new SkillConversation(baseUrl, 'template-skill');
  await c.init();
  await c.launch('anything', undefined, { memo: { entry: 'SomeThing' } });
  assert.match(esmlOf(c.response), /This is a template skill/);

  const bad = new SkillConversation(baseUrl, 'template-skill');
  await bad.init();
  await bad.launch('anything', undefined, { memo: { entry: 'Wrong' } });
  assert.equal(bad.response.type, 'ERROR');
});

test('speaker override fixture: explicit speaker id flows into perception', async () => {
  const c = new SkillConversation(baseUrl, 'report-skill');
  await c.init();
  await c.withSpeakerId({ id: DEFAULT_SPEAKER.id, accountId: DEFAULT_SPEAKER.accountId })
    .atISOTime('2017-12-11T08:00:00-05:00')
    .launch('requestWeatherPR', undefined, { memo: 'Reactive Weather' });
  assert.equal(c.response.type, 'SKILL_ACTION');
  assert.equal(slimsOf(c.response)[0].config.play.meta.mim_id, 'WeatherServiceDown');
});
