// D-01 — common relay + cache contract.
//
// The oracle is the V-01 reference run, which executed the ORIGINAL
// AbstractRelayRequestHandler (pegasus d682547a31511cd164db0913b6104eb1786455a2)
// behind a `FixtureCalendar` relay:
//   scripts/parity-reference/capture.cjs:253-283
//   docs/parity/evidence/2026-09-05/reference/transactions.json
//     transactions relay-cache-miss / relay-cache-hit /
//     relay-skip-cache-string-false / relay-head-prefetch /
//     relay-invalid-input / relay-provider-failure / relay-empty-provider
//
// Part 1 replays that exact fixture through Phoenix's createRelay and compares
// every observable: status, content-type, byte-identical body and
// content-length. Part 2 pins details that the capture did not reach (upstream
// `.response` status, cache read/write failure tolerance, falsy provider
// results). Part 3 pins the per-relay TTLs and HEAD immediacy with a
// deterministic clock and a gated upstream.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '@phoenix/common';
import { TTLCache } from '../src/cache.js';
import { createRelay, fetchError } from '../src/relay.js';
import { createDataService } from '../src/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Listen on an ephemeral port and return the real port. */
async function listen(service) {
  const server = await service.listen(0);
  return { server, port: server.address().port };
}

/** Raw response capture — headers are part of the observed contract. */
async function call(port, path, method = 'GET') {
  const res = await fetch(`http://localhost:${port}${path}`, { method });
  return { status: res.status, type: res.headers.get('content-type'), len: res.headers.get('content-length'), body: await res.text() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 2000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('waitFor timed out');
}

// ---------------------------------------------------------------------------
// Part 1 — replay the original FixtureCalendar relay
// ---------------------------------------------------------------------------

let server;
let port;
let cache;
let calls;
let releaseSlow;
let slowReleased;
let slowGate;

before(async () => {
  cache = new TTLCache();
  calls = [];
  slowReleased = false;
  slowGate = new Promise((resolve) => { releaseSlow = () => { slowReleased = true; resolve(); }; });

  // Mirror of capture.cjs FixtureRelay (name/cacheSecondsToLive/validate/key/fetch).
  const relay = createRelay({
    name: 'FixtureCalendar',
    ttlSeconds: 60,
    cache,
    validate: (q) => { if (!q.get('key')) throw new Error('fixture key required'); return { key: q.get('key') }; },
    key: (input) => 'fixture:' + input.key,
    fetchExternal: async (input) => {
      calls.push(input.key);
      if (input.key === 'failure') throw new Error('fixture provider unavailable');
      if (input.key === 'empty') return null;
      if (input.key === 'slow') { await slowGate; return { events: [] }; }
      return { events: [] };
    },
  });
  const svc = createService({ name: 'fixture-lasso', routes: { 'GET /v1/calendar': relay, 'HEAD /v1/calendar': relay } });
  ({ server, port } = await listen(svc));
});

after(() => server?.close?.());

test('D01/1 relay-cache-miss: JSON envelope {relayData,lassoDataFromRedis:false} at 54 bytes', async () => {
  calls.length = 0;
  const r = await call(port, '/v1/calendar?key=calendar');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/json; charset=utf-8');
  assert.equal(r.body, '{"relayData":{"events":[]},"lassoDataFromRedis":false}');
  assert.equal(r.body.length, 54);          // captured content-length: 54
  assert.deepEqual(calls, ['calendar']);    // one live provider call
});

test('D01/2 relay-cache-hit: stored bytes echoed verbatim as text/html at 107 bytes', async () => {
  calls.length = 0;
  const r = await call(port, '/v1/calendar?key=calendar');
  assert.equal(r.status, 200);
  // ORIGINAL OBSERVED: the hit is `response.send(<stored string>)` -> text/html,
  // NOT the miss's application/json.
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.equal(r.body.length, 107);         // captured content-length: 107
  assert.deepEqual(calls, [], 'cache hit performs no provider call');

  // The body is the cached value re-serialised, byte for byte.
  const stored = cache.get('fixture:calendar');
  assert.equal(r.body, JSON.stringify(stored));
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.lassoDataFromRedis, true);
  assert.equal(parsed.relayData.events.length, 0);
  assert.match(parsed.lassoInsertedIntoRedisAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('D01/3 relay-skip-cache-string-false: the string "false" still skips the cache read', async () => {
  calls.length = 0;
  const r = await call(port, '/v1/calendar?key=calendar&skipCache=false');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/json; charset=utf-8');
  assert.equal(r.body, '{"relayData":{"events":[]},"lassoDataFromRedis":false}');
  assert.deepEqual(calls, ['calendar'], 'provider was called again despite a warm cache');
});

test('D01/4 skipCache with an empty value is falsy and therefore reads the cache', async () => {
  calls.length = 0;
  const r = await call(port, '/v1/calendar?key=calendar&skipCache=');
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.equal(JSON.parse(r.body).lassoDataFromRedis, true);
  assert.deepEqual(calls, []);
});

test('D01/5 relay-head-prefetch: empty 200, no content-type, and it warms the cache', async () => {
  calls.length = 0;
  const head = await call(port, '/v1/calendar?key=prefetch', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  // ORIGINAL OBSERVED: `response.send()` with no argument sets no entity headers.
  assert.equal(head.type, null, 'HEAD carries no content-type');
  assert.equal(head.len, null, 'HEAD carries no content-length');

  await waitFor(() => cache.get('fixture:prefetch'));
  const g = await call(port, '/v1/calendar?key=prefetch');
  assert.equal(JSON.parse(g.body).lassoDataFromRedis, true, 'HEAD warmed the cache');
  assert.deepEqual(calls, ['prefetch'], 'HEAD performed the provider work once');
});

test('D01/6 relay-invalid-input: 400 text/html with the raw validation message', async () => {
  const r = await call(port, '/v1/calendar');
  assert.equal(r.status, 400);
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.equal(r.body, 'fixture key required');
  assert.equal(r.body.length, 20);          // captured content-length: 20
});

test('D01/6b validation runs before the HEAD branch: HEAD with bad input is 400, not 200', async () => {
  const r = await call(port, '/v1/calendar', 'HEAD');
  assert.equal(r.status, 400);              // source lines 56-62 precede lines 69-73
  assert.equal(r.type, 'text/html; charset=utf-8');
  // Node strips the entity from a HEAD response but keeps the framing header.
  assert.equal(r.body, '');
  assert.equal(r.len, '20');
});

test('D01/7 relay-provider-failure: 502 with "Error getting <name> data: " + String(err)', async () => {
  const r = await call(port, '/v1/calendar?key=failure');
  assert.equal(r.status, 502);
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.equal(r.body, 'Error getting FixtureCalendar data: Error: fixture provider unavailable');
  assert.equal(r.body.length, 71);          // captured content-length: 71
});

test('D01/8 relay-empty-provider: 502 with "Empty reply from <name>"', async () => {
  const r = await call(port, '/v1/calendar?key=empty');
  assert.equal(r.status, 502);
  assert.equal(r.type, 'text/html; charset=utf-8');
  assert.equal(r.body, 'Empty reply from FixtureCalendar');
  assert.equal(r.body.length, 32);          // captured content-length: 32
});

test('D01/9 prefetch responds immediately, before the provider settles', async () => {
  // `slow` only settles when slowGate is released; the HEAD must answer first.
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error('HEAD blocked on the provider')), 3000);
  });
  let head;
  try {
    head = await Promise.race([call(port, '/v1/calendar?key=slow', 'HEAD'), guard]);
  } finally {
    clearTimeout(guardTimer);
  }
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(slowReleased, false, 'HEAD answered while the provider was still pending');

  releaseSlow();
  await waitFor(() => cache.get('fixture:slow'));
  const g = await call(port, '/v1/calendar?key=slow');
  assert.equal(JSON.parse(g.body).lassoDataFromRedis, true);
});

