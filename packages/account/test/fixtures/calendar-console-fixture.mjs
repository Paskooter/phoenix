// A disposable Account service with invented calendars for exercising the
// console's Calendar section in a real browser.
//
// Everything is local: subscription "fetches" are answered from the iCal text
// below by an injected fetcher, every peer service points at a closed port,
// and the store lives in a throwaway directory. Nothing here reads a real
// calendar, a robot or another host.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The browser's frozen "now": noon on Wednesday 14 October 2026 in Los Angeles. */
export const FIXTURE_NOW = '2026-10-14T19:00:00.000Z';
export const FIXTURE_TIME_ZONE = 'America/Los_Angeles';
export const FIXTURE_DEVICE_TIME_ZONE = 'America/New_York';

const HOST = 'https://calendar.example.test';
export const FEEDS = Object.freeze({
  family: `${HOST}/family/basic.ics`,
  work: `${HOST}/feeds/3f1c2a9b8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211/work-basic.ics?token=synthetic`,
  school: `${HOST}/school/missing.ics`,
  holidays: `${HOST}/holidays/basic.ics`,
  paused: `${HOST}/old-team/basic.ics`,
  added: `${HOST}/added/basic.ics`,
});

const vevent = (fields) => ['BEGIN:VEVENT', ...fields, 'END:VEVENT'];
const timed = (uid, day, start, end, summary, extra = []) => vevent([
  `UID:${uid}`,
  `DTSTART;TZID=America/Los_Angeles:${day}T${start}00`,
  `DTEND;TZID=America/Los_Angeles:${day}T${end}00`,
  `SUMMARY:${summary}`,
  ...extra,
]);
const allDay = (uid, first, afterLast, summary, extra = []) => vevent([
  `UID:${uid}`,
  `DTSTART;VALUE=DATE:${first}`,
  `DTEND;VALUE=DATE:${afterLast}`,
  `SUMMARY:${summary}`,
  ...extra,
]);
const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Phoenix console fixture//EN',
  ...events.flat(), 'END:VCALENDAR'].join('\r\n');

export const LONG_TITLE = 'Quarterly planning workshop with the extended product, design and engineering group (bring laptops)';

const ICS = {
  [FEEDS.family]: calendar(
    timed('parent-night', '20260928', '1800', '1900', 'Parent night'),
    vevent(['UID:piano', 'DTSTART;TZID=America/Los_Angeles:20261001T160000',
      'DTEND;TZID=America/Los_Angeles:20261001T164500', 'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=9',
      'SUMMARY:Piano lesson', 'LOCATION:Music school']),
    allDay('birthday', '20261003', '20261004', 'Grandma’s birthday'),
    timed('dentist', '20261014', '1000', '1045', 'Dentist'),
    vevent(['UID:pickup', 'DTSTART;TZID=America/Los_Angeles:20261014T150000',
      'DTEND;TZID=America/Los_Angeles:20261014T153000', 'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4',
      'SUMMARY:School pickup']),
    allDay('camping', '20261016', '20261019', 'Fall camping trip', ['LOCATION:Big Basin Redwoods']),
    timed('gym', '20261021', '0700', '0800', 'Gym'),
    timed('drop-off', '20261021', '0815', '0845', 'School drop-off'),
    timed('plumber', '20261021', '0900', '1200', 'Plumber visit (arrival window)'),
    timed('bank', '20261021', '1030', '1100', 'Call with the bank'),
    timed('lunch', '20261021', '1200', '1300', 'Lunch with Sam'),
    timed('soccer', '20261021', '1730', '1830', 'Soccer practice', ['LOCATION:Field 3']),
    timed('book-club', '20261021', '1900', '2100', 'Book club: The Remarkable and Surprisingly Long Story of Everything'),
    timed('workshop', '20261022', '1300', '1600', LONG_TITLE),
    // Google-style export: a timed event written in UTC. 17:00Z is 10:00 in Los Angeles.
    vevent(['UID:grandpa', 'DTSTART:20261023T170000Z', 'DTEND:20261023T180000Z', 'SUMMARY:Video call with Grandpa']),
    vevent(['UID:movie', 'DTSTART;TZID=America/Los_Angeles:20261024T220000',
      'DTEND;TZID=America/Los_Angeles:20261025T013000', 'SUMMARY:Late movie night']),
    timed('halloween', '20261031', '1800', '2100', 'Halloween party', ['LOCATION:Maple Street']),
    allDay('teacher-day', '20261105', '20261106', 'Teacher conference day'),
    timed('thanksgiving', '20261126', '1600', '2000', 'Thanksgiving dinner'),
  ),
  [FEEDS.work]: calendar(
    // Written in New York time: 9:00 there is 6:00 in Los Angeles.
    vevent(['UID:standup', 'DTSTART;TZID=America/New_York:20261005T090000',
      'DTEND;TZID=America/New_York:20261005T091500', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24',
      'SUMMARY:Team standup']),
    vevent(['UID:conference', 'DTSTART;TZID=America/Los_Angeles:20261019T090000',
      'DTEND;TZID=America/Los_Angeles:20261020T170000', 'SUMMARY:Design conference', 'LOCATION:Seattle']),
    timed('sprint-review', '20261021', '0930', '1000', 'Sprint review'),
    allDay('offsite', '20261027', '20261030', 'Company offsite'),
  ),
  [FEEDS.holidays]: calendar(
    allDay('columbus', '20261012', '20261013', 'Indigenous Peoples’ Day'),
    allDay('veterans', '20261111', '20261112', 'Veterans Day'),
  ),
  [FEEDS.paused]: calendar(timed('paused-event', '20261015', '1100', '1200', 'Old team retro')),
  [FEEDS.added]: calendar(timed('added-event', '20261020', '1800', '1900', 'Neighbourhood meeting')),
};

