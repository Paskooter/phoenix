import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';

import { DateTime } from '../src/report/dateTime.js';
import { commuteParse, CommuteMimLogic } from '../src/report/commute.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/commute/CommuteParse.ts (lines 53-68),
// packages/report-skill/src/subskills/calendar/CalendarParse.ts (lines 75-97),
// packages/report-skill/src/subskills/commute/CommuteMimLogic.ts (lines 57-98),
// and packages/report-skill/src/utils.ts (lines 19-22).  The source uses the
// fixed ISO offset carried by jibo-data-utils DateTime, floors route seconds
// through secondsToMinutes, rounds the UTC departure delta, and applies strict
// MIM inequalities.  These tests keep those calculations deterministic.

const SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
const LOCAL_ISO = '2026-06-12T08:00:00-04:00';

function prefs({ mode = 'driving', workTime = { hour: 9, min: 0 } } = {}) {
  return { commute: { complete: true, mode, workTime: { ...workTime } } };
}

function mapsLeg({ baselineSeconds = 1500, trafficSeconds, includeTraffic = true } = {}) {
  const leg = { duration: { value: baselineSeconds } };
  if (includeTraffic) leg.duration_in_traffic = { value: trafficSeconds };
  return { routes: [{ legs: [leg] }] };
}

async function parseRoute({
  localISO = LOCAL_ISO,
  mode = 'driving',
  workTime = { hour: 9, min: 0 },
  calendar = { events: [] },
  baselineSeconds = 1500,
  trafficSeconds,
  includeTraffic = true,
} = {}) {
  return commuteParse(
    mapsLeg({ baselineSeconds, trafficSeconds, includeTraffic }),
    localISO,
    { userPrefs: prefs({ mode, workTime }), calendar },
  );
}

async function withFrozenNow(nowISO, callback) {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(nowISO) });
  try {
    return await callback();
  } finally {
    mock.timers.reset();
  }
}

function localParts(dateTime) {
  const { year, monthNum, date, hour, minute } = dateTime.getLocalTime();
  return { year, monthNum, date, hour, minute };
}

async function runLogic({ minsLeft, extraMins = 0, modeIsDriving = true } = {}) {
  const mode = modeIsDriving ? 'driving' : 'transit';
  const data = {
    local: {
      userPrefs: { commute: { complete: true, mode } },
      commute: {
        minsLeft,
        extraMins,
        modeIsDriving,
        eventIsEarly: false,
        durationMins: 25,
        departDT: new DateTime(LOCAL_ISO),
        arriveDT: new DateTime('2026-06-12T09:00:00-04:00'),
      },
      views: {},
      mimPaths: [],
    },
    skill: { session: { data: { _personalReport: { singleSkill: null } } } },
  };
  const result = await new CommuteMimLogic('Commute Mim Logic').exit(data);
  assert.equal(result.transition, 'Done');
  return {
    ids: data.local.mimPaths.map((path) => basename(path, '.mim')),
    views: data.local.views,
  };
}

