// Maps/commute relay — TomTom Routing re-shaped into the Google Maps `Maps`
// schema report-skill's commute subskill reads (routes[0].legs[0].duration{,_in_traffic}).
//
// Google Directions is dead (its legacy client IDs were retired; the API answers
// 403). This relay previously used OpenRouteService, which routes well but has no
// traffic model at all, so `duration_in_traffic` could only ever mirror `duration`
// and report-skill's Poor/Terrible commute MIMs were unreachable by construction.
// TomTom Routing is the replacement: free tier, no card, and real live traffic.
// ORS has been removed entirely.
//
// Requires TOMTOM_API_KEY. Cache TTL 15m.
//
// `computeTravelTimeFor=all` is REQUIRED. Without it TomTom silently omits the
// traffic breakdown and answers with free-flow times only, which is
// indistinguishable from "no traffic right now".
//
//   liveTrafficIncidentsTravelTimeInSeconds -> Google duration_in_traffic
//   noTrafficTravelTimeInSeconds            -> Google duration
//
// Contract (pinned, pegasus@5c0a7390539663ba749d360de348a428c088505c):
//   * input      — GoogleMapsHandler.ts:35-64. `origin`/`destination` are JSON
//                  strings of {lat,lon} (the report-skill LassoClient axios-serialises
//                  those objects to JSON: LassoClient.ts:59-69); `mode` is one of
//                  googlemaps.CommuteMode {driving,transit,bicycling,walking}
//                  (interfaces/src/personalreport/googlemaps.ts:181-186).
//   * validation — LatLon.make_from_strings (lasso/src/utils/LatLon.ts:20-31) plus
//                  the LatLon constructor range check (:9-14). Messages are
//                  `Invalid latitude <raw>` / `Invalid longitude <raw>`, and a
//                  missing mode renders as `Invalid mode: "undefined"`
//                  (GoogleMaps.test.ts:145-167). All validation errors -> 400 text.
//   * key        — `google_maps:oLat;oLon;dLat;dLon;mode` (GoogleMapsHandler.ts:67-70).
//   * routes     — `{status, geocoded_waypoints, routes[]}`; a route carries
//                  summary/legs/overview_polyline/bounds/copyrights
//                  (googlemaps.ts:16-34); no routes -> ZERO_RESULTS.
//   * errors     — an empty upstream body -> 502 `Empty reply from GoogleMaps`
//                  (GoogleMaps.test.ts:98-117); an upstream HTTP error reproduces the
//                  upstream status with `Error getting GoogleMaps data: <json>`
//                  (AbstractRelayRequestHandler.ts:153-173).
//
// Retained gaps (see docs/parity/DIVERGENCES.md):
//   * transit is not real transit — TomTom has no transit profile on this tier,
//     so `mode=transit` is answered with the `bus` travel mode.
//   * `legs[].steps`, `arrival_time`/`departure_time`, `warnings`, `fare`,
//     `geocoded_waypoints` and the per-road `summary` are not produced.
//   * `overview_polyline` and `bounds` are omitted; TomTom returns route geometry
//     as point arrays rather than an encoded polyline, and report-skill reads
//     neither field.

export const COMMUTE_MODES = ['driving', 'transit', 'bicycling', 'walking'];

/** LatLon.ts:21 — the only accepted numeric form. */
const LATLON_STR = /^-?\d+\.?\d*$/;

/**
 * Port of `LatLon.make_from_strings` + the `LatLon` constructor range check
 * (lasso/src/utils/LatLon.ts:7-31), in that order: the regex runs over the raw
 * values and its message carries the raw value; the range check runs over the
 * parsed floats. Nothing is coerced up front, so a missing lat/lon cannot slip
 * through the way `Number(undefined) -> NaN` or an `isFinite` test would let it.
 * @returns {{lat: number, lon: number}} the shape the original stores on LatLon
 */
export function makeLatLon(lat, lon) {
  if (!LATLON_STR.test(lat)) throw new RangeError(`Invalid latitude ${lat}`);
  if (!LATLON_STR.test(lon)) throw new RangeError(`Invalid longitude ${lon}`);
  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);
  if (parsedLat < -90 || parsedLat > 90) throw new RangeError(`Invalid latitude ${parsedLat}`);
  if (parsedLon < -180 || parsedLon > 180) throw new RangeError(`Invalid longitude ${parsedLon}`);
  return { lat: parsedLat, lon: parsedLon };
}

export function validateMaps(q) {
  // GoogleMapsHandler.ts:35-40 — falsy (including the empty string) is "missing".
  const o = q.get('origin');
  const d = q.get('destination');
  if (!o) throw new Error('Origin required');
  if (!d) throw new Error('Destination required');
  let oj, dj;
  try { oj = JSON.parse(o); } catch { throw new Error(`Could not parse origin: ${o}`); }
  try { dj = JSON.parse(d); } catch { throw new Error(`Could not parse destination: ${d}`); }
  const origin = makeLatLon(oj.lat, oj.lon);
  const destination = makeLatLon(dj.lat, dj.lon);
  // Express's qs hands the handler `undefined` when the parameter is absent, and
  // the original interpolates that into the message (GoogleMaps.test.ts:165-167).
  const rawMode = q.get('mode');
  const mode = rawMode === null ? undefined : rawMode;
  if (!COMMUTE_MODES.includes(mode)) throw new RangeError(`Invalid mode: "${mode}"`);
  return { origin, destination, mode };
}

