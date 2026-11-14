// Loop → Manage → Personal report for an adult in the loop without a login.
//
// 5x1 parity (G3). The loop owner chooses Calendar / Commute / News for an
// accountless adult; their report reads it through the internal Settings hop
// by loop ID + member ID. Linked adults keep their own Account settings and
// the owner cannot read or change them here; children keep the report's
// default behaviour. Synthetic loop: owner, linked adult, unlinked adult and
// child (plus outsiders). Every person, address and calendar is invented and
// no real network is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, createSettingsInternalService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, newId } = await import('../src/model.js');
const { createSession } = await import('../src/sessions.js');
const { defaultSettingsData, setSettingsData } = await import('../src/settingsData.js');
const { fetchAndParseIcal } = await import('../src/icalSubscriptions.js');

const PEER_TOKEN = 'local-adult-report-peer-test';
const dir = mkdtempSync(join(tmpdir(), 'phx-local-adult-report-'));
const store = new Store(join(dir, 'store.json'));
const ids = {};
const cookies = new Map();
let loop; let otherLoop;
let service; let server; let base;
let settingsServer; let settingsUrl;
let previousToken;
const fetched = [];

const CANNED_EVENT = {
  summary: 'Fixture standup', start: { dateTime: '2026-11-12T15:00:00Z', timestamp: Date.parse('2026-11-12T15:00:00Z') },
  end: { dateTime: '2026-11-12T15:30:00Z', timestamp: Date.parse('2026-11-12T15:30:00Z') },
};

// Canned feed for the invented public host; anything else goes through the
// real fetcher, so its URL rules (private-address refusal) still apply.
async function calendarFetcher(url, options) {
  fetched.push(url);
  if (new URL(url).hostname === 'calendar.fixture.example') return { events: [CANNED_EVENT] };
  return fetchAndParseIcal(url, { ...options, fetchImpl: async () => { throw new Error('network disabled in test'); } });
}

function member(id, fields) {
  return { _id: id, enrolled: { face: true, voice: true }, created: 1_700_000_000_000, ...fields };
}

