// The console Calendar's month layout and agenda wording, run on the DOM-free
// block of app.js in a sandbox. Synthetic events only.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const START = '/* -- Calendar: pure month and agenda state';
const END = '/* -- end of the calendar pure state';
const source = readFileSync(new URL('../portal/app.js', import.meta.url), 'utf8');

function load() {
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  assert.ok(from >= 0 && to > from, 'app.js keeps the calendar pure-state block between its markers');
  const context = vm.createContext({ Intl, Date, Math, Number, String, Array, Object, JSON, Set, Map, RegExp });
  vm.runInContext(`${source.slice(from, to)}
;globalThis.calendar = { calendarMonthModel, calendarEventSpan, calendarEventWhen, calendarMonthEventCount,
  calendarAgendaOrder, calendarAddDays, calendarAddMonths, calendarGridKeys, calendarMonthWindow,
  calendarZoneDescription, calendarSubscriptionSummary, calendarSentence, calendarColorIndex, calendarChipTime };`, context);
  return context.calendar;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
// Each test reports a missing block on its own rather than failing the file.
let cal = null;
let missing = null;
try { cal = load(); } catch (error) { missing = error; }
const test = (name, body) => nodeTest(name, () => {
  if (missing) throw missing;
  return body();
});
const LA = 'America/Los_Angeles';
const OCTOBER = new Date(Date.UTC(2026, 9, 1));

const timed = (id, startIso, endIso, extra = {}) => ({
  uid: id, summary: id, fullDay: false, subscriptionId: extra.subscriptionId || 'family',
  start: { timestamp: Date.parse(startIso), dateTime: startIso },
  end: { timestamp: Date.parse(endIso), dateTime: endIso },
  ...extra,
});
// An all-day event as the server stores one: midnight in the zone it was checked in.
const allDay = (id, first, afterLast, zoneOffset = '-07:00', extra = {}) => ({
  uid: id, summary: id, fullDay: true, subscriptionId: extra.subscriptionId || 'family',
  start: { timestamp: Date.parse(`${first}T00:00:00${zoneOffset}`), dateTime: `${first}T00:00:00${zoneOffset}` },
  end: { timestamp: Date.parse(`${afterLast}T00:00:00${zoneOffset}`), dateTime: `${afterLast}T00:00:00${zoneOffset}` },
  ...extra,
});
const day = (model, key) => model.days.find((item) => item.key === key);
const rowSummary = (entry) => plain(entry.rows.map((row) => row.kind === 'spacer' ? '-' : `${row.kind}:${row.item.event.uid}`));

test('the grid days are the 42 days the events request covers', () => {
  const keys = cal.calendarGridKeys(OCTOBER);
  assert.equal(keys.length, 42);
  assert.equal(keys[0], '2026-09-27');
  assert.equal(keys[41], '2026-11-07');
  const window = cal.calendarMonthWindow(OCTOBER);
  assert.ok(Date.parse(window.start) < Date.parse(`${keys[0]}T00:00:00Z`) - 14 * 3600000, 'the window starts before the first grid day anywhere on Earth');
  assert.ok(Date.parse(window.end) > Date.parse(`${keys[41]}T00:00:00Z`) + 38 * 3600000, 'and ends after the last one');
});

test('an all-day event keeps its own dates in a zone west of the one it was checked in', () => {
  const birthday = allDay('birthday', '2026-10-03', '2026-10-04');
  const trip = allDay('trip', '2026-10-16', '2026-10-19');
  assert.deepEqual(plain(cal.calendarEventSpan(birthday, 'Pacific/Honolulu')), { first: '2026-10-03', last: '2026-10-03' });
  assert.deepEqual(plain(cal.calendarEventSpan(trip, 'Pacific/Honolulu')), { first: '2026-10-16', last: '2026-10-18' });
  assert.deepEqual(plain(cal.calendarEventSpan(trip, 'Asia/Tokyo')), { first: '2026-10-16', last: '2026-10-18' });
  const model = cal.calendarMonthModel([birthday, trip], OCTOBER, 'Pacific/Honolulu');
  assert.deepEqual(day(model, '2026-10-02').events.length, 0, 'not on the day before');
  assert.deepEqual(rowSummary(day(model, '2026-10-03')), ['bar:birthday']);
  assert.deepEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']
    .map((key) => day(model, key).events.length), [0, 1, 1, 1, 0]);
});

