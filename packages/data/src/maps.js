// Maps/commute relay — Phoenix port of lasso/relay/GoogleMapsHandler.ts (the 2026 ORS shim).
// Google Directions key is dead; fetch from OpenRouteService and re-shape into the Google Maps
// `Maps` schema report-skill's commute subskill reads (routes[0].legs[0].duration{,_in_traffic}).
// ORS needs an API key (ETCO_data_orsKey) in the Authorization header. Cache TTL 15m.
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
// Retained gaps (ORS cannot supply them; see docs/parity/DIVERGENCES.md):
//   * transit is not real transit — the ORS free tier has no transit profile, so
//     `mode=transit` is answered with the driving-car route.
//   * no traffic model — ORS has none, so `duration_in_traffic` mirrors `duration`
//     and report-skill's `extraMins` traffic MIMs are unreachable.
//   * `legs[].steps`, `arrival_time`/`departure_time`, `warnings`, `fare`,
//     `geocoded_waypoints` and the per-road `summary` are not produced.

export const COMMUTE_MODES = ['driving', 'transit', 'bicycling', 'walking'];

const ORS_PROFILE = {
  driving: 'driving-car',
  transit: 'driving-car', // ORS free tier has no transit; closest fallback
  bicycling: 'cycling-regular',
  walking: 'foot-walking',
};

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

export async function defaultOrsGet({ origin, destination, mode }) {
  const profile = ORS_PROFILE[mode] || 'driving-car';
  const res = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}`, {
    method: 'POST',
    headers: {
      Authorization: process.env.ETCO_data_orsKey || '',
      'Content-Type': 'application/json',
      Accept: 'application/json, application/geo+json, application/gpx+xml',
    },
    body: JSON.stringify({ coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]] }),
  });
  if (!res.ok) {
    // The reference axios call rejects with `err.response` set, so `fetchData`
    // reproduces the upstream status and JSON-stringifies the upstream body
    // (AbstractRelayRequestHandler.ts:159-163). Live ORS error bodies observed
    // (2026-09-11): 401 `{"error":"Authorization field missing"}`,
    // 403 `{"error":"Access to this API has been disallowed"}`.
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const e = new Error(`OpenRouteService ${res.status}`);
    e.response = { status: res.status, data };
    throw e;
  }
  const text = await res.text();
  // Reference `fetchFromExternal` returns `result ? result.data : null`, so an
  // empty body is a falsy redirect-to-null, not a parse error
  // (GoogleMapsHandler.ts:90, GoogleMaps.test.ts:98-117).
  if (!text) return null;
  return JSON.parse(text);
}

/** fetchExternal: returns the Google Maps `Maps` object. opts.get(input) overrides the ORS call. */
export async function fetchMaps(input, { get = defaultOrsGet } = {}) {
  const ors = await get(input);
  if (!ors) return null; // -> relay answers 502 `Empty reply from GoogleMaps`
  return openRouteServiceToGoogleMaps(ors, input.origin, input.destination);
}

/** Map an ORS /v2/directions body onto the Google Maps subset report-skill reads. */
export function openRouteServiceToGoogleMaps(ors, origin, destination) {
  const routes = ors.routes || [];
  if (routes.length === 0) return { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] };

  const route = routes[0] || {};
  const summary = route.summary || {};
  const durationSeconds = Math.round(summary.duration || 0);
  const distanceMeters = Math.round(summary.distance || 0);
  const durationText = `${Math.round(durationSeconds / 60)} mins`;

  const leg = {
    steps: [],
    distance: { text: `${(distanceMeters / 1609.344).toFixed(1)} mi`, value: distanceMeters },
    duration: { text: durationText, value: durationSeconds },
    duration_in_traffic: { text: durationText, value: durationSeconds }, // ORS has no traffic
    start_location: { lat: origin.lat, lng: origin.lon },
    end_location: { lat: destination.lat, lng: destination.lon },
    start_address: '',
    end_address: '',
  };

  const mappedRoute = {
    summary: 'OpenRouteService',
    legs: [leg],
    copyrights: 'OpenRouteService / OpenStreetMap contributors',
  };

  // ORS returns the route geometry as an encoded polyline by default
  // (`geometry_format=encodedpolyline`), the same precision-5 algorithm Google
  // returns in `overview_polyline.points`. docs: giscience.github.io/
  // openrouteservice/api-reference/endpoints/directions/
  if (typeof route.geometry === 'string' && route.geometry) {
    mappedRoute.overview_polyline = { points: route.geometry };
  }
  // ORS route `bbox` is [minLon, minLat, maxLon, maxLat]; Google's `bounds` is
  // {northeast:{lat,lng}, southwest:{lat,lng}}.
  const bbox = route.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => Number.isFinite(n))) {
    mappedRoute.bounds = {
      northeast: { lat: bbox[3], lng: bbox[2] },
      southwest: { lat: bbox[1], lng: bbox[0] },
    };
  }

  return { status: 'OK', geocoded_waypoints: [], routes: [mappedRoute] };
}
