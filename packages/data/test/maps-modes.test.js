// D-07 — maps routes, modes and commute payloads.
//
// Pinned reference: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/lasso/src/relay/GoogleMapsHandler.ts
//   packages/lasso/src/utils/LatLon.ts
//   packages/lasso/tests/relay/GoogleMaps.test.ts
//   packages/interfaces/src/personalreport/googlemaps.ts
//   packages/test-utils/src/lasso-test/GoogleMapsTestData.ts
// Runtime evidence: docs/parity/evidence/2026-09-10/d07-maps/{probe.mjs,evidence.md}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUTE_MODES, makeLatLon, validateMaps, mapsKey, fetchMaps, tomTomToGoogleMaps,
} from '../src/maps.js';
import { createDataService } from '../src/index.js';

const origin = JSON.stringify({ lat: 42.3601, lon: -71.0589 });
const dest = JSON.stringify({ lat: 42.3727, lon: -71.1229 });
const qs = (o, d, mode) => new URLSearchParams(
  `origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` + (mode === undefined ? '' : `&mode=${mode}`));

// TomTom calculateRoute body (developer.tomtom.com routing v1: summary carries
// travelTimeInSeconds plus the traffic breakdown that computeTravelTimeFor=all
// requests, and lengthInMeters).
const TOMTOM = {
  routes: [{
    summary: {
      lengthInMeters: 16093.44,
      travelTimeInSeconds: 1500,
      noTrafficTravelTimeInSeconds: 1500,
      historicTrafficTravelTimeInSeconds: 1500,
      liveTrafficIncidentsTravelTimeInSeconds: 1500,
      trafficDelayInSeconds: 0,
    },
  }],
};

// ---------------------------------------------------------------- validation

test('D07/lat-range: origin {lat:800} -> "Invalid latitude 800" (pinned GoogleMaps.test.ts:146)', () => {
  assert.throws(() => validateMaps(qs(JSON.stringify({ lat: 800, lon: 58.6 }), dest, 'driving')),
    (e) => e instanceof RangeError && e.message === 'Invalid latitude 800');
});

test('D07/lon-range: destination {lon:654} -> "Invalid longitude 654" (pinned GoogleMaps.test.ts:150)', () => {
  assert.throws(() => validateMaps(qs(origin, JSON.stringify({ lat: -65, lon: 654 }), 'driving')),
    (e) => e instanceof RangeError && e.message === 'Invalid longitude 654');
});

test('D07/boundaries: +/-90 lat and +/-180 lon are accepted, just outside are not (LatLon.ts:9-14)', () => {
  assert.deepEqual(makeLatLon(90, 180), { lat: 90, lon: 180 });
  assert.deepEqual(makeLatLon(-90, -180), { lat: -90, lon: -180 });
  assert.throws(() => makeLatLon(90.0001, 0), /^RangeError: Invalid latitude 90\.0001$/);
  assert.throws(() => makeLatLon(0, -180.0001), /^RangeError: Invalid longitude -180\.0001$/);
  // range messages carry the parsed float, the regex messages the raw value
  assert.throws(() => makeLatLon('800.00', 0), /^RangeError: Invalid latitude 800$/);
});

test('D07/format: non-numeric and missing values carry the raw value in the message (LatLon.ts:20-31)', () => {
  assert.throws(() => makeLatLon('abc', 1), /^RangeError: Invalid latitude abc$/);
  assert.throws(() => makeLatLon(1, 'abc'), /^RangeError: Invalid longitude abc$/);
  assert.throws(() => makeLatLon(undefined, 1), /Invalid latitude undefined/);
  assert.throws(() => makeLatLon(1, undefined), /Invalid longitude undefined/);
  assert.throws(() => makeLatLon(null, 1), /Invalid latitude null/);
  assert.throws(() => makeLatLon('4.2e1', 1), /Invalid latitude 4\.2e1/); // regex has no exponent form
  assert.equal(makeLatLon('42.3601', '-71.0589').lon, -71.0589);
});

