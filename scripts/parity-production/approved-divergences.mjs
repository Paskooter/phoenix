import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = fileURLToPath(new URL('./approved-divergences.json', import.meta.url));
export const APPROVED_MANIFEST_SHA256 = '9fd4e94bd9192970056d02bec2ccdd8d9acc61463165f274b5da6d57cba97bbf';

const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_CASE_IDS = [
  'boundary:rules-null',
  'boundary:rules-string',
  'boundary:missing-data',
  'boundary:text-number',
];
const MANIFEST_KEYS = [
  'schemaVersion',
  'kind',
  'referenceRevision',
  'suiteId',
  'suiteSha256',
  'comparisonSchemaVersion',
  'expectedDivergenceCount',
  'expectedCaseIds',
  'review',
  'divergences',
];
const REVIEW_KEYS = ['result', 'scope', 'rationale'];
const DIVERGENCE_KEYS = ['caseId', 'path', 'kind', 'reference', 'candidate'];
const VALUE_KEYS = ['present', 'value'];

const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = values => [...values].sort();

function fail(message) {
  throw new Error(`Approved divergence validation failed: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  if (!isDeepStrictEqual(sorted(Object.keys(value)), sorted(expected))) {
    fail(`${label} has an unsupported or missing field`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} is not a SHA-256 digest`);
}

function validateSide(side, label, expectedPresent) {
  exactKeys(side, expectedPresent ? VALUE_KEYS : ['present'], label);
  if (typeof side.present !== 'boolean' || side.present !== expectedPresent) {
    fail(`${label}.present is not the reviewed presence state`);
  }
}

function validateManifestShape(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'approved-security-divergence-manifest') {
    fail('manifest schema or kind is not approved');
  }
  if (typeof manifest.referenceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.referenceRevision)) {
    fail('manifest reference revision is invalid');
  }
  if (typeof manifest.suiteId !== 'string' || !manifest.suiteId) fail('manifest suite id is invalid');
  assertSha256(manifest.suiteSha256, 'manifest suiteSha256');
  if (manifest.comparisonSchemaVersion !== 1) fail('comparison schema is not approved');
  if (manifest.expectedDivergenceCount !== 22) fail('approved divergence count is not 22');
  if (!isDeepStrictEqual(manifest.expectedCaseIds, EXPECTED_CASE_IDS)) fail('approved case ID set changed');
  exactKeys(manifest.review, REVIEW_KEYS, 'manifest review');
  if (manifest.review.result !== 'approved' || !manifest.review.scope || !manifest.review.rationale) {
    fail('manifest review is missing approval or rationale');
  }
  if (!Array.isArray(manifest.divergences) || manifest.divergences.length !== manifest.expectedDivergenceCount) {
    fail('manifest divergence list is incomplete');
  }
  const seen = new Set();
  for (const [index, divergence] of manifest.divergences.entries()) {
    const label = `manifest divergences[${index}]`;
    exactKeys(divergence, DIVERGENCE_KEYS, label);
    if (!EXPECTED_CASE_IDS.includes(divergence.caseId)) fail(`${label} names an unapproved case`);
    if (typeof divergence.path !== 'string' || !/^\/[^/].*$/.test(divergence.path) || divergence.path.includes('//')) {
      fail(`${label}.path is not a stable relative comparison path`);
    }
    if (divergence.path.startsWith('/cases/')) fail(`${label}.path must not depend on a case index`);
    if (!['presence', 'value'].includes(divergence.kind)) fail(`${label}.kind is not approved`);
    const key = `${divergence.caseId}\0${divergence.path}`;
    if (seen.has(key)) fail(`${label} duplicates a case/path`);
    seen.add(key);
    if (divergence.kind === 'presence') {
      if (!isObject(divergence.reference) || !isObject(divergence.candidate)) fail(`${label} presence sides are malformed`);
      validateSide(divergence.reference, `${label}.reference`, divergence.reference.present);
      validateSide(divergence.candidate, `${label}.candidate`, divergence.candidate.present);
    } else {
      validateSide(divergence.reference, `${label}.reference`, true);
      validateSide(divergence.candidate, `${label}.candidate`, true);
    }
  }
  return manifest;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadApprovedDivergences(path = MANIFEST_PATH) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(`manifest cannot be read: ${error.message}`);
  }
  if (hash(bytes) !== APPROVED_MANIFEST_SHA256) fail('manifest hash is not the reviewed hash');
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    fail(`manifest JSON is invalid: ${error.message}`);
  }
  return validateManifestShape(manifest);
}

function normalizedDifference(difference, label) {
  if (!isObject(difference)) fail(`${label} is not an object`);
  if (difference.kind === 'presence') {
    exactKeys(difference, [
      'path',
      'kind',
      'expectedPresent',
      'actualPresent',
      ...(difference.expectedPresent ? ['expected'] : []),
      ...(difference.actualPresent ? ['actual'] : []),
    ], label);
    if (typeof difference.expectedPresent !== 'boolean' || typeof difference.actualPresent !== 'boolean') {
      fail(`${label} has invalid presence flags`);
    }
    const reference = { present: difference.expectedPresent };
    if (difference.expectedPresent) reference.value = difference.expected;
    const candidate = { present: difference.actualPresent };
    if (difference.actualPresent) candidate.value = difference.actual;
    return { kind: 'presence', reference, candidate };
  }
  if (difference.kind === 'value') {
    exactKeys(difference, ['path', 'kind', 'expected', 'actual'], label);
    return {
      kind: 'value',
      reference: { present: true, value: difference.expected },
      candidate: { present: true, value: difference.actual },
    };
  }
  fail(`${label} has an unapproved difference kind`);
}

