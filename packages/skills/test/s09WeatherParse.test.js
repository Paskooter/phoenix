import test from 'node:test';
import assert from 'node:assert/strict';
import { ParseDataNode } from '../src/report/nodes.js';
import { sanitizeSummary, weatherParse } from '../src/report/weather.js';

// Source contract:
// jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
// packages/report-skill/src/subskills/weather/WeatherParse.ts
// packages/report-skill/tests/subskills/Weather.test.js (Parse suite)

const defaults = {
  yest: { icon: 'clear-day', high: 57.7, low: 54.35, summary: 'Summer Breeze, make me feel fine...' },
  today: { icon: 'rain', high: 50.3, low: 45.83, summary: 'Raining Blood! (from a lacerated sky)' },
  tomorrow: { icon: 'fog', high: 55.3, low: 40.83, summary: "Bet your bottom dollar that tomorrow there'll be fog" },
  current: { icon: 'cloudy', temp: 65, summary: 'Cloudy with a chance of meatballs' },
};

function weatherRaw(overrides = {}) {
  const value = {
    yest: { ...defaults.yest, ...(overrides.yest || {}) },
    today: { ...defaults.today, ...(overrides.today || {}) },
    tomorrow: { ...defaults.tomorrow, ...(overrides.tomorrow || {}) },
    current: overrides.current === null
      ? null
      : { ...defaults.current, ...(overrides.current || {}) },
  };
  const yesterdayData = {
    summary: value.yest.summary,
    icon: value.yest.icon,
    temperatureHigh: value.yest.high,
    temperatureLow: value.yest.low,
  };
  const todayData = {
    summary: value.today.summary,
    icon: value.today.icon,
    temperatureHigh: value.today.high,
    temperatureLow: value.today.low,
  };
  const tomorrowData = {
    summary: value.tomorrow.summary,
    icon: value.tomorrow.icon,
    temperatureHigh: value.tomorrow.high,
    temperatureLow: value.tomorrow.low,
  };
  return [
    { daily: { data: [yesterdayData] } },
    {
      ...(value.current ? {
        currently: {
          icon: value.current.icon,
          temperature: value.current.temp,
          summary: value.current.summary,
        },
      } : {}),
      daily: { data: [todayData, tomorrowData] },
    },
  ];
}

function prefs({ useCelsius = false, active = ['weather'] } = {}) {
  return {
    weather: { active: active.includes('weather'), useCelsius },
    calendar: { active: active.includes('calendar') },
    commute: { active: active.includes('commute') },
    news: { active: active.includes('news') },
  };
}

test('S09 archived Parse: return undefined if no data', async () => {
  assert.equal(await weatherParse(null, prefs()), undefined);
});

test('S09 archived Parse: return undefined if no today data', async () => {
  assert.equal(await weatherParse([weatherRaw()[0], null], prefs()), undefined);
});

test('S09 archived Parse: return today and yesterday data if no tomorrow data', async () => {
  const raw = weatherRaw();
  raw[1].daily.data.length = 1;
  const parsed = await weatherParse(raw, prefs());
  assert.ok(parsed.yest);
  assert.equal(parsed.today.icon, 'rain');
  assert.equal(parsed.today.summary, defaults.today.summary);
  assert.equal(parsed.today.highTemp, 50);
  assert.equal(parsed.today.lowTemp, 46);
  assert.equal(parsed.tomorrow, undefined);
});

test('S09 archived Parse: return today and tomorrow data if no yesterday data', async () => {
  const parsed = await weatherParse([null, weatherRaw()[1]], prefs());
  assert.equal(parsed.yest, undefined);
  assert.equal(parsed.today.icon, 'rain');
  assert.equal(parsed.tomorrow.icon, 'fog');
  assert.equal(parsed.tomorrow.highTemp, 55);
  assert.equal(parsed.tomorrow.lowTemp, 41);
});

test('S09 archived Parse: onlyWeatherActive === true if no other active categories', async () => {
  const parsed = await weatherParse(weatherRaw(), prefs({ active: ['weather'] }));
  assert.equal(parsed.onlyWeatherActive, true);
});

test('S09 archived Parse: onlyWeatherActive === false if any other active categories', async () => {
  const parsed = await weatherParse(weatherRaw(), prefs({ active: ['weather', 'calendar'] }));
  assert.equal(parsed.onlyWeatherActive, false);
});

