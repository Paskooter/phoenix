import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarParse, CalendarMimLogic } from '../src/report/calendar.js';
import { calEventViews } from '../src/report/calendarViews.js';

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