test('D07/nested-query: origin/destination are JSON strings (LassoClient axios serialisation)', () => {
  assert.throws(() => validateMaps(qs('42.36,-71.06', dest, 'driving')),
    /Could not parse origin: 42\.36,-71\.06/);
  assert.throws(() => validateMaps(qs(origin, 'not json', 'driving')),
    /Could not parse destination: not json/);
  assert.throws(() => validateMaps(qs('', '', 'driving')), /Origin required/); // empty string is falsy
  assert.throws(() => validateMaps(qs(origin, dest)), /Invalid mode: "undefined"/); // pinned :166
});

// -------------------------------------------------------------------- modes

test('D07/modes: CommuteMode order is driving,transit,bicycling,walking (googlemaps.ts:181-186)', () => {
  assert.deepEqual(COMMUTE_MODES, ['driving', 'transit', 'bicycling', 'walking']);
  for (const m of COMMUTE_MODES) assert.equal(validateMaps(qs(origin, dest, m)).mode, m);
});

test('D07/key: google_maps:oLat;oLon;dLat;dLon;mode (GoogleMapsHandler.ts:67-70)', () => {
  const input = validateMaps(qs(origin, dest, 'bicycling'));
  assert.equal(mapsKey(input), 'google_maps:42.3601;-71.0589;42.3727;-71.1229;bicycling');
  // the key is built from the parsed floats, not the raw query text
  assert.equal(mapsKey(validateMaps(qs(JSON.stringify({ lat: 42.36010, lon: -71.05890 }), dest, 'walking'))),
    'google_maps:42.3601;-71.0589;42.3727;-71.1229;walking');
});

// ------------------------------------------------------------------- routes

test('D07/route-geometry: overview_polyline and bounds are omitted under TomTom', () => {
  // ORS returned an encoded polyline and a bbox, so the relay used to populate
  // Google's overview_polyline/bounds. TomTom returns route geometry as point
  // arrays instead, and report-skill's commute subskill reads neither field, so
  // they are deliberately not synthesised. Recorded in DIVERGENCES.md.
  const m = tomTomToGoogleMaps(TOMTOM, { lat: 42.3601, lon: -71.0589 }, { lat: 42.3727, lon: -71.1229 });
  assert.equal(m.routes[0].overview_polyline, undefined);
  assert.equal(m.routes[0].bounds, undefined);
  assert.equal(m.routes[0].summary, 'TomTom');
  assert.equal(m.routes[0].copyrights, 'TomTom');
});

test('D07/leg: units and duration/duration_in_traffic fields', () => {
  const leg = tomTomToGoogleMaps(TOMTOM, { lat: 42.3601, lon: -71.0589 }, { lat: 42.3727, lon: -71.1229 }).routes[0].legs[0];
  assert.deepEqual(leg.duration, { text: '25 mins', value: 1500 });
  assert.equal(leg.distance.value, 16093);            // Google's distance.value is always metres
  assert.equal(leg.duration_in_traffic.value, leg.duration.value); // free-flowing at this moment
  assert.deepEqual(leg.start_location, { lat: 42.3601, lng: -71.0589 });
  assert.deepEqual(leg.end_location, { lat: 42.3727, lng: -71.1229 });
});

test('D07/empty-routes: no routes -> ZERO_RESULTS with an empty routes[]', () => {
  assert.deepEqual(tomTomToGoogleMaps({ routes: [] }, {}, {}),
    { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] });
});

test('D07/empty-reply: an empty provider body is returned as null so the relay sends 502', async () => {
  assert.equal(await fetchMaps({ origin: {}, destination: {}, mode: 'driving' }, { get: async () => null }), null);
});

// ------------------------------------------- runtime (real HTTP, real service)

const realFetch = globalThis.fetch;
const req = (port, q, method = 'GET') => realFetch(`http://127.0.0.1:${port}/v1/google_maps?${q}`, { method });

async function withService(port, opts, fn) {
  const srv = await createDataService(opts).listen(port);
  try { return await fn(port); } finally { await new Promise((r) => srv.close(r)); }
}

