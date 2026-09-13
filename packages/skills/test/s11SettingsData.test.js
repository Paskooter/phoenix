// S-11 — settings/commute data boundaries against the pinned Pegasus source.
// Source: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/report-skill/src/SettingsClient.ts
//   packages/report-skill/src/subskills/commute/{CommuteData,CommuteFactory}.ts
//   packages/report-skill/tests/{SettingsClient,subskills/Commute}.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsClient } from '../src/report/settingsClient.js';
import { commuteParse, getData, CommuteFactory } from '../src/report/commute.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { Names } from '../src/report/utils.js';
import { GraphManager } from '../src/graph/graphManager.js';

const SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';

function settingsFixture() {
  return {
    weatherEnabled: { value: true },
    weather: { value: 0 },
    newsEnabled: { value: true },
    newsNational: { value: false },
    newsBusiness: { value: false },
    newsEntertainment: { value: false },
    newsInternational: { value: false },
    newsSports: { value: false },
    newsHealth: { value: false },
    newsPolitics: { value: false },
    newsScience: { value: false },
    newsTechnology: { value: false },
    newsStrange: { value: true },
    homeLocation: { lat: 42.3601, lng: -71.0589 },
    workLocation: { lat: 42.3727, lng: -71.1229 },
    commuteEnabled: { value: true },
    commuteType: { value: 0 },
    commuteTime: { hour: 10, min: 0 },
    calendarEnabled: { value: true },
    'google:personalCalendar:readonly': { credentialExists: false },
    'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false },
    'outlook:workCalendar:readonly': { credentialExists: false },
  };
}

