'use strict';
// S-05 differential probe — pinned original.
//
// Exercises the frozen `jibo-data-utils` DateTime and the baseskill PromptData
// dt surface against the fixture the Phoenix probe consumes.  Output is plain
// JSON so the two can be diffed field-for-field.
//
// usage: S05_SOURCE_ROOT=/path/to/pegasus node s05-datetime-matrix-source.cjs <matrix.json> <out.json>
const fs = require('fs');

const sourceRoot = process.env.S05_SOURCE_ROOT || '/ref';
const dataUtils = require(`${sourceRoot}/node_modules/jibo-data-utils`);
const { DateTime } = dataUtils;
const PromptData = require(`${sourceRoot}/packages/baseskill/lib/graph/mims/utils/slimmer/PromptData.js`).PromptData;
const log = { createChild: function () { return this; }, warn: function () {} };

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const originalNow = Date.now;
const safe = fn => { try { return fn(); } catch (e) { return { error: e && e.message || String(e) }; } };

const PERIODS = ['year', 'month', 'week', 'weekend', 'day', 'morning', 'afternoon', 'evening', 'night', 'hour', 'minute', 'now'];
const OPTION_KEYS = [
  ['str', undefined],
  ['o0', {}],
  ['timeOnly', { timeOnly: true }],
  ['dateOnly', { dateOnly: true }],
  ['display', { display: true }],
  ['drop', { dropPeriod: true }],
  ['displayDrop', { display: true, dropPeriod: true }],
  ['prefix', { prefixOnAt: true }],
  ['prefixDisplay', { prefixOnAt: true, display: true }],
  ['prefixTimeOnly', { prefixOnAt: true, timeOnly: true }],
  ['prefixDateOnly', { prefixOnAt: true, dateOnly: true }],
  ['suppress', { suppressVerbalOutput: true }],
];

function nowSummary(dt) {
  const out = {};
  for (const [key, opts] of OPTION_KEYS) {
    out[key] = safe(() => (opts === undefined ? String(dt) : dt.toString(opts)));
  }
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

function dtFields(pd) {
  const dt = pd.dt || {};
  return {
    date: dt.date, day: dt.day, dayOfWeek: dt.dayOfWeek, dayOfMonth: dt.dayOfMonth,
    dayOfYear: dt.dayOfYear, weekOfYear: dt.weekOfYear, month: dt.month,
    monthOfYear: dt.monthOfYear, quarterOfYear: dt.quarterOfYear, year: dt.year,
    now: safe(() => String(dt.now)), prefix: safe(() => dt.now.toString({ prefixOnAt: true })),
    timeOnly: safe(() => dt.now.toString({ timeOnly: true })), display: safe(() => dt.now.toString({ display: true })),
  };
}

const out = { tz: process.env.TZ || null, seasonDates: spec.seasonDates, dt: [], periods: [], ranges: {}, phrasing: [] };

// --- seasonal windows over the frozen real MIM pair corpus ------------------
let index = 0;
for (const iso of spec.seasonDates) {
  Date.now = () => Date.parse(spec.nows[0]);
  const dt = new DateTime(iso);
  const row = [];
  for (const pair of spec.seasonPairs) row.push(safe(() => dt.isInRange(pair[0], pair[1])) === true ? '1' : '0');
  out.ranges[`#${index}:${iso}`] = row.join('');
  if (index % 7 === 0) {
    out.dt.push({ id: `season-${iso}`, value: { local: safe(() => dt.getLocalTime()), str: safe(() => String(dt)), relDays: safe(() => dt.getRelativeDays()) } });
  }
  index += 1;
}

// --- (now, runtime location iso) matrix ------------------------------------
for (const now of spec.nows) {
  Date.now = () => Date.parse(now);
  for (const iso of spec.dtIsos) {
    const dt = new DateTime(iso);
    out.periods.push({ id: `p|${now}|${iso}`, values: nowSummary(dt), periods: periodSummary(dt), mutations: mutationSummary(dt) });
  }
  out.periods.push({ id: `p|${now}|<absent>`, values: nowSummary(new DateTime()), periods: periodSummary(new DateTime()), mutations: mutationSummary(new DateTime()) });
  out.periods.push({ id: `p|${now}|<null>`, values: nowSummary(new DateTime(null)), periods: periodSummary(new DateTime(null)), mutations: mutationSummary(new DateTime(null)) });
  out.periods.push({ id: `p|${now}|<number>`, values: nowSummary(new DateTime(Date.parse(now))), periods: periodSummary(new DateTime(Date.parse(now))), mutations: mutationSummary(new DateTime(Date.parse(now))) });
}

// --- PromptData date phrasing for every frozen season date -----------------
for (const now of spec.nows) {
  Date.now = () => Date.parse(now);
  for (const iso of spec.seasonDates) {
    out.phrasing.push({ id: `t|${now}|${iso}`, value: safe(() => dtFields(new PromptData({ location: { iso } }, log))) });
  }
}

Date.now = originalNow;
fs.writeFileSync(process.argv[3], JSON.stringify(out));
