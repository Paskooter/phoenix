'use strict';

// Immutable acceptance contract for the S-11 HTTP graph lane.  Keep this
// module CommonJS and Node 8-compatible because the source runner loads it in
// the pinned Pegasus container as well as from the current Phoenix process.

const crypto = require('crypto');

const EXPECTED_SCHEMA = 's11-report-commute-http-v1';
const EXPECTED_RECEIPT_SCHEMA = 's11-report-commute-http-receipt-v1';
const EXPECTED_SOURCE_REVISION = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';
const EXPECTED_SOURCE_IMAGE = 'node';
const EXPECTED_SOURCE_IMAGE_DIGEST = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';
const EXPECTED_MATRIX_SEMANTIC_SHA256 = '45674b4578430637ca8cc1a08447072773d1138677b64b988e3a4c36c4e7f694';

// This is the only accepted case inventory.  The matrix file is input data,
// so its own cases.length and order cannot define the scope of the proof.
const EXPECTED_CASE_IDS = Object.freeze([
  'full-driving-normal-offset',
  'single-driving-confirm-and-normal',
  'driving-traffic-poor-exact-five',
  'driving-traffic-poor-fourteen',
  'driving-traffic-terrible-exact-fifteen',
  'driving-missing-traffic-falls-back',
  'transit-ignores-traffic',
  'bicycling-normal',
  'walking-normal',
  'driving-hurry-minus-nine',
  'transit-hurry-minus-nine',
  'driving-late-minus-ten',
  'driving-now-over-two-hours',
  'driving-normal-exact-120-minutes-left',
  'driving-normal-exact-30-minutes-left',
  'driving-normal-29-minutes-adds-countdown',
  'driving-now-exact-minus-31',
  'driving-duration-floor-and-minutes',
  'driving-pm-departure-view',
  'incomplete-prefs-no-maps',
  'maps-service-failure',
  'maps-empty-routes-service-down',
  'maps-malformed-envelope-service-down',
  'settings-failure-single',
  'unidentified-speaker',
  'single-commute-not-in-loop-must-be-looper',
  'single-commute-child-must-be-adult',
  'full-commute-active-calendar-off',
  'full-commute-calendar-dependency',
  'full-all-services-down',
  'invalid-commute-prefs-no-maps',
  'maps-null-envelope-service-down',
  'maps-malformed-route-service-down',
]);

const EXPECTED_COUNTS = Object.freeze({ cases: 33, responses: 34, calls: 31 });

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => { out[key] = stable(value[key]); });
  return out;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The digest covers every matrix field except its self-describing digest.
// This binds expected MIMs, speech tokens, provider fixtures/semantics,
// coordinates, source pins, and the case inventory as one immutable payload.
function matrixSemanticPayload(matrix) {
  const payload = {};
  if (matrix && typeof matrix === 'object') {
    Object.keys(matrix).forEach((key) => {
      if (key !== 'matrixSemanticSha256') payload[key] = matrix[key];
    });
  }
  return payload;
}

function matrixSemanticSha256(matrix) {
  return sha256(canonical(matrixSemanticPayload(matrix)));
}

function validateMatrix(matrix, expectedSemanticSha256) {
  const errors = [];
  const expectedHash = expectedSemanticSha256 || null;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return [{ kind: 'shape', actual: matrix, expected: 'object' }];
  }
  if (matrix.schema !== EXPECTED_SCHEMA) errors.push({ kind: 'schema', actual: matrix.schema, expected: EXPECTED_SCHEMA });
  if (matrix.referenceRevision !== EXPECTED_SOURCE_REVISION) errors.push({ kind: 'source-revision', actual: matrix.referenceRevision, expected: EXPECTED_SOURCE_REVISION });
  if (matrix.sourceImage !== EXPECTED_SOURCE_IMAGE) errors.push({ kind: 'source-image', actual: matrix.sourceImage, expected: EXPECTED_SOURCE_IMAGE });
  if (matrix.sourceImageDigest !== EXPECTED_SOURCE_IMAGE_DIGEST) errors.push({ kind: 'source-image-digest', actual: matrix.sourceImageDigest, expected: EXPECTED_SOURCE_IMAGE_DIGEST });
  if (canonical(matrix.counts) !== canonical(EXPECTED_COUNTS)) errors.push({ kind: 'counts', actual: matrix.counts, expected: EXPECTED_COUNTS });

  if (!Array.isArray(matrix.cases)) {
    errors.push({ kind: 'case-shape', actual: matrix.cases, expected: 'array' });
  } else {
    const actualIds = matrix.cases.map((item) => item && item.id);
    if (matrix.cases.length !== EXPECTED_CASE_IDS.length) errors.push({ kind: 'case-count', actual: matrix.cases.length, expected: EXPECTED_CASE_IDS.length });
    if (canonical(actualIds) !== canonical(EXPECTED_CASE_IDS)) errors.push({ kind: 'case-inventory', actual: actualIds, expected: EXPECTED_CASE_IDS });
  }

  if (expectedHash && matrix.matrixSemanticSha256 !== expectedHash) errors.push({ kind: 'matrix-semantic-field', actual: matrix.matrixSemanticSha256, expected: expectedHash });
  if (expectedHash && matrixSemanticSha256(matrix) !== expectedHash) errors.push({ kind: 'matrix-semantic-hash', actual: matrixSemanticSha256(matrix), expected: expectedHash });
  return errors;
}

function receiptCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    cases: list.length,
    responses: list.reduce((total, row) => total + (row && Array.isArray(row.responses) ? row.responses.length : 0), 0),
    calls: list.reduce((total, row) => total + (row && Array.isArray(row.dataRequests) ? row.dataRequests.length : 0), 0),
  };
}

module.exports = {
  EXPECTED_SCHEMA,
  EXPECTED_RECEIPT_SCHEMA,
  EXPECTED_SOURCE_REVISION,
  EXPECTED_SOURCE_IMAGE,
  EXPECTED_SOURCE_IMAGE_DIGEST,
  EXPECTED_MATRIX_SEMANTIC_SHA256,
  EXPECTED_CASE_IDS,
  EXPECTED_COUNTS,
  canonical,
  matrixSemanticSha256,
  receiptCounts,
  validateMatrix,
};
