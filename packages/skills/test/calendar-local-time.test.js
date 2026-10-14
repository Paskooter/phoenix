import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarParse, CalendarMimLogic, getData } from '../src/report/calendar.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { calEventViews } from '../src/report/calendarViews.js';
import { commuteParse } from '../src/report/commute.js';
import { departView } from '../src/report/commuteViews.js';
import { normalizeEvent, normalizeOutlookEvent } from '../../data/src/calendar.js';
import { parseICalendar } from '../../common/src/ical.js';

function reportData(iso, timeZone = 'America/New_York') {
  return {
    runtime: { location: { iso } },
    local: { userPrefs: { calendar: { timeZone }, commute: { workTime: { hour: 9, min: 0 } } } },
    skill: { session: { data: { _personalReport: { singleSkill: 'calendar' } } } },
    result: { nlu: { entities: {} } },
  };
}

function eventAt(dateTime, fullDay = false) {
  return { summary: 'Appointment', fullDay, start: { dateTime, timestamp: Date.parse(dateTime) } };
}

function parse(events, data) {
  data.local.calendar = calendarParse(events, data);
  return data.local.calendar;
}

function freeze(t, iso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}

test('UTC calendar event speaks and displays 1 PM in New York without changing its instant', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const event = eventAt('2026-10-14T17:00:00Z');
  const original = JSON.stringify(event);
  const parsed = parse([event], data);
  new CalendarMimLogic('calendar').getSingleSkillMims(data);
  assert.deepEqual(parsed.eventTimesOnAt, ['at 1:00 PM']);
  const [view] = await calEventViews(parsed.events, data);
  const [card, , time, ampm] = view.componentConfigs;
  assert.equal(time.text, '1');
  assert.equal(ampm.text, 'PM');
  assert.match(card.assets[0].src, /eventAfternoon_v01\.crn$/);
  assert.equal(parsed.events[0].dateTime.utc, event.start.timestamp);
  assert.equal(JSON.stringify(event), original);
});

test('calendar uses the New York event-date offset after DST ends', (t) => {
  const iso = '2026-10-31T18:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const event = eventAt('2026-11-01T18:00:00Z');
  const parsed = parse([event], data);
  assert.equal(parsed.numEventsTomorrow, 1);
  assert.equal(parsed.events[0].dateTime.toString({ prefixOnAt: true }), 'tomorrow at 1:00 PM');
  assert.equal(parsed.events[0].dateTime.utc, event.start.timestamp);
});

test('early events compare against 9 AM on the local day after DST ends', (t) => {
  const iso = '2026-10-31T18:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const parsed = parse([eventAt('2026-11-01T13:30:00Z'), eventAt('2026-11-01T14:00:00Z')], data);
  assert.equal(parsed.workArrivalDT.utc, Date.parse('2026-11-01T09:00:00-05:00'));
  assert.deepEqual(parsed.events.map((event) => event.isEarly), [true, false]);
});

test('UTC calendar card labels use the robot time instead of the event suffix', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const parsed = parse([eventAt('2026-10-14T17:00:00Z')], data);
  const [view] = await calEventViews(parsed.events, data);
  assert.deepEqual(view.componentConfigs.slice(2, 4).map((component) => component.text), ['1', 'PM']);
});

for (const [start, time, ampm, period] of [
  ['2026-10-14T14:30:00Z', '10:30', 'AM', 'Morning'],
  ['2026-10-14T20:00:00Z', '4', 'PM', 'Afternoon'],
  ['2026-10-15T01:30:00Z', '9:30', 'PM', 'Night'],
]) {
  test(`UTC calendar event uses the local ${period} card`, async (t) => {
    const iso = '2026-10-14T08:00:00-04:00';
    freeze(t, iso);
    const data = reportData(iso);
    const parsed = parse([eventAt(start)], data);
    const [view] = await calEventViews(parsed.events, data);
    assert.match(view.componentConfigs[0].assets[0].src, new RegExp(`event${period}_v01\\.crn$`));
    assert.deepEqual(view.componentConfigs.slice(2, 4).map((component) => component.text), [time, ampm]);
  });
}

test('9:30 PM local event stored on the next UTC date counts as today', (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const parsed = parse([eventAt('2026-10-15T01:30:00Z')], data);
  assert.equal(parsed.numEventsToday, 1);
  assert.equal(parsed.numEventsTomorrow, 0);
  assert.equal(parsed.workArrivalDT.utc, Date.parse('2026-10-14T09:00:00-04:00'));
  assert.equal(parsed.events[0].isEarly, false);
  const logic = new CalendarMimLogic('calendar');
  assert.deepEqual(logic.getSingleSkillMims(data), ['EventCountToday', 'SummaryAndTime', 'Outro']);
  assert.deepEqual(parsed.eventTimesOnAt, ['at 9:30 PM']);
  assert.deepEqual(logic.getFullReportMims(data), ['EventToday']);
});