test('timed events are placed in the calendar time zone, including UTC-written ones', () => {
  // 17:00Z is 10:00 in Los Angeles and 02:00 the next day in Tokyo.
  const call = timed('call', '2026-10-23T17:00:00Z', '2026-10-23T18:00:00Z');
  const late = timed('late', '2026-10-15T04:30:00Z', '2026-10-15T05:00:00Z'); // 21:30 on the 14th in LA
  assert.deepEqual(plain(cal.calendarEventSpan(call, LA)), { first: '2026-10-23', last: '2026-10-23' });
  assert.deepEqual(plain(cal.calendarEventSpan(call, 'Asia/Tokyo')), { first: '2026-10-24', last: '2026-10-24' });
  assert.deepEqual(plain(cal.calendarEventSpan(late, LA)), { first: '2026-10-14', last: '2026-10-14' });
  assert.equal(cal.calendarEventWhen(call, LA, 'en-US').replace(/\s/g, ' '), '10:00 – 11:00 AM');
  assert.equal(cal.calendarEventWhen(call, 'America/New_York', 'en-US').replace(/\s/g, ' '), '1:00 – 2:00 PM');
});

test('a multi-day bar keeps one row across its week and splits at the week boundary', () => {
  const trip = allDay('trip', '2026-10-16', '2026-10-19');
  const conference = timed('conference', '2026-10-19T16:00:00Z', '2026-10-21T00:00:00Z'); // 9 AM Mon to 5 PM Tue in LA
  const dentist = timed('dentist', '2026-10-16T17:00:00Z', '2026-10-16T17:45:00Z');
  const party = timed('party', '2026-10-22T03:00:00Z', '2026-10-22T07:00:00Z'); // 8 PM Wed to midnight in LA
  const model = cal.calendarMonthModel([dentist, trip, conference, party], OCTOBER, LA);
  assert.deepEqual(rowSummary(day(model, '2026-10-16')), ['bar:trip', 'timed:dentist'], 'bars sit above timed events');
  assert.deepEqual(rowSummary(day(model, '2026-10-17')), ['bar:trip']);
  assert.deepEqual(rowSummary(day(model, '2026-10-18')), ['bar:trip']);
  assert.deepEqual(rowSummary(day(model, '2026-10-19')), ['bar:conference']);
  assert.deepEqual(rowSummary(day(model, '2026-10-20')), ['bar:conference']);
  assert.deepEqual(rowSummary(day(model, '2026-10-21')), ['timed:party']);
  assert.deepEqual(rowSummary(day(model, '2026-10-22')), [], 'an event that ends at midnight does not touch the next day');
  const pieces = (weekIndex) => model.weeks[weekIndex].bars.map((piece) => ({
    uid: piece.item.event.uid, row: piece.row, from: piece.from, to: piece.to, before: piece.before, after: piece.after,
  }));
  // Week 3 is Oct 11-17, week 4 is Oct 18-24.
  assert.deepEqual(plain(pieces(2)), [{ uid: 'trip', row: 0, from: 5, to: 6, before: false, after: true }]);
  assert.deepEqual(plain(pieces(3)), [
    { uid: 'trip', row: 0, from: 0, to: 0, before: true, after: false },
    { uid: 'conference', row: 0, from: 1, to: 2, before: false, after: false },
  ]);
});

test('overlapping bars take separate rows and a free row is reused', () => {
  const a = allDay('a', '2026-10-05', '2026-10-08'); // Mon-Wed
  const b = allDay('b', '2026-10-06', '2026-10-07'); // Tue
  const c = allDay('c', '2026-10-09', '2026-10-10'); // Fri
  const model = cal.calendarMonthModel([c, b, a], OCTOBER, LA);
  assert.deepEqual(rowSummary(day(model, '2026-10-06')), ['bar:a', 'bar:b']);
  assert.deepEqual(rowSummary(day(model, '2026-10-07')), ['bar:a'], 'no trailing gap when nothing follows');
  assert.deepEqual(rowSummary(day(model, '2026-10-09')), ['bar:c'], 'a free top row is reused');
});