test('D01/9b a prefetch whose provider fails still answers the empty 200', async () => {
  // Source: line 71 sends the HEAD response before the provider is called, so
  // the client already holds the empty 200 when line 107 runs. Phoenix returns
  // instead of double-sending; the client-visible result is the same.
  const r = await call(port, '/v1/calendar?key=failure', 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
  assert.equal((await call(port, '/v1/calendar?key=calendar')).status, 200, 'server still serving');
});

// ---------------------------------------------------------------------------
// Part 2 — details beyond the capture, pinned to the source
// ---------------------------------------------------------------------------

test('D01/10 fetchError reproduces an upstream .response status and body', () => {
  // AbstractRelayRequestHandler.ts:159-161.
  const ce = fetchError('DarkSky', { response: { status: 503, data: { message: 'upstream down' } } });
  assert.equal(ce.status, 503);
  assert.equal(ce.message, 'Error getting DarkSky data: {"message":"upstream down"}');
});

test('D01/11 fetchError falls back to 502 with Error string concatenation', () => {
  // AbstractRelayRequestHandler.ts:163 — `+ err`, so an Error renders as "Error: msg".
  const ce = fetchError('DarkSky', new Error('socket hang up'));
  assert.equal(ce.status, 502);
  assert.equal(ce.message, 'Error getting DarkSky data: Error: socket hang up');
});

test('D01/12 a relay with an upstream .response error serves that status, not 502', async () => {
  const relay = createRelay({
    name: 'Upstream',
    ttlSeconds: 60,
    cache: new TTLCache(),
    validate: () => ({}),
    key: () => 'upstream:1',
    fetchExternal: async () => { const e = new Error('bad gateway'); e.response = { status: 504, data: { error: 'gateway timeout' } }; throw e; },
  });
  const svc = createService({ name: 'upstream-svc', routes: { 'GET /x': relay } });
  const { server: s, port: p } = await listen(svc);
  try {
    const r = await call(p, '/x');
    assert.equal(r.status, 504);
    assert.equal(r.type, 'text/html; charset=utf-8');
    assert.equal(r.body, 'Error getting Upstream data: {"error":"gateway timeout"}');
  } finally { s.close(); }
});

test('D01/13 falsy provider results are "Empty reply" (source line 167 `if (!relayData)`)', async () => {
  for (const value of [null, undefined, false, 0, '']) {
    const relay = createRelay({
      name: 'Empty',
      ttlSeconds: 60,
      cache: new TTLCache(),
      validate: () => ({}),
      key: () => 'empty:1',
      fetchExternal: async () => value,
    });
    const svc = createService({ name: 'empty-svc', routes: { 'GET /x': relay } });
    const { server: s, port: p } = await listen(svc);
    try {
      const r = await call(p, '/x');
      assert.equal(r.status, 502, `falsy ${JSON.stringify(value)} -> 502`);
      assert.equal(r.body, 'Empty reply from Empty');
    } finally { s.close(); }
  }
});

test('D01/14 a cache read failure is non-fatal: the relay fetches live', async () => {
  const cacheStub = { get() { throw new Error('redis down'); }, set() {} };
  const relay = createRelay({
    name: 'CacheReadFail',
    ttlSeconds: 60,
    cache: cacheStub,
    validate: () => ({}),
    key: () => 'k',
    fetchExternal: async () => ({ ok: true }),
  });
  const svc = createService({ name: 'crf', routes: { 'GET /x': relay } });
  const { server: s, port: p } = await listen(svc);
  try {
    const r = await call(p, '/x');
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"relayData":{"ok":true},"lassoDataFromRedis":false}');
  } finally { s.close(); }
});

