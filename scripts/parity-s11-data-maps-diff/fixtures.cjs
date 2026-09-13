'use strict';

// Shared deterministic inputs for the S-11 Data/Maps HTTP differential.
// The source runner combines these values with the pinned compiled
// GoogleMapsTestData fixture. The candidate runner feeds the ORS body through
// Phoenix's real defaultOrsGet path, so its URL/body/header serialization is
// observable without network access.

var ORIGIN = { lat: 45.5000668, lon: -73.58495669999999 };
var DESTINATION = { lat: 45.5100214, lon: -73.55198829999999 };

var GOOGLE_BOUNDS = {
  northeast: { lat: 45.51015049999999, lng: -73.55198829999999 },
  southwest: { lat: 45.4995955, lng: -73.58495669999999 },
};

var GOOGLE_GEOMETRY = 'mvutG~`c`MFYGO|A{DgDeDcAeAY_@gAyAc@w@[a@_CgCeAkAe@w@uBoCu@eBGM]_@UUD[CKIIFUTk@d@gA]]u@q@QEUCo@g@K_@QqAEO~C{HV]dBkEpCiHnBiF_E{DmDgDeBaByAwAaCmBuGwFkEqDqD{C}CeCmAgA|CyIt@uBhCuHtBwFTk@DKTo@pEqNcA}@gBuAmB_BgBgAgCoBo@c@uEwDX{A';

// This is the ORS response used by the candidate's real defaultOrsGet path.
// Its route values are copied from the pinned Google fixture so the common
// Google-shaped route projection can be compared byte-for-byte.
var ORS_ROUTE = {
  summary: { distance: 3851, duration: 2855 },
  bbox: [-73.58495669999999, 45.4995955, -73.55198829999999, 45.51015049999999],
  geometry: GOOGLE_GEOMETRY,
  segments: [{ distance: 3851, duration: 2855, steps: [] }],
  way_points: [0, 12],
};
var ORS = {
  bbox: ORS_ROUTE.bbox,
  routes: [ORS_ROUTE],
  metadata: { attribution: 'openrouteservice.org | OpenStreetMap contributors' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function query(origin, destination, mode, suffix) {
  var pairs = [];
  if (origin !== undefined) pairs.push('origin=' + encode(JSON.stringify(origin)));
  if (destination !== undefined) pairs.push('destination=' + encode(JSON.stringify(destination)));
  if (mode !== undefined) pairs.push('mode=' + encode(mode));
  if (suffix) pairs.push(suffix);
  return pairs.join('&');
}

function standardQuery(mode, suffix) {
  return query(ORIGIN, DESTINATION, mode === undefined ? 'driving' : mode, suffix);
}

function requestFor(spec) {
  var mode = spec.mode === undefined ? 'driving' : spec.mode;
  if (spec.kind === 'validation') {
    if (spec.validation === 'missing-origin') return query(undefined, DESTINATION, mode).replace(/^destination=/, 'destination=');
    if (spec.validation === 'missing-destination') return 'origin=' + encode(JSON.stringify(ORIGIN)) + '&mode=' + encode(mode);
    if (spec.validation === 'missing-mode') return query(ORIGIN, DESTINATION, undefined);
    if (spec.validation === 'invalid-mode') return query(ORIGIN, DESTINATION, spec.mode);
    if (spec.validation === 'invalid-origin') return query({ lat: 800, lon: 58.6 }, DESTINATION, mode);
    if (spec.validation === 'invalid-destination') return query(ORIGIN, { lat: -65, lon: 654 }, mode);
    if (spec.validation === 'unparseable-origin') return 'origin=not-json&destination=' + encode(JSON.stringify(DESTINATION)) + '&mode=' + encode(mode);
    if (spec.validation === 'unparseable-destination') return 'origin=' + encode(JSON.stringify(ORIGIN)) + '&destination=not-json&mode=' + encode(mode);
    throw new Error('unknown validation: ' + spec.validation);
  }
  if (spec.kind === 'skip') return standardQuery(mode, spec.skip);
  return standardQuery(mode);
}

// Construct a synthetic Google response from the pinned source fixture. It
// retains the exact source fixture's route geometry, bounds, distance, time,
// and endpoint locations, while using the fields Phoenix's ORS adapter emits.
// This makes the relay envelope/header/cache differential exact and keeps the
// provider-specific D07 mode/traffic differences visible in the wire records.
function googleParityPayload(sourceFixture) {
  var sourceRoute = sourceFixture.routes[0];
  var sourceLeg = sourceRoute.legs[0];
  var distance = sourceLeg.distance.value;
  var duration = sourceLeg.duration.value;
  var durationText = Math.round(duration / 60) + ' mins';
  return {
    status: 'OK',
    geocoded_waypoints: [],
    routes: [{
      summary: 'OpenRouteService',
      legs: [{
        steps: [],
        distance: { text: (distance / 1609.344).toFixed(1) + ' mi', value: distance },
        duration: { text: durationText, value: duration },
        duration_in_traffic: { text: durationText, value: duration },
        start_location: clone(sourceLeg.start_location),
        end_location: clone(sourceLeg.end_location),
        start_address: '',
        end_address: '',
      }],
      copyrights: 'OpenRouteService / OpenStreetMap contributors',
      overview_polyline: clone(sourceRoute.overview_polyline),
      bounds: clone(sourceRoute.bounds),
    }],
  };
}

module.exports = {
  ORIGIN: ORIGIN,
  DESTINATION: DESTINATION,
  ORS: ORS,
  ORS_ROUTE: ORS_ROUTE,
  GOOGLE_BOUNDS: GOOGLE_BOUNDS,
  GOOGLE_GEOMETRY: GOOGLE_GEOMETRY,
  clone: clone,
  query: query,
  standardQuery: standardQuery,
  requestFor: requestFor,
  googleParityPayload: googleParityPayload,
};
