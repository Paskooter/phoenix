// D-07 runtime probe — REAL HTTP requests through the REAL data service
// (`createDataService`), including the real ORS provider path (`defaultOrsGet`)
// driven by a stubbed global fetch that records the outgoing request.
//
// Run from the repository root:  node docs/parity/evidence/2026-09-10/d07-maps/probe.mjs
// Exit 0 = every expectation held. Each line is labelled PASS/FAIL.
import { createDataService } from '../../../../../packages/data/src/index.js';

const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}/v1/google_maps`;

// An ORS /v2/directions/{profile} body (docs: giscience.github.io/openrouteservice
// api-reference/endpoints/directions — bbox is [minLon,minLat,maxLon,maxLat],
// geometry is an encoded polyline, summary is {distance,duration}).
const ORS_FIXTURE = {
  bbox: [-71.1229, 42.36, -71.0589, 42.3727],
  routes: [{
    summary: { distance: 3851.2, duration: 1500.4 },
    bbox: [-71.1229, 42.36, -71.0589, 42.3727],
    geometry: 'mvutG~`c`MFYGO|A{D',
    segments: [{ distance: 3851.2, duration: 1500.4, steps: [] }],
    way_points: [0, 12],
  }],
  metadata: { attribution: 'openrouteservice.org | OpenStreetMap contributors' },
};

const origin = JSON.stringify({ lat: 42.3601, lon: -71.0589 });
const dest = JSON.stringify({ lat: 42.3727, lon: -71.1229 });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
}

// ---- service A: real provider path, stubbed global fetch recording the wire request
const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  wire.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return new Response(JSON.stringify(ORS_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
};
const svcA = createDataService({});
const serverA = await svcA.listen(PORT);

async function get(query, init) {
  const r = await realFetch(`${BASE}?${query}`, init);
  const text = await r.text();
  return { status: r.status, ctype: r.headers.get('content-type'), body: text };
}

// 1. every CommuteMode reaches the provider, on its own ORS profile.
const EXPECTED_PROFILE = {
  driving: 'driving-car', transit: 'driving-car', bicycling: 'cycling-regular', walking: 'foot-walking',
};
for (const mode of ['driving', 'transit', 'bicycling', 'walking']) {
  wire.length = 0;
  const r = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=${mode}`);
  const path = wire.length ? new URL(wire[0].url).pathname : '(no upstream call)';
  const want = `/v2/directions/${EXPECTED_PROFILE[mode]}`;
  check(`mode=${mode} -> 200 + ORS profile ${EXPECTED_PROFILE[mode]}`,
    r.status === 200 && path === want, `status=${r.status} upstream=${path}`);
  const j = JSON.parse(r.body);
  check(`mode=${mode} payload legs[0].duration.value`,
    j.relayData.routes[0].legs[0].duration.value === 1500, JSON.stringify(j.relayData.routes[0].legs[0].duration));
  check(`mode=${mode} cache key carries the mode`,
    j.relayData.routes[0].legs[0].duration.value === 1500 && r.status === 200 && wire[0].body !== null,
    `ors coords [lon,lat]=${JSON.stringify(wire.length ? wire[0].body.coordinates : null)}`);
}

