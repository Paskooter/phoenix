import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateMaps, openRouteServiceToGoogleMaps, COMMUTE_MODES } from '../src/maps.js';
import { createDataService } from '../src/index.js';

const PORT = 7797;
const ORS = { routes: [{ summary: { duration: 1500, distance: 16093.44 } }] };
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

test('openRouteServiceToGoogleMaps maps duration/distance into the Maps shape', () => {
  const m = openRouteServiceToGoogleMaps(ORS, { lat: 42.36, lon: -71.06 }, { lat: 42.37, lon: -71.1 });
  assert.equal(m.status, 'OK');
  const leg = m.routes[0].legs[0];
  assert.equal(leg.duration.value, 1500);
  assert.equal(leg.duration.text, '25 mins');
  assert.equal(leg.duration_in_traffic.value, 1500); // ORS has no traffic -> same
  assert.equal(leg.distance.value, 16093);
  assert.equal(leg.distance.text, '10.0 mi');
});

test('no routes -> ZERO_RESULTS', () => {
  const m = openRouteServiceToGoogleMaps({ routes: [] }, {}, {});
  assert.equal(m.status, 'ZERO_RESULTS');
});

let server;
let calls = 0;
before(async () => {
  calls = 0;
  const svc = createDataService({ mapsGet: async () => { calls++; return ORS; } });
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
