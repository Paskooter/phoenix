import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiLoTempView } from '../src/report/weatherViews.js';
import { MimPath, WeatherMimLogic, weatherParse } from '../src/report/weather.js';

// These rows are the archived Pegasus Weather.test.js Views cases from
// jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c.  The source reads
// the runtime location through DateTime.getLocalTime(), so the selection rows
// deliberately use +14:00 to catch accidental host-UTC reads.
const NOON_PLUS_FOURTEEN = '2026-06-12T10:00:00.000+14:00';
const EVENING_PLUS_FOURTEEN = '2026-06-12T18:00:00.000+14:00';

const defaultWeather = {
  yest: { high: 57.7, low: 54.35, summary: 'Yesterday', icon: 'clear-day' },
  today: { high: 80, low: 60, summary: 'Today', icon: 'rain' },
  tomorrow: { high: 70, low: 50, summary: 'Tomorrow', icon: 'fog' },
  current: { temp: 65, summary: 'Current', icon: 'cloudy' },
};

const weatherPrefs = (useCelsius = false) => ({
  weather: { active: true, useCelsius },
  calendar: { active: false },
  commute: { active: false },
  news: { active: false },
});

function rawWeather(overrides = {}) {
  const value = {};
  for (const name of ['yest', 'today', 'tomorrow', 'current']) {
    value[name] = { ...defaultWeather[name], ...(overrides[name] || {}) };
  }
  const daily = (day) => ({
    temperatureHigh: day.high,
    temperatureLow: day.low,
    summary: day.summary,
    icon: day.icon,
  });
  return [
    { daily: { data: [daily(value.yest)] } },
    {
      currently: {
        temperature: value.current.temp,
        summary: value.current.summary,
        icon: value.current.icon,
      },
      daily: { data: [daily(value.today), daily(value.tomorrow)] },
    },
  ];
}

async function runLogic(weather, iso) {
  const data = {
    local: { weather, views: {} },
    runtime: { location: { iso } },
    skill: { session: { data: { _personalReport: { singleSkill: null } } } },
  };
  await new WeatherMimLogic('Weather Logic').exit(data);
  return data;
}

async function runRaw(overrides, iso, useCelsius = false) {
  const weather = await weatherParse(rawWeather(overrides), weatherPrefs(useCelsius));
  return runLogic(weather, iso);
}

function component(view, id) {
  return view.componentConfigs.find((item) => item.id === id);
}

test('S-09/S-13 Weather.test.js row 46: no temperature view for no data or icon-only data', async () => {
  const noData = await runLogic(undefined, NOON_PLUS_FOURTEEN);
  assert.equal(noData.local.views.weatherHiLo, undefined);
  assert.match(noData.local.mimPaths[0], new RegExp(`${MimPath.ServiceDown}\\.mim$`));

  const iconOnly = await runRaw({
    today: { high: null, low: null, icon: 'clear-day' },
    tomorrow: { high: null, low: null, icon: 'rain' },
  }, NOON_PLUS_FOURTEEN);
  assert.equal(iconOnly.local.views.weatherHiLo, undefined);
  assert.match(iconOnly.local.mimPaths[1], /BasicClearDay\.mim$/);
});

test('S-09/S-13 Weather.test.js row 47: report selects today data before 5PM in the location timezone', async () => {
  const data = await runRaw({}, NOON_PLUS_FOURTEEN);
  assert.equal(component(data.local.views.weatherHiLo, 'hiNumLabel').text, '80°');
  assert.equal(data.local.weather.summary, 'Today');
});

test('S-09/S-13 Weather.test.js row 48: report selects tomorrow data after 5PM in the location timezone', async () => {
  const data = await runRaw({}, EVENING_PLUS_FOURTEEN);
  assert.equal(component(data.local.views.weatherHiLo, 'hiNumLabel').text, '70°');
  assert.equal(data.local.weather.summary, 'Tomorrow');
});

test('S-13 Weather.test.js row 49: temperature view uses the cold background below 40°F', async () => {
  const view = await hiLoTempView({ highTemp: 39, lowTemp: 30, icon: 'clear-day' }, false);
  assert.match(view.componentConfigs[0].assets[0].src, /tempCold_v01\.crn$/);
});

test('S-13 Weather.test.js row 50: temperature view uses the hot background above 85°F', async () => {
  const view = await hiLoTempView({ highTemp: 86, lowTemp: 70, icon: 'clear-day' }, false);
  assert.match(view.componentConfigs[0].assets[0].src, /tempHot_v01\.crn$/);
});

test('S-13 Weather.test.js row 51: temperature view keeps 40°F and 85°F in the normal band', async () => {
  const background = async (highTemp) => (await hiLoTempView({ highTemp, lowTemp: 50, icon: 'clear-day' }, false))
    .componentConfigs[0].assets[0].src;
  assert.match(await background(40), /tempNormal_v01\.crn$/);
  assert.match(await background(85), /tempNormal_v01\.crn$/);
});

test('S-13 Weather.test.js row 52: icon, high/low labels and Fahrenheit units match the selected data', async () => {
  const view = await hiLoTempView({ highTemp: 66, lowTemp: 57, icon: 'rain' }, false);
  assert.match(component(view, 'iconClip').assets[0].src, /icons\/rain_v01\.crn$/);
  assert.equal(component(view, 'hiNumLabel').text, '66°');
  assert.equal(component(view, 'loNumLabel').text, '57°');
  assert.equal(component(view, 'hiUnitLabel').text, 'F');
  assert.equal(component(view, 'loUnitLabel').text, 'F');
});

test('S-13 Weather.test.js row 53: Celsius weather data is converted and labelled in the view', async () => {
  const data = await runRaw({ today: { high: 66, low: 57 } }, NOON_PLUS_FOURTEEN, true);
  const view = data.local.views.weatherHiLo;
  assert.equal(component(view, 'hiNumLabel').text, '19°');
  assert.equal(component(view, 'loNumLabel').text, '14°');
  assert.equal(component(view, 'hiUnitLabel').text, 'C');
  assert.equal(component(view, 'loUnitLabel').text, 'C');
});

test('S-13 Weather.test.js row 54: one and three-character temperatures receive the source x offsets', async () => {
  const data = await runRaw({ today: { high: 6, low: -57, icon: 'rain' } }, NOON_PLUS_FOURTEEN);
  const view = data.local.views.weatherHiLo;
  assert.equal(component(view, 'hiNumLabel').position.x, 370 - 70);
  assert.equal(component(view, 'hiUnitLabel').position.x, 360 - 70);
  assert.equal(component(view, 'loNumLabel').position.x, 1110 + 70);
  assert.equal(component(view, 'loUnitLabel').position.x, 1100 + 70);
});
