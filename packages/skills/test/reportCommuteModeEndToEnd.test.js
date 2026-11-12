// Commute mode, end to end: what someone picks in the console is the mode the
// personal report routes with.
//
// The console stores commuteType as an index into [driving, walking,
// bicycling, transit]; every record it has saved means that. The report skill
// is the source port and reads the source CommuteMode enum [driving, transit,
// bicycling, walking] off the Settings wire. Before the fix Settings handed the
// stored number straight through, so walking and transit came out swapped for
// everyone. Settings now renumbers at its boundary; stored records keep their
// meaning.
//
// Real Account portal + real internal Settings listener + the real report
// skill; only the maps relay is a local stub that records the requested mode.
// Every person, place and address is invented; no real network is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRequestType } from '@phoenix/contracts';
import { reportSkill } from '../src/reportSkill.js';
import { SettingsClient } from '../src/report/settingsClient.js';
import { clearReportEnvCache } from '../src/report/env.js';
import { createAccountService, createSettingsInternalService, Store } from '../../account/src/index.js';
import { createLoop, createOwnerAccount, newId } from '../../account/src/model.js';
import { createSession } from '../../account/src/sessions.js';
import { settingsAwsDispatch } from '../../account/src/settingsFace.js';

const PEER_TOKEN = 'report-commute-mode-peer-test';
const NOW = Date.parse('2026-10-14T12:00:00Z'); // 08:00 in New York
const ISO = '2026-10-14T08:00:00-04:00';
const MODES = ['driving', 'walking', 'bicycling', 'transit'];
// What the console has always stored for each choice. Saved records keep this.
const CONSOLE_INDEX = { driving: 0, walking: 1, bicycling: 2, transit: 3 };
const HOME = { lat: 40.1, lng: -74.2 };
const WORK = { lat: 40.3, lng: -74.4 };

const saved = {};
const ids = {};
const cookies = {};
let dir; let store; let loop;
let portal; let portalUrl; let settings; let maps;
const mapsCalls = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function close(server) {
  return server?.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
}

before(async () => {
  for (const name of ['prefsFromConfig', 'NET_settings', 'NET_lasso', 'NET_data', 'ETCO_account_internalPeerToken']) {
    saved[name] = process.env[name];
  }
  dir = mkdtempSync(join(tmpdir(), 'phx-report-commute-mode-'));
  store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'owner@fixture.invalid', password: 'owner-password-1', firstName: 'Morgan' });
  const linked = createOwnerAccount(store, { email: 'linked@fixture.invalid', password: 'linked-password-1', firstName: 'Riley' });
  ids.owner = owner._id;
  ids.linked = linked._id;
  ({ loop } = createLoop(store, { owner, robotId: 'commute-mode-robot' }));
  ids.linkedMember = newId();
  ids.local = newId();
  loop.members.push(
    { _id: ids.linkedMember, accountId: linked._id, status: 'accepted', memberProperties: { firstName: 'Riley' } },
    { _id: ids.local, status: 'accepted', memberProperties: { firstName: 'Robin', isChild: false, email: null, birthday: Date.UTC(1990, 0, 1) } },
  );
  store.flush();
  cookies.owner = `phx_session=${createSession(store, { kind: 'user', accountId: owner._id })._id}`;
  cookies.linked = `phx_session=${createSession(store, { kind: 'user', accountId: linked._id })._id}`;

  process.env.ETCO_account_internalPeerToken = PEER_TOKEN;
  portal = await createAccountService({ store }).listen(0, '127.0.0.1');
  portalUrl = `http://127.0.0.1:${portal.address().port}`;
  settings = await createSettingsInternalService({ store }).listen(0, '127.0.0.1');
  maps = await listen(http.createServer((req, res) => {
    const url = new URL(req.url, 'http://maps-stub');
    if (url.pathname !== '/v1/google_maps') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"not stubbed"}');
      return;
    }
    mapsCalls.push(url.searchParams.get('mode'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ relayData: {
      status: 'OK', routes: [{ legs: [{ duration: { value: 1500 }, duration_in_traffic: { value: 1500 } }] }],
    } }));
  }));
  process.env.NET_settings = `127.0.0.1:${settings.address().port}`;
  process.env.NET_lasso = `127.0.0.1:${maps.address().port}`;
  delete process.env.NET_data;
  process.env.prefsFromConfig = 'false';
  clearReportEnvCache();
});

after(async () => {
  await Promise.all([close(portal), close(settings), close(maps)]);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearReportEnvCache();
  rmSync(dir, { recursive: true, force: true });
});

