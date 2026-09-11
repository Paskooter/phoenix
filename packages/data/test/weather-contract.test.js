// D-05 — weather data and forecast/date semantics, run against the real data service.
//
// Pinned reference:
//   pegasus packages/lasso/src/relay/DarkSkyHandler.ts  (validateAndExtractInputs, createRedisKey)
//   pegasus packages/lasso/src/utils/LatLon.ts          (make_from_strings + range checks)
//   pegasus packages/lasso/tests/relay/DarkSky.test.ts  (the 400 messages/cases replayed below)
//   pegasus packages/report-skill/src/subskills/weather/WeatherParse.ts (daily.data[0] = today)
//   docs/parity/COMPATIBILITY.md B1 "weather day index" -> required repair owned by D-05.
//
// Observed at runtime before the fix: `GET /v1/dark_sky` with no lat/lon answered 200 with
// latitude:0/longitude:0 and cached `dark_sky:0;0` (DIVERGENCES.md D05a), and
// `secondsSinceEpoch=0` collapsed onto the same cache key as an absent timestamp.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDataService, TTLCache } from '../src/index.js';
import { validateWeather, weatherKey, makeLatLon, openMeteoToDarkSky } from '../src/weather.js';

const PORT = 7802;

// past_days=1 window: [yesterday, today, tomorrow, +1]
const OM = {
  timezone: 'America/New_York',
  daily: {
    time: ['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10'],
    temperature_2m_max: [70, 75, 80, 85],
    temperature_2m_min: [50, 55, 60, 65],
    weathercode: [0, 61, 3, 1],
    sunrise: ['2026-06-07T05:00', '2026-06-08T05:01', '2026-06-09T05:02', '2026-06-10T05:03'],
    sunset: ['2026-06-07T20:00', '2026-06-08T20:01', '2026-06-09T20:02', '2026-06-10T20:03'],
    precipitation_sum: [0, 1.2, 0, 0.1],
    precipitation_probability_max: [0, 80, 10, 20],
  },
};
const sse = (iso) => Math.floor(Date.parse(iso) / 1000);

// --- unit: LatLon / validateWeather ----------------------------------------

test('D05/01 makeLatLon replays the pinned LatLon float-pattern and range checks', () => {
  assert.deepEqual(makeLatLon('43.7', '-79.4'), { lat: 43.7, lon: -79.4 });
  assert.deepEqual(makeLatLon('42', '-71'), { lat: 42, lon: -71 });
  assert.throws(() => makeLatLon(undefined, '1'), /^RangeError: Invalid latitude undefined$/);
  assert.throws(() => makeLatLon('abc', '1'), /^RangeError: Invalid latitude abc$/);
  assert.throws(() => makeLatLon('1', 'asdf'), /^RangeError: Invalid longitude asdf$/);
  assert.throws(() => makeLatLon('-555', '1.1'), /^RangeError: Invalid latitude -555$/);
  assert.throws(() => makeLatLon('91', '0'), /^RangeError: Invalid latitude 91$/);
  assert.throws(() => makeLatLon('0', '181'), /^RangeError: Invalid longitude 181$/);
  // The old Number() coercion accepted these; the pinned pattern rejects them.
  for (const bad of ['1e5', '0x10', '  ', 'Infinity', '', 'NaN']) {
    assert.throws(() => makeLatLon(bad, '0'), RangeError, `lat=${JSON.stringify(bad)} rejected`);
  }
});

test('D05/02 validateWeather keeps secondsSinceEpoch as the raw string (so "0" stays truthy)', () => {
  assert.deepEqual(validateWeather(new URLSearchParams('lat=1&lon=2')), { lat: 1, lon: 2, secondsSinceEpoch: 0 });
  assert.deepEqual(
    validateWeather(new URLSearchParams('lat=1&lon=2&secondsSinceEpoch=0')),
    { lat: 1, lon: 2, secondsSinceEpoch: '0' },
  );
  assert.deepEqual(
    validateWeather(new URLSearchParams('lat=1&lon=2&secondsSinceEpoch=1516378549')),
    { lat: 1, lon: 2, secondsSinceEpoch: '1516378549' },
  );
  assert.throws(
    () => validateWeather(new URLSearchParams('lat=1&lon=2&secondsSinceEpoch=very much not a number!')),
    /^RangeError: Invalid timestamp: 'very much not a number!'$/,
  );
});

// --- unit: cache key --------------------------------------------------------

test('D05/03 weatherKey appends the date segment on raw-string truthiness', () => {
  assert.equal(weatherKey({ lat: 1, lon: 2, secondsSinceEpoch: 0 }), 'dark_sky:1;2');
  assert.equal(weatherKey({ lat: 21.3, lon: -157.81666743, secondsSinceEpoch: 0 }), 'dark_sky:21.3;-157.81666743');
  assert.equal(weatherKey({ lat: 1, lon: 2, secondsSinceEpoch: '0' }), 'dark_sky:1;2;1970-01-01');
  assert.equal(weatherKey({ lat: 43.7, lon: -79.4, secondsSinceEpoch: '1516378549' }), 'dark_sky:43.7;-79.4;2018-01-19');
});

// --- unit: Dark Sky day index ----------------------------------------------

