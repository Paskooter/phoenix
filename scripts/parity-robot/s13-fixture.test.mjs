import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRequestType } from '@phoenix/contracts';
import { createDataService } from '../../packages/data/src/index.js';
import { createSkillService } from '../../packages/skills/src/skillService.js';
import { createReportSkill } from '../../packages/skills/src/reportSkill.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { LassoClient } from '../../packages/skills/src/report/lassoClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';
import {
  S13_FIXTURE_SCHEMA,
  S13_FIXTURE_CALENDAR_ACCOUNT_ID,
  casesSha256,
  createS13FixtureRuntime,
  installCalendarIdentityBridge,
  readS13Fixture,
  resolveLocalOffset,
} from './s13-fixture.mjs';

function prefs() {
  return {
    weather: { active: false, useCelsius: false },
    calendar: {
      active: true,
      googlePersonalCreds: true,
      googleWorkCreds: false,
      outlookPersonalCreds: true,
      outlookWorkCreds: false,
    },
    commute: {
      active: true,
      workTime: { hour: 9, min: 0 },
      origin: { lat: 42.3, lng: -71.1 },
      destination: { lat: 42.4, lng: -71.0 },
      mode: 'driving',
      complete: true,
    },
    news: { active: false, activeNewsCategories: {} },
  };
}

function map(trafficSeconds) {
  return {
    status: 'OK',
    geocoded_waypoints: [],
    routes: [{ legs: [{
      duration: { text: '10 mins', value: 600 },
      duration_in_traffic: { text: `${trafficSeconds / 60} mins`, value: trafficSeconds },
    }] }],
  };
}

function caseData(trafficSeconds) {
  return {
    userPrefs: prefs(),
    maps: map(trafficSeconds),
    calendar: {
      google: { personalCalendar: { items: [] }, workCalendar: { items: [] } },
      outlook: { personalCalendar: { value: [] }, workCalendar: { value: [] } },
    },
    meta: {
      date: '2026-06-12',
      timeZone: 'UTC',
      workTime: { hour: 9, min: 0 },
      eventTimestamps: [],
    },
  };
}

function documentFor() {
  const cases = { Normal: caseData(600), Bad: caseData(900) };
  return {
    schema: S13_FIXTURE_SCHEMA,
    caseId: 'Normal',
    integrity: { casesSha256: casesSha256(cases) },
    cases,
  };
}

function fixtureFile(document = documentFor()) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-s13-fixture-'));
  const file = join(directory, 'fixture.json');
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, directory, document };
}

function rewrite(file, document) {
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  chmodSync(file, 0o600);
}

test('S-13 template wall-clock offset resolver handles both sides of DST transitions', () => {
  assert.equal(resolveLocalOffset('2026-03-08', 1, 59, 'America/New_York'), '-05:00');
  assert.equal(resolveLocalOffset('2026-03-08', 3, 1, 'America/New_York'), '-04:00');
  // The nonexistent spring-forward wall time follows moment-timezone's
  // compatible/post-gap behavior; the overlap picks the earlier instant.
  assert.equal(resolveLocalOffset('2026-03-08', 2, 30, 'America/New_York'), '-04:00');
  assert.equal(resolveLocalOffset('2026-11-01', 1, 30, 'America/New_York'), '-04:00');
  assert.equal(resolveLocalOffset('2026-03-29', 2, 30, 'Europe/Berlin'), '+02:00');
});

function runtime() {
  return {
    perception: { speaker: 'adult' },
    loop: { loopId: 'loop-1', users: [{ id: 'adult', accountId: 'u1', birthdate: '1990-01-01' }] },
    location: { lat: 42.3, lng: -71.1, iso: '2026-06-12T08:00:00+00:00' },
    dialog: { referent: null },
  };
}