async function call(method, path, body, who = 'owner') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies.get(who) ? { cookie: cookies.get(who) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const getReport = (loopId, id, who = 'owner') =>
  call('GET', `/api/loop/members/report?loopId=${encodeURIComponent(loopId)}&id=${encodeURIComponent(id)}`, undefined, who);
const putReport = (body, who = 'owner') => call('PUT', '/api/loop/members/report', body, who);
const viewMember = (body, loopId, memberId) => (body.loop ? [body.loop] : body.loops)
  .find((l) => l.id === loopId).members.find((m) => m.id === memberId);
const localKey = (loopId, memberId) => `loopmember:${loopId}:${memberId}`;

/** Report-skill GetSettings as the skill sends it on the internal hop. */
async function internalGetSettings(body, { accountId, token = PEER_TOKEN } = {}) {
  const res = await fetch(settingsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'x-amz-target': 'Settings_20160801.GetSettings',
      ...(accountId ? { 'x-amz-credentials': JSON.stringify({ id: accountId }) } : {}),
      ...(token ? { 'x-phoenix-internal-token': token } : {}),
    },
    body: JSON.stringify({ transId: 'tid:local-adult', getView: false, skills: 'report-skill', ...body }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, text, json };
}

const OWNER_EDIT = {
  news: { active: true, categories: { science: true, sports: false, technology: false, business: false, national: false } },
  commute: { active: true, mode: 'bicycling', time: { hour: 7, min: 45 }, home: { lat: 40.1, lng: -74.2 }, work: { lat: 40.3, lng: -74.4 } },
  calendar: { active: true, timeZone: 'America/Chicago' },
};

before(async () => {
  previousToken = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = PEER_TOKEN;
  const account = (key, first) => {
    const created = createOwnerAccount(store, {
      email: `${key}@fixture.invalid`, password: `${key}-password-1`, firstName: first, lastName: 'Example',
    });
    ids[key] = created._id;
    return created;
  };
  const owner = account('owner', 'Morgan');
  account('linked', 'Riley');
  account('member', 'Jordan');
  account('newcomer', 'Lee');
  const stranger = account('stranger', 'Avery');

  ({ loop } = createLoop(store, { owner, robotId: 'local-report-robot' }));
  Object.assign(ids, {
    linkedMember: newId(), plainMember: newId(), local: newId(), child: newId(), invited: newId(), removed: newId(),
  });
  loop.members.push(
    member(ids.linkedMember, { accountId: ids.linked, status: 'accepted', memberProperties: { firstName: 'Riley' } }),
    member(ids.plainMember, { accountId: ids.member, status: 'accepted', memberProperties: { firstName: 'Jordan' } }),
    member(ids.local, {
      accountId: undefined, status: 'accepted',
      memberProperties: { firstName: 'Robin', lastName: 'Sample', isChild: false, email: null, birthday: Date.UTC(1990, 0, 1) },
    }),
    member(ids.child, {
      accountId: undefined, status: 'accepted',
      memberProperties: { firstName: 'Kit', lastName: 'Fixture', isChild: true, email: null },
    }),
    member(ids.invited, {
      accountId: undefined, status: 'invited', invitationCode: 'Invite1',
      memberProperties: { firstName: 'Quinn', email: 'quinn@fixture.invalid', isChild: false },
    }),
    member(ids.removed, { accountId: undefined, status: 'removed', memberProperties: { firstName: 'Gone', isChild: false } }),
  );
  ({ loop: otherLoop } = createLoop(store, { owner: stranger, robotId: 'local-report-other-robot' }));
  ids.foreignLocal = newId();
  otherLoop.members.push(member(ids.foreignLocal, {
    accountId: undefined, status: 'accepted', memberProperties: { firstName: 'Sam', isChild: false, email: null },
  }));

  // The linked adult's own Account → Personal report choices.
  const linkedData = defaultSettingsData();
  linkedData.newsEnabled = { value: 0 };
  linkedData.commuteEnabled = { value: 1 };
  linkedData.commuteType = { value: 2 };
  linkedData.calendarTimeZone = { value: 'Europe/Paris' };
  setSettingsData(store, ids.linked, linkedData);
  store.flush();

  service = createAccountService({ store, calendarFetcher });
  server = await service.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  settingsServer = await createSettingsInternalService({ store }).listen(0, '127.0.0.1');
  settingsUrl = `http://127.0.0.1:${settingsServer.address().port}/`;
  for (const key of ['owner', 'linked', 'member', 'stranger']) {
    cookies.set(key, `phx_session=${createSession(store, { kind: 'user', accountId: ids[key] })._id}`);
  }
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (settingsServer?.listening) await new Promise((resolve) => settingsServer.close(resolve));
  if (previousToken === undefined) delete process.env.ETCO_account_internalPeerToken;
  else process.env.ETCO_account_internalPeerToken = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

test('RED G3: the owner sees Manage report only for the adult without a login', async () => {
  const listed = await call('GET', '/api/loop');
  assert.equal(listed.status, 200);
  assert.equal(viewMember(listed.body, loop._id, ids.local).canManageReport, true);
  for (const id of [ids.linkedMember, ids.plainMember, ids.child, ids.invited]) {
    assert.equal(viewMember(listed.body, loop._id, id).canManageReport, false, id);
  }
  const owner = listed.body.loops.find((l) => l.id === loop._id).members.find((m) => m.accountId === ids.owner);
  assert.equal(owner.canManageReport, false);
  // Another adult in the loop sees no such control for anyone.
  const asMember = await call('GET', '/api/loop', undefined, 'member');
  for (const m of asMember.body.loops.find((l) => l.id === loop._id).members) assert.notEqual(m.canManageReport, true);
});

test('RED G3: owner edits for the unlinked adult persist under loop + member identity', async () => {
  const linkedBefore = JSON.stringify(store.settings.get(ids.linked));
  const ownerBefore = JSON.stringify(store.settings.get(ids.owner) ?? null);

  const first = await getReport(loop._id, ids.local);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.settings.calendar.active, false, 'report defaults until the owner saves');
  assert.equal(first.body.settings.news.active, true);

  const saved = await putReport({ loopId: loop._id, id: ids.local, settings: OWNER_EDIT });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const record = store.settings.get(localKey(loop._id, ids.local));
  assert.ok(record, 'stored as loopmember:<loopId>:<memberId>');
  assert.equal(record.data.newsEnabled.value, 1);
  assert.equal(record.data.newsScience.value, 1);
  assert.equal(record.data.newsSports.value, 0);
  assert.equal(record.data.commuteEnabled.value, 1);
  assert.deepEqual(record.data.commuteTime, { hour: 7, min: 45 });
  assert.deepEqual(record.data.homeLocation, { lat: 40.1, lng: -74.2 });
  assert.equal(record.data.calendarEnabled.value, 1);
  assert.equal(record.data.calendarTimeZone.value, 'America/Chicago');
  for (const key of ['google:personalCalendar:readonly', 'outlook:workCalendar:readonly']) {
    assert.deepEqual(record.data[key], { credentialExists: false });
  }

  // Reopen: the owner sees exactly what was saved.
  const reopened = await getReport(loop._id, ids.local);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.settings.commute, {
    active: true, mode: 'bicycling', time: { hour: 7, min: 45 }, home: { lat: 40.1, lng: -74.2 }, work: { lat: 40.3, lng: -74.4 },
  });
  assert.equal(reopened.body.settings.news.categories.science, true);
  assert.equal(reopened.body.settings.news.categories.sports, false);
  assert.deepEqual(reopened.body.settings.calendar, { active: true, timeZone: 'America/Chicago' });

  // Nobody else's record moved.
  assert.equal(JSON.stringify(store.settings.get(ids.linked)), linkedBefore, 'linked adult settings byte-identical');
  assert.equal(JSON.stringify(store.settings.get(ids.owner) ?? null), ownerBefore, 'owner settings untouched');
  assert.equal(store.settings.has(localKey(loop._id, ids.child)), false);
});

test('RED G3: the unlinked adult\'s report request reads the owner\'s choices', async () => {
  const res = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local });
  assert.equal(res.status, 200, res.text);
  const [report] = res.json;
  assert.equal(report.skillId, 'report-skill');
  assert.equal(report.data.commuteEnabled.value, 1);
  assert.equal(report.data.commuteType.value, 2, 'bicycling');
  assert.equal(report.data.calendarTimeZone.value, 'America/Chicago');
  assert.equal(report.data.calendarEnabled.value, 1);
  assert.equal(report.data['google:personalCalendar:readonly'].credentialExists, false);
});

