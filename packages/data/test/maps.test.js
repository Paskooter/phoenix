import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateMaps, tomTomToGoogleMaps, COMMUTE_MODES } from '../src/maps.js';
import { createDataService } from '../src/index.js';

const PORT = 7797;
// A TomTom calculateRoute summary. The traffic and free-flow times differ,
// which is the whole reason TomTom replaced OpenRouteService.
const TOMTOM = { routes: [{ summary: {
  travelTimeInSeconds: 1500,
  noTrafficTravelTimeInSeconds: 1500,
  liveTrafficIncidentsTravelTimeInSeconds: 1500,
  lengthInMeters: 16093.44,
} }] };
const origin = JSON.stringify({ lat: 42.36, lon: -71.06 });
const dest = JSON.stringify({ lat: 42.37, lon: -71.1 });

test('validateMaps parses origin/destination JSON + validates mode', () => {
  assert.throws(() => validateMaps(new URLSearchParams(`destination=${dest}&mode=driving`)), /Origin required/);
  assert.throws(() => validateMaps(new URLSearchParams(`origin=${origin}&destination=${dest}&mode=teleport`)), /Invalid mode/);
  const v = validateMaps(new URLSearchParams(`origin=${origin}&destination=${dest}&mode=driving`));
  assert.deepEqual(v.origin, { lat: 42.36, lon: -71.06 });
  assert.equal(v.mode, 'driving');
  assert.ok(COMMUTE_MODES.includes('walking'));
});

test('tomTomToGoogleMaps maps duration/distance into the Maps shape', () => {
  const m = tomTomToGoogleMaps(TOMTOM, { lat: 42.36, lon: -71.06 }, { lat: 42.37, lon: -71.1 });
  assert.equal(m.status, 'OK');
  const leg = m.routes[0].legs[0];
  assert.equal(leg.duration.value, 1500);
  assert.equal(leg.duration.text, '25 mins');
  assert.equal(leg.duration_in_traffic.value, 1500);
  assert.equal(leg.distance.value, 16093);
  assert.equal(leg.distance.text, '10.0 mi');
});

test('tomTomToGoogleMaps carries a real traffic delay into duration_in_traffic', () => {
  // The case OpenRouteService could never produce: free-flow and traffic differ,
  // so report-skill's extraMins is non-zero and its Poor/Terrible MIMs reachable.
  const congested = { routes: [{ summary: {
    noTrafficTravelTimeInSeconds: 600,
    liveTrafficIncidentsTravelTimeInSeconds: 1500,
    lengthInMeters: 16093.44,
  } }] };
  const leg = tomTomToGoogleMaps(congested, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }).routes[0].legs[0];
  assert.equal(leg.duration.value, 600);
  assert.equal(leg.duration_in_traffic.value, 1500);
  assert.equal(Math.round((leg.duration_in_traffic.value - leg.duration.value) / 60), 15);
});

test('tomTomToGoogleMaps falls back through historic to plain travel time', () => {
  const noBreakdown = { routes: [{ summary: { travelTimeInSeconds: 900, lengthInMeters: 1000 } }] };
  const leg = tomTomToGoogleMaps(noBreakdown, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }).routes[0].legs[0];
  assert.equal(leg.duration.value, 900);
  assert.equal(leg.duration_in_traffic.value, 900);
});

test('no routes -> ZERO_RESULTS', () => {
  const m = tomTomToGoogleMaps({ routes: [] }, {}, {});
  assert.equal(m.status, 'ZERO_RESULTS');
});

let server;
let calls = 0;
before(async () => {
  calls = 0;
  const svc = createDataService({ mapsGet: async () => { calls++; return TOMTOM; } });
  server = await svc.listen(PORT);
});
after(() => server?.close?.());

test('GET /v1/google_maps: envelope + cache', async () => {
  const url = `http://localhost:${PORT}/v1/google_maps?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`;
  const r1 = await (await fetch(url)).json();
  assert.equal(r1.lassoDataFromRedis, false);
  assert.equal(r1.relayData.routes[0].legs[0].duration.value, 1500);
  const r2 = await (await fetch(url)).json();
  assert.equal(r2.lassoDataFromRedis, true);
  assert.equal(calls, 1, 'cached');
});

test('bad mode -> 400', async () => {
  const url = `http://localhost:${PORT}/v1/google_maps?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=fly`;
  assert.equal((await fetch(url)).status, 400);
});
