// S-11 Maps/report boundary lane.
//
// Source rows: pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/lasso/tests/relay/GoogleMaps.test.ts:59-171 and
// packages/report-skill/src/subskills/commute/{CommuteData,CommuteParse}.ts.
// Keep the HTTP checks here independent of maps-modes.test.js: the source rows
// assert the relay's status/body/cache effects, while this lane follows one
// representative relay route into the report's data and parse boundaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataService } from '../../data/src/index.js';
import { TTLCache } from '../../data/src/cache.js';
import { tomTomToGoogleMaps } from '../../data/src/maps.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { commuteParse, getData as getCommuteData } from '../src/report/commute.js';

const ORIGIN = { lat: 45.5000668, lon: -73.5849567 };
const DESTINATION = { lat: 45.5100214, lon: -73.5519883 };
const originJSON = JSON.stringify(ORIGIN);
const destinationJSON = JSON.stringify(DESTINATION);

// The values are the representative route fields asserted by the original
// GoogleMaps test fixture (distance 3851m, duration 2855s). The relay's TomTom
// adapter reshapes these into the Google Maps subset consumed by CommuteParse.
const TOMTOM_ROUTE = {
  routes: [{
    summary: {
      lengthInMeters: 3851,
      travelTimeInSeconds: 2855,
      noTrafficTravelTimeInSeconds: 2855,
      liveTrafficIncidentsTravelTimeInSeconds: 2855,
    },
  }],
};

function query(options = {}) {
  const origin = Object.prototype.hasOwnProperty.call(options, 'origin') ? options.origin : originJSON;
  const destination = Object.prototype.hasOwnProperty.call(options, 'destination') ? options.destination : destinationJSON;
  const mode = Object.prototype.hasOwnProperty.call(options, 'mode') ? options.mode : 'driving';
  const params = new URLSearchParams();
  if (origin !== undefined) params.set('origin', origin);
  if (destination !== undefined) params.set('destination', destination);
  if (mode !== undefined) params.set('mode', mode);
  return params.toString();
}