test('calendar feeds use the account iCal path: canned feed verified, private address refused, URL never shown', async () => {
  const added = await call('POST', '/api/loop/members/report/calendars',
    { loopId: loop._id, id: ids.local, url: 'https://calendar.fixture.example/robin.ics?token=fixture-secret', label: 'Robin work' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const [feed] = added.body.settings.subscriptions;
  assert.equal(feed.label, 'Robin work');
  assert.equal(feed.host, 'calendar.fixture.example');
  assert.equal(feed.verification.status, 'ok');
  assert.equal(feed.verification.eventCount, 1);
  assert.doesNotMatch(JSON.stringify(added.body), /fixture-secret|robin\.ics/);

  const blocked = await call('POST', '/api/loop/members/report/calendars',
    { loopId: loop._id, id: ids.local, url: 'http://127.0.0.1:9/private.ics', label: 'Private' });
  assert.equal(blocked.status, 201);
  const bad = blocked.body.settings.subscriptions.find((item) => item.label === 'Private');
  assert.equal(bad.verification.status, 'invalid', 'the SSRF rule of the account path applies');
  assert.equal(bad.verification.eventCount, 0);
  assert.equal(bad.verification.lastError, 'calendar URL host is not allowed', 'refused before any fetch');

  // The report receives the cached events without the private feed address.
  const res = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local });
  assert.equal(res.status, 200, res.text);
  const subs = res.json[0].data.icalSubscriptions.subscriptions;
  assert.equal(subs.find((s) => s.label === 'Robin work').events[0].summary, 'Fixture standup');
  assert.doesNotMatch(res.text, /fixture-secret|robin\.ics|127\.0\.0\.1/);

  const removed = await call('POST', '/api/loop/members/report/calendars/remove',
    { loopId: loop._id, id: ids.local, subscriptionId: bad.id });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.settings.subscriptions.map((s) => s.label), ['Robin work']);
});