function reportRequest() {
  return {
    type: SkillRequestType.LISTEN_LAUNCH,
    msgID: 's13-report-1',
    ts: 1,
    data: {
      general: { accountID: 'u1', robotID: 'r1', lang: 'en-US' },
      runtime: runtime(),
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'requestCommute', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  };
}

function postSkill(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/report-skill/main', method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        'x-jibo-transid': 's13-turn-1', 'x-jibo-robotid': 'r1', 'x-jibo-logging-config': '{}',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('S-13 fixture loader enforces private mode, schema, case and semantic digest', () => {
  const { file, document } = fixtureFile();
  const first = readS13Fixture(file);
  assert.equal(first.metadata.caseId, 'Normal');
  assert.equal(first.metadata.casesSha256, document.integrity.casesSha256);
  assert.match(first.metadata.sha256, /^[0-9a-f]{64}$/);

  const wrongCase = { ...document, caseId: 'missing' };
  rewrite(file, wrongCase);
  assert.throws(() => readS13Fixture(file), /caseId 'missing' is not present/);

  rewrite(file, document);
  chmodSync(file, 0o644);
  assert.throws(() => readS13Fixture(file), /mode 0600/);
  chmodSync(file, 0o600);

  const tampered = { ...document, cases: { ...document.cases, Normal: { ...document.cases.Normal, maps: map(1200) } } };
  rewrite(file, tampered);
  assert.throws(() => readS13Fixture(file), /cases SHA-256 mismatch/);
});

test('S-13 fixture runtime rereads exact case selector and settings per call', async () => {
  const { file, document } = fixtureFile();
  const reads = [];
  const runtime = createS13FixtureRuntime({ filePath: file, onRead: (meta) => reads.push(meta) });
  const restore = runtime.installSettingsClient(SettingsClient);
  const data = { log: {}, req: { jibo: { transID: 'turn-1' } } };
  try {
    const normal = await SettingsClient.getUserPrefs(data, 'adult');
    assert.equal(normal.commute.workTime.hour, 9);
    const switched = { ...document, caseId: 'Bad' };
    rewrite(file, switched);
    const bad = await SettingsClient.getUserPrefs(data, 'adult');
    assert.equal(bad.commute.workTime.hour, 9);
    assert.equal(reads.at(-1).caseId, 'Bad');
    assert.equal(reads.length, 2);
  } finally {
    restore();
  }
});

test('S-13 fixture runtime rejects a case switch in the middle of one transaction', () => {
  const { file, document } = fixtureFile();
  const runtime = createS13FixtureRuntime({ filePath: file });
  runtime.mapsProvider({ mode: 'driving' }, { req: { headers: { 'x-jibo-transid': 'turn-1' } } });
  rewrite(file, { ...document, caseId: 'Bad' });
  assert.throws(() => runtime.mapsProvider({ mode: 'driving' }, {
    req: { headers: { 'x-jibo-transid': 'turn-1' } },
  }), /case changed during transaction/);
});

