import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import { reportSkill } from '../src/reportSkill.js';
import { chitchatSkill } from '../src/chitchatSkill.js';
import { buildSkillAction } from '../src/jcp.js';

function reqWithIntent(intent) {
  return { data: { result: { nlu: { intent, entities: {} }, asr: { text: '' } }, runtime: {}, skill: null } };
}
const esmlOf = (action) => action.data.action.config.jcp.children[0].config.play.esml;
const mimOf = (action) => action.data.action.config.jcp.children[0].config.play.meta.mim_id;

// Report-skill — the PersonalReport graph (port of report-skill/src/PersonalReport.ts).
// These run with NO data/settings services configured, so the graph exercises the
// reference degradation paths: ServiceDown mims, SettingsFailed, MustBeLooper, WhoIsThis.

function reportReq(intent, { speaker = null, adult = true, memo = 'Reactive' } = {}) {
  const users = speaker ? [{ id: speaker, name: 'Alice Smith', accountId: 'acct-1', ...(adult ? { birthdate: '1990-01-01' } : {}) }] : [];
  return {
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: {
        dialog: {},
        perception: speaker ? { speaker } : {},
        loop: { loopId: 'loop-1', users },
        location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
      },
      skill: { id: 'report-skill' },
      result: intent
        ? { nlu: { intent, entities: {}, rules: [] }, asr: { text: '' }, memo }
        : { nlu: null, memo },
    },
  };
}
const slimsOf = (r) => {
  const jcp = r.data.action.config.jcp;
  return jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((c) => c.type === 'SLIM');
};
const reportMims = (r) => slimsOf(r).map((s) => s.config.play.meta.mim_id);
const reportEsml = (r) => slimsOf(r).map((s) => s.config.play.esml).join(' ');

test('report: requestNews -> news subskill only; ServiceDown when lasso is unreachable', async () => {
  const r = await reportSkill(reportReq('requestNews'));
  assert.equal(r.data.final, true);
  assert.deepEqual(reportMims(r), ['NewsServiceDown'], 'single skill: no kickoff, no weather, no outro mim');
  assert.ok(!/personal report/i.test(reportEsml(r)));
});

test('report: requestWeatherPR -> weather subskill only', async () => {
  const r = await reportSkill(reportReq('requestWeatherPR'));
  assert.deepEqual(reportMims(r), ['WeatherServiceDown']);
  assert.ok(!/personal report/i.test(reportEsml(r)));
});

test('report: launchPersonalReport without an ID asks WhoIsThis (QN, non-final)', async () => {
  const r = await reportSkill(reportReq('launchPersonalReport'));
  assert.equal(r.data.final, false, 'WhoIsThis is a question');
  assert.deepEqual(reportMims(r), ['PersonalReportWhoIsThis']);
  assert.equal(slimsOf(r)[0].config.listen.rule, 'shared/wrong_id');
});

test('report: full report for an IDed adult -> SettingsFailed + per-service degradation + outro MAN', async () => {
  const r = await reportSkill(reportReq('launchPersonalReport', { speaker: 'u1' }));
  assert.equal(r.data.final, true);
  assert.deepEqual(reportMims(r), [
    'PersonalReportSettingsFailed', // settings service dead -> defaults + apology
    'WeatherServiceDown',           // weather active by default, lasso dead
    'NewsServiceDown',              // news active by default, lasso dead
    'PersonalReportOutroConfigured', // settingsError -> basic outro
  ]);
});

test('report: requestCommute without an ID -> WhoIsThis, then notInLoop -> MustBeLooper', async () => {
  // Commute needs an ID, so the UserID subgraph asks first (unlike weather/news).
  const r1 = await reportSkill(reportReq('requestCommute'));
  assert.equal(r1.data.final, false);
  assert.deepEqual(reportMims(r1), ['PersonalReportWhoIsThis']);

  // The user answers "that's not me" -> SetLooperID NotInLoop -> prefs say MustBeLooper.
  const base = reportReq('requestCommute');
  const r2 = await reportSkill({
    type: SkillRequestType.LISTEN_UPDATE, msgID: 'm2', ts: 2,
    data: {
      ...base.data,
      skill: { id: 'report-skill', session: r1.data.skill.session },
      result: { nlu: { intent: 'notInLoop', entities: {}, rules: [] }, asr: { text: "that's not me" } },
    },
  });
  assert.equal(r2.data.final, true);
  assert.deepEqual(reportMims(r2), ['PersonalReportMustBeLooper']);
});

test('report: requestCalendar from a child -> MustBeAdult', async () => {
  const r = await reportSkill(reportReq('requestCalendar', { speaker: 'kid', adult: false }));
  assert.deepEqual(reportMims(r), ['PersonalReportMustBeAdult']);
});

test('report: proactive launch -> opt-in proposal question (VERIFY_ID base MIM)', async () => {
  const r = await reportSkill({
    ...reportReq(null, { speaker: 'u2', adult: false, memo: 'Proactive' }),
    type: SkillRequestType.PROACTIVE_LAUNCH,
  });
  assert.equal(r.data.final, false, 'proposal is a question');
  assert.deepEqual(reportMims(r), ['OptInProposalVerifyID'], 'unified base MIM identity');
  assert.equal(slimsOf(r)[0].config.listen.rule, 'shared/verify_id');
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