async function request(port, qs, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}/v1/google_maps?${qs}`, { method });
  return {
    response,
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  };
}

async function withDataService(options, callback) {
  const server = await createDataService(options).listen(0);
  try { return await callback(server.address().port); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function noOpLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test('S-11 Maps GET miss returns the commute route fields in the relay envelope', async () => {
  let calls = 0;
  await withDataService({ mapsGet: async () => { calls += 1; return TOMTOM_ROUTE; } }, async (port) => {
    const { status, type, body } = await request(port, query());
    assert.equal(status, 200);
    assert.equal(type, 'application/json; charset=utf-8');
    const payload = JSON.parse(body);
    assert.equal(payload.lassoDataFromRedis, false);

    const leg = payload.relayData.routes[0].legs[0];
    assert.equal(payload.relayData.status, 'OK');
    assert.equal(leg.distance.value, 3851); // source GoogleMaps.test.ts:59-75
    assert.equal(leg.duration.value, 2855);
    assert.equal(leg.duration_in_traffic.value, 2855);
    assert.deepEqual(leg.start_location, { lat: ORIGIN.lat, lng: ORIGIN.lon });
    assert.deepEqual(leg.end_location, { lat: DESTINATION.lat, lng: DESTINATION.lon });
    // TomTom returns route geometry as point arrays rather than an encoded
    // polyline, and CommuteParse reads neither overview_polyline nor bounds, so
    // the relay does not synthesise them. Recorded in DIVERGENCES.md.
    assert.equal(payload.relayData.routes[0].overview_polyline, undefined);
    assert.equal(calls, 1);
  });
});

test('S-11 Maps cold HEAD is empty before upstream work, then warms a GET cache hit', async () => {
  let calls = 0;
  await withDataService({ mapsGet: async () => { calls += 1; return TOMTOM_ROUTE; } }, async (port) => {
    const head = await request(port, query(), 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.type, null);
    assert.equal(head.body, '');
    // GoogleMaps.test.ts:77-95 checks nock.isDone() immediately after HEAD;
    // the provider must not be touched until the empty HEAD response returns.
    assert.equal(calls, 0, 'cold HEAD must not call the provider before responding');

    // Let the fire-and-forget prefetch finish without adding a fixed sleep.
    for (let i = 0; calls === 0 && i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'HEAD eventually warms the route');

    const get = await request(port, query());
    assert.equal(get.status, 200);
    assert.equal(get.type, 'text/html; charset=utf-8');
    const payload = JSON.parse(get.body);
    assert.equal(payload.lassoDataFromRedis, true);
    assert.equal(payload.relayData.routes[0].legs[0].distance.value, 3851);
    assert.equal(calls, 1, 'warmed GET must not call the provider');
  });
});

test('S-11 Maps empty reply is 502 and never enters the cache', async () => {
  const cache = new TTLCache();
  let calls = 0;
  await withDataService({ cache, mapsGet: async () => { calls += 1; return null; } }, async (port) => {
    const first = await request(port, query());
    assert.equal(first.status, 502);
    assert.equal(first.type, 'text/html; charset=utf-8');
    assert.equal(first.body, 'Empty reply from GoogleMaps'); // GoogleMaps.test.ts:98-117

    const second = await request(port, query());
    assert.equal(second.status, 502);
    assert.equal(second.body, 'Empty reply from GoogleMaps');
    assert.equal(calls, 2, 'an empty provider result must be fetched again');
    assert.equal(cache.m.size, 0, 'an empty provider result must not be cached');
  });
});

test('S-11 Maps missing and invalid inputs are exact 400 text responses with no provider call', async () => {
  let calls = 0;
  await withDataService({ mapsGet: async () => { calls += 1; return TOMTOM_ROUTE; } }, async (port) => {
    const cases = [
      ['missing origin', query({ origin: undefined }), 'Origin required'],
      ['missing destination', query({ destination: undefined }), 'Destination required'],
      ['invalid origin', query({ origin: JSON.stringify({ lat: 800, lon: 58.6 }) }), 'Invalid latitude 800'],
      ['invalid destination', query({ destination: JSON.stringify({ lat: -65, lon: 654 }) }), 'Invalid longitude 654'],
      ['invalid mode', query({ mode: 'blah' }), 'Invalid mode: "blah"'],
      ['missing mode', query({ mode: undefined }), 'Invalid mode: "undefined"'],
    ];
    for (const [label, qs, expected] of cases) {
      const result = await request(port, qs);
      assert.equal(result.status, 400, label);
      assert.equal(result.type, 'text/html; charset=utf-8', label);
      assert.equal(result.body, expected, label);
    }
    assert.equal(calls, 0, 'validation failures must not call the provider');
  });
});

test('S-11 Maps route fields pass through CommuteData and CommuteParse', async () => {
  const mapsData = tomTomToGoogleMaps(TOMTOM_ROUTE, ORIGIN, DESTINATION);
  const prefs = {
    commute: {
      complete: true,
      mode: 'driving',
      origin: { lat: ORIGIN.lat, lng: ORIGIN.lon },
      destination: { lat: DESTINATION.lat, lng: DESTINATION.lon },
      workTime: { hour: 9, min: 0 },
    },
  };
  const data = { log: noOpLog() };
  const previousFetch = LassoClient.fetchGoogleMaps;
  LassoClient.fetchGoogleMaps = async (_data, commutePrefs) => {
    assert.equal(commutePrefs.mode, 'driving');
    return mapsData;
  };
  try {
    const [name, returned] = await getCommuteData(prefs, data);
    assert.equal(name, 'commute');
    assert.deepEqual(returned, mapsData);

    const parsed = await commuteParse(returned, '2026-06-12T08:00:00-04:00', { userPrefs: prefs });
    assert.equal(parsed.modeIsDriving, true);
    assert.equal(parsed.durationMins, 47); // secondsToMinutes(2855), source value not display text
    assert.equal(parsed.extraMins, 0);
    assert.equal(parsed.arriveDT.getLocalTime().hour, 9);
    assert.equal(parsed.arriveDT.getLocalTime().minute, 0);
    assert.equal(parsed.departDT.getLocalTime().hour, 8);
    assert.equal(parsed.departDT.getLocalTime().minute, 12);
    assert.equal(parsed.minsLeft, 12);
  } finally {
    LassoClient.fetchGoogleMaps = previousFetch;
  }
});