function validateSuite(suite, suiteBytes, manifest) {
  if (!isObject(suite) || typeof suite.id !== 'string' || suite.id !== manifest.suiteId) {
    fail('capture suite ID is not the reviewed suite');
  }
  if (suite.referenceRevision !== manifest.referenceRevision) fail('capture reference revision changed');
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) fail('capture suite cases are missing');
  if (!suiteBytes || hash(suiteBytes) !== manifest.suiteSha256) fail('capture suite bytes are not the reviewed golden');
  const ids = suite.cases.map((definition, index) => {
    if (!isObject(definition) || typeof definition.id !== 'string' || !definition.id) fail(`suite case ${index} has no stable ID`);
    return definition.id;
  });
  if (new Set(ids).size !== ids.length) fail('capture suite case IDs are not unique');
  for (const caseId of manifest.expectedCaseIds) if (!ids.includes(caseId)) fail(`reviewed case is missing from suite: ${caseId}`);
  return new Map(ids.map((id, index) => [id, index]));
}

function validateRun(run, comparison, comparisonBytes, suiteBytes, manifest) {
  if (!isObject(run)) fail('run record is missing');
  if (run.result !== 'mismatch') fail('approved divergence requires an honest mismatch run result');
  if (run.referenceRevision !== manifest.referenceRevision || run.candidate !== 'phoenix') {
    fail('run provenance is not the reviewed Phoenix smoke run');
  }
  if (run.cases !== comparison.cases || run.differences !== comparison.differences.length
      || run.invariants !== comparison.invariants.length || run.coverageGaps !== comparison.coverageGaps.length) {
    fail('run record counters disagree with comparison output');
  }
  if (has(run, 'failure') || has(run, 'cleanupFailures')) fail('run contains a tool/runtime failure');
  if (!Array.isArray(run.commands) || !run.commands.length) fail('run command record is missing');
  const allowed = new Set(['image-phoenix', 'pull-phoenix', 'candidate', 'compare']);
  const names = new Set();
  for (const command of run.commands) {
    if (!isObject(command) || typeof command.name !== 'string' || !allowed.has(command.name)) fail('run contains an unknown tool command');
    if (names.has(command.name)) fail(`run repeats tool command: ${command.name}`);
    names.add(command.name);
    if (!Number.isInteger(command.exitCode) || command.timedOut) fail(`run command failed or timed out: ${command.name}`);
    const expectedExit = command.name === 'compare' ? 1 : 0;
    if (command.exitCode !== expectedExit) fail(`run command has unexpected exit code: ${command.name}`);
  }
  for (const required of ['image-phoenix', 'candidate', 'compare']) if (!names.has(required)) fail(`run is missing command: ${required}`);
  if (!isObject(run.artifacts) || run.artifacts['suite.json'] !== hash(suiteBytes)
      || run.artifacts['comparison.json'] !== hash(comparisonBytes)) {
    fail('run artifact hashes do not cover the validated suite and comparison');
  }
}

export function validateApprovedDivergences({ comparison, suite, suiteBytes, comparisonBytes, run, manifest }) {
  validateManifestShape(manifest);
  const caseIndexes = validateSuite(suite, suiteBytes, manifest);
  if (!isObject(comparison) || comparison.schemaVersion !== manifest.comparisonSchemaVersion) fail('comparison schema is not approved');
  if (comparison.pass !== false || comparison.measuredAgreement !== false) fail('strict comparison did not record a mismatch');
  if (comparison.cases !== suite.cases.length) fail('comparison case coverage changed');
  if (!Array.isArray(comparison.invariants) || comparison.invariants.length) fail('comparison contains invariant failures');
  if (!Array.isArray(comparison.coverageGaps) || comparison.coverageGaps.length) fail('comparison contains coverage gaps');
  if (!Array.isArray(comparison.differences)) fail('comparison differences are missing');
  if (comparison.differences.length !== manifest.expectedDivergenceCount) fail('comparison difference count is not the reviewed count');
  if (!comparisonBytes || hash(comparisonBytes) === '') fail('comparison bytes are missing');

  const approved = new Map(manifest.divergences.map(divergence => [
    `${divergence.caseId}\0${divergence.path}`,
    divergence,
  ]));
  const matched = new Set();
  for (const [index, difference] of comparison.differences.entries()) {
    const label = `comparison differences[${index}]`;
    if (!isObject(difference) || typeof difference.path !== 'string') fail(`${label} is malformed`);
    const match = /^\/cases\/(\d+)(\/.*)$/.exec(difference.path);
    if (!match) fail(`${label} is outside a stable case/path`);
    const caseIndex = Number(match[1]);
    const caseId = suite.cases[caseIndex]?.id;
    if (caseId === undefined || caseIndexes.get(caseId) !== caseIndex) fail(`${label} names an unknown case`);
    const relativePath = match[2];
    const key = `${caseId}\0${relativePath}`;
    const expected = approved.get(key);
    if (!expected) fail(`${label} does not match an approved divergence`);
    if (matched.has(key)) fail(`${label} duplicates an approved divergence`);
    const actual = normalizedDifference(difference, label);
    if (actual.kind !== expected.kind || !isDeepStrictEqual(actual.reference, expected.reference)
        || !isDeepStrictEqual(actual.candidate, expected.candidate)) {
      fail(`${label} does not match approved divergence ${caseId}${relativePath}`);
    }
    matched.add(key);
  }
  if (matched.size !== approved.size) {
    const missing = [...approved.keys()].filter(key => !matched.has(key));
    fail(`missing approved divergence: ${missing.join(', ')}`);
  }
  validateRun(run, comparison, comparisonBytes, suiteBytes, manifest);
  return {
    approved: true,
    approvedCount: matched.size,
    caseIds: manifest.expectedCaseIds,
  };
}
