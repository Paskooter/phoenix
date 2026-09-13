#!/usr/bin/env node
// Create a private, current-date starter fixture for the S-13 diagnostic stack.
// The generated values are concrete: once written, the fixture is deterministic
// until the operator atomically changes its case selector or data and digest.

import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { casesSha256, resolveLocalOffset, S13_FIXTURE_SCHEMA } from './s13-fixture.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node scripts/parity-robot/s13-fixture-template.mjs <private-fixture.json>');
process.umask(0o077);
const file = resolve(target);
const directory = dirname(file);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(file)) throw new Error(`refusing to overwrite existing fixture: ${file}`);

const TIME_ZONE = process.env.PHOENIX_S13_FIXTURE_TIME_ZONE || 'America/New_York';
const now = new Date();
const pad = (value) => String(value).padStart(2, '0');

function localParts(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), min: Number(values.minute), sec: Number(values.second),
  };
}

function localDateText({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function dateAfter(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  // Noon avoids a DST transition at local midnight when deriving a calendar date.
  const candidate = new Date(Date.UTC(year, month - 1, day, 12) + days * 86400000);
  return localDateText(localParts(candidate));
}

function localISO(dateText, hour, min) {
  return `${dateText}T${pad(hour)}:${pad(min)}:00${resolveLocalOffset(dateText, hour, min, TIME_ZONE)}`;
}

const today = localDateText(localParts(now));
const tomorrow = dateAfter(today, 1);
const current = localParts(now);
const currentMinutes = current.hour * 60 + current.min + (current.sec ? 1 : 0);
const latestUsefulWorkMinute = 23 * 60 + 55;
const roundedFuture = Math.ceil((currentMinutes + 75) / 5) * 5;
const workMinutes = Math.min(roundedFuture, latestUsefulWorkMinute);
if (workMinutes - currentMinutes < 30) {
  throw new Error(`run fixture generation with at least 30 minutes left in ${TIME_ZONE} day (current ${pad(current.hour)}:${pad(current.min)})`);
}
const workTime = { hour: Math.floor(workMinutes / 60), min: workMinutes % 60 };

function prefs({ calendar = false, googlePersonal = false, googleWork = false, outlookPersonal = false, outlookWork = false, work = workTime } = {}) {
  return {
    weather: { active: false, useCelsius: false },
    calendar: {
      active: calendar,
      googlePersonalCreds: googlePersonal,
      googleWorkCreds: googleWork,
      outlookPersonalCreds: outlookPersonal,
      outlookWorkCreds: outlookWork,
    },
    commute: {
      active: true,
      workTime: { ...work },
      origin: { lat: 42.313352, lng: -71.1273681 },
      destination: { lat: 42.3601, lng: -71.0589 },
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
      // Keep the source baseline and traffic duration independent. Normal,
      // Bad and Terrible select 10, 15 and 25 minute traffic paths.
      duration: { text: '10 mins', value: 600 },
      duration_in_traffic: { text: `${Math.round(trafficSeconds / 60)} mins`, value: trafficSeconds },
    }] }],
  };
}

function googleTimed(summary, dateText, hour, min) {
  return {
    summary,
    start: { dateTime: localISO(dateText, hour, min), timeZone: TIME_ZONE },
    end: { dateTime: localISO(dateText, hour + (min + 30 >= 60 ? 1 : 0), (min + 30) % 60), timeZone: TIME_ZONE },
  };
}

function googleAllDay(summary, dateText) {
  return { summary, start: { date: dateText }, end: { date: dateAfter(dateText, 1) } };
}

function outlookTimed(summary, dateText, hour, min) {
  return {
    subject: summary,
    isAllDay: false,
    start: { dateTime: `${dateText}T${pad(hour)}:${pad(min)}:00`, timeZone: TIME_ZONE },
    end: { dateTime: `${dateText}T${pad(hour + (min + 30 >= 60 ? 1 : 0))}:${pad((min + 30) % 60)}:00`, timeZone: TIME_ZONE },
  };
}

function eventTimestamps(calendar) {
  const out = [];
  for (const service of ['google', 'outlook']) {
    for (const calendarName of ['personalCalendar', 'workCalendar']) {
      const selected = calendar[service][calendarName];
      const events = service === 'google' ? selected.items : selected.value;
      events.forEach((event, index) => {
        const start = service === 'google' ? (event.start.dateTime || event.start.date) : event.start.dateTime;
        const end = service === 'google' ? (event.end?.dateTime || event.end?.date) : event.end?.dateTime;
        out.push({ service, calendar: calendarName, index, start, ...(end ? { end } : {}) });
      });
    }
  }
  return out;
}

function calendarData({ mode = 'empty' } = {}) {
  const cards = mode === 'cards' ? [
    // One ordered, single-provider 4-card turn: full day, long :25 birthday,
    // on-hour Work fallback, and a night dog event.
    googleAllDay('Company holiday', tomorrow),
    googleTimed(`Birthday party and board meeting ${'.'.repeat(30)}`, tomorrow, 10, 25),
    googleTimed('Work meeting', tomorrow, 14, 0),
    googleTimed('Dog walk', tomorrow, 20, 25),
  ] : [];
  const parallelPersonal = mode === 'parallel' ? [googleTimed('Personal standup', tomorrow, 11, 0)] : [];
  const parallelWork = mode === 'parallel' ? [outlookTimed('Work review', tomorrow, 11, 0)] : [];
  return {
    google: {
      personalCalendar: { items: mode === 'cards' ? cards : parallelPersonal, timeZone: TIME_ZONE },
      workCalendar: { items: [], timeZone: TIME_ZONE },
    },
    outlook: {
      personalCalendar: { value: [], timeZone: TIME_ZONE },
      workCalendar: { value: parallelWork, timeZone: TIME_ZONE },
    },
  };
}

function caseData({ trafficSeconds = 600, calendarMode = 'empty', calendarPrefs = {}, work = workTime, calendarPhrase } = {}) {
  const userPrefs = prefs({ ...calendarPrefs, work });
  const calendar = calendarData({ mode: calendarMode });
  return {
    userPrefs,
    maps: map(trafficSeconds),
    calendar,
    meta: {
      date: today,
      timeZone: TIME_ZONE,
      workTime: { ...work },
      eventTimestamps: eventTimestamps(calendar),
      ...(calendarPhrase ? { calendarPhrase } : {}),
    },
  };
}

const cases = {
  Normal: caseData({ trafficSeconds: 600 }),
  Bad: caseData({ trafficSeconds: 900 }),
  Terrible: caseData({ trafficSeconds: 1500 }),
  'calendar-four-card-field-matrix': caseData({
    calendarMode: 'cards',
    calendarPrefs: { calendar: true, googlePersonal: true },
    calendarPhrase: 'what is on my calendar tomorrow',
  }),
  'calendar-parallel': caseData({
    calendarMode: 'parallel',
    calendarPrefs: { calendar: true, googlePersonal: true, outlookWork: true },
    calendarPhrase: 'what is on my calendar tomorrow',
  }),
};

const fixture = {
  schema: S13_FIXTURE_SCHEMA,
  caseId: 'Normal',
  integrity: { casesSha256: casesSha256(cases) },
  cases,
};
const text = `${JSON.stringify(fixture, null, 2)}\n`;
writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
const descriptor = openSync(file, 'r+');
try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
console.log(JSON.stringify({
  path: file,
  casesSha256: fixture.integrity.casesSha256,
  caseId: fixture.caseId,
  date: today,
  timeZone: TIME_ZONE,
  workTime,
  calendarTomorrow: tomorrow,
}));
