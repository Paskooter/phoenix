import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createAccountService } from '../src/index.js';
import { IcalRefreshService, ICAL_REFRESH_INTERVAL_MS } from '../src/icalRefresh.js';
import { listSubscriptions, saveSubscriptions } from '../src/icalSubscriptions.js';
import { friendlyToData, getSettingsData, setSettingsData } from '../src/settingsData.js';

const DAY = ICAL_REFRESH_INTERVAL_MS;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-ical-refresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'account.json');
  const store = new Store(file);
  store.accounts.set('alice', { _id: 'alice', email: 'alice@example.test', isActive: true });
  store.flush();
  return { store, file };
}

function subscription(now, overrides = {}) {
  return {
    id: 'family', label: 'Family', url: 'https://calendar.example.test/family.ics',
    enabled: true, checkedTimeZone: 'UTC',
    verification: {
      status: 'ok', eventCount: 1, lastChecked: now - DAY - 1,
      lastSuccess: now - DAY - 1, lastError: null,
    },
    events: [{ summary: 'Old event', start: { timestamp: now + 1000 }, end: { timestamp: now + 2000 } }],
    ...overrides,
  };
}

test('daily iCal refresh replaces events, resumes from persisted last check, and stops after removal', async (t) => {
  const { store, file } = fixture(t);
  let now = Date.UTC(2026, 8, 29);
  let calls = 0;
  let timerClears = 0;
  let tick;
  saveSubscriptions(store, 'alice', [subscription(now)]);
  const worker = new IcalRefreshService(store, {
    now: () => now,
    fetcher: async () => ({ events: [{ summary: `New event ${++calls}` }] }),
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => { timerClears += 1; },
  });
  await worker.start();
  assert.equal(calls, 1);
  assert.equal(listSubscriptions(store, 'alice')[0].events[0].summary, 'New event 1');
  assert.equal(listSubscriptions(store, 'alice')[0].verification.lastChecked, now);
  assert.ok(worker.timer);

  // Restarting the Account process reuses the checkpoint rather than fetching
  // every calendar on every boot.
  worker.stop();
  const reopened = new Store(file);
  const resumed = new IcalRefreshService(reopened, {
    now: () => now,
    fetcher: async () => ({ events: [{ summary: `New event ${++calls}` }] }),
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => { timerClears += 1; },
  });
  await resumed.start();
  assert.equal(calls, 1);
  now += DAY - 1;
  await resumed.refreshDue();
  assert.equal(calls, 1);
  now += 1;
  tick();
  await resumed.running;
  assert.equal(calls, 2);
  saveSubscriptions(reopened, 'alice', []);
  resumed.changed();
  assert.equal(resumed.timer, null);
  now += DAY * 2;
  await resumed.refreshDue();
  assert.equal(calls, 2);
  assert.ok(timerClears >= 2);
  resumed.stop();
});

test('a failed background refresh keeps last good events, then a successful refresh removes cancelled events', async (t) => {
  const { store } = fixture(t);
  let now = Date.UTC(2026, 8, 29);
  let fail = true;
  saveSubscriptions(store, 'alice', [subscription(now)]);
  const worker = new IcalRefreshService(store, {
    now: () => now,
    fetcher: async () => {
      if (fail) throw new Error('https://calendar.example.test/private-token is unavailable');
      return { events: [] };
    },
  });
  const first = await worker.refreshDue();
  assert.deepEqual(first, { refreshed: 1, failed: 1 });
  const saved = listSubscriptions(store, 'alice')[0];
  assert.equal(saved.verification.status, 'ok');
  assert.equal(saved.verification.lastSuccess, now - DAY - 1);
  assert.equal(saved.events[0].summary, 'Old event');
  assert.doesNotMatch(saved.verification.lastError, /private-token/);
  now += DAY;
  fail = false;
  const second = await worker.refreshDue();
  assert.deepEqual(second, { refreshed: 1, failed: 0 });
  assert.deepEqual(listSubscriptions(store, 'alice')[0].events, []);
  assert.equal(listSubscriptions(store, 'alice')[0].verification.lastError, null);
});

