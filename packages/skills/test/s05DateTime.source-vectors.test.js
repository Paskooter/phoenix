import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DateTime, dateTimeConstants } from '../src/graph/mims/dateTime.js';
import { buildPromptData } from '../src/graph/mims/promptData.js';

// Every expectation in the golden fixture was recorded by running the PINNED
// original (jibo-data-utils 3.0.1 + baseskill PromptData.ts) through
// packages/skills/tools/s05-datetime-matrix-source.cjs under a UTC host.  The
// fixture holds the real `isInRange` argument pairs lifted verbatim from the
// vendored MIM corpus, so the seasonal windows are pinned to production inputs
// rather than to invented ones.
const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 's05-datetime-golden.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

const PERIODS = ['year', 'month', 'week', 'weekend', 'day', 'morning', 'afternoon', 'evening', 'night', 'hour', 'minute', 'now'];
const OPTION_KEYS = [
  ['str', undefined], ['o0', {}], ['timeOnly', { timeOnly: true }], ['dateOnly', { dateOnly: true }],
  ['display', { display: true }], ['drop', { dropPeriod: true }], ['displayDrop', { display: true, dropPeriod: true }],
  ['prefix', { prefixOnAt: true }], ['prefixDisplay', { prefixOnAt: true, display: true }],
  ['prefixTimeOnly', { prefixOnAt: true, timeOnly: true }], ['prefixDateOnly', { prefixOnAt: true, dateOnly: true }],
  ['suppress', { suppressVerbalOutput: true }],
];

function withNow(now, fn) {
  const original = Date.now;
  Date.now = () => Date.parse(now);
  try { return fn(); } finally { Date.now = original; }
}
const safe = fn => { try { return fn(); } catch (e) { return { error: e && e.message || String(e) }; } };
// The golden was serialised to JSON, so NaN becomes null and undefined keys
// disappear.  Normalise the live values the same way before comparing.
const asJSON = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function nowSummary(dt) {
  const out = {};
  for (const [key, opts] of OPTION_KEYS) out[key] = safe(() => (opts === undefined ? String(dt) : dt.toString(opts)));
  out.local = safe(() => dt.getLocalTime());
  out.mmdd = safe(() => dt.getLocalMMDD());
  out.yyyymmdd = safe(() => dt.getLocalYYYYMMDD());
  out.relDays = safe(() => dt.getRelativeDays());
  out.relHours = safe(() => dt.getRelativeHours());
  out.isFuture = safe(() => dt.isFuture());
  out.isPast = safe(() => dt.isPast());
  out.iso = safe(() => dt.toISOString());
  out.json = safe(() => dt.toJSON());
  out.clone = safe(() => dt.clone().toJSON());
  out.toMoment = safe(() => dt.toMoment());
  return out;
}

function periodSummary(dt) {
  const out = {};
  for (const period of PERIODS) {
    const clone = dt.clone();
    clone.timePeriod = period;
    out[period] = {
      str: safe(() => String(clone)),
      display: safe(() => clone.toString({ display: true })),
      timeOnly: safe(() => clone.toString({ timeOnly: true })),
      dateOnly: safe(() => clone.toString({ dateOnly: true })),
      prefix: safe(() => clone.toString({ prefixOnAt: true })),
      prefixDisplay: safe(() => clone.toString({ prefixOnAt: true, display: true })),
      prefixTimeOnly: safe(() => clone.toString({ prefixOnAt: true, timeOnly: true })),
      displayDrop: safe(() => clone.toString({ display: true, dropPeriod: true })),
      relDays: safe(() => clone.getRelativeDays()),
      isPast: safe(() => clone.isPast()),
      toMoment: safe(() => clone.toMoment()),
      json: safe(() => clone.toJSON()),
    };
  }
  return out;
}

function mutationSummary(dt) {
  const run = fn => safe(() => { const copy = dt.clone(); fn(copy); return { json: copy.toJSON(), str: safe(() => String(copy)) }; });
  const byPeriod = fn => {
    const out = {};
    for (const period of PERIODS) out[period] = run(c => { c.timePeriod = period; fn(c); });
    return out;
  };
  return {
    addDays1: run(c => c.addDays(1)),
    addDaysNeg1Zero: run(c => c.addDays(-1, true)),
    addDaysZeroZero: run(c => c.addDays(0, true)),
    addHours3: run(c => c.addHours(3)),
    addHoursZero: run(c => c.addHours(3, true)),
    addHoursNeg: run(c => c.addHours(-25)),
    addYear1: run(c => c.addYear(1)),
    addYearNeg1: run(c => c.addYear(-1)),
    setTimeHM: run(c => c.setTime(15, 30)),
    setTimeH: run(c => c.setTime(15)),
    setTimeMidnight: run(c => c.setTime(24, 0)),
    stripTime: run(c => c.stripTime()),
    stripTimeByPeriod: byPeriod(c => c.stripTime()),
    jumpNext: run(c => c.jumpToNextDayPeriod()),
    jumpNextByPeriod: byPeriod(c => c.jumpToNextDayPeriod()),
    escape: run(c => c.setTime(NaN, NaN)),
  };
}

