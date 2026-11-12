// The personal report of an adult in the loop without a login uses the
// choices the loop owner made for them (Loop → Manage → Personal report).
//
// 5x1 parity (G3). Real account store + the real internal Settings listener;
// the report skill resolves the speaker by loop ID + member ID because they
// have no account. Linked adults keep reading their own account record and
// children keep the report defaults. Every person and event is invented; no
// news, map or calendar provider is contacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRequestType } from '@phoenix/contracts';
import { reportSkill } from '../src/reportSkill.js';
import { SettingsClient } from '../src/report/settingsClient.js';
import { clearReportEnvCache } from '../src/report/env.js';
import { createSettingsInternalService, Store } from '../../account/src/index.js';
import { createLoop, createOwnerAccount, newId } from '../../account/src/model.js';
import { defaultSettingsData, friendlyToData, setSettingsData } from '../../account/src/settingsData.js';

const PEER_TOKEN = 'report-local-adult-peer-test';
const NOW = Date.parse('2026-10-14T12:00:00Z'); // 08:00 in New York
const saved = {};
const ids = {};
let dir; let store; let loop; let server; let requests = 0;

before(async () => {
  for (const name of ['prefsFromConfig', 'NET_settings', 'ETCO_account_internalPeerToken']) saved[name] = process.env[name];
  dir = mkdtempSync(join(tmpdir(), 'phx-report-local-adult-'));
  store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'owner@fixture.invalid', password: 'owner-password-1', firstName: 'Morgan' });
  const linked = createOwnerAccount(store, { email: 'linked@fixture.invalid', password: 'linked-password-1', firstName: 'Riley' });
  ids.owner = owner._id;
  ids.linked = linked._id;
  ({ loop } = createLoop(store, { owner, robotId: 'report-local-robot' }));
  ids.linkedMember = newId();
  ids.local = newId();
  ids.child = newId();
  loop.members.push(
    { _id: ids.linkedMember, accountId: linked._id, status: 'accepted', memberProperties: { firstName: 'Riley' } },
    { _id: ids.local, status: 'accepted', memberProperties: { firstName: 'Robin', isChild: false, email: null, birthday: Date.UTC(1990, 0, 1) } },
    { _id: ids.child, status: 'accepted', memberProperties: { firstName: 'Kit', isChild: true, email: null } },
  );
  store.flush();

  // The linked adult's own Account → Personal report.
  const linkedData = defaultSettingsData();
  linkedData.newsEnabled = { value: 0 };
  linkedData.calendarTimeZone = { value: 'Europe/Paris' };
  setSettingsData(store, linked._id, linkedData);

  // What the owner chose for Robin in Loop → Manage, stored under the
  // documented loop + member key (the portal route itself is covered by
  // account/test/loopLocalAdultReport.test.js), plus one cached event.
  const data = friendlyToData({
    news: { active: true, categories: { science: true, health: true, technology: false, sports: false, business: false, national: false } },
    commute: { active: true, mode: 'bicycling', time: { hour: 7, min: 45 }, home: { lat: 40.1, lng: -74.2 }, work: { lat: 40.3, lng: -74.4 } },
    calendar: { active: true, timeZone: 'America/New_York' },
  }, defaultSettingsData());
  data.icalSubscriptions = { subscriptions: [{
    id: 'sub-robin', label: 'Robin', url: 'https://calendar.fixture.example/robin.ics?token=fixture-secret', enabled: true,
    verification: { status: 'ok', eventCount: 1 },
    events: [{
      summary: 'Pottery class',
      start: { dateTime: '2026-10-14T17:00:00Z', timestamp: Date.parse('2026-10-14T17:00:00Z') },
      end: { dateTime: '2026-10-14T18:00:00Z', timestamp: Date.parse('2026-10-14T18:00:00Z') },
    }],
  }] };
  const key = `loopmember:${loop._id}:${ids.local}`;
  store.settings.set(key, { _id: key, data, updated: NOW });
  store.flush();

  process.env.ETCO_account_internalPeerToken = PEER_TOKEN;
  const service = createSettingsInternalService({ store });
  server = await service.listen(0, '127.0.0.1');
  server.on('request', () => { requests += 1; });
  process.env.NET_settings = `127.0.0.1:${server.address().port}`;
  process.env.prefsFromConfig = 'false';
  clearReportEnvCache();
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearReportEnvCache();
  rmSync(dir, { recursive: true, force: true });
});