test('explicit tomorrow request selects the robot calendar date', (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  data.skill.session.data._personalReport.nlu = { entities: { date: 'tomorrow' } };
  const today = eventAt('2026-10-15T01:30:00Z');
  const tomorrow = { ...eventAt('2026-10-16T01:30:00Z'), summary: 'Evening appointment' };
  const parsed = parse([today, tomorrow], data);
  assert.equal(parsed.numEventsToday, 1);
  assert.equal(parsed.numEventsTomorrow, 1);
  new CalendarMimLogic('calendar').getSingleSkillMims(data);
  assert.deepEqual(parsed.eventSummaries, ['Evening appointment']);
  assert.deepEqual(parsed.eventTimesOnAt, ['tomorrow at 9:30 PM']);
});

test('DST day classification resolves the current date and event date separately', (t) => {
  const iso = '2026-10-31T00:30:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  const parsed = parse([eventAt('2026-11-01T06:30:00Z')], data);
  assert.equal(parsed.numEventsTomorrow, 1);
  assert.equal(parsed.events[0].dateTime.toString({ prefixOnAt: true }), 'tomorrow at 1:30 AM');
  assert.equal(parsed.workArrivalDT.utc, Date.parse('2026-11-01T09:00:00-05:00'));
});

test('UTC calendar times use Europe/Berlin wall time and Night card', async (t) => {
  const iso = '2026-10-14T09:00:00+02:00';
  freeze(t, iso);
  const data = reportData(iso, 'Europe/Berlin');
  const parsed = parse([eventAt('2026-10-14T17:00:00Z')], data);
  assert.equal(parsed.events[0].dateTime.toString({ prefixOnAt: true }), 'at 7:00 PM');
  const [view] = await calEventViews(parsed.events, data);
  assert.match(view.componentConfigs[0].assets[0].src, /eventNight_v01\.crn$/);
  assert.deepEqual(view.componentConfigs.slice(2, 4).map((component) => component.text), ['7', 'PM']);
});

for (const [carrier, key] of [['location', 'timeZone'], ['location', 'timezone'], ['runtime', 'timeZone'], ['runtime', 'timezone']]) {
  test(`calendar uses the ${carrier}.${key} IANA zone when preferences have none`, (t) => {
    const iso = '2026-10-31T18:00:00-04:00';
    freeze(t, iso);
    const data = reportData(iso, null);
    (carrier === 'location' ? data.runtime.location : data.runtime)[key] = 'America/New_York';
    const parsed = parse([eventAt('2026-11-01T18:00:00Z')], data);
    assert.equal(parsed.events[0].dateTime.toString({ timeOnly: true }), '1:00 PM');
  });
}

test('calendar falls back to the robot ISO offset when no IANA zone is available', (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const parsed = parse([eventAt('2026-10-14T17:00:00Z')], reportData(iso, null));
  assert.equal(parsed.events[0].dateTime.toString(), '1:00 PM');
});

test('invalid named zones fall back to the fractional robot ISO offset', (t) => {
  const iso = '2026-10-14T08:00:00+05:45';
  freeze(t, iso);
  const data = reportData(iso, 'Not/AZone');
  data.runtime.location.timeZone = 'Also/Invalid';
  const parsed = parse([eventAt('2026-10-14T08:00:00Z')], data);
  assert.equal(parsed.events[0].dateTime.toString(), '1:45 PM');
});

test('early calendar events keep local arrival and departure speech and cards', async (t) => {
  const iso = '2026-10-14T07:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  Object.assign(data.local.userPrefs.commute, { complete: true, mode: 'driving' });
  const parsed = parse([eventAt('2026-10-14T12:30:00Z')], data);
  assert.equal(parsed.events[0].isEarly, true);
  const maps = { routes: [{ legs: [{ duration: { value: 1800 }, duration_in_traffic: { value: 1800 } }] }] };
  const commute = await commuteParse(maps, iso, data.local);
  assert.equal(commute.eventIsEarly, true);
  assert.equal(commute.arriveDT.toString(), '8:30 AM');
  assert.equal(commute.departDT.toString({ timeOnly: true }), '8:00 AM');
  const view = await departView(commute);
  assert.deepEqual(view.componentConfigs.slice(1).map((component) => component.text), ['8:00', 'AM']);
});

