#!/usr/bin/env node

/**
 * Pure, fail-closed validation for the S-13 physical capture receipt.
 *
 * This module only reads JSON and referenced artifact bytes.  It does not
 * start Phoenix, talk to a robot, invoke a provider, or trust receipt fields
 * that can be recomputed from the matrix/artifacts.  A receipt is accepted
 * only when every matrix row is present in order and every required binding
 * has a valid value and hash.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MATRIX_PATH = path.join(here, 'matrix.json');
export const RECEIPT_SCHEMA = 'phoenix.parity.s13.physical-capture-receipt';
export const RECEIPT_VERSION = 1;
export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const REVISION_RE = /^[0-9a-f]{40}$/;

// These values are deliberately duplicated in code.  Updating matrix.json and
// its self-reported digest cannot silently redefine the acceptance contract.
export const IMMUTABLE = Object.freeze({
  matrixSha256: 'ea64253c1ce045370d115c61b0075663abc2a8f8452b42e466646d4444ce93ea',
  caseInventorySha256: 'b2410705ee0b7b2f8096fd974a06fdf8b7e983d63c544394a96019ac11671d53',
  baseRevision: '0902410c597f8dc424af60ee98fc4d32f19a1bb0',
  caseIds: Object.freeze([
    'commute-normal-combined',
    'commute-bad-combined',
    'commute-terrible-combined',
    'commute-pm-departure-combined',
    'calendar-four-card-field-matrix',
    'calendar-concurrent-parallel',
    'calendar-tree-park-nature',
    'commute-no-view-now',
    'commute-no-view-hurry',
    'commute-no-view-late',
    'commute-no-view-app-setup',
    'commute-no-view-service-down',
    'calendar-no-view-empty',
    'calendar-no-view-asked-tomorrow',
    'calendar-no-view-app-setup',
    'weather-revalidation',
    'news-revalidation'
  ]),
  controlIds: Object.freeze([
    'matrix-case-omission',
    'matrix-case-reorder',
    'receipt-case-omission',
    'receipt-case-reorder',
    'stale-phoenix-revision',
    'provenance-version-omission',
    'input-payload-mutation',
    'action-payload-mutation',
    'view-contract-mutation',
    'correlation-mismatch',
    'wire-trace-hash-mismatch',
    'screenshot-order-mutation',
    'screenshot-bytes-mutation',
    'idle-closure-omission',
    'no-view-screenshot-injection',
    'blocked-tree-claim',
    'falsification-control-omission'
  ])
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function canonicalSha256(value) {
  return sha256Text(canonicalJson(value));
}

export function matrixInventory(matrix) {
  return (matrix && Array.isArray(matrix.cases) ? matrix.cases : []).map(({ ordinal, id, kind, domain }) => ({
    ordinal, id, kind, domain
  }));
}

export function matrixWithoutIntegrity(matrix) {
  if (!matrix || typeof matrix !== 'object') return matrix;
  const copy = { ...matrix };
  delete copy.integrity;
  return copy;
}

export function matrixSha256(matrix) {
  return canonicalSha256(matrixWithoutIntegrity(matrix));
}

export function addLocalDays(dateISO, days, timezone = 'America/New_York') {
  if (typeof dateISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  if (typeof timezone !== 'string' || !timezone) return null;
  // Calendar fixtures are keyed by a wall date.  Read the wall-date parts in
  // the declared zone, add a civil day, and format the resulting civil date;
  // no UTC hour arithmetic is used, so DST transitions cannot shift a card.
  const parts = dateISO.split('-').map(Number);
  const probe = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
  if (Number.isNaN(probe.getTime())) return null;
  const localParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(probe).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  const shifted = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day + days, 12));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function resolveCommuteSchedule(locationISO, schedule, timezone = 'America/New_York') {
  const instant = new Date(locationISO);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(instant).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  let dateISO = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  let hour = parts.hour;
  let minute = parts.minute;
  if (schedule === 'next-local-pm-17:05') {
    if (hour > 17 || (hour === 17 && minute >= 5)) dateISO = addLocalDays(dateISO, 1, timezone);
    hour = 17;
    minute = 5;
  } else if (schedule === 'capture-plus-60-minutes') {
    // Advance the instant before converting back to wall time.  This maps a
    // spring-forward hour to 03:xx rather than inventing a nonexistent 02:xx.
    const shifted = new Date(instant.getTime() + 60 * 60 * 1000);
    const shiftedParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(shifted).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
    dateISO = `${shiftedParts.year}-${String(shiftedParts.month).padStart(2, '0')}-${String(shiftedParts.day).padStart(2, '0')}`;
    hour = shiftedParts.hour;
    minute = shiftedParts.minute;
  } else return null;
  return { dateISO, hour, minute };
}

function same(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function requireObject(errors, value, label) {
  add(errors, isObject(value), `${label} must be an object`);
  return isObject(value);
}

function requireString(errors, value, label) {
  add(errors, isNonEmptyString(value), `${label} must be a non-empty string`);
  return isNonEmptyString(value);
}

function requireDigest(errors, value, label) {
  add(errors, typeof value === 'string' && DIGEST_RE.test(value), `${label} must be a lowercase SHA-256 digest`);
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function requireRevision(errors, value, label) {
  add(errors, typeof value === 'string' && REVISION_RE.test(value), `${label} must be a 40-character lowercase revision`);
  return typeof value === 'string' && REVISION_RE.test(value);
}

function expectedViewContracts(descriptor) {
  return descriptor?.expected?.viewContracts || [];
}

function expectedViewIds(descriptor) {
  if (Array.isArray(descriptor?.expected?.viewIds)) return descriptor.expected.viewIds;
  return expectedViewContracts(descriptor).map((view) => view.id);
}

function expectedMimIds(descriptor) {
  return descriptor?.expected?.mimIds || [];
}

function mimIdsAreCaptureDerived(descriptor) {
  return descriptor?.expected?.mimIdsPolicy === 'capture-derived';
}

export function validateMatrix(matrix) {
  const errors = [];
  if (!requireObject(errors, matrix, 'matrix')) return { result: 'fail', errors };
  add(errors, matrix.schema === 'phoenix.parity.s13.physical-capture-matrix', 'matrix.schema is not the S-13 physical matrix');
  add(errors, matrix.schemaVersion === 1, 'matrix.schemaVersion must be 1');
  add(errors, matrix.task === 'S-13', 'matrix.task must be S-13');
  add(errors, matrix.claim === 'physical-display-only', 'matrix.claim must be physical-display-only');
  add(errors, matrix.baseRevision === IMMUTABLE.baseRevision, 'matrix.baseRevision is not the requested immutable base');
  requireRevision(errors, matrix.referenceRevision, 'matrix.referenceRevision');
  add(errors, matrix.clockPolicy?.mode === 'relative-fixtures', 'matrix.clockPolicy must use relative-fixtures');
  add(errors, matrix.clockPolicy?.timezone === 'America/New_York', 'matrix.clockPolicy timezone is not America/New_York');
  add(errors, matrix.physicalProtocol?.captureMode === 'CLIENT_ASR_TEXT_INJECTION_WITH_MICROPHONE_ACCEPTANCE_FALSE', 'matrix physical capture mode is not the bounded text-injection mode');
  add(errors, Array.isArray(matrix.physicalProtocol?.allowedRequests) && matrix.physicalProtocol.allowedRequests.length > 0, 'matrix must allow-list a proven SDK request operation before capture');
  const allowedOperations = new Set();
  for (const request of matrix.physicalProtocol?.allowedRequests || []) {
    if (!requireObject(errors, request, 'matrix.physicalProtocol.allowedRequests item')) continue;
    requireString(errors, request.operation, 'matrix allowed request operation');
    requireString(errors, request.method, 'matrix allowed request method');
    requireString(errors, request.endpoint, 'matrix allowed request endpoint');
    requireString(errors, request.transportMode, 'matrix allowed request transportMode');
    requireString(errors, request.bodyField, 'matrix allowed request bodyField');
    requireString(errors, request.contextSource, 'matrix allowed request contextSource');
    allowedOperations.add(request.operation);
  }
  add(errors, allowedOperations.has('mimicGlobalTurn') || allowedOperations.has('startLocalTurn'), 'matrix must allow a known original SDK local/global turn operation');
  add(errors, matrix.physicalProtocol?.preflight?.required === true, 'matrix requires an operation/context preflight');
  add(errors, matrix.physicalProtocol?.preflight?.contextSourceMustBeExplicit === true, 'matrix preflight must require explicit context provenance');
  add(errors, Array.isArray(matrix.physicalProtocol?.preflight?.contextFields), 'matrix preflight context fields are missing');
  add(errors, matrix.physicalProtocol?.request?.microphoneAcceptance === false, 'matrix must explicitly disable microphone acceptance for text injection');
  add(errors, matrix.physicalProtocol?.receiptHashing?.algorithm === 'sha256', 'matrix artifact hashing must use SHA-256');
  add(errors, matrix.physicalProtocol?.receiptHashing?.screenshotIdentity === 'ordinal+viewId; duplicate view IDs are separate captures and must not be deduplicated', 'matrix screenshot identity must preserve duplicate view ordinals');
  add(errors, Array.isArray(matrix.falsificationControls) && same(matrix.falsificationControls, IMMUTABLE.controlIds), 'matrix falsification controls are missing, reordered, or changed');

  if (!Array.isArray(matrix.cases)) {
    errors.push('matrix.cases must be an array');
  } else {
    add(errors, matrix.cases.length === IMMUTABLE.caseIds.length, `matrix must contain exactly ${IMMUTABLE.caseIds.length} cases`);
    const seen = new Set();
    matrix.cases.forEach((descriptor, index) => {
      const expectedId = IMMUTABLE.caseIds[index];
      if (!requireObject(errors, descriptor, `matrix.cases[${index}]`)) return;
      add(errors, descriptor.ordinal === index + 1, `matrix case ${index} ordinal is not ${index + 1}`);
      add(errors, descriptor.id === expectedId, `matrix case ${index} id/order differs from the immutable inventory`);
      if (seen.has(descriptor.id)) errors.push(`matrix duplicate case id: ${descriptor.id}`);
      seen.add(descriptor.id);
      add(errors, ['physical', 'no-view', 'revalidation', 'blocked'].includes(descriptor.kind), `matrix case ${descriptor.id} has an unknown kind`);
      requireString(errors, descriptor.domain, `matrix case ${descriptor.id}.domain`);
      requireObject(errors, descriptor.expected, `matrix case ${descriptor.id}.expected`);
      add(errors, Array.isArray(descriptor.expected?.mimIds), `matrix case ${descriptor.id}.expected.mimIds must be an array`);
      if (descriptor.kind === 'revalidation') add(errors, descriptor.expected?.mimIdsPolicy === 'capture-derived', `matrix revalidation case ${descriptor.id} must declare capture-derived MIM IDs`);
      add(errors, Array.isArray(descriptor.expected?.viewIds), `matrix case ${descriptor.id}.expected.viewIds must be an array`);
      add(errors, Array.isArray(descriptor.expected?.viewContracts), `matrix case ${descriptor.id}.expected.viewContracts must be an array`);
      add(errors, same(expectedViewIds(descriptor), expectedViewContracts(descriptor).map((view) => view.id)), `matrix case ${descriptor.id} viewIds do not match view contract order`);
      if (descriptor.kind === 'blocked') {
        add(errors, descriptor.blocked?.reason === 'missing-source-asset:tree', `matrix case ${descriptor.id} must be blocked for the missing tree asset`);
        add(errors, descriptor.blocked?.asset === 'assets/personal-report-skill/calendar/icons/tree_v01.crn', `matrix case ${descriptor.id} must name tree_v01.crn as the blocked asset`);
      }
      if (descriptor.kind === 'no-view') {
        add(errors, descriptor.expected.viewIds.length === 0, `matrix no-view case ${descriptor.id} must have zero expected views`);
        add(errors, descriptor.expected.viewContracts.length === 0, `matrix no-view case ${descriptor.id} must have zero view contracts`);
        requireObject(errors, descriptor.reference, `matrix no-view case ${descriptor.id}.reference`);
        requireDigest(errors, descriptor.reference?.sha256, `matrix no-view case ${descriptor.id}.reference.sha256`);
      }
      if (descriptor.kind === 'physical' || descriptor.kind === 'revalidation') {
        requireObject(errors, descriptor.input, `matrix case ${descriptor.id}.input`);
        requireObject(errors, descriptor.provider, `matrix case ${descriptor.id}.provider`);
        add(errors, descriptor.provider?.fixtureSha256Required === true, `matrix case ${descriptor.id} must require a provider fixture hash`);
        add(errors, descriptor.expected.viewContracts.length > 0, `matrix case ${descriptor.id} must pin at least one view contract`);
      }
    });
  }

  const actualInventoryDigest = canonicalSha256(matrixInventory(matrix));
  const actualMatrixDigest = matrixSha256(matrix);
  add(errors, matrix.integrity?.algorithm === 'sha256', 'matrix.integrity.algorithm must be sha256');
  add(errors, matrix.integrity?.canonicalExcludes?.[0] === 'integrity', 'matrix.integrity must exclude only itself from matrix digest');
  add(errors, matrix.integrity?.matrixSha256 === IMMUTABLE.matrixSha256, 'matrix reported matrixSha256 differs from immutable validator pin');
  add(errors, matrix.integrity?.caseInventorySha256 === IMMUTABLE.caseInventorySha256, 'matrix reported caseInventorySha256 differs from immutable validator pin');
  add(errors, actualMatrixDigest === IMMUTABLE.matrixSha256, `matrix canonical digest mismatch (computed ${actualMatrixDigest})`);
  add(errors, actualInventoryDigest === IMMUTABLE.caseInventorySha256, `matrix inventory digest mismatch (computed ${actualInventoryDigest})`);

  const counts = matrix.counts;
  if (isObject(counts) && Array.isArray(matrix.cases)) {
    const count = (kind) => matrix.cases.filter((item) => item.kind === kind).length;
    add(errors, counts.total === matrix.cases.length, 'matrix counts.total is wrong');
    add(errors, counts.physical === count('physical'), 'matrix counts.physical is wrong');
    add(errors, counts.noViewAssertions === count('no-view'), 'matrix counts.noViewAssertions is wrong');
    add(errors, counts.revalidation === count('revalidation'), 'matrix counts.revalidation is wrong');
    add(errors, counts.blocked === count('blocked'), 'matrix counts.blocked is wrong');
  } else errors.push('matrix.counts must be an object');

  return {
    result: errors.length ? 'fail' : 'pass',
    errors,
    matrixSha256: actualMatrixDigest,
    caseInventorySha256: actualInventoryDigest,
    caseIds: Array.isArray(matrix.cases) ? matrix.cases.map((item) => item?.id) : []
  };
}

function safeArtifactPath(root, filePath, errors, label) {
  if (!requireString(errors, filePath, `${label}.path`)) return null;
  if (path.isAbsolute(filePath)) {
    errors.push(`${label}.path must be relative to the receipt root`);
    return null;
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, filePath);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    errors.push(`${label}.path escapes the receipt root`);
    return null;
  }
  return resolved;
}

function validateArtifactRef(ref, root, errors, label) {
  if (!requireObject(errors, ref, label)) return null;
  const resolved = safeArtifactPath(root, ref.path, errors, label);
  const hashOk = requireDigest(errors, ref.sha256, `${label}.sha256`);
  if (!resolved || !hashOk) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    errors.push(`${label}.path cannot be read: ${error.code || error.message}`);
    return null;
  }
  const actual = sha256Bytes(bytes);
  add(errors, actual === ref.sha256, `${label}.sha256 does not match artifact bytes (computed ${actual})`);
  if (ref.bytes !== undefined) add(errors, ref.bytes === bytes.length, `${label}.bytes does not match artifact bytes`);
  return { path: ref.path, sha256: ref.sha256, bytes };
}

function validateReference(expected, actual, errors, label) {
  if (!requireObject(errors, actual, label)) return;
  add(errors, actual.lane === expected?.lane, `${label}.lane does not match matrix`);
  add(errors, actual.caseId === expected?.caseId, `${label}.caseId does not match matrix`);
  add(errors, actual.path === expected?.path, `${label}.path does not match matrix`);
  add(errors, actual.sha256 === expected?.sha256, `${label}.sha256 does not match matrix`);
  requireDigest(errors, actual.sha256, `${label}.sha256`);
}

function validateProvenance(receipt, matrix, errors) {
  if (!requireObject(errors, receipt.provenance, 'receipt.provenance')) return;
  const provenance = receipt.provenance;
  if (requireObject(errors, provenance.phoenix, 'receipt.provenance.phoenix')) {
    requireRevision(errors, provenance.phoenix.revision, 'receipt.provenance.phoenix.revision');
    requireRevision(errors, receipt.phoenixRevision, 'receipt.phoenixRevision');
    add(errors, receipt.phoenixRevision === provenance.phoenix.revision, 'receipt.phoenixRevision must duplicate the bound Phoenix provenance revision');
    add(errors, provenance.phoenix.baseRevision === matrix.baseRevision, 'receipt.provenance.phoenix.baseRevision does not match matrix base');
    requireDigest(errors, provenance.phoenix.treeSha256, 'receipt.provenance.phoenix.treeSha256');
    requireDigest(errors, provenance.phoenix.sourceManifestSha256, 'receipt.provenance.phoenix.sourceManifestSha256');
    requireString(errors, provenance.phoenix.worktree, 'receipt.provenance.phoenix.worktree');
  }
  const requiredPackages = [
    ['be', ['packageName', 'version', 'slot', 'packageSha256', 'deploymentReceiptSha256']],
    ['client', ['packageName', 'version', 'node', 'packageJsonSha256', 'entrySha256', 'loadedPath']],
    ['nimbus', ['packageName', 'version', 'root', 'packageJsonSha256', 'indexSha256', 'assetManifestSha256']],
    ['native', ['firmware', 'ssmVersion', 'ssmSha256', 'jetstreamBinarySha256', 'jetstreamConfigSha256']]
  ];
  for (const [name, fields] of requiredPackages) {
    const packageInfo = provenance[name];
    if (!requireObject(errors, packageInfo, `receipt.provenance.${name}`)) continue;
    fields.forEach((field) => requireString(errors, packageInfo[field], `receipt.provenance.${name}.${field}`));
    for (const field of fields.filter((field) => field.toLowerCase().includes('sha'))) {
      requireDigest(errors, packageInfo[field], `receipt.provenance.${name}.${field}`);
    }
  }
  add(errors, provenance.nimbus?.assetManifestSha256 === matrix.referenceContract?.assetAudit?.assetManifestSha256, 'receipt Nimbus asset manifest is not the audited manifest');
  add(errors, provenance.client?.node && /^(?:v)?\d+\.\d+\.\d+/.test(provenance.client.node), 'receipt client.node must record a Node version');
}

function validateMatrixBinding(receipt, matrix, errors) {
  if (!requireObject(errors, receipt.matrix, 'receipt.matrix')) return;
  const binding = receipt.matrix;
  add(errors, binding.path === 'scripts/parity-s13-physical/matrix.json', 'receipt.matrix.path is not the committed S-13 matrix');
  add(errors, binding.sha256 === matrix.integrity?.matrixSha256, 'receipt.matrix.sha256 does not match matrix digest');
  add(errors, binding.inventorySha256 === matrix.integrity?.caseInventorySha256, 'receipt.matrix.inventorySha256 does not match matrix inventory digest');
  add(errors, binding.baseRevision === matrix.baseRevision, 'receipt.matrix.baseRevision does not match matrix');
  add(errors, binding.caseCount === matrix.cases.length, 'receipt.matrix.caseCount does not match matrix');
  add(errors, Array.isArray(binding.orderedCaseIds) && same(binding.orderedCaseIds, matrix.cases.map((item) => item.id)), 'receipt.matrix.orderedCaseIds differ from matrix');
  requireDigest(errors, binding.sha256, 'receipt.matrix.sha256');
  requireDigest(errors, binding.inventorySha256, 'receipt.matrix.inventorySha256');
}

function validateRuntime(receipt, errors) {
  if (!requireObject(errors, receipt.runtime, 'receipt.runtime')) return;
  const runtime = receipt.runtime;
  requireString(errors, runtime.captureISO, 'receipt.runtime.captureISO');
  requireString(errors, runtime.localDateISO, 'receipt.runtime.localDateISO');
  add(errors, !Number.isNaN(Date.parse(runtime.captureISO)), 'receipt.runtime.captureISO must be an ISO timestamp');
  add(errors, /^\d{4}-\d{2}-\d{2}$/.test(runtime.localDateISO), 'receipt.runtime.localDateISO must be YYYY-MM-DD');
  add(errors, runtime.timezone === 'America/New_York', 'receipt.runtime.timezone must be America/New_York');
  add(errors, runtime.fixtureGenerator === 'relative-to-local-date', 'receipt.runtime.fixtureGenerator must be relative-to-local-date');
  add(errors, runtime.wallClockBound === true, 'receipt.runtime.wallClockBound must be true');
}

function selectedRequest(matrix, operation) {
  return (matrix.physicalProtocol?.allowedRequests || []).find((item) => item.operation === operation);
}

function validatePreflight(receipt, matrix, errors) {
  if (!requireObject(errors, receipt.preflight, 'receipt.preflight')) return null;
  const preflight = receipt.preflight;
  const allowed = selectedRequest(matrix, preflight.operation);
  add(errors, Boolean(allowed), 'receipt.preflight.operation is not allow-listed by the matrix');
  if (allowed) {
    add(errors, preflight.method === allowed.method, 'receipt.preflight.method does not match the allow-list');
    add(errors, preflight.endpoint === allowed.endpoint, 'receipt.preflight.endpoint does not match the allow-list');
    add(errors, preflight.transportMode === allowed.transportMode, 'receipt.preflight.transportMode does not match the allow-list');
    add(errors, preflight.bodyField === allowed.bodyField, 'receipt.preflight.bodyField does not match the allow-list');
    add(errors, preflight.contextSource === allowed.contextSource, 'receipt.preflight.contextSource does not match the allow-list');
  }
  add(errors, preflight.proven === true, 'receipt.preflight.proven must be true');
  if (requireObject(errors, preflight.context, 'receipt.preflight.context')) {
    requireString(errors, preflight.context.runtimeLocationISO, 'receipt.preflight.context.runtimeLocationISO');
    requireString(errors, preflight.context.timezone, 'receipt.preflight.context.timezone');
    add(errors, !Number.isNaN(Date.parse(preflight.context.runtimeLocationISO)), 'receipt.preflight.context.runtimeLocationISO must be an ISO timestamp');
    add(errors, preflight.context.timezone === matrix.clockPolicy?.timezone, 'receipt.preflight.context.timezone does not match matrix');
    requireDigest(errors, preflight.contextSha256, 'receipt.preflight.contextSha256');
    add(errors, preflight.contextSha256 === canonicalSha256(preflight.context), 'receipt.preflight.contextSha256 does not match context');
  }
  return allowed || null;
}

function validateRequest(descriptor, actual, errors, label, allowedRequest, preflight) {
  if (!requireObject(errors, actual, label)) return;
  add(errors, actual.operation === allowedRequest?.operation, `${label}.operation does not match the selected preflight operation`);
  add(errors, actual.method === 'POST', `${label}.method must be POST`);
  add(errors, actual.endpoint === allowedRequest?.endpoint, `${label}.endpoint does not match the selected preflight endpoint`);
  add(errors, actual.transportMode === allowedRequest?.transportMode, `${label}.transportMode does not match the selected preflight mode`);
  add(errors, actual.mode === descriptor.input?.mode, `${label}.mode does not match matrix input mode`);
  add(errors, actual.microphoneAcceptance === false, `${label}.microphoneAcceptance must be false`);
  add(errors, actual.phrase === descriptor.input?.phrase, `${label}.phrase does not match matrix input phrase`);
  const body = allowedRequest?.bodyField === 'clientASR'
    ? { clientASR: descriptor.input?.phrase }
    : actual.body;
  if (allowedRequest?.bodyField === 'clientASR') {
    add(errors, same(actual.body, body), `${label}.body is not exactly {clientASR: matrix phrase}`);
  } else {
    add(errors, isObject(actual.body) && Array.isArray(actual.body?.nluRules) && actual.body.nluRules.length > 0, `${label}.body must preserve the original local-turn nluRules contract`);
  }
  add(errors, actual.bodySha256 === canonicalSha256(actual.body), `${label}.bodySha256 does not match canonical request body`);
  requireDigest(errors, actual.bodySha256, `${label}.bodySha256`);
  if (descriptor.domain === 'commute') {
    requireString(errors, actual.locationISO, `${label}.locationISO`);
    add(errors, !Number.isNaN(Date.parse(actual.locationISO)), `${label}.locationISO must be an ISO timestamp`);
    add(errors, actual.locationISO === preflight?.context?.runtimeLocationISO, `${label}.locationISO must equal the preflight runtime context`);
    add(errors, actual.locationMode === 'capture-local-clock', `${label}.locationMode must be capture-local-clock`);
    add(errors, isObject(actual.prefs) && actual.prefs.mode === descriptor.input?.prefsPolicy?.mode, `${label}.prefs.mode does not match the matrix policy`);
    add(errors, actual.prefs?.baseSeconds === descriptor.input?.prefsPolicy?.baseSeconds, `${label}.prefs.baseSeconds does not match the matrix policy`);
    add(errors, actual.prefs?.trafficSeconds === descriptor.input?.prefsPolicy?.trafficSeconds, `${label}.prefs.trafficSeconds does not match the matrix policy`);
    add(errors, Number.isInteger(actual.prefs?.workHour) && Number.isInteger(actual.prefs?.workMin), `${label}.prefs must contain resolved wall-clock workHour/workMin`);
    requireString(errors, actual.prefs?.workDateISO, `${label}.prefs.workDateISO`);
    add(errors, /^\d{4}-\d{2}-\d{2}$/.test(actual.prefs?.workDateISO || ''), `${label}.prefs.workDateISO must be YYYY-MM-DD`);
    const resolvedSchedule = resolveCommuteSchedule(actual.locationISO, descriptor.input?.prefsPolicy?.schedule, 'America/New_York');
    if (resolvedSchedule) {
      add(errors, actual.prefs.workHour === resolvedSchedule.hour, `${label}.prefs.workHour is not derived from capture-local-clock`);
      add(errors, actual.prefs.workMin === resolvedSchedule.minute, `${label}.prefs.workMin is not derived from capture-local-clock`);
      add(errors, actual.prefs.workDateISO === resolvedSchedule.dateISO, `${label}.prefs.workDateISO is not derived from capture-local-clock`);
    } else errors.push(`${label}.prefs policy cannot be resolved`);
    if (requireObject(errors, actual.prefsResolution, `${label}.prefsResolution`)) {
      add(errors, actual.prefsResolution.schedule === descriptor.input?.prefsPolicy?.schedule, `${label}.prefsResolution.schedule does not match the matrix policy`);
      add(errors, actual.prefsResolution.generatedFrom === 'capture-local-clock', `${label}.prefsResolution.generatedFrom must be capture-local-clock`);
      add(errors, actual.prefsResolution.workDateISO === actual.prefs.workDateISO, `${label}.prefsResolution.workDateISO does not bind resolved prefs`);
      requireDigest(errors, actual.prefsResolution.sha256, `${label}.prefsResolution.sha256`);
      add(errors, actual.prefsResolution.sha256 === canonicalSha256(actual.prefs), `${label}.prefsResolution.sha256 does not match resolved prefs`);
    }
  }
  if (descriptor.domain === 'calendar') {
    requireString(errors, actual.calendarDateISO, `${label}.calendarDateISO`);
    add(errors, /^\d{4}-\d{2}-\d{2}$/.test(actual.calendarDateISO), `${label}.calendarDateISO must be YYYY-MM-DD`);
    const expectedDate = addLocalDays(actual.runtimeLocalDateISO, 1, 'America/New_York');
    add(errors, actual.calendarDateISO === expectedDate, `${label}.calendarDateISO must be the next local calendar date`);
    add(errors, actual.calendarFixture === descriptor.input?.calendarFixture, `${label}.calendarFixture does not match matrix`);
  }
  if (descriptor.kind === 'revalidation') {
    add(errors, actual.revalidation === true, `${label}.revalidation must be true`);
    add(errors, actual.runtimeLocalDateISO === actual.calendarDateISO || isNonEmptyString(actual.calendarDateISO), `${label} must record its resolved revalidation date`);
  }
}

function validateProvider(descriptor, actual, errors, label) {
  if (!requireObject(errors, actual, label)) return;
  add(errors, actual.kind === descriptor.provider?.kind, `${label}.kind does not match matrix`);
  if (descriptor.provider?.fixture !== undefined) add(errors, actual.fixture === descriptor.provider.fixture, `${label}.fixture does not match matrix`);
  if (descriptor.provider?.baseSeconds !== undefined) add(errors, actual.baseSeconds === descriptor.provider.baseSeconds, `${label}.baseSeconds does not match matrix`);
  if (descriptor.provider?.trafficSeconds !== undefined) add(errors, actual.trafficSeconds === descriptor.provider.trafficSeconds, `${label}.trafficSeconds does not match matrix`);
  if (descriptor.provider?.parallel !== undefined) add(errors, actual.parallel === descriptor.provider.parallel, `${label}.parallel does not match matrix`);
  requireString(errors, actual.resolvedDateISO, `${label}.resolvedDateISO`);
  requireDigest(errors, actual.fixtureSha256, `${label}.fixtureSha256`);
  if (descriptor.domain === 'calendar' || descriptor.domain === 'weather' || descriptor.domain === 'news') {
    const expectedDate = descriptor.domain === 'calendar'
      ? actual.calendarDateISO
      : actual.runtimeLocalDateISO;
    add(errors, actual.resolvedDateISO === expectedDate, `${label}.resolvedDateISO does not match the resolved fixture date`);
  }
}

function departureLabels(descriptor, actual) {
  const contract = expectedViewContracts(descriptor).find((view) => view.type === 'commute-departure');
  if (!contract?.labelsFrom) return contract?.labels || null;
  const workHour = actual?.request?.prefs?.workHour;
  const workMin = actual?.request?.prefs?.workMin;
  const seconds = actual?.provider?.trafficSeconds;
  if (!Number.isInteger(workHour) || !Number.isInteger(workMin) || !Number.isFinite(seconds)) return null;
  const date = new Date(Date.UTC(2000, 0, 1, workHour, workMin, 0) - seconds * 1000);
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return { time: `${hour12}:${String(minutes).padStart(2, '0')}`, ampm };
}

function resolvedViewContracts(descriptor, actual) {
  const contracts = expectedViewContracts(descriptor).map((view) => {
    if (view.type !== 'commute-departure' || !view.labelsFrom) return view;
    const labels = departureLabels(descriptor, actual);
    return { ...view, labelsFrom: undefined, labels };
  });
  return contracts.map((view) => {
    if (view.labelsFrom === undefined) {
      const { labelsFrom: _discard, ...rest } = view;
      return rest;
    }
    return view;
  });
}

function validateProjection(descriptor, action, errors, label, context = action) {
  if (!requireObject(errors, action, label)) return;
  const expectedProjection = {
    mimIds: mimIdsAreCaptureDerived(descriptor) ? action.projection?.mimIds : expectedMimIds(descriptor),
    viewIds: expectedViewIds(descriptor),
    viewContracts: resolvedViewContracts(descriptor, context)
  };
  add(errors, same(action.projection, expectedProjection), `${label}.projection differs from matrix action/view contract`);
  if (requireObject(errors, action.projection, `${label}.projection`)) {
    if (mimIdsAreCaptureDerived(descriptor)) {
      add(errors, Array.isArray(action.projection.mimIds) && action.projection.mimIds.length > 0, `${label}.projection.mimIds must be captured and non-empty for revalidation`);
    } else add(errors, same(action.projection.mimIds, expectedProjection.mimIds), `${label}.projection.mimIds differ from matrix`);
    add(errors, same(action.projection.viewIds, expectedProjection.viewIds), `${label}.projection.viewIds differ from matrix`);
    add(errors, same(action.projection.viewContracts, expectedProjection.viewContracts), `${label}.projection.viewContracts differ from matrix`);
  }
}

function validateAction(descriptor, actual, errors, label, context = actual, selectedOperation) {
  if (!requireObject(errors, actual, label)) return;
  validateProjection(descriptor, actual, errors, label, context);
  requireString(errors, actual.operation, `${label}.operation`);
  add(errors, actual.operation === selectedOperation, `${label}.operation does not match the selected preflight operation`);
  requireDigest(errors, actual.rawSha256, `${label}.rawSha256`);
  requireDigest(errors, actual.payloadSha256, `${label}.payloadSha256`);
  requireString(errors, actual.canonicalization, `${label}.canonicalization`);
  add(errors, actual.canonicalization === 'sorted object keys, array order preserved, UTF-8 JSON without trailing newline', `${label}.canonicalization is not the pinned canonicalization`);
  if (!requireObject(errors, actual.payload, `${label}.payload`)) return;
  const payload = actual.payload;
  for (const stream of ['phoenix', 'native', 'wire']) {
    requireObject(errors, payload[stream], `${label}.payload.${stream}`);
    add(errors, payload[stream]?.operation === selectedOperation, `${label}.payload.${stream}.operation does not match the selected preflight operation`);
    requireDigest(errors, actual[`${stream}CanonicalSha256`], `${label}.${stream}CanonicalSha256`);
    if (payload[stream] !== undefined) add(errors, actual[`${stream}CanonicalSha256`] === canonicalSha256(payload[stream]), `${label}.${stream}CanonicalSha256 does not match payload`);
    if (payload[stream]?.projection !== undefined) {
      add(errors, same(payload[stream].projection, actual.projection), `${label}.payload.${stream}.projection differs from action projection`);
    } else errors.push(`${label}.payload.${stream}.projection is missing`);
  }
  add(errors, actual.nativeEqualsPhoenix === true, `${label}.nativeEqualsPhoenix must be true`);
  add(errors, actual.wireEqualsNative === true, `${label}.wireEqualsNative must be true`);
  add(errors, actual.phoenixMatchesMatrix === true, `${label}.phoenixMatchesMatrix must be true`);
}

function validateLogsAndCorrelation(actual, errors, label) {
  if (!requireObject(errors, actual.correlation, `${label}.correlation`)) return;
  const correlation = actual.correlation;
  requireString(errors, correlation.ackRequestID, `${label}.correlation.ackRequestID`);
  requireString(errors, correlation.transID, `${label}.correlation.transID`);
  add(errors, correlation.ackRequestID === correlation.transID, `${label}.correlation ackRequestID/transID mismatch`);
  requireString(errors, correlation.connectionId, `${label}.correlation.connectionId`);
  requireString(errors, correlation.nativeActionEventId, `${label}.correlation.nativeActionEventId`);
  requireString(errors, correlation.wireActionMessageId, `${label}.correlation.wireActionMessageId`);
  if (!requireObject(errors, actual.logs, `${label}.logs`)) return;
  const { native, wire } = actual.logs;
  if (requireObject(errors, native, `${label}.logs.native`)) {
    add(errors, Number.isInteger(native.eventCount) && native.eventCount > 0, `${label}.logs.native.eventCount must be positive`);
    add(errors, Number.isInteger(native.actionEventIndex) && native.actionEventIndex >= 0 && native.actionEventIndex < native.eventCount, `${label}.logs.native.actionEventIndex is out of range`);
    add(errors, Number.isInteger(native.idleEventIndex) && native.idleEventIndex >= 0 && native.idleEventIndex < native.eventCount, `${label}.logs.native.idleEventIndex is out of range`);
    add(errors, native.actionEventId === correlation.nativeActionEventId, `${label}.logs.native.actionEventId does not correlate`);
  }
  if (requireObject(errors, wire, `${label}.logs.wire`)) {
    add(errors, Number.isInteger(wire.messageCount) && wire.messageCount > 0, `${label}.logs.wire.messageCount must be positive`);
    add(errors, Number.isInteger(wire.actionMessageIndex) && wire.actionMessageIndex >= 0 && wire.actionMessageIndex < wire.messageCount, `${label}.logs.wire.actionMessageIndex is out of range`);
    add(errors, Number.isInteger(wire.ackMessageIndex) && wire.ackMessageIndex >= 0 && wire.ackMessageIndex < wire.messageCount, `${label}.logs.wire.ackMessageIndex is out of range`);
    add(errors, wire.actionMessageId === correlation.wireActionMessageId, `${label}.logs.wire.actionMessageId does not correlate`);
    requireString(errors, wire.connectionId, `${label}.logs.wire.connectionId`);
    add(errors, wire.connectionId === correlation.connectionId, `${label}.logs.wire.connectionId does not correlate`);
  }
  if (requireObject(errors, actual.traceRange, `${label}.traceRange`)) {
    add(errors, Number.isInteger(actual.traceRange.start) && actual.traceRange.start >= 0, `${label}.traceRange.start must be a non-negative integer`);
    add(errors, Number.isInteger(actual.traceRange.end) && actual.traceRange.end >= actual.traceRange.start, `${label}.traceRange.end must follow start`);
  }
}

function validateTimeline(descriptor, actual, errors, label) {
  if (!requireObject(errors, actual.timeline, `${label}.timeline`)) return;
  const timeline = actual.timeline;
  const contracts = expectedViewContracts(descriptor);
  if (!Array.isArray(timeline.views)) {
    errors.push(`${label}.timeline.views must be an array`);
  } else {
    add(errors, timeline.views.length === contracts.length, `${label}.timeline.views count differs from expected view count`);
    contracts.forEach((contract, index) => {
      const item = timeline.views[index];
      if (!requireObject(errors, item, `${label}.timeline.views[${index}]`)) return;
      add(errors, item.ordinal === contract.ordinal, `${label}.timeline.views[${index}].ordinal is out of order`);
      add(errors, item.viewId === contract.id, `${label}.timeline.views[${index}].viewId is out of order`);
      add(errors, isFiniteNumber(item.openedMs) && isFiniteNumber(item.closedMs), `${label}.timeline.views[${index}] must contain numeric open/close times`);
      add(errors, item.openedMs < item.closedMs, `${label}.timeline.views[${index}] must close after opening`);
    });
  }
  if (requireObject(errors, timeline.idle, `${label}.timeline.idle`)) {
    const idle = timeline.idle;
    add(errors, isFiniteNumber(idle.observedMs), `${label}.timeline.idle.observedMs must be numeric`);
    add(errors, idle.skill === '@be/idle', `${label}.timeline.idle.skill must be @be/idle`);
    add(errors, idle.view === 'eyeView', `${label}.timeline.idle.view must be eyeView`);
    add(errors, idle.listener === 'Idle', `${label}.timeline.idle.listener must be Idle`);
    add(errors, idle.ttsTalking === false, `${label}.timeline.idle.ttsTalking must be false`);
    add(errors, idle.finalState === 'idle', `${label}.timeline.idle.finalState must be idle`);
    add(errors, idle.observersRestored === true, `${label}.timeline.idle.observersRestored must be true`);
    if (Array.isArray(timeline.views)) timeline.views.forEach((item, index) => add(errors, isFiniteNumber(item.closedMs) && item.closedMs < idle.observedMs, `${label}.timeline.views[${index}] closed after idle`));
  }
  add(errors, timeline.transitionToIdle === true, `${label}.timeline.transitionToIdle must be true`);
}

function validateScreenshots(descriptor, actual, root, errors, label) {
  const expected = expectedViewContracts(descriptor);
  if (!Array.isArray(actual.screenshots)) {
    errors.push(`${label}.screenshots must be an array`);
    return;
  }
  add(errors, actual.screenshots.length === expected.length, `${label}.screenshots count differs from expected view count`);
  const ordinals = new Set();
  actual.screenshots.forEach((shot, index) => {
    if (!requireObject(errors, shot, `${label}.screenshots[${index}]`)) return;
    const contract = expected[index];
    add(errors, shot.ordinal === contract?.ordinal, `${label}.screenshots[${index}].ordinal is out of order`);
    add(errors, shot.viewId === contract?.id, `${label}.screenshots[${index}].viewId is out of order`);
    if (ordinals.has(shot.ordinal)) errors.push(`${label}.screenshots duplicate ordinal ${shot.ordinal}`);
    ordinals.add(shot.ordinal);
    add(errors, shot.stableForMs >= 500, `${label}.screenshots[${index}] was not stable for at least 500ms`);
    add(errors, shot.visuallyInspected === true, `${label}.screenshots[${index}] was not visually inspected`);
    validateArtifactRef(shot, root, errors, `${label}.screenshots[${index}]`);
  });
}

function validateArtifacts(actual, root, errors, label) {
  if (!requireObject(errors, actual.artifacts, `${label}.artifacts`)) return;
  const refs = {};
  for (const name of ['stackReceipt', 'nativeReport', 'wireTrace', 'providerTrace', 'actionPayload']) {
    refs[name] = validateArtifactRef(actual.artifacts[name], root, errors, `${label}.artifacts.${name}`);
  }
  return refs;
}

function validateActionArtifact(actual, refs, errors, label) {
  const bytes = refs?.actionPayload?.bytes;
  if (!bytes) return;
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
    errors.push(`${label}.artifacts.actionPayload must contain JSON: ${error.message}`);
    return;
  }
  add(errors, same(parsed, actual.action?.payload), `${label}.artifacts.actionPayload does not bind actual.action.payload`);
}

function validatePhysicalRow(descriptor, row, runtime, root, errors, allowedRequest, preflight) {
  const label = `case ${descriptor.id}`;
  add(errors, row.status === 'pass', `${label} status must be pass`);
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  if (!requireObject(errors, row.actual, `${label}.actual`)) return;
  validateRequest(descriptor, { ...row.actual.request, runtimeLocalDateISO: runtime.localDateISO }, errors, `${label}.actual.request`, allowedRequest, preflight);
  validateProvider(descriptor, { ...row.actual.provider, runtimeLocalDateISO: runtime.localDateISO, calendarDateISO: row.actual.request?.calendarDateISO }, errors, `${label}.actual.provider`);
  validateAction(descriptor, row.actual.action, errors, `${label}.actual.action`, row.actual, allowedRequest?.operation);
  validateLogsAndCorrelation(row.actual, errors, label);
  validateTimeline(descriptor, row.actual, errors, label);
  validateScreenshots(descriptor, row.actual, root, errors, label);
  const artifactRefs = validateArtifacts(row.actual, root, errors, label);
  validateActionArtifact(row.actual, artifactRefs, errors, label);
  add(errors, row.actual.observersRestored === true, `${label}.actual.observersRestored must be true`);
  add(errors, row.actual.noBypass === true, `${label}.actual.noBypass must be true`);
}

function validateNoViewRow(descriptor, row, errors) {
  const label = `case ${descriptor.id}`;
  add(errors, row.status === 'asserted', `${label} status must be asserted`);
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  if (!requireObject(errors, row.actual, `${label}.actual`)) return;
  validateReference(descriptor.reference, row.actual.sourceReceipt, errors, `${label}.actual.sourceReceipt`);
  add(errors, row.actual.viewIds && Array.isArray(row.actual.viewIds) && row.actual.viewIds.length === 0, `${label}.actual.viewIds must be empty`);
  add(errors, Array.isArray(row.actual.screenshots) && row.actual.screenshots.length === 0, `${label}.actual.screenshots must be empty`);
  add(errors, row.actual.transitionToIdle === true, `${label}.actual.transitionToIdle must be true`);
  if (requireObject(errors, row.actual.action, `${label}.actual.action`)) {
    add(errors, same(row.actual.action.mimIds, expectedMimIds(descriptor)), `${label}.actual.action.mimIds differ from linked receipt assertion`);
    add(errors, same(row.actual.action.viewIds, []), `${label}.actual.action.viewIds must be empty`);
    requireDigest(errors, row.actual.action.receiptSha256, `${label}.actual.action.receiptSha256`);
    add(errors, row.actual.action.receiptSha256 === descriptor.reference.sha256, `${label}.actual.action.receiptSha256 must bind the linked receipt`);
  }
}

function validateBlockedRow(descriptor, row, errors) {
  const label = `case ${descriptor.id}`;
  add(errors, row.status === 'blocked', `${label} cannot be claimed pass; it must remain blocked`);
  add(errors, row.blockedReason === descriptor.blocked?.reason, `${label}.blockedReason does not preserve the missing source asset decision`);
  if (requireObject(errors, row.actual, `${label}.actual`)) {
    add(errors, Array.isArray(row.actual.viewIds) && row.actual.viewIds.length === 0, `${label}.actual.viewIds must be empty while blocked`);
    add(errors, Array.isArray(row.actual.screenshots) && row.actual.screenshots.length === 0, `${label}.actual.screenshots must be empty while blocked`);
  }
  add(errors, row.claimed === false, `${label}.claimed must be false`);
}

function validateFalsification(receipt, matrix, errors) {
  if (!requireObject(errors, receipt.falsification, 'receipt.falsification')) return;
  const falsification = receipt.falsification;
  add(errors, falsification.result === 'pass', 'receipt.falsification.result must be pass');
  add(errors, Array.isArray(falsification.controls), 'receipt.falsification.controls must be an array');
  if (!Array.isArray(falsification.controls)) return;
  const ids = falsification.controls.map((control) => control?.id);
  add(errors, same(ids, matrix.falsificationControls), 'receipt falsification controls are incomplete or reordered');
  const controlProjection = [];
  falsification.controls.forEach((control, index) => {
    if (!requireObject(errors, control, `receipt.falsification.controls[${index}]`)) return;
    add(errors, control.id === matrix.falsificationControls[index], `receipt.falsification.controls[${index}].id is out of order`);
    add(errors, control.status === 'rejected', `receipt.falsification.controls[${index}] must record a rejected mutation`);
    add(errors, Number.isInteger(control.exitCode) && control.exitCode > 0, `receipt.falsification.controls[${index}].exitCode must be non-zero`);
    requireString(errors, control.evidence, `receipt.falsification.controls[${index}].evidence`);
    controlProjection.push({ id: control.id, status: control.status, exitCode: control.exitCode, evidence: control.evidence });
  });
  requireDigest(errors, falsification.controlsSha256, 'receipt.falsification.controlsSha256');
  add(errors, falsification.controlsSha256 === canonicalSha256(controlProjection), 'receipt.falsification.controlsSha256 does not match controls');
}

export function validateReceipt(receipt, matrix, { root = process.cwd() } = {}) {
  const matrixReport = validateMatrix(matrix);
  const errors = [...matrixReport.errors];
  if (!requireObject(errors, receipt, 'receipt')) return { result: 'fail', errors, matrix: matrixReport };
  add(errors, receipt.schema === RECEIPT_SCHEMA, 'receipt.schema is not the S-13 physical receipt schema');
  add(errors, receipt.schemaVersion === RECEIPT_VERSION, 'receipt.schemaVersion must be 1');
  add(errors, receipt.task === 'S-13', 'receipt.task must be S-13');
  add(errors, receipt.claim === 'physical-display-only', 'receipt.claim must be physical-display-only');
  add(errors, ['verified_bounded', 'blocked'].includes(receipt.decision), 'receipt.decision must be verified_bounded or blocked');
  add(errors, ['open', 'closed'].includes(receipt.taskStatus), 'receipt.taskStatus must be open or closed');
  validateRuntime(receipt, errors);
  validateProvenance(receipt, matrix, errors);
  validateMatrixBinding(receipt, matrix, errors);
  const preflight = receipt.preflight;
  const allowedRequest = validatePreflight(receipt, matrix, errors);
  validateFalsification(receipt, matrix, errors);

  const descriptors = Array.isArray(matrix.cases) ? matrix.cases : [];
  if (!Array.isArray(receipt.cases)) {
    errors.push('receipt.cases must be an array');
  } else {
    add(errors, receipt.cases.length === descriptors.length, `receipt must contain exactly ${descriptors.length} ordered case rows`);
    const seen = new Set();
    descriptors.forEach((descriptor, index) => {
      const row = receipt.cases[index];
      const label = `receipt.cases[${index}]`;
      if (!requireObject(errors, row, label)) return;
      add(errors, row.ordinal === descriptor.ordinal, `${label}.ordinal does not match matrix`);
      add(errors, row.id === descriptor.id, `${label}.id/order does not match matrix`);
      if (seen.has(row.id)) errors.push(`receipt duplicate case id: ${row.id}`);
      seen.add(row.id);
      if (descriptor.kind === 'no-view') validateNoViewRow(descriptor, row, errors);
      else if (descriptor.kind === 'blocked') validateBlockedRow(descriptor, row, errors);
      else validatePhysicalRow(descriptor, row, receipt.runtime || {}, root, errors, allowedRequest, preflight);
    });
  }

  const blockedCount = descriptors.filter((item) => item.kind === 'blocked').length;
  if (blockedCount > 0) {
    add(errors, receipt.decision === 'blocked', 'a matrix-blocked case requires receipt.decision=blocked');
    add(errors, receipt.taskStatus === 'open', 'a matrix-blocked case requires receipt.taskStatus=open');
    add(errors, receipt.complete === false, 'a matrix-blocked case cannot set receipt.complete=true');
  } else {
    add(errors, receipt.decision === 'verified_bounded', 'a complete matrix requires receipt.decision=verified_bounded');
    add(errors, receipt.taskStatus === 'closed', 'a complete matrix requires receipt.taskStatus=closed');
    add(errors, receipt.complete === true, 'a complete matrix requires receipt.complete=true');
  }

  return {
    result: errors.length ? 'fail' : 'pass',
    errors,
    matrix: matrixReport,
    checkedCases: Array.isArray(receipt.cases) ? receipt.cases.length : 0,
    blockedCases: blockedCount
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { matrix: DEFAULT_MATRIX_PATH, receipt: null, root: process.cwd(), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--matrix') args.matrix = path.resolve(argv[++i]);
    else if (arg === '--root') args.root = path.resolve(argv[++i]);
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: node scripts/parity-s13-physical/validate.mjs [--matrix PATH] [--root DIR] [--out PATH] RECEIPT.json');
      return null;
    } else if (!args.receipt) args.receipt = path.resolve(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.receipt) throw new Error('a receipt JSON path is required');
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) return 0;
  let report;
  try {
    const matrix = readJson(args.matrix);
    const receipt = readJson(args.receipt);
    report = validateReceipt(receipt, matrix, { root: args.root });
  } catch (error) {
    report = { result: 'fail', errors: [`cannot read or validate input: ${error.message}`] };
  }
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ result: report.result, errors: report.errors?.length || 0, checkedCases: report.checkedCases || 0 }));
  return report.result === 'pass' ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = main();
