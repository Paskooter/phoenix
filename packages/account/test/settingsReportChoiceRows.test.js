// Commute mode and temperature units are four-way / two-way choices in the
// original Jibo app, not on/off switches.
//
// The original report-skill manifest declares `commuteType` and `weather` as
// `choice` rows (0 Drive, 1 Public transport, 2 Bike, 3 Walk; 0 Fahrenheit,
// 1 Celsius). Phoenix synthesizes that view locally from stored data, and it
// used to declare both keys as `switch` rows. The source UpdateSettings
// validator then turned 0/1 into false/true and refused 2 and 3 ("must be in
// format {"value": boolean}"), so the original app could not pick Bike or
// Walk, and it drew an on/off switch instead of the choice list.
//
// This sends each mode through the internal source Settings listener exactly
// as the original app does (UpdateSettings, wire choice id in {value}), then
// checks the stored value and the row type GetSettings renders. The row
// layout is compared against the shipped original manifest file.
// Every account, loop and person here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSettingsInternalService, createSettingsProviders } from '../src/index.js';
import { Store } from '../src/store.js';
import { dataToFriendly, defaultSettingsData, friendlyToData, getSettingsData, setSettingsData } from '../src/settingsData.js';
import { useInternalPeerToken, internalPeerHeaders } from './fixtures/internalPeer.js';

useInternalPeerToken();

const ACCOUNT = 'choice-row-adult';
const LOOP = 'choice-row-loop';

// Wire choice id (manifest) -> what the console stores and shows.
const COMMUTE = [
  { wire: 0, label: 'Drive', stored: 0, mode: 'driving' },
  { wire: 1, label: 'Public transport', stored: 3, mode: 'transit' },
  { wire: 2, label: 'Bike', stored: 2, mode: 'bicycling' },
  { wire: 3, label: 'Walk', stored: 1, mode: 'walking' },
];

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../gateway/resources/skills/pegasus-skills/report_skill_manifest.json', import.meta.url,
)), 'utf8'));

function manifestNode(key, view = MANIFEST.settings.view) {
  if (view?.valueDefinition?.key === key && view.type !== 'location') return view;
  for (const child of view?.childViews || []) {
    const found = manifestNode(key, child);
    if (found) return found;
  }
  return null;
}

let dir; let store; let server; let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phx-report-choice-rows-'));
  store = new Store(join(dir, 'store.json'));
  store.accounts.set('choice-row-robot', { _id: 'choice-row-robot', friendlyId: 'choice-row-friendly' });
  store.accounts.set(ACCOUNT, { _id: ACCOUNT });
  store.loops.set(LOOP, {
    _id: LOOP,
    robot: 'choice-row-robot',
    members: [
      { _id: 'choice-row-member', accountId: ACCOUNT, status: 'accepted' },
    ],
  });
  setSettingsData(store, ACCOUNT, defaultSettingsData());
  store.flush();
  server = await createSettingsInternalService({
    store, settingsProviders: createSettingsProviders({ store, env: {} }),
  }).listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function call(operation, body, credentials = { id: ACCOUNT }) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-target': `Settings_20171219.${operation}`,
      ...(credentials ? { 'x-amz-credentials': JSON.stringify(credentials) } : {}),
      ...internalPeerHeaders(),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// The original app's UpdateSettings for one person row.
function update(key, value) {
  return call('UpdateSettings', {
    loopId: LOOP,
    transId: `choice-row-${key}-${value}`,
    data: { [key]: { skillId: 'report-skill', dataService: 'person', value: { value } } },
  });
}

async function renderedReport(body = { loopId: LOOP }, credentials) {
  const res = await call('GetSettings', body, credentials);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const report = res.body.find((item) => item.skillId === 'report-skill');
  assert.ok(report, 'GetSettings answers for the report skill');
  const rows = Object.fromEntries(report.view.childViews.map((row) => [row.valueDefinition.key, row]));
  return { rows, data: report.data };
}