async function console_(method, path, body, who) {
  const res = await fetch(`${portalUrl}${path}`, {
    method,
    headers: { cookie: cookies[who], ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// What the robot sends: the linked adult carries an accountId, Robin has none.
function users() {
  return [
    { id: ids.linkedMember, name: 'Riley', accountId: ids.linked, birthdate: '1985-05-05' },
    { id: ids.local, name: 'Robin', birthdate: '1990-01-01' },
  ];
}
function runtime(speaker) {
  return { dialog: {}, perception: { speaker }, loop: { loopId: loop._id, users: users() }, location: { lat: 40, lng: -74, iso: ISO } };
}
function commuteRequest(speaker) {
  return {
    type: SkillRequestType.LISTEN_LAUNCH, msgID: 'commute-mode', ts: 1,
    data: {
      general: { accountID: ids.owner, robotID: 'commute-mode-robot', lang: 'en-US' },
      runtime: runtime(speaker),
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'requestCommute', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  };
}
const sourceRequest = { req: { jibo: {
  transID: 'commute-mode',
  toHeader: () => ({ 'x-jibo-transid': 'commute-mode', 'x-jibo-robotid': 'commute-mode-robot', 'x-jibo-logging-config': '{}' }),
} } };

/** The report's own reader, then a full spoken commute report through the maps relay. */
async function reportMode(speaker) {
  const prefs = await SettingsClient.getUserPrefs({
    log: {}, runtime: runtime(speaker), req: { jibo: { transID: 'tid:commute-mode' } },
  }, speaker);
  mapsCalls.length = 0;
  const response = await reportSkill(commuteRequest(speaker), sourceRequest);
  assert.equal(response.data.final, true);
  assert.equal(mapsCalls.length, 1, 'the commute report asked the maps relay once');
  return { prefsMode: prefs.commute.mode, routedMode: mapsCalls[0] };
}

const PEOPLE = {
  'a linked adult (their own Account page)': {
    speaker: () => ids.linkedMember,
    record: () => store.settings.get(ids.linked)?.data,
    async save(mode) {
      return console_('PUT', '/api/settings', { commute: { active: true, mode, time: { hour: 9, min: 0 }, home: HOME, work: WORK } }, 'linked');
    },
    async readBack() {
      return (await console_('GET', '/api/settings', undefined, 'linked')).body.settings.commute.mode;
    },
  },
};

for (const [who, person] of Object.entries(PEOPLE)) {
  for (const mode of MODES) {
    test(`${who}: "${mode}" chosen in the console is the mode the report routes with`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const saved_ = await person.save(mode);
      assert.equal(saved_.status, 200, JSON.stringify(saved_.body));
      // Stored value: the console's numbering, unchanged by this fix.
      assert.equal(person.record().commuteType.value, CONSOLE_INDEX[mode], 'stored index keeps its meaning');
      assert.equal(await person.readBack(), mode, 'the console shows the same choice again');
      const { prefsMode, routedMode } = await reportMode(person.speaker());
      assert.equal(prefsMode, mode, 'report preferences');
      assert.equal(routedMode, mode, 'mode sent to the maps relay');
    });
  }
}

test('a record the console saved before this fix keeps its meaning', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // Written exactly as an earlier console save left it: walking = 1, transit = 3.
  for (const [mode, value] of [['walking', 1], ['transit', 3]]) {
    const data = { ...store.settings.get(ids.linked).data, commuteType: { value } };
    store.settings.set(ids.linked, { _id: ids.linked, data, updated: NOW });
    store.flush();
    assert.equal(await PEOPLE['a linked adult (their own Account page)'].readBack(), mode);
    const { prefsMode, routedMode } = await reportMode(ids.linkedMember);
    assert.equal(prefsMode, mode);
    assert.equal(routedMode, mode);
    assert.equal(store.settings.get(ids.linked).data.commuteType.value, value, 'reading does not rewrite the record');
  }
});

test('a wire-format UpdateSettings (manifest ids) is stored in the console numbering', async () => {
  const res = { statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(text) { this.body = text; } };
  const req = { headers: { 'content-type': 'application/json' }, _phoenixVerifiedCredentials: store.accounts.get(ids.linked) };
  // Manifest choice id 1 is "Public transport", 3 is "Walk".
  for (const [wire, mode] of [[1, 'transit'], [3, 'walking'], [0, 'driving'], [2, 'bicycling']]) {
    const data = { ...store.settings.get(ids.linked).data, commuteType: { value: wire } };
    await settingsAwsDispatch(store, { req, res, body: { data }, op: 'UpdateSettings', log: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).data[0].data.commuteType.value, wire, 'the reply speaks the wire enum');
    assert.equal(store.settings.get(ids.linked).data.commuteType.value, CONSOLE_INDEX[mode]);
    assert.equal(await PEOPLE['a linked adult (their own Account page)'].readBack(), mode);
  }
});