test('S-11 frozen parser preserves source offsets through midnight, half-hour offsets, and DST offset changes', async () => {
  assert.equal(SOURCE_REVISION, '5c0a7390539663ba749d360de348a428c088505c');

  const cases = [
    {
      name: 'negative offset rolls departure into the prior local date',
      now: '2026-06-12T04:00:00Z',
      localISO: '2026-06-12T00:00:00-04:00',
      workTime: { hour: 0, min: 15 },
      baselineSeconds: 1800,
      trafficSeconds: 1800,
      arrivalUTC: '2026-06-12T04:15:00Z',
      departUTC: '2026-06-12T03:45:00Z',
      departLocal: { year: 2026, monthNum: 5, date: 11, hour: 23, minute: 45 },
      minsLeft: -15,
    },
    {
      name: 'UTC+14 keeps the local date while UTC rolls back a day',
      now: '2026-06-11T10:00:00Z',
      localISO: '2026-06-12T00:00:00+14:00',
      workTime: { hour: 0, min: 15 },
      baselineSeconds: 1800,
      trafficSeconds: 1800,
      arrivalUTC: '2026-06-11T10:15:00Z',
      departUTC: '2026-06-11T09:45:00Z',
      departLocal: { year: 2026, monthNum: 5, date: 11, hour: 23, minute: 45 },
      minsLeft: -15,
    },
    {
      name: 'UTC-12 keeps the local date while UTC remains on the next date',
      now: '2026-06-12T12:00:00Z',
      localISO: '2026-06-12T00:00:00-12:00',
      workTime: { hour: 0, min: 15 },
      baselineSeconds: 1800,
      trafficSeconds: 1800,
      arrivalUTC: '2026-06-12T12:15:00Z',
      departUTC: '2026-06-12T11:45:00Z',
      departLocal: { year: 2026, monthNum: 5, date: 11, hour: 23, minute: 45 },
      minsLeft: -15,
    },
    {
      name: 'half-hour offset is retained in local departure arithmetic',
      now: '2026-06-12T02:30:00Z',
      localISO: '2026-06-12T08:00:00+05:30',
      workTime: { hour: 9, min: 0 },
      baselineSeconds: 1500,
      trafficSeconds: 1500,
      arrivalUTC: '2026-06-12T03:30:00Z',
      departUTC: '2026-06-12T03:05:00Z',
      departLocal: { year: 2026, monthNum: 5, date: 12, hour: 8, minute: 35 },
      minsLeft: 35,
    },
  ];

  for (const vector of cases) {
    const parsed = await withFrozenNow(vector.now, () => parseRoute(vector));
    assert.equal(parsed.arriveDT.utc, Date.parse(vector.arrivalUTC), `${vector.name}: arrival UTC`);
    assert.equal(parsed.departDT.utc, Date.parse(vector.departUTC), `${vector.name}: departure UTC`);
    assert.deepEqual(localParts(parsed.departDT), vector.departLocal, `${vector.name}: local departure`);
    assert.equal(parsed.minsLeft, vector.minsLeft, `${vector.name}: minutes left`);
  }

  const dst = await withFrozenNow('2026-03-08T06:30:00Z', () => parseRoute({
    localISO: '2026-03-08T01:30:00-05:00',
    workTime: { hour: 9, min: 0 },
    baselineSeconds: 1800,
    trafficSeconds: 1800,
    calendar: {
      events: [{
        isEarly: true,
        fullDay: false,
        dateTime: new DateTime('2026-03-08T03:00:00-04:00'),
      }],
    },
  }));
  assert.equal(dst.arriveDT.utc, Date.parse('2026-03-08T07:00:00Z'), 'DST event arrival instant');
  assert.deepEqual(localParts(dst.arriveDT), {
    year: 2026, monthNum: 2, date: 8, hour: 3, minute: 0,
  }, 'DST event keeps its -04:00 wall clock');
  assert.equal(dst.departDT.utc, Date.parse('2026-03-08T06:30:00Z'), 'DST departure instant');
  assert.deepEqual(localParts(dst.departDT), {
    year: 2026, monthNum: 2, date: 8, hour: 2, minute: 30,
  }, 'DST departure subtracts duration in the event offset');
  assert.equal(dst.minsLeft, 0, 'DST event is exactly due');
  assert.equal(dst.eventIsEarly, true, 'DST event is today in its carried offset');
});

