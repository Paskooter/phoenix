#!/usr/bin/env node

// Fail-closed comparator for the S-11 Data/Maps relay differential. A pass
// requires complete ordered rows, valid row self-hashes, pinned provenance,
// exact HTTP response summaries, matching cache/provider effects, and valid
// side-specific Google/ORS wire records.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [matrixArg, sourceArg, candidateArg, outArg] = process.argv.slice(2);
if (!matrixArg || !sourceArg || !candidateArg) throw new Error('usage: compare.mjs <matrix.json> <source.json> <candidate.json> [comparison.json]');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const matrix = readJSON(matrixArg);
const source = readJSON(sourceArg);
const candidate = readJSON(candidateArg);
const output = outArg ? path.resolve(outArg) : null;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value;
}
const canonical = value => JSON.stringify(stable(value));
function display(value) {
  const text = JSON.stringify(value);
  return text && text.length > 900 ? `${text.slice(0, 897)}...` : value;
}
function firstDifference(a, b, at = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return { path: at, source: display(a), candidate: display(b) };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { path: at, source: display(a), candidate: display(b) };
    for (let i = 0; i < a.length; i += 1) { const diff = firstDifference(a[i], b[i], `${at}[${i}]`); if (diff) return diff; }
    return { path: at, source: display(a), candidate: display(b) };
  }
  if (typeof a === 'object') {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const diff = firstDifference(a[key], b[key], `${at}.${key}`);
      if (diff) return diff;
    }
  }
  return { path: at, source: display(a), candidate: display(b) };
}

const expectedSchema = 'phoenix.parity.s11.data-maps-http-matrix.v1';
const receiptSchema = 'phoenix.parity.s11.data-maps-http-receipt.v1';
// These controls are intentionally outside matrix.json. The matrix digest
// below is filled after all pins are populated and covers the complete
// semantic matrix. Byte pins are independently verified against the files and
// receipts, avoiding a self-hash cycle for this harness.
const MATRIX_SEMANTIC_SHA256 = 'f25be355dbf8e11ad5113a3b24fd2e5f34a138dcd6e0a63892538b36b7f565cf';
const EXPECTED_CASE_IDS = [
  'get-miss-google-route', 'get-hit-cache', 'head-cold-eventual-warm-hit',
  'empty-reply-not-cached', 'provider-status-error-not-cached', 'zero-results',
  'skip-cache-false-refetch', 'skip-cache-array-refetch',
  'validation-missing-origin', 'validation-missing-destination',
  'validation-invalid-origin', 'validation-invalid-destination',
  'validation-missing-mode', 'validation-invalid-mode',
  'validation-unparseable-origin', 'validation-unparseable-destination',
  'mode-driving-wire', 'mode-transit-wire', 'mode-bicycling-wire', 'mode-walking-wire',
];
const EXPECTED_COUNTS = { namedCases: 20, requestRuns: 28, providerCalls: 17 };
const sourceRevision = '5c0a7390539663ba749d360de348a428c088505c';
const sourceImage = 'node:8.9.4-slim';
const sourceImageDigest = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';
// Independent pin controls catch a matrix/hash-map rewrite even when an
// attacker rewrites both receipts to agree with it. The candidate comparator
// entry is omitted from this digest because it hashes this file itself; the
// runner still checks every candidate path against matrix.candidate.hashes.
const REFERENCE_PIN_SHA256 = '78b830299710a54b1ab44e535cf003abf5f90850bb9d99d0e88400c8df3077a2';
const CANDIDATE_PIN_SHA256 = 'e8165436e47d68527505f9e22df47bb771fc4a5bc95afc725ea5c0c56c487a80';
const HARNESS_PIN_SHA256 = '32947c687b6103b294e3f9aa7a6ec857235f9fb819207f890441a76d8927c4aa';
const differences = [];
const receiptErrors = [];

