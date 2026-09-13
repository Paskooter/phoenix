import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { DateTime } from '../src/report/dateTime.js';
import {
  CommuteMimLogic,
  commuteParse,
  getData,
} from '../src/report/commute.js';
import { trafficView } from '../src/report/commuteViews.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/commute/{CommuteParse,CommuteMimLogic,
// CommuteData,CommuteViews}.ts and packages/report-skill/tests/subskills/Commute.test.js.

const LOCAL_ISO = '2026-06-12T08:00:00-04:00';
const FIXED_NOW = Date.parse(LOCAL_ISO);

function prefs({ complete = true, mode = 'driving', workTime = { hour: 9, min: 0 } } = {}) {
  return { commute: { complete, mode, workTime } };
}

function mapsLeg({ baselineSeconds = 1500, trafficSeconds, includeTraffic = true } = {}) {
  const leg = { duration: { value: baselineSeconds } };
  if (includeTraffic) leg.duration_in_traffic = { value: trafficSeconds };
  return { routes: [{ legs: [leg] }] };
}

async function parse({
  localISO = LOCAL_ISO,
  userPrefs = prefs(),
  calendar,
  mapsData = mapsLeg({ trafficSeconds: 1800 }),
} = {}) {
  return commuteParse(mapsData, localISO, { userPrefs, calendar });
}

function mimData({
  complete = true,
  commute = null,
  singleSkill = null,
  existingPaths = [],
} = {}) {
  return {
    local: {
      userPrefs: { commute: { complete } },
      commute,
      views: {},
      mimPaths: existingPaths,
    },
    skill: { session: { data: { _personalReport: { singleSkill } } } },
  };
}

async function runMim(options = {}) {
  const data = mimData(options);
  const result = await new CommuteMimLogic('Commute Logic').exit(data);
  assert.equal(result.transition, 'Done');
  return data;
}

function mimIds(data) {
  return data.local.mimPaths.map((path) => basename(path, '.mim'));
}

function promptCommute({
  minsLeft = 60,
  modeIsDriving = true,
  extraMins = 0,
  departISO = '2026-06-12T08:30:00-04:00',
} = {}) {
  return {
    minsLeft,
    modeIsDriving,
    extraMins,
    departDT: new DateTime(departISO),
  };
}

async function withFrozenNow(now, callback) {
  mock.timers.enable({ apis: ['Date'], now });
  try {
    return await callback();
  } finally {
    mock.timers.reset();
  }
}

