// D-01 — common relay + cache contract, runtime and durability pins.
//
// Companion to relay-contract.test.js. That file replays the V-01 fixture
// bodies; this file pins the parts of the contract that only a running service
// can show:
//
//   Part A  full header replay (status / content-type / content-length / ETag /
//           body) against the captured original transactions at the reference
//           clock time, so "matches the original" is byte-identical, not
//           body-only.
//   Part B  the captured `relayEffects` ordering: cache GET precedes the
//           provider call, cache SET follows it, and a provider failure / empty
//           reply is never cached.
//   Part C  `request.query.skipCache` truthiness for every query encoding the
//           original Express (4.16.2, qs default parser) can produce.
//   Part D  the three real routes (weather/news/maps) relayed end-to-end
//           through createDataService: miss, hit, prefetch warming, skipCache,
//           per-relay key composition and cross-relay isolation.
//   Part E  expiry on the real clock (the mocked-clock boundary is D01/16).
//   Part F  durability: an actual process restart.
//
// Reference: pegasus packages/lasso/src/relay/AbstractRelayRequestHandler.ts
// (@5c0a739) and the captures in
// docs/parity/evidence/2026-09-05/reference/transactions.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '@phoenix/common';
import { TTLCache } from '../src/cache.js';
import { createRelay } from '../src/relay.js';
import { createDataService } from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function listen(service) {
  const server = await service.listen(0);
  return { server, port: server.address().port };
}

