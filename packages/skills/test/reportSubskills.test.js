// E.8b — Commute + Calendar subskills against a mock lasso, with prefs from
// resources/report-prefsConfig.json (ETCO_report_prefsFromConfig=true): the depart-time math,
// traffic tables (Poor/Terrible/Hurry/Now/MinutesLeft) and the calendar count/SummaryAndTime/
// ParallelEvent/TomorrowOnly walks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SkillRequestType } from '@phoenix/contracts';

process.env.ETCO_report_prefsFromConfig = 'true';
const { reportSkill } = await import('../src/reportSkill.js');

// Controlled "now": commute math is driven by runtime.location.iso (fully deterministic);
// calendar today/tomorrow classification uses the real clock, so calendar events are
// built relative to Date.now() (today events at now+5min — only flaky within 5 minutes
// of local midnight, accepted).
const TZ = '-04:00';
const isoAt = (hhmm) => `2026-06-12T${hhmm}:00${TZ}`;
const nowISO = () => new Date(Date.now() - 4 * 3600e3).toISOString().replace('Z', TZ);
const nowPlus = (ms) => new Date(Date.now() + ms - 4 * 3600e3).toISOString().replace('Z', TZ);

let server;
let mapsLeg = {};
let calendarEvents = { google: [], outlook: [] };

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/v1/google_maps') {
      res.end(JSON.stringify({ relayData: { status: 'OK', routes: [{ legs: [mapsLeg] }] } }));
    } else if (u.pathname === '/v1/google_calendar') {
      res.end(JSON.stringify({ relayData: { events: calendarEvents.google } }));
    } else if (u.pathname === '/v1/outlook_calendar') {
      res.end(JSON.stringify({ relayData: { events: calendarEvents.outlook } }));
    } else if (u.pathname === '/v1/dark_sky' || u.pathname === '/v1/ap_news') {
      res.end(JSON.stringify({ relayData: null })); // weather/news degrade; not under test here
    } else {
      res.end(JSON.stringify({ relayData: null }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  process.env.NET_data = `localhost:${server.address().port}`;
});
after(() => { server.close(); delete process.env.NET_data; });

const launch = (intent, iso, entities = {}) => ({
  type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1,
  data: {
    general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
    runtime: {
      dialog: {},
      perception: { speaker: 'u1' },
      loop: { loopId: 'loop-1', users: [{ id: 'u1', name: 'Alice Smith', accountId: 'acct-1', birthdate: '1990-01-01' }] },
      location: { lat: 42.36, lng: -71.06, iso },
    },
    skill: { id: 'report-skill' },
    result: { nlu: { intent, entities, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
  },
});

const slims = (r) => {
  const jcp = r.data.action.config.jcp;
  return jcp.type === 'SLIM' ? [jcp] : jcp.children.filter((c) => c.type === 'SLIM');
};
const mims = (r) => slims(r).map((s) => s.config.play.meta.mim_id);
const esml = (r) => slims(r).map((s) => s.config.play.esml).join(' | ');

// --- commute ---------------------------------------------------------------------

test('commute: light traffic -> DrivePoor + DepartTimeNotNormal (no MinutesLeft at exactly 30)', async () => {
  // 8:00, arrive 9:00, 30 min in traffic (25 baseline) -> depart 8:30, +5 extra mins.
  mapsLeg = { duration: { value: 1500 }, duration_in_traffic: { value: 1800 } };
  const r = await reportSkill(launch('requestCommute', isoAt('08:00')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteDrivePoor', 'CommuteDepartTimeNotNormal']);
  assert.match(esml(r), /8:30 AM/, 'depart time rendered via departDT.toString({timeOnly})');
});

test('commute: heavy traffic + <30 min left -> DriveTerrible + MinutesLeft', async () => {
  // 8:00, arrive 9:00, 45 min in traffic (25 baseline) -> depart 8:15, 15 min left, +20 extra.
  mapsLeg = { duration: { value: 1500 }, duration_in_traffic: { value: 2700 } };
  const r = await reportSkill(launch('requestCommute', isoAt('08:00')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteDriveTerrible', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft']);
  assert.match(esml(r), /15 minutes/, 'minsLeft resolved');
});

test('commute: no traffic -> DriveNormal + DepartTimeNormal', async () => {
  // 8:00, arrive 9:00, 25 min flat -> depart 8:35; 35 min left (>=30, no MinutesLeft).
  mapsLeg = { duration: { value: 1500 }, duration_in_traffic: { value: 1500 } };
  const r = await reportSkill(launch('requestCommute', isoAt('08:00')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.match(esml(r), /8:35 AM/);
});

test('commute: just missed the departure -> DriveHurry; long missed -> DriveLate; far ahead -> Now', async () => {
  mapsLeg = { duration: { value: 1500 }, duration_in_traffic: { value: 1500 } };
  // depart 8:35; at 8:40 -> -5 min -> Hurry
  let r = await reportSkill(launch('requestCommute', isoAt('08:40')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteDriveHurry']);
  // at 8:55 -> -20 min -> Late
  r = await reportSkill(launch('requestCommute', isoAt('08:55')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteDriveLate']);
  // at 05:00 -> +215 min -> Now
  r = await reportSkill(launch('requestCommute', isoAt('05:00')));
  assert.deepEqual(mims(r), ['CommuteConfirmSpeaker', 'CommuteNow']);
  assert.match(esml(r), /25 minutes/, 'durationMins in the Now prompt');
});

// --- calendar ---------------------------------------------------------------------

test('calendar: two concurrent events today -> Count + SummaryAndTime + ParallelEvent + Outro', async () => {
  const t = Date.now() + 5 * 60 * 1000;
  calendarEvents = {
    google: [{ summary: 'Standup', start: { dateTime: nowPlus(5 * 60 * 1000), timestamp: t } }],
    outlook: [{ summary: 'Dentist', start: { dateTime: nowPlus(5 * 60 * 1000), timestamp: t } }],
  };
  const r = await reportSkill(launch('requestCalendar', nowISO()));
  assert.deepEqual(mims(r), ['CalendarEventCountToday', 'CalendarSummaryAndTime', 'CalendarParallelEvent', 'CalendarOutro']);
  const text = esml(r);
  assert.match(text, /Standup/);
  assert.match(text, /Dentist/);
  assert.match(text, /at \d{1,2}:\d{2} (AM|PM)/, 'eventTimesOnAt rendered with the on/at prefix');
});

test('calendar: events only tomorrow -> TomorrowOnly + Count + walk', async () => {
  const t = Date.now() + 24 * 3600 * 1000;
  calendarEvents = { google: [{ summary: 'Flight to Boston', start: { dateTime: nowPlus(24 * 3600 * 1000), timestamp: t } }], outlook: [] };
  const r = await reportSkill(launch('requestCalendar', nowISO()));
  assert.deepEqual(mims(r), ['CalendarTomorrowOnly', 'CalendarEventCountTomorrow', 'CalendarSummaryAndTime', 'CalendarOutro']);
  assert.match(esml(r), /Flight to Boston/);
});

test('calendar: asked for tomorrow with nothing scheduled -> Nothing', async () => {
  calendarEvents = { google: [], outlook: [] };
  const r = await reportSkill(launch('requestCalendar', nowISO(), { date: 'tomorrow' }));
  assert.deepEqual(mims(r), ['CalendarNothing']);
});

test('calendar: all-day event today reads the fullDay phrasing', async () => {
  const t = Date.now() + 5 * 60 * 1000;
  calendarEvents = {
    google: [{ summary: 'Company holiday', fullDay: true, start: { dateTime: nowPlus(5 * 60 * 1000), timestamp: t } }],
    outlook: [],
  };
  const r = await reportSkill(launch('requestCalendar', nowISO()));
  assert.deepEqual(mims(r), ['CalendarEventCountToday', 'CalendarSummaryAndTime', 'CalendarOutro']);
  assert.match(esml(r), /all day event/, 'mimPromptText calendar.fullDay phrasing');
});