function locationSummary(home) {
  return {
    city: home.city, state: home.state, stateAbbr: home.stateAbbr, country: home.country,
    countryCode: home.countryCode, lat: home.lat, lng: home.lng,
    string: safe(() => String(home)), prefix: safe(() => home.prefixIn()), standard: safe(() => home.getStandardName()),
    log: safe(() => home.toLog()), isLocal: safe(() => home.isLocal), json: safe(() => home.toJSON()),
    regions: {
      us: safe(() => home.isInRegion('US')), usma: safe(() => home.isInRegion('US-MA')),
      ca: safe(() => home.isInRegion('CA')), array: safe(() => home.isInRegion(['CA', 'US'])),
      emptyArray: safe(() => home.isInRegion([])),
      number: safe(() => home.isInRegion(42)),
      sparseObject: safe(() => home.isInRegion({ length: 1, 0: 'CA' })),
      nullRegions: safe(() => home.isInRegion(null)),
    },
    equalsNull: safe(() => home.equals(null)),
    equalsSelf: safe(() => home.equals(home)),
  };
}

test('S-05 seasonal windows reproduce every pinned isInRange bit for the real MIM pair corpus', () => {
  const { pairs, rows } = golden.isInRange;
  assert.equal(pairs.length, 852, 'the fixture must carry the extracted MIM corpus');
  for (const row of rows) {
    const actual = withNow('2020-06-15T18:45:30.000Z', () => {
      const dt = new DateTime(row.iso);
      return pairs.map(([start, end]) => (dt.isInRange(start, end) === true ? '1' : '0')).join('');
    });
    assert.equal(actual, row.bits, `isInRange bits for ${row.iso}`);
  }
});

test('S-05 date phrasing matches the pinned original for every recorded context', () => {
  for (const record of golden.phrasing) {
    const actual = withNow(record.now, () => {
      const data = buildPromptData({ location: { iso: record.iso } });
      const dt = data.dt;
      return {
        date: dt.date, day: dt.day, dayOfWeek: dt.dayOfWeek, dayOfMonth: dt.dayOfMonth,
        dayOfYear: dt.dayOfYear, weekOfYear: dt.weekOfYear, month: dt.month,
        monthOfYear: dt.monthOfYear, quarterOfYear: dt.quarterOfYear, year: dt.year,
        now: safe(() => String(dt.now)), prefix: safe(() => dt.now.toString({ prefixOnAt: true })),
        timeOnly: safe(() => dt.now.toString({ timeOnly: true })), display: safe(() => dt.now.toString({ display: true })),
      };
    });
    assert.deepEqual(asJSON(actual), record.fields, `phrasing for ${record.now} / ${record.iso}`);
  }
});

test('S-05 DateTime string/time-period matrix matches the pinned original', () => {
  for (const record of golden.stringMatrix) {
    withNow(record.now, () => {
      const dt = new DateTime(record.iso);
      assert.deepEqual(asJSON(nowSummary(dt)), record.values, `now summary ${record.now} / ${record.iso}`);
      assert.deepEqual(asJSON(periodSummary(dt)), record.periods, `period matrix ${record.now} / ${record.iso}`);
    });
  }
});

test('S-05 DateTime mutation surface matches the pinned original', () => {
  for (const record of golden.mutEdges) {
    withNow(record.now, () => {
      assert.deepEqual(asJSON(mutationSummary(new DateTime(record.iso))), record.mutations, `mutations ${record.now} / ${record.iso}`);
    });
  }
});