test('D01/15 a cache write failure is non-fatal: the miss response still goes out', async () => {
  let wrote = false;
  const cacheStub = { get() { return null; }, set() { wrote = true; throw new Error('redis down'); } };
  const relay = createRelay({
    name: 'CacheWriteFail',
    ttlSeconds: 60,
    cache: cacheStub,
    validate: () => ({}),
    key: () => 'k',
    fetchExternal: async () => ({ ok: true }),
  });
  const svc = createService({ name: 'cwf', routes: { 'GET /x': relay } });
  const { server: s, port: p } = await listen(svc);
  try {
    const r = await call(p, '/x');
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"relayData":{"ok":true},"lassoDataFromRedis":false}');
    assert.equal(wrote, true, 'the write was attempted after the response');
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Part 3 — TTLs and the deterministic clock
// ---------------------------------------------------------------------------

test('D01/16 per-relay TTLs expire exactly at 900s (weather/maps) and 3900s (news)', async (t) => {
  // Deterministic clock. This observes Phoenix's own TTLCache expiry — the
  // reference's expiry is Redis `EX` and is UNKNOWN here (see report).
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const cache = new TTLCache();
  const calls = { weather: 0, news: 0, maps: 0 };
  const svc = createDataService({
    cache,
    weatherGet: async () => { calls.weather++; return { daily: {} }; },
    newsGet: async () => { calls.news++; return '<feed><entry><title>t</title></entry></feed>'; },
    mapsGet: async () => { calls.maps++; return { routes: [{ summary: { duration: 60, distance: 100 } }] }; },
  });
  const { server: s, port: p } = await listen(svc);
  try {
    const w = () => call(p, '/v1/dark_sky?lat=1&lon=2').then((r) => JSON.parse(r.body));
    const n = () => call(p, '/v1/ap_news?sourceID=42209').then((r) => JSON.parse(r.body));
    const m = () => call(p, '/v1/google_maps?origin={"lat":1,"lon":2}&destination={"lat":3,"lon":4}&mode=driving').then((r) => JSON.parse(r.body));

    assert.equal((await w()).lassoDataFromRedis, false);
    assert.equal((await n()).lassoDataFromRedis, false);
    assert.equal((await m()).lassoDataFromRedis, false);
    assert.deepEqual(calls, { weather: 1, news: 1, maps: 1 });

    t.mock.timers.tick(900 * 1000 - 1);          // 899.999s
    assert.equal((await w()).lassoDataFromRedis, true, 'weather still cached just under 900s');
    assert.equal((await m()).lassoDataFromRedis, true, 'maps still cached just under 900s');
    assert.equal((await n()).lassoDataFromRedis, true, 'news still cached at 899.999s');
    assert.deepEqual(calls, { weather: 1, news: 1, maps: 1 });

    t.mock.timers.tick(1);                       // 900.000s -> weather/maps expire
    assert.equal((await w()).lassoDataFromRedis, false, 'weather expired at 900s');
    assert.equal((await m()).lassoDataFromRedis, false, 'maps expired at 900s');
    assert.equal((await n()).lassoDataFromRedis, true, 'news has a 65-minute TTL, still cached');
    assert.deepEqual(calls, { weather: 2, news: 1, maps: 2 });

    t.mock.timers.tick(3900 * 1000 - 900 * 1000 - 1);
    assert.equal((await n()).lassoDataFromRedis, true, 'news still cached just under 3900s');
    t.mock.timers.tick(1);
    assert.equal((await n()).lassoDataFromRedis, false, 'news expired at 3900s');
    assert.equal(calls.news, 2);
  } finally { s.close(); }
});