test('linked adults keep their own settings: the owner can neither read nor change them here', async () => {
  const before = JSON.stringify(store.settings.get(ids.linked));
  const read = await getReport(loop._id, ids.linkedMember);
  assert.equal(read.status, 403);
  assert.equal(read.body.code, 'MEMBER_NOT_LOCAL_ADULT');
  assert.doesNotMatch(JSON.stringify(read.body), /Europe\/Paris/);
  const write = await putReport({ loopId: loop._id, id: ids.linkedMember, settings: OWNER_EDIT });
  assert.equal(write.status, 403);
  const feed = await call('POST', '/api/loop/members/report/calendars',
    { loopId: loop._id, id: ids.linkedMember, url: 'https://calendar.fixture.example/x.ics' });
  assert.equal(feed.status, 403);
  assert.equal(JSON.stringify(store.settings.get(ids.linked)), before, 'byte-identical');
  assert.equal(store.settings.has(localKey(loop._id, ids.linkedMember)), false);

  // Their report still reads their own account record, unchanged.
  const own = await internalGetSettings({ loopId: loop._id }, { accountId: ids.linked });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json[0].data.calendarTimeZone.value, 'Europe/Paris');
  assert.equal(own.json[0].data.newsEnabled.value, 0);
  // Naming a linked adult by member ID gets nothing.
  const byMember = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.linkedMember });
  assert.equal(byMember.status, 403);
  assert.doesNotMatch(byMember.text, /Europe\/Paris/);
});

test('children keep the standard report: no editor, no stored record, no member lookup', async () => {
  const read = await getReport(loop._id, ids.child);
  assert.equal(read.status, 403);
  assert.equal(read.body.code, 'MEMBER_NOT_LOCAL_ADULT');
  const write = await putReport({ loopId: loop._id, id: ids.child, settings: { news: { active: false } } });
  assert.equal(write.status, 403);
  assert.equal(store.settings.has(localKey(loop._id, ids.child)), false);
  const report = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.child });
  assert.equal(report.status, 403);
});