test('S-05 location values and thrown messages match the pinned original', () => {
  for (const record of golden.locations) {
    const data = withNow('2018-05-22T23:21:00.159Z', () => buildPromptData({ location: record.input }));
    assert.deepEqual(asJSON(locationSummary(data.location.home)), record.expect.home, `location ${record.id}`);
    for (const key of ['city', 'state', 'stateAbbr', 'country', 'countryCode', 'lat', 'lng']) {
      assert.deepEqual(asJSON(data.location[key]), record.expect[key], `location ${record.id}.${key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Named edge vectors: readable pins for the behaviours the matrix above locks
// in bulk.  Expected values were read from the pinned jibo-data-utils 3.0.1
// bundle (lib/jibo-data-utils.js) and confirmed by running it.
// ---------------------------------------------------------------------------

test('S-05 getOrdinal special-cases only 11-19', () => {
  const { ordinal } = dateTimeConstants;
  assert.equal(ordinal(0), 'zero');
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(31), '31st');
  assert.equal(ordinal(110), '110th');
  assert.equal(ordinal(111), '111st');
  assert.equal(ordinal(112), '112nd');
  assert.equal(ordinal(113), '113rd');
});

test('S-05 stripTime only collapses time-bearing periods', () => {
  const base = new DateTime('2020-02-29T23:30:00.000-05:00');
  for (const period of ['year', 'month', 'week', 'weekend', 'day', null]) {
    const dt = base.clone();
    dt.timePeriod = period;
    dt.stripTime();
    assert.equal(dt.timePeriod, period, `stripTime must leave ${period} alone`);
    assert.equal(dt.utc, base.utc, `stripTime must not move ${period}`);
  }
  for (const period of ['hour', 'minute', 'morning', 'afternoon', 'evening', 'night', 'now']) {
    const dt = base.clone();
    dt.timePeriod = period;
    dt.stripTime();
    assert.equal(dt.timePeriod, 'day', `stripTime must collapse ${period}`);
    assert.equal(dt.toJSON().timezone.offsetUTC, -18000000);
    assert.equal(dt.toISOString(), '2020-02-29T00:00:00.000-05:00');
    assert.equal(withNow('2020-02-29T04:30:00.000Z', () => String(dt)), 'tomorrow');
  }
});

test('S-05 jumpToNextDayPeriod buckets match the source thresholds', () => {
  const at = hour => new DateTime(`2020-06-13T${String(hour).padStart(2, '0')}:30:00.000-05:00`);
  const cases = [
    [5, 'morning', 5, '2020-06-13T06:00:00.000-05:00'],
    [11, 'afternoon', 6, '2020-06-13T12:00:00.000-05:00'],
    [17, 'evening', 4, '2020-06-13T18:00:00.000-05:00'],
    [21, 'night', 7, '2020-06-13T22:00:00.000-05:00'],
    [23, 'minute', 0, '2020-06-14T06:00:00.000-05:00'],
  ];
  for (const [hour, period, durationHours, iso] of cases) {
    const dt = at(hour);
    dt.jumpToNextDayPeriod();
    assert.equal(dt.timePeriod, period, `period after ${hour}:30`);
    assert.equal(dt.durationHours, durationHours, `duration after ${hour}:30`);
    assert.equal(dt.toISOString(), iso, `instant after ${hour}:30`);
  }
});

test('S-05 toMoment phrasing matches the source ladder', () => {
  const now = Date.parse('2020-06-15T18:45:30.000Z');
  const momentOf = (iso, current = now) => withNow(new Date(current).toISOString(), () => new DateTime(iso).toMoment());
  assert.equal(momentOf('2020-06-15T19:00:00.000Z'), 'The Future');
  assert.equal(momentOf('2020-06-15T18:40:00.000Z'), 'Just Now');
  assert.equal(momentOf('2020-06-15T18:00:30.000Z'), '45m ago');
  assert.equal(momentOf('2020-06-15T12:45:30.000Z'), '6h ago');
  assert.equal(momentOf('2020-06-14T17:45:30.000Z'), 'Yesterday');
  assert.equal(momentOf('2020-06-10T18:45:30.000Z'), '5d ago');
  assert.equal(momentOf('2020-05-10T18:45:30.000Z'), 'May 10th');
  assert.equal(momentOf('2019-05-10T18:45:30.000Z'), 'May 10 2019');
});

test('S-05 getLocalYYYYMMDD concatenates the raw year like the source', () => {
  const dt = new DateTime('2020-02-29T23:30:00.000-05:00');
  assert.equal(dt.getLocalYYYYMMDD(), '20200229');
  assert.equal(dt.getLocalMMDD(), '0229');
  assert.equal(new DateTime('0500-02-28T12:00:00.000Z').getLocalYYYYMMDD(), '5000228');
});

test('S-05 location throws for non-string fields instead of coercing them', () => {
  const data = buildPromptData({
    location: { iso: '2018-05-22T19:21:00.159-04:00', city: 42, state: 43, country: 44, countryCode: 'US', stateAbbr: 'zz' },
  });
  const home = data.location.home;
  assert.throws(() => String(home), { name: 'TypeError', message: 'str.replace is not a function' });
  assert.throws(() => home.getStandardName(), { name: 'TypeError', message: 'strA.toLowerCase is not a function' });
  assert.throws(() => home.prefixIn(), { name: 'TypeError', message: 'strA.toLowerCase is not a function' });
  assert.throws(() => home.isLocal, { name: 'TypeError', message: 'strA.toLowerCase is not a function' });
  assert.throws(() => home.equals(null), { name: 'TypeError', message: "Cannot read properties of null (reading 'city')" });
  assert.throws(() => home.isInRegion(null), { name: 'TypeError', message: "Cannot read properties of null (reading 'length')" });
});

test('S-05 part-of-day input dates are read as the robot wall clock, not the host clock', () => {
  // getTimezonedDate-style encoding: wall clock carried as a UTC instant.
  const wall = new Date(Date.UTC(2026, 5, 13, 10, 0, 0));
  assert.equal(wall.getUTCHours(), 10);
  const dt = new DateTime('2026-06-13T10:00:00.000-04:00');
  assert.equal(dt.getLocalTime().hour, 10);
  assert.equal(dt.getLocalTime().dayOfWeek, 'saturday');
});