test('S-11 early-event selection matches source today/tomorrow/full-day and first-early ordering', async () => {
  const todayEarly = {
    isEarly: true,
    fullDay: false,
    dateTime: new DateTime('2026-06-12T08:30:00-04:00'),
  };
  const tomorrowEarly = {
    isEarly: true,
    fullDay: false,
    dateTime: new DateTime('2026-06-13T08:30:00-04:00'),
  };
  const fullDay = {
    isEarly: false,
    fullDay: true,
    dateTime: new DateTime('2026-06-12T00:00:00-04:00'),
  };

  const cases = [
    {
      name: 'today early event replaces work arrival',
      events: [todayEarly],
      arrivalUTC: '2026-06-12T12:30:00Z',
      departUTC: '2026-06-12T12:20:00Z',
      minsLeft: 20,
      eventIsEarly: true,
    },
    {
      name: 'first early event tomorrow blocks a later today event',
      events: [tomorrowEarly, todayEarly],
      arrivalUTC: '2026-06-12T13:00:00Z',
      departUTC: '2026-06-12T12:50:00Z',
      minsLeft: 50,
      eventIsEarly: false,
    },
    {
      name: 'full-day event does not become an early arrival',
      events: [fullDay],
      arrivalUTC: '2026-06-12T13:00:00Z',
      departUTC: '2026-06-12T12:50:00Z',
      minsLeft: 50,
      eventIsEarly: false,
    },
    {
      name: 'full-day event is skipped before a real early event',
      events: [fullDay, todayEarly],
      arrivalUTC: '2026-06-12T12:30:00Z',
      departUTC: '2026-06-12T12:20:00Z',
      minsLeft: 20,
      eventIsEarly: true,
    },
  ];

  for (const vector of cases) {
    const parsed = await withFrozenNow('2026-06-12T12:00:00Z', () => parseRoute({
      localISO: LOCAL_ISO,
      workTime: { hour: 9, min: 0 },
      baselineSeconds: 600,
      trafficSeconds: 600,
      calendar: { events: vector.events },
    }));
    assert.equal(parsed.arriveDT.utc, Date.parse(vector.arrivalUTC), `${vector.name}: arrival`);
    assert.equal(parsed.departDT.utc, Date.parse(vector.departUTC), `${vector.name}: departure`);
    assert.equal(parsed.minsLeft, vector.minsLeft, `${vector.name}: minutes left`);
    assert.equal(parsed.eventIsEarly, vector.eventIsEarly, `${vector.name}: early flag`);
  }
});

test('S-11 parser preserves source floor, fallback, and negative traffic-delta behavior', async () => {
  const cases = [
    {
      name: 'sub-minute route', baselineSeconds: 59, trafficSeconds: 59,
      durationMins: 0, extraMins: 0, departUTC: '2026-06-12T12:59:01Z', minsLeft: 59,
    },
    {
      name: 'seconds below extra-minute floor', baselineSeconds: 60, trafficSeconds: 119,
      durationMins: 1, extraMins: 0, departUTC: '2026-06-12T12:58:01Z', minsLeft: 58,
    },
    {
      name: 'exact extra-minute floor', baselineSeconds: 60, trafficSeconds: 120,
      durationMins: 2, extraMins: 1, departUTC: '2026-06-12T12:58:00Z', minsLeft: 58,
    },
    {
      name: 'missing traffic duration falls back to baseline', baselineSeconds: 1500,
      includeTraffic: false, durationMins: 25, extraMins: 0,
      departUTC: '2026-06-12T12:35:00Z', minsLeft: 35,
    },
    {
      name: 'zero traffic duration falls back to baseline', baselineSeconds: 1500,
      trafficSeconds: 0, durationMins: 25, extraMins: 0,
      departUTC: '2026-06-12T12:35:00Z', minsLeft: 35,
    },
    {
      name: 'negative delta still uses positive traffic duration but clamps extra',
      baselineSeconds: 120, trafficSeconds: 59,
      durationMins: 0, extraMins: 0, departUTC: '2026-06-12T12:59:01Z', minsLeft: 59,
    },
    {
      name: 'non-driving ignores traffic for duration', baselineSeconds: 120,
      trafficSeconds: 179, mode: 'transit', durationMins: 2, extraMins: 0,
      departUTC: '2026-06-12T12:58:00Z', minsLeft: 58,
    },
  ];

  for (const vector of cases) {
    const parsed = await withFrozenNow('2026-06-12T12:00:00Z', () => parseRoute({
      localISO: LOCAL_ISO,
      mode: vector.mode,
      baselineSeconds: vector.baselineSeconds,
      trafficSeconds: vector.trafficSeconds,
      includeTraffic: vector.includeTraffic,
    }));
    assert.equal(parsed.durationMins, vector.durationMins, `${vector.name}: duration floor`);
    assert.equal(parsed.extraMins, vector.extraMins, `${vector.name}: extra floor/clamp`);
    assert.equal(parsed.departDT.utc, Date.parse(vector.departUTC), `${vector.name}: departure`);
    assert.equal(parsed.minsLeft, vector.minsLeft, `${vector.name}: minutes left`);
  }
});