test('S09 archived Parse: temp in °C if userPrefs.useCelsius', async () => {
  const parsed = await weatherParse(weatherRaw(), prefs({ useCelsius: true }));
  assert.equal(parsed.today.highTemp, 10);
  assert.equal(parsed.today.lowTemp, 8);
  assert.equal(parsed.useCelsius, true);
});

test('S09 archived Parse: temp in °F if !userPrefs.useCelsius', async () => {
  const parsed = await weatherParse(weatherRaw(), prefs());
  assert.equal(parsed.today.highTemp, 50);
  assert.equal(parsed.today.lowTemp, 46);
  assert.equal(parsed.useCelsius, false);
});

test('S09 archived Parse: get random weather prefix', async () => {
  const parsed = await weatherParse(weatherRaw(), prefs());
  const promptPrefixes = [
    "Looks like it's going to be", 'We can expect it to be', "It's going to be",
    'Looks like', "It'll be", 'It looks like', "It's supposed to be",
    "They're predicting", "They're saying it's going to be", 'We can expect',
    'All signs point to',
  ];
  assert.ok(promptPrefixes.includes(parsed.prefix), parsed.prefix);
});

test('S09 archived Parse: replace < with "less than"', async () => {
  const parsed = await weatherParse(weatherRaw({ today: {
    summary: 'Light snow (< 1 in.) and breezy overnight.',
  } }), prefs());
  assert.equal(parsed.today.summary, 'Light snow (less than 1 inch) and breezy overnight.');
});

test('S09 archived Parse: replace > with "more than"', async () => {
  const parsed = await weatherParse(weatherRaw({ today: {
    summary: 'Light snow (> 1 ft.) and breezy overnight.',
  } }), prefs());
  assert.equal(parsed.today.summary, 'Light snow (more than 1 foot) and breezy overnight.');
});

test('S09 archived Parse: replace < with "less than" when not followed by "in." or "ft."', async () => {
  const parsed = await weatherParse(weatherRaw({ today: {
    summary: 'Light snow (< 1 unit) and breezy overnight.',
  } }), prefs());
  assert.equal(parsed.today.summary, 'Light snow (less than 1 unit) and breezy overnight.');
});

test('S09 archived Parse: replace "in." with "inches"', async () => {
  const parsed = await weatherParse(weatherRaw({ today: {
    summary: 'Snow (9-11 in.) and breezy overnight.',
  } }), prefs());
  assert.equal(parsed.today.summary, 'Snow (9-11 inches) and breezy overnight.');
});

test('S09 archived Parse: replace "ft." with "feet"', async () => {
  const parsed = await weatherParse(weatherRaw({ today: {
    summary: 'Snow (9-11 ft.) and breezy overnight.',
  } }), prefs());
  assert.equal(parsed.today.summary, 'Snow (9-11 feet) and breezy overnight.');
});

test('S09 parser: missing current data keeps the source empty current shape', async () => {
  const parsed = await weatherParse(weatherRaw({ current: null }), prefs());
  assert.deepEqual(parsed.current, { temp: null, icon: null, summary: '' });
});

test('S09 parser: missing summaries preserve source TypeError behavior', async () => {
  await assert.rejects(
    weatherParse(weatherRaw({ today: { summary: undefined } }), prefs()),
    TypeError,
  );
  await assert.rejects(
    weatherParse(weatherRaw({ current: { summary: 42 } }), prefs()),
    TypeError,
  );
});

test('S09 parser: ParseDataNode awaits WeatherParse before transitioning', async () => {
  const data = {
    result: { weather: weatherRaw() },
    local: { userPrefs: prefs() },
    runtime: {},
    log: { error() {} },
  };
  const exit = await new ParseDataNode('Parse Data').exit(data);
  assert.equal(exit.transition, 'Done');
  assert.equal(data.local.weather.today.highTemp, 50);
  assert.equal(typeof data.local.weather.then, 'undefined');
});

test('S09 sanitizer preserves source string-only input contract', () => {
  assert.equal(sanitizeSummary('< 1 in.'), 'less than 1 inch');
  assert.throws(() => sanitizeSummary(42), TypeError);
  assert.throws(() => sanitizeSummary(undefined), TypeError);
});