test('a busy day shows two events and "+N more", and the count covers everything left out', () => {
  const busy = Array.from({ length: 9 }, (_, index) => timed(`e${index}`,
    `2026-10-21T${String(14 + index).padStart(2, '0')}:00:00Z`, `2026-10-21T${String(14 + index).padStart(2, '0')}:30:00Z`));
  const model = cal.calendarMonthModel(busy, OCTOBER, LA);
  const wednesday = day(model, '2026-10-21');
  assert.equal(wednesday.events.length, 9, 'the agenda still gets every event');
  assert.deepEqual(rowSummary(wednesday), ['timed:e0', 'timed:e1']);
  assert.equal(wednesday.more, 7);
  const three = cal.calendarMonthModel(busy.slice(0, 3), OCTOBER, LA);
  assert.deepEqual(rowSummary(day(three, '2026-10-21')), ['timed:e0', 'timed:e1', 'timed:e2'], 'exactly three fit without a "more"');
  assert.equal(day(three, '2026-10-21').more, 0);
  // A gap kept under an earlier bar holds a later bar in its row; it is not an event.
  const bars = [allDay('A', '2026-10-19', '2026-10-21'), allDay('B', '2026-10-20', '2026-10-23')]; // Mon-Tue, Tue-Thu
  const stacked = cal.calendarMonthModel([...bars, ...busy.slice(0, 2)], OCTOBER, LA);
  assert.deepEqual(rowSummary(day(stacked, '2026-10-20')), ['bar:A', 'bar:B']);
  assert.deepEqual(rowSummary(day(stacked, '2026-10-22')), ['-', 'bar:B']);
  const wed = day(stacked, '2026-10-21');
  assert.deepEqual(rowSummary(wed), ['-', 'bar:B']);
  assert.equal(wed.events.length, 3);
  assert.equal(wed.more, 2);
  assert.deepEqual(plain(stacked.weeks[3].bars.map((piece) => [piece.item.event.uid, piece.row, piece.from, piece.to])),
    [['A', 0, 1, 2], ['B', 1, 2, 4]]);
  // A gap among the rows left out is not counted as an event either. P and Q
  // fill the week; S takes the third row on Mon-Tue, so R (Tue-Fri) needs a
  // fourth row and Thursday's third row is an empty gap.
  const gapped = cal.calendarMonthModel([
    allDay('P', '2026-10-18', '2026-10-25'), allDay('Q', '2026-10-18', '2026-10-25'),
    allDay('S', '2026-10-19', '2026-10-21'), allDay('R', '2026-10-20', '2026-10-24'),
  ], OCTOBER, LA);
  const thursday = day(gapped, '2026-10-22');
  assert.deepEqual(rowSummary(thursday), ['bar:P', 'bar:Q']);
  assert.equal(thursday.events.length, 3);
  assert.equal(thursday.more, 1, 'only R is left out');
});

test('the agenda lists all-day events first, then by start time, and describes each in plain words', () => {
  const trip = allDay('Fall camping trip', '2026-10-16', '2026-10-19');
  const birthday = allDay('Birthday', '2026-10-16', '2026-10-17');
  const movie = timed('Late movie night', '2026-10-17T05:00:00Z', '2026-10-17T08:30:00Z'); // 10 PM Fri to 1:30 AM Sat in LA
  const dentist = timed('Dentist', '2026-10-16T17:00:00Z', '2026-10-16T17:45:00Z');
  const reminder = timed('Reminder', '2026-10-16T16:00:00Z', '2026-10-16T16:00:00Z');
  const ordered = [movie, dentist, trip, reminder, birthday].sort(cal.calendarAgendaOrder).map((event) => event.uid);
  assert.deepEqual(ordered, ['Fall camping trip', 'Birthday', 'Reminder', 'Dentist', 'Late movie night']);
  const when = (event) => cal.calendarEventWhen(event, LA, 'en-US').replace(/\s/g, ' ');
  assert.equal(when(birthday), 'All day');
  assert.equal(when(trip), 'All day · Fri, Oct 16 – Sun, Oct 18');
  assert.equal(when(dentist), '10:00 – 10:45 AM');
  assert.equal(when(reminder), '9:00 AM');
  assert.equal(when(movie), 'Oct 16, 10:00 PM – Oct 17, 1:30 AM');
});