function adultData({ accountId = 'account-1', loopId = 'loop-1', transId = 'trans-1', log } = {}) {
  return {
    runtime: {
      perception: { speaker: 'speaker-1' },
      loop: {
        loopId,
        users: [{ id: 'speaker-1', accountId, birthdate: '1990-01-01' }],
      },
      location: { iso: '2026-09-13T12:00:00.000Z' },
    },
    req: { jibo: transId === undefined ? {} : { transID: transId } },
    log: log || { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function withPatched(object, property, replacement, callback) {
  const original = object[property];
  object[property] = replacement;
  try {
    return await callback();
  } finally {
    object[property] = original;
  }
}

test('S11/source pin is explicit for settings and commute boundary coverage', () => {
  assert.equal(SOURCE_REVISION, '5c0a7390539663ba749d360de348a428c088505c');
});

test('S11/commute.complete: every archived missing-field case is incomplete', () => {
  const missing = [
    ['mode', (settings) => { settings.commuteType = undefined; }],
    ['origin.lat', (settings) => { settings.homeLocation.lat = undefined; }],
    ['origin.lng', (settings) => { settings.homeLocation.lng = undefined; }],
    ['destination.lat', (settings) => { settings.workLocation.lat = undefined; }],
    ['destination.lng', (settings) => { settings.workLocation.lng = undefined; }],
    ['workTime.hour', (settings) => { settings.commuteTime.hour = undefined; }],
    ['workTime.min', (settings) => { settings.commuteTime.min = undefined; }],
  ];

  for (const [label, removeField] of missing) {
    const settings = settingsFixture();
    removeField(settings);
    const prefs = SettingsClient.convertSettingsToPrefs(settings);
    assert.equal(prefs.commute.complete, false, label);
    assert.equal(
      label === 'mode' ? prefs.commute.mode
        : label === 'origin.lat' ? prefs.commute.origin.lat
          : label === 'origin.lng' ? prefs.commute.origin.lng
            : label === 'destination.lat' ? prefs.commute.destination.lat
              : label === 'destination.lng' ? prefs.commute.destination.lng
                : label === 'workTime.hour' ? prefs.commute.workTime.hour
                  : prefs.commute.workTime.min,
      undefined,
      label,
    );
  }
});

test('S11/settings: commute mode uses the source enum order and leaves invalid values undefined', () => {
  for (const [value, mode] of ['driving', 'transit', 'bicycling', 'walking'].entries()) {
    const settings = settingsFixture();
    settings.commuteType.value = value;
    const prefs = SettingsClient.convertSettingsToPrefs(settings);
    assert.equal(prefs.commute.mode, mode, `mode ${value}`);
    assert.equal(prefs.commute.complete, true, `complete mode ${value}`);
  }

  for (const value of [-1, 4, 99, 1.5, Number.NaN, 'invalid', null]) {
    const settings = settingsFixture();
    settings.commuteType.value = value;
    const prefs = SettingsClient.convertSettingsToPrefs(settings);
    assert.equal(prefs.commute.mode, undefined, `invalid commuteType ${String(value)}`);
    assert.equal(prefs.commute.complete, false, `invalid commuteType ${String(value)}`);
  }
});

test('S11/settings: completeness checks presence only, including zero and out-of-range values', () => {
  const settings = settingsFixture();
  settings.commuteEnabled.value = 0;
  settings.commuteType.value = 0;
  settings.commuteTime.hour = 0;
  settings.commuteTime.min = 0;
  settings.homeLocation.lat = 0;
  settings.homeLocation.lng = 0;
  settings.workLocation.lat = 999;
  settings.workLocation.lng = -999;

  const prefs = SettingsClient.convertSettingsToPrefs(settings);
  assert.equal(prefs.commute.active, false);
  assert.equal(prefs.commute.mode, 'driving');
  assert.equal(prefs.commute.complete, true);
  assert.deepEqual(prefs.commute.workTime, { hour: 0, min: 0 });
  assert.deepEqual(prefs.commute.origin, { lat: 0, lng: 0 });
  assert.deepEqual(prefs.commute.destination, { lat: 999, lng: -999 });
});

test('S11/settings: malformed settings preserve the source partial preference shape', () => {
  assert.throws(() => SettingsClient.convertSettingsToPrefs(null), { message: 'No settings provided' });
  assert.throws(() => SettingsClient.convertSettingsToPrefs(undefined), { message: 'No settings provided' });

  const prefs = SettingsClient.convertSettingsToPrefs({ something: 'bad' });
  assert.equal(prefs.weather.active, false);
  assert.equal(prefs.weather.useCelsius, false);
  assert.equal(prefs.calendar.active, false);
  assert.equal(prefs.commute.active, false);
  assert.equal(prefs.commute.mode, undefined);
  assert.equal(prefs.commute.complete, false);
  assert.equal(prefs.commute.workTime.hour, undefined);
  assert.equal(prefs.commute.origin.lat, undefined);
  assert.equal(prefs.news.active, false);
  assert.deepEqual(prefs.news.activeNewsCategories, {
    technology: false, sports: false, business: false, science: false,
    entertainment: false, strange: false, health: false, international: false,
    national: false, politics: false,
  });
});

test('S11/settings: default paths bypass the settings request for missing or child speakers', async () => {
  let requests = 0;
  await withPatched(SettingsClient, 'getSettings', async () => {
    requests += 1;
    throw new Error('default path unexpectedly requested settings');
  }, async () => {
    const noSpeaker = await SettingsClient.getUserPrefs({ log: { info() {} } });
    assert.deepEqual(noSpeaker, SettingsClient.getDefaultPrefs());

    const child = adultData();
    child.runtime.loop.users[0].birthdate = '2018-01-01';
    const childPrefs = await SettingsClient.getUserPrefs(child, 'speaker-1');
    assert.deepEqual(childPrefs, SettingsClient.getDefaultPrefs());

    const notInLoop = await SettingsClient.getUserPrefs(adultData(), 'notInLoop');
    assert.deepEqual(notInLoop, SettingsClient.getDefaultPrefs());
  });
  assert.equal(requests, 0);
});

test('S11/settings: adult request passes account, loop, and req.jibo.transID into GetSettings', async () => {
  let args;
  const expected = SettingsClient.convertSettingsToPrefs(settingsFixture());
  await withPatched(SettingsClient, 'getSettings', async (...received) => {
    args = received;
    return [{ skillId: 'report-skill', data: settingsFixture() }];
  }, async () => {
    const prefs = await SettingsClient.getUserPrefs(adultData({
      accountId: 'acct-from-loop', loopId: 'loop-from-runtime', transId: 'trans-from-jibo',
    }), 'speaker-1');
    assert.deepEqual(prefs, expected);
  });
  assert.deepEqual(args, ['acct-from-loop', 'loop-from-runtime', 'trans-from-jibo']);
});

test('S11/settings: missing credentials, missing report data, and null settings retain source errors', async () => {
  await assert.rejects(
    SettingsClient.getSettings(null, 'loop-1', 'trans-1'),
    { message: 'Missing creds for Settings request. Got accountID: false | loopID: true' },
  );
  await assert.rejects(
    SettingsClient.getSettings('account-1', null, 'trans-1'),
    { message: 'Missing creds for Settings request. Got accountID: true | loopID: false' },
  );
  await assert.rejects(
    SettingsClient.getSettings('no-auth-provided', 'loop-1', 'trans-1'),
    { message: 'Missing creds for Settings request. Got accountID: true | loopID: true' },
  );

  await withPatched(SettingsClient, 'getSettings', async () => null, async () => {
    await assert.rejects(
      SettingsClient.getUserPrefs(adultData(), 'speaker-1'),
      { message: 'Error converting settings data into prefs: No settings provided' },
    );
  });
});

test('S11/CommuteFactory: graph has the source nodes and Done exit', () => {
  const gm = new GraphManager();
  const graph = new CommuteFactory().createGraph(gm);
  assert.equal(graph.name, 'Commute');
  assert.equal(graph.isFinalized(), true);
  assert.equal(graph.initial.name, 'Commute Mim Logic');
  assert.equal(graph.nodes.size, 2);
  assert.deepEqual([...graph.nodes].map((node) => node.name), ['Commute Mim Logic', 'Commute Outro']);
  assert.deepEqual([...graph.exitTransitions.keys()], ['Done']);
  assert.equal(gm.getNode(graph.initial.id), graph.initial);
});

test('S11/CommuteData: incomplete preferences return empty fields without requesting Maps', async () => {
  let requests = 0;
  const result = await withPatched(LassoClient, 'fetchGoogleMaps', async () => {
    requests += 1;
    return { shouldNot: 'be requested' };
  }, () => getData(
    { commute: { complete: false, marker: 'incomplete' } },
    { log: { warn() {} } },
  ));

  assert.equal(requests, 0);
  assert.deepEqual(result, [Names.commute, { status: null, geocoded_waypoints: null, routes: null }]);
});

test('S11/CommuteData: complete preferences request Maps once and preserve its payload', async () => {
  const commute = {
    complete: true,
    mode: 'walking',
    origin: { lat: 1, lng: 2 },
    destination: { lat: 3, lng: 4 },
  };
  const payload = { status: 'OK', routes: [{ legs: [] }] };
  const data = { log: {} };
  let requests = 0;
  let requestArgs;
  const result = await withPatched(LassoClient, 'fetchGoogleMaps', async (...args) => {
    requests += 1;
    requestArgs = args;
    return payload;
  }, () => getData({ commute }, data));

  assert.equal(requests, 1);
  assert.deepEqual(requestArgs, [data, commute]);
  assert.deepEqual(result, [Names.commute, payload]);
});

test('S11/CommuteData: Maps request failures return null data after the source catch', async () => {
  const result = await withPatched(LassoClient, 'fetchGoogleMaps', async () => {
    throw new Error('socket closed');
  }, () => getData(
    { commute: { complete: true } },
    { log: { error() {} } },
  ));

  assert.deepEqual(result, [Names.commute, null]);
});

test('S11/CommuteParse: malformed route containers return no prompt data', async () => {
  const malformedMaps = [
    undefined,
    null,
    {},
    { routes: undefined },
    { routes: null },
    { routes: [] },
    { routes: [undefined] },
    { routes: [null] },
    { routes: [{}] },
    { routes: [{ legs: undefined }] },
    { routes: [{ legs: null }] },
    { routes: [{ legs: [] }] },
    { routes: [{ legs: [undefined] }] },
    { routes: [{ legs: [null] }] },
  ];
  const userPrefs = {
    commute: { complete: true, mode: 'driving', workTime: { hour: 9, min: 0 } },
  };

  for (const mapsData of malformedMaps) {
    assert.equal(
      await commuteParse(mapsData, '2026-09-13T12:00:00.000Z', { userPrefs }),
      undefined,
      JSON.stringify(mapsData),
    );
  }
});