async function call(port, pathname, method = 'GET') {
  const res = await fetch(`http://localhost:${port}${pathname}`, { method });
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    len: res.headers.get('content-length'),
    etag: res.headers.get('etag'),
    body: await res.text(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A FixtureCalendar relay mirroring scripts/parity-reference/capture.cjs:253-283.
function fixtureRelay(cache, effects) {
  return createRelay({
    name: 'FixtureCalendar',
    ttlSeconds: 60,
    cache,
    validate: (q) => { if (!q.get('key')) throw new Error('fixture key required'); return { key: q.get('key') }; },
    key: (input) => 'fixture:' + input.key,
    fetchExternal: async (input) => {
      effects?.push({ operation: 'provider.fetch', input });
      if (input.key === 'failure') throw new Error('fixture provider unavailable');
      if (input.key === 'empty') return null;
      return { events: [] };
    },
  });
}

// The captured original clock: the reference froze `new Date()` at this instant
// and the stored metadata string is "2018-05-30T12:00:00.000Z".
const FROZEN_MS = Date.parse('2018-05-30T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Part A — byte-level replay of the captured original transactions
// ---------------------------------------------------------------------------

test('D01/17 replayed original transactions match status, content-type, length, ETag and body', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FROZEN_MS });
  const cache = new TTLCache();
  const relay = fixtureRelay(cache);
  const svc = createService({ name: 'fixture-lasso', routes: { 'GET /v1/calendar': relay, 'HEAD /v1/calendar': relay } });
  const { server, port } = await listen(svc);
  try {
    // Expected values copied from
    // docs/parity/evidence/2026-09-05/reference/transactions.json (the ORIGINAL
    // handler executed against a fake Redis at the same frozen clock).
    const cases = [
      ['GET', '/v1/calendar?key=calendar', 200, 'application/json; charset=utf-8', '54',
        'W/"36-ubWu+rtBDjPOL6hoZGQ200T4yHI"', '{"relayData":{"events":[]},"lassoDataFromRedis":false}'],
      ['GET', '/v1/calendar?key=calendar', 200, 'text/html; charset=utf-8', '107',
        'W/"6b-yAQpi7If9eBMRZJx3ChHya1ztDU"',
        '{"relayData":{"events":[]},"lassoDataFromRedis":true,"lassoInsertedIntoRedisAt":"2018-05-30T12:00:00.000Z"}'],
      ['GET', '/v1/calendar?key=calendar&skipCache=false', 200, 'application/json; charset=utf-8', '54',
        'W/"36-ubWu+rtBDjPOL6hoZGQ200T4yHI"', '{"relayData":{"events":[]},"lassoDataFromRedis":false}'],
      ['HEAD', '/v1/calendar?key=prefetch', 200, null, null, null, ''],
      ['GET', '/v1/calendar', 400, 'text/html; charset=utf-8', '20',
        'W/"14-zxZbQCsV+3+3cKwnMkFxZY5y3pg"', 'fixture key required'],
      ['GET', '/v1/calendar?key=failure', 502, 'text/html; charset=utf-8', '71',
        'W/"47-YyLi7eIvFZfWP7CFcet3O7Dquds"', 'Error getting FixtureCalendar data: Error: fixture provider unavailable'],
      ['GET', '/v1/calendar?key=empty', 502, 'text/html; charset=utf-8', '32',
        'W/"20-2193Mgn8o694I2ybIPPvURAp1Ks"', 'Empty reply from FixtureCalendar'],
    ];
    for (const [method, pathname, status, type, len, etag, body] of cases) {
      const r = await call(port, pathname, method);
      const label = `${method} ${pathname}`;
      assert.equal(r.status, status, `${label} status`);
      assert.equal(r.type, type, `${label} content-type`);
      assert.equal(r.len, len, `${label} content-length`);
      assert.equal(r.etag, etag, `${label} ETag`);
      assert.equal(r.body, body, `${label} body`);
    }
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Part B — cache/provider call ordering (the captured `relayEffects`)
// ---------------------------------------------------------------------------

test('D01/18 cache GET precedes the provider call and a failure or empty reply is never cached', async () => {
  const cache = new TTLCache();
  const effects = [];
  const recorder = {
    get: (k) => { effects.push({ operation: 'redis.get', key: k }); return cache.get(k); },
    set: (k, v, ttl) => { effects.push({ operation: 'redis.set', key: k, value: JSON.stringify(v), ttl }); return cache.set(k, v, ttl); },
  };
  const relay = fixtureRelay(recorder, effects);
  const svc = createService({ name: 'fx', routes: { 'GET /v1/calendar': relay, 'HEAD /v1/calendar': relay } });
  const { server, port } = await listen(svc);
  try {
    await call(port, '/v1/calendar?key=calendar');                    // miss
    await call(port, '/v1/calendar?key=calendar');                    // hit
    await call(port, '/v1/calendar?key=calendar&skipCache=false');    // explicit refetch
    await call(port, '/v1/calendar?key=prefetch', 'HEAD');            // prefetch
    await call(port, '/v1/calendar');                                 // validation error
    await call(port, '/v1/calendar?key=failure');                     // provider error
    await call(port, '/v1/calendar?key=empty');                       // empty provider

    // Ordering from docs/parity/evidence/2026-09-05/reference/transactions.json
    // `relayEffects`: get, fetch, set | get | fetch, set | get, fetch, set |
    // get, fetch, set | (nothing) | get, fetch | get, fetch.
    const expectedSequence = [
      ['redis.get', 'fixture:calendar'],
      ['provider.fetch', 'calendar'],
      ['redis.set', 'fixture:calendar'],
      ['redis.get', 'fixture:calendar'],
      ['provider.fetch', 'calendar'],
      ['redis.set', 'fixture:calendar'],
      ['redis.get', 'fixture:prefetch'],
      ['provider.fetch', 'prefetch'],
      ['redis.set', 'fixture:prefetch'],
      ['redis.get', 'fixture:failure'],
      ['provider.fetch', 'failure'],
      ['redis.get', 'fixture:empty'],
      ['provider.fetch', 'empty'],
    ];
    assert.deepEqual(
      effects.map((e) => [e.operation, e.operation === 'provider.fetch' ? e.input.key : e.key]),
      expectedSequence,
      'cache/provider call sequence matches the original run',
    );
    const sets = effects.filter((e) => e.operation === 'redis.set');
    assert.equal(sets.length, 3, 'only successful fetches were cached');
    for (const s of sets) {
      assert.equal(s.ttl, 60, `${s.key} uses the relay TTL`);
      assert.match(s.value, /^\{"relayData":\{"events":\[\]\},"lassoDataFromRedis":true,"lassoInsertedIntoRedisAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}$/);
    }
    // The reference never caches a failed or empty provider result.
    assert.deepEqual([...cache.m.keys()].sort(), ['fixture:calendar', 'fixture:prefetch']);
  } finally { server.close(); }
});

test('D01/19 a HEAD against a warm cache performs no provider call and no re-set', async () => {
  const cache = new TTLCache();
  const calls = [];
  const relay = createRelay({
    name: 'WarmHead',
    ttlSeconds: 60,
    cache,
    validate: () => ({}),
    key: () => 'warm:1',
    fetchExternal: async () => { calls.push('fetch'); return { ok: true }; },
  });
  const svc = createService({ name: 'wh', routes: { 'GET /x': relay, 'HEAD /x': relay } });
  const { server, port } = await listen(svc);
  try {
    await call(port, '/x');                                  // miss -> provider
    assert.deepEqual(calls, ['fetch']);
    const head = await call(port, '/x', 'HEAD');             // warm
    assert.equal(head.status, 200);
    assert.equal(head.type, null);
    assert.equal(head.len, null);
    assert.equal(head.body, '');
    assert.deepEqual(calls, ['fetch'], 'a HEAD hit must not call the provider');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Part C — skipCache truthiness for every qs encoding
// ---------------------------------------------------------------------------

test('D01/20 skipCache truthiness matches Express qs for every encoding', async () => {
  const cache = new TTLCache();
  const relay = createRelay({
    name: 'SkipCache',
    ttlSeconds: 60,
    cache,
    validate: () => ({}),
    key: () => 'k',
    fetchExternal: async () => ({ ok: true }),
  });
  const svc = createService({ name: 'sc', routes: { 'GET /x': relay, 'HEAD /x': relay } });
  const { server, port } = await listen(svc);
  try {
    await call(port, '/x'); // warm once
    // Expected column is `Boolean(express@4.16.2 req.query.skipCache)` (qs),
    // i.e. the reference `const skipRedisCheck = request.query && request.query.skipCache`.
    const cases = [
      ['/x', false],                       // absent
      ['/x?skipCache', false],             // '' -> falsy
      ['/x?skipCache=', false],            // '' -> falsy
      ['/x?skipCache=false', true],        // 'false' -> the string is truthy
      ['/x?skipCache=0', true],            // '0' -> truthy
      ['/x?skipCache=1', true],
      ['/x?skipCache[]=', true],           // qs Array -> truthy even when empty
      ['/x?skipCache[]=1', true],
      ['/x?skipCache=a&skipCache=b', true],// qs Array -> truthy
      ['/x?skipCache=&skipCache=', true],  // qs Array of empty strings -> truthy
    ];
    for (const [pathname, skips] of cases) {
      const r = await call(port, pathname);
      const fromCache = JSON.parse(r.body).lassoDataFromRedis;
      assert.equal(fromCache, !skips, `${pathname} -> ${skips ? 'expected a live refetch' : 'expected a cache read'}`);
    }
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Part D — the real routes relay end-to-end through index.js
// ---------------------------------------------------------------------------

test('D01/21 weather/news/maps relay through createDataService with miss, hit, warming and key isolation', async () => {
  const cache = new TTLCache();
  const calls = { weather: 0, news: 0, maps: 0 };
  const svc = createDataService({
    cache,
    weatherGet: async () => { calls.weather++; return { timezone: 'UTC', daily: { time: ['2026-09-10'], temperature_2m_max: [70], temperature_2m_min: [50], weathercode: [0], sunrise: ['2026-09-10T10:00'], sunset: ['2026-09-10T22:00'], precipitation_sum: [0], precipitation_probability_max: [10] } }; },
    newsGet: async () => { calls.news++; return '<rss><channel><title>BBC</title><item><title>T</title><description>D</description></item></channel></rss>'; },
    mapsGet: async () => { calls.maps++; return { routes: [{ summary: { duration: 120, distance: 3218.688 } }] }; },
  });
  const { server, port } = await listen(svc);
  const W = '/v1/dark_sky?lat=1&lon=2';
  const N = '/v1/ap_news?sourceID=42209';
  const M = '/v1/google_maps?origin=%7B%22lat%22%3A1%2C%22lon%22%3A2%7D&destination=%7B%22lat%22%3A3%2C%22lon%22%3A4%7D&mode=driving';
  try {
    for (const pathname of [W, N, M]) {
      const miss = await call(port, pathname);
      assert.equal(miss.status, 200);
      assert.equal(miss.type, 'application/json; charset=utf-8', `${pathname} miss is JSON`);
      assert.equal(JSON.parse(miss.body).lassoDataFromRedis, false);
      const hit = await call(port, pathname);
      assert.equal(hit.type, 'text/html; charset=utf-8', `${pathname} hit is the stored bytes`);
      assert.equal(JSON.parse(hit.body).lassoDataFromRedis, true);
    }
    assert.deepEqual(calls, { weather: 1, news: 1, maps: 1 });

    // Per-relay key composition (DarkSkyHandler.ts:25-33, APNewsHandler.ts:107-109,
    // GoogleMapsHandler.ts:51-54).
    assert.deepEqual([...cache.m.keys()].sort(), ['ap_news:42209', 'dark_sky:1;2', 'google_maps:1;2;3;4;driving']);

    // Warming: a cold key prefetched with HEAD is served from cache by the next GET.
    const cold = '/v1/dark_sky?lat=9&lon=9';
    const head = await call(port, cold, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const warmed = await call(port, cold);
    assert.equal(JSON.parse(warmed.body).lassoDataFromRedis, true);
    assert.equal(calls.weather, 2);

    // skipCache refetches and re-inserts, without touching another relay's entry.
    const skipped = await call(port, W + '&skipCache=1');
    assert.equal(JSON.parse(skipped.body).lassoDataFromRedis, false);
    assert.equal(calls.weather, 3);
    assert.equal((await call(port, N)).type, 'text/html; charset=utf-8', 'news entry untouched');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Part E — expiry on the real clock
// ---------------------------------------------------------------------------

test('D01/22 a relay entry expires on the real clock and a live refetch replaces it', async () => {
  const cache = new TTLCache();
  let calls = 0;
  const relay = createRelay({
    name: 'Short',
    ttlSeconds: 1,
    cache,
    validate: () => ({}),
    key: () => 'short:1',
    fetchExternal: async () => { calls++; return { n: calls }; },
  });
  const svc = createService({ name: 'short', routes: { 'GET /x': relay } });
  const { server, port } = await listen(svc);
  try {
    assert.equal(JSON.parse((await call(port, '/x')).body).lassoDataFromRedis, false);
    assert.equal(JSON.parse((await call(port, '/x')).body).lassoDataFromRedis, true, 'hit inside the TTL');
    const deadline = Date.now() + 4000;
    let expired = false;
    while (Date.now() < deadline) {
      await sleep(50);
      if (JSON.parse((await call(port, '/x')).body).lassoDataFromRedis === false) { expired = true; break; }
    }
    assert.equal(expired, true, 'the 1s TTL elapsed on the real clock');
    assert.equal(calls, 2, 'expiry caused exactly one refetch');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Part F — durability across an actual process restart
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

const CHILD_SOURCE = `
import { createDataService } from ${JSON.stringify(path.join(ROOT, 'packages/data/src/index.js'))};
const port = Number(process.argv[process.argv.length - 1]);
const svc = createDataService({ weatherGet: async () => ({ timezone: 'UTC', daily: { time: ['2026-09-10'], temperature_2m_max: [70], temperature_2m_min: [50], weathercode: [0], sunrise: ['2026-09-10T10:00'], sunset: ['2026-09-10T22:00'], precipitation_sum: [0], precipitation_probability_max: [10] } }) });
await svc.listen(port);
process.stderr.write('READY ' + process.pid + '\\n');
`;

function startChild(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE, String(port)], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`child did not become ready: ${stderr}`)), 20000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/READY (\d+)/);
      if (match) { clearTimeout(timer); resolve({ child, pid: Number(match[1]) }); }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited early (${code}): ${stderr}`)); });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

test('D01/23 a real restart resumes relaying and the cache is process-local (D-01a)', async () => {
  const port = await freePort();
  const url = `http://localhost:${port}/v1/dark_sky?lat=1&lon=2`;

  const first = await startChild(port);
  let firstMiss;
  let firstHit;
  try {
    firstMiss = JSON.parse(await (await fetch(url)).text());
    firstHit = JSON.parse(await (await fetch(url)).text());
  } finally { await stopChild(first.child); }

  assert.equal(firstMiss.lassoDataFromRedis, false, 'process 1: cold miss');
  assert.equal(firstHit.lassoDataFromRedis, true, 'process 1: cache hit');

  const second = await startChild(port);
  let afterRestart;
  try {
    afterRestart = JSON.parse(await (await fetch(url)).text());
  } finally { await stopChild(second.child); }

  assert.notEqual(second.pid, first.pid, 'the service was actually restarted');
  assert.equal(afterRestart.lassoDataFromRedis, false, 'process 2: the relay cache did not survive the restart');
  assert.equal(afterRestart.relayData.timezone, 'UTC', 'process 2 relays correctly after the restart');
});