test('S-13 calendar identity bridge fills only the selected missing loop user without mutating report data', async () => {
  const { file } = fixtureFile();
  const fixtureRuntime = createS13FixtureRuntime({ filePath: file });
  const calls = [];
  const client = {
    fetchCalendarEvents: async function fetchCalendarEvents(data, ...args) {
      calls.push({ data, args, receiver: this });
      return { events: [] };
    },
  };
  const original = client.fetchCalendarEvents;
  const restore = fixtureRuntime.installCalendarIdentityBridge(client);
  const input = {
    marker: 'same-report-data',
    runtime: {
      perception: { speaker: 'adult' },
      loop: { loopId: 'loop-1', users: [
        { id: 'adult', birthdate: '1990-01-01' },
        { id: 'other', accountId: 'real-account' },
      ] },
    },
  };
  try {
    const result = await client.fetchCalendarEvents(input, 'google', 'personalCalendar', '2050-01-01T00:00:00Z');
    assert.deepEqual(result, { events: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, client);
    assert.deepEqual(calls[0].args, ['google', 'personalCalendar', '2050-01-01T00:00:00Z']);
    assert.notEqual(calls[0].data, input);
    assert.notEqual(calls[0].data.runtime, input.runtime);
    assert.notEqual(calls[0].data.runtime.loop, input.runtime.loop);
    assert.notEqual(calls[0].data.runtime.loop.users, input.runtime.loop.users);
    assert.equal(calls[0].data.runtime.loop.users[0].accountId, S13_FIXTURE_CALENDAR_ACCOUNT_ID);
    assert.equal(calls[0].data.runtime.loop.users[1].accountId, 'real-account');
    assert.equal(input.runtime.loop.users[0].accountId, undefined);
    assert.equal(fixtureRuntime.metadata().calendarIdentity.accountId, S13_FIXTURE_CALENDAR_ACCOUNT_ID);
    assert.equal(fixtureRuntime.metadata().calendarIdentity.credentials, 'none');
  } finally {
    fixtureRuntime.restore();
  }
  assert.equal(client.fetchCalendarEvents, original);
});

test('S-13 calendar identity bridge preserves valid identity and rejects malformed speaker context', () => {
  let calls = 0;
  const client = {
    fetchCalendarEvents: () => { calls += 1; return 'original'; },
  };
  const original = client.fetchCalendarEvents;
  const restore = installCalendarIdentityBridge(client);
  try {
    const valid = {
      runtime: {
        perception: { speaker: 'adult' },
        loop: { users: [{ id: 'adult', accountId: 'existing-account' }] },
      },
    };
    assert.equal(client.fetchCalendarEvents(valid, 'google', 'personalCalendar'), 'original');
    assert.equal(calls, 1);

    const invalid = [
      [{ runtime: { perception: {}, loop: { users: [] } } }, /requires a selected speaker/],
      [{ runtime: { perception: { speaker: 'unknown' }, loop: { users: [{ id: 'adult' }] } } }, /exactly one loop user/],
      [{ runtime: { perception: { speaker: 'adult' }, loop: { users: [{ id: 'adult' }, { id: 'adult' }] } } }, /exactly one loop user/],
      [{ runtime: { perception: { speaker: 'adult' }, loop: { users: [{ id: 'adult', accountId: 42 }] } } }, /invalid accountId/],
      [{ runtime: { perception: { speaker: 'adult' } } }, /requires loop\.users/],
    ];
    for (const [input, error] of invalid) assert.throws(() => client.fetchCalendarEvents(input), error);
    assert.equal(calls, 1, 'malformed context must fail before the original call');
  } finally {
    restore();
    restore();
  }
  assert.equal(client.fetchCalendarEvents, original);
});

test('S-13 identity bridge reaches the real Lasso calendar request and fixture Data provider', { concurrency: false }, async () => {
  const { file } = fixtureFile();
  const providerCalls = [];
  const fixtureRuntime = createS13FixtureRuntime({ filePath: file, onProvider: (event) => providerCalls.push(event) });
  const dataServer = await createDataService(fixtureRuntime.dataOptions()).listen(0);
  const previousLasso = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${dataServer.address().port}`;
  clearReportEnvCache();
  const original = LassoClient.fetchCalendarEvents;
  fixtureRuntime.installCalendarIdentityBridge(LassoClient);
  const data = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    req: { jibo: { toHeader: () => ({}) } },
    skill: { id: 'report-skill' },
    runtime: {
      perception: { speaker: 'adult' },
      loop: { users: [{ id: 'adult' }] },
      location: { iso: '2026-06-12T08:00:00+00:00' },
    },
  };
  try {
    const result = await LassoClient.fetchCalendarEvents(data, 'google', 'personalCalendar', '2050-01-01T00:00:00Z');
    assert.deepEqual(result, { events: [] });
    assert.equal(data.runtime.loop.users[0].accountId, undefined);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].service, 'google-calendar');
    assert.equal(providerCalls[0].input.accountId, S13_FIXTURE_CALENDAR_ACCOUNT_ID);
  } finally {
    fixtureRuntime.restore();
    assert.equal(LassoClient.fetchCalendarEvents, original);
    await new Promise((resolve, reject) => dataServer.close((error) => error ? reject(error) : resolve()));
    if (previousLasso === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previousLasso;
    clearReportEnvCache();
  }
});

test('S-13 Data HTTP uses source-shaped Maps and Google/Outlook provider fixtures, then sees a case edit', async () => {
  const { file, document } = fixtureFile();
  const providerCalls = [];
  const runtime = createS13FixtureRuntime({ filePath: file, onProvider: (event) => providerCalls.push(event) });
  const server = await createDataService(runtime.dataOptions()).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = encodeURIComponent(JSON.stringify({ lat: 42.3, lon: -71.1 }));
  const destination = encodeURIComponent(JSON.stringify({ lat: 42.4, lon: -71.0 }));
  try {
    const mapsURL = `${base}/v1/google_maps?origin=${origin}&destination=${destination}&mode=driving`;
    let body = await (await fetch(mapsURL)).json();
    assert.equal(body.relayData.routes[0].legs[0].duration.value, 600);
    assert.equal(body.relayData.routes[0].legs[0].duration_in_traffic.value, 600);

    const google = await (await fetch(`${base}/v1/google_calendar?skillId=report-skill&accountId=u1&calendar=personalCalendar&endDate=2050-01-01T00:00:00Z`)).json();
    assert.deepEqual(google.relayData.events, []);
    const outlook = await (await fetch(`${base}/v1/outlook_calendar?skillId=report-skill&accountId=u1&calendar=personalCalendar&endDate=2050-01-01T00:00:00Z`)).json();
    assert.deepEqual(outlook.relayData.events, []);

    rewrite(file, { ...document, caseId: 'Bad' });
    body = await (await fetch(mapsURL)).json();
    assert.equal(body.relayData.routes[0].legs[0].duration_in_traffic.value, 900);
    assert.deepEqual(providerCalls.map((event) => event.service), ['maps', 'google-calendar', 'outlook-calendar', 'maps']);
  } finally {
    server.close();
  }
});

test('S-13 fixture reaches the real Report skill over HTTP and its Data peer', { concurrency: false }, async () => {
  const { file } = fixtureFile();
  const providerCalls = [];
  const runtimeFixture = createS13FixtureRuntime({ filePath: file, onProvider: (event) => providerCalls.push(event) });
  const dataServer = await createDataService(runtimeFixture.dataOptions()).listen(0);
  const previousLasso = process.env.NET_lasso;
  process.env.NET_lasso = `127.0.0.1:${dataServer.address().port}`;
  clearReportEnvCache();
  const restoreSettings = runtimeFixture.installSettingsClient(SettingsClient);
  const skillServer = await createSkillService({
    name: 's13-report', skillId: 'report-skill', handler: createReportSkill({ graphManager: new GraphManager() }),
  }).listen(0);
  try {
    const response = await postSkill(skillServer.address().port, reportRequest());
    assert.equal(response.status, 200);
    assert.equal(response.body.type, 'SKILL_ACTION');
    assert.deepEqual(providerCalls.map((event) => event.service), ['settings', 'google-calendar', 'maps']);
  } finally {
    restoreSettings();
    await new Promise((resolve, reject) => skillServer.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => dataServer.close((error) => error ? reject(error) : resolve()));
    if (previousLasso === undefined) delete process.env.NET_lasso;
    else process.env.NET_lasso = previousLasso;
    clearReportEnvCache();
  }
});

test('S-13 fixture can enforce an immutable complete-file hash', () => {
  const { file } = fixtureFile();
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(readS13Fixture(file, { expectedFileSha256: digest }).metadata.sha256, digest);
  assert.throws(() => readS13Fixture(file, { expectedFileSha256: '0'.repeat(64) }), /fixture SHA-256 mismatch/);
});
