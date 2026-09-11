// The locally synthesized report-skill settings view must carry the presentation fields the
// mobile client binds onto each row. The original Settings service returned the report-skill
// manifest's `settings.view` -- every node carries `index` plus a human `title` and, where
// authored, `subtitle`/`icon`. The Android client dereferences `icon` unguarded
// (ViewHolders.OauthViewHolder.invalidateView -> Items.OauthItem.getIcon().contains(...)), so a
// bare {type,valueDefinition} row crashed the settings screen with
// `NullPointerException: Attempt to invoke virtual method 'boolean
// java.lang.String.contains(java.lang.CharSequence)' on a null object reference`.
//
// Values are pinned to the authoritative manifest:
//   archive repo jiboV2/pegasus, packages/hub/pegasus-skills/report_skill_manifest.json
//   sha256 6a492c450ae85434f341e352b3e29c62c005150a79ac787896a46add622824fc
// and the Settings service example in
//   /confluence/display/SDK/Mobile-Settings-Lasso+support+for+Personal+Report+credentials

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Store } = await import('../src/store.js');
const { createSettingsProviders } = await import('../src/settingsProviders.js');

function context(id, transactionId = `tx-${id}`) {
  return { loopId: `loop-${id}`, userId: 'account-1', transactionId };
}

// A representative slice of the stored report-skill data: person switches, the four calendar
// oauth rows (keyed service:account:scope, presence signalled by credentialExists), the
// keys the manifest authors without a title, and one unknown key for the total-fallback path.
const STORED_DATA = {
  weatherEnabled: { value: 1 },
  weather: { value: 0 },
  homeLocation: { lat: null, lng: null },
  commuteEnabled: { value: 0 },
  commuteTime: { hour: 9, min: 0 },
  calendarEnabled: { value: 0 },
  'google:personalCalendar:readonly': { credentialExists: false },
  'outlook:personalCalendar:readonly': { credentialExists: false },
  'google:workCalendar:readonly': { credentialExists: false },
  'outlook:workCalendar:readonly': { credentialExists: true },
  newsEnabled: { value: 1 },
  newsTechnology: { value: 1 },
  notAReportKey: { value: 1 },
};

function buildProviders() {
  const dir = mkdtempSync(join(tmpdir(), 'phx-report-view-'));
  const store = new Store(join(dir, 'store.json'));
  store.accounts.set('robot-account', { _id: 'robot-account', friendlyId: 'robot-local' });
  store.loops.set('loop-local', { _id: 'loop-local', robot: 'robot-account' });
  store.settings.set('account-1', { _id: 'account-1', data: STORED_DATA });
  return { dir, providers: createSettingsProviders({ store, env: {} }) };
}

async function localChildViews() {
  const { dir, providers } = buildProviders();
  try {
    const configs = await providers.hub.getSkillConfigs(context('local'));
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, 'report-skill');
    return { view: configs[0].settings.view, childViews: configs[0].settings.view.childViews };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('local view carries the manifest skill header (title/subtitle/icon/index)', async () => {
  const { view } = await localChildViews();
  assert.equal(view.type, 'group');
  assert.equal(view.index, 0);
  assert.equal(view.title, 'Personal report');
  assert.equal(view.subtitle, 'Add your commute, calendar and news');
  assert.equal(view.icon, 'personal_report_icon');
});

test('every synthesized row carries an index equal to its position (no zeroed indices)', async () => {
  const { childViews } = await localChildViews();
  assert.ok(childViews.length > 0);
  childViews.forEach((row, i) => {
    assert.equal(row.index, i, `row ${i} (${row.valueDefinition.key}) must carry index ${i}`);
  });
  // Guard the original defect directly: no row may lack the index field.
  for (const row of childViews) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'index'), `${row.valueDefinition.key} missing index`);
  }
});

test('person switch rows carry the manifest title/subtitle', async () => {
  const { childViews } = await localChildViews();
  const byKey = Object.fromEntries(childViews.map((r) => [r.valueDefinition.key, r]));

  assert.equal(byKey.weatherEnabled.title, 'Weather');
  assert.equal(byKey.weatherEnabled.subtitle, 'Change temperature units');
  assert.equal(byKey.commuteEnabled.title, 'Commute');
  assert.equal(byKey.calendarEnabled.title, 'Calendars');
  assert.equal(byKey.newsEnabled.title, 'News');
  assert.equal(byKey.newsTechnology.title, 'Technology');

  // Keys the manifest authors without a title must not gain an invented one.
  assert.equal(byKey.weather.title, undefined);
  assert.equal(byKey.homeLocation.title, undefined);
  assert.equal(byKey.commuteTime.title, undefined);
});

test('offerProactively keeps its manifest title and declared default', async () => {
  const { childViews } = await localChildViews();
  const row = childViews.find((r) => r.valueDefinition.key === 'offerProactively');
  assert.ok(row, 'offerProactively row present');
  assert.equal(row.title, 'Offer report proactively');
  assert.equal(row.subtitle, 'Jibo offers your Personal Report when he sees you');
  assert.equal(row.valueDefinition.default, true);
  assert.equal(row.valueDefinition.target, 'person');
});

test('the four calendar oauth rows carry google/outlook titles and matching icons', async () => {
  const { childViews } = await localChildViews();
  const oauthRows = childViews.filter((r) => r.type === 'oauth');
  assert.equal(oauthRows.length, 4, 'four oauth rows emitted');

  const expected = {
    'google:personalCalendar:readonly': { title: 'Google Calendar', icon: 'googleCalendarIcon' },
    'outlook:personalCalendar:readonly': { title: 'Outlook Calendar', icon: 'outlookCalendarIcon' },
    'google:workCalendar:readonly': { title: 'Google Calendar', icon: 'googleCalendarIcon' },
    'outlook:workCalendar:readonly': { title: 'Outlook Calendar', icon: 'outlookCalendarIcon' },
  };

  for (const row of oauthRows) {
    const key = row.valueDefinition.key;
    const want = expected[key];
    assert.ok(want, `unexpected oauth key ${key}`);
    assert.equal(row.type, 'oauth');
    assert.equal(row.valueDefinition.target, 'lasso');
    assert.equal(row.title, want.title);
    assert.equal(row.icon, want.icon);
    assert.ok(typeof row.icon === 'string' && row.icon.length > 0, `${key} icon must be a non-empty string`);
    // The OauthViewHolder selects its asset with getIcon().contains(...) -- the substring must
    // be present or the row renders the wrong (or no) icon.
    assert.ok(row.icon.includes('google') || row.icon.includes('outlook'), `${key} icon must contain google|outlook`);
    assert.ok(row.oauthParams, `${key} keeps oauthParams`);
    assert.equal(row.oauthParams.serviceName, key.split(':')[0]);
  }
});

test('the client can render every row without a null icon/title dereference', async () => {
  const { childViews } = await localChildViews();
  // Mirrors the exact Android call site that crashed: for oauth rows the icon is dereferenced
  // with .contains(). Simulate the client's null-invocation so a regression fails here first.
  for (const row of childViews) {
    const icon = row.icon === undefined ? null : row.icon;
    if (row.type === 'oauth') {
      assert.doesNotThrow(() => {
        if (icon === null || icon === undefined) {
          throw new TypeError("Cannot invoke \"String.contains(CharSequence)\" because \"icon\" is null");
        }
        return icon.includes('google') || icon.includes('outlook');
      }, `oauth row ${row.valueDefinition.key} would NPE in OauthViewHolder`);
    }
  }
});