function semanticMatrix(value) {
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.reference) {
    delete copy.reference.sourceHashes;
    delete copy.reference.compiledHashes;
    delete copy.reference.testSha256;
    delete copy.reference.fixtureSourceSha256;
    delete copy.reference.fixtureCompiledSha256;
  }
  if (copy.candidate) delete copy.candidate.hashes;
  if (copy.harness) delete copy.harness.sourceHashes;
  return copy;
}

function referencePins(value) {
  return {
    sourceHashes: value.reference && value.reference.sourceHashes,
    compiledHashes: value.reference && value.reference.compiledHashes,
    testSha256: value.reference && value.reference.testSha256,
    fixtureSourceSha256: value.reference && value.reference.fixtureSourceSha256,
    fixtureCompiledSha256: value.reference && value.reference.fixtureCompiledSha256,
  };
}
function candidatePins(value) {
  const hashes = { ...((value.candidate && value.candidate.hashes) || {}) };
  delete hashes['scripts/parity-s11-data-maps-diff/compare.mjs'];
  return hashes;
}
function harnessPins(value) { return value.harness && value.harness.sourceHashes; }

function checkMatrix() {
  if (sha(canonical(semanticMatrix(matrix))) !== MATRIX_SEMANTIC_SHA256) receiptErrors.push({ side: 'matrix', message: 'matrix semantic digest mismatch' });
  if (matrix.schema !== expectedSchema || matrix.task !== 'S-11' || matrix.base !== '55e23ac') receiptErrors.push({ side: 'matrix', message: 'matrix identity mismatch' });
  if (!matrix.cases || matrix.cases.length !== EXPECTED_CASE_IDS.length || matrix.cases.map(item => item.id).join('\n') !== EXPECTED_CASE_IDS.join('\n')) receiptErrors.push({ side: 'matrix', message: 'case inventory/order mismatch' });
  if (!matrix.counts || matrix.counts.namedCases !== EXPECTED_COUNTS.namedCases || matrix.counts.requestRuns !== EXPECTED_COUNTS.requestRuns || matrix.counts.providerCalls !== EXPECTED_COUNTS.providerCalls) receiptErrors.push({ side: 'matrix', message: 'case count pin mismatch' });
  if (sha(canonical(referencePins(matrix))) !== REFERENCE_PIN_SHA256) receiptErrors.push({ side: 'matrix', message: 'reference byte-pin digest mismatch' });
  if (sha(canonical(candidatePins(matrix))) !== CANDIDATE_PIN_SHA256) receiptErrors.push({ side: 'matrix', message: 'candidate byte-pin digest mismatch' });
  if (sha(canonical(harnessPins(matrix))) !== HARNESS_PIN_SHA256) receiptErrors.push({ side: 'matrix', message: 'harness byte-pin digest mismatch' });
}

function failReceipt(side, message) { receiptErrors.push({ side, message }); }