test('S-11 commuteParse uses traffic duration only for driving across every travel mode', async () => {
  const modes = ['driving', 'transit', 'bicycling', 'walking'];
  for (const mode of modes) {
    const parsed = await parse({
      userPrefs: prefs({ mode }),
      mapsData: mapsLeg({ baselineSeconds: 1500, trafficSeconds: 2700 }),
    });
    const driving = mode === 'driving';
    assert.equal(parsed.modeIsDriving, driving, `${mode} driving flag`);
    assert.equal(parsed.durationMins, driving ? 45 : 25, `${mode} duration`);
    assert.equal(parsed.extraMins, 20, `${mode} extra traffic`);
    assert.equal(parsed.minsLeft, driving ? 15 : 35, `${mode} departure timing`);
    assert.equal(parsed.departDT.getLocalTime().hour, driving ? 8 : 8, `${mode} depart hour`);
    assert.equal(parsed.departDT.getLocalTime().minute, driving ? 15 : 35, `${mode} depart minute`);

    const data = await runMim({ commute: parsed });
    assert.deepEqual(
      mimIds(data),
      driving
        ? ['CommuteDriveTerrible', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft']
        : ['CommuteTransportNormal', 'CommuteDepartTimeNormal'],
      `${mode} MIM prefix and traffic behavior`,
    );
  }
});

test('S-11 commuteParse falls back to baseline duration when traffic is absent or zero', async () => {
  const missing = await parse({
    mapsData: mapsLeg({ baselineSeconds: 1500, includeTraffic: false }),
  });
  assert.equal(missing.durationMins, 25);
  assert.equal(missing.extraMins, 0);
  assert.equal(missing.departDT.getLocalTime().minute, 35);
  assert.equal(missing.minsLeft, 35);

  const zero = await parse({
    mapsData: mapsLeg({ baselineSeconds: 1500, trafficSeconds: 0 }),
  });
  assert.equal(zero.durationMins, 25);
  assert.equal(zero.extraMins, 0);
  assert.equal(zero.departDT.getLocalTime().minute, 35);

  const slowerThanBaseline = await parse({
    mapsData: mapsLeg({ baselineSeconds: 1500, trafficSeconds: 1200 }),
  });
  assert.equal(slowerThanBaseline.durationMins, 20);
  assert.equal(slowerThanBaseline.extraMins, 0);
});

test('S-11 commuteParse uses runtime localISO rather than host clock for departure timing', async () => {
  const options = {
    mapsData: mapsLeg({ baselineSeconds: 1500, trafficSeconds: 1800 }),
  };
  const first = await withFrozenNow(FIXED_NOW, () => parse(options));
  const second = await withFrozenNow(FIXED_NOW + 6 * 60 * 60 * 1000, () => parse(options));

  assert.equal(first.arriveDT.utc, Date.parse('2026-06-12T09:00:00-04:00'));
  assert.equal(first.departDT.utc, Date.parse('2026-06-12T08:30:00-04:00'));
  assert.equal(first.minsLeft, 30);
  assert.deepEqual(
    [second.arriveDT.utc, second.departDT.utc, second.minsLeft],
    [first.arriveDT.utc, first.departDT.utc, first.minsLeft],
  );
});

test('S-11 commuteParse chooses an early event only when it is today and ignores full-day events', async () => {
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

  const today = await withFrozenNow(FIXED_NOW, () => parse({
    calendar: { events: [todayEarly] },
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  }));
  assert.equal(today.arriveDT.utc, todayEarly.dateTime.utc);
  assert.equal(today.eventIsEarly, true);
  assert.equal(today.departDT.getLocalTime().minute, 20);
  assert.equal(today.minsLeft, 20);

  const tomorrow = await withFrozenNow(FIXED_NOW, () => parse({
    calendar: { events: [tomorrowEarly] },
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  }));
  assert.equal(tomorrow.arriveDT.utc, Date.parse('2026-06-12T09:00:00-04:00'));
  assert.equal(tomorrow.eventIsEarly, false);

  const allDay = await withFrozenNow(FIXED_NOW, () => parse({
    calendar: { events: [fullDay] },
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  }));
  assert.equal(allDay.arriveDT.utc, Date.parse('2026-06-12T09:00:00-04:00'));
  assert.equal(allDay.eventIsEarly, false);
});

test('S-11 commuteParse fails closed for missing maps, incomplete prefs, and malformed workTime', async () => {
  assert.equal(await parse({ mapsData: null }), undefined);
  assert.equal(await parse({ userPrefs: prefs({ complete: false }) }), undefined);
  assert.equal(await commuteParse(mapsLeg({ trafficSeconds: 600 }), LOCAL_ISO, {}), undefined);

  const defaultWorkTime = await parse({
    userPrefs: { commute: { complete: true, mode: 'driving' } },
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  });
  assert.equal(defaultWorkTime.arriveDT.getLocalTime().hour, 9);
  assert.equal(defaultWorkTime.arriveDT.getLocalTime().minute, 0);

  const malformedWorkTime = await parse({
    userPrefs: prefs({ workTime: null }),
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  });
  assert.equal(malformedWorkTime, undefined);
});

test('S-11 commuteParse still evaluates malformed workTime when an early event is available', async () => {
  const malformedWithEarlyEvent = await withFrozenNow(FIXED_NOW, () => parse({
    userPrefs: prefs({ workTime: null }),
    calendar: {
      events: [{
        isEarly: true,
        fullDay: false,
        dateTime: new DateTime('2026-06-12T08:30:00-04:00'),
      }],
    },
    mapsData: mapsLeg({ baselineSeconds: 600, trafficSeconds: 600 }),
  }));
  assert.equal(malformedWithEarlyEvent, undefined);
});

test('S-11 CommuteData returns source empty fields when preferences are incomplete', async () => {
  const result = await getData({ commute: { complete: false } }, {});
  assert.deepEqual(result, [
    'commute',
    { status: null, geocoded_waypoints: null, routes: null },
  ]);
});

test('S-11 CommuteMimLogic distinguishes AppSetup, ServiceDown, and single-skill confirmation', async () => {
  const appSetup = await runMim({ complete: false });
  assert.deepEqual(mimIds(appSetup), ['CommuteAppSetup']);

  const serviceDown = await runMim({ complete: true, commute: null });
  assert.deepEqual(mimIds(serviceDown), ['CommuteServiceDown']);

  const fullReport = await runMim({ commute: promptCommute({ minsLeft: 60 }) });
  assert.deepEqual(mimIds(fullReport), ['CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.equal(mimIds(fullReport).includes('CommuteConfirmSpeaker'), false);

  const singleSkill = await runMim({
    commute: promptCommute({ minsLeft: 60 }),
    singleSkill: 'commute',
  });
  assert.deepEqual(mimIds(singleSkill), [
    'CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal',
  ]);
});

test('S-11 CommuteMimLogic applies exact departure timing boundaries and source Now/Hurry/Late branches', async () => {
  const cases = [
    [121, ['CommuteNow']],
    [120, ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [30, ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [29, ['CommuteDriveNormal', 'CommuteDepartTimeNormal', 'CommuteMinutesLeft']],
    [0, ['CommuteDriveHurry']],
    [-9, ['CommuteDriveHurry']],
    [-10, ['CommuteDriveLate']],
    [-30, ['CommuteDriveLate']],
    [-31, ['CommuteNow']],
  ];
  for (const [minsLeft, expected] of cases) {
    const data = await runMim({ commute: promptCommute({ minsLeft }) });
    assert.deepEqual(mimIds(data), expected, `minsLeft ${minsLeft}`);
  }
});

test('S-11 traffic severity uses Normal below 5, Bad at 5, and Terrible at 15', async () => {
  const cases = [
    [0, 'Normal', ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [4, 'Normal', ['CommuteDriveNormal', 'CommuteDepartTimeNormal']],
    [5, 'Bad', ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal']],
    [14, 'Bad', ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal']],
    [15, 'Terrible', ['CommuteDriveTerrible', 'CommuteDepartTimeNotNormal']],
  ];
  for (const [extraMins, condition, expected] of cases) {
    const data = await runMim({ commute: promptCommute({ minsLeft: 60, extraMins }) });
    assert.deepEqual(mimIds(data), expected, `extraMins ${extraMins}`);
    assert.match(
      data.local.views.commuteTraffic.componentConfigs[0].assets[0].src,
      new RegExp(`traffic${condition}_v01\\.crn$`),
      `traffic view ${extraMins}`,
    );
  }

  const direct = await Promise.all([
    trafficView(4), trafficView(5), trafficView(15),
  ]);
  assert.deepEqual(direct.map((view) => view.componentConfigs[0].assets[0].src), [
    'assets/personal-report-skill/commute/trafficNormal_v01.crn',
    'assets/personal-report-skill/commute/trafficBad_v01.crn',
    'assets/personal-report-skill/commute/trafficTerrible_v01.crn',
  ]);
});

test('S-11 non-driving modes keep Normal MIMs even when traffic has extra minutes', async () => {
  const data = await runMim({
    commute: promptCommute({ minsLeft: 20, modeIsDriving: false, extraMins: 30 }),
  });
  assert.deepEqual(mimIds(data), [
    'CommuteTransportNormal', 'CommuteDepartTimeNormal', 'CommuteMinutesLeft',
  ]);
  assert.match(
    data.local.views.commuteTraffic.componentConfigs[0].assets[0].src,
    /trafficTerrible_v01\.crn$/,
  );
});

test('S-11 preserves existing MIM paths when commute appends its result', async () => {
  const data = await runMim({
    existingPaths: ['/prior/path.mim'],
    commute: promptCommute({ minsLeft: 60 }),
  });
  assert.equal(data.local.mimPaths[0], '/prior/path.mim');
  assert.deepEqual(mimIds(data).slice(1), ['CommuteDriveNormal', 'CommuteDepartTimeNormal']);
});