const FAILURES = {
  [FEEDS.work]: 'calendar fetch timed out',
  [FEEDS.school]: 'calendar fetch returned HTTP 404',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW = { start: Date.parse('2026-08-01T00:00:00Z'), end: Date.parse('2027-03-01T00:00:00Z') };

/**
 * scenario:
 *   'busy'       five calendars: verified, using saved events, failing, not checked, paused
 *   'empty'      no calendars yet
 *   'unverified' calendars exist but none has verified
 */
export async function startCalendarConsole({ scenario = 'busy', timeZone = FIXTURE_TIME_ZONE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-calendar-console-'));
  process.env.PHOENIX_ENV_FILE = '/dev/null';
  process.env.PHOENIX_DATA_DIR = dir;
  process.env.ETCO_account_secureCookies = 'false';
  process.env.ETCO_account_internalPeerToken = 'calendar-console-fixture-peer-token';
  const { DefaultPort } = await import('../../../contracts/src/index.js');
  for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
  const { createAccountService, Store } = await import('../../src/index.js');
  const { createOwnerAccount } = await import('../../src/model.js');
  const { markEmailVerified } = await import('../../src/emailVerification.js');
  const { createSession } = await import('../../src/sessions.js');
  const { defaultSettingsData, setSettingsData } = await import('../../src/settingsData.js');
  const { validateIcalUrl } = await import('../../src/icalSubscriptions.js');
  const { ical } = await import('../../../common/src/index.js');

  const parse = (url, zone) => ical.parseICalendar(ICS[url], {
    timeZone: zone, windowStart: WINDOW.start, windowEnd: WINDOW.end, maxOccurrences: 2000,
  });
  const fetches = [];
  const calendarFetcher = async (url, { timeZone: zone = 'UTC' } = {}) => {
    fetches.push(url);
    validateIcalUrl(url);
    if (FAILURES[url]) throw new Error(FAILURES[url]);
    if (!ICS[url]) throw new Error('calendar fetch returned HTTP 404');
    return { events: parse(url, zone) };
  };

  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'calendar-owner@example.invalid', password: 'Synthetic-password-1', firstName: 'Fixture',
  });
  markEmailVerified(owner);
  // Checked three hours before the browser's frozen "now", so the dates shown
  // never depend on when the test runs.
  const fixtureNow = Date.parse(FIXTURE_NOW);
  const now = fixtureNow - 3 * 60 * 60 * 1000;
  const verified = (url, extra = {}) => {
    const events = parse(url, timeZone);
    return {
      events, checkedTimeZone: timeZone,
      verification: { status: 'ok', eventCount: events.length, lastChecked: now, lastSuccess: now, lastError: null, ...extra },
    };
  };
  const all = {
    family: { id: 'cal-family', label: 'Family', url: FEEDS.family, enabled: true, ...verified(FEEDS.family) },
    work: {
      id: 'cal-work', label: 'Work', url: FEEDS.work, enabled: true,
      ...verified(FEEDS.work, { lastSuccess: now - 2 * DAY_MS, lastError: FAILURES[FEEDS.work] }),
    },
    school: {
      id: 'cal-school', label: 'School', url: FEEDS.school, enabled: true, events: [], checkedTimeZone: timeZone,
      verification: { status: 'invalid', eventCount: 0, lastChecked: now, lastSuccess: null, lastError: FAILURES[FEEDS.school] },
    },
    holidays: {
      id: 'cal-holidays', label: 'Holidays', url: FEEDS.holidays, enabled: true, events: [], checkedTimeZone: timeZone,
      verification: { status: 'unknown', eventCount: 0, lastChecked: now, lastSuccess: null, lastError: null },
    },
    paused: { id: 'cal-paused', label: 'Old team calendar', url: FEEDS.paused, enabled: false, ...verified(FEEDS.paused) },
  };
  const subscriptions = scenario === 'empty' ? []
    : scenario === 'unverified' ? [all.school, all.holidays]
      : [all.family, all.work, all.school, all.holidays, all.paused];
  setSettingsData(store, owner._id, {
    ...defaultSettingsData(),
    calendarEnabled: { value: 1 },
    calendarTimeZone: { value: timeZone },
    icalSubscriptions: { subscriptions },
  });
  const session = createSession(store, { kind: 'user', accountId: owner._id });
  store.flush();

  // The refresh service reads the same frozen clock and never schedules a
  // sweep, so a background refresh cannot change a calendar's state mid-test.
  const server = await createAccountService({
    store, smtp: null, calendarFetcher,
    calendarRefreshOptions: { now: () => fixtureNow, setIntervalFn: () => null, clearIntervalFn: () => {} },
  }).listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    store,
    accountId: owner._id,
    fetches,
    cookie: { name: 'phx_session', value: session._id, url },
    async close() {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