// What the robot sends: a person without an account has no accountId.
function users() {
  return [
    { id: ids.linkedMember, name: 'Riley', accountId: ids.linked, birthdate: '1985-05-05' },
    { id: ids.local, name: 'Robin', birthdate: '1990-01-01' },
    { id: ids.child, name: 'Kit', birthdate: '2018-03-03' },
  ];
}

function prefsData(speaker) {
  return {
    log: {},
    runtime: {
      perception: { speaker },
      loop: { loopId: loop._id, users: users() },
      location: { lat: 40, lng: -74, iso: '2026-10-14T08:00:00-04:00' },
    },
    req: { jibo: { transID: 'tid:local-adult' } },
  };
}

function request(speaker, intent = 'requestCalendar') {
  return {
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'local-adult', ts: 1,
    data: {
      general: { accountID: ids.owner, robotID: 'report-local-robot', lang: 'en-US' },
      runtime: {
        dialog: {}, perception: { speaker },
        loop: { loopId: loop._id, users: users() },
        location: { lat: 40, lng: -74, iso: '2026-10-14T08:00:00-04:00' },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent, entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  };
}

const sourceRequest = { req: { jibo: {
  transID: 'local-adult',
  toHeader: () => ({ 'x-jibo-transid': 'local-adult', 'x-jibo-robotid': 'report-local-robot', 'x-jibo-logging-config': '{}' }),
} } };

function speech(response) {
  const jcp = response.data.action.config.jcp;
  const slims = jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((child) => child.type === 'SLIM');
  return slims.map((slim) => slim.config.play.esml).join(' ');
}

test('RED G3: the unlinked adult\'s report prefs are the owner\'s choices', async () => {
  const prefs = await SettingsClient.getUserPrefs(prefsData(ids.local), ids.local);
  assert.equal(prefs.commute.active, true);
  assert.equal(prefs.commute.mode, 'bicycling');
  assert.deepEqual(prefs.commute.workTime, { hour: 7, min: 45 });
  assert.deepEqual(prefs.commute.origin, { lat: 40.1, lng: -74.2 });
  assert.equal(prefs.commute.complete, true);
  assert.equal(prefs.news.active, true);
  assert.equal(prefs.news.activeNewsCategories.science, true);
  assert.equal(prefs.news.activeNewsCategories.health, true);
  assert.equal(prefs.news.activeNewsCategories.technology, false);
  assert.equal(prefs.calendar.active, true);
  assert.equal(prefs.calendar.timeZone, 'America/New_York');
  assert.equal(prefs.calendar.googlePersonalCreds, false);
  assert.equal(prefs.calendar.icalSubscriptions[0].events[0].summary, 'Pottery class');
  assert.equal(JSON.stringify(prefs).includes('fixture-secret'), false, 'the feed address never reaches the robot');
});

test('RED G3: asking for their calendar reads the owner-managed calendar', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const response = await reportSkill(request(ids.local), sourceRequest);
  assert.equal(response.data.final, true);
  const said = speech(response);
  assert.match(said, /Pottery class/, said);
  assert.match(said, /1:00 PM/, said);
  assert.doesNotMatch(said, /trouble|couldn.t|settings/i);
});

test('a linked adult still gets their own account settings', async () => {
  const prefs = await SettingsClient.getUserPrefs(prefsData(ids.linkedMember), ids.linkedMember);
  assert.equal(prefs.news.active, false);
  assert.equal(prefs.calendar.timeZone, 'Europe/Paris');
  assert.equal(prefs.commute.active, false);
});

test('a child still gets the default report without any Settings request', async () => {
  const before = requests;
  const prefs = await SettingsClient.getUserPrefs(prefsData(ids.child), ids.child);
  assert.deepEqual(prefs, SettingsClient.getDefaultPrefs());
  assert.equal(requests, before);
});