function checkMetadata(receipt, side) {
  if (!receipt || receipt.schema !== receiptSchema) { failReceipt(side, 'receipt schema/result missing'); return; }
  if (receipt.result !== 'pass') failReceipt(side, 'receipt result is not pass');
  if (receipt.task !== matrix.task || receipt.base !== matrix.base) failReceipt(side, 'task/base mismatch');
  const runtime = receipt.runtime || {};
  if (runtime.timezone !== matrix.runtime.timezone || runtime.clockISO !== matrix.runtime.clockISO || runtime.randomSeed !== matrix.runtime.randomSeed) failReceipt(side, 'deterministic runtime controls mismatch');
  if (side === 'source') {
    if (runtime.node !== 'v8.9.4' || runtime.network !== 'none' || runtime.sourceImage !== sourceImage || runtime.sourceImageDigest !== sourceImageDigest) failReceipt(side, 'source Node 8/network/image pin mismatch');
    const ref = receipt.reference || {};
    const want = matrix.reference;
    for (const key of ['repo', 'revision', 'compiledRecordPath', 'compiledRecordSha256', 'testPath', 'testSha256', 'fixtureSourcePath', 'fixtureSourceSha256', 'fixtureCompiledPath', 'fixtureCompiledSha256']) if (ref[key] !== want[key]) failReceipt(side, `reference ${key} mismatch`);
    if (canonical(ref.sourcePaths) !== canonical(want.sourcePaths) || canonical(ref.sourceHashes) !== canonical(want.sourceHashes)) failReceipt(side, 'source path/hash pin mismatch');
    if (canonical(ref.compiledPaths) !== canonical(want.compiledPaths) || canonical(ref.compiledHashes) !== canonical(want.compiledHashes)) failReceipt(side, 'compiled path/hash pin mismatch');
  } else {
    if (runtime.network !== 'loopback-only' || !/^v\d+\.\d+\.\d+$/.test(runtime.node || '')) failReceipt(side, 'candidate runtime/network mismatch');
    const expectedRevision = process.env.PHOENIX_S11_EXPECTED_REVISION;
    if (expectedRevision && receipt.candidate?.revision !== expectedRevision) failReceipt(side, 'candidate revision mismatch');
    const meta = receipt.candidate || {};
    if (canonical(meta.paths) !== canonical(matrix.candidate.paths) || canonical(meta.hashes) !== canonical(matrix.candidate.hashes)) failReceipt(side, 'candidate path/hash pin mismatch');
  }
  const harness = receipt.harness || {};
  if (canonical(harness.sourcePaths) !== canonical(matrix.harness.sourcePaths) || canonical(harness.sourceHashes) !== canonical(matrix.harness.sourceHashes)) failReceipt(side, 'harness path/hash pin mismatch');
  if (canonical(receipt.retainedGaps) !== canonical(matrix.retainedGaps)) failReceipt(side, 'retained D07 gap declarations changed');
  if (canonical(receipt.counts) !== canonical(EXPECTED_COUNTS)) failReceipt(side, 'receipt counts mismatch');
}

function validateRows(receipt, side) {
  const rows = receipt && receipt.cases;
  if (!Array.isArray(rows)) { failReceipt(side, 'cases is not an array'); return new Map(); }
  if (rows.length !== matrix.cases.length) failReceipt(side, `case count ${rows.length} != ${matrix.cases.length}`);
  const byId = new Map();
  const seen = new Set();
  rows.forEach((row, index) => {
    if (!row || typeof row.id !== 'string') { failReceipt(side, `row ${index} has no id`); return; }
    if (seen.has(row.id)) failReceipt(side, `duplicate row ${row.id}`);
    seen.add(row.id);
    byId.set(row.id, row);
    const spec = matrix.cases[index];
    if (!spec || row.id !== spec.id) failReceipt(side, `row order mismatch at ${index}: ${row.id}`);
    if (spec && (row.kind !== spec.kind || row.sourceName !== spec.sourceName || row.sourceLine !== spec.sourceLine || (row.expectedError || null) !== (spec.expectedError || null))) failReceipt(side, `row metadata mismatch ${row.id}`);
    if (!Array.isArray(row.responses) || !Array.isArray(row.effects) || !Array.isArray(row.providerCalls) || !row.observations) failReceipt(side, `incomplete observables ${row.id}`);
    if (typeof row.sha256 !== 'string') failReceipt(side, `missing row hash ${row.id}`);
    else {
      const copy = { ...row };
      delete copy.sha256;
      if (sha(canonical(copy)) !== row.sha256) failReceipt(side, `mutated row ${row.id}`);
    }
  });
  const expectedIds = EXPECTED_CASE_IDS;
  if (canonical(rows.map(row => row && row.id)) !== canonical(expectedIds)) failReceipt(side, 'case order/inventory mismatch');
  for (const id of expectedIds) if (!seen.has(id)) failReceipt(side, `missing row ${id}`);
  return byId;
}