test('removing or disabling a calendar during an in-flight refresh prevents stale results being saved', async (t) => {
  const { store } = fixture(t);
  const now = Date.UTC(2026, 8, 29);
  let resolveFetch;
  const waiting = new Promise((resolve) => { resolveFetch = resolve; });
  saveSubscriptions(store, 'alice', [subscription(now)]);
  const worker = new IcalRefreshService(store, {
    now: () => now,
    fetcher: () => waiting,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  const running = worker.start();
  saveSubscriptions(store, 'alice', []);
  worker.changed();
  assert.equal(worker.timer, null);
  resolveFetch({ events: [{ summary: 'Must not return' }] });
  assert.deepEqual(await running, { refreshed: 0, failed: 0 });
  assert.deepEqual(listSubscriptions(store, 'alice'), []);
  worker.stop();

  saveSubscriptions(store, 'alice', [subscription(now, { enabled: false })]);
  let resumedCalls = 0;
  const paused = new IcalRefreshService(store, {
    now: () => now,
    fetcher: async () => { resumedCalls += 1; return { events: [] }; },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await paused.start();
  assert.equal(paused.timer, null);
  assert.equal(resumedCalls, 0);
  saveSubscriptions(store, 'alice', [subscription(now, { enabled: true })]);
  paused.changed();
  await paused.running;
  assert.equal(resumedCalls, 1, 're-enabling a stale subscription checks it immediately');
  paused.stop();
});

test('changing account timezone reparses a recently checked calendar', async (t) => {
  const { store } = fixture(t);
  const now = Date.UTC(2026, 8, 29);
  saveSubscriptions(store, 'alice', [subscription(now, {
    verification: { status: 'ok', eventCount: 1, lastChecked: now, lastSuccess: now, lastError: null },
  })]);
  const data = getSettingsData(store, 'alice');
  setSettingsData(store, 'alice', { ...data, calendarTimeZone: { value: 'America/New_York' } });
  let parsedZone;
  const worker = new IcalRefreshService(store, {
    now: () => now,
    fetcher: async (_url, options) => { parsedZone = options.timeZone; return { events: [] }; },
  });
  assert.deepEqual(await worker.refreshDue(), { refreshed: 1, failed: 0 });
  assert.equal(parsedZone, 'America/New_York');
  assert.equal(listSubscriptions(store, 'alice')[0].checkedTimeZone, 'America/New_York');
});

test('a failed timezone refresh waits a day before retrying, without discarding saved events', async (t) => {
  const { store } = fixture(t);
  let now = Date.UTC(2026, 8, 29);
  saveSubscriptions(store, 'alice', [subscription(now, {
    verification: { status: 'ok', eventCount: 1, lastChecked: now, lastSuccess: now, lastError: null },
  })]);
  setSettingsData(store, 'alice', {
    ...getSettingsData(store, 'alice'), calendarTimeZone: { value: 'America/Chicago' },
  });
  let calls = 0;
  const worker = new IcalRefreshService(store, {
    now: () => now,
    fetcher: async () => { calls += 1; throw new Error('temporarily unavailable'); },
  });
  await worker.refreshDue();
  assert.equal(calls, 1);
  assert.equal(listSubscriptions(store, 'alice')[0].checkedTimeZone, 'America/Chicago');
  assert.equal(listSubscriptions(store, 'alice')[0].events[0].summary, 'Old event');
  now += 60 * 60 * 1000;
  await worker.refreshDue();
  assert.equal(calls, 1);
  now += DAY;
  await worker.refreshDue();
  assert.equal(calls, 2);
});

test('Account listener starts iCal refresh and closing it stops the worker', async (t) => {
  const { store } = fixture(t);
  const now = Date.UTC(2026, 8, 29);
  saveSubscriptions(store, 'alice', [subscription(now)]);
  let calls = 0;
  const account = createAccountService({
    store,
    calendarFetcher: async () => { calls += 1; return { events: [] }; },
    calendarRefreshOptions: { now: () => now },
  });
  const server = await account.listen(0);
  t.after(() => { if (server.listening) server.close(); });
  await account.calendarRefresh.running;
  assert.equal(calls, 1);
  assert.ok(account.calendarRefresh.timer);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(account.calendarRefresh.timer, null);
});

test('removing a subscription during portal verification does not resurrect it', async (t) => {
  const { store } = fixture(t);
  let resolveFetch;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const account = createAccountService({
    store,
    calendarFetcher: () => {
      markStarted();
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const server = await account.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(`${base}/api/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'calendar-race@example.test', password: 'orbit-city-ical', firstName: 'Calendar' }),
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.get('set-cookie').split(';', 1)[0];
    const adding = fetch(`${base}/api/calendar/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ label: 'Soon removed', url: 'https://calendar.example.test/feed.ics' }),
    });
    await started;
    const accountId = store.accountByEmail('calendar-race@example.test')._id;
    const id = listSubscriptions(store, accountId)[0].id;
    const removing = await fetch(`${base}/api/calendar/subscriptions/${id}`, {
      method: 'DELETE', headers: { cookie },
    });
    assert.equal(removing.status, 200);
    resolveFetch({ events: [{ summary: 'Should not be saved' }] });
    assert.equal((await adding).status, 409);
    assert.deepEqual(listSubscriptions(store, accountId), []);
    assert.equal(account.calendarRefresh.timer, null);
  } finally {
    resolveFetch?.({ events: [] });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generic report settings cannot replace subscription URLs or cached events', () => {
  const existing = { subscriptions: [{ id: 'family', url: 'https://calendar.example.test/real.ics', events: [] }] };
  const updated = friendlyToData({ calendar: {
    active: true,
    icalSubscriptions: [{ id: 'injected', url: 'http://127.0.0.1/admin', events: [] }],
  } }, { icalSubscriptions: existing });
  assert.deepEqual(updated.icalSubscriptions, existing);
});