function assertManifestChoiceRow(row, key) {
  const original = manifestNode(key);
  assert.equal(original.type, 'choice', `the original manifest declares ${key} as a choice row`);
  assert.equal(row.type, 'choice', `${key} renders as the original choice row, not a ${row.type}`);
  assert.deepEqual(row.choices, original.choices, `${key} offers exactly the original choices`);
  assert.deepEqual(row.valueDefinition, original.valueDefinition);
  assert.equal(row.title, original.title);
}

for (const choice of COMMUTE) {
  test(`original app picks "${choice.label}" (commuteType ${choice.wire}): stored as ${choice.mode}, row stays a 4-way choice`, async () => {
    const res = await update('commuteType', choice.wire);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.errors, undefined, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.commuteType, {
      skillId: 'report-skill', dataService: 'person', value: { value: choice.wire },
    }, 'the reply echoes the wire choice id, not a boolean');

    const stored = getSettingsData(store, ACCOUNT).commuteType;
    assert.deepEqual(stored, { value: choice.stored }, 'stored in the console numbering');
    assert.equal(dataToFriendly(getSettingsData(store, ACCOUNT)).commute.mode, choice.mode, 'the console shows the same mode');

    const { rows, data } = await renderedReport();
    assertManifestChoiceRow(rows.commuteType, 'commuteType');
    assert.deepEqual(data.commuteType, { value: choice.wire }, 'GetSettings reads back the chosen id');
    assert.ok(rows.commuteType.choices.some((item) => item.id === data.commuteType.value),
      'the stored value selects one of the rendered choices');
  });
}

for (const [wire, celsius] of [[1, true], [0, false]]) {
  test(`original app picks ${celsius ? 'Celsius' : 'Fahrenheit'} (weather ${wire}): stored as a number, row is the units choice`, async () => {
    const res = await update('weather', wire);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.weather.value, { value: wire });
    assert.deepEqual(getSettingsData(store, ACCOUNT).weather, { value: wire }, 'stored as the choice id, as the console writes it');
    assert.equal(dataToFriendly(getSettingsData(store, ACCOUNT)).weather.celsius, celsius);

    const { rows, data } = await renderedReport();
    assertManifestChoiceRow(rows.weather, 'weather');
    assert.deepEqual(data.weather, { value: wire });
  });
}

test('on/off rows stay switches with their original titles', async () => {
  const { rows } = await renderedReport();
  for (const key of ['offerProactively', 'weatherEnabled', 'commuteEnabled', 'calendarEnabled', 'newsEnabled']) {
    assert.equal(rows[key].type, 'switch', key);
    assert.equal(rows[key].title, manifestNode(key).title, key);
  }
  const res = await update('commuteEnabled', 1);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.commuteEnabled.value, { value: true }, 'switches keep the source boolean coercion');
});

test('a mode and unit saved in the console select the matching original choice', async () => {
  for (const choice of COMMUTE) {
    setSettingsData(store, ACCOUNT, friendlyToData({ commute: { mode: choice.mode } }, getSettingsData(store, ACCOUNT)));
    const { rows, data } = await renderedReport();
    assert.deepEqual(data.commuteType, { value: choice.wire }, `console ${choice.mode} reads back as wire ${choice.wire}`);
    const picked = rows.commuteType.choices.find((item) => item.id === data.commuteType.value);
    assert.equal(picked?.value, choice.label, `the original app highlights ${choice.label}`);
  }
  for (const [celsius, label] of [[true, 'Celsius'], [false, 'Fahrenheit']]) {
    setSettingsData(store, ACCOUNT, friendlyToData({ weather: { celsius } }, getSettingsData(store, ACCOUNT)));
    const { rows, data } = await renderedReport();
    const picked = rows.weather.choices.find((item) => item.id === data.weather.value);
    assert.equal(picked?.value, label, `console ${label} selects the ${label} choice`);
  }
});