test('early calendar departure clone resolves its own DST offset', async (t) => {
  const iso = '2026-11-01T00:30:00-04:00';
  freeze(t, iso);
  const data = reportData(iso);
  Object.assign(data.local.userPrefs.commute, { complete: true, mode: 'driving' });
  parse([eventAt('2026-11-01T06:30:00Z')], data);
  const maps = { routes: [{ legs: [{ duration: { value: 3600 }, duration_in_traffic: { value: 3600 } }] }] };
  const commute = await commuteParse(maps, iso, data.local);
  assert.equal(commute.arriveDT.utc, Date.parse('2026-11-01T06:30:00Z'));
  assert.equal(commute.departDT.utc, Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(commute.arriveDT.toString(), '1:30 AM');
  assert.equal(commute.departDT.toString(), '1:30 AM');
});

test('full-day iCal, Google and Outlook dates and blank time labels stay unchanged', async (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const source = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:all-day-test\nDTSTART;VALUE=DATE:20261014\nSUMMARY:Day off\nEND:VEVENT\nEND:VCALENDAR';
  const [ical] = parseICalendar(source, { timeZone: 'America/New_York', windowStart: Date.parse('2026-10-14T00:00:00Z'), windowEnd: Date.parse('2026-10-16T00:00:00Z') });
  const google = normalizeEvent({ summary: 'Day off', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } }, 'America/New_York');
  const outlook = normalizeOutlookEvent({ subject: 'Day off', isAllDay: true, start: { dateTime: '2026-10-14T00:00:00', timeZone: 'UTC' } }, -240);
  for (const event of [ical, google, outlook, eventAt('2026-10-14T00:00:00Z', true)]) {
    const data = reportData(iso);
    const original = JSON.stringify(event);
    const parsed = parse([event], data);
    assert.equal(parsed.numEventsToday, 1);
    assert.equal(parsed.numEventsTomorrow, 0);
    assert.equal(parsed.events[0].isEarly, false);
    new CalendarMimLogic('calendar').getSingleSkillMims(data);
    assert.deepEqual(parsed.eventTimesOnAt, ['an all day event']);
    const [view] = await calEventViews(parsed.events, data);
    assert.deepEqual(view.componentConfigs.slice(2, 4).map((component) => component.text), ['', '']);
    assert.match(view.componentConfigs[0].assets[0].src, /eventMorning_v01\.crn$/);
    assert.equal(JSON.stringify(event), original);
  }
});

test('already-local TZID, Google and Outlook timed events retain their instants and labels', (t) => {
  const iso = '2026-10-14T08:00:00-04:00';
  freeze(t, iso);
  const source = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:local-time-test\nDTSTART;TZID=America/New_York:20261014T130000\nSUMMARY:Appointment\nEND:VEVENT\nEND:VCALENDAR';
  const [ical] = parseICalendar(source, { timeZone: 'America/New_York', windowStart: Date.parse('2026-10-14T00:00:00Z'), windowEnd: Date.parse('2026-10-16T00:00:00Z') });
  const google = normalizeEvent({ summary: 'Appointment', start: { dateTime: '2026-10-14T13:00:00-04:00' } }, 'America/New_York');
  const outlook = normalizeOutlookEvent({ subject: 'Appointment', start: { dateTime: '2026-10-14T17:00:00', timeZone: 'UTC' } }, -240);
  for (const event of [ical, google, outlook]) {
    const original = JSON.stringify(event);
    const parsed = parse([event], reportData(iso));
    assert.equal(parsed.events[0].dateTime.toString(), '1:00 PM');
    assert.equal(parsed.events[0].dateTime.utc, Date.parse('2026-10-14T17:00:00Z'));
    assert.equal(JSON.stringify(event), original);
  }
});

test('full-report tomorrow summary uses the preferred zone for the noon decision', (t) => {
  const iso = '2026-10-14T12:00:00Z';
  freeze(t, iso);
  const data = reportData(iso);
  data.runtime.location.timeZone = 'Europe/Berlin';
  parse([eventAt('2026-10-15T17:00:00Z')], data);
  assert.deepEqual(new CalendarMimLogic('calendar').getFullReportMims(data), ['NothingToday']);
});

test('calendar fetch includes the last local hour of tomorrow after DST ends', async (t) => {
  const iso = '2026-10-31T18:00:00-04:00';
  freeze(t, iso);
  const data = reportData(iso, null);
  const prefs = { calendar: { timeZone: 'America/New_York', googlePersonalCreds: true } };
  let endDate;
  t.mock.method(LassoClient, 'fetchCalendarEvents', async (_data, _service, _calendar, end) => {
    endDate = end;
    return { events: [] };
  });
  await getData(prefs, data);
  assert.equal(endDate, '2026-11-01T23:59:59-05:00');
});

test('calendar event the day after the US DST change uses standard time', (t) => {
  const iso = '2026-11-01T00:30:00-04:00';
  freeze(t, iso);
  const parsed = parse([eventAt('2026-11-02T18:00:00Z')], reportData(iso));
  assert.equal(parsed.numEventsTomorrow, 1);
  assert.equal(parsed.events[0].dateTime.toString({ prefixOnAt: true }), 'tomorrow at 1:00 PM');
});

test('calendar uses the new local work-arrival offset when DST starts', (t) => {
  const iso = '2026-03-07T18:00:00-05:00';
  freeze(t, iso);
  const parsed = parse([eventAt('2026-03-08T12:30:00Z')], reportData(iso));
  assert.equal(parsed.events[0].dateTime.toString(), '8:30 AM');
  assert.equal(parsed.workArrivalDT.utc, Date.parse('2026-03-08T09:00:00-04:00'));
  assert.equal(parsed.events[0].isEarly, true);
});

test('a UTC robot offset overrides a timed event with a nonzero suffix', (t) => {
  const iso = '2026-10-14T08:00:00Z';
  freeze(t, iso);
  const parsed = parse([eventAt('2026-10-14T13:00:00+02:00')], reportData(iso, null));
  assert.equal(parsed.events[0].dateTime.toString(), '11:00 AM');
  assert.equal(parsed.events[0].dateTime.utc, Date.parse('2026-10-14T11:00:00Z'));
});
