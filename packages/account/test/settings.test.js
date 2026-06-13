// H.2 — the settings service: AWS-JSON GetSettings/UpdateSettings round-trip, the friendly
// portal editor, and the end-to-end payoff — the report-skill reading real prefs from a LIVE
// settings service instead of degrading to SettingsFailed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRequestType } from '@phoenix/contracts';

const dir = mkdtempSync(join(tmpdir(), 'phx-settings-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount } = await import('../src/model.js');

let server; let base; const jar = new Map();
async function call(method, path, body, jarName = 'c') {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(jar.get(jarName) ? { cookie: jar.get(jarName) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) jar.set(jarName, sc.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function amzSettings(op, body, accountId) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `Settings_20171219.${op}`,
      ...(accountId ? { 'x-amz-credentials': JSON.stringify({ id: accountId }) } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('AWS-JSON GetSettings: default report-skill data shape the report-skill expects', async () => {
  const r = await amzSettings('GetSettings', { loopId: 'l', skills: 'report-skill' }, 'acct-x');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  const entry = r.body.find((s) => s.skillId === 'report-skill');
  assert.ok(entry, 'report-skill entry present');
  assert.equal(entry.data.weatherEnabled.value, 1, 'weather on by default');
  assert.equal(entry.data.newsEnabled.value, 1, 'news on by default');
  assert.equal(entry.data.commuteEnabled.value, 0, 'commute off by default');
});

test('portal settings editor: GET defaults, PUT toggles, GET reflects', async () => {
  await call('POST', '/api/signup', { email: 'jane@jetson.test', password: 'orbit-city-4ever', firstName: 'Jane' });
  const me = await call('GET', '/api/me');
  const accountId = me.body.account.id;

  const g = await call('GET', '/api/settings');
  assert.equal(g.body.settings.weather.active, true);
  assert.equal(g.body.settings.news.active, true);

  // Turn news OFF and commute ON with locations.
  const put = await call('PUT', '/api/settings', {
    news: { active: false },
    commute: { active: true, home: { lat: 42.36, lng: -71.06 }, work: { lat: 42.37, lng: -71.12 }, mode: 'driving' },
  });
  assert.equal(put.body.settings.news.active, false);
  assert.equal(put.body.settings.commute.active, true);
  assert.equal(put.body.settings.commute.mode, 'driving');

  // The AWS-JSON face (keyed by the same accountId) reflects it for the report-skill.
  const wire = await amzSettings('GetSettings', { loopId: 'l', skills: 'report-skill' }, accountId);
  const data = wire.body.find((s) => s.skillId === 'report-skill').data;
  assert.equal(data.newsEnabled.value, 0);
  assert.equal(data.commuteEnabled.value, 1);
  assert.equal(data.homeLocation.lat, 42.36);
});

test('END-TO-END: report-skill reads real prefs from the live settings service (no SettingsFailed)', async () => {
  const store = getStore();
  // an account whose settings say: weather ON, everything else OFF
  const acct = createOwnerAccount(store, { email: 'george@jetson.test', password: 'spacely-sprockets' });
  await amzSettings('UpdateSettings', {
    data: { weatherEnabled: { value: 1 }, newsEnabled: { value: 0 }, commuteEnabled: { value: 0 }, calendarEnabled: { value: 0 } },
  }, acct._id);

  // point the report-skill at THIS settings service and drive a full report
  process.env.NET_settings = base.replace('http://', '');
  delete process.env.ETCO_report_prefsFromConfig;
  const { reportSkill } = await import('../../skills/src/reportSkill.js');

  const r = await reportSkill({
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: {
        dialog: {}, perception: { speaker: 'u1' },
        loop: { loopId: 'loop-1', users: [{ id: 'u1', accountId: acct._id, birthdate: '1990-01-01', firstName: 'George' }] },
        location: { lat: 42.36, lng: -71.06, iso: '2026-06-13T10:00:00-04:00' },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  });
  delete process.env.NET_settings;

  const jcp = r.data.action.config.jcp;
  const mims = (jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((c) => c.type === 'SLIM')).map((s) => s.config.play.meta.mim_id);
  // The settings service SUCCEEDED (no SettingsFailed degradation) and its prefs were honored:
  // the "configured" KickOff played (settings returned active prefs), and with only weather
  // active + lasso unreachable here, all-active-services-down routes to AllServicesDown — NOT
  // SettingsFailed, and news (disabled) is never attempted (no NewsServiceDown).
  assert.ok(!mims.includes('PersonalReportSettingsFailed'), `no SettingsFailed: ${JSON.stringify(mims)}`);
  assert.ok(mims.includes('PersonalReportKickOff'), `configured kickoff played: ${JSON.stringify(mims)}`);
  assert.ok(mims.includes('PersonalReportAllServicesDown'), `only-active weather down -> AllServicesDown: ${JSON.stringify(mims)}`);
  assert.ok(!mims.includes('NewsServiceDown'), 'news disabled in settings -> not attempted');
});