test('D07/runtime-modes: every CommuteMode reaches TomTom on its own travel mode', async () => {
  const wire = [];
  globalThis.fetch = async (url, o) => {
    wire.push({ url: String(url), headers: (o && o.headers) || {} });
    return new Response(JSON.stringify(TOMTOM), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const priorKey = process.env.TOMTOM_API_KEY;
  process.env.TOMTOM_API_KEY = 'test-key';
  try {
    await withService(7811, {}, async (port) => {
      const want = { driving: 'car', transit: 'bus', bicycling: 'bicycle', walking: 'pedestrian' };
      for (const mode of COMMUTE_MODES) {
        wire.length = 0;
        const r = await req(port, `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=${mode}`);
        const body = await r.json();
        assert.equal(r.status, 200, mode);
        const u = new URL(wire[0].url);
        assert.equal(u.pathname,
          `/routing/1/calculateRoute/42.3601,-71.0589:42.3727,-71.1229/json`, `${mode} lat,lon order`);
        assert.equal(u.searchParams.get('travelMode'), want[mode], mode);
        // Without computeTravelTimeFor=all TomTom silently omits the traffic
        // breakdown, which is indistinguishable from "no traffic right now".
        assert.equal(u.searchParams.get('computeTravelTimeFor'), 'all', mode);
        assert.equal(u.searchParams.get('traffic'), 'true', mode);
        assert.equal(u.searchParams.get('key'), 'test-key', mode);
        assert.equal(body.relayData.routes[0].legs[0].duration.value, 1500, mode);
        assert.equal(body.lassoDataFromRedis, false, mode);
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    if (priorKey === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = priorKey;
  }
});

test('D07/runtime-reject: out-of-range coords -> 400 text, provider untouched, nothing cached', async () => {
  let calls = 0;
  await withService(7812, { mapsGet: async () => { calls += 1; return TOMTOM; } }, async (port) => {
    const cases = [
      [JSON.stringify({ lat: 800, lon: 58.6 }), dest, 'Invalid latitude 800'],
      [origin, JSON.stringify({ lat: -65, lon: 654 }), 'Invalid longitude 654'],
      [JSON.stringify({ lon: 58.6 }), dest, 'Invalid latitude undefined'],
      [origin, dest, 'Invalid mode: "undefined"', true],
    ];
    for (const [o, d, want, noMode] of cases) {
      const r = await req(port, `origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` + (noMode ? '' : '&mode=driving'));
      assert.equal(r.status, 400, want);
      assert.equal(await r.text(), want);
      assert.match(r.headers.get('content-type'), /^text\/html/);
    }
    assert.equal(calls, 0, 'no invalid request may reach the provider');
    // a rejected request must not poison the cache: the same coordinates with a
    // valid value still fetch, and the second valid request is a cache hit.
    assert.equal((await req(port, `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`)).status, 200);
    const hit = await req(port, `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`);
    assert.equal((await hit.json()).lassoDataFromRedis, true);
    assert.equal(calls, 1);
  });
});

test('D07/runtime-upstream-errors: empty body -> 502 Empty reply; HTTP error -> status + json body', async () => {
  await withService(7813, {}, async (port) => {
    const q = `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=walking&skipCache=1`;
    try {
      globalThis.fetch = async () => new Response('', { status: 200 });
      const empty = await req(port, q);
      assert.equal(empty.status, 502);
      assert.equal(await empty.text(), 'Empty reply from GoogleMaps'); // pinned GoogleMaps.test.ts:110-111
      // real ORS error body (observed 2026-09-11)
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Authorization field missing' }),
        { status: 401, headers: { 'content-type': 'application/json' } });
      const bad = await req(port, q);
      assert.equal(bad.status, 401);
      assert.equal(await bad.text(), 'Error getting GoogleMaps data: {"error":"Authorization field missing"}');
    } finally { globalThis.fetch = realFetch; }
  });
});
