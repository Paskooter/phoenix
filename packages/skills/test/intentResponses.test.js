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

// Chitchat memo-driven dispatch over the REAL vendored MIM library (mirrors
// ProcessQueryNode: memo {mim,type} from the matched manifest entry names the MIM,
// the Slimmer renders it).

function reqWithMemo(intent, memo, entities = {}) {
  const req = reqWithIntent(intent);
  req.data.result.memo = memo;
  req.data.result.nlu.entities = entities;
  return req;
}
const det = { rng: () => 0 }; // deterministic prompt pick

test('chitchat: dance memo plays the real RA_JBO_SpecificDance MIM (raw <anim> ESML)', async () => {
  const r = await chitchatSkill(reqWithMemo('requestDance', { mim: 'RA_JBO_SpecificDance', type: 'ScriptedResponse' }), det);
  assert.match(esmlOf(r), /<anim cat='dance'/);
  assert.equal(mimOf(r), 'RA_JBO_SpecificDance');
});

test('chitchat: twerk memo plays the real RA_JBO_Twerk MIM', async () => {
  const r = await chitchatSkill(reqWithMemo('requestTwerk', { mim: 'RA_JBO_Twerk', type: 'ScriptedResponse' }), det);
  assert.match(esmlOf(r), /twerk/i);
  assert.equal(mimOf(r), 'RA_JBO_Twerk');
});

test('chitchat: aprilFools memo plays the real JF_AprilFools MIM', async () => {
  const r = await chitchatSkill(reqWithMemo('aprilFools', { mim: 'JF_AprilFools', type: 'ScriptedResponse' }), det);
  assert.match(esmlOf(r), /April Fools/);
});

test('chitchat: emotion-query memo resolves in emotion-responses', async () => {
  const r = await chitchatSkill(reqWithMemo('emotionQuery', { mim: 'OI_JBO_IsHappy', type: 'EmotionQuery' }), det);
  assert.equal(mimOf(r), 'OI_JBO_IsHappy');
  assert.ok(esmlOf(r).length > 0);
});

test('chitchat: semi-specific stem resolves via entity value + category CSV', async () => {
  // OI_JBO_IsIn_SS_RoomInHouse exists; "Attic" is a RoomInHouse member.
  const r = await chitchatSkill(reqWithMemo('whereIsJibo', { mim: 'OI_JBO_IsIn_SS', type: 'SemiSpecificResponse' }, { Location: 'Attic' }), det);
  assert.equal(mimOf(r), 'OI_JBO_IsIn_SS_RoomInHouse');
});

test('chitchat: unknown/missing memo falls back to the real CC_Fallback MIM', async () => {
  const r1 = await chitchatSkill(reqWithMemo('x', { mim: 'NoSuchMim', type: 'ScriptedResponse' }), det);
  assert.equal(mimOf(r1), 'CC_Fallback');
  const r2 = await chitchatSkill(reqWithIntent('someUnknownIntent'), det);
  assert.equal(mimOf(r2), 'CC_Fallback');
});

// esmlRaw flag: skill-authored markup passes through; default still escapes.

test('jcp: esmlRaw passes markup through, default escapes it', () => {
  const raw = buildSkillAction({ skillId: 's', esmlText: "<anim cat='dance'/>", sessionId: 'x', esmlRaw: true });
  assert.match(esmlOf(raw), /^<anim/);
  const esc = buildSkillAction({ skillId: 's', esmlText: '<script>', sessionId: 'x' });
  assert.ok(!/^<script/.test(esmlOf(esc)));
});
