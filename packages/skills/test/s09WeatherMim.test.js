import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { DateTime } from '../src/report/dateTime.js';
import { WeatherMimLogic } from '../src/report/weather.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/weather/WeatherMimLogic.ts and
// packages/report-skill/tests/subskills/Weather.test.js.  The source uses the
// fixed-offset DateTime local hour and queues Intro, condition/comment,
// WetNowDryLater, then high/low in that order.

const DAY_ISO = '2026-06-12T12:00:00-04:00';

function weather(overrides = {}) {
  const result = {
    yest: { icon: 'clear-day', highTemp: 60, lowTemp: 45, summary: 'Yesterday.' },
    today: { icon: 'clear-day', highTemp: 65, lowTemp: 50, summary: 'Today.' },
    tomorrow: { icon: 'rain', highTemp: 66, lowTemp: 51, summary: 'Tomorrow.' },
    current: { icon: 'cloudy', temp: 60, summary: 'Now.' },
    useCelsius: false,
  };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value === null ? null : Object.assign(result[key] || {}, value);
  }
  return result;
}

function makeData({ iso = DAY_ISO, weatherData = {}, singleSkill = null, entities = {} } = {}) {
  return {
    local: { weather: weatherData === null ? null : weather(weatherData), views: {} },
    runtime: { location: { iso } },
    skill: { session: { data: { _personalReport: { singleSkill, nlu: { entities } } } } },
  };
}

async function run(options = {}) {
  const data = makeData(options);
  await new WeatherMimLogic('Weather Logic').exit(data);
  return data;
}

function mimIds(data) {
  return data.local.mimPaths.map((path) => basename(path, '.mim'));
}

