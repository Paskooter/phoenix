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
  COMMUTE_MODES, makeLatLon, validateMaps, mapsKey, fetchMaps, openRouteServiceToGoogleMaps,
} from '../src/maps.js';
import { createDataService } from '../src/index.js';

const origin = JSON.stringify({ lat: 42.3601, lon: -71.0589 });
const dest = JSON.stringify({ lat: 42.3727, lon: -71.1229 });
const qs = (o, d, mode) => new URLSearchParams(
  `origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}` + (mode === undefined ? '' : `&mode=${mode}`));

// ORS /v2/directions body (giscience.github.io/openrouteservice api-reference/
// endpoints/directions: bbox [minLon,minLat,maxLon,maxLat], geometry encoded
// polyline, summary {distance,duration}).
const ORS = {
  bbox: [-71.1229, 42.36, -71.0589, 42.3727],
  routes: [{
    summary: { distance: 16093.44, duration: 1500 },
    bbox: [-71.1229, 42.36, -71.0589, 42.3727],
    geometry: 'mvutG~`c`MFYGO|A{D',
    segments: [{ distance: 16093.44, duration: 1500, steps: [] }],
    way_points: [0, 12],
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

test('D07/route-geometry: overview_polyline + bounds come from ORS geometry/bbox', () => {
  const m = openRouteServiceToGoogleMaps(ORS, { lat: 42.3601, lon: -71.0589 }, { lat: 42.3727, lon: -71.1229 });
  assert.equal(m.status, 'OK');
  const route = m.routes[0];
  assert.deepEqual(route.overview_polyline, { points: 'mvutG~`c`MFYGO|A{D' });
  assert.deepEqual(route.bounds, {
    northeast: { lat: 42.3727, lng: -71.0589 }, southwest: { lat: 42.36, lng: -71.1229 },
  });
  // absent ORS geometry/bbox -> the optional Google fields are simply omitted
  const bare = openRouteServiceToGoogleMaps({ routes: [{ summary: { distance: 10, duration: 60 } }] }, { lat: 1, lon: 2 }, { lat: 3, lon: 4 });
  assert.equal('overview_polyline' in bare.routes[0], false);
  assert.equal('bounds' in bare.routes[0], false);
});

test('D07/leg: geometry, units and duration/duration_in_traffic fields', () => {
  const leg = openRouteServiceToGoogleMaps(ORS, { lat: 42.3601, lon: -71.0589 }, { lat: 42.3727, lon: -71.1229 }).routes[0].legs[0];
  assert.deepEqual(leg.duration, { text: '25 mins', value: 1500 });
  assert.equal(leg.distance.value, 16093);            // Google's distance.value is always metres
  assert.equal(leg.duration_in_traffic.value, leg.duration.value); // ORS has no traffic model
  assert.deepEqual(leg.start_location, { lat: 42.3601, lng: -71.0589 });
  assert.deepEqual(leg.end_location, { lat: 42.3727, lng: -71.1229 });
});

test('D07/empty-routes: no routes -> ZERO_RESULTS with an empty routes[]', () => {
  assert.deepEqual(openRouteServiceToGoogleMaps({ routes: [] }, {}, {}),
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

test('D07/runtime-modes: every CommuteMode reaches ORS on its own profile', async () => {
  const wire = [];
  globalThis.fetch = async (url, o) => {
    wire.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    return new Response(JSON.stringify(ORS), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await withService(7811, {}, async (port) => {
      const want = { driving: 'driving-car', transit: 'driving-car', bicycling: 'cycling-regular', walking: 'foot-walking' };
      for (const mode of COMMUTE_MODES) {
        wire.length = 0;
        const r = await req(port, `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=${mode}`);
        const body = await r.json();
        assert.equal(r.status, 200, mode);
        assert.equal(new URL(wire[0].url).pathname, `/v2/directions/${want[mode]}`, mode);
        assert.deepEqual(wire[0].body.coordinates, [[-71.0589, 42.3601], [-71.1229, 42.3727]], `${mode} lon,lat order`);
        assert.equal(wire[0].headers['Content-Type'], 'application/json', mode);
        assert.equal(wire[0].headers.Accept, 'application/json, application/geo+json, application/gpx+xml', mode);
        assert.equal(body.relayData.routes[0].legs[0].duration.value, 1500, mode);
        assert.equal(body.lassoDataFromRedis, false, mode);
      }
    });
  } finally { globalThis.fetch = realFetch; }
});

test('D07/runtime-reject: out-of-range coords -> 400 text, provider untouched, nothing cached', async () => {
  let calls = 0;
  await withService(7812, { mapsGet: async () => { calls += 1; return ORS; } }, async (port) => {
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