test('S-11 Math.round minutes-left keeps both positive and negative half ties', async () => {
  const cases = [
    {
      name: '+30.5 rounds up', workTime: { hour: 9, min: 0 }, seconds: 1770,
      departUTC: '2026-06-12T12:30:30Z', expected: 31,
    },
    {
      name: '+29.5 rounds up to the timing boundary', workTime: { hour: 9, min: 0 }, seconds: 1830,
      departUTC: '2026-06-12T12:29:30Z', expected: 30,
    },
    {
      name: '-9.5 rounds toward positive infinity', workTime: { hour: 8, min: 0 }, seconds: 570,
      departUTC: '2026-06-12T11:50:30Z', expected: -9,
    },
    {
      name: '-10.5 rounds toward positive infinity', workTime: { hour: 8, min: 0 }, seconds: 630,
      departUTC: '2026-06-12T11:49:30Z', expected: -10,
    },
    {
      name: '-0.5 preserves JavaScript negative zero', workTime: { hour: 8, min: 0 }, seconds: 30,
      departUTC: '2026-06-12T11:59:30Z', expected: -0,
    },
  ];

  for (const vector of cases) {
    const parsed = await withFrozenNow('2026-06-12T12:00:00Z', () => parseRoute({
      localISO: LOCAL_ISO,
      workTime: vector.workTime,
      baselineSeconds: vector.seconds,
      trafficSeconds: vector.seconds,
    }));
    assert.equal(parsed.departDT.utc, Date.parse(vector.departUTC), `${vector.name}: departure`);
    if (Object.is(vector.expected, -0)) assert.equal(Object.is(parsed.minsLeft, -0), true, vector.name);
    else assert.equal(parsed.minsLeft, vector.expected, vector.name);
  }
});

test('S-11 MIM logic keeps every timing edge and floored traffic severity edge', async () => {
  const timingCases = [
    [121, ['CommuteNow']],
    [120, ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [30, ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [29, ['CommuteDriveNormal', 'CommuteDepartTimeNormal', 'CommuteMinutesLeft']],
    [1, ['CommuteDriveNormal', 'CommuteDepartTimeNormal', 'CommuteMinutesLeft']],
    [0, ['CommuteDriveHurry']],
    [-0, ['CommuteDriveHurry']],
    [-9, ['CommuteDriveHurry']],
    [-10, ['CommuteDriveLate']],
    [-30, ['CommuteDriveLate']],
    [-31, ['CommuteNow']],
  ];
  for (const [minsLeft, expected] of timingCases) {
    const actual = await runLogic({ minsLeft });
    assert.deepEqual(actual.ids, expected, `minsLeft=${minsLeft}`);
    if (minsLeft > 0 && minsLeft <= 120) {
      assert.deepEqual(Object.keys(actual.views).sort(), ['commuteDepart', 'commuteTraffic']);
    } else {
      assert.deepEqual(actual.views, {}, `minsLeft=${minsLeft}: terminal branch has no views`);
    }
  }

  const trafficCases = [
    [299, 4, ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [300, 5, ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal']],
    [899, 14, ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal']],
    [900, 15, ['CommuteDriveTerrible', 'CommuteDepartTimeNotNormal']],
  ];
  for (const [deltaSeconds, expectedExtra, expected] of trafficCases) {
    const parsed = await withFrozenNow('2026-06-12T12:00:00Z', () => parseRoute({
      localISO: LOCAL_ISO,
      baselineSeconds: 600,
      trafficSeconds: 600 + deltaSeconds,
    }));
    assert.equal(parsed.extraMins, expectedExtra, `traffic delta ${deltaSeconds}: floor`);
    const actual = await runLogic({ minsLeft: parsed.minsLeft, extraMins: parsed.extraMins });
    assert.deepEqual(actual.ids, expected, `traffic delta ${deltaSeconds}: MIMs`);
  }
});
