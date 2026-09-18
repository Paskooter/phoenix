import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IcalParseError, parseICalendar } from '../src/ical.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const windowFor = (start, end) => ({
  windowStart: Date.parse(start),
  windowEnd: Date.parse(end),
});

test('ical parser unfolds lines, unescapes text, resolves TZID and expands all-day/duration events', () => {
  const events = parseICalendar(fixture('ical-basic.ics'), {
    timeZone: 'America/New_York',
    ...windowFor('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z'),
  });

  assert.equal(events.length, 3);
  assert.equal(events[0].uid, 'folded-1');
  assert.equal(events[0].summary, 'Planning, Q1; kickoff with a very long project name');
  assert.equal(events[0].description, 'Bring slides\nBring coffee\\mug');
  assert.equal(events[0].location, 'Studio, East');
  assert.equal(events[0].fullDay, false);
  assert.equal(events[0].start.timestamp, Date.parse('2027-01-15T14:30:00Z'));
  assert.equal(events[0].start.dateTime, '2027-01-15T09:30:00-05:00');

  assert.equal(events[1].uid, 'all-day-1');
  assert.equal(events[1].fullDay, true);
  assert.equal(events[1].start.dateTime, '2027-01-16T00:00:00-05:00');
  assert.equal(events[1].end.dateTime, '2027-01-18T00:00:00-05:00');

  assert.equal(events[2].uid, 'utc-duration-1');
  assert.equal(events[2].start.dateTime, '2027-01-20T15:00:00Z');
  assert.equal(events[2].end.timestamp - events[2].start.timestamp, 90 * 60 * 1000);
});

test('ical parser treats floating date-times in the requested account timezone', () => {
  const [event] = parseICalendar(fixture('ical-floating.ics'), {
    timeZone: 'America/Los_Angeles',
    ...windowFor('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  });
  assert.equal(event.start.timestamp, Date.parse('2026-01-10T17:00:00Z'));
  assert.equal(event.start.dateTime, '2026-01-10T09:00:00-08:00');
});

test('ical parser expands a common weekly RRULE without dropping occurrences', () => {
  const events = parseICalendar(fixture('ical-recurring.ics'), {
    timeZone: 'America/New_York',
    ...windowFor('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  });
  const weekly = events.filter((event) => event.uid === 'weekly-1');
  assert.deepEqual(weekly.map((event) => event.start.dateTime), [
    '2026-01-05T09:00:00-05:00',
    '2026-01-07T09:00:00-05:00',
    '2026-01-12T09:00:00-05:00',
    '2026-01-14T09:00:00-05:00',
  ]);
  const monthEnds = events.filter((event) => event.uid === 'month-end-1');
  assert.deepEqual(monthEnds.map((event) => event.start.dateTime), ['2026-01-31T09:00:00-05:00']);
  assert.ok(weekly.every((event) => event.recurrenceId === 'weekly-1'));
});
test('ical parser rejects malformed VEVENT input instead of silently dropping it', () => {
  assert.throws(
    () => parseICalendar(fixture('ical-malformed.ics')),
    (error) => error instanceof IcalParseError && /DTSTART/.test(error.message),
  );
});

test('ical parser rejects recurrence features it cannot expand instead of dropping them', () => {
  const source = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:unsupported-1',
    'DTSTART:20270101T090000Z',
    'RRULE:FREQ=DAILY;BYHOUR=9;COUNT=2',
    'SUMMARY:Unsupported',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  assert.throws(() => parseICalendar(source), (error) => (
    error instanceof IcalParseError && /unsupported RRULE component/.test(error.message)
  ));
});