test('outsiders, other members, wrong loop, removed and invited people are refused', async () => {
  const edit = { loopId: loop._id, id: ids.local, settings: { news: { active: false } } };
  assert.equal((await putReport(edit, 'member')).status, 403, 'a non-owner adult in the loop');
  assert.equal((await putReport(edit, 'linked')).status, 403, 'the linked adult');
  assert.equal((await putReport(edit, 'stranger')).status, 403, 'someone outside the loop');
  assert.equal((await putReport(edit, 'nobody')).status, 401, 'not signed in');
  assert.equal((await getReport(loop._id, ids.local, 'stranger')).status, 403);
  assert.equal(store.settings.get(localKey(loop._id, ids.local)).data.newsEnabled.value, 1, 'unchanged');

  // A member ID from another loop does not resolve inside this one.
  assert.equal((await getReport(loop._id, ids.foreignLocal)).status, 404);
  assert.equal((await getReport(otherLoop._id, ids.foreignLocal)).status, 403);
  assert.equal((await getReport(loop._id, ids.removed)).status, 404);
  assert.equal((await getReport(loop._id, ids.invited)).status, 403);

  for (const [loopId, memberId] of [
    [otherLoop._id, ids.local], [loop._id, ids.foreignLocal], [loop._id, ids.removed], [loop._id, ids.invited], ['missing', ids.local],
  ]) {
    const res = await internalGetSettings({ loopId, loopMemberId: memberId });
    assert.equal(res.status, 403, `${loopId}/${memberId}`);
  }
  // The member form never works without the internal peer token, and a body
  // member ID never overrides a forwarded account identity.
  assert.notEqual((await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local }, { token: null })).status, 200);
  const wrongToken = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local }, { token: 'x'.repeat(PEER_TOKEN.length) });
  assert.notEqual(wrongToken.status, 200);
  const withAccount = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local }, { accountId: ids.linked });
  assert.equal(withAccount.status, 200, withAccount.text);
  assert.equal(withAccount.json[0].data.calendarTimeZone.value, 'Europe/Paris', 'account identity wins');
});

test('local Weather: owner saves and reads back units, location and the existing choice rows', async () => {
  const weather = { active: true, celsius: true, location: { lat: 0, lng: 18.25 } };
  const linkedBefore = JSON.stringify(store.settings.get(ids.linked));
  const saved = await putReport({ loopId: loop._id, id: ids.local, settings: { weather } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.settings.weather, weather);
  const reopened = await getReport(loop._id, ids.local);
  assert.deepEqual(reopened.body.settings.weather, weather);
  const data = store.settings.get(localKey(loop._id, ids.local)).data;
  assert.deepEqual(data.weather, { value: 1 });
  assert.deepEqual(data.weatherLocation, weather.location);
  const disk = new Store(join(dir, 'store.json'));
  assert.deepEqual(disk.settings.get(localKey(loop._id, ids.local)).data.weatherLocation, weather.location);

  const wire = await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local, getView: true });
  assert.equal(wire.status, 200, wire.text);
  const rows = Object.fromEntries(wire.json[0].view.childViews.map((row) => [row.valueDefinition.key, row]));
  assert.equal(rows.weather.type, 'choice');
  assert.deepEqual(rows.weather.choices, [{ id: 0, value: 'Fahrenheit' }, { id: 1, value: 'Celsius' }]);
  assert.equal(rows.commuteType.type, 'choice');
  assert.deepEqual(rows.commuteType.choices.map((row) => row.value), ['Drive', 'Public transport', 'Bike', 'Walk']);
  assert.equal(rows.weatherLocation.type, 'location', 'the new coordinate row is never an on/off switch');

  const partial = await putReport({ loopId: loop._id, id: ids.local, settings: { weather: { celsius: false } } });
  assert.deepEqual(partial.body.settings.weather, { ...weather, celsius: false });
  const clear = await putReport({ loopId: loop._id, id: ids.local,
    settings: { weather: { active: false, location: { lat: null, lng: null } } } });
  assert.equal(clear.status, 200);
  assert.deepEqual(clear.body.settings.weather, { active: false, celsius: false, location: { lat: null, lng: null } });
  assert.equal(JSON.stringify(store.settings.get(ids.linked)), linkedBefore);
});

