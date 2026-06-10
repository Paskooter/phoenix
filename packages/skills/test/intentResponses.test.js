import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportSkill } from '../src/reportSkill.js';
import { chitchatSkill } from '../src/chitchatSkill.js';
import { buildSkillAction } from '../src/jcp.js';

// Report-skill intent split (mirrors reference IntentSplitNode): the launch intent
// selects a single subskill; only launchPersonalReport runs the full report.

function reqWithIntent(intent) {
  return { data: { result: { nlu: { intent, entities: {} }, asr: { text: '' } }, runtime: {}, skill: null } };
}
const esmlOf = (action) => action.data.action.config.jcp.children[0].config.play.esml;
const mimOf = (action) => action.data.action.config.jcp.children[0].config.play.meta.mim_id;

test('report: requestNews -> news only, never the personal report', async () => {
  const r = await reportSkill(reqWithIntent('requestNews'));
  const esml = esmlOf(r);
  assert.ok(!/personal report/i.test(esml), `news reply must not be the personal report: ${esml}`);
  assert.equal(mimOf(r), 'NewsReport');
});

test('report: requestWeatherPR -> weather only', async () => {
  const r = await reportSkill(reqWithIntent('requestWeatherPR'));
  const esml = esmlOf(r);
  assert.ok(!/personal report/i.test(esml), `weather reply must not be the personal report: ${esml}`);
  assert.equal(mimOf(r), 'WeatherReport');
});

test('report: launchPersonalReport -> full report', async () => {
  const r = await reportSkill(reqWithIntent('launchPersonalReport'));
  assert.match(esmlOf(r), /personal report/i);
  assert.equal(mimOf(r), 'PersonalReport');
});

test('report: commute + calendar intents get their own subskill replies', async () => {
  assert.equal(mimOf(await reportSkill(reqWithIntent('requestCommute'))), 'CommuteReport');
  assert.equal(mimOf(await reportSkill(reqWithIntent('requestCalendar'))), 'CalendarReport');
});

// Chitchat intent-keyed responses (real reference MIM prompt text incl. ESML).

test('chitchat: requestDance answers by dancing (raw <anim> ESML preserved)', async () => {
  const r = await chitchatSkill(reqWithIntent('requestDance'));
  assert.match(esmlOf(r), /<anim cat='dance'/);
  assert.equal(mimOf(r), 'RA_JBO_SpecificDance');
});

test('chitchat: requestTwerk uses the real RA_JBO_Twerk response', async () => {
  const r = await chitchatSkill(reqWithIntent('requestTwerk'));
  assert.match(esmlOf(r), /twerk/);
  assert.equal(mimOf(r), 'RA_JBO_Twerk');
});

test('chitchat: memo.mim scripted path still works (aprilFools)', async () => {
  const req = reqWithIntent('aprilFools');
  req.data.result.memo = { mim: 'JF_AprilFools' };
  const r = await chitchatSkill(req);
  assert.match(esmlOf(r), /April Fools/);
});

test('chitchat: unmapped intent falls back to CC_Fallback', async () => {
  const r = await chitchatSkill(reqWithIntent('someUnknownIntent'));
  assert.equal(mimOf(r), 'CC_Fallback');
});

// esmlRaw flag: skill-authored markup passes through; default still escapes.

test('jcp: esmlRaw passes markup through, default escapes it', () => {
  const raw = buildSkillAction({ skillId: 's', esmlText: "<anim cat='dance'/>", sessionId: 'x', esmlRaw: true });
  assert.match(esmlOf(raw), /^<anim/);
  const esc = buildSkillAction({ skillId: 's', esmlText: '<script>', sessionId: 'x' });
  assert.ok(!/^<script/.test(esmlOf(esc)));
});