export function mapsKey({ origin, destination, mode }) {
  return `google_maps:${origin.lat};${origin.lon};${destination.lat};${destination.lon};${mode}`;
}

/**
 * TomTom Routing — the only free, no-card provider found that returns real live
 * traffic, which is what Google's `duration_in_traffic` carried and what
 * report-skill's Poor/Terrible commute MIMs branch on.
 *
 * `computeTravelTimeFor=all` is REQUIRED. Without it TomTom silently omits the
 * traffic breakdown and answers with free-flow times only, which is
 * indistinguishable from "no traffic right now".
 *
 *   liveTrafficIncidentsTravelTimeInSeconds -> Google duration_in_traffic
 *   noTrafficTravelTimeInSeconds            -> Google duration
 */
const TOMTOM_TRAVEL_MODE = {
  driving: 'car',
  transit: 'bus',      // closest available; still not real transit routing
  bicycling: 'bicycle',
  walking: 'pedestrian',
};

export async function defaultTomTomGet({ origin, destination, mode }, apiKey) {
  const travelMode = TOMTOM_TRAVEL_MODE[mode] || 'car';
  const loc = `${origin.lat},${origin.lon}:${destination.lat},${destination.lon}`;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${loc}/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('travelMode', travelMode);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('traffic', 'true');
  url.searchParams.set('computeTravelTimeFor', 'all');
  // Pedestrian and bicycle routing reject departAt; only ask for it where it means something.
  if (travelMode === 'car' || travelMode === 'bus') url.searchParams.set('departAt', 'now');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const e = new Error(`TomTom ${res.status}`);
    e.response = { status: res.status, data };
    throw e;
  }
  const text = await res.text();
  if (!text) return null; // -> relay answers 502 `Empty reply from GoogleMaps`
  return { provider: 'tomtom', body: JSON.parse(text) };
}

/** Map a TomTom calculateRoute body onto the Google Maps subset report-skill reads. */
export function tomTomToGoogleMaps(body, origin, destination) {
  const routes = (body && body.routes) || [];
  if (routes.length === 0) return { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] };

  const summary = routes[0].summary || {};
  const freeFlow = Math.round(summary.noTrafficTravelTimeInSeconds ?? summary.travelTimeInSeconds ?? 0);
  // Prefer the live-incident time; fall back through historic to the plain
  // travel time so a response without the breakdown still yields a sane pair.
  const withTraffic = Math.round(
    summary.liveTrafficIncidentsTravelTimeInSeconds
    ?? summary.historicTrafficTravelTimeInSeconds
    ?? summary.travelTimeInSeconds
    ?? freeFlow,
  );
  const distanceMeters = Math.round(summary.lengthInMeters || 0);
  const mins = (seconds) => `${Math.round(seconds / 60)} mins`;

  const leg = {
    steps: [],
    distance: { text: `${(distanceMeters / 1609.344).toFixed(1)} mi`, value: distanceMeters },
    duration: { text: mins(freeFlow), value: freeFlow },
    duration_in_traffic: { text: mins(withTraffic), value: withTraffic },
    start_location: { lat: origin.lat, lng: origin.lon },
    end_location: { lat: destination.lat, lng: destination.lon },
    start_address: '',
    end_address: '',
  };

  return {
    status: 'OK',
    geocoded_waypoints: [],
    routes: [{ summary: 'TomTom', legs: [leg], copyrights: 'TomTom' }],
  };
}

/** The maps provider. TomTom only; ORS was removed because it has no traffic model. */
export async function defaultMapsGet(input) {
  const tomtomKey = process.env.TOMTOM_API_KEY || '';
  if (!tomtomKey) {
    const e = new Error('TomTom 401');
    e.response = { status: 401, data: { error: 'TOMTOM_API_KEY is not configured' } };
    throw e;
  }
  return defaultTomTomGet(input, tomtomKey);
}

/** fetchExternal: returns the Google Maps `Maps` object. opts.get(input) overrides the TomTom call. */
export async function fetchMaps(input, { get = defaultMapsGet } = {}) {
  const raw = await get(input);
  if (!raw) return null; // -> relay answers 502 `Empty reply from GoogleMaps`
  // An injected `get` may return either the tagged provider envelope or a bare
  // TomTom body, so tests can supply a fixture without wrapping it.
  const body = raw && raw.provider === 'tomtom' ? raw.body : raw;
  return tomTomToGoogleMaps(body, input.origin, input.destination);
}