async function withHostTimezone(timezone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('S-09 uses the runtime ISO offset at every 3am/6pm daytime boundary', async () => {
  // UTC makes the old Date#getHours implementation fail for at least one
  // side of every non-zero offset while keeping the expected result explicit.
  await withHostTimezone('UTC', async () => {
    const boundaries = [
      { hour: '02:59', daytime: false },
      { hour: '03:00', daytime: true },
      { hour: '17:59', daytime: true },
      { hour: '18:00', daytime: false },
    ];
    for (const offset of ['+09:00', '-08:00']) {
      for (const boundary of boundaries) {
        const iso = `2026-06-12T${boundary.hour}:00${offset}`;
        const actualHour = new DateTime(iso).getLocalTime().hour;
        assert.equal(actualHour, Number(boundary.hour.slice(0, 2)), `${iso} local hour`);
        const data = await run({ iso });
        const expected = boundary.daytime
          ? [
            'WeatherIntro', 'WeatherCommentClearDay', 'WeatherTodayHighLow',
          ]
          : [
            'WeatherIntroTomorrow', 'WeatherCommentRain', 'WeatherTomorrowHighLow',
          ];
        assert.deepEqual(mimIds(data), expected, `${iso} ordered MIMs`);
      }
    }
  });
});

test('S-09 queues every source condition-change branch in source order', async () => {
  const cases = [
    ['cloudy to clear', { yest: { icon: 'cloudy' }, today: { icon: 'clear-day' } }, 'WeatherChangeCloudyClear'],
    ['cloudy to wet', { yest: { icon: 'cloudy' }, today: { icon: 'rain' } }, 'WeatherChangeCloudyWet'],
    ['wet to clear', { yest: { icon: 'rain' }, today: { icon: 'clear-day' } }, 'WeatherChangeWetClear'],
    ['clear to wet', { yest: { icon: 'clear-day' }, today: { icon: 'rain' } }, 'WeatherChangeClearWet'],
  ];
  for (const [name, weatherData, conditionMim] of cases) {
    const data = await run({ weatherData });
    assert.deepEqual(
      mimIds(data),
      ['WeatherIntro', conditionMim, 'WeatherTodayHighLow'],
      `${name} MIM order`,
    );
  }
});

test('S-09 preserves WetNowDryLater placement and wet-now negative branch', async () => {
  const dryLater = await run({ weatherData: {
    current: { icon: 'sleet' },
    today: { icon: 'clear-day' },
  } });
  assert.deepEqual(mimIds(dryLater), [
    'WeatherIntro', 'WeatherCommentClearDay', 'WeatherWetNowDryLater', 'WeatherTodayHighLow',
  ]);

  const wetLater = await run({ weatherData: {
    yest: { icon: 'rain' },
    current: { icon: 'rain' },
    today: { icon: 'rain' },
  } });
  assert.deepEqual(mimIds(wetLater), [
    'WeatherIntro', 'WeatherCommentRain', 'WeatherTodayHighLow',
  ]);
  assert.equal(mimIds(wetLater).includes('WeatherWetNowDryLater'), false);
});

test('S-09 preserves source temperature-change thresholds in Fahrenheit and Celsius', async () => {
  const fahrenheitCases = [
    ['+10 at hot threshold', 75, 85, 'WeatherTodayHotter'],
    ['+10 below hot threshold', 60, 70, 'WeatherTodayWarmer'],
    ['-10 at cold threshold', 50, 40, 'WeatherTodayColder'],
    ['-10 above cold threshold', 60, 50, 'WeatherTodayCooler'],
  ];
  for (const [name, yesterday, today, expected] of fahrenheitCases) {
    const data = await run({ weatherData: {
      yest: { highTemp: yesterday },
      today: { highTemp: today },
    } });
    assert.equal(mimIds(data)[2], expected, name);
    assert.equal(mimIds(data).includes('WeatherTodayHighLow'), false, `${name} suppresses high/low`);
  }

  const celsiusCases = [
    ['+6 below hot threshold', 20, 26, 'WeatherTodayWarmer'],
    ['+6 at hot threshold', 23, 29, 'WeatherTodayHotter'],
    ['-6 above cold threshold', 20, 14, 'WeatherTodayCooler'],
    ['-6 at cold threshold', 10, 4, 'WeatherTodayColder'],
  ];
  for (const [name, yesterday, today, expected] of celsiusCases) {
    const data = await run({ weatherData: {
      useCelsius: true,
      yest: { highTemp: yesterday },
      today: { highTemp: today },
    } });
    assert.equal(mimIds(data)[2], expected, name);
    assert.equal(mimIds(data).includes('WeatherTodayHighLow'), false, `${name} suppresses high/low`);
  }
});

test('S-09 preserves basic and service-down fallback paths', async () => {
  const basic = await run({ weatherData: {
    today: { highTemp: null, lowTemp: null, icon: 'clear-day' },
  } });
  assert.deepEqual(mimIds(basic), ['WeatherIntro', 'WeatherBasicClearDay']);

  const serviceDown = makeData({ weatherData: null });
  await new WeatherMimLogic('Weather Logic').exit(serviceDown);
  assert.deepEqual(mimIds(serviceDown), ['WeatherServiceDown']);
});

test('S-09 selects today/tomorrow for full reports and honors single-skill tomorrow', async () => {
  const fullReportToday = await run({
    iso: '2026-06-12T17:59:00-08:00',
  });
  assert.deepEqual(mimIds(fullReportToday), [
    'WeatherIntro', 'WeatherCommentClearDay', 'WeatherTodayHighLow',
  ]);
  assert.equal(fullReportToday.local.weather.summary, fullReportToday.local.weather.today.summary);
  assert.equal(fullReportToday.local.weather.icon, fullReportToday.local.weather.today.icon);

  const fullReportTomorrow = await run({
    iso: '2026-06-12T18:00:00+09:00',
  });
  assert.deepEqual(mimIds(fullReportTomorrow), [
    'WeatherIntroTomorrow', 'WeatherCommentRain', 'WeatherTomorrowHighLow',
  ]);
  assert.equal(fullReportTomorrow.local.weather.summary, fullReportTomorrow.local.weather.tomorrow.summary);
  assert.equal(fullReportTomorrow.local.weather.icon, fullReportTomorrow.local.weather.tomorrow.icon);

  const singleSkillEvening = await run({
    iso: '2026-06-12T18:00:00+09:00',
    singleSkill: 'weather',
  });
  assert.deepEqual(mimIds(singleSkillEvening), [
    'WeatherIntro', 'WeatherCommentClearNight', 'WeatherTodayHighLow',
  ]);

  const singleSkillTomorrow = await run({
    iso: '2026-06-12T12:00:00-08:00',
    singleSkill: 'weather',
    entities: { date: 'tomorrow' },
  });
  assert.deepEqual(mimIds(singleSkillTomorrow), [
    'WeatherIntroTomorrow', 'WeatherCommentRain', 'WeatherTomorrowHighLow',
  ]);
});

test('S-09 keeps the selected high/low view aligned with the ordered MIM data', async () => {
  const data = await run({ weatherData: {
    today: { highTemp: 86, lowTemp: 39, icon: 'rain' },
  } });
  const [background, icon, high, highUnit, low, lowUnit] = data.local.views.weatherHiLo.componentConfigs;
  assert.match(background.assets[0].src, /tempHot_v01\.crn$/);
  assert.match(icon.assets[0].src, /icons\/rain_v01\.crn$/);
  assert.equal(high.text, '86°');
  assert.equal(highUnit.text, 'F');
  assert.equal(low.text, '39°');
  assert.equal(lowUnit.text, 'F');
});