// 2. routes geometry / bounds / status
wire.length = 0;
const okRoute = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`);
const okJson = JSON.parse(okRoute.body);
const route0 = okJson.relayData.routes[0];
check('route.overview_polyline.points from ORS geometry',
  route0.overview_polyline && route0.overview_polyline.points === ORS_FIXTURE.routes[0].geometry,
  JSON.stringify(route0.overview_polyline));
check('route.bounds northeast/southwest from ORS bbox',
  route0.bounds && route0.bounds.northeast.lat === 42.3727 && route0.bounds.southwest.lng === -71.1229,
  JSON.stringify(route0.bounds));
check('legs[0].duration_in_traffic mirrors duration (ORS has no traffic model)',
  route0.legs[0].duration_in_traffic.value === route0.legs[0].duration.value,
  JSON.stringify(route0.legs[0].duration_in_traffic));

// 3. validation: out-of-range coordinates must be rejected, provider untouched
for (const [label, o, d, want] of [
  ['lat>90', JSON.stringify({ lat: 800, lon: 58.6 }), dest, 'Invalid latitude 800'],
  ['lon>180', origin, JSON.stringify({ lat: -65, lon: 654 }), 'Invalid longitude 654'],
  ['lat missing', JSON.stringify({ lon: 58.6 }), dest, 'Invalid latitude undefined'],
  ['lon non-numeric', JSON.stringify({ lat: 42, lon: 'abc' }), dest, 'Invalid longitude abc'],
]) {
  wire.length = 0;
  const r = await get(`origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&mode=driving`);
  check(`reject ${label} -> 400 "${want}" and no upstream call`,
    r.status === 400 && r.body === want && wire.length === 0,
    `status=${r.status} body=${JSON.stringify(r.body)} upstreamCalls=${wire.length}`);
}

// 4. missing / bad mode
wire.length = 0;
const noMode = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`);
check('missing mode -> 400 `Invalid mode: "undefined"`',
  noMode.status === 400 && noMode.body === 'Invalid mode: "undefined"', `status=${noMode.status} body=${JSON.stringify(noMode.body)}`);
const badMode = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=blah`);
check('mode=blah -> 400 `Invalid mode: "blah"`',
  badMode.status === 400 && badMode.body === 'Invalid mode: "blah"', `status=${badMode.status} body=${JSON.stringify(badMode.body)}`);

// 5. empty provider reply -> 502 "Empty reply from GoogleMaps"
globalThis.fetch = async () => new Response('', { status: 200 });
const empty = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=walking&skipCache=1`);
check('empty upstream body -> 502 "Empty reply from GoogleMaps"',
  empty.status === 502 && empty.body === 'Empty reply from GoogleMaps', `status=${empty.status} body=${JSON.stringify(empty.body)}`);

// 6. upstream HTTP error -> status reproduced + JSON body in the message
// (real ORS error bodies observed live 2026-09-11: 401 "Authorization field missing")
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Authorization field missing' }),
  { status: 401, headers: { 'content-type': 'application/json' } });
const upErr = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving&skipCache=1`);
check('upstream 401 -> 401 `Error getting GoogleMaps data: {"error":"..."}`',
  upErr.status === 401 && upErr.body === 'Error getting GoogleMaps data: {"error":"Authorization field missing"}',
  `status=${upErr.status} body=${JSON.stringify(upErr.body)}`);

// 7. empty routes -> ZERO_RESULTS
globalThis.fetch = async () => new Response(JSON.stringify({ routes: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const zero = await get(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving&skipCache=1`);
const zeroJson = JSON.parse(zero.body);
check('empty routes -> ZERO_RESULTS + empty routes[]',
  zeroJson.relayData.status === 'ZERO_RESULTS' && zeroJson.relayData.routes.length === 0,
  JSON.stringify(zeroJson.relayData.status));

globalThis.fetch = realFetch;
await new Promise((res) => serverA.close(res));

// ---- service B: counting provider, asserts a rejected request never reaches it and never caches
let calls = 0;
const svcB = createDataService({ mapsGet: async () => { calls += 1; return ORS_FIXTURE; } });
const serverB = await svcB.listen(PORT + 1);
const b = async (q) => {
  const r = await realFetch(`http://127.0.0.1:${PORT + 1}/v1/google_maps?${q}`);
  return { status: r.status, body: await r.text() };
};
calls = 0;
const bad = await b(`origin=${encodeURIComponent(JSON.stringify({ lat: 800, lon: 58.6 }))}&destination=${encodeURIComponent(dest)}&mode=driving`);
check('provider override: out-of-range origin -> 400, provider calls = 0', bad.status === 400 && calls === 0, `status=${bad.status} calls=${calls}`);
const good = await b(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`);
const good2 = await b(`origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=driving`);
check('provider override: 200 then cache hit (1 upstream call)',
  good.status === 200 && good2.status === 200 && calls === 1 && JSON.parse(good2.body).lassoDataFromRedis === true,
  `calls=${calls} second=${JSON.parse(good2.body).lassoDataFromRedis}`);
await new Promise((res) => serverB.close(res));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probe expectations held`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