test('the month count includes events that started before the month', () => {
  const events = [
    allDay('spanning', '2026-09-29', '2026-10-02'),
    timed('outside-before', '2026-09-28T17:00:00Z', '2026-09-28T18:00:00Z'),
    timed('inside', '2026-10-14T17:00:00Z', '2026-10-14T18:00:00Z'),
    timed('outside-after', '2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z'),
  ];
  assert.equal(cal.calendarMonthEventCount(events, OCTOBER, LA), 2);
});

test('keyboard steps stay on real days and month steps clamp to shorter months', () => {
  assert.equal(cal.calendarAddDays('2026-10-31', 1), '2026-11-01');
  assert.equal(cal.calendarAddDays('2026-11-01', -7), '2026-10-25');
  assert.equal(cal.calendarAddDays('2026-11-01', 1), '2026-11-02', 'the day DST ends is still one day');
  assert.equal(cal.calendarAddMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(cal.calendarAddMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(cal.calendarAddMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(cal.calendarAddMonths('2026-10-14', 12), '2027-10-14');
});

test('summaries, problems and zone names read as plain sentences', () => {
  const ok = { status: 'ok', lastError: null };
  assert.equal(cal.calendarSubscriptionSummary([
    { enabled: true, verification: ok },
    { enabled: true, verification: { status: 'ok', lastError: 'calendar fetch timed out' } },
    { enabled: true, verification: { status: 'invalid', lastError: 'calendar fetch returned HTTP 404' } },
    { enabled: false, verification: { status: 'invalid' } },
  ]), '4 calendars · 3 in use · 2 need attention');
  assert.equal(cal.calendarSubscriptionSummary([{ enabled: true, verification: ok }]), '1 calendar · 1 in use');
  assert.equal(cal.calendarSubscriptionSummary([{ enabled: true, verification: { status: 'unknown' } }]), '1 calendar · 1 in use · 1 needs attention');
  assert.equal(cal.calendarSentence('calendar fetch timed out'), 'Calendar fetch timed out.');
  assert.equal(cal.calendarSentence('Already a sentence.'), 'Already a sentence.');
  assert.equal(cal.calendarSentence(''), '');
  const summer = Date.parse('2026-07-01T12:00:00Z');
  const winter = Date.parse('2026-12-01T12:00:00Z');
  assert.equal(cal.calendarZoneDescription(LA, summer, 'en-US'), 'Pacific Daylight Time (GMT-7)');
  assert.equal(cal.calendarZoneDescription(LA, winter, 'en-US'), 'Pacific Standard Time (GMT-8)');
  assert.equal(cal.calendarZoneDescription('Not/AZone', summer, 'en-US'), 'Not/AZone');
});

test('each of the first six calendars gets its own colour, in list order', () => {
  const subscriptions = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }));
  assert.deepEqual(subscriptions.map((item) => cal.calendarColorIndex(subscriptions, item.id)), [0, 1, 2, 3, 4, 5, 0]);
  assert.equal(cal.calendarColorIndex(subscriptions, 'missing'), -1);
});

test('a month cell gives a short start time', () => {
  const at = (iso) => cal.calendarChipTime(Date.parse(iso), LA, 'en-US').replace(/\s/g, ' ');
  assert.equal(at('2026-10-19T16:00:00Z'), '9 AM');
  assert.equal(at('2026-10-24T05:00:00Z'), '10 PM');
  assert.equal(at('2026-10-14T22:30:00Z'), '3:30 PM');
  assert.equal(cal.calendarChipTime(Date.parse('2026-10-14T22:30:00Z'), LA, 'en-GB'), '15:30');
});
