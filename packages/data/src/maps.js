// Maps/commute relay — Phoenix port of lasso/relay/GoogleMapsHandler.ts (the 2026 ORS shim).
// Google Directions key is dead; fetch from OpenRouteService and re-shape into the Google Maps
// `Maps` schema report-skill's commute subskill reads (routes[0].legs[0].duration{,_in_traffic}).
// ORS needs an API key (ETCO_data_orsKey) in the Authorization header. Cache TTL 15m.

export const COMMUTE_MODES = ['driving', 'transit', 'bicycling', 'walking'];

const ORS_PROFILE = {
  driving: 'driving-car',
  transit: 'driving-car', // ORS free tier has no transit; closest fallback
  bicycling: 'cycling-regular',
  walking: 'foot-walking',
};

export function validateMaps(q) {
  const o = q.get('origin');
  const d = q.get('destination');
  if (!o) throw new Error('Origin required');
  if (!d) throw new Error('Destination required');
  let oj, dj;
  try { oj = JSON.parse(o); } catch { throw new Error(`Could not parse origin: ${o}`); }
  try { dj = JSON.parse(d); } catch { throw new Error(`Could not parse destination: ${d}`); }
  const origin = { lat: Number(oj.lat), lon: Number(oj.lon) };
  const destination = { lat: Number(dj.lat), lon: Number(dj.lon) };
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) throw new Error('Invalid origin coordinates');
  if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lon)) throw new Error('Invalid destination coordinates');
  const mode = q.get('mode');
  if (!COMMUTE_MODES.includes(mode)) throw new Error(`Invalid mode: "${mode}"`);
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
      Accept: 'application/json, application/geo+json',
    },
    body: JSON.stringify({ coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]] }),
  });
  if (!res.ok) { const e = new Error(`OpenRouteService ${res.status}`); e.status = 502; throw e; }
  return res.json();
}

/** fetchExternal: returns the Google Maps `Maps` object. opts.get(input) overrides the ORS call. */
export async function fetchMaps(input, { get = defaultOrsGet } = {}) {
  const ors = await get(input);
  if (!ors) throw new Error('Empty reply from OpenRouteService');
  return openRouteServiceToGoogleMaps(ors, input.origin, input.destination);
}

/** Map ORS onto the Google Maps subset report-skill reads. Ported from GoogleMapsHandler.ts. */
export function openRouteServiceToGoogleMaps(ors, origin, destination) {
  const routes = ors.routes || [];
  if (routes.length === 0) return { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] };

  const summary = routes[0].summary || {};
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

  return {
    status: 'OK',
    geocoded_waypoints: [],
    routes: [{ summary: 'OpenRouteService', legs: [leg], copyrights: 'OpenRouteService / OpenStreetMap contributors' }],
  };
}