function expectedSignature(rawQueryWithoutSignature) {
  const key = Buffer.from('c2VjcmV0', 'base64');
  return crypto.createHmac('sha1', key).update(`/maps/api/directions/json?${rawQueryWithoutSignature}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function expectedOrigin() { return { lat: 45.5000668, lon: -73.58495669999999 }; }
function expectedDestination() { return { lat: 45.5100214, lon: -73.55198829999999 }; }
function keyFor(mode) {
  const origin = expectedOrigin(); const destination = expectedDestination();
  return `google_maps:${origin.lat};${origin.lon};${destination.lat};${destination.lon};${mode}`;
}

function validateSourceWire(row, spec, sideDiffs) {
  if (spec.kind === 'validation') return;
  const expectedCalls = spec.kind === 'head' ? 1 : spec.kind === 'hit' ? 1 : spec.kind === 'empty' ? 3 : spec.kind === 'provider-error' ? 2 : spec.kind === 'skip' ? 2 : 1;
  if (row.providerCalls.length !== expectedCalls) { sideDiffs.push({ id: spec.id, kind: 'provider-call-count', actual: row.providerCalls.length, expected: expectedCalls }); return; }
  for (let i = 0; i < row.providerCalls.length; i += 1) {
    const call = row.providerCalls[i];
    const wire = call && call.wire || {};
    const mode = spec.mode || 'driving';
    const origin = expectedOrigin(); const destination = expectedDestination();
    const expectedQuery = {
      origin: `${origin.lat},${origin.lon}`,
      destination: `${destination.lat},${destination.lon}`,
      departure_time: 'now',
      traffic_model: 'pessimistic',
      client: 'gme-jiboinc',
      mode,
    };
    if (wire.method !== 'GET' || wire.path !== '/maps/api/directions/json') sideDiffs.push({ id: spec.id, kind: 'google-request-target', actual: { method: wire.method, path: wire.path } });
    const query = wire.query || {};
    for (const [key, value] of Object.entries(expectedQuery)) if (query[key] !== value) sideDiffs.push({ id: spec.id, kind: 'google-query-field', field: key, actual: query[key], expected: value });
    const keys = Object.keys(query);
    if (keys.length !== 7 || keys[keys.length - 1] !== 'signature' || typeof query.signature !== 'string' || !query.signature) sideDiffs.push({ id: spec.id, kind: 'google-signature-field', actual: query });
    if (wire.rawQuery) {
      const parts = wire.rawQuery.split('&');
      const without = parts.slice(0, 6).join('&');
      const expected = expectedSignature(without);
      if (query.signature !== expected) sideDiffs.push({ id: spec.id, kind: 'google-signature', actual: query.signature, expected });
    }
    if (call.key !== keyFor(mode) || canonical(call.origin) !== canonical(origin) || canonical(call.destination) !== canonical(destination) || call.mode !== mode) sideDiffs.push({ id: spec.id, kind: 'google-semantic-input', actual: { key: call.key, origin: call.origin, destination: call.destination, mode: call.mode }, expected: { key: keyFor(mode), origin, destination, mode } });
    const wantStatus = spec.kind === 'provider-error' ? 503 : 200;
    if (call.status !== wantStatus) sideDiffs.push({ id: spec.id, kind: 'google-provider-status', actual: call.status, expected: wantStatus });
  }
}

const profiles = { driving: 'driving-car', transit: 'driving-car', bicycling: 'cycling-regular', walking: 'foot-walking' };
function validateCandidateWire(row, spec, sideDiffs) {
  if (spec.kind === 'validation') return;
  const expectedCalls = spec.kind === 'head' ? 1 : spec.kind === 'hit' ? 1 : spec.kind === 'empty' ? 3 : spec.kind === 'provider-error' ? 2 : spec.kind === 'skip' ? 2 : 1;
  if (row.providerCalls.length !== expectedCalls) { sideDiffs.push({ id: spec.id, kind: 'provider-call-count', actual: row.providerCalls.length, expected: expectedCalls }); return; }
  for (const call of row.providerCalls) {
    const mode = spec.mode || 'driving';
    const origin = expectedOrigin(); const destination = expectedDestination();
    const wire = call && call.wire || {};
    const expectedBody = { coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]] };
    const expectedPath = `/v2/directions/${profiles[mode]}`;
    if (wire.method !== 'POST' || wire.path !== expectedPath || wire.profile !== profiles[mode]) sideDiffs.push({ id: spec.id, kind: 'ors-request-target', actual: { method: wire.method, path: wire.path, profile: wire.profile }, expected: { method: 'POST', path: expectedPath } });
    if (canonical(wire.body) !== canonical(expectedBody)) sideDiffs.push({ id: spec.id, kind: 'ors-request-body', actual: wire.body, expected: expectedBody });
    const headers = wire.headers || {};
    const expectedHeaders = { authorization: 's11-local-ors-key', 'content-type': 'application/json', accept: 'application/json, application/geo+json, application/gpx+xml' };
    for (const [name, value] of Object.entries(expectedHeaders)) if (headers[name] !== value) sideDiffs.push({ id: spec.id, kind: 'ors-request-header', field: name, actual: headers[name], expected: value });
    if (Object.keys(wire.query || {}).length) sideDiffs.push({ id: spec.id, kind: 'ors-unexpected-query', actual: wire.query });
    if (call.key !== keyFor(mode) || canonical(call.origin) !== canonical(origin) || canonical(call.destination) !== canonical(destination) || call.mode !== mode) sideDiffs.push({ id: spec.id, kind: 'ors-semantic-input', actual: { key: call.key, origin: call.origin, destination: call.destination, mode: call.mode }, expected: { key: keyFor(mode), origin, destination, mode } });
    const wantStatus = spec.kind === 'provider-error' ? 503 : 200;
    if (call.status !== wantStatus) sideDiffs.push({ id: spec.id, kind: 'ors-provider-status', actual: call.status, expected: wantStatus });
  }
}

function exactKeys(value, keys) { return value && canonical(Object.keys(value).sort()) === canonical(keys.slice().sort()); }
function validateGoogleRoute(response, errors, fromRedis) {
  if (!response) { errors.push({ kind: 'missing-route-response' }); return; }
  const body = response.bodyNormalized;
  const envelopeKeys = fromRedis ? ['lassoDataFromRedis', 'lassoInsertedIntoRedisAt', 'relayData'] : ['lassoDataFromRedis', 'relayData'];
  if (!body || !exactKeys(body, envelopeKeys)) { errors.push({ kind: 'route-envelope', actual: body }); return; }
  if (body.lassoDataFromRedis !== fromRedis) errors.push({ kind: 'route-cache-flag', actual: body.lassoDataFromRedis, expected: fromRedis });
  const relay = body.relayData;
  if (!relay || relay.status !== 'OK' || !Array.isArray(relay.geocoded_waypoints) || !exactKeys(relay, ['geocoded_waypoints', 'routes', 'status'])) errors.push({ kind: 'google-route-envelope', actual: relay });
  const route = relay && relay.routes && relay.routes[0];
  if (!route || !exactKeys(route, ['bounds', 'copyrights', 'legs', 'overview_polyline', 'summary'])) { errors.push({ kind: 'google-route-fields', actual: route }); return; }
  if (route.summary !== 'OpenRouteService' || route.copyrights !== 'OpenRouteService / OpenStreetMap contributors') errors.push({ kind: 'google-route-labels', actual: { summary: route.summary, copyrights: route.copyrights } });
  const leg = route.legs[0];
  if (!leg || !exactKeys(leg, ['distance', 'duration', 'duration_in_traffic', 'end_address', 'end_location', 'start_address', 'start_location', 'steps'])) { errors.push({ kind: 'google-leg-fields', actual: leg }); return; }
  if (!Array.isArray(leg.steps) || leg.steps.length !== 0 || leg.start_address !== '' || leg.end_address !== '') errors.push({ kind: 'google-leg-empty-fields', actual: leg });
  if (!leg.distance || leg.distance.text !== '2.4 mi' || leg.distance.value !== 3851 || !leg.duration || leg.duration.text !== '48 mins' || leg.duration.value !== 2855 || canonical(leg.duration_in_traffic) !== canonical(leg.duration)) errors.push({ kind: 'google-leg-duration-distance', actual: leg });
  if (canonical(leg.start_location) !== canonical({ lat: 45.5000668, lng: -73.58495669999999 }) || canonical(leg.end_location) !== canonical({ lat: 45.5100214, lng: -73.55198829999999 })) errors.push({ kind: 'google-leg-endpoints', actual: { start: leg.start_location, end: leg.end_location } });
  if (!route.overview_polyline || typeof route.overview_polyline.points !== 'string' || !route.overview_polyline.points) errors.push({ kind: 'google-polyline', actual: route.overview_polyline });
  if (!route.bounds || canonical(Object.keys(route.bounds).sort()) !== canonical(['northeast', 'southwest']) || canonical(route.bounds.northeast) !== canonical({ lat: 45.51015049999999, lng: -73.55198829999999 }) || canonical(route.bounds.southwest) !== canonical({ lat: 45.4995955, lng: -73.58495669999999 })) errors.push({ kind: 'google-bounds', actual: route.bounds });
}
function validateGoogleZero(response, errors) {
  if (!response) { errors.push({ kind: 'missing-zero-response' }); return; }
  const body = response.bodyNormalized;
  if (!body || !exactKeys(body, ['lassoDataFromRedis', 'relayData']) || body.lassoDataFromRedis !== false || !body.relayData || body.relayData.status !== 'ZERO_RESULTS' || !Array.isArray(body.relayData.geocoded_waypoints) || !Array.isArray(body.relayData.routes) || body.relayData.routes.length !== 0) errors.push({ kind: 'google-zero-envelope', actual: body });
}

function validateCaseContract(row, spec, side) {
  const errors = [];
  const responses = row.responses || [];
  const responseAt = (index, status, body) => {
    const response = responses[index]?.response;
    if (!response) { errors.push({ kind: 'missing-response', index }); return; }
    if (response.status !== status) errors.push({ kind: 'status', index, actual: response.status, expected: status });
    if (body !== undefined && response.body !== body) errors.push({ kind: 'body', index, actual: response.body, expected: body });
  };
  if (spec.kind === 'validation') {
    responseAt(0, 400, spec.expectedError);
    if (row.effects.length || row.providerCalls.length || (row.observations.cacheKeys || []).length) errors.push({ kind: 'validation-side-effects', effects: row.effects, providerCalls: row.providerCalls, cacheKeys: row.observations.cacheKeys });
  } else if (spec.kind === 'route' || spec.kind === 'mode' || spec.kind === 'zero') {
    responseAt(0, 200);
  } else if (spec.kind === 'hit') {
    responseAt(0, 200); responseAt(1, 200);
    if (responses[1]?.response?.headers?.['content-type'] !== 'text/html; charset=utf-8') errors.push({ kind: 'cache-hit-content-type', actual: responses[1]?.response?.headers?.['content-type'] });
  } else if (spec.kind === 'head') {
    responseAt(0, 200, ''); responseAt(1, 200); responseAt(2, 200, '');
    if (!row.observations.headResponseBeforeProvider || row.observations.providerCallsAfterWarmHead !== 1) errors.push({ kind: 'head-order', observations: row.observations });
  } else if (spec.kind === 'empty') {
    responseAt(0, 502, 'Empty reply from GoogleMaps'); responseAt(1, 502, 'Empty reply from GoogleMaps'); responseAt(2, 200);
  } else if (spec.kind === 'provider-error') {
    responseAt(0, 503, 'Error getting GoogleMaps data: {"error":"provider unavailable"}'); responseAt(1, 503, 'Error getting GoogleMaps data: {"error":"provider unavailable"}');
  } else if (spec.kind === 'skip') {
    responseAt(0, 200); responseAt(1, 200);
  }
  if (spec.kind === 'route' || spec.kind === 'mode') validateGoogleRoute(responses[0] && responses[0].response, errors, false);
  if (spec.kind === 'zero') validateGoogleZero(responses[0] && responses[0].response, errors);
  if (spec.kind === 'hit') {
    validateGoogleRoute(responses[0] && responses[0].response, errors, false);
    validateGoogleRoute(responses[1] && responses[1].response, errors, true);
  }
  if (spec.kind === 'head') validateGoogleRoute(responses[1] && responses[1].response, errors, true);
  if (spec.kind === 'empty') validateGoogleRoute(responses[2] && responses[2].response, errors, false);
  if (spec.kind === 'skip') {
    validateGoogleRoute(responses[0] && responses[0].response, errors, false);
    validateGoogleRoute(responses[1] && responses[1].response, errors, false);
  }
  const expectedOperations = {
    validation: [],
    route: ['cache.get', 'provider.call', 'cache.set'],
    mode: ['cache.get', 'provider.call', 'cache.set'],
    zero: ['cache.get', 'provider.call', 'cache.set'],
    hit: ['cache.get', 'provider.call', 'cache.set', 'cache.get'],
    head: ['cache.get', 'provider.call', 'cache.set', 'cache.get', 'cache.get'],
    empty: ['cache.get', 'provider.call', 'cache.get', 'provider.call', 'cache.get', 'provider.call', 'cache.set'],
    'provider-error': ['cache.get', 'provider.call', 'cache.get', 'provider.call'],
    skip: ['cache.get', 'provider.call', 'cache.set', 'provider.call', 'cache.set'],
  }[spec.kind];
  if (canonical((row.effects || []).map(effect => effect.operation)) !== canonical(expectedOperations)) errors.push({ kind: 'effect-order', actual: row.effects, expected: expectedOperations });
  const expectedKey = keyFor(spec.mode || 'driving');
  for (const effect of row.effects || []) {
    if ((effect.operation === 'cache.get' || effect.operation === 'cache.set') && effect.key !== expectedKey) errors.push({ kind: 'cache-key', actual: effect.key, expected: expectedKey });
  }
  const sideDiffs = [];
  if (side === 'source') validateSourceWire(row, spec, sideDiffs); else validateCandidateWire(row, spec, sideDiffs);
  for (const item of errors) differences.push({ side, id: spec.id, ...item });
  for (const item of sideDiffs) differences.push({ side, ...item });
}

function comparable(row) {
  return {
    responses: row.responses,
    effects: row.effects,
    providerSemantics: (row.providerCalls || []).map(call => ({ key: call.key, origin: call.origin, destination: call.destination, mode: call.mode, status: call.status })),
    cacheKeys: row.observations && row.observations.cacheKeys,
    observations: row.observations,
  };
}

checkMatrix();
checkMetadata(source, 'source');
checkMetadata(candidate, 'candidate');
const sourceRows = validateRows(source, 'source');
const candidateRows = validateRows(candidate, 'candidate');

for (const spec of matrix.cases) {
  const a = sourceRows.get(spec.id);
  const b = candidateRows.get(spec.id);
  if (!a || !b) continue;
  validateCaseContract(a, spec, 'source');
  validateCaseContract(b, spec, 'candidate');
  const ac = comparable(a); const bc = comparable(b);
  if (canonical(ac) !== canonical(bc)) differences.push({ id: spec.id, kind: 'runtime-difference', firstDifference: firstDifference(stable(ac), stable(bc)) });
}

const report = {
  schema: matrix.harness.differentialSchema,
  result: receiptErrors.length || differences.length ? 'fail' : 'pass',
  task: matrix.task,
  base: matrix.base,
  referenceRevision: sourceRevision,
  sourceImage,
  sourceImageDigest,
  cases: EXPECTED_CASE_IDS.length,
  differences,
  receiptErrors,
  falsifierReady: true,
};
if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
process.stdout.write(`${JSON.stringify({ result: report.result, cases: report.cases, differences: differences.length, receiptErrors: receiptErrors.length, out: output })}\n`);
if (report.result !== 'pass') process.exitCode = 1;