test('local Weather: unauthorized edits and reads reveal no saved location or account settings', async () => {
  const edit = { loopId: loop._id, id: ids.local,
    settings: { weather: { active: true, celsius: true, location: { lat: 11.25, lng: 22.5 } } } };
  const before = JSON.stringify([...store.settings]);
  for (const who of ['member', 'linked', 'stranger', 'nobody']) {
    const write = await putReport(edit, who);
    assert.equal(write.status, who === 'nobody' ? 401 : 403, who);
    const read = await getReport(loop._id, ids.local, who);
    assert.equal(read.status, who === 'nobody' ? 401 : 403, who);
    assert.doesNotMatch(JSON.stringify(read.body), /weatherLocation|location/);
  }
  for (const id of [ids.linkedMember, ids.child, ids.invited]) {
    assert.equal((await putReport({ ...edit, id })).status, 403);
  }
  assert.equal(JSON.stringify([...store.settings]), before, 'all records byte-identical after refusals');
});

test('only supported local report options can be changed; malformed Weather is refused atomically', async () => {
  const before = JSON.stringify(store.settings.get(localKey(loop._id, ids.local)).data);
  for (const settings of [
    { weather: { active: 'yes' } },
    { weather: { celsius: 1 } },
    { weather: { units: 'kelvin' } },
    { weather: { location: { lat: 91, lng: 0 } } },
    { weather: { location: { lat: 0, lng: -181 } } },
    { weather: { location: { lat: 0, lng: null } } },
    { weather: { location: { lat: '0', lng: 0 } } },
    { weather: { location: { lat: 0, lng: 0, url: 'https://fixture.invalid' } } },
    { offerProactively: false },
    { calendar: { googlePersonal: true } },
    { calendar: { timeZone: 'Not/AZone' } },
    { commute: { mode: 'teleport' } },
    { commute: { home: { lat: 91, lng: 0 } } },
    { news: { categories: { gossip: true } } },
    { news: { active: 'yes' } },
  ]) {
    const res = await putReport({ loopId: loop._id, id: ids.local, settings });
    assert.equal(res.status, 400, JSON.stringify(settings));
  }
  assert.equal(JSON.stringify(store.settings.get(localKey(loop._id, ids.local)).data), before);
});

test('their calendar feeds are refreshed daily like an account\'s', async () => {
  const { IcalRefreshService } = await import('../src/icalRefresh.js');
  const key = localKey(loop._id, ids.local);
  const before = store.settings.get(key).data.icalSubscriptions.subscriptions[0].verification.lastChecked;
  const later = Date.now() + 2 * 86_400_000;
  const refresher = new IcalRefreshService(store, { fetcher: calendarFetcher, now: () => later });
  assert.ok(refresher._accountsWithSubscriptions().includes(key));
  const result = await refresher.refreshDue();
  assert.ok(result.refreshed >= 1, JSON.stringify(result));
  const feed = store.settings.get(key).data.icalSubscriptions.subscriptions[0];
  assert.equal(feed.verification.lastChecked, later);
  assert.notEqual(feed.verification.lastChecked, before);
  // A removed person or a child is never a refresh subject.
  assert.equal(refresher._isLiveSubject(localKey(loop._id, ids.removed)), false);
  assert.equal(refresher._isLiveSubject(localKey(loop._id, ids.child)), false);
});

test('their report settings go when they leave the loop or get an account', async () => {
  // A second local adult who then links an account.
  const later = newId();
  const target = store.loops.get(loop._id);
  target.members.push(member(later, {
    accountId: undefined, status: 'accepted', memberProperties: { firstName: 'Lee', isChild: false, email: null },
  }));
  store.flush();
  assert.equal((await putReport({ loopId: loop._id, id: later, settings: { news: { active: false } } })).status, 200);
  assert.equal(store.settings.has(localKey(loop._id, later)), true);
  const linked = await call('POST', '/api/loop/members/link', { loopId: loop._id, id: later, accountId: ids.newcomer });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(store.settings.has(localKey(loop._id, later)), false, 'now they manage it on their own account');

  const removed = await call('POST', '/api/loop/members/remove', { loopId: loop._id, id: ids.local });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(store.settings.has(localKey(loop._id, ids.local)), false);
  assert.equal((await internalGetSettings({ loopId: loop._id, loopMemberId: ids.local })).status, 403);
});
