// D-04 acceptance item 3 — report-skill -> Phoenix data -> provider-fixture integration.
//
// The real report path is driven against the REAL data service over HTTP:
//   reportCalendar.getData()  ->  LassoClient.fetchCalendarEvents()  ->  GET /v1/google_calendar
//   ->  createDataService (relay envelope + 60s cache)  ->  fixture provider
// and the events must arrive in the report's parsed structure. The FALSIFICATION
// anchor for this file is the envelope line in packages/data/src/calendar.js:
// break it (return the bare `{events}` pre-D-04 body) and D-04/i1 fails with
// `Incomplete Lasso data from: google calendar` — the exact failure D-04 removes.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const FIXED_NOW = Date.parse('2026-06-12T12:00:00-04:00');
const LOCATION_ISO = '2026-06-12T12:00:00-04:00';
const TZ = '-04:00';

process.env.NET_data = 'unset';
const { clearReportEnvCache } = await import('../src/report/env.js');
const { createDataService } = await import('../../data/src/index.js');
const { LassoClient } = await import('../src/report/lassoClient.js');
const { getData, calendarParse } = await import('../src/report/calendar.js');
const { Names } = await import('../src/report/utils.js');

const PORT = 7805;

// Fixture provider payloads: Google-shaped events, all after the frozen now.
// A 09:00 tomorrow, B 18:00 tomorrow (personal) and C 09:00 the day after (work).
const eventAt = (summary, dayOffset, hour) => ({
  summary,
  start: { dateTime: `${dayOffset}T${hour}:00:00${TZ}` },
  end: { dateTime: `${dayOffset}T${hour}:30:00${TZ}` },
});
const TOMORROW = '2026-06-13';
const DAY_AFTER = '2026-06-14';
// End of tomorrow in the location's timezone, in the form the report actually sends.
const END_OF_TOMORROW = '2026-06-14T03:59:59.999Z';
const WORK_EVENT = eventAt('Work standup', TOMORROW, '09');
const PERSONAL_EVENT_LATE = eventAt('Dinner with Sam', TOMORROW, '18');
const PERSONAL_EVENT_DAY_AFTER = eventAt('Dentist', DAY_AFTER, '09');

const providerRequests = [];
const errors = [];
let server;

const reportData = () => ({
  log: {
    debug() {}, info() {}, warn() {},
    error(...args) { errors.push(args.map(String).join(' ')); },
  },
  skill: { id: 'report-skill', session: { data: { _personalReport: { singleSkill: null } } } },
  local: { userPrefs: {} },
  runtime: {
    location: { iso: LOCATION_ISO },
    loop: { loopId: 'loop-1', users: [{ id: 'u1', name: 'Alice Smith', accountId: 'acct-1', birthdate: '1990-01-01' }] },
    perception: { speaker: 'u1' },
  },
  req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 't', 'x-jibo-robotid': 'r', 'x-jibo-logging-config': '{}' }) } },
});

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
  const googleProvider = async (req) => {
    providerRequests.push({ service: 'google', ...req });
    return {
      events: req.calendar === 'workCalendar'
        ? [WORK_EVENT]
        : [PERSONAL_EVENT_LATE, PERSONAL_EVENT_DAY_AFTER],
      calendarTimezone: 'America/New_York',
    };
  };
  const outlookAllDayProvider = async (req) => {
    providerRequests.push({ service: 'outlook', ...req });
    return {
      events: [{
        subject: 'Conference', isAllDay: true,
        start: { dateTime: '2026-06-13T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-06-14T00:00:00.0000000', timeZone: 'UTC' },
      }],
    };
  };
  server = await createDataService({
    googleCalendarProvider: googleProvider,
    outlookCalendarProvider: outlookAllDayProvider,
  }).listen(PORT);
  process.env.NET_data = `localhost:${PORT}`;
  clearReportEnvCache();
});
after(() => { server?.close?.(); delete process.env.NET_data; clearReportEnvCache(); mock.timers.reset(); });

test('D-04/i1 a provider returning events reaches the report through the real envelope', async () => {
  const data = reportData();
  const [name, events] = await getData({ calendar: { googlePersonalCreds: true, googleWorkCreds: true } }, data);

  assert.equal(name, Names.calendar);
  assert.ok(Array.isArray(events), 'the report received an events array, not a parse failure');
  assert.deepEqual(events.map((e) => e.summary), ['Work standup', 'Dinner with Sam', 'Dentist'],
    'personal + work merged and ordered by start.timestamp');
  assert.deepEqual(errors, [], 'the report logged no Lasso failure');

  // the report's endDate is the end of tomorrow in the location's timezone,
  // rendered by the report as UTC (the pinned source renders the same instant with
  // the location offset — see D-04/i3)
  const sent = providerRequests.filter((r) => r.calendar === 'personalCalendar');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endDate, END_OF_TOMORROW);
  assert.equal(new Date(sent[0].endDate).toISOString(), '2026-06-14T03:59:59.999Z');

  // and the report's own parse accepts them: two events tomorrow, none today
  const parsed = calendarParse(events, data);
  assert.equal(parsed.numEventsToday, 0);
  assert.equal(parsed.numEventsTomorrow, 2);
  assert.deepEqual(parsed.events.map((e) => e.summary), ['Work standup', 'Dinner with Sam']);
  assert.equal(parsed.events[0].fullDay, false);
});

test('D-04/i2 LassoClient.fetchCalendarEvents returns the relayData envelope contents', async () => {
  const data = reportData();
  const res = await LassoClient.fetchCalendarEvents(data, 'google', 'workCalendar', '2026-06-13T23:59:59.999Z');
  assert.deepEqual(Object.keys(res), ['events']);
  assert.deepEqual(res.events.map((e) => e.summary), ['Work standup']);
  const raw = await fetch(`http://localhost:${PORT}/v1/google_calendar?skillId=report-skill&accountId=acct-1&calendar=workCalendar&endDate=2026-06-13T23:59:59.999Z`);
  const body = await raw.json();
  assert.deepEqual(body.relayData, res, 'extractResponseData lifted exactly relayData');
  assert.equal(body.lassoDataFromRedis, true, 'the second read came from the 60s cache');
});

test('D-04/i3 DIVERGENCE (report side, out of D-04 scope): the report sends a UTC endDate so an all-day Outlook event is not shifted', async () => {
  const data = reportData();
  const [name, events] = await getData({ calendar: { outlookPersonalCreds: true } }, data);
  assert.equal(name, Names.calendar);
  const request = providerRequests.filter((r) => r.service === 'outlook').at(-1);
  assert.equal(request.endDate, END_OF_TOMORROW);
  // The pinned source builds endDate with
  // moment.parseZone(iso).add(1,'day').endOf('day').format()
  // (report-skill/src/subskills/calendar/CalendarData.ts:22), which keeps the location
  // offset ('2026-06-13T23:59:59-04:00'). The Phoenix report sends the same instant as
  // UTC, so the data service sees tzOffset 0 and presents an all-day Outlook event at
  // +00:00 instead of the location offset. Data-service side is correct (see
  // packages/data/test/calendar-relay.test.js D-04/11); the report's rendering is the gap.
  assert.equal(request.endDate.endsWith('Z'), true, 'no offset designator survives');
  assert.equal(events[0].fullDay, true);
  assert.equal(events[0].start.dateTime, '2026-06-13T00:00:00+00:00');
  assert.equal(events[0].start.dateTime.endsWith('-04:00'), false);
});