test('D05/04 daily.data[0] is the requested day (pinned WeatherParse indexing)', () => {
  const forecast = openMeteoToDarkSky(OM, { lat: 42, lon: -71, secondsSinceEpoch: 0 });
  assert.deepEqual(forecast.daily.data.map((d) => d.temperatureHigh), [75, 80, 85]);
  assert.equal(forecast.daily.data[0].time, sse('2026-06-08T00:00:00Z')); // today
  assert.equal(forecast.daily.data[1].icon, 'cloudy'); // tomorrow code 3

  // A time-machine request for 2026-06-07 (yesterday) moves that day to index 0.
  const historical = openMeteoToDarkSky(OM, { lat: 42, lon: -71, secondsSinceEpoch: String(sse('2026-06-07T12:00:00Z')) });
  assert.deepEqual(historical.daily.data.map((d) => d.temperatureHigh), [70, 75, 80, 85]);
  assert.equal(historical.daily.data[0].time, sse('2026-06-07T00:00:00Z'));
});

test('D05/05 current_weather drives `currently` for a forecast request only', () => {
  const withCurrent = { ...OM, current_weather: { temperature: 63.5, weathercode: 0, is_day: 1, time: '2026-06-08T09:00' } };
  const forecast = openMeteoToDarkSky(withCurrent, { lat: 42, lon: -71, secondsSinceEpoch: 0 });
  assert.equal(forecast.currently.temperature, 63.5);
  assert.equal(forecast.currently.icon, 'clear-day');

  // A historical request is about its own day; current_weather must not leak into it.
  const historical = openMeteoToDarkSky(withCurrent, { lat: 42, lon: -71, secondsSinceEpoch: String(sse('2026-06-07T12:00:00Z')) });
  assert.equal(historical.currently.temperature, 70);
  assert.equal(historical.currently.icon, 'clear-day'); // yesterday code 0
});

// --- runtime: the real data service over HTTP -------------------------------

const cache = new TTLCache();
const calls = [];
let server;
before(async () => {
  const svc = createDataService({ cache, weatherGet: async (lat, lon) => { calls.push([lat, lon]); return OM; } });
  server = await svc.listen(PORT);
});
after(() => server?.close?.());

const get = (qs, method = 'GET') => fetch(`http://localhost:${PORT}/v1/dark_sky?${qs}`, { method });

test('D05/06 bad coordinates / timestamp -> 400 with the original message, no upstream call, no cache write', async () => {
  const cases = [
    ['', 'Invalid latitude undefined'],
    ['lat=2.2&lon=asdf&secondsSinceEpoch=1516378549', 'Invalid longitude asdf'],
    ['lat=-555&lon=1.1', 'Invalid latitude -555'],
    ['lat=abc&lon=2', 'Invalid latitude abc'],
    ['lat=5.5&lon=6.6&secondsSinceEpoch=' + encodeURIComponent('very much not a number!'), "Invalid timestamp: 'very much not a number!'"],
  ];
  for (const [qs, message] of cases) {
    const res = await get(qs);
    assert.equal(res.status, 400, `${qs} -> 400`);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), message, `${qs} -> body`);
  }
  assert.equal(calls.length, 0, 'no invalid request reached the provider');
  assert.deepEqual([...cache.m.keys()], [], 'no invalid request was cached');
});

test('D05/07 valid forecast request is 200 with today at daily.data[0] and a warmed cache', async () => {
  const res = await get('lat=42.3134&lon=-71.1274');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lassoDataFromRedis, false);
  assert.equal(body.relayData.latitude, 42.3134);
  assert.equal(body.relayData.longitude, -71.1274);
  assert.equal(body.relayData.timezone, 'America/New_York');
  assert.equal(body.relayData.daily.data[0].temperatureHigh, 75); // today, not yesterday
  assert.equal(body.relayData.daily.data[1].temperatureHigh, 80); // tomorrow
  assert.equal(body.relayData.flags.units, 'us');
  assert.deepEqual(calls, [[42.3134, -71.1274]]);

  const hit = await (await get('lat=42.3134&lon=-71.1274')).json();
  assert.equal(hit.lassoDataFromRedis, true);
  assert.deepEqual([...cache.m.keys()].filter((k) => k.startsWith('dark_sky:42.3134')), ['dark_sky:42.3134;-71.1274']);
});

test('D05/08 secondsSinceEpoch=0 gets its own ";1970-01-01" cache entry instead of collapsing to the no-timestamp key', async () => {
  const base = await (await get('lat=9&lon=9')).json();
  assert.equal(base.lassoDataFromRedis, false);
  const zero = await (await get('lat=9&lon=9&secondsSinceEpoch=0')).json();
  assert.equal(zero.lassoDataFromRedis, false, 'a distinct key is a miss, not a hit on the no-timestamp entry');
  const stamp = await (await get('lat=9&lon=9&secondsSinceEpoch=1516378549')).json();
  assert.equal(stamp.lassoDataFromRedis, false);

  assert.deepEqual(
    [...cache.m.keys()].filter((k) => k.startsWith('dark_sky:9;9')).sort(),
    ['dark_sky:9;9', 'dark_sky:9;9;1970-01-01', 'dark_sky:9;9;2018-01-19'],
  );
  assert.equal(calls.filter(([a, b]) => a === 9 && b === 9).length, 3, 'three distinct keys, three upstream fetches');
});

test('D05/09 a historical request returns that day at daily.data[0] through the real service', async () => {
  const ts = sse('2026-06-07T12:00:00Z');
  const body = await (await get(`lat=7&lon=7&secondsSinceEpoch=${ts}`)).json();
  assert.equal(body.relayData.daily.data[0].time, sse('2026-06-07T00:00:00Z'));
  assert.equal(body.relayData.daily.data[0].temperatureHigh, 70);
  assert.ok([...cache.m.keys()].includes('dark_sky:7;7;2026-06-07'));
});
