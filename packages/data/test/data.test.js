import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/cache.js';
import { openMeteoToDarkSky, weatherCodeToIcon, validateWeather } from '../src/weather.js';
import { createDataService } from '../src/index.js';

const PORT = 7799;

// past_days=1: [yesterday, today, tomorrow]
const OM = {
  timezone: 'America/New_York',
  daily: {
    time: ['2026-06-07', '2026-06-08', '2026-06-09'],
    temperature_2m_max: [70, 75, 80],
    temperature_2m_min: [50, 55, 60],
    weathercode: [0, 61, 3],
    sunrise: ['2026-06-07T05:00', '2026-06-08T05:01', '2026-06-09T05:02'],
    sunset: ['2026-06-07T20:00', '2026-06-08T20:01', '2026-06-09T20:02'],
    precipitation_sum: [0, 1.2, 0],
    precipitation_probability_max: [0, 80, 10],
  },
};

test('TTLCache: get/set + expiry', () => {
  const c = new TTLCache();
  c.set('k', { x: 1 }, 60);
  assert.deepEqual(c.get('k'), { x: 1 });
  c.set('e', 1, -1); // already expired
  assert.equal(c.get('e'), null);
});

test('validateWeather requires numeric lat/lon', () => {
  assert.throws(() => validateWeather(new URLSearchParams('lat=abc&lon=2')), /lat and lon are required/);
  assert.deepEqual(validateWeather(new URLSearchParams('lat=42&lon=-71')), { lat: 42, lon: -71, secondsSinceEpoch: 0 });
});

test('openMeteoToDarkSky maps to the Dark Sky shape; "today" = index 1 (past_days=1)', () => {
  const d = openMeteoToDarkSky(OM, { lat: 42, lon: -71, secondsSinceEpoch: 0 });
  assert.equal(d.daily.data.length, 3);
  assert.equal(d.daily.data[0].temperatureHigh, 70); // yesterday
  assert.equal(d.daily.data[0].icon, 'clear-day');
  assert.equal(d.daily.data[1].temperatureHigh, 75); // today
  assert.equal(d.daily.data[1].icon, 'rain'); // code 61
  assert.equal(d.daily.data[1].summary, 'Light rain');
  assert.equal(d.currently.temperature, 75); // currently follows "today"
  assert.equal(d.flags.sources[0], 'open-meteo');
});

test('weatherCodeToIcon mapping', () => {
  assert.equal(weatherCodeToIcon(0), 'clear-day');
  assert.equal(weatherCodeToIcon(71), 'snow');
  assert.equal(weatherCodeToIcon(95), 'rain');
});

// --- HTTP relay: envelope + cache ------------------------------------------
let server;
let fetchCount = 0;
before(async () => {
  fetchCount = 0;
  const svc = createDataService({ weatherGet: async () => { fetchCount++; return OM; } });
  server = await svc.listen(PORT);
});
after(() => server?.close?.());

const getWeather = (qs, method = 'GET') => fetch(`http://localhost:${PORT}/v1/dark_sky?${qs}`, { method });

test('GET miss -> lassoDataFromRedis:false; second GET -> cache hit (no refetch)', async () => {
  const r1 = await (await getWeather('lat=42&lon=-71')).json();
  assert.equal(r1.lassoDataFromRedis, false);
  assert.equal(r1.relayData.daily.data[1].temperatureHigh, 75);
  assert.equal(fetchCount, 1);

  const r2 = await (await getWeather('lat=42&lon=-71')).json();
  assert.equal(r2.lassoDataFromRedis, true);
  assert.ok(r2.lassoInsertedIntoRedisAt, 'cached envelope carries the insert timestamp');
  assert.equal(fetchCount, 1, 'second GET served from cache, no upstream refetch');
});

test('HEAD prefetch warms the cache (empty 200), next GET is a hit', async () => {
  const head = await getWeather('lat=10&lon=20', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  await new Promise((r) => setTimeout(r, 50)); // let the background cache write land
  const g = await (await getWeather('lat=10&lon=20')).json();
  assert.equal(g.lassoDataFromRedis, true);
});

test('missing lat/lon -> 400', async () => {
  const res = await getWeather('lat=foo');
  assert.equal(res.status, 400);
});
