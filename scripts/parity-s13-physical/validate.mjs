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
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MATRIX_PATH = path.join(here, 'matrix.json');
export const RECEIPT_SCHEMA = 'phoenix.parity.s13.physical-capture-receipt';
export const RECEIPT_VERSION = 1;
export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const REVISION_RE = /^[0-9a-f]{40}$/;
export const EXTERNAL_ANCHORS_SCHEMA = 'phoenix.parity.s13.external-validation-anchors.v1';

// These values are deliberately duplicated in code.  Updating matrix.json and
// its self-reported digest cannot silently redefine the acceptance contract.
export const IMMUTABLE = Object.freeze({
  matrixSha256: 'd7784113ca8cdf5903645c60d8bb04a4704c6af9302a9184e304657ba784e5bc',
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
    'falsification-control-omission',
    'screenshot-identity-swap',
    'png-chunk-corruption',
    'local-turn-body-contract-mutation',
    'pm-availability-contradiction',
    'revalidation-date-mutation',
    'native-request-omission',
    'wire-request-omission',
    'ack-payload-mutation',
    'timeline-order-mutation',
    'falsification-execution-metadata-mutation',
    'provenance-anchor-mutation',
    'context-anchor-omission'
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

/**
 * Return the value an independent reviewer must anchor before accepting
 * runtime provenance.  The receipt repeats these values, so this digest is
 * deliberately computed over the complete provenance object and its duplicate
 * top-level Phoenix revision.  A digest supplied by the receipt itself is not
 * a trust anchor; callers must provide this value out of band.
 */
export function provenanceAnchorProjection(receipt) {
  const captureBindings = (receipt?.cases || []).map((row) => ({
    id: row?.id,
    status: row?.status,
    artifacts: Object.fromEntries(Object.entries(row?.actual?.artifacts || {}).map(([name, ref]) => [name, {
      path: ref?.path,
      sha256: ref?.sha256,
      bytes: ref?.bytes
    }])),
    screenshots: (row?.actual?.screenshots || []).map((shot) => ({
      path: shot?.path,
      sha256: shot?.sha256,
      pixelSha256: shot?.pixelSha256,
      artifactIdentity: shot?.artifactIdentity,
      captureKey: shot?.captureKey
    }))
  }));
  return {
    phoenixRevision: receipt?.phoenixRevision,
    provenance: receipt?.provenance,
    captureBindings
  };
}

export function provenanceAnchorSha256(receipt) {
  return canonicalSha256(provenanceAnchorProjection(receipt));
}

/**
 * Falsifier evidence contains its own self-checking digest.  Exclude that
 * digest from the projection to avoid a circular hash, while retaining every
 * control, execution, and artifact binding that the reviewer approved.
 */
export function falsificationAnchorProjection(falsification) {
  if (!falsification || typeof falsification !== 'object' || Array.isArray(falsification)) return falsification;
  const projection = { ...falsification };
  delete projection.receiptSha256;
  delete projection.falsifierReceiptSha256;
  return projection;
}

export function falsificationAnchorSha256(falsification) {
  return canonicalSha256(falsificationAnchorProjection(falsification));
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

function localDateForTimestamp(timestamp, timezone) {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
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
  add(errors, matrix.clockPolicy?.calendarDate === 'receipt.runtime.localDateISO plus one local civil day; fixture event dates must use that resolved local date', 'matrix calendar fixtures must resolve to local date plus one civil day');
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
    if (request.operation === 'startLocalTurn') {
      add(errors, request.bodyContract?.exact === true, 'matrix startLocalTurn bodyContract must be exact');
      add(errors, same(request.bodyContract?.nluRules, ['launch']), 'matrix startLocalTurn nluRules must be exactly ["launch"]');
      add(errors, request.bodyContract?.sosTimeout === 5, 'matrix startLocalTurn sosTimeout must be 5');
      add(errors, request.bodyContract?.maxSpeechTimeout === 12, 'matrix startLocalTurn maxSpeechTimeout must be 12');
    }
    allowedOperations.add(request.operation);
  }
  add(errors, allowedOperations.has('mimicGlobalTurn') || allowedOperations.has('startLocalTurn'), 'matrix must allow a known original SDK local/global turn operation');
  add(errors, matrix.physicalProtocol?.preflight?.required === true, 'matrix requires an operation/context preflight');
  add(errors, matrix.physicalProtocol?.preflight?.contextSourceMustBeExplicit === true, 'matrix preflight must require explicit context provenance');
  add(errors, Array.isArray(matrix.physicalProtocol?.preflight?.contextFields), 'matrix preflight context fields are missing');
  add(errors, matrix.physicalProtocol?.request?.microphoneAcceptance === false, 'matrix must explicitly disable microphone acceptance for text injection');
  add(errors, Array.isArray(matrix.physicalProtocol?.requiredArtifactKinds) && matrix.physicalProtocol.requiredArtifactKinds.includes('provider-fixture'), 'matrix must require a private provider-fixture artifact');
  add(errors, Array.isArray(matrix.physicalProtocol?.requiredArtifactKinds) && matrix.physicalProtocol.requiredArtifactKinds.includes('context-anchor'), 'matrix must require a standalone context/timezone anchor artifact');
  add(errors, Array.isArray(matrix.physicalProtocol?.requiredArtifactKinds) && matrix.physicalProtocol.requiredArtifactKinds.includes('visual-review'), 'matrix must require an external visual-review artifact for screenshots');
  add(errors, matrix.physicalProtocol?.receiptHashing?.algorithm === 'sha256', 'matrix artifact hashing must use SHA-256');
  add(errors, matrix.physicalProtocol?.receiptHashing?.screenshotIdentity === 'ordinal+viewId; duplicate view IDs are separate captures and must not be deduplicated', 'matrix screenshot identity must preserve duplicate view ordinals');
  add(errors, Array.isArray(matrix.falsificationControls) && same(matrix.falsificationControls, IMMUTABLE.controlIds), 'matrix falsification controls are missing, reordered, or changed');
  if (requireObject(errors, matrix.fixtureBoundary, 'matrix.fixtureBoundary')) {
    add(errors, matrix.fixtureBoundary.name === 'already-converted-prefs-and-provider-injection', 'matrix.fixtureBoundary.name is not the bounded fixture contract');
    add(errors, Array.isArray(matrix.fixtureBoundary.separatedProof) && matrix.fixtureBoundary.separatedProof.length === 2, 'matrix.fixtureBoundary must name the S-11 and S-12 separated proofs');
    requireString(errors, matrix.fixtureBoundary.scope, 'matrix.fixtureBoundary.scope');
    requireString(errors, matrix.fixtureBoundary.implication, 'matrix.fixtureBoundary.implication');
  }

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
      if (descriptor.id === 'commute-pm-departure-combined') {
        if (requireObject(errors, descriptor.captureCondition, `matrix case ${descriptor.id}.captureCondition`)) {
          add(errors, descriptor.captureCondition.key === 'pmDepartureAvailable', `matrix case ${descriptor.id} must use the pmDepartureAvailable condition`);
          add(errors, descriptor.captureCondition.source === 'S-11 61-row source lane owns AM/PM coverage', `matrix case ${descriptor.id} must identify the S-11 source lane boundary`);
          requireString(errors, descriptor.captureCondition.when, `matrix case ${descriptor.id}.captureCondition.when`);
        }
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
      if (descriptor.id === 'calendar-four-card-field-matrix') {
        add(errors, descriptor.reference?.caseId === 'full-report-event-tomorrow', 'calendar four-card source case must be the tomorrow fixture');
        add(errors, descriptor.input?.phrase === 'what is on my calendar tomorrow', 'calendar four-card phrase must request tomorrow');
        add(errors, typeof descriptor.input?.calendarFixture === 'string' && descriptor.input.calendarFixture.startsWith('tomorrow-'), 'calendar four-card fixture must be relative to tomorrow');
        add(errors, descriptor.expected?.mimIds?.[0] === 'CalendarEventCountTomorrow', 'calendar four-card count MIM must be CalendarEventCountTomorrow');
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

function pathIsWithin(rootPath, candidate) {
  return candidate === rootPath || candidate.startsWith(`${rootPath}${path.sep}`);
}

// Resolve every component with lstat before opening bytes.  A lexical
// `../` check alone is insufficient: a directory below the receipt root can
// be a symlink to an otherwise-valid path outside it.
function safeArtifactPath(root, filePath, errors, label) {
  if (!requireString(errors, filePath, `${label}.path`)) return null;
  if (filePath.split(path.sep).some((component) => component === '.' || component === '..')) {
    errors.push(`${label}.path must not contain dot path components`);
    return null;
  }
  if (path.isAbsolute(filePath)) {
    errors.push(`${label}.path must be relative to the receipt root`);
    return null;
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, filePath);
  if (!pathIsWithin(rootPath, resolved)) {
    errors.push(`${label}.path escapes the receipt root`);
    return null;
  }
  let rootStat;
  let realRoot;
  try {
    rootStat = fs.lstatSync(rootPath);
    if (rootStat.isSymbolicLink()) {
      errors.push(`${label}.root is a symlink`);
      return null;
    }
    if (!rootStat.isDirectory()) {
      errors.push(`${label}.root is not a directory`);
      return null;
    }
    realRoot = fs.realpathSync(rootPath);
    if (realRoot !== rootPath) {
      errors.push(`${label}.root has a symlinked ancestor`);
      return null;
    }
  } catch (error) {
    errors.push(`${label}.root cannot be resolved: ${error.code || error.message}`);
    return null;
  }

  const relative = path.relative(rootPath, resolved);
  const components = relative ? relative.split(path.sep) : [];
  let cursor = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      // Let validateArtifactRef report a precise missing/unreadable artifact.
      if (error.code === 'ENOENT') break;
      errors.push(`${label}.path cannot be inspected: ${error.code || error.message}`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`${label}.path contains symlink component ${path.relative(rootPath, cursor)}`);
      return null;
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      errors.push(`${label}.path ancestor is not a directory`);
      return null;
    }
  }

  try {
    const realResolved = fs.realpathSync(resolved);
    if (!pathIsWithin(realRoot, realResolved) || realResolved !== resolved) {
      errors.push(`${label}.path resolves outside the receipt root or through a symlink`);
      return null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`${label}.path realpath failed: ${error.code || error.message}`);
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
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      errors.push(`${label}.path is a symlink`);
      return null;
    }
    if (!stat.isFile()) {
      errors.push(`${label}.path is not a regular file`);
      return null;
    }
    const realResolved = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(path.resolve(root));
    if (realResolved !== resolved || !pathIsWithin(realRoot, realResolved)) {
      errors.push(`${label}.path resolves outside the receipt root`);
      return null;
    }
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

function parseJsonBytes(ref, errors, label) {
  if (!ref?.bytes) return null;
  try {
    const value = JSON.parse(ref.bytes.toString('utf8'));
    if (!isObject(value)) errors.push(`${label} must contain a JSON object`);
    return value;
  } catch (error) {
    errors.push(`${label} must contain JSON: ${error.message}`);
    return null;
  }
}

function parseJsonlBytes(ref, errors, label) {
  if (!ref?.bytes) return [];
  const text = ref.bytes.toString('utf8');
  if (!text.endsWith('\n')) errors.push(`${label} must end with a newline-delimited record`);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) errors.push(`${label} must contain at least one JSON record`);
  return lines.map((line, index) => {
    if (!line.trim()) {
      errors.push(`${label} line ${index} is empty`);
      return null;
    }
    try {
      const value = JSON.parse(line);
      if (!isObject(value)) errors.push(`${label} line ${index} must be a JSON object`);
      return value;
    } catch (error) {
      errors.push(`${label} line ${index} is not JSON: ${error.message}`);
      return null;
    }
  });
}

// Keep the exact UTF-8 bytes for a JSONL record.  `split(/\r?\n/)` is useful
// for parsing but loses the byte identity needed to prove that a context
// anchor names a real source line in the captured trace.
function jsonlLineBytes(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    lines.push(bytes.subarray(start, end));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function parseJsonlLineAt(ref, line, errors, label) {
  if (!ref?.bytes || !Number.isInteger(line) || line < 0) return null;
  const lines = jsonlLineBytes(ref.bytes);
  const bytes = lines[line];
  if (!bytes) {
    errors.push(`${label} sourceLine ${line} is outside the source JSONL artifact`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    errors.push(`${label} sourceLine ${line} is not JSON: ${error.message}`);
    return null;
  }
  if (!isObject(value)) {
    errors.push(`${label} sourceLine ${line} must contain a JSON object`);
    return null;
  }
  return { value, bytes, line };
}

function timestampMs(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return Date.parse(value);
}

function requireTimestamp(errors, value, label) {
  const parsed = timestampMs(value);
  add(errors, parsed !== null, `${label} must be an ISO timestamp`);
  return parsed;
}

function wireStageName(record) {
  const value = record?.stage ?? record?.stageId ?? record?.flowStage ?? record?.phase ?? record?.lane ?? record?.transportMode;
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'tg' || normalized.includes('global') || normalized.includes('prelude')) return 'Tg';
  if (normalized === 'tl' || normalized.includes('local') || normalized.includes('followup') || normalized.includes('follow-up')) return 'Tl';
  return null;
}

function wireFlowStages(actual) {
  const flow = actual?.wireFlow || actual?.flow;
  if (!isObject(flow)) return [];
  const stages = Array.isArray(flow.stages) ? flow.stages : [
    ...(isObject(flow.initial) ? [{ stage: 'Tg', ...flow.initial }] : []),
    ...(isObject(flow.followup) ? [{ stage: 'Tl', ...flow.followup }] : [])
  ];
  return stages.filter(isObject).map((stage) => ({ ...stage, stage: wireStageName(stage) || stage.stage || stage.id || stage.name }));
}

function wireFlowStage(actual, stageName) {
  return wireFlowStages(actual).find((stage) => wireStageName(stage) === stageName || stage.stage === stageName || stage.id === stageName || stage.name === stageName) || null;
}

function hasTwoStageFlow(actual) {
  const stages = wireFlowStages(actual);
  return stages.some((stage) => wireStageName(stage) === 'Tg') && stages.some((stage) => wireStageName(stage) === 'Tl');
}

function validateTraceIdentity(record, descriptor, actual, selectedOperation, errors, label, stream = '') {
  if (!requireObject(errors, record, label)) return null;
  const stage = stream === 'wire' ? wireFlowStage(actual, wireStageName(record)) : null;
  add(errors, record.caseId === descriptor.id, `${label}.caseId does not bind matrix case`);
  add(errors, record.requestID === (stage?.requestID ?? actual.correlation?.requestID), `${label}.requestID does not bind receipt correlation`);
  add(errors, record.transID === (stage?.transID ?? actual.correlation?.transID), `${label}.transID does not bind receipt correlation`);
  add(errors, record.operation === selectedOperation, `${label}.operation does not bind selected preflight`);
  return requireTimestamp(errors, record.timestampISO, `${label}.timestampISO`);
}

function expectedProviderProjection(descriptor, actual) {
  const provider = descriptor.provider || {};
  return {
    kind: provider.kind,
    ...(provider.fixture === undefined ? {} : { fixture: provider.fixture }),
    ...(provider.baseSeconds === undefined ? {} : { baseSeconds: provider.baseSeconds }),
    ...(provider.trafficSeconds === undefined ? {} : { trafficSeconds: provider.trafficSeconds }),
    ...(provider.parallel === undefined ? {} : { parallel: provider.parallel }),
    resolvedDateISO: actual.provider?.resolvedDateISO
  };
}

function validateProviderFixture(descriptor, actual, refs, root, errors, label) {
  const fixtureRef = refs?.providerFixture;
  if (!fixtureRef) return null;
  const fixture = parseJsonBytes(fixtureRef, errors, `${label}.artifacts.providerFixture`);
  if (!fixture) return null;
  add(errors, fixture.schema === 's13-private-provider-fixture-v1', `${label}.providerFixture.schema is invalid`);
  add(errors, fixture.caseId === descriptor.id, `${label}.providerFixture.caseId does not bind matrix case`);
  add(errors, fixture.domain === descriptor.domain, `${label}.providerFixture.domain does not bind matrix domain`);
  add(errors, fixture.resolvedDateISO === actual.provider?.resolvedDateISO, `${label}.providerFixture.resolvedDateISO does not bind provider date`);
  add(errors, fixtureRef.sha256 === actual.provider?.fixtureSha256, `${label}.provider.fixtureSha256 does not bind private fixture bytes`);
  const expectedFixture = descriptor.provider?.fixture ?? `${descriptor.provider?.kind}:${actual.provider?.resolvedDateISO}`;
  add(errors, fixture.fixture === expectedFixture, `${label}.providerFixture.fixture does not match matrix fixture`);
  add(errors, same(fixture.provider, expectedProviderProjection(descriptor, actual)), `${label}.providerFixture.provider does not match the matrix/provider projection`);
  if (descriptor.domain === 'calendar') {
    add(errors, same(fixture.events, descriptor.input?.events), `${label}.providerFixture.events do not match the ordered calendar fixture`);
    add(errors, fixture.calendarDateISO === actual.request?.calendarDateISO, `${label}.providerFixture.calendarDateISO does not bind request date`);
  }
  if (fixture.sourceFixture !== undefined) {
    if (requireObject(errors, fixture.sourceFixture, `${label}.providerFixture.sourceFixture`)) {
      add(errors, fixture.sourceFixture.path === actual.artifacts?.rawFixture?.path, `${label}.providerFixture.sourceFixture.path does not bind raw fixture artifact`);
      add(errors, fixture.sourceFixture.sha256 === actual.artifacts?.rawFixture?.sha256, `${label}.providerFixture.sourceFixture.sha256 does not bind raw fixture artifact`);
      if (actual.artifacts?.rawFixture) add(errors, fixture.sourceFixture.sha256 === actual.artifacts.rawFixture.sha256, `${label}.providerFixture.sourceFixture bytes do not bind raw fixture artifact`);
    }
  }
  return fixture;
}

/*
 * The v2 fixture is a projection of the captured robot fixture.  Its calendar
 * events therefore have to be compared with the selected raw case, rather
 * than with the matrix's synthetic input.  The matrix still pins the case
 * identity, provider kind, and fixture alias; the raw bytes own the event
 * values used by this capture.
 */
function v2RawFixtureEvents(fixtureCase, errors, label) {
  const timestampRows = fixtureCase?.meta?.eventTimestamps;
  if (!Array.isArray(timestampRows)) {
    errors.push(`${label}.meta.eventTimestamps must be an array`);
    return [];
  }
  const calendar = fixtureCase?.calendar;
  if (!isObject(calendar)) {
    errors.push(`${label}.calendar must be an object`);
    return [];
  }
  const lookup = (service, calendarName, index) => {
    const source = calendar?.[service]?.[calendarName];
    const items = Array.isArray(source?.items) ? source.items : Array.isArray(source?.value) ? source.value : [];
    return items[index];
  };
  const expectedTimestampRows = [];
  for (const service of ['google', 'outlook']) {
    for (const calendarName of ['personalCalendar', 'workCalendar']) {
      const source = calendar?.[service]?.[calendarName];
      const items = Array.isArray(source?.items) ? source.items : Array.isArray(source?.value) ? source.value : [];
      items.forEach((item, index) => {
        const start = item?.start || {};
        const end = item?.end || {};
        const startValue = service === 'google' ? (start.dateTime || start.date) : start.dateTime;
        const endValue = service === 'google' ? (end.dateTime || end.date) : end.dateTime;
        const row = { service, calendar: calendarName, index, start: startValue };
        if (endValue !== undefined) row.end = endValue;
        expectedTimestampRows.push(row);
      });
    }
  }
  add(errors, same(timestampRows, expectedTimestampRows), `${label}.meta.eventTimestamps do not bind raw calendar event bytes`);
  const localTime = (dateTime) => {
    if (typeof dateTime !== 'string') return null;
    const match = dateTime.match(/T(\d{2}):(\d{2})/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return { hour, minute, time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}` };
  };
  return timestampRows.map((row, index) => {
    const rowLabel = `${label}.meta.eventTimestamps[${index}]`;
    if (!requireObject(errors, row, rowLabel)) return null;
    requireString(errors, row.service, `${rowLabel}.service`);
    requireString(errors, row.calendar, `${rowLabel}.calendar`);
    add(errors, Number.isInteger(row.index) && row.index >= 0, `${rowLabel}.index must be a non-negative integer`);
    const item = lookup(row.service, row.calendar, row.index);
    if (!requireObject(errors, item, `${rowLabel} source event`)) return null;
    const start = item.start || {};
    const allDay = typeof start.date === 'string' || item.isAllDay === true;
    const rawDate = start.date || start.dateTime;
    const date = typeof rawDate === 'string' ? rawDate.slice(0, 10) : null;
    const clock = allDay ? null : localTime(start.dateTime);
    add(errors, typeof row.start === 'string' && row.start === rawDate, `${rowLabel}.start does not bind source event`);
    if (row.end !== undefined) {
      const end = item.end || {};
      const rawEnd = end.date || end.dateTime;
      add(errors, typeof row.end === 'string' && row.end === rawEnd, `${rowLabel}.end does not bind source event`);
    }
    add(errors, typeof (item.summary || item.subject) === 'string', `${rowLabel} source event summary is missing`);
    return {
      summary: item.summary || item.subject,
      hour: clock?.hour ?? 0,
      minute: clock?.minute ?? 0,
      time: clock?.time ?? null,
      fullDay: allDay,
      date
    };
  }).filter(Boolean).map(({ date, ...event }) => event);
}

function v2ValidateProviderFixture(descriptor, actual, refs, errors, label) {
  const fixture = parseJsonBytes(refs?.providerFixture, errors, `${label}.artifacts.providerFixture`);
  const rawFixture = parseJsonBytes(refs?.rawFixture, errors, `${label}.artifacts.rawFixture`);
  if (!fixture || !rawFixture) return { fixture, rawFixture, sourceCase: null, sourceCaseKey: null };
  add(errors, fixture.schema === 's13-private-provider-fixture-v1', `${label}.providerFixture.schema is invalid`);
  add(errors, fixture.caseId === descriptor.id, `${label}.providerFixture.caseId does not bind matrix case`);
  add(errors, fixture.domain === descriptor.domain, `${label}.providerFixture.domain does not bind matrix domain`);
  add(errors, fixture.resolvedDateISO === actual.provider?.resolvedDateISO, `${label}.providerFixture.resolvedDateISO does not bind provider date`);
  add(errors, refs.providerFixture.sha256 === actual.provider?.fixtureSha256, `${label}.provider.fixtureSha256 does not bind private fixture bytes`);
  const expectedFixture = descriptor.provider?.fixture ?? `${descriptor.provider?.kind}:${actual.provider?.resolvedDateISO}`;
  add(errors, fixture.fixture === expectedFixture, `${label}.providerFixture.fixture does not match matrix fixture`);
  add(errors, same(fixture.provider, expectedProviderProjection(descriptor, actual)), `${label}.providerFixture.provider does not match the matrix/provider projection`);
  if (!requireObject(errors, fixture.sourceFixture, `${label}.providerFixture.sourceFixture`)) {
    return { fixture, rawFixture, sourceCase: null, sourceCaseKey: null };
  }
  const sourceCaseKey = fixture.sourceFixture.caseKey;
  requireString(errors, sourceCaseKey, `${label}.providerFixture.sourceFixture.caseKey`);
  add(errors, fixture.sourceFixture.path === refs.rawFixture?.path, `${label}.providerFixture.sourceFixture.path does not bind raw fixture artifact`);
  add(errors, fixture.sourceFixture.sha256 === refs.rawFixture?.sha256, `${label}.providerFixture.sourceFixture.sha256 does not bind raw fixture artifact`);
  add(errors, fixture.sourceFixture.sha256 === sha256Bytes(refs.rawFixture.bytes), `${label}.providerFixture.sourceFixture.sha256 does not bind raw fixture bytes`);
  add(errors, rawFixture.schema === 'phoenix-s13-robot-fixture-v1', `${label}.rawFixture.schema is invalid`);
  add(errors, rawFixture.caseId === sourceCaseKey, `${label}.rawFixture.caseId must equal providerFixture.sourceFixture.caseKey`);
  add(errors, isObject(rawFixture.cases) && Object.hasOwn(rawFixture.cases, sourceCaseKey), `${label}.rawFixture is missing providerFixture.sourceFixture.caseKey`);
  if (isObject(rawFixture.integrity)) {
    requireDigest(errors, rawFixture.integrity.casesSha256, `${label}.rawFixture.integrity.casesSha256`);
    add(errors, rawFixture.integrity.casesSha256 === canonicalSha256(rawFixture.cases), `${label}.rawFixture.integrity.casesSha256 does not match raw case bytes`);
  } else {
    errors.push(`${label}.rawFixture.integrity must be an object`);
  }
  const sourceCase = rawFixture.cases?.[sourceCaseKey];
  if (!requireObject(errors, sourceCase, `${label}.rawFixture.cases.${sourceCaseKey}`)) {
    return { fixture, rawFixture, sourceCase: null, sourceCaseKey };
  }
  const maps = sourceCase.maps?.routes?.[0]?.legs?.[0] || {};
  const sourceProvider = {
    kind: descriptor.provider?.kind,
    ...(descriptor.provider?.fixture === undefined ? {} : { fixture: descriptor.provider.fixture }),
    ...(descriptor.domain === 'commute' && Number.isFinite(maps.duration?.value) ? { baseSeconds: maps.duration.value } : {}),
    ...(descriptor.domain === 'commute' && Number.isFinite(maps.duration_in_traffic?.value) ? { trafficSeconds: maps.duration_in_traffic.value } : {}),
    ...(descriptor.provider?.parallel === undefined ? {} : { parallel: descriptor.provider.parallel }),
    resolvedDateISO: actual.provider?.resolvedDateISO
  };
  add(errors, same(fixture.provider, sourceProvider), `${label}.providerFixture.provider does not bind raw fixture map bytes`);
  add(errors, same(actual.provider, { ...sourceProvider, fixtureSha256: actual.provider?.fixtureSha256 }), `${label}.provider does not bind raw fixture map bytes`);
  if (descriptor.domain === 'calendar') {
    add(errors, fixture.calendarDateISO === actual.request?.calendarDateISO, `${label}.providerFixture.calendarDateISO does not bind request date`);
    const sourceDate = sourceCase.meta?.date;
    const sourceTimezone = sourceCase.meta?.timeZone || 'America/New_York';
    if (typeof sourceDate === 'string') {
      add(errors, sourceDate === actual.localDateISO, `${label}.rawFixture source date does not bind capture local date`);
      add(errors, addLocalDays(sourceDate, 1, sourceTimezone) === fixture.calendarDateISO, `${label}.providerFixture.calendarDateISO does not derive from raw fixture date`);
    } else errors.push(`${label}.rawFixture source case meta.date is missing`);
    const events = v2RawFixtureEvents(sourceCase, errors, `${label}.rawFixture.cases.${sourceCaseKey}`);
    add(errors, same(fixture.events, events), `${label}.providerFixture.events do not bind raw fixture event bytes`);
  } else {
    const sourceDate = sourceCase.meta?.date;
    add(errors, sourceDate === actual.localDateISO, `${label}.rawFixture source date does not bind capture local date`);
    if (descriptor.domain === 'commute' && actual.request?.prefsResolution?.generatedFrom === 'private-fixture-work-time') {
      const workTime = sourceCase.userPrefs?.commute?.workTime || sourceCase.meta?.workTime;
      const requestPrefs = actual.request?.prefs;
      const resolution = actual.request.prefsResolution;
      if (!requireObject(errors, workTime, `${label}.rawFixture.cases.${sourceCaseKey}.workTime`)) return { fixture, rawFixture, sourceCase, sourceCaseKey };
      add(errors, requestPrefs?.workDateISO === sourceCase.meta?.date, `${label}.request.prefs.workDateISO does not bind fixture date`);
      add(errors, requestPrefs?.workHour === workTime.hour, `${label}.request.prefs.workHour does not bind fixture work time`);
      add(errors, requestPrefs?.workMin === workTime.min, `${label}.request.prefs.workMin does not bind fixture work time`);
      const sourceFixture = resolution.sourceFixture;
      const fixtureSha256 = resolution.fixtureSha256 ?? sourceFixture?.sha256;
      add(errors, fixtureSha256 === refs.rawFixture.sha256, `${label}.request.prefsResolution fixture hash does not bind raw fixture`);
      const fixtureCase = resolution.fixtureCase ?? sourceFixture?.caseKey;
      add(errors, fixtureCase === sourceCaseKey, `${label}.request.prefsResolution fixture case does not bind raw fixture case`);
      if (sourceFixture !== undefined) {
        add(errors, sourceFixture.path === refs.rawFixture.path, `${label}.request.prefsResolution source fixture path does not bind raw fixture`);
        add(errors, sourceFixture.sha256 === refs.rawFixture.sha256, `${label}.request.prefsResolution source fixture hash does not bind raw fixture`);
      }
      if (resolution.workTime !== undefined) {
        add(errors, same(resolution.workTime, {
          dateISO: sourceCase.meta?.date,
          timeZone: sourceCase.meta?.timeZone,
          hour: workTime.hour,
          min: workTime.min
        }), `${label}.request.prefsResolution.workTime does not bind raw fixture work time`);
      }
      if (fixture.workTime !== undefined) {
        add(errors, fixture.workTime.source === 'private-fixture-work-time', `${label}.providerFixture.workTime.source must bind private fixture work time`);
        add(errors, fixture.workTime.dateISO === sourceCase.meta?.date, `${label}.providerFixture.workTime.dateISO does not bind fixture date`);
        add(errors, fixture.workTime.timeZone === sourceCase.meta?.timeZone, `${label}.providerFixture.workTime.timeZone does not bind fixture timezone`);
        add(errors, fixture.workTime.hour === workTime.hour, `${label}.providerFixture.workTime.hour does not bind fixture work time`);
        add(errors, fixture.workTime.min === workTime.min, `${label}.providerFixture.workTime.min does not bind fixture work time`);
      }
    }
  }
  return { fixture, rawFixture, sourceCase, sourceCaseKey };
}

function validateReference(expected, actual, errors, label) {
  if (!requireObject(errors, actual, label)) return;
  add(errors, actual.lane === expected?.lane, `${label}.lane does not match matrix`);
  add(errors, actual.caseId === expected?.caseId, `${label}.caseId does not match matrix`);
  add(errors, actual.path === expected?.path, `${label}.path does not match matrix`);
  add(errors, actual.sha256 === expected?.sha256, `${label}.sha256 does not match matrix`);
  requireDigest(errors, actual.sha256, `${label}.sha256`);
}

function validateProvenance(receipt, matrix, root, errors) {
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
  if (requireObject(errors, provenance.anchors, 'receipt.provenance.anchors')) {
    const anchorSpecs = [
      ['matrix', 'matrix.json'],
      ['validator', 'validate.mjs'],
      ['falsifier', 'falsify.mjs']
    ];
    for (const [name, filename] of anchorSpecs) {
      const ref = validateArtifactRef(provenance.anchors[name], root, errors, `receipt.provenance.anchors.${name}`);
      if (!ref) continue;
      if (name === 'matrix') {
        const parsed = parseJsonBytes(ref, errors, `receipt.provenance.anchors.${name}`);
        add(errors, parsed && same(parsed, matrix), 'receipt matrix provenance anchor does not bind the validated matrix bytes');
        if (parsed) add(errors, matrixSha256(parsed) === matrix.integrity?.matrixSha256, 'receipt matrix provenance anchor digest does not bind matrix integrity');
      } else {
        const localPath = path.join(here, filename);
        try {
          const localBytes = fs.readFileSync(localPath);
          add(errors, ref.sha256 === sha256Bytes(localBytes), `receipt ${name} provenance anchor does not bind the validator worktree bytes`);
        } catch (error) {
          errors.push(`receipt ${name} provenance anchor cannot be compared to the toolkit source: ${error.code || error.message}`);
        }
      }
    }
  }
  if (provenance.sourceRun !== undefined) {
    const sourceRunRef = validateArtifactRef(provenance.sourceRun, root, errors, 'receipt.provenance.sourceRun');
    if (sourceRunRef) {
      const sourceRun = parseJsonBytes(sourceRunRef, errors, 'receipt.provenance.sourceRun');
      if (sourceRun) {
        add(errors, sourceRun.schema === 'phoenix-s13-raw-run-manifest-v1', 'receipt raw run manifest schema is invalid');
        if (sourceRun.bundleManifest !== undefined) {
          const bundleManifestRef = validateArtifactRef(sourceRun.bundleManifest, root, errors, 'receipt raw run bundleManifest');
          const bundleManifest = bundleManifestRef ? parseJsonBytes(bundleManifestRef, errors, 'receipt raw run bundleManifest') : null;
          add(errors, ['phoenix-s13-bundle-manifest-v1', 'phoenix-s13-case-bundle-manifest-v1'].includes(bundleManifest?.schema), 'receipt raw run bundle manifest schema is invalid');
          if (bundleManifest && requireObject(errors, bundleManifest.cases, 'receipt raw run bundle manifest cases')) {
            const sourceBundleIds = isObject(sourceRun.bundles) ? Object.keys(sourceRun.bundles).sort() : [];
            add(errors, same(Object.keys(bundleManifest.cases).sort(), sourceBundleIds), 'receipt raw run bundle manifest cases do not bind source bundles');
            for (const [caseId, entry] of Object.entries(bundleManifest.cases)) {
              const sourceBundle = sourceRun.bundles?.[caseId];
              if (!sourceBundle) continue;
              const configuredDir = typeof entry === 'string' ? entry : entry?.bundle || entry?.dir || entry?.path;
              if (configuredDir) add(errors, path.resolve(sourceRun.runDirectory, configuredDir) === sourceBundle.directory, `receipt raw run bundle manifest ${caseId} directory does not bind source bundle`);
              if (entry && typeof entry === 'object' && entry.caseId !== undefined) add(errors, entry.caseId === sourceBundle.caseId, `receipt raw run bundle manifest ${caseId}.caseId does not bind source bundle`);
              const sourceNames = sourceBundle.sourceNames;
              if (requireObject(errors, sourceNames, `receipt raw run bundle ${caseId}.sourceNames`)) {
                for (const key of ['stack', 'fixture', 'wire', 'turn']) {
                  const configuredValue = entry && typeof entry === 'object' ? entry[key] : undefined;
                  if (configuredValue !== undefined) {
                    const configured = typeof configuredValue === 'string' ? configuredValue : configuredValue?.path;
                    const bundleDirectory = path.resolve(sourceBundle.directory);
                    const configuredName = typeof configured === 'string' ? path.relative(bundleDirectory, path.resolve(bundleDirectory, configured)) : null;
                    add(errors, configuredName === sourceNames[key], `receipt raw run bundle manifest ${caseId}.${key} does not bind source file`);
                  }
                }
                const configuredContextValue = entry && typeof entry === 'object' ? entry.context : undefined;
                if (configuredContextValue !== undefined) {
                  const configuredContext = typeof configuredContextValue === 'string' ? configuredContextValue : configuredContextValue?.path;
                  const bundleDirectory = path.resolve(sourceBundle.directory);
                  const configuredName = typeof configuredContext === 'string' ? path.relative(bundleDirectory, path.resolve(bundleDirectory, configuredContext)) : null;
                  add(errors, sourceNames.context === configuredName, `receipt raw run bundle manifest ${caseId}.context does not bind source file`);
                }
              }
            }
          }
        }
        if (requireObject(errors, sourceRun.fixtureBinding, 'receipt raw run fixtureBinding')) {
          add(errors, sourceRun.fixtureBinding.matches === true, 'receipt raw run fixture binding does not match immutable stack/fixture bytes');
          add(errors, Array.isArray(sourceRun.fixtureBinding.mismatches) && sourceRun.fixtureBinding.mismatches.length === 0, 'receipt raw run fixture binding contains mismatches');
        }
        for (const name of ['stack', 'fixture', 'wire']) validateArtifactRef(sourceRun[name], root, errors, `receipt raw run ${name}`);
        if (requireObject(errors, sourceRun.bundles, 'receipt raw run bundles')) {
          for (const [caseId, bundle] of Object.entries(sourceRun.bundles)) {
            if (!requireObject(errors, bundle, `receipt raw run bundle ${caseId}`)) continue;
            const stackRef = validateArtifactRef(bundle.stack, root, errors, `receipt raw run bundle ${caseId}.stack`);
            const fixtureRef = validateArtifactRef(bundle.fixture, root, errors, `receipt raw run bundle ${caseId}.fixture`);
            validateArtifactRef(bundle.wire, root, errors, `receipt raw run bundle ${caseId}.wire`);
            validateArtifactRef(bundle.turn, root, errors, `receipt raw run bundle ${caseId}.turn`);
            if (bundle.context !== undefined) validateArtifactRef(bundle.context, root, errors, `receipt raw run bundle ${caseId}.context`);
            if (stackRef && fixtureRef) {
              const stack = parseJsonBytes(stackRef, errors, `receipt raw run bundle ${caseId}.stack`);
              add(errors, stack?.fixture?.sha256 === fixtureRef.sha256, `receipt raw run bundle ${caseId} stack fixture hash does not bind fixture bytes`);
            }
          }
        }
      }
    }
  }
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
  add(errors, typeof runtime.captureISO === 'string' && /T/.test(runtime.captureISO), 'receipt.runtime.captureISO must include a time component');
  add(errors, /^\d{4}-\d{2}-\d{2}$/.test(runtime.localDateISO), 'receipt.runtime.localDateISO must be YYYY-MM-DD');
  add(errors, runtime.timezone === 'America/New_York', 'receipt.runtime.timezone must be America/New_York');
  add(errors, localDateForTimestamp(runtime.captureISO, runtime.timezone) === runtime.localDateISO, 'receipt.runtime.localDateISO must be derived from captureISO in the declared timezone');
  add(errors, runtime.fixtureGenerator === 'relative-to-local-date', 'receipt.runtime.fixtureGenerator must be relative-to-local-date');
  add(errors, runtime.wallClockBound === true, 'receipt.runtime.wallClockBound must be true');
  if (requireObject(errors, runtime.captureConditions, 'receipt.runtime.captureConditions')) {
    add(errors, typeof runtime.captureConditions.pmDepartureAvailable === 'boolean', 'receipt.runtime.captureConditions.pmDepartureAvailable must be boolean');
  }
}

function externalAnchorsFromOptions(options) {
  if (!isObject(options)) return null;
  const supplied = options.externalAnchors || options.validationAnchors || options.trustedAnchors;
  if (isObject(supplied)) return supplied;
  // Accept the direct shape as a small convenience for callers that already
  // keep validation options separate from the artifact root.  The CLI always
  // passes the named `externalAnchors` shape.
  if (options.visualReviewSha256 !== undefined || options.provenanceSha256 !== undefined || options.captureWindow !== undefined || options.falsifierReceiptSha256 !== undefined) return options;
  return null;
}

function visualReviewAnchorMap(anchors) {
  const value = anchors?.visualReviewSha256 ?? anchors?.visualReviewHashes ?? anchors?.visualReview;
  if (typeof value === 'string') return value;
  if (!isObject(value)) return value;
  // A v2 review is one externally anchored artifact for the whole capture.
  // Accept a named `global` member as well as the concise string form.
  if (typeof value.global === 'string') return value.global;
  if (typeof value.sha256 === 'string' && Object.keys(value).every((key) => key === 'sha256' || key === 'path')) return value.sha256;
  return value;
}

function captureWindowValue(anchors) {
  const value = anchors?.captureWindow ?? anchors?.capture;
  if (!isObject(value)) return value;
  return {
    startISO: value.startISO ?? value.start,
    endISO: value.endISO ?? value.end
  };
}

function falsifierAnchorValue(anchors) {
  return anchors?.falsifierReceiptSha256
    ?? anchors?.falsificationReceiptSha256
    ?? anchors?.falsifierSha256;
}

function globalVisualReviewRef(receipt) {
  const explicit = receipt?.visualReview || receipt?.artifacts?.visualReview || receipt?.provenance?.visualReview;
  if (isObject(explicit) && typeof explicit.path === 'string') return explicit;
  const refs = (receipt?.cases || [])
    .map((row) => row?.actual?.artifacts?.visualReview)
    .filter((ref) => isObject(ref) && typeof ref.path === 'string');
  if (!refs.length) return null;
  const first = refs[0];
  // A shared path/hash is the only receipt-level indication available before
  // opening the bytes. Per-case v1 review artifacts have distinct paths.
  return refs.every((ref) => ref.path === first.path && ref.sha256 === first.sha256) ? first : null;
}

// A receipt enters the v2 physical contract as soon as it advertises any of
// the raw capture evidence or the global visual review.  This deliberately
// does not infer v2 from a producer-controlled boolean: deleting a raw ref or
// a wire-flow object from an otherwise v2 receipt must still leave the row in
// the strict lane and produce a validation error.
function hasV2CaptureEvidence(receipt) {
  if (!isObject(receipt)) return false;
  if (globalVisualReviewRef(receipt)) return true;
  return (receipt.cases || []).some((row) => {
    const actual = row?.actual;
    return isObject(actual?.wireFlow)
      || isObject(actual?.flow)
      || isObject(actual?.artifacts) && ['rawTurn', 'rawWire', 'rawFixture'].some((name) => actual.artifacts[name] !== undefined);
  });
}

function validateExternalAnchors(receipt, matrix, options, errors) {
  const anchors = externalAnchorsFromOptions(options);
  if (!anchors) {
    errors.push('external validation anchors are required; pass { externalAnchors } from an independent review');
    return null;
  }
  if (anchors.schema !== undefined) add(errors, anchors.schema === EXTERNAL_ANCHORS_SCHEMA, 'external validation anchor schema is unsupported');

  const visualMap = visualReviewAnchorMap(anchors);
  const globalReview = globalVisualReviewRef(receipt);
  if (globalReview) {
    const globalDigest = typeof visualMap === 'string' ? visualMap : visualMap?.sha256;
    requireDigest(errors, globalDigest, 'externalAnchors.visualReviewSha256');
    requireDigest(errors, globalReview.sha256, 'receipt global visual-review.sha256');
    add(errors, globalDigest === globalReview.sha256, 'global visual-review artifact does not match the external review anchor');
  } else if (!requireObject(errors, visualMap, 'externalAnchors.visualReviewSha256')) return null;
  const expectedVisualCases = (matrix.cases || []).filter((descriptor, index) => {
    const row = receipt?.cases?.[index];
    return descriptor.kind === 'physical' && row?.status !== 'skipped';
  }).map((descriptor) => descriptor.id);
  if (!globalReview) {
    for (const caseId of Object.keys(visualMap)) {
      add(errors, expectedVisualCases.includes(caseId), `externalAnchors.visualReviewSha256 contains unexpected case ${caseId}`);
    }
    for (const caseId of expectedVisualCases) {
      const digest = visualMap[caseId];
      requireDigest(errors, digest, `externalAnchors.visualReviewSha256.${caseId}`);
      const row = receipt?.cases?.find((item) => item?.id === caseId);
      const actual = row?.actual?.artifacts?.visualReview?.sha256;
      add(errors, digest === actual, `case ${caseId} visual-review artifact does not match the external review anchor`);
    }
    add(errors, Object.keys(visualMap).length === expectedVisualCases.length, 'externalAnchors.visualReviewSha256 must name exactly one anchor for every captured physical case');
  }

  requireDigest(errors, anchors.provenanceSha256, 'externalAnchors.provenanceSha256');
  add(errors, anchors.provenanceSha256 === provenanceAnchorSha256(receipt), 'receipt provenance does not match the external provenance anchor');

  const window = captureWindowValue(anchors);
  if (!requireObject(errors, window, 'externalAnchors.captureWindow')) return null;
  const start = requireTimestamp(errors, window.startISO, 'externalAnchors.captureWindow.startISO');
  const end = requireTimestamp(errors, window.endISO, 'externalAnchors.captureWindow.endISO');
  if (start !== null && end !== null) add(errors, end >= start, 'externalAnchors.captureWindow.endISO must follow startISO');

  const falsifierSha256 = falsifierAnchorValue(anchors);
  requireDigest(errors, falsifierSha256, 'externalAnchors.falsifierReceiptSha256');
  add(errors, falsifierSha256 === falsificationAnchorSha256(receipt?.falsification), 'receipt falsification evidence does not match the external falsifier receipt anchor');

  return {
    visualReviewSha256: visualMap,
    globalVisualReview: globalReview,
    captureWindow: start !== null && end !== null ? { start, end } : null,
    provenanceSha256: anchors.provenanceSha256,
    falsifierReceiptSha256: falsifierSha256
  };
}

function validateCaptureWindowValue(value, window, errors, label) {
  if (!window) return;
  const parsed = timestampMs(value);
  add(errors, parsed !== null && parsed >= window.start && parsed <= window.end, `${label} falls outside the externally anchored capture window`);
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
  if (preflight.contextByCase !== undefined) {
    if (!requireObject(errors, preflight.contextByCase, 'receipt.preflight.contextByCase')) return allowed || null;
    for (const descriptor of matrix.cases || []) {
      const context = preflight.contextByCase[descriptor.id];
      if (!context) continue;
      if (!requireObject(errors, context, `receipt.preflight.contextByCase.${descriptor.id}`)) continue;
      requireString(errors, context.runtimeLocationISO, `receipt.preflight.contextByCase.${descriptor.id}.runtimeLocationISO`);
      requireString(errors, context.timezone, `receipt.preflight.contextByCase.${descriptor.id}.timezone`);
      add(errors, !Number.isNaN(Date.parse(context.runtimeLocationISO)), `receipt.preflight.contextByCase.${descriptor.id}.runtimeLocationISO must be an ISO timestamp`);
      add(errors, context.timezone === matrix.clockPolicy?.timezone, `receipt.preflight.contextByCase.${descriptor.id}.timezone does not match matrix`);
      requireDigest(errors, context.contextSha256, `receipt.preflight.contextByCase.${descriptor.id}.contextSha256`);
      add(errors, context.contextSha256 === canonicalSha256({ runtimeLocationISO: context.runtimeLocationISO, timezone: context.timezone }), `receipt.preflight.contextByCase.${descriptor.id}.contextSha256 does not match context`);
    }
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
  if (!isObject(actual.body)) {
    errors.push(`${label}.body must be an object`);
    return;
  }
  if (allowedRequest?.bodyField === 'clientASR') {
    add(errors, same(actual.body, body), `${label}.body is not exactly {clientASR: matrix phrase}`);
  } else {
    add(errors, same(actual.body, allowedRequest?.bodyContract), `${label}.body must exactly match the allow-listed local-turn body contract`);
    add(errors, Array.isArray(actual.body?.nluRules) && actual.body.nluRules.length === 1 && actual.body.nluRules[0] === 'launch', `${label}.body.nluRules must be exactly ["launch"]`);
  }
  add(errors, actual.bodySha256 === canonicalSha256(actual.body), `${label}.bodySha256 does not match canonical request body`);
  requireDigest(errors, actual.bodySha256, `${label}.bodySha256`);
  if (descriptor.domain === 'commute') {
    requireString(errors, actual.locationISO, `${label}.locationISO`);
    add(errors, !Number.isNaN(Date.parse(actual.locationISO)), `${label}.locationISO must be an ISO timestamp`);
    add(errors, actual.locationISO === preflight?.context?.runtimeLocationISO, `${label}.locationISO must equal the preflight runtime context`);
    const fixtureWorkTime = actual.prefsResolution?.generatedFrom === 'private-fixture-work-time';
    add(errors, fixtureWorkTime
      ? ['capture-local-clock', 'private-fixture-work-time'].includes(actual.locationMode)
      : actual.locationMode === 'capture-local-clock', `${label}.locationMode must be capture-local-clock or private-fixture-work-time`);
    add(errors, isObject(actual.prefs) && actual.prefs.mode === descriptor.input?.prefsPolicy?.mode, `${label}.prefs.mode does not match the matrix policy`);
    add(errors, actual.prefs?.baseSeconds === descriptor.input?.prefsPolicy?.baseSeconds, `${label}.prefs.baseSeconds does not match the matrix policy`);
    add(errors, actual.prefs?.trafficSeconds === descriptor.input?.prefsPolicy?.trafficSeconds, `${label}.prefs.trafficSeconds does not match the matrix policy`);
    add(errors, Number.isInteger(actual.prefs?.workHour) && Number.isInteger(actual.prefs?.workMin), `${label}.prefs must contain resolved wall-clock workHour/workMin`);
    requireString(errors, actual.prefs?.workDateISO, `${label}.prefs.workDateISO`);
    add(errors, /^\d{4}-\d{2}-\d{2}$/.test(actual.prefs?.workDateISO || ''), `${label}.prefs.workDateISO must be YYYY-MM-DD`);
    const resolvedSchedule = fixtureWorkTime
      ? null
      : resolveCommuteSchedule(actual.locationISO, descriptor.input?.prefsPolicy?.schedule, 'America/New_York');
    if (resolvedSchedule) {
      add(errors, actual.prefs.workHour === resolvedSchedule.hour, `${label}.prefs.workHour is not derived from capture-local-clock`);
      add(errors, actual.prefs.workMin === resolvedSchedule.minute, `${label}.prefs.workMin is not derived from capture-local-clock`);
      add(errors, actual.prefs.workDateISO === resolvedSchedule.dateISO, `${label}.prefs.workDateISO is not derived from capture-local-clock`);
    } else if (!fixtureWorkTime) errors.push(`${label}.prefs policy cannot be resolved`);
    if (requireObject(errors, actual.prefsResolution, `${label}.prefsResolution`)) {
      add(errors, fixtureWorkTime
        ? ['private-fixture-work-time', descriptor.input?.prefsPolicy?.schedule].includes(actual.prefsResolution.schedule)
        : actual.prefsResolution.schedule === descriptor.input?.prefsPolicy?.schedule, `${label}.prefsResolution.schedule does not match the matrix policy or private fixture mode`);
      if (fixtureWorkTime) {
        add(errors, ['private-fixture-work-time', 'fixture.userPrefs.commute.workTime'].includes(actual.prefsResolution.source), `${label}.prefsResolution.source must identify private fixture work time`);
        const sourceFixture = actual.prefsResolution.sourceFixture;
        const fixtureSha256 = actual.prefsResolution.fixtureSha256 ?? sourceFixture?.sha256;
        requireDigest(errors, fixtureSha256, `${label}.prefsResolution.fixtureSha256`);
        add(errors, typeof sourceFixture?.caseKey === 'string' || typeof actual.prefsResolution.fixtureCase === 'string', `${label}.prefsResolution must identify the private fixture case`);
        if (actual.prefsResolution.matrixPolicy !== undefined) add(errors, actual.prefsResolution.matrixPolicy === descriptor.input?.prefsPolicy?.schedule, `${label}.prefsResolution.matrixPolicy does not match the matrix policy`);
      } else add(errors, actual.prefsResolution.generatedFrom === 'capture-local-clock', `${label}.prefsResolution.generatedFrom must be capture-local-clock`);
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
    add(errors, actual.calendarDateISO === actual.runtimeLocalDateISO, `${label}.calendarDateISO must equal the exact runtime local date`);
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
  add(errors, actual.rawSha256 === sha256Text(JSON.stringify(payload.phoenix)), `${label}.rawSha256 does not match the raw Phoenix payload`);
  add(errors, actual.payloadSha256 === canonicalSha256(payload), `${label}.payloadSha256 does not match the action payload`);
  for (const stream of ['phoenix', 'native', 'wire']) {
    requireObject(errors, payload[stream], `${label}.payload.${stream}`);
    add(errors, payload[stream]?.operation === selectedOperation, `${label}.payload.${stream}.operation does not match the selected preflight operation`);
    requireDigest(errors, actual[`${stream}CanonicalSha256`], `${label}.${stream}CanonicalSha256`);
    if (payload[stream] !== undefined) add(errors, actual[`${stream}CanonicalSha256`] === canonicalSha256(payload[stream]), `${label}.${stream}CanonicalSha256 does not match payload`);
    if (payload[stream]?.projection !== undefined) {
      add(errors, same(payload[stream].projection, actual.projection), `${label}.payload.${stream}.projection differs from action projection`);
    } else errors.push(`${label}.payload.${stream}.projection is missing`);
  }
  add(errors, same(payload.native, payload.phoenix), `${label}.native payload differs from Phoenix payload`);
  add(errors, same(payload.wire, payload.native), `${label}.wire payload differs from native payload`);
  add(errors, actual.nativeEqualsPhoenix === same(payload.native, payload.phoenix), `${label}.nativeEqualsPhoenix does not reflect payload bytes`);
  add(errors, actual.wireEqualsNative === same(payload.wire, payload.native), `${label}.wireEqualsNative does not reflect payload bytes`);
  add(errors, actual.phoenixMatchesMatrix === true, `${label}.phoenixMatchesMatrix must be true`);
  if (actual.sourceAction !== undefined) {
    if (requireObject(errors, actual.sourceAction, `${label}.sourceAction`)) {
      requireDigest(errors, actual.sourceAction.rawActionSha256, `${label}.sourceAction.rawActionSha256`);
      add(errors, actual.sourceAction.rawActionSha256 === payload.phoenix.rawActionSha256, `${label}.sourceAction.rawActionSha256 does not bind Phoenix payload`);
      requireDigest(errors, actual.sourceAction.rawTurnSha256, `${label}.sourceAction.rawTurnSha256`);
      add(errors, Number.isInteger(actual.sourceAction.eventIndex) && actual.sourceAction.eventIndex >= 0, `${label}.sourceAction.eventIndex must be a non-negative integer`);
    }
  }
}

function validateLogsAndCorrelation(descriptor, actual, errors, label, selectedOperation) {
  if (!requireObject(errors, actual.correlation, `${label}.correlation`)) return;
  const correlation = actual.correlation;
  requireString(errors, correlation.requestID, `${label}.correlation.requestID`);
  requireString(errors, correlation.ackRequestID, `${label}.correlation.ackRequestID`);
  requireString(errors, correlation.transID, `${label}.correlation.transID`);
  add(errors, correlation.requestID === correlation.transID, `${label}.correlation requestID/transID mismatch`);
  const initialStage = wireFlowStage(actual, 'Tg');
  add(errors, hasTwoStageFlow(actual)
    ? correlation.ackRequestID === (initialStage?.transID ?? initialStage?.requestID)
    : correlation.ackRequestID === correlation.transID, `${label}.correlation ackRequestID does not bind the acknowledged stage`);
  add(errors, correlation.caseId === descriptor.id, `${label}.correlation.caseId does not bind matrix case`);
  add(errors, correlation.operation === selectedOperation, `${label}.correlation.operation does not bind selected operation`);
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
    const twoStage = hasTwoStageFlow(actual);
    add(errors, Number.isInteger(wire.messageCount) && wire.messageCount > 0, `${label}.logs.wire.messageCount must be positive`);
    add(errors, Number.isInteger(wire.actionMessageIndex) && wire.actionMessageIndex >= 0 && wire.actionMessageIndex < wire.messageCount, `${label}.logs.wire.actionMessageIndex is out of range`);
    add(errors, twoStage
      ? (wire.ackMessageIndex === -1 || wire.ackMessageIndex === undefined || wire.ackMessageIndex === null)
      : (Number.isInteger(wire.ackMessageIndex) && wire.ackMessageIndex >= 0 && wire.ackMessageIndex < wire.messageCount),
    twoStage ? `${label}.logs.wire.ackMessageIndex must be absent/-1 because rawTurn carries the Tg ACK` : `${label}.logs.wire.ackMessageIndex is out of range`);
    add(errors, wire.actionMessageId === correlation.wireActionMessageId, `${label}.logs.wire.actionMessageId does not correlate`);
    requireString(errors, wire.connectionId, `${label}.logs.wire.connectionId`);
    add(errors, wire.connectionId === correlation.connectionId, `${label}.logs.wire.connectionId does not correlate`);
    if (twoStage) add(errors, wire.ackPayloadSha256 === undefined, `${label}.logs.wire.ackPayloadSha256 must be absent when the raw wire has no ACK record`);
  }
  if (requireObject(errors, actual.traceRange, `${label}.traceRange`)) {
    add(errors, Number.isInteger(actual.traceRange.start) && actual.traceRange.start >= 0, `${label}.traceRange.start must be a non-negative integer`);
    add(errors, Number.isInteger(actual.traceRange.end) && actual.traceRange.end >= actual.traceRange.start, `${label}.traceRange.end must follow start`);
  }
}

function validateTimeline(descriptor, actual, errors, label) {
  if (!requireObject(errors, actual.timeline, `${label}.timeline`)) return;
  const timeline = actual.timeline;
  const captureBase = timestampMs(actual.captureISO);
  const contracts = expectedViewContracts(descriptor);
  if (!Array.isArray(timeline.views)) {
    errors.push(`${label}.timeline.views must be an array`);
  } else {
    add(errors, timeline.views.length === contracts.length, `${label}.timeline.views count differs from expected view count`);
    let previousClosed = null;
    contracts.forEach((contract, index) => {
      const item = timeline.views[index];
      if (!requireObject(errors, item, `${label}.timeline.views[${index}]`)) return;
      add(errors, item.ordinal === contract.ordinal, `${label}.timeline.views[${index}].ordinal is out of order`);
      add(errors, item.viewId === contract.id, `${label}.timeline.views[${index}].viewId is out of order`);
      add(errors, isFiniteNumber(item.openedMs) && isFiniteNumber(item.closedMs), `${label}.timeline.views[${index}] must contain numeric open/close times`);
      add(errors, item.openedMs < item.closedMs, `${label}.timeline.views[${index}] must close after opening`);
      const openedAt = requireTimestamp(errors, item.openedAtISO, `${label}.timeline.views[${index}].openedAtISO`);
      const closedAt = requireTimestamp(errors, item.closedAtISO, `${label}.timeline.views[${index}].closedAtISO`);
      if (openedAt !== null && closedAt !== null) {
        if (captureBase !== null) {
          add(errors, item.openedMs === openedAt - captureBase, `${label}.timeline.views[${index}].openedMs does not bind openedAtISO to captureISO`);
          add(errors, item.closedMs === closedAt - captureBase, `${label}.timeline.views[${index}].closedMs does not bind closedAtISO to captureISO`);
        }
        add(errors, openedAt < closedAt, `${label}.timeline.views[${index}] openedAtISO must precede closedAtISO`);
        if (previousClosed !== null) add(errors, openedAt >= previousClosed, `${label}.timeline.views[${index}] opens before the prior view closes`);
        previousClosed = closedAt;
      }
    });
  }
  if (requireObject(errors, timeline.idle, `${label}.timeline.idle`)) {
    const idle = timeline.idle;
    add(errors, isFiniteNumber(idle.observedMs), `${label}.timeline.idle.observedMs must be numeric`);
    const idleAt = requireTimestamp(errors, idle.observedAtISO, `${label}.timeline.idle.observedAtISO`);
    if (captureBase !== null && idleAt !== null) add(errors, idle.observedMs === idleAt - captureBase, `${label}.timeline.idle.observedMs does not bind observedAtISO to captureISO`);
    add(errors, idle.skill === '@be/idle', `${label}.timeline.idle.skill must be @be/idle`);
    add(errors, idle.view === 'eyeView', `${label}.timeline.idle.view must be eyeView`);
    add(errors, idle.listener === 'Idle', `${label}.timeline.idle.listener must be Idle`);
    add(errors, idle.ttsTalking === false, `${label}.timeline.idle.ttsTalking must be false`);
    add(errors, idle.finalState === 'idle', `${label}.timeline.idle.finalState must be idle`);
    add(errors, idle.observersRestored === true, `${label}.timeline.idle.observersRestored must be true`);
    if (Array.isArray(timeline.views)) timeline.views.forEach((item, index) => {
      add(errors, isFiniteNumber(item.closedMs) && item.closedMs < idle.observedMs, `${label}.timeline.views[${index}] closed after idle`);
      const closedAt = timestampMs(item.closedAtISO);
      const idleTimestamp = timestampMs(idle.observedAtISO);
      add(errors, closedAt !== null && idleTimestamp !== null && closedAt < idleTimestamp, `${label}.timeline.views[${index}] closedAtISO after idle`);
    });
  }
  add(errors, timeline.transitionToIdle === true, `${label}.timeline.transitionToIdle must be true`);
}

function validateScreenshots(descriptor, actual, root, errors, label, identityState = { paths: new Set(), captureKeys: new Set(), artifactIdentities: new Set() }) {
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
    add(errors, shot.caseId === descriptor.id, `${label}.screenshots[${index}].caseId does not bind the matrix case`);
    add(errors, shot.viewOrdinal === shot.ordinal, `${label}.screenshots[${index}].viewOrdinal does not bind ordinal`);
    add(errors, shot.captureKey === `${descriptor.id}:view:${shot.ordinal}:${shot.viewId}`, `${label}.screenshots[${index}].captureKey is not the producer capture identity`);
    add(errors, typeof shot.path === 'string' && shot.path.startsWith(`artifacts/${descriptor.id}/screenshots/`), `${label}.screenshots[${index}].path is outside the case screenshot namespace`);
    add(errors, typeof shot.captureAtISO === 'string' && timestampMs(shot.captureAtISO) !== null, `${label}.screenshots[${index}].captureAtISO must be an ISO timestamp`);
    requireDigest(errors, shot.pixelSha256, `${label}.screenshots[${index}].pixelSha256`);
    requireDigest(errors, shot.artifactIdentity, `${label}.screenshots[${index}].artifactIdentity`);
    if (identityState.paths.has(shot.path)) errors.push(`${label}.screenshots[${index}] reuses a screenshot artifact path`);
    if (identityState.captureKeys.has(shot.captureKey)) errors.push(`${label}.screenshots[${index}] reuses a screenshot capture key`);
    if (identityState.artifactIdentities.has(shot.artifactIdentity)) errors.push(`${label}.screenshots[${index}] reuses a screenshot artifact identity`);
    identityState.paths.add(shot.path);
    identityState.captureKeys.add(shot.captureKey);
    identityState.artifactIdentities.add(shot.artifactIdentity);
    add(errors, shot.stableForMs >= 500, `${label}.screenshots[${index}] was not stable for at least 500ms`);
    add(errors, shot.visuallyInspected === true, `${label}.screenshots[${index}] was not visually inspected`);
    if (hasTwoStageFlow(actual)) {
      const displayAction = shot.sourceScreenshot?.displayAction;
      if (displayAction !== undefined) {
        add(errors, isObject(displayAction), `${label}.screenshots[${index}].sourceScreenshot.displayAction must be an object`);
        add(errors, displayAction.captureStatus === 'captured', `${label}.screenshots[${index}] was not captured from a selected display action`);
        add(errors, displayAction.eventType === 'SKILL_ACTION', `${label}.screenshots[${index}] source display event is not SKILL_ACTION`);
        add(errors, displayAction.transID === actual.correlation?.transID, `${label}.screenshots[${index}] display action does not bind final Tl transID`);
        add(errors, displayAction.eventIndex === actual.action?.sourceAction?.eventIndex, `${label}.screenshots[${index}] display action does not bind final Tl action event`);
      } else errors.push(`${label}.screenshots[${index}] is missing the raw final Tl display-action locator`);
    }
    const screenshotRef = validateArtifactRef(shot, root, errors, `${label}.screenshots[${index}]`);
    if (screenshotRef) {
      add(errors, shot.pixelSha256 === screenshotRef.sha256, `${label}.screenshots[${index}].pixelSha256 does not match screenshot bytes`);
      add(errors, shot.artifactIdentity === canonicalSha256({ caseId: descriptor.id, caseOrdinal: descriptor.ordinal, viewOrdinal: shot.viewOrdinal, viewId: shot.viewId, pixelSha256: shot.pixelSha256 }), `${label}.screenshots[${index}].artifactIdentity does not bind case/view/pixels`);
    }
    validatePngArtifact(screenshotRef, errors, `${label}.screenshots[${index}]`);
  });
  return identityState;
}

function validateArtifacts(actual, root, errors, label, globalReview = null) {
  if (!requireObject(errors, actual.artifacts, `${label}.artifacts`)) return;
  const refs = {};
  for (const name of ['stackReceipt', 'nativeReport', 'wireTrace', 'providerTrace', 'actionPayload', 'providerFixture', 'contextAnchor']) {
    refs[name] = validateArtifactRef(actual.artifacts[name], root, errors, `${label}.artifacts.${name}`);
  }
  refs.visualReview = actual.artifacts.visualReview !== undefined
    ? validateArtifactRef(actual.artifacts.visualReview, root, errors, `${label}.artifacts.visualReview`)
    : globalReview;
  if (!refs.visualReview) errors.push(`${label}.artifacts.visualReview must identify an externally reviewed artifact`);
  for (const name of ['rawTurn', 'rawFixture', 'rawWire']) {
    if (actual.artifacts[name] !== undefined) refs[name] = validateArtifactRef(actual.artifacts[name], root, errors, `${label}.artifacts.${name}`);
  }
  return refs;
}

function validateVisualReview(descriptor, actual, refs, errors, label) {
  const ref = refs?.visualReview;
  if (!ref) return;
  const review = parseJsonBytes(ref, errors, `${label}.artifacts.visualReview`);
  if (!review) return;
  // The v2 artifact is global and is checked once against every screenshot.
  // A row may still carry the shared ref for convenient provenance, but its
  // records must not be interpreted as a per-case v1 review.
  if (review.schema === 'phoenix-s13-visual-review-v2') return;
  add(errors, review.schema === 's13-visual-review-v1', `${label}.visualReview.schema is unsupported`);
  add(errors, review.caseId === descriptor.id, `${label}.visualReview.caseId does not bind the matrix case`);
  requireString(errors, review.reviewer, `${label}.visualReview.reviewer`);
  add(errors, timestampMs(review.reviewedAt) !== null, `${label}.visualReview.reviewedAt must be an ISO timestamp`);
  add(errors, review.visuallyInspected === true, `${label}.visualReview must record visuallyInspected:true`);
  const records = Array.isArray(review.screenshots) ? review.screenshots : null;
  if (!records) {
    errors.push(`${label}.visualReview.screenshots must be an array`);
    return;
  }
  const expected = Array.isArray(actual.screenshots) ? actual.screenshots : [];
  add(errors, records.length === expected.length, `${label}.visualReview screenshot count differs from captured views`);
  records.forEach((record, index) => {
    if (!requireObject(errors, record, `${label}.visualReview.screenshots[${index}]`)) return;
    const shot = expected[index];
    add(errors, record.caseId === descriptor.id, `${label}.visualReview.screenshots[${index}].caseId does not bind the case`);
    add(errors, record.viewOrdinal === shot?.viewOrdinal, `${label}.visualReview.screenshots[${index}].viewOrdinal does not bind the capture`);
    add(errors, record.viewId === shot?.viewId, `${label}.visualReview.screenshots[${index}].viewId does not bind the capture`);
    add(errors, record.captureKey === shot?.captureKey, `${label}.visualReview.screenshots[${index}].captureKey does not bind the capture`);
    add(errors, record.sha256 === shot?.sha256, `${label}.visualReview.screenshots[${index}].sha256 does not bind screenshot bytes`);
    add(errors, record.verdict === 'pass', `${label}.visualReview.screenshots[${index}].verdict must be pass`);
  });
}

function reviewPathMatchesShot(reviewPath, shot, caseId) {
  if (typeof reviewPath !== 'string') return false;
  const candidates = [shot?.path, shot?.sourceScreenshot?.filename].filter((value) => typeof value === 'string');
  return candidates.some((candidate) => candidate === reviewPath
    || candidate.endsWith(`/${reviewPath}`)
    || (reviewPath.endsWith(`/${path.basename(candidate)}`) && reviewPath.startsWith(`${caseId}/`)));
}

function reviewCaptureOrdinal(shot) {
  return shot?.captureOrdinal
    ?? shot?.sourceScreenshot?.captureOrdinal
    ?? shot?.sourceScreenshot?.displayAction?.captureOrdinal
    ?? shot?.viewOrdinal
    ?? shot?.ordinal;
}

function validateGlobalVisualReview(receipt, matrix, ref, root, errors) {
  if (!ref) return;
  const label = 'global visual-review';
  const review = parseJsonBytes(ref, errors, label);
  if (!review) return;
  add(errors, review.schema === 'phoenix-s13-visual-review-v2', `${label}.schema must be phoenix-s13-visual-review-v2`);
  requireString(errors, review.reviewer, `${label}.reviewer`);
  add(errors, timestampMs(review.reviewedAt) !== null, `${label}.reviewedAt must be an ISO timestamp`);
  add(errors, review.allPassed === true, `${label}.allPassed must be true`);
  const records = Array.isArray(review.reviews) ? review.reviews : null;
  if (!records) {
    errors.push(`${label}.reviews must be an array`);
    return;
  }
  const expected = [];
  for (const row of receipt?.cases || []) {
    const descriptor = matrix.cases?.find((item) => item.id === row?.id);
    if (descriptor?.kind !== 'physical' || row?.status !== 'pass') continue;
    for (const shot of row.actual?.screenshots || []) expected.push({ caseId: row.id, shot });
  }
  add(errors, records.length === expected.length, `${label}.reviews count does not equal captured screenshot count`);
  if (review.targetCount !== undefined) add(errors, review.targetCount === expected.length, `${label}.targetCount does not equal captured screenshot count`);
  const seen = new Set();
  records.forEach((record, index) => {
    const recordLabel = `${label}.reviews[${index}]`;
    if (!requireObject(errors, record, recordLabel)) return;
    const caseId = record.caseId ?? record.case;
    requireString(errors, caseId, `${recordLabel}.case`);
    const ordinal = record.captureOrdinal ?? record.viewOrdinal ?? record.ordinal;
    add(errors, Number.isInteger(ordinal) && ordinal >= 0, `${recordLabel}.captureOrdinal must be a non-negative integer`);
    requireString(errors, record.path, `${recordLabel}.path`);
    requireDigest(errors, record.sha256, `${recordLabel}.sha256`);
    add(errors, record.verdict === 'pass', `${recordLabel}.verdict must be pass`);
    const key = `${caseId}|${ordinal}|${record.path}|${record.sha256}`;
    if (seen.has(key)) errors.push(`${label} duplicate review key ${key}`);
    seen.add(key);
    const candidates = expected.filter(({ caseId: expectedCaseId, shot }) => expectedCaseId === caseId
      && reviewCaptureOrdinal(shot) === ordinal
      && reviewPathMatchesShot(record.path, shot, caseId)
      && record.sha256 === (shot.pixelSha256 || shot.sha256));
    add(errors, candidates.length === 1, `${recordLabel} does not identify exactly one captured screenshot by case/ordinal/path/hash`);
    if (candidates.length === 1) {
      const shot = candidates[0].shot;
      if (record.viewId !== undefined) add(errors, record.viewId === shot.viewId, `${recordLabel}.viewId does not bind the screenshot`);
      if (record.bytes !== undefined) add(errors, record.bytes === shot.bytes, `${recordLabel}.bytes does not bind screenshot bytes`);
    }
  });
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

function validateContextAnchor(descriptor, actual, refs, preflight, errors, label, captureWindow = null) {
  const ref = refs?.contextAnchor;
  if (!ref) return null;
  const anchor = parseJsonBytes(ref, errors, `${label}.artifacts.contextAnchor`);
  if (!anchor) return null;
  add(errors, anchor.schema === 's13-context-anchor-v1', `${label}.contextAnchor.schema is invalid`);
  add(errors, anchor.available === true, `${label}.contextAnchor must contain a verified standalone context anchor`);
  add(errors, anchor.caseId === descriptor.id, `${label}.contextAnchor.caseId does not bind matrix case`);
  add(errors, anchor.requestID === actual.correlation?.requestID, `${label}.contextAnchor.requestID does not bind receipt correlation`);
  add(errors, anchor.transID === actual.correlation?.transID, `${label}.contextAnchor.transID does not bind receipt correlation`);
  add(errors, anchor.operation === actual.request?.operation, `${label}.contextAnchor.operation does not bind request operation`);
  requireString(errors, anchor.runtimeLocationISO, `${label}.contextAnchor.runtimeLocationISO`);
  requireString(errors, anchor.timezone, `${label}.contextAnchor.timezone`);
  add(errors, timestampMs(anchor.runtimeLocationISO) !== null, `${label}.contextAnchor.runtimeLocationISO must be an ISO timestamp`);
  add(errors, anchor.timezone === 'America/New_York', `${label}.contextAnchor.timezone must be America/New_York`);
  const expectedLocationISO = actual.request?.locationISO || actual.contextLocationISO || actual.captureISO;
  add(errors, anchor.runtimeLocationISO === expectedLocationISO, `${label}.contextAnchor.runtimeLocationISO does not bind request/capture location`);
  add(errors, anchor.runtimeLocationISO === preflight?.context?.runtimeLocationISO, `${label}.contextAnchor.runtimeLocationISO does not bind preflight context`);
  add(errors, anchor.timezone === preflight?.context?.timezone, `${label}.contextAnchor.timezone does not bind preflight timezone`);
  requireString(errors, anchor.source, `${label}.contextAnchor.source`);
  requireString(errors, anchor.sourceMessageId, `${label}.contextAnchor.sourceMessageId`);
  add(errors, Number.isInteger(anchor.sourceLine) && anchor.sourceLine >= 0, `${label}.contextAnchor.sourceLine must identify a non-negative source trace line`);
  requireTimestamp(errors, anchor.capturedAtISO, `${label}.contextAnchor.capturedAtISO`);
  requireDigest(errors, anchor.sourceTraceSha256, `${label}.contextAnchor.sourceTraceSha256`);
  const strict = Boolean(refs.rawWire || hasTwoStageFlow(actual));
  if (!strict) {
    add(errors, anchor.sourceTraceSha256 === actual.artifacts?.wireTrace?.sha256, `${label}.contextAnchor.sourceTraceSha256 does not bind wire trace bytes`);
    return anchor;
  }
  requireDigest(errors, anchor.sourceLineSha256, `${label}.contextAnchor.sourceLineSha256`);
  const sourceTrace = refs.rawWire || refs.wireTrace;
  add(errors, Boolean(sourceTrace), `${label}.contextAnchor source trace artifact is missing`);
  add(errors, anchor.sourceTraceSha256 === sourceTrace?.sha256, `${label}.contextAnchor.sourceTraceSha256 does not bind source wire trace bytes`);
  validateCaptureWindowValue(anchor.runtimeLocationISO, captureWindow, errors, `${label}.contextAnchor.runtimeLocationISO`);
  validateCaptureWindowValue(anchor.capturedAtISO, captureWindow, errors, `${label}.contextAnchor.capturedAtISO`);

  if (anchor.available === true && sourceTrace && Number.isInteger(anchor.sourceLine) && anchor.sourceLine >= 0) {
    const sourceLine = parseJsonlLineAt(sourceTrace, anchor.sourceLine, errors, `${label}.contextAnchor`);
    if (sourceLine) {
      add(errors, anchor.sourceLineSha256 === sha256Bytes(sourceLine.bytes), `${label}.contextAnchor.sourceLineSha256 does not match raw trace line bytes`);
      const value = sourceLine.value;
      const sourceJson = isObject(value.json) ? value.json : value;
      const messageId = value.messageId || value.msgID || sourceJson.msgID || sourceJson.messageId;
      add(errors, messageId === anchor.sourceMessageId, `${label}.contextAnchor.sourceMessageId does not identify the selected raw trace line`);
      const transID = value.transID || sourceJson.transID;
      add(errors, transID === anchor.transID, `${label}.contextAnchor source line transID does not bind correlation`);
      const locationISO = value.runtimeLocationISO
        || sourceJson.runtimeLocationISO
        || sourceJson.data?.runtime?.location?.iso
        || sourceJson.runtime?.location?.iso;
      add(errors, locationISO === anchor.runtimeLocationISO, `${label}.contextAnchor source line runtime location does not bind the anchor`);
      const capturedAtISO = value.timestampISO || value.at || sourceJson.timestampISO || sourceJson.at;
      add(errors, capturedAtISO === anchor.capturedAtISO, `${label}.contextAnchor source line timestamp does not bind the anchor`);
      add(errors, value.type === 'context' || sourceJson.type === 'CONTEXT' || Boolean(locationISO), `${label}.contextAnchor source line is not a context record`);
    }
  }

  // The normalized wire trace must carry the same raw-line locator.  This
  // prevents a producer from presenting a valid raw context line while the
  // wire artifact used for the receipt points at a different context.
  if (refs.wireTrace && anchor.available === true) {
    const normalized = parseJsonlBytes(refs.wireTrace, errors, `${label}.artifacts.wireTrace`);
    const contexts = normalized.filter((record) => record?.type === 'context');
    const expectedContextCount = hasTwoStageFlow(actual) ? 2 : 1;
    add(errors, contexts.length === expectedContextCount, `${label}.wireTrace must contain exactly ${expectedContextCount} context record${expectedContextCount === 1 ? '' : 's'}`);
    const context = contexts.find((record) => record?.messageId === anchor.sourceMessageId) || contexts[0];
    if (context) {
      add(errors, context.messageId === anchor.sourceMessageId, `${label}.wireTrace context message ID does not bind context anchor`);
      add(errors, context.runtimeLocationISO === anchor.runtimeLocationISO, `${label}.wireTrace context location does not bind context anchor`);
      add(errors, context.timestampISO === anchor.capturedAtISO, `${label}.wireTrace context timestamp does not bind context anchor`);
      if (requireObject(errors, context.source, `${label}.wireTrace context.source`)) {
        add(errors, context.source.line === anchor.sourceLine, `${label}.wireTrace context source line does not bind context anchor`);
        add(errors, context.source.messageId === anchor.sourceMessageId, `${label}.wireTrace context source message ID does not bind context anchor`);
        add(errors, context.source.sha256 === anchor.sourceLineSha256, `${label}.wireTrace context source line hash does not bind context anchor`);
        add(errors, context.source.traceSha256 === anchor.sourceTraceSha256, `${label}.wireTrace context source trace hash does not bind context anchor`);
      }
    }
  }
  return anchor;
}

function rawWireMessageType(record) {
  if (['context', 'request', 'action', 'ack', 'idle'].includes(record?.type)) return record.type;
  const type = record?.json?.type;
  if (type === 'CONTEXT') return 'context';
  if (type === 'CLIENT_ASR' || type === 'LISTEN') return 'request';
  if (type === 'SKILL_ACTION') return 'action';
  return null;
}

function validateWireSourceBindings(descriptor, actual, refs, wire, errors, label) {
  const rawRef = refs?.rawWire;
  if (!rawRef) return;
  const raw = parseJsonlBytes(rawRef, errors, `${label}.artifacts.rawWire`);
  if (!raw.length) return;
  const usedLines = new Set();
  for (const [index, record] of wire.entries()) {
    const source = record?.source;
    if (record?.type === 'idle' && (!source || source.line === undefined)) continue;
    if (!requireObject(errors, source, `${label}.wireTrace[${index}].source`)) continue;
    add(errors, Number.isInteger(source.line) && source.line >= 0, `${label}.wireTrace[${index}].source.line must be a non-negative integer`);
    requireDigest(errors, source.sha256, `${label}.wireTrace[${index}].source.sha256`);
    requireDigest(errors, source.traceSha256, `${label}.wireTrace[${index}].source.traceSha256`);
    add(errors, source.traceSha256 === rawRef.sha256, `${label}.wireTrace[${index}].source.traceSha256 does not bind raw wire bytes`);
    if (!Number.isInteger(source.line) || source.line < 0) continue;
    if (usedLines.has(source.line)) errors.push(`${label}.wireTrace source line ${source.line} is selected more than once`);
    usedLines.add(source.line);
    const rawLine = parseJsonlLineAt(rawRef, source.line, errors, `${label}.wireTrace[${index}].source`);
    if (!rawLine) continue;
    const rawRecord = rawLine.value;
    const rawType = rawWireMessageType(rawRecord);
    add(errors, rawType === record.type, `${label}.wireTrace[${index}] source line type does not bind normalized ${record.type}`);
    add(errors, source.sha256 === sha256Bytes(rawLine.bytes), `${label}.wireTrace[${index}].source.sha256 does not match raw source line bytes`);
    add(errors, source.kind === rawRecord.kind, `${label}.wireTrace[${index}].source.kind does not bind raw record kind`);
    add(errors, source.id === rawRecord.id, `${label}.wireTrace[${index}].source.id does not bind raw record ID`);
    const rawMessageId = rawRecord.json?.msgID || rawRecord.json?.messageId;
    if (rawMessageId !== undefined) add(errors, source.messageId === rawMessageId && record.messageId === rawMessageId, `${label}.wireTrace[${index}] message ID does not bind raw source line`);
    const rawTransID = rawRecord.json?.transID;
    if (rawTransID !== undefined) add(errors, record.transID === rawTransID, `${label}.wireTrace[${index}] transID does not bind raw source line`);
    add(errors, rawRecord.at === record.timestampISO, `${label}.wireTrace[${index}] timestamp does not bind raw source line`);
    const sourceStage = wireStageName(record);
    if (sourceStage) {
      const stage = wireFlowStage(actual, sourceStage);
      if (stage?.requestType && record.type === 'request') add(errors, source.messageType === stage.requestType, `${label}.wireTrace[${index}] request source type does not bind ${sourceStage} stage`);
      if (record.type === 'context') add(errors, source.messageType === 'CONTEXT', `${label}.wireTrace[${index}] context source type is not CONTEXT`);
      if (record.type === 'action') add(errors, source.messageType === 'SKILL_ACTION', `${label}.wireTrace[${index}] action source type is not SKILL_ACTION`);
      const expectedID = stage?.requestID ?? stage?.transID;
      if (expectedID !== undefined && rawTransID !== undefined) add(errors, expectedID === rawTransID, `${label}.wireTrace[${index}] raw source line does not bind ${sourceStage} stage`);
    }
  }
}

function validateRawTurnAck(actual, refs, errors, label) {
  if (!hasTwoStageFlow(actual)) return;
  if (!refs?.rawTurn) {
    errors.push(`${label}.artifacts.rawTurn is required to bind the Tg SDK ACK`);
    return;
  }
  const rawTurn = parseJsonBytes(refs?.rawTurn, errors, `${label}.artifacts.rawTurn`);
  const initial = wireFlowStage(actual, 'Tg');
  if (!rawTurn) return;
  const excluded = Array.isArray(rawTurn.excludedDisplayActions)
    ? rawTurn.excludedDisplayActions.filter((item) => item?.captureStatus === 'excluded-prelude')
    : [];
  const declaredExcluded = actual.flow?.excludedPrelude || actual.wireFlow?.excludedPrelude;
  add(errors, excluded.length === 1, `${label}.rawTurn must contain exactly one excluded prelude display`);
  if (requireObject(errors, declaredExcluded, `${label}.wireFlow.excludedPrelude`)) {
    add(errors, declaredExcluded.count === 1, `${label}.wireFlow.excludedPrelude.count must be 1`);
    if (excluded.length === 1) {
      add(errors, declaredExcluded.eventIndex === excluded[0].eventIndex, `${label}.wireFlow.excludedPrelude.eventIndex does not bind raw turn`);
      add(errors, declaredExcluded.viewId === excluded[0].viewId, `${label}.wireFlow.excludedPrelude.viewId does not bind raw turn`);
      add(errors, declaredExcluded.exclusionReason === excluded[0].exclusionReason, `${label}.wireFlow.excludedPrelude.exclusionReason does not bind raw turn`);
    }
  }
  if (excluded.length === 1 && initial?.transID !== undefined) {
    add(errors, excluded[0].transID === initial.transID, `${label}.rawTurn excluded prelude does not bind Tg stage`);
  }
  if (!requireObject(errors, rawTurn.ack, `${label}.rawTurn.ack`)) return;
  requireString(errors, rawTurn.ack.requestID, `${label}.rawTurn.ack.requestID`);
  const expectedAckID = initial?.ackRequestID ?? initial?.requestID ?? initial?.transID;
  add(errors, rawTurn.ack.requestID === expectedAckID, `${label}.rawTurn.ack.requestID does not bind the Tg stage`);
  add(errors, actual.correlation?.ackRequestID === rawTurn.ack.requestID, `${label}.correlation.ackRequestID does not bind rawTurn.ack.requestID`);
  if (initial?.requestID !== undefined && rawTurn.request?.requestID !== undefined) add(errors, rawTurn.request.requestID === initial.requestID, `${label}.rawTurn.request does not bind Tg request ID`);
  if (initial?.endpoint !== undefined && rawTurn.request?.endpoint !== undefined) add(errors, rawTurn.request.endpoint === initial.endpoint, `${label}.rawTurn.request endpoint does not bind Tg stage`);
  if (initial?.body !== undefined && rawTurn.request?.body !== undefined) add(errors, same(rawTurn.request.body, initial.body), `${label}.rawTurn.request body does not bind Tg stage`);
  const followup = rawTurn.followup;
  if (isObject(followup)) {
    add(errors, followup.used === true, `${label}.rawTurn.followup.used must be true for a two-stage capture`);
    const calls = Array.isArray(followup.calls) ? followup.calls : [];
    add(errors, calls.length === 1, `${label}.rawTurn.followup must contain exactly one local followup call`);
    if (calls.length === 1 && initial?.requestID !== undefined && wireFlowStage(actual, 'Tl')?.requestID !== undefined) {
      add(errors, calls[0]?.requestID === wireFlowStage(actual, 'Tl').requestID, `${label}.rawTurn.followup request ID does not bind Tl stage`);
      add(errors, calls[0]?.updateCompleted === true, `${label}.rawTurn.followup call was not completed`);
    }
  }
}

function validateProviderSourceBindings(actual, refs, provider, errors, label) {
  if (!hasTwoStageFlow(actual) || !provider.length) return;
  const rawRef = refs?.rawWire;
  if (!rawRef) {
    errors.push(`${label}.providerTrace requires rawWire to bind provider-call source lines`);
    return;
  }
  const raw = parseJsonlBytes(rawRef, errors, `${label}.artifacts.rawWire`);
  const usedLines = new Set();
  const calls = provider.filter((record) => record?.type === 'provider-call');
  add(errors, calls.length === provider.length, `${label}.providerTrace may contain only raw provider-call records for a two-stage capture`);
  calls.forEach((record, index) => {
    const recordLabel = `${label}.providerTrace[${index}]`;
    if (!requireObject(errors, record.source, `${recordLabel}.source`)) return;
    const source = record.source;
    requireDigest(errors, source.sha256, `${recordLabel}.source.sha256`);
    requireDigest(errors, source.traceSha256, `${recordLabel}.source.traceSha256`);
    add(errors, source.traceSha256 === rawRef.sha256, `${recordLabel}.source.traceSha256 does not bind raw wire bytes`);
    add(errors, Number.isInteger(source.line) && source.line >= 0, `${recordLabel}.source.line must be a non-negative integer`);
    if (!Number.isInteger(source.line) || source.line < 0) return;
    if (usedLines.has(source.line)) errors.push(`${label}.providerTrace source line ${source.line} is selected more than once`);
    usedLines.add(source.line);
    const line = parseJsonlLineAt(rawRef, source.line, errors, `${recordLabel}.source`);
    if (!line) return;
    const rawRecord = line.value;
    add(errors, rawRecord.kind === 'fixture-provider', `${recordLabel}.source line is not a fixture-provider record`);
    add(errors, source.sha256 === sha256Bytes(line.bytes), `${recordLabel}.source.sha256 does not match raw provider line bytes`);
    add(errors, source.kind === rawRecord.kind, `${recordLabel}.source.kind does not bind raw provider record kind`);
    add(errors, source.id === rawRecord.id, `${recordLabel}.source.id does not bind raw provider record ID`);
    add(errors, rawRecord.at === record.timestampISO, `${recordLabel}.timestampISO does not bind raw provider line`);
    const stage = wireFlowStage(actual, 'Tl');
    const rawTransID = rawRecord.input?.transID;
    if (rawTransID !== undefined) add(errors, rawTransID === stage?.requestID || rawTransID === stage?.transID, `${recordLabel}.source provider transID does not bind Tl stage`);
  });
  const rawProviderLines = raw.filter((record) => record?.kind === 'fixture-provider');
  if (rawProviderLines.length) add(errors, calls.length === rawProviderLines.length, `${label}.providerTrace call cardinality does not match raw fixture-provider records`);
}

function validateTraceArtifacts(descriptor, actual, refs, runtime, root, errors, label, selectedOperation, captureWindow = null) {
  if (!refs) return;
  const stack = parseJsonBytes(refs.stackReceipt, errors, `${label}.artifacts.stackReceipt`);
  const native = parseJsonBytes(refs.nativeReport, errors, `${label}.artifacts.nativeReport`);
  const wire = parseJsonlBytes(refs.wireTrace, errors, `${label}.artifacts.wireTrace`);
  const provider = parseJsonlBytes(refs.providerTrace, errors, `${label}.artifacts.providerTrace`);
  validateRawTurnAck(actual, refs, errors, label);
  if (hasTwoStageFlow(actual)) add(errors, provider.length > 0, `${label}.providerTrace must contain raw provider-call records`);
  const records = [];
  const times = [];
  const identity = (record, recordLabel, stream = '') => {
    const time = validateTraceIdentity(record, descriptor, actual, selectedOperation, errors, recordLabel, stream);
    if (time !== null) { records.push({ record, time, label: recordLabel }); times.push(time); }
    return time;
  };

  if (refs.contextAnchor) {
    const contextAnchor = parseJsonBytes(refs.contextAnchor, errors, `${label}.artifacts.contextAnchor`);
    if (contextAnchor?.available === true) {
      identity({
        caseId: contextAnchor.caseId,
        requestID: contextAnchor.requestID,
        transID: contextAnchor.transID,
        operation: contextAnchor.operation,
        timestampISO: contextAnchor.capturedAtISO
      }, `${label}.contextAnchor.source`);
    }
  }

  if (stack) {
    add(errors, stack.schema === 's13-stack-receipt-v1', `${label}.stackReceipt.schema is invalid`);
    identity({ ...stack, timestampISO: stack.startedAtISO }, `${label}.stackReceipt.start`);
    const completedAt = requireTimestamp(errors, stack.completedAtISO, `${label}.stackReceipt.completedAtISO`);
    if (completedAt !== null) times.push(completedAt);
    if (requireObject(errors, stack.request, `${label}.stackReceipt.request`)) {
      add(errors, same(stack.request, actual.request), `${label}.stackReceipt.request does not bind receipt request`);
    }
    if (requireObject(errors, stack.action, `${label}.stackReceipt.action`)) {
      add(errors, same(stack.action.payload, actual.action?.payload?.phoenix), `${label}.stackReceipt.action.payload does not bind Phoenix action payload`);
      add(errors, stack.action.operation === selectedOperation, `${label}.stackReceipt.action.operation does not bind selected operation`);
    }
    if (requireObject(errors, stack.finalIdle, `${label}.stackReceipt.finalIdle`)) {
      const idleTime = identity({ ...stack.finalIdle, timestampISO: stack.finalIdle.timestampISO }, `${label}.stackReceipt.finalIdle`);
      add(errors, stack.finalIdle.finalState === 'idle', `${label}.stackReceipt.finalIdle.finalState must be idle`);
      add(errors, stack.finalIdle.skill === '@be/idle', `${label}.stackReceipt.finalIdle.skill must be @be/idle`);
      add(errors, stack.finalIdle.view === 'eyeView', `${label}.stackReceipt.finalIdle.view must be eyeView`);
      add(errors, stack.finalIdle.listener === 'Idle', `${label}.stackReceipt.finalIdle.listener must be Idle`);
      add(errors, stack.finalIdle.ttsTalking === false, `${label}.stackReceipt.finalIdle.ttsTalking must be false`);
      add(errors, idleTime !== null, `${label}.stackReceipt.finalIdle timestamp is missing`);
      add(errors, stack.finalIdle.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.stackReceipt final idle timestamp does not bind timeline idle`);
    }
  }

  let nativeEvents = [];
  if (native) {
    add(errors, native.schema === 's13-native-report-v1', `${label}.nativeReport.schema is invalid`);
    add(errors, native.caseId === descriptor.id, `${label}.nativeReport.caseId does not bind matrix case`);
    add(errors, native.requestID === actual.correlation?.requestID, `${label}.nativeReport.requestID does not bind receipt correlation`);
    add(errors, native.transID === actual.correlation?.transID, `${label}.nativeReport.transID does not bind receipt correlation`);
    add(errors, native.operation === selectedOperation, `${label}.nativeReport.operation does not bind selected operation`);
    if (native.sourceTurn !== undefined) {
      const sourceTurn = validateArtifactRef(native.sourceTurn, root, errors, `${label}.nativeReport.sourceTurn`);
      // The ref is opened below through refs.rawTurn as well.  Keep this
      // check explicit so a normalized report cannot claim an unbound raw
      // turn by changing only its local source metadata.
      if (refs.rawTurn) add(errors, native.sourceTurn.sha256 === refs.rawTurn.sha256, `${label}.nativeReport.sourceTurn does not bind raw turn artifact`);
      if (sourceTurn && refs.rawTurn) add(errors, sourceTurn.sha256 === refs.rawTurn.sha256, `${label}.nativeReport.sourceTurn bytes do not bind raw turn artifact`);
    }
    if (native.sourceAction !== undefined && requireObject(errors, native.sourceAction, `${label}.nativeReport.sourceAction`)) {
      requireDigest(errors, native.sourceAction.rawActionSha256, `${label}.nativeReport.sourceAction.rawActionSha256`);
      requireDigest(errors, native.sourceAction.rawTurnSha256, `${label}.nativeReport.sourceAction.rawTurnSha256`);
      add(errors, native.sourceAction.rawActionSha256 === actual.action?.sourceAction?.rawActionSha256, `${label}.nativeReport.sourceAction does not bind action source hash`);
      add(errors, native.sourceAction.rawTurnSha256 === actual.action?.sourceAction?.rawTurnSha256, `${label}.nativeReport.sourceAction does not bind turn source hash`);
      add(errors, native.sourceAction.eventIndex === actual.action?.sourceAction?.eventIndex, `${label}.nativeReport.sourceAction event index does not bind action source`);
      if (native.sourceAction.rawAction !== undefined) {
        add(errors, native.sourceAction.rawActionSha256 === sha256Text(JSON.stringify(native.sourceAction.rawAction)), `${label}.nativeReport.sourceAction raw action hash does not match bytes`);
        const rawTurn = parseJsonBytes(refs.rawTurn, errors, `${label}.artifacts.rawTurn`);
        const event = rawTurn?.events?.[native.sourceAction.eventIndex]?.event;
        add(errors, event?.type === 'SKILL_ACTION', `${label}.nativeReport.sourceAction event does not identify a SKILL_ACTION`);
        if (event?.data?.action) add(errors, same(event.data.action, native.sourceAction.rawAction), `${label}.nativeReport.sourceAction raw action does not bind raw turn event`);
      }
    }
    nativeEvents = Array.isArray(native.events) ? native.events : [];
    add(errors, nativeEvents.length > 0, `${label}.nativeReport.events must be non-empty`);
    nativeEvents.forEach((event, index) => identity(event, `${label}.nativeReport.events[${index}]`, 'native'));
    const twoStage = hasTwoStageFlow(actual);
    const actionIndex = twoStage
      ? nativeEvents.findIndex((event) => event?.type === 'action' && wireStageName(event) === 'Tl')
      : nativeEvents.findIndex((event) => event?.type === 'action');
    const idleIndex = nativeEvents.findIndex((event) => event?.type === 'idle');
    add(errors, twoStage ? nativeEvents.filter((event) => event?.type === 'action').length === 2 : nativeEvents.filter((event) => event?.type === 'action').length === 1, `${label}.nativeReport action cardinality is invalid`);
    add(errors, nativeEvents.filter((event) => event?.type === 'idle').length === 1, `${label}.nativeReport must contain exactly one idle record`);
    add(errors, actionIndex === actual.logs?.native?.actionEventIndex, `${label}.nativeReport action index does not bind receipt logs`);
    add(errors, idleIndex === actual.logs?.native?.idleEventIndex, `${label}.nativeReport idle index does not bind receipt logs`);
    add(errors, nativeEvents.length === actual.logs?.native?.eventCount, `${label}.nativeReport event count does not bind receipt logs`);
    add(errors, actionIndex >= 0 && same(nativeEvents[actionIndex]?.payload, actual.action?.payload?.native), `${label}.nativeReport action payload does not bind native action`);
    add(errors, actionIndex >= 0 && nativeEvents[actionIndex]?.eventId === actual.correlation?.nativeActionEventId, `${label}.nativeReport action event ID does not bind correlation`);
    add(errors, idleIndex === nativeEvents.length - 1, `${label}.nativeReport final event must be idle`);
    if (idleIndex >= 0) {
      add(errors, nativeEvents[idleIndex]?.finalState === 'idle', `${label}.nativeReport final idle state is not idle`);
      add(errors, nativeEvents[idleIndex]?.skill === '@be/idle', `${label}.nativeReport final idle skill is not @be/idle`);
      add(errors, nativeEvents[idleIndex]?.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.nativeReport idle timestamp does not bind timeline idle`);
    }
    const requestIndex = twoStage
      ? nativeEvents.findIndex((event) => event?.type === 'request' && wireStageName(event) === 'Tl')
      : nativeEvents.findIndex((event) => event?.type === 'request');
    add(errors, requestIndex >= 0, `${label}.nativeReport must contain a request record`);
    add(errors, twoStage ? nativeEvents.filter((event) => event?.type === 'request').length === 2 : nativeEvents.filter((event) => event?.type === 'request').length === 1, `${label}.nativeReport request cardinality is invalid`);
    if (requestIndex >= 0) {
      const requestStage = twoStage ? wireFlowStage(actual, wireStageName(nativeEvents[requestIndex])) : null;
      add(errors, same(nativeEvents[requestIndex]?.body, requestStage?.body ?? actual.request?.body), `${label}.nativeReport request body does not bind actual request stage`);
      add(errors, nativeEvents[requestIndex]?.operation === selectedOperation, `${label}.nativeReport request operation does not bind selected operation`);
      add(errors, nativeEvents[requestIndex]?.endpoint === actual.request?.endpoint, `${label}.nativeReport request endpoint does not bind actual request`);
      add(errors, nativeEvents[requestIndex]?.bodySha256 === (requestStage?.bodySha256 ?? actual.request?.bodySha256), `${label}.nativeReport request body hash does not bind actual request stage`);
      add(errors, nativeEvents[requestIndex]?.bodySha256 === canonicalSha256(nativeEvents[requestIndex]?.body), `${label}.nativeReport request body hash is invalid`);
    }
    if (!Array.isArray(native.captures)) {
      errors.push(`${label}.nativeReport.captures must be an array`);
    } else {
      add(errors, native.captures.length === actual.screenshots?.length, `${label}.nativeReport capture count does not bind screenshots`);
      native.captures.forEach((capture, index) => {
        const shot = actual.screenshots?.[index];
        if (!requireObject(errors, capture, `${label}.nativeReport.captures[${index}]`)) return;
        add(errors, capture.caseId === descriptor.id, `${label}.nativeReport.captures[${index}].caseId does not bind case`);
        add(errors, capture.requestID === actual.correlation?.requestID, `${label}.nativeReport.captures[${index}].requestID does not bind correlation`);
        add(errors, capture.transID === actual.correlation?.transID, `${label}.nativeReport.captures[${index}].transID does not bind correlation`);
        add(errors, capture.operation === selectedOperation, `${label}.nativeReport.captures[${index}].operation does not bind selected operation`);
        add(errors, capture.viewOrdinal === shot?.viewOrdinal, `${label}.nativeReport.captures[${index}].viewOrdinal does not bind screenshot`);
        add(errors, capture.viewId === shot?.viewId, `${label}.nativeReport.captures[${index}].viewId does not bind screenshot`);
        add(errors, capture.captureKey === shot?.captureKey, `${label}.nativeReport.captures[${index}].captureKey does not bind screenshot`);
        add(errors, capture.artifactPath === shot?.path, `${label}.nativeReport.captures[${index}].artifactPath does not bind screenshot`);
        add(errors, capture.sha256 === shot?.sha256 && capture.pixelSha256 === shot?.pixelSha256, `${label}.nativeReport.captures[${index}] hashes do not bind screenshot bytes`);
        add(errors, capture.artifactIdentity === shot?.artifactIdentity, `${label}.nativeReport.captures[${index}].artifactIdentity does not bind screenshot`);
        if (capture.sourceScreenshot !== undefined || shot?.sourceScreenshot !== undefined) {
          add(errors, same(capture.sourceScreenshot, shot?.sourceScreenshot), `${label}.nativeReport.captures[${index}].sourceScreenshot does not bind screenshot source`);
          if (requireObject(errors, capture.sourceScreenshot, `${label}.nativeReport.captures[${index}].sourceScreenshot`)) {
            requireString(errors, capture.sourceScreenshot.filename, `${label}.nativeReport.captures[${index}].sourceScreenshot.filename`);
            requireDigest(errors, capture.sourceScreenshot.sha256, `${label}.nativeReport.captures[${index}].sourceScreenshot.sha256`);
            if (refs.rawTurn) {
              add(errors, capture.sourceScreenshot.rawTurnSha256 === undefined || capture.sourceScreenshot.rawTurnSha256 === refs.rawTurn.sha256, `${label}.nativeReport.captures[${index}].sourceScreenshot raw turn hash does not bind raw turn`);
              const rawTurn = parseJsonBytes(refs.rawTurn, errors, `${label}.artifacts.rawTurn`);
              const rawShot = rawTurn?.screenshots?.find((item) => item?.filename === capture.sourceScreenshot.filename);
              add(errors, Boolean(rawShot), `${label}.nativeReport.captures[${index}].sourceScreenshot filename is absent from raw turn`);
              if (rawShot) {
                add(errors, rawShot.sha256 === capture.sourceScreenshot.sha256, `${label}.nativeReport.captures[${index}].sourceScreenshot hash does not bind raw turn`);
                add(errors, rawShot.viewId === capture.viewId, `${label}.nativeReport.captures[${index}].sourceScreenshot view does not bind capture`);
              }
            }
          }
        }
        const captureTime = requireTimestamp(errors, capture.timestampISO, `${label}.nativeReport.captures[${index}].timestampISO`);
        const shotTime = timestampMs(shot?.captureAtISO);
        add(errors, captureTime !== null && shotTime !== null && captureTime === shotTime, `${label}.nativeReport.captures[${index}].timestampISO does not bind screenshot capture time`);
      });
    }
  }

  let wireRecords = [];
  if (wire.length) {
    wireRecords = wire;
    wire.forEach((record, index) => identity(record, `${label}.wireTrace[${index}]`, 'wire'));
    const wireMessageIds = new Set();
    wire.forEach((record, index) => {
      requireString(errors, record?.messageId, `${label}.wireTrace[${index}].messageId`);
      if (wireMessageIds.has(record?.messageId)) errors.push(`${label}.wireTrace duplicate messageId ${record?.messageId}`);
      wireMessageIds.add(record?.messageId);
    });
    const wireTypes = ['context', 'request', 'action', 'ack', 'idle'];
    const flowStages = wireFlowStages(actual);
    const hasTg = flowStages.some((stage) => wireStageName(stage) === 'Tg');
    const hasTl = flowStages.some((stage) => wireStageName(stage) === 'Tl');
    const stagedRecords = wire.some((record) => wireStageName(record) !== null);
    const twoStage = hasTg && hasTl && stagedRecords;
    const wireCounts = Object.fromEntries(wireTypes.map((type) => [type, wire.filter((record) => record?.type === type).length]));
    if (twoStage) {
      add(errors, wireCounts.context === 2, `${label}.wireTrace must contain exactly one context record per Tg/Tl stage`);
      add(errors, wireCounts.request === 2, `${label}.wireTrace must contain exactly one request record per Tg/Tl stage`);
      add(errors, wireCounts.action === 2, `${label}.wireTrace must contain exactly one action record per Tg/Tl stage`);
      // The SDK ACK is the HTTP response stored in rawTurn.ack. The raw wire
      // JSONL has no ACK record, so accepting a normalized one would let a
      // producer synthesize the missing acknowledgement.
      add(errors, wireCounts.ack === 0, `${label}.wireTrace must not contain a synthetic ACK record; bind Tg ACK through rawTurn.ack`);
      // Final idle is recorded by the native/turn snapshot. It is not a wire
      // message, so a normalized idle record would be synthetic evidence.
      add(errors, wireCounts.idle === 0, `${label}.wireTrace must not contain a synthetic idle record`);
      add(errors, flowStages.length === 2 && hasTg && hasTl, `${label}.wireFlow must describe exactly Tg and Tl stages`);
      const tg = wireFlowStage(actual, 'Tg');
      const tl = wireFlowStage(actual, 'Tl');
      for (const [stageName, stage] of [['Tg', tg], ['Tl', tl]]) {
        if (!requireObject(errors, stage, `${label}.wireFlow.${stageName}`)) continue;
        requireString(errors, stage.requestID, `${label}.wireFlow.${stageName}.requestID`);
        requireString(errors, stage.transID, `${label}.wireFlow.${stageName}.transID`);
        requireString(errors, stage.connectionId, `${label}.wireFlow.${stageName}.connectionId`);
        add(errors, stage.operation === undefined || stage.operation === selectedOperation, `${label}.wireFlow.${stageName}.operation does not bind selected operation`);
        if (stage.body !== undefined) {
          requireDigest(errors, stage.bodySha256, `${label}.wireFlow.${stageName}.bodySha256`);
          add(errors, stage.bodySha256 === canonicalSha256(stage.body), `${label}.wireFlow.${stageName}.bodySha256 does not match stage body`);
        }
      }
      add(errors, tg?.requestID !== tl?.requestID, `${label}.wireFlow Tg and Tl must use distinct request IDs`);
      add(errors, tg?.transID !== tl?.transID, `${label}.wireFlow Tg and Tl must use distinct trans IDs`);
      add(errors, tg?.connectionId !== tl?.connectionId, `${label}.wireFlow Tg and Tl must use distinct connection IDs`);
      add(errors, wire.every((record) => wireTypes.includes(record?.type) && (record?.type === 'idle' || wireStageName(record) !== null)), `${label}.wireTrace staged records must identify Tg or Tl`);
      const sessionIds = new Set(wire.map((record) => record?.sessionId ?? record?.sessionID).filter((value) => value !== undefined));
      const flowSessionId = actual.wireFlow?.sessionId ?? actual.wireFlow?.sessionID ?? actual.flow?.sessionId ?? actual.flow?.sessionID;
      if (flowSessionId !== undefined) add(errors, sessionIds.size === 1 && sessionIds.has(flowSessionId), `${label}.wireTrace records do not share the declared session`);
      else add(errors, sessionIds.size === 1, `${label}.wireFlow must declare or wire records must carry one shared session ID`);
      for (const stageName of ['Tg', 'Tl']) {
        const stageRecords = wire.filter((record) => wireStageName(record) === stageName);
        const stage = wireFlowStage(actual, stageName);
        add(errors, stageRecords.length >= 2, `${label}.wireTrace ${stageName} stage is incomplete`);
        add(errors, stageRecords.filter((record) => record?.type === 'context').length === 1, `${label}.wireTrace ${stageName} stage must contain exactly one context`);
        add(errors, stageRecords.filter((record) => record?.type === 'request').length === 1, `${label}.wireTrace ${stageName} stage must contain exactly one request`);
        add(errors, stageRecords.filter((record) => record?.type === 'action').length === 1, `${label}.wireTrace ${stageName} stage must contain exactly one action`);
        add(errors, stageRecords.filter((record) => record?.type === 'ack').length === 0, `${label}.wireTrace ${stageName} must not contain an ACK record`);
        if (stage?.connectionId !== undefined) stageRecords.forEach((record, index) => add(errors, record.connectionId === stage.connectionId, `${label}.wireTrace ${stageName} record ${index} connection does not bind flow`));
      }
    } else {
      // Legacy receipts may omit a standalone CONTEXT record.  The v2 lane
      // below performs the exact six-record/context checks independently;
      // retaining this branch keeps the pre-v2 fixture contract stable.
    }
    const actions = wire.filter((record) => record?.type === 'action');
    const initialAction = twoStage ? actions.find((record) => wireStageName(record) === 'Tg') : actions[0];
    const finalAction = twoStage ? actions.find((record) => wireStageName(record) === 'Tl') : actions[0];
    const actionIndex = finalAction ? wire.indexOf(finalAction) : -1;
    const ackIndex = wire.findIndex((record) => record?.type === 'ack');
    const idleIndex = wire.findIndex((record) => record?.type === 'idle');
    const contextIndex = wire.findIndex((record) => record?.type === 'context');
    const requestRecords = wire.filter((record) => record?.type === 'request');
    const requestIndex = twoStage
      ? wire.indexOf(requestRecords.find((record) => wireStageName(record) === 'Tl'))
      : wire.findIndex((record) => record?.type === 'request');
    add(errors, actionIndex === actual.logs?.wire?.actionMessageIndex, `${label}.wireTrace action index does not bind receipt logs`);
    add(errors, ackIndex === actual.logs?.wire?.ackMessageIndex, `${label}.wireTrace ack index does not bind receipt logs`);
    add(errors, wire.length === actual.logs?.wire?.messageCount, `${label}.wireTrace message count does not bind receipt logs`);
    add(errors, actionIndex >= 0 && same(wire[actionIndex]?.payload, actual.action?.payload?.wire), `${label}.wireTrace final action payload does not bind wire action`);
    add(errors, actionIndex >= 0 && wire[actionIndex]?.messageId === actual.correlation?.wireActionMessageId, `${label}.wireTrace final action message ID does not bind correlation`);
    if (twoStage) {
      const initialStage = wireFlowStage(actual, 'Tg');
      const finalStage = wireFlowStage(actual, 'Tl');
      const initialActionIndex = initialAction ? wire.indexOf(initialAction) : -1;
      const finalContextIndex = wire.findIndex((record) => record?.type === 'context' && wireStageName(record) === 'Tl');
      const finalRequestIndex = wire.findIndex((record) => record?.type === 'request' && wireStageName(record) === 'Tl');
      // The second local turn starts only after the global action. Context and
      // request ordering is transport-specific, but both precede the local
      // action. There is one final idle closure after that action.
      add(errors, initialActionIndex >= 0 && finalContextIndex > initialActionIndex && finalRequestIndex > initialActionIndex, `${label}.wireTrace Tl prelude must follow Tg action`);
      add(errors, finalContextIndex >= 0 && finalRequestIndex >= 0 && actionIndex > finalContextIndex && actionIndex > finalRequestIndex, `${label}.wireTrace Tl action must follow its context and request`);
      add(errors, finalStage?.connectionId === undefined || actual.correlation?.connectionId === finalStage.connectionId, `${label}.wireFlow Tl connection does not bind final correlation`);
      if (initialStage?.actionMessageId !== undefined) add(errors, initialAction?.messageId === initialStage.actionMessageId, `${label}.wireFlow Tg action message ID does not bind initial stage`);
      if (finalStage?.actionMessageId !== undefined) add(errors, finalAction?.messageId === finalStage.actionMessageId, `${label}.wireFlow Tl action message ID does not bind final stage`);
    } else add(errors, wire.every((record) => record?.connectionId === actual.correlation?.connectionId), `${label}.wireTrace connection IDs do not bind correlation`);
    add(errors, twoStage ? idleIndex === -1 && actionIndex === wire.length - 1 : idleIndex === wire.length - 1, twoStage ? `${label}.wireTrace must end at the final Tl action` : `${label}.wireTrace final record must be idle`);
    if (twoStage) add(errors, contextIndex >= 0 && requestIndex >= 0 && actionIndex > requestIndex, `${label}.wireTrace records are not in the required causal order`);
    if (idleIndex >= 0) {
      add(errors, wire[idleIndex]?.finalState === 'idle', `${label}.wireTrace final idle state is not idle`);
      add(errors, wire[idleIndex]?.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.wireTrace idle timestamp does not bind timeline idle`);
    }
    add(errors, requestIndex >= 0, `${label}.wireTrace must contain a request record`);
    add(errors, twoStage ? requestRecords.length === 2 : requestRecords.length === 1, `${label}.wireTrace request cardinality is invalid`);
    if (requestIndex >= 0) {
      const requestStage = twoStage ? wireFlowStage(actual, wireStageName(wire[requestIndex])) : null;
      add(errors, same(wire[requestIndex]?.body, requestStage?.body ?? actual.request?.body), `${label}.wireTrace request body does not bind actual request stage`);
      add(errors, wire[requestIndex]?.operation === selectedOperation, `${label}.wireTrace request operation does not bind selected operation`);
      add(errors, wire[requestIndex]?.endpoint === actual.request?.endpoint, `${label}.wireTrace request endpoint does not bind actual request`);
      add(errors, wire[requestIndex]?.bodySha256 === (requestStage?.bodySha256 ?? actual.request?.bodySha256), `${label}.wireTrace request body hash does not bind actual request stage`);
      add(errors, wire[requestIndex]?.bodySha256 === canonicalSha256(wire[requestIndex]?.body), `${label}.wireTrace request body hash is invalid`);
    }
    if (ackIndex >= 0) {
      const ack = wire[ackIndex];
      const ackAction = twoStage ? initialAction : finalAction;
      const ackStage = wireFlowStage(actual, 'Tg');
      requireDigest(errors, ack.payloadSha256, `${label}.wireTrace ack.payloadSha256`);
      requireDigest(errors, ack.actionPayloadSha256, `${label}.wireTrace ack.actionPayloadSha256`);
      add(errors, ack.ackFor === (twoStage ? (ackStage?.actionMessageId ?? ackAction?.messageId) : actual.correlation?.wireActionMessageId), `${label}.wireTrace ack.ackFor does not bind the acknowledged action message`);
      add(errors, same(ack.payload, ackAction?.payload || actual.action?.payload?.wire), `${label}.wireTrace ack payload does not bind acknowledged action payload`);
      add(errors, ack.payloadSha256 === canonicalSha256(ack.payload), `${label}.wireTrace ack.payloadSha256 does not match ACK payload`);
      add(errors, ack.payloadSha256 === canonicalSha256(ackAction?.payload || actual.action?.payload?.wire), `${label}.wireTrace ack.payloadSha256 does not bind acknowledged wire payload hash`);
      add(errors, ack.actionPayloadSha256 === (twoStage ? (ackStage?.actionPayloadSha256 ?? canonicalSha256(ackAction?.payload || {})) : actual.action?.payloadSha256), `${label}.wireTrace ack.actionPayloadSha256 does not bind acknowledged action payload hash`);
      add(errors, actual.logs?.wire?.ackPayloadSha256 === ack.payloadSha256, `${label}.logs.wire.ackPayloadSha256 does not bind ACK payload hash`);
    } else if (!twoStage) errors.push(`${label}.wireTrace must contain an ACK record`);
    validateWireSourceBindings(descriptor, actual, refs, wire, errors, label);
  }

  if (provider.length) {
    provider.forEach((record, index) => identity(record, `${label}.providerTrace[${index}]`, 'provider'));
    const calls = provider.filter((record) => record?.type === 'provider-call');
    add(errors, calls.length > 0, `${label}.providerTrace must contain a provider-call record`);
    calls.forEach((record, index) => {
      add(errors, same(record.provider, actual.provider), `${label}.providerTrace call ${index} does not bind actual provider projection`);
      add(errors, record.fixturePath === actual.artifacts?.providerFixture?.path, `${label}.providerTrace fixturePath does not bind provider fixture artifact`);
      add(errors, record.fixtureSha256 === actual.provider?.fixtureSha256, `${label}.providerTrace fixtureSha256 does not bind provider fixture artifact`);
    });
    const returns = provider.filter((record) => record?.type === 'provider-return');
    const twoStage = hasTwoStageFlow(actual);
    if (twoStage) {
      add(errors, returns.length === 0, `${label}.providerTrace must not contain a synthetic provider-return record`);
      validateProviderSourceBindings(actual, refs, provider, errors, label);
    } else {
      add(errors, returns.length > 0, `${label}.providerTrace must contain a provider-return record`);
      returns.forEach((record, index) => add(errors, same(record.provider, actual.provider), `${label}.providerTrace return ${index} does not bind actual provider projection`));
    }
    const providerIdleIndex = provider.findIndex((record) => record?.type === 'idle');
    add(errors, twoStage ? providerIdleIndex === -1 : providerIdleIndex === provider.length - 1, twoStage ? `${label}.providerTrace must not contain a synthetic idle record` : `${label}.providerTrace final record must be idle`);
    if (providerIdleIndex >= 0 && !twoStage) {
      add(errors, provider[providerIdleIndex]?.finalState === 'idle', `${label}.providerTrace final idle state is not idle`);
      add(errors, provider[providerIdleIndex]?.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.providerTrace idle timestamp does not bind timeline idle`);
    }
  }

  // The receipt's timeline is meaningful only if the independently parsed
  // traces tell the same causal story: request, action, ordered view opens,
  // captures, closes, and final idle. In a two-stage SDK capture the global
  // ACK lives in rawTurn.ack rather than the wire JSONL. These comparisons deliberately
  // use parsed artifact timestamps rather than the receipt's booleans.
  const nativeActionEvents = nativeEvents.filter((event) => event?.type === 'action');
  const nativeRequestEvents = nativeEvents.filter((event) => event?.type === 'request');
  const nativeActionRecord = nativeActionEvents.at(-1);
  const nativeRequestRecord = nativeRequestEvents.at(-1);
  const nativeActionTime = nativeActionRecord ? timestampMs(nativeActionRecord.timestampISO) : null;
  const nativeRequestTime = nativeRequestRecord ? timestampMs(nativeRequestRecord.timestampISO) : null;
  const nativeIdleTime = nativeEvents.find((event) => event?.type === 'idle') ? timestampMs(nativeEvents.find((event) => event?.type === 'idle').timestampISO) : null;
  const wireActionRecord = wireRecords.filter((record) => record?.type === 'action').at(-1);
  const wireRequestRecord = wireRecords.filter((record) => record?.type === 'request').at(-1);
  const wireActionTime = wireActionRecord ? timestampMs(wireActionRecord.timestampISO) : null;
  const wireRequestTime = wireRequestRecord ? timestampMs(wireRequestRecord.timestampISO) : null;
  const wireAckTime = wireRecords.find((record) => record?.type === 'ack') ? timestampMs(wireRecords.find((record) => record?.type === 'ack').timestampISO) : null;
  const wireIdleTime = wireRecords.find((record) => record?.type === 'idle') ? timestampMs(wireRecords.find((record) => record?.type === 'idle').timestampISO) : null;
  add(errors, nativeActionTime !== null, `${label} native action timestamp is missing`);
  add(errors, wireActionTime !== null, `${label} wire action timestamp is missing`);
  add(errors, nativeActionTime !== null && wireActionTime !== null && nativeActionTime === wireActionTime, `${label} native and wire action timestamps diverge`);
  add(errors, nativeRequestTime !== null && nativeActionTime !== null && nativeRequestTime <= nativeActionTime, `${label} native request occurs after native action`);
  add(errors, wireRequestTime !== null && wireActionTime !== null && wireRequestTime <= wireActionTime, `${label} wire request occurs after wire action`);
  const twoStage = hasTwoStageFlow(actual);
  add(errors, twoStage || (wireAckTime !== null && wireActionTime !== null && wireAckTime >= wireActionTime), `${label} wire ACK occurs before wire action`);
  add(errors, nativeIdleTime !== null && nativeActionTime !== null && nativeIdleTime > nativeActionTime, `${label} native idle occurs before native action`);
  add(errors, twoStage
    ? (wireIdleTime !== null && wireActionTime !== null && wireIdleTime > wireActionTime)
    : (wireIdleTime !== null && wireAckTime !== null && wireIdleTime > wireAckTime),
  twoStage ? `${label} wire idle occurs before final wire action` : `${label} wire idle occurs before wire ACK`);
  const firstViewOpen = Array.isArray(actual.timeline?.views) && actual.timeline.views.length ? timestampMs(actual.timeline.views[0].openedAtISO) : null;
  const idleTime = timestampMs(actual.timeline?.idle?.observedAtISO);
  add(errors, firstViewOpen !== null && nativeActionTime !== null && nativeActionTime <= firstViewOpen, `${label} first view opens before the native action`);
  if (Array.isArray(actual.timeline?.views)) {
    actual.timeline.views.forEach((view, index) => {
      const opened = timestampMs(view.openedAtISO);
      const closed = timestampMs(view.closedAtISO);
      const shot = actual.screenshots?.[index];
      const captured = timestampMs(shot?.captureAtISO);
      add(errors, opened !== null && captured !== null && captured >= opened, `${label} screenshot ${index} precedes its view opening`);
      add(errors, closed !== null && captured !== null && captured <= closed, `${label} screenshot ${index} follows its view close`);
      add(errors, closed !== null && idleTime !== null && closed < idleTime, `${label} view ${index} closes after final idle`);
    });
  }
  add(errors, nativeIdleTime !== null && idleTime !== null && nativeIdleTime === idleTime, `${label} native idle does not bind timeline idle`);
  add(errors, wireIdleTime !== null && idleTime !== null && wireIdleTime === idleTime, `${label} wire idle does not bind timeline idle`);

  const declaredStart = timestampMs(actual.traceRange?.startISO);
  const declaredEnd = timestampMs(actual.traceRange?.endISO);
  add(errors, declaredStart !== null, `${label}.traceRange.startISO must be an ISO timestamp`);
  add(errors, declaredEnd !== null, `${label}.traceRange.endISO must be an ISO timestamp`);
  if (declaredStart !== null && declaredEnd !== null) {
    add(errors, declaredEnd >= declaredStart, `${label}.traceRange.endISO must follow startISO`);
    times.forEach((time, index) => add(errors, time >= declaredStart && time <= declaredEnd, `${label} trace timestamp ${index} falls outside declared traceRange`));
    const capture = timestampMs(runtime.captureISO);
    add(errors, capture !== null && capture >= declaredStart && capture <= declaredEnd, `${label}.runtime.captureISO falls outside artifact traceRange`);
    validateCaptureWindowValue(actual.traceRange?.startISO, captureWindow, errors, `${label}.traceRange.startISO`);
    validateCaptureWindowValue(actual.traceRange?.endISO, captureWindow, errors, `${label}.traceRange.endISO`);
    times.forEach((time, index) => validateCaptureWindowValue(new Date(time).toISOString(), captureWindow, errors, `${label} trace timestamp ${index}`));
    if (times.length) {
      add(errors, declaredStart === Math.min(...times), `${label}.traceRange.startISO does not bind earliest artifact timestamp`);
      add(errors, declaredEnd === Math.max(...times), `${label}.traceRange.endISO does not bind latest artifact timestamp`);
    }
  }
  return { stack, native, wire: wireRecords, provider, times };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngArtifact(ref, errors, label) {
  const bytes = ref?.bytes;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes) return;
  add(errors, bytes.length >= 256, `${label} is implausibly small for a physical screenshot`);
  add(errors, bytes.subarray(0, 8).equals(signature), `${label} does not have a PNG signature`);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return;

  // Parse the complete chunk stream.  Checking only IHDR and the last eight
  // bytes permits a forged payload with truncated IDAT data, arbitrary bytes
  // after IEND, or a corrupt ancillary chunk.  Every declared length and CRC
  // is part of the physical artifact identity.
  let offset = 8;
  const chunks = [];
  let parseFailed = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      errors.push(`${label} has a truncated PNG chunk header or CRC`);
      parseFailed = true;
      break;
    }
    const length = bytes.readUInt32BE(offset);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) {
      errors.push(`${label} has an invalid PNG chunk type`);
      parseFailed = true;
      break;
    }
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      errors.push(`${label} ${type} chunk length exceeds artifact bytes`);
      parseFailed = true;
      break;
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const recordedCrc = bytes.readUInt32BE(offset + 8 + length);
    const computedCrc = crc32(Buffer.concat([typeBytes, data]));
    add(errors, recordedCrc === computedCrc, `${label} ${type} CRC does not match bytes`);
    chunks.push({ type, length, data, offset, end: chunkEnd });
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  add(errors, !parseFailed && offset === bytes.length, `${label} contains trailing or truncated bytes after its PNG chunk stream`);
  const iendIndexes = chunks.map((chunk, index) => chunk.type === 'IEND' ? index : -1).filter((index) => index >= 0);
  const ihdrIndexes = chunks.map((chunk, index) => chunk.type === 'IHDR' ? index : -1).filter((index) => index >= 0);
  const idatIndexes = chunks.map((chunk, index) => chunk.type === 'IDAT' ? index : -1).filter((index) => index >= 0);
  add(errors, chunks[0]?.type === 'IHDR', `${label} is missing a leading IHDR chunk`);
  add(errors, ihdrIndexes.length === 1, `${label} must contain exactly one IHDR chunk`);
  add(errors, iendIndexes.length === 1 && iendIndexes[0] === chunks.length - 1, `${label} must contain exactly one final IEND chunk`);
  add(errors, idatIndexes.length > 0, `${label} must contain at least one IDAT chunk`);
  if (idatIndexes.length > 1) {
    const first = idatIndexes[0];
    const last = idatIndexes.at(-1);
    add(errors, idatIndexes.length === last - first + 1, `${label} IDAT chunks must be contiguous`);
  }
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR') return;
  add(errors, ihdr.length === 13, `${label} IHDR length must be 13`);
  if (ihdr.length !== 13) return;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compressionMethod = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlaceMethod = ihdr.data[12];
  add(errors, width >= 320 && width <= 10000, `${label} width is outside physical-display bounds`);
  add(errors, height >= 200 && height <= 10000, `${label} height is outside physical-display bounds`);
  add(errors, width * height >= 64000, `${label} dimensions are too small for physical acceptance`);
  add(errors, [1, 2, 4, 8, 16].includes(bitDepth), `${label} has an unsupported PNG bit depth`);
  add(errors, [0, 2, 3, 4, 6].includes(colorType), `${label} has an unsupported PNG color type`);
  const validDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  };
  add(errors, validDepths[colorType]?.includes(bitDepth) === true, `${label} bit depth is invalid for PNG color type ${colorType}`);
  add(errors, compressionMethod === 0, `${label} has an unsupported PNG compression method`);
  add(errors, filterMethod === 0, `${label} has an unsupported PNG filter method`);
  add(errors, interlaceMethod === 0 || interlaceMethod === 1, `${label} has an unsupported PNG interlace method`);
  if (chunks.at(-1)?.type === 'IEND') add(errors, chunks.at(-1).length === 0, `${label} IEND chunk must be empty`);
  add(errors, idatIndexes.every((index) => chunks[index].length > 0), `${label} IDAT chunks must contain data`);

  if (!validDepths[colorType]?.includes(bitDepth) || ![0, 1].includes(interlaceMethod) || compressionMethod !== 0 || filterMethod !== 0 || idatIndexes.length === 0) return;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = (pixelWidth) => Math.ceil((pixelWidth * bitsPerPixel) / 8);
  const passes = interlaceMethod === 0
    ? [[0, 0, 1, 1, width, height]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]].map(([x, y, dx, dy]) => [x, y, dx, dy, x < width ? Math.ceil((width - x) / dx) : 0, y < height ? Math.ceil((height - y) / dy) : 0]);
  const expectedBytes = passes.reduce((sum, pass) => sum + (pass[5] * (rowBytes(pass[4]) + 1)), 0);
  let inflated;
  try {
    // A bounded inflate keeps a corrupt or hostile screenshot from allocating
    // an unbounded buffer before the scanline length check below.
    inflated = zlib.inflateSync(Buffer.concat(idatIndexes.map((index) => chunks[index].data)), { maxOutputLength: expectedBytes + 1 });
  } catch (error) {
    errors.push(`${label} IDAT zlib stream is invalid: ${error.message}`);
    return;
  }
  add(errors, inflated.length === expectedBytes, `${label} IDAT scanline byte length ${inflated.length} does not match expected ${expectedBytes}`);
  if (inflated.length !== expectedBytes) return;
  let cursor = 0;
  passes.forEach((pass, passIndex) => {
    const passWidth = pass[4];
    const passHeight = pass[5];
    const bytesPerRow = rowBytes(passWidth);
    for (let row = 0; row < passHeight; row += 1) {
      const filter = inflated[cursor];
      add(errors, filter <= 4, `${label} scanline filter ${filter} is invalid at pass ${passIndex}, row ${row}`);
      cursor += bytesPerRow + 1;
    }
  });
}

// Small pure entry point used by the adversarial tests and by independent
// reviewers that want to check a screenshot before constructing a receipt.
export function validatePngBytes(bytes) {
  const errors = [];
  const ref = { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []) };
  validatePngArtifact(ref, errors, 'png');
  return { result: errors.length ? 'fail' : 'pass', errors };
}

/*
 * v2 physical evidence contract
 * --------------------------------
 * The original receipt format mixed derived summaries with transport rows.
 * That made it possible to add an ACK, an idle row, or a provider return to a
 * normalized file even when the capture never contained one.  v2 keeps the
 * summaries for review, but validates them against the raw turn and raw
 * JSONL line bytes.  Every predicate below is deliberately type-specific:
 * audio, close, connection, shutdown, and provider rows are not forced to
 * carry message identities that their source protocol does not define.
 */

const V2_WIRE_TYPES = Object.freeze(['context', 'request', 'action']);
const V2_FORBIDDEN_WIRE_TYPES = new Set(['ack', 'idle', 'provider-return', 'provider-idle']);

function v2ExpectedProviderServices(descriptor) {
  if (Array.isArray(descriptor?.provider?.services)) return descriptor.provider.services;
  if (descriptor?.domain === 'commute') return ['settings', 'maps'];
  if (descriptor?.id === 'calendar-concurrent-parallel' || descriptor?.provider?.parallel === true) {
    return ['settings', 'google-calendar', 'outlook-calendar'];
  }
  if (descriptor?.domain === 'calendar') return ['settings', 'google-calendar'];
  return [];
}

function v2RawWireType(record) {
  if (!isObject(record)) return null;
  if (record.kind === 'client-audio') return 'audio';
  if (record.kind === 'connection') return 'connection';
  if (record.kind === 'close') return 'close';
  if (record.kind === 'shutdown') return 'shutdown';
  if (record.kind === 'fixture-provider') return 'provider';
  const type = record.json?.type ?? record.type;
  if (type === 'CONTEXT') return 'context';
  if (type === 'LISTEN' || type === 'CLIENT_ASR') return 'request';
  if (type === 'SKILL_ACTION') return 'action';
  if (type === 'ACK' || type === 'ack') return 'ack';
  if (type === 'IDLE' || type === 'idle') return 'idle';
  if (record.kind === 'client-message') return 'client-message';
  if (record.kind === 'server-message') return 'server-message';
  return type || record.kind || null;
}

function v2StageNames(actual) {
  const stages = wireFlowStages(actual);
  const names = stages.map((stage) => wireStageName(stage) || stage.stage).filter(Boolean);
  return { stages, names };
}

// A physical report turn has exactly two lawful shapes, and which one occurs
// is not the capture operator's choice.  The original report graph decides it
// in packages/report-skill/src/subgraphs/userid/UserIDFactory.ts: its
// `checkSpeakerID` reads `data.runtime.perception.speaker` and, because a
// commute or calendar single-skill report always needs a speaker, a truthy
// speaker takes the True edge straight to UserID Done.  The WhoIsThis question
// node is then unreachable, so no whoIsThisMenu prelude and no local follow-up
// turn can exist.  A falsy speaker takes the False edge and must produce both.
// The shape is therefore derived from the raw CONTEXT line the robot sent and
// the receipt must agree with it: a receipt cannot invent a second stage, and
// cannot quietly drop one.
const V2_SHAPES = Object.freeze({
  'one-stage': Object.freeze({
    stages: Object.freeze(['Tg']),
    target: 'Tg',
    schema: 'phoenix.s13.one-stage-wire-flow.v1',
    wireRecords: 3,
    nativeActions: 1,
    nativeRequests: 1,
    turnStarted: 1,
    skillActions: 1,
    excludedPrelude: 0,
    followupUsed: false,
    followupCalls: 0
  }),
  'two-stage': Object.freeze({
    stages: Object.freeze(['Tg', 'Tl']),
    target: 'Tl',
    schema: 'phoenix.s13.two-stage-wire-flow.v1',
    wireRecords: 6,
    nativeActions: 2,
    nativeRequests: 2,
    turnStarted: 2,
    skillActions: 2,
    excludedPrelude: 1,
    followupUsed: true,
    followupCalls: 1
  })
});

function v2RawSpeakerIdentified(raw) {
  return Boolean(raw?.json?.data?.runtime?.perception?.speaker);
}

// The global stage's own raw CONTEXT line is the only admissible witness.
function v2GlobalContextRow(rawRows, globalStage) {
  if (!Array.isArray(rawRows) || !globalStage) return null;
  const matches = rawRows
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.kind === 'client-message'
      && record.json?.type === 'CONTEXT'
      && v2RawTransId(record) === globalStage.transID
      && v2SameConnection(globalStage, record));
  return matches.length === 1 ? matches[0] : null;
}

function v2DerivedShape(rawRows, globalStage) {
  const row = v2GlobalContextRow(rawRows, globalStage);
  if (!row) return null;
  return v2RawSpeakerIdentified(row.record) ? 'one-stage' : 'two-stage';
}

function v2ConnectionToken(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const match = text.match(/(?:^|[-_:])connection[-_:](.+)$/i);
  return match ? match[1] : text;
}

function v2SameConnection(stage, raw) {
  const expected = stage?.rawConnectionId ?? stage?.wireConnectionId ?? stage?.connectionId;
  if (expected === undefined || raw?.id === undefined) return false;
  return v2ConnectionToken(expected) === v2ConnectionToken(raw.id);
}

function v2RawJson(record) {
  return isObject(record?.json) ? record.json : record;
}

function v2RawMessageId(record) {
  const json = v2RawJson(record);
  return json?.msgID ?? json?.messageId ?? record?.messageId;
}

function v2RawTransId(record) {
  const json = v2RawJson(record);
  return json?.transID ?? record?.transID ?? record?.input?.transID;
}

function v2RawAt(record) {
  return record?.at ?? record?.timestampISO ?? v2RawJson(record)?.at ?? v2RawJson(record)?.timestampISO;
}

function v2SourceLine(ref, source, errors, label) {
  if (!requireObject(errors, source, `${label}.source`)) return null;
  add(errors, Number.isInteger(source.line) && source.line >= 0, `${label}.source.line must be a non-negative integer`);
  requireDigest(errors, source.sha256, `${label}.source.sha256`);
  requireDigest(errors, source.traceSha256, `${label}.source.traceSha256`);
  add(errors, source.traceSha256 === ref?.sha256, `${label}.source.traceSha256 must bind rawWire bytes`);
  if (!Number.isInteger(source.line) || source.line < 0 || !ref) return null;
  const selected = parseJsonlLineAt(ref, source.line, errors, `${label}.source`);
  if (!selected) return null;
  add(errors, source.sha256 === sha256Bytes(selected.bytes), `${label}.source.sha256 does not match raw line bytes`);
  add(errors, source.kind === selected.value.kind, `${label}.source.kind does not match raw line kind`);
  if (selected.value.id !== undefined) add(errors, source.id === selected.value.id, `${label}.source.id does not match raw line id`);
  const messageId = v2RawMessageId(selected.value);
  if (messageId !== undefined) add(errors, source.messageId === messageId, `${label}.source.messageId does not match raw line message ID`);
  const messageType = v2RawJson(selected.value)?.type;
  if (messageType !== undefined) add(errors, source.messageType === messageType, `${label}.source.messageType does not match raw line type`);
  return selected;
}

function v2ValidateRawWire(descriptor, actual, refs, errors, label) {
  const raw = parseJsonlBytes(refs?.rawWire, errors, `${label}.artifacts.rawWire`);
  const result = { raw, providerRows: [], stageRows: new Map() };
  if (!raw.length) return result;
  raw.forEach((record, index) => {
    const recordLabel = `${label}.rawWire[${index}]`;
    if (!requireObject(errors, record, recordLabel)) return;
    requireString(errors, record.kind, `${recordLabel}.kind`);
    requireTimestamp(errors, v2RawAt(record), `${recordLabel}.at`);
    if (V2_FORBIDDEN_WIRE_TYPES.has(record.type)) errors.push(`${recordLabel} contains forbidden synthetic ${record.type} evidence`);
    if (['ACK', 'IDLE', 'ack', 'idle'].includes(record.json?.type)) errors.push(`${recordLabel} may not encode ACK/idle in raw wire`);
    const type = v2RawWireType(record);
    if (V2_FORBIDDEN_WIRE_TYPES.has(type)) errors.push(`${recordLabel} contains forbidden synthetic ${type} evidence`);
    if (record.kind === 'client-audio') {
      // Audio frames carry physical bytes and a socket id.  They do not carry
      // JSON message/trans IDs, so only validate the fields the frame format
      // actually supplies.
      add(errors, record.id !== undefined, `${recordLabel}.id is required for client-audio`);
      add(errors, Number.isInteger(record.bytes) && record.bytes >= 0, `${recordLabel}.bytes must be a non-negative integer`);
      if (record.sha256 !== undefined) requireDigest(errors, record.sha256, `${recordLabel}.sha256`);
      return;
    }
    if (record.kind === 'connection' || record.kind === 'close') {
      add(errors, record.id !== undefined, `${recordLabel}.id is required for ${record.kind}`);
      if (record.kind === 'close' && record.code !== undefined) add(errors, Number.isInteger(record.code), `${recordLabel}.code must be an integer`);
      return;
    }
    if (record.kind === 'shutdown') return;
    if (record.kind === 'fixture-provider') {
      requireString(errors, record.service, `${recordLabel}.service`);
      requireString(errors, record.caseId, `${recordLabel}.caseId`);
      add(errors, isObject(record.input), `${recordLabel}.input must be an object`);
      requireTimestamp(errors, record.at, `${recordLabel}.at`);
      result.providerRows.push({ record, index });
      return;
    }
    if (record.kind === 'client-message' || record.kind === 'server-message') {
      add(errors, isObject(record.json), `${recordLabel}.json must be an object`);
      requireTimestamp(errors, record.at, `${recordLabel}.at`);
      const messageType = record.json?.type;
      requireString(errors, messageType, `${recordLabel}.json.type`);
      add(errors, !['ACK', 'IDLE', 'ack', 'idle'].includes(messageType), `${recordLabel} may not encode ACK/idle in raw wire`);
      if (record.kind === 'client-message' && ['CONTEXT', 'LISTEN', 'CLIENT_ASR'].includes(messageType)) {
        requireString(errors, record.json?.transID, `${recordLabel}.json.transID`);
      }
      if (record.kind === 'server-message' && messageType === 'SKILL_ACTION') {
        add(errors, isObject(record.json?.data?.action), `${recordLabel}.json.data.action must be an object`);
      }
    }
  });
  return result;
}

function v2ValidateFlow(descriptor, actual, refs, rawWire, errors, label) {
  const { stages, names } = v2StageNames(actual);
  const declaredShape = actual.wireFlow?.shape;
  add(errors, Object.hasOwn(V2_SHAPES, declaredShape || ''), `${label}.wireFlow.shape must be one-stage or two-stage`);
  const tg = stages.find((stage) => wireStageName(stage) === 'Tg');
  const tl = stages.find((stage) => wireStageName(stage) === 'Tl');
  const rawRowsForShape = parseJsonlBytes(refs?.rawWire, errors, `${label}.artifacts.rawWire`);
  const derivedShape = v2DerivedShape(rawRowsForShape, tg);
  add(errors, derivedShape !== null, `${label}.wireFlow shape cannot be derived: the Tg stage has no unique raw CONTEXT line`);
  add(errors, derivedShape === null || declaredShape === derivedShape, `${label}.wireFlow.shape (${declaredShape}) disagrees with the raw CONTEXT speaker state (${derivedShape})`);
  const spec = V2_SHAPES[derivedShape] || V2_SHAPES[declaredShape] || V2_SHAPES['two-stage'];
  const expectedStages = spec.stages;
  const oneStage = spec.target === 'Tg';
  const target = oneStage ? tg : tl;

  // The speaker state must cite the same raw line the shape was derived from,
  // and may never copy the looper identifier itself into the receipt.
  const speakerState = actual.wireFlow?.speakerState;
  if (requireObject(errors, speakerState, `${label}.wireFlow.speakerState`)) {
    const contextRow = v2GlobalContextRow(rawRowsForShape, tg);
    add(errors, speakerState.schema === 'phoenix.s13.speaker-state.v1', `${label}.wireFlow.speakerState.schema is invalid`);
    add(errors, speakerState.field === 'data.runtime.perception.speaker', `${label}.wireFlow.speakerState.field must name the source predicate input`);
    add(errors, speakerState.identified === oneStage, `${label}.wireFlow.speakerState.identified does not match the derived ${derivedShape} shape`);
    add(errors, contextRow !== null && speakerState.sourceLine === contextRow.index, `${label}.wireFlow.speakerState.sourceLine does not bind the raw Tg CONTEXT line`);
    add(errors, contextRow === null || speakerState.sourceMessageId === (contextRow.record.json?.msgID ?? null), `${label}.wireFlow.speakerState.sourceMessageId does not bind the raw Tg CONTEXT line`);
    add(errors, speakerState.derivedShape === derivedShape, `${label}.wireFlow.speakerState.derivedShape does not bind the derived shape`);
    const speakerId = contextRow?.record?.json?.data?.runtime?.perception?.speaker;
    const serialized = JSON.stringify(speakerState);
    add(errors, !speakerId || !serialized.includes(String(speakerId)), `${label}.wireFlow.speakerState may not copy the raw speaker identifier`);
  }

  add(errors, actual.wireFlow?.schema === spec.schema, `${label}.wireFlow.schema must identify the ${derivedShape} flow`);
  add(errors, stages.length === expectedStages.length, `${label}.wireFlow must contain exactly ${expectedStages.length} stage(s) for a ${derivedShape} capture`);
  add(errors, same(names, [...expectedStages]), `${label}.wireFlow stages must be exactly ${expectedStages.join(' then ')}`);
  add(errors, oneStage ? tl === undefined : tl !== undefined, oneStage
    ? `${label}.wireFlow may not declare a Tl stage: the recognized speaker never opened a local turn`
    : `${label}.wireFlow must declare a Tl stage`);
  const flowSessionId = actual.wireFlow?.sessionId ?? actual.wireFlow?.sessionID;
  for (const [name, stage] of expectedStages.map((stageName) => [stageName, stageName === 'Tg' ? tg : tl])) {
    if (!requireObject(errors, stage, `${label}.wireFlow.${name}`)) continue;
    requireString(errors, stage.requestID, `${label}.wireFlow.${name}.requestID`);
    requireString(errors, stage.transID, `${label}.wireFlow.${name}.transID`);
    requireString(errors, stage.connectionId, `${label}.wireFlow.${name}.connectionId`);
    add(errors, !String(stage.connectionId).includes('missing-'), `${label}.wireFlow.${name}.connectionId may not be a placeholder`);
    add(errors, stage.operation === undefined || stage.operation === actual.request?.operation, `${label}.wireFlow.${name}.operation does not bind request`);
    if (stage.body !== undefined) {
      requireDigest(errors, stage.bodySha256, `${label}.wireFlow.${name}.bodySha256`);
      add(errors, stage.bodySha256 === canonicalSha256(stage.body), `${label}.wireFlow.${name}.bodySha256 does not match body`);
    }
  }
  if (!oneStage) {
    add(errors, tg?.requestID !== tl?.requestID, `${label}.wireFlow Tg/Tl request IDs must be distinct`);
    add(errors, tg?.transID !== tl?.transID, `${label}.wireFlow Tg/Tl trans IDs must be distinct`);
    add(errors, tg?.connectionId !== tl?.connectionId, `${label}.wireFlow Tg/Tl connection IDs must be distinct`);
  }
  requireString(errors, flowSessionId, `${label}.wireFlow.sessionId`);

  const raw = parseJsonlBytes(refs?.rawWire, errors, `${label}.artifacts.rawWire`);
  const wire = parseJsonlBytes(refs?.wireTrace, errors, `${label}.artifacts.wireTrace`);
  const sourceLines = new Set();
  const counts = { Tg: { context: 0, request: 0, action: 0 }, Tl: { context: 0, request: 0, action: 0 } };
  add(errors, wire.length === spec.wireRecords, `${label}.wireTrace must contain exactly ${spec.wireRecords} staged records for a ${derivedShape} capture`);
  wire.forEach((record, index) => {
    const recordLabel = `${label}.wireTrace[${index}]`;
    if (!requireObject(errors, record, recordLabel)) return;
    add(errors, V2_WIRE_TYPES.includes(record.type), `${recordLabel}.type must be context/request/action`);
    add(errors, !V2_FORBIDDEN_WIRE_TYPES.has(record.type), `${recordLabel}.type may not be ${record.type}`);
    const stageName = wireStageName(record);
    add(errors, expectedStages.includes(stageName), `${recordLabel} must identify ${expectedStages.join(' or ')}`);
    if (stageName && V2_WIRE_TYPES.includes(record.type)) counts[stageName][record.type] += 1;
    requireString(errors, record.caseId, `${recordLabel}.caseId`);
    add(errors, record.caseId === descriptor.id, `${recordLabel}.caseId does not bind matrix case`);
    requireString(errors, record.requestID, `${recordLabel}.requestID`);
    requireString(errors, record.transID, `${recordLabel}.transID`);
    requireString(errors, record.connectionId, `${recordLabel}.connectionId`);
    requireString(errors, record.timestampISO, `${recordLabel}.timestampISO`);
    requireTimestamp(errors, record.timestampISO, `${recordLabel}.timestampISO`);
    requireString(errors, record.messageId, `${recordLabel}.messageId`);
    const source = v2SourceLine(refs.rawWire, record.source, errors, recordLabel);
    if (!source) return;
    if (sourceLines.has(source.line)) errors.push(`${label}.wireTrace source line ${source.line} is selected more than once`);
    sourceLines.add(source.line);
    const raw = source.value;
    const rawType = v2RawWireType(raw);
    add(errors, rawType === record.type, `${recordLabel} source line type does not match normalized type`);
    add(errors, record.timestampISO === v2RawAt(raw), `${recordLabel}.timestampISO does not bind raw line at`);
    const stage = stageName === 'Tg' ? tg : tl;
    add(errors, v2SameConnection(stage, raw), `${recordLabel} source connection does not bind ${stageName}`);
    if (record.type === 'request') {
      add(errors, raw.kind === 'client-message' && ['LISTEN', 'CLIENT_ASR'].includes(raw.json?.type), `${recordLabel} request source must be a client LISTEN/CLIENT_ASR line`);
      if (stage?.requestType) add(errors, raw.json?.type === stage.requestType, `${recordLabel} source request type does not bind ${stageName}`);
      add(errors, v2RawTransId(raw) === stage?.transID, `${recordLabel} source request transID does not bind ${stageName}`);
      requireObject(errors, record.body, `${recordLabel}.body`);
      requireDigest(errors, record.bodySha256, `${recordLabel}.bodySha256`);
      add(errors, record.bodySha256 === canonicalSha256(record.body), `${recordLabel}.bodySha256 does not match body`);
      if (stage?.body !== undefined) add(errors, same(record.body, stage.body), `${recordLabel}.body does not bind stage body`);
    } else if (record.type === 'context') {
      add(errors, raw.kind === 'client-message' && raw.json?.type === 'CONTEXT', `${recordLabel} context source must be a client CONTEXT line`);
      add(errors, v2RawTransId(raw) === stage?.transID, `${recordLabel} context source transID does not bind ${stageName}`);
      add(errors, record.messageId === v2RawMessageId(raw), `${recordLabel}.messageId does not bind raw context message ID`);
      const location = raw.json?.data?.runtime?.location?.iso;
      add(errors, record.runtimeLocationISO === location, `${recordLabel}.runtimeLocationISO does not bind raw context location`);
    } else if (record.type === 'action') {
      add(errors, raw.kind === 'server-message' && raw.json?.type === 'SKILL_ACTION', `${recordLabel} action source must be a server SKILL_ACTION line`);
      add(errors, record.messageId === v2RawMessageId(raw), `${recordLabel}.messageId does not bind raw action message ID`);
      const rawAction = raw.json?.data?.action;
      const rawActionSha256 = rawAction ? sha256Text(JSON.stringify(rawAction)) : null;
      add(errors, record.rawActionSha256 === undefined || record.rawActionSha256 === rawActionSha256, `${recordLabel}.rawActionSha256 does not bind raw action bytes`);
      add(errors, stage?.actionPayloadSha256 === undefined || stage.actionPayloadSha256 === rawActionSha256, `${recordLabel} ${stageName} action hash does not bind flow stage`);
      if (stageName === spec.target) add(errors, same(record.payload, actual.action?.payload?.wire), `${recordLabel} ${stageName} target action payload does not bind actual wire payload`);
    }
    add(errors, record.sessionId === flowSessionId || record.sessionID === flowSessionId, `${recordLabel} does not bind shared flow session`);
  });
  for (const stageName of expectedStages) for (const type of V2_WIRE_TYPES) {
    add(errors, counts[stageName][type] === 1, `${label}.wireTrace ${stageName} must contain exactly one ${type}`);
  }
  if (oneStage) for (const type of V2_WIRE_TYPES) {
    add(errors, counts.Tl[type] === 0, `${label}.wireTrace may not contain a Tl ${type} record`);
  }
  // The normalized six rows are only meaningful when the raw socket really
  // contains the complete stage.  The raw protocol has one CONTEXT, one
  // LISTEN, one CLIENT_ASR, and one server SKILL_ACTION on each connection;
  // server rows intentionally have no transID and are selected by socket.
  for (const [stageName, stage] of expectedStages.map((name) => [name, name === 'Tg' ? tg : tl])) {
    const stageRaw = raw.filter((record) => v2SameConnection(stage, record));
    const contextRows = stageRaw.filter((record) => record?.kind === 'client-message' && record.json?.type === 'CONTEXT' && v2RawTransId(record) === stage?.transID);
    const listenRows = stageRaw.filter((record) => record?.kind === 'client-message' && record.json?.type === 'LISTEN' && v2RawTransId(record) === stage?.transID);
    const asrRows = stageRaw.filter((record) => record?.kind === 'client-message' && record.json?.type === 'CLIENT_ASR' && v2RawTransId(record) === stage?.transID);
    const actionRows = stageRaw.filter((record) => record?.kind === 'server-message' && record.json?.type === 'SKILL_ACTION');
    add(errors, contextRows.length === 1, `${label}.rawWire ${stageName} must contain exactly one CONTEXT for its transID`);
    add(errors, listenRows.length === 1, `${label}.rawWire ${stageName} must contain exactly one LISTEN for its transID`);
    add(errors, asrRows.length === 1, `${label}.rawWire ${stageName} must contain exactly one CLIENT_ASR for its transID`);
    add(errors, actionRows.length === 1, `${label}.rawWire ${stageName} must contain exactly one SKILL_ACTION on its connection`);
  }
  const targetActionIndex = wire.findIndex((record) => record?.type === 'action' && wireStageName(record) === spec.target);
  add(errors, targetActionIndex === actual.logs?.wire?.actionMessageIndex, `${label}.logs.wire.actionMessageIndex must point at the final ${spec.target} action`);
  add(errors, actual.logs?.wire?.ackMessageIndex === -1 || actual.logs?.wire?.ackMessageIndex === undefined, `${label}.logs.wire.ackMessageIndex must be absent/-1`);
  add(errors, actual.logs?.wire?.idleMessageIndex === -1 || actual.logs?.wire?.idleMessageIndex === undefined, `${label}.logs.wire.idleMessageIndex must be absent/-1`);
  add(errors, actual.logs?.wire?.messageCount === wire.length, `${label}.logs.wire.messageCount does not bind wire rows`);
  add(errors, wire.every((record) => record?.type !== 'ack' && record?.type !== 'idle'), `${label}.wireTrace may not contain ACK/idle rows`);
  const tgActionIndex = wire.findIndex((record) => record?.type === 'action' && wireStageName(record) === 'Tg');
  if (oneStage) {
    const tgContextIndex = wire.findIndex((record) => record?.type === 'context' && wireStageName(record) === 'Tg');
    const tgRequestIndex = wire.findIndex((record) => record?.type === 'request' && wireStageName(record) === 'Tg');
    add(errors, tgContextIndex >= 0 && tgRequestIndex >= 0 && targetActionIndex > tgContextIndex && targetActionIndex > tgRequestIndex, `${label}.wireTrace Tg action must follow its context and request`);
    add(errors, targetActionIndex === wire.length - 1, `${label}.wireTrace must end at the Tg action`);
  } else {
    const tlContextIndex = wire.findIndex((record) => record?.type === 'context' && wireStageName(record) === 'Tl');
    const tlRequestIndex = wire.findIndex((record) => record?.type === 'request' && wireStageName(record) === 'Tl');
    add(errors, tgActionIndex >= 0 && tlContextIndex > tgActionIndex && tlRequestIndex > tgActionIndex, `${label}.wireTrace Tl must follow Tg action`);
    add(errors, tlContextIndex >= 0 && tlRequestIndex >= 0 && targetActionIndex > tlContextIndex && targetActionIndex > tlRequestIndex, `${label}.wireTrace Tl action must follow context/request`);
  }
  return { rawWire: raw, rawWireRows: raw.map((record, index) => ({ record, index })), wire, stages: { Tg: tg, Tl: tl }, target, spec, shape: derivedShape, oneStage, expectedStages, targetActionIndex, tgActionIndex };
}

function v2TurnEventRow(rawTurn, index) {
  const item = rawTurn?.events?.[index];
  return isObject(item?.event) ? item.event : isObject(item) ? item : null;
}

function v2ActionAt(rawTurn, index) {
  return v2TurnEventRow(rawTurn, index)?.data?.action;
}

function v2ActionNodeAt(event, actionPath) {
  if (!isObject(event?.data?.action) || !Array.isArray(actionPath) || actionPath.length < 2) return undefined;
  if (actionPath[0] !== 'data' || actionPath[1] !== 'action') return undefined;
  return actionPath.slice(2).reduce((value, key) => value?.[key], event.data.action);
}

function v2SnapshotIdle(snapshot) {
  const be = snapshot?.be ?? snapshot;
  return be?.skill === '@be/idle' && be?.view === 'eyeView' && be?.listen === 'Idle' && be?.talking === false;
}

function v2SourceSnapshot(event, rawTurnRef, finalIdleIndex, errors, label) {
  const source = event?.sourceSnapshot ?? event?.source ?? {};
  const index = source.snapshotIndex ?? source.rawSnapshotIndex ?? event?.snapshotIndex ?? event?.rawSnapshotIndex;
  add(errors, Number.isInteger(index) && index >= 0, `${label}.sourceSnapshot.snapshotIndex must identify a raw turn snapshot`);
  if (Number.isInteger(index)) add(errors, index === finalIdleIndex, `${label}.sourceSnapshot.snapshotIndex must identify the final post-restore idle snapshot`);
  const rawTurnSha256 = source.rawTurnSha256 ?? source.turnSha256 ?? source.sha256;
  requireDigest(errors, rawTurnSha256, `${label}.sourceSnapshot.rawTurnSha256`);
  add(errors, rawTurnSha256 === rawTurnRef?.sha256, `${label}.sourceSnapshot.rawTurnSha256 does not bind rawTurn bytes`);
  return index;
}

function v2ValidateRawTurn(descriptor, actual, refs, flow, errors, label) {
  const rawTurn = parseJsonBytes(refs?.rawTurn, errors, `${label}.artifacts.rawTurn`);
  if (!rawTurn) return { rawTurn: null, finalIdleIndex: null, targetEvent: null, preludeEvent: null, targetDisplays: [] };
  add(errors, rawTurn.preflight?.idleRequired === true, `${label}.rawTurn.preflight.idleRequired must be true`);
  add(errors, rawTurn.preflight?.idle === true, `${label}.rawTurn.preflight.idle must be true`);
  if (rawTurn.preflight?.snapshot !== undefined) add(errors, v2SnapshotIdle(rawTurn.preflight.snapshot), `${label}.rawTurn.preflight.snapshot must be a native idle snapshot`);
  const tg = flow?.stages?.Tg;
  const tl = flow?.stages?.Tl;
  const spec = flow?.spec || V2_SHAPES['two-stage'];
  const oneStage = spec.target === 'Tg';
  const targetStage = oneStage ? tg : tl;
  requireString(errors, rawTurn.request?.via, `${label}.rawTurn.request.via`);
  add(errors, /original\s+BE\s+Jetstream\s+SDK/i.test(rawTurn.request?.via || ''), `${label}.rawTurn.request.via must identify the original BE Jetstream SDK`);
  if (!requireObject(errors, rawTurn.ack, `${label}.rawTurn.ack`)) return { rawTurn, finalIdleIndex: null, targetEvent: null, preludeEvent: null, targetDisplays: [] };
  for (const key of ['acks', 'ackEvents', 'wireAcks']) {
    if (rawTurn[key] !== undefined) add(errors, Array.isArray(rawTurn[key]) && rawTurn[key].length === 0, `${label}.rawTurn.${key} must be empty; the sole ACK is rawTurn.ack`);
  }
  const encodedAcks = (rawTurn.events || []).filter((item) => ['ACK', 'ack'].includes((item?.event ?? item)?.type));
  add(errors, encodedAcks.length === 0, `${label}.rawTurn.events must not duplicate the SDK ACK`);
  requireString(errors, rawTurn.ack.requestID, `${label}.rawTurn.ack.requestID`);
  add(errors, rawTurn.ack.requestID === tg?.ackRequestID || rawTurn.ack.requestID === tg?.requestID || rawTurn.ack.requestID === tg?.transID, `${label}.rawTurn.ack must bind Tg request`);
  add(errors, actual.correlation?.ackRequestID === rawTurn.ack.requestID, `${label}.correlation.ackRequestID must bind rawTurn.ack`);
  add(errors, oneStage
    ? actual.correlation?.ackRequestID === actual.correlation?.transID
    : actual.correlation?.ackRequestID !== actual.correlation?.transID,
  oneStage
    ? `${label}.correlation.ackRequestID must bind the single Tg transID`
    : `${label}.correlation must distinguish Tg ACK from Tl transID`);
  if (rawTurn.request?.endpoint !== undefined && tg?.endpoint !== undefined) add(errors, rawTurn.request.endpoint === tg.endpoint, `${label}.rawTurn.request.endpoint does not bind Tg`);
  if (rawTurn.request?.body !== undefined && tg?.body !== undefined) add(errors, same(rawTurn.request.body, tg.body), `${label}.rawTurn.request.body does not bind Tg`);
  const followup = rawTurn.followup;
  const calls = Array.isArray(followup?.calls) ? followup.calls : [];
  if (oneStage) {
    // The WhoIsThis question never ran, so there is no local turn to record.
    add(errors, followup === undefined || followup === null || followup.used === false, `${label}.rawTurn.followup.used must be false for a one-stage capture`);
    add(errors, calls.length === 0, `${label}.rawTurn.followup.calls must be empty for a one-stage capture`);
  } else {
    add(errors, isObject(followup) && followup.used === true, `${label}.rawTurn.followup.used must be true`);
    add(errors, calls.length === 1, `${label}.rawTurn.followup.calls must contain exactly one call`);
    if (calls.length === 1) {
      add(errors, calls[0].requestID === tl?.requestID || calls[0].transID === tl?.transID, `${label}.rawTurn.followup call must bind Tl`);
      add(errors, calls[0].updateCompleted === true, `${label}.rawTurn.followup updateCompleted must be true`);
      // The Tl stage copies the SDK update record verbatim. Binding the whole
      // handle to the raw call is what makes the local-turn body contract
      // falsifiable: without it a receipt could restate the local turn's rules
      // or answer text, or bolt on an extra field, and nothing would notice.
      if (tl?.handle !== undefined) {
        add(errors, same(tl.handle, calls[0]), `${label}.wireFlow Tl handle does not bind the raw follow-up call`);
      }
    }
  }
  add(errors, followup?.restored === true || rawTurn.postRestore?.restored === true, `${label}.rawTurn must record post-restore completion`);

  const eventRows = Array.isArray(rawTurn.events) ? rawTurn.events : [];
  add(errors, eventRows.length > 0, `${label}.rawTurn.events must be non-empty`);
  add(errors, eventRows.every((item) => !['IDLE', 'idle'].includes((item?.event ?? item)?.type)), `${label}.rawTurn.events must not contain synthetic idle evidence`);
  const started = eventRows.map((item, index) => ({ item, index, event: v2TurnEventRow(rawTurn, index) })).filter(({ event }) => event?.type === 'TURN_STARTED');
  const tgStarts = started.filter(({ event }) => event.requestID === tg?.requestID || event.transID === tg?.transID);
  const tlStarts = started.filter(({ event }) => event.requestID === tl?.requestID || event.transID === tl?.transID);
  add(errors, started.length === spec.turnStarted, `${label}.rawTurn must contain exactly ${spec.turnStarted} TURN_STARTED event(s) for a ${flow?.shape} capture`);
  add(errors, tgStarts.length === 1, `${label}.rawTurn must contain exactly one Tg TURN_STARTED event`);
  if (oneStage) {
    add(errors, tlStarts.length === 0, `${label}.rawTurn may not contain a Tl TURN_STARTED event`);
  } else {
    add(errors, tlStarts.length === 1, `${label}.rawTurn must contain exactly one Tl TURN_STARTED event`);
    if (tgStarts.length && tlStarts.length) add(errors, tgStarts[0].index < tlStarts[0].index, `${label}.rawTurn Tl must start after Tg`);
  }
  const actions = eventRows.map((item, index) => ({ item, index, event: v2TurnEventRow(rawTurn, index) })).filter(({ event }) => event?.type === 'SKILL_ACTION');
  const prelude = oneStage ? [] : actions.filter(({ event }) => event.requestID === tg?.requestID || event.transID === tg?.transID);
  const target = actions.filter(({ event }) => event.requestID === targetStage?.requestID || event.transID === targetStage?.transID);
  add(errors, actions.length === spec.skillActions, `${label}.rawTurn must contain exactly ${spec.skillActions} SKILL_ACTION event(s) for a ${flow?.shape} capture`);
  add(errors, prelude.length === spec.excludedPrelude, oneStage
    ? `${label}.rawTurn may not contain a Tg prelude SKILL_ACTION`
    : `${label}.rawTurn must contain exactly one Tg prelude SKILL_ACTION`);
  add(errors, target.length === 1, `${label}.rawTurn must contain exactly one ${spec.target} target SKILL_ACTION`);
  add(errors, actions.at(-1)?.index === target[0]?.index, `${label}.rawTurn ${spec.target} target action must be final SKILL_ACTION`);
  if (target.length) {
    const targetSession = target[0].event.data?.skill?.session?.id;
    requireString(errors, targetSession, `${label}.rawTurn ${spec.target} session id`);
    if (prelude.length) {
      const preludeSession = prelude[0].event.data?.skill?.session?.id;
      requireString(errors, preludeSession, `${label}.rawTurn Tg session id`);
      add(errors, preludeSession === targetSession, `${label}.rawTurn Tg/Tl actions must share one skill session`);
    }
    add(errors, (actual.wireFlow?.sessionId ?? actual.wireFlow?.sessionID) === targetSession, `${label}.wireFlow.sessionId does not bind skill session`);
  }

  const excludedActions = Array.isArray(rawTurn.excludedDisplayActions) ? rawTurn.excludedDisplayActions : [];
  const excluded = excludedActions.filter((item) => item?.captureStatus === 'excluded-prelude');
  add(errors, excludedActions.length === spec.excludedPrelude, oneStage
    ? `${label}.rawTurn must contain no excluded display actions: the WhoIsThis question never ran`
    : `${label}.rawTurn must contain exactly one excluded display action`);
  add(errors, excluded.length === spec.excludedPrelude, oneStage
    ? `${label}.rawTurn must contain no excluded prelude display`
    : `${label}.rawTurn must contain exactly one excluded prelude display`);
  if (oneStage) {
    // A recognized speaker never reaches the WhoIsThis question, so the menu
    // must be absent from the whole turn rather than merely unphotographed.
    const anyWhoIsThis = [...(Array.isArray(rawTurn.displayActions) ? rawTurn.displayActions : []), ...excludedActions]
      .filter((item) => item?.viewId === 'whoIsThisMenu');
    add(errors, anyWhoIsThis.length === 0, `${label}.rawTurn may not contain any whoIsThisMenu display on the one-stage path`);
  }
  if (excluded.length === 1 && !oneStage) {
    const item = excluded[0];
    add(errors, item.viewId === 'whoIsThisMenu', `${label}.rawTurn excluded prelude must be whoIsThisMenu`);
    add(errors, item.eventIndex === prelude[0]?.index, `${label}.rawTurn excluded prelude event must be Tg action`);
    add(errors, item.requestID === tg?.requestID && item.transID === tg?.transID, `${label}.rawTurn excluded prelude must bind Tg IDs`);
    add(errors, item.captureStatus === 'excluded-prelude', `${label}.rawTurn excluded prelude capture status is invalid`);
  }
  const declaredExcluded = actual.wireFlow?.excludedPrelude ?? actual.flow?.excludedPrelude;
  if (requireObject(errors, declaredExcluded, `${label}.wireFlow.excludedPrelude`)) {
    add(errors, declaredExcluded.count === spec.excludedPrelude, `${label}.wireFlow.excludedPrelude.count must be ${spec.excludedPrelude}`);
    if (excluded.length === 1 && !oneStage) {
      add(errors, declaredExcluded.eventIndex === excluded[0].eventIndex, `${label}.wireFlow.excludedPrelude.eventIndex does not bind raw turn`);
      add(errors, declaredExcluded.viewId === excluded[0].viewId, `${label}.wireFlow.excludedPrelude.viewId does not bind raw turn`);
    }
  }
  const targetDisplays = Array.isArray(rawTurn.displayActions) ? rawTurn.displayActions.filter((item) => item?.captureStatus === 'captured') : [];
  const expectedIds = expectedViewIds(descriptor);
  add(errors, targetDisplays.length === expectedIds.length, `${label}.rawTurn target display action count differs from matrix`);
  const displayKeys = new Set();
  const displayOrdinals = new Set();
  const displayOccurrences = new Map();
  targetDisplays.forEach((display, index) => {
    const displayLabel = `${label}.rawTurn.displayActions[${index}]`;
    add(errors, display.viewId === expectedIds[index], `${displayLabel}.viewId is out of matrix order`);
    add(errors, display.eventIndex === target[0]?.index, `${displayLabel}.eventIndex must point at the ${spec.target} target action`);
    add(errors, display.eventType === 'SKILL_ACTION', `${displayLabel}.eventType must be SKILL_ACTION`);
    add(errors, display.requestID === targetStage?.requestID && display.transID === targetStage?.transID, `${displayLabel} must bind ${spec.target} IDs`);
    requireString(errors, display.displayId, `${displayLabel}.displayId`);
    add(errors, Number.isInteger(display.displayIndex) && display.displayIndex === index, `${displayLabel}.displayIndex is out of order`);
    add(errors, Number.isInteger(display.displayOrdinal) && display.displayOrdinal === index + 1, `${displayLabel}.displayOrdinal is out of order`);
    add(errors, Array.isArray(display.actionPath), `${displayLabel}.actionPath must be an array`);
    const node = v2ActionNodeAt(target[0]?.event, display.actionPath);
    add(errors, isObject(node), `${displayLabel}.actionPath does not resolve a display node`);
    add(errors, node?.id === display.displayId || node?.displayId === display.displayId, `${displayLabel}.displayId does not bind the raw display node`);
    const nodeViewId = node?.view?.context?.data?.viewConfig?.id ?? node?.viewId;
    add(errors, nodeViewId === display.viewId, `${displayLabel}.viewId does not bind the raw display node`);
    add(errors, display.captureKey === `${display.viewId}#${display.viewOccurrence}`, `${displayLabel}.captureKey does not bind occurrence`);
    add(errors, Number.isInteger(display.viewOccurrence) && display.viewOccurrence >= 1, `${displayLabel}.viewOccurrence must be positive`);
    add(errors, Number.isInteger(display.viewGeneration) && display.viewGeneration > 0, `${displayLabel}.viewGeneration must be positive`);
    const occurrence = (displayOccurrences.get(display.viewId) || 0) + 1;
    displayOccurrences.set(display.viewId, occurrence);
    add(errors, display.viewOccurrence === occurrence, `${displayLabel}.viewOccurrence is not the exact repeated-view occurrence`);
    const key = `${display.viewId}#${display.viewOccurrence}`;
    if (displayKeys.has(key)) errors.push(`${label}.rawTurn duplicate display captureKey ${key}`);
    if (displayOrdinals.has(display.displayOrdinal)) errors.push(`${label}.rawTurn duplicate displayOrdinal ${display.displayOrdinal}`);
    displayKeys.add(key);
    displayOrdinals.add(display.displayOrdinal);
  });
  const screenshots = Array.isArray(rawTurn.screenshots) ? rawTurn.screenshots : [];
  add(errors, screenshots.filter((shot) => shot?.viewId === 'whoIsThisMenu').length === 0, `${label}.rawTurn must not screenshot whoIsThisMenu prelude`);
  add(errors, screenshots.filter((shot) => shot?.displayAction?.captureStatus === 'excluded-prelude' || String(shot?.captureKey || '').startsWith('excluded-prelude:')).length === 0, `${label}.rawTurn must not capture an excluded prelude display`);
  const idleCandidates = Array.isArray(rawTurn.snapshots) ? rawTurn.snapshots.map((snapshot, index) => ({ snapshot, index })).filter(({ snapshot }) => v2SnapshotIdle(snapshot)) : [];
  const finalIdle = idleCandidates.at(-1);
  add(errors, Boolean(finalIdle), `${label}.rawTurn must contain a native final idle snapshot`);
  add(errors, finalIdle?.index === (rawTurn.snapshots?.length || 0) - 1, `${label}.rawTurn final snapshot must be post-restore idle`);
  return {
    rawTurn,
    finalIdleIndex: finalIdle?.index ?? null,
    finalIdleSnapshot: finalIdle?.snapshot ?? null,
    targetEvent: target[0] ?? null,
    preludeEvent: prelude[0] ?? null,
    targetDisplays,
    screenshots
  };
}

function v2ValidateNative(descriptor, actual, refs, turn, flow, errors, label) {
  const native = parseJsonBytes(refs?.nativeReport, errors, `${label}.artifacts.nativeReport`);
  if (!native) return;
  add(errors, native.schema === 's13-native-report-v1', `${label}.nativeReport.schema is invalid`);
  const events = Array.isArray(native.events) ? native.events : [];
  add(errors, events.length > 0, `${label}.nativeReport.events must be non-empty`);
  // Native idle is valid only as the one final report row sourced from the
  // post-restore turn snapshot.  ACK, provider-return, and provider-idle are
  // never native evidence; the raw/normalized wire lanes reject idle too.
  add(errors, events.filter((event) => ['ack', 'provider-return', 'provider-idle'].includes(event?.type)).length === 0, `${label}.nativeReport contains forbidden ACK/provider-return type`);
  const actions = events.filter((event) => event?.type === 'action');
  const requests = events.filter((event) => event?.type === 'request');
  const idles = events.filter((event) => event?.type === 'idle');
  const spec = flow?.spec || V2_SHAPES['two-stage'];
  const oneStage = spec.target === 'Tg';
  const expectedStages = spec.stages;
  add(errors, actions.length === spec.nativeActions, `${label}.nativeReport must contain exactly ${spec.nativeActions} action event(s) for a ${flow?.shape} capture`);
  add(errors, requests.length === spec.nativeRequests, `${label}.nativeReport must contain exactly ${spec.nativeRequests} request event(s) for a ${flow?.shape} capture`);
  add(errors, idles.length === 1 && events.at(-1)?.type === 'idle', `${label}.nativeReport must contain one final idle event`);
  const tgAction = actions.find((event) => wireStageName(event) === 'Tg');
  const tlAction = actions.find((event) => wireStageName(event) === 'Tl');
  const tgRequest = requests.find((event) => wireStageName(event) === 'Tg');
  const tlRequest = requests.find((event) => wireStageName(event) === 'Tl');
  const targetAction = oneStage ? tgAction : tlAction;
  requireObject(errors, tgAction, `${label}.nativeReport Tg action`);
  requireObject(errors, tgRequest, `${label}.nativeReport Tg request`);
  if (oneStage) {
    add(errors, tlAction === undefined, `${label}.nativeReport may not contain a Tl action`);
    add(errors, tlRequest === undefined, `${label}.nativeReport may not contain a Tl request`);
  } else {
    requireObject(errors, tlAction, `${label}.nativeReport Tl action`);
    requireObject(errors, tlRequest, `${label}.nativeReport Tl request`);
  }
  if (tgRequest) add(errors, tgRequest.requestID === flow?.stages?.Tg?.requestID && tgRequest.transID === flow?.stages?.Tg?.transID, `${label}.nativeReport Tg request does not bind flow`);
  if (tlRequest && !oneStage) add(errors, tlRequest.requestID === flow?.stages?.Tl?.requestID && tlRequest.transID === flow?.stages?.Tl?.transID, `${label}.nativeReport Tl request does not bind flow`);
  for (const [stageName, request] of expectedStages.map((name) => [name, name === 'Tg' ? tgRequest : tlRequest])) {
    if (!request) continue;
    const stage = flow?.stages?.[stageName];
    add(errors, request.caseId === descriptor.id, `${label}.nativeReport ${stageName} request case does not bind matrix`);
    add(errors, request.operation === actual.request?.operation, `${label}.nativeReport ${stageName} request operation does not bind request`);
    add(errors, request.endpoint === stage?.endpoint || request.endpoint === actual.request?.endpoint, `${label}.nativeReport ${stageName} endpoint does not bind stage`);
    requireObject(errors, request.body, `${label}.nativeReport ${stageName} body`);
    requireDigest(errors, request.bodySha256, `${label}.nativeReport ${stageName} bodySha256`);
    add(errors, request.bodySha256 === canonicalSha256(request.body), `${label}.nativeReport ${stageName} bodySha256 is invalid`);
    add(errors, stage?.body === undefined || same(request.body, stage.body), `${label}.nativeReport ${stageName} body does not bind stage body`);
  }
  for (const [stageName, action] of expectedStages.map((name) => [name, name === 'Tg' ? tgAction : tlAction])) {
    if (!action) continue;
    const stage = flow?.stages?.[stageName];
    add(errors, action.caseId === descriptor.id, `${label}.nativeReport ${stageName} action case does not bind matrix`);
    add(errors, action.requestID === stage?.requestID && action.transID === stage?.transID, `${label}.nativeReport ${stageName} action does not bind flow IDs`);
    add(errors, action.operation === actual.request?.operation, `${label}.nativeReport ${stageName} action operation does not bind request`);
    requireTimestamp(errors, action.timestampISO, `${label}.nativeReport ${stageName} action.timestampISO`);
    if (turn?.rawTurn) {
      const eventIndex = action.source?.eventIndex;
      const rawEvent = Number.isInteger(eventIndex) ? v2TurnEventRow(turn.rawTurn, eventIndex) : null;
      add(errors, rawEvent?.type === 'SKILL_ACTION', `${label}.nativeReport ${stageName} action source must be SKILL_ACTION`);
      add(errors, rawEvent?.ts === undefined || action.timestampISO === new Date(rawEvent.ts).toISOString(), `${label}.nativeReport ${stageName} action timestamp does not bind raw turn`);
      const rawAction = rawEvent?.data?.action;
      if (rawAction) {
        add(errors, action.source?.rawActionSha256 === sha256Text(JSON.stringify(rawAction)), `${label}.nativeReport ${stageName} action source hash does not bind raw action`);
        add(errors, action.payload?.rawActionSha256 === undefined || action.payload.rawActionSha256 === sha256Text(JSON.stringify(rawAction)), `${label}.nativeReport ${stageName} action payload source hash does not bind raw action`);
      }
    }
  }
  if (tgAction && !oneStage) add(errors, tgAction.source?.eventIndex === turn?.preludeEvent?.index, `${label}.nativeReport Tg action source does not bind excluded prelude event`);
  if (targetAction) {
    add(errors, same(targetAction.payload, actual.action?.payload?.native), `${label}.nativeReport ${spec.target} action payload does not bind native payload`);
    add(errors, targetAction.eventId === actual.correlation?.nativeActionEventId, `${label}.nativeReport ${spec.target} action event ID does not bind correlation`);
    if (turn?.targetEvent) add(errors, targetAction.source?.eventIndex === turn.targetEvent.index, `${label}.nativeReport ${spec.target} action source event does not bind raw turn`);
  }
  const idle = idles[0];
  if (idle) {
    add(errors, idle.finalState === 'idle' && idle.skill === '@be/idle' && idle.view === 'eyeView' && idle.listener === 'Idle' && idle.ttsTalking === false, `${label}.nativeReport idle state is invalid`);
    v2SourceSnapshot(idle, refs.rawTurn, turn?.finalIdleIndex, errors, `${label}.nativeReport.events[${events.indexOf(idle)}]`);
    add(errors, idle.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.nativeReport idle timestamp does not bind timeline`);
  }
  add(errors, native.sourceTurn?.sha256 === refs.rawTurn?.sha256, `${label}.nativeReport.sourceTurn does not bind rawTurn`);
  add(errors, native.sourceAction?.eventIndex === turn?.targetEvent?.index, `${label}.nativeReport.sourceAction does not bind the ${spec.target} target event`);
  add(errors, native.sourceAction?.rawTurnSha256 === refs.rawTurn?.sha256, `${label}.nativeReport.sourceAction does not bind rawTurn`);
  add(errors, actual.logs?.native?.actionEventIndex === events.indexOf(targetAction), `${label}.logs.native.actionEventIndex does not bind the ${spec.target} action`);
  add(errors, actual.logs?.native?.idleEventIndex === events.indexOf(idle), `${label}.logs.native.idleEventIndex does not bind final idle`);
  add(errors, actual.logs?.native?.eventCount === events.length, `${label}.logs.native.eventCount does not bind native events`);
}

function v2ValidateProviders(descriptor, actual, refs, flow, rawWireRows, errors, label) {
  const expectedServices = v2ExpectedProviderServices(descriptor);
  const rawProviderRows = rawWireRows.filter(({ record }) => record?.kind === 'fixture-provider');
  const fixture = parseJsonBytes(refs?.rawFixture, errors, `${label}.artifacts.rawFixture`);
  const providerFixture = parseJsonBytes(refs?.providerFixture, errors, `${label}.artifacts.providerFixture`);
  // The provider fixture names the exact source case selected from the raw
  // fixture.  The matrix/provider fixture alias is not a valid substitute;
  // parallel calendar captures intentionally use a source key different from
  // the matrix row id.
  const expectedCaseKey = providerFixture?.sourceFixture?.caseKey;
  requireString(errors, expectedCaseKey, `${label}.providerFixture.sourceFixture.caseKey`);
  add(errors, fixture?.caseId === expectedCaseKey, `${label}.rawFixture.caseId must bind providerFixture.sourceFixture.caseKey`);
  add(errors, Boolean(fixture && isObject(fixture.cases) && Object.hasOwn(fixture.cases, expectedCaseKey)), `${label}.rawFixture must contain providerFixture.sourceFixture.caseKey`);
  add(errors, rawProviderRows.length === expectedServices.length, `${label}.rawWire provider cardinality does not match the case contract`);
  add(errors, same(rawProviderRows.map(({ record }) => record.service), expectedServices), `${label}.rawWire provider services/order do not match the case contract`);
  // Provider calls belong to the transaction that actually ran the report,
  // which is Tl on the two-stage path and the single Tg on the one-stage path.
  const spec = flow?.spec || V2_SHAPES['two-stage'];
  const tl = flow?.target ?? flow?.stages?.[spec.target];
  const tlRequestAt = rawWireRows
    .filter(({ record }) => v2SameConnection(tl, record) && record?.kind === 'client-message' && ['LISTEN', 'CLIENT_ASR'].includes(record.json?.type) && v2RawTransId(record) === tl?.transID)
    .map(({ record }) => timestampMs(v2RawAt(record)))
    .filter((value) => value !== null)
    .at(-1);
  const tlActionAt = rawWireRows
    .filter(({ record }) => v2SameConnection(tl, record) && record?.kind === 'server-message' && record.json?.type === 'SKILL_ACTION')
    .map(({ record }) => timestampMs(v2RawAt(record)))
    .filter((value) => value !== null)
    .at(-1);
  const providerSourceLines = new Set();
  const provider = parseJsonlBytes(refs?.providerTrace, errors, `${label}.artifacts.providerTrace`);
  add(errors, provider.length === expectedServices.length, `${label}.providerTrace must contain exactly one row per provider call`);
  provider.forEach((call, index) => {
    const callLabel = `${label}.providerTrace[${index}]`;
    if (!requireObject(errors, call, callLabel)) return;
    add(errors, call.type === 'provider-call', `${callLabel}.type must be provider-call`);
    add(errors, !V2_FORBIDDEN_WIRE_TYPES.has(call.type), `${callLabel}.type may not be synthetic ${call.type}`);
    add(errors, call.service === expectedServices[index], `${callLabel}.service is out of contract order`);
    const source = v2SourceLine(refs.rawWire, call.source, errors, callLabel);
    if (!source) return;
    if (providerSourceLines.has(call.source.line)) errors.push(`${callLabel}.source line is reused by multiple provider calls`);
    providerSourceLines.add(call.source.line);
    const raw = source.value;
    add(errors, raw.kind === 'fixture-provider', `${callLabel}.source must identify fixture-provider`);
    add(errors, raw.service === call.service, `${callLabel}.service does not bind source row`);
    add(errors, raw.caseId === expectedCaseKey, `${callLabel}.source case ID does not bind the selected fixture case`);
    add(errors, call.timestampISO === raw.at, `${callLabel}.timestampISO does not bind raw provider time`);
    add(errors, same(call.input, raw.input), `${callLabel}.input does not bind raw provider input`);
    add(errors, same(call.provider, actual.provider), `${callLabel}.provider projection does not bind actual provider`);
    add(errors, call.fixturePath === actual.artifacts?.providerFixture?.path, `${callLabel}.fixturePath does not bind fixture artifact`);
    add(errors, call.fixtureSha256 === actual.provider?.fixtureSha256, `${callLabel}.fixtureSha256 does not bind fixture artifact`);
    const providerAt = timestampMs(raw.at);
    if (tlRequestAt !== undefined && tlRequestAt !== null) add(errors, providerAt !== null && providerAt >= tlRequestAt, `${callLabel}.timestampISO must follow the ${spec.target} request`);
    if (tlActionAt !== undefined && tlActionAt !== null) add(errors, providerAt !== null && providerAt <= tlActionAt, `${callLabel}.timestampISO must precede the ${spec.target} action`);
    if (Object.hasOwn(raw.input || {}, 'transID')) {
      add(errors, call.transID === raw.input.transID, `${callLabel}.transID does not bind raw input transID`);
      add(errors, raw.input.transID === tl?.transID, `${callLabel}.raw input transID must bind ${spec.target}`);
    } else {
      add(errors, !Object.hasOwn(call, 'transID') || call.transID === undefined, `${callLabel} invents transID absent from raw provider input`);
    }
  });
  add(errors, providerFixture?.sourceFixture?.sha256 === refs.rawFixture?.sha256, `${label}.providerFixture must bind rawFixture bytes`);
  if (providerFixture?.sourceFixture?.caseKey !== undefined && fixture) {
    add(errors, Object.hasOwn(fixture.cases || fixture, providerFixture.sourceFixture.caseKey), `${label}.providerFixture source case key is absent from raw fixture`);
  }
  add(errors, provider.length === rawProviderRows.length, `${label}.providerTrace rows must cover every raw provider row exactly once`);
}

function v2DisplayEqual(expected, actual, label, errors) {
  if (!requireObject(errors, actual, label)) return;
  for (const field of ['eventIndex', 'eventType', 'requestID', 'transID', 'jcpId', 'displayId', 'displayIndex', 'viewId', 'viewOccurrence', 'displayOrdinal', 'captureKey', 'captureStatus', 'viewGeneration']) {
    if (expected?.[field] !== undefined) add(errors, actual[field] === expected[field], `${label}.${field} does not bind raw display identity`);
  }
  add(errors, Array.isArray(actual.actionPath) && same(actual.actionPath, expected?.actionPath), `${label}.actionPath does not bind raw display path`);
}

function v2ValidateScreenshots(descriptor, actual, refs, root, turn, errors, label, screenshotIdentityState) {
  validateScreenshots(descriptor, actual, root, errors, label, screenshotIdentityState);
  const expected = turn?.targetDisplays || [];
  const shots = Array.isArray(actual.screenshots) ? actual.screenshots : [];
  add(errors, shots.length === expected.length, `${label}.screenshots must have one screenshot per target display action`);
  const rawShots = turn?.screenshots || [];
  shots.forEach((shot, index) => {
    const shotLabel = `${label}.screenshots[${index}]`;
    const source = shot.sourceScreenshot;
    if (!requireObject(errors, source, `${shotLabel}.sourceScreenshot`)) return;
    requireDigest(errors, source.rawTurnSha256, `${shotLabel}.sourceScreenshot.rawTurnSha256`);
    add(errors, source.rawTurnSha256 === refs.rawTurn?.sha256, `${shotLabel}.sourceScreenshot.rawTurnSha256 does not bind rawTurn`);
    const raw = rawShots.find((candidate) => candidate?.filename === source.filename)
      || rawShots.find((candidate) => candidate?.sha256 === source.sha256 && candidate?.viewId === shot.viewId && candidate?.viewGeneration === source.viewGeneration);
    add(errors, Boolean(raw), `${shotLabel}.sourceScreenshot does not identify a raw turn screenshot`);
    if (!raw) return;
    add(errors, source.sha256 === raw.sha256, `${shotLabel}.sourceScreenshot.sha256 does not bind raw screenshot`);
    add(errors, source.viewInstance === raw.viewInstance, `${shotLabel}.sourceScreenshot.viewInstance does not bind raw screenshot`);
    add(errors, source.viewGeneration === raw.viewGeneration, `${shotLabel}.sourceScreenshot.viewGeneration does not bind raw screenshot`);
    v2DisplayEqual(expected[index], source.displayAction, `${shotLabel}.sourceScreenshot.displayAction`, errors);
    add(errors, raw.displayAction?.captureKey === expected[index]?.captureKey, `${shotLabel}.sourceScreenshot display capture key does not bind raw target action`);
    add(errors, shot.captureKey === `${descriptor.id}:view:${shot.ordinal}:${shot.viewId}`, `${shotLabel}.captureKey does not bind case/ordinal/view`);
    add(errors, shot.viewId === expected[index]?.viewId, `${shotLabel}.viewId does not bind target display order`);
    add(errors, shot.viewOrdinal === index && shot.ordinal === index, `${shotLabel}.ordinal does not bind target display order`);
    add(errors, shot.sourceScreenshot?.displayAction?.captureStatus === 'captured', `${shotLabel} must come from captured target action`);
  });
}

function v2ValidateTimeline(descriptor, actual, turn, errors, label) {
  const views = Array.isArray(actual.timeline?.views) ? actual.timeline.views : [];
  const contracts = expectedViewContracts(descriptor);
  add(errors, views.length === contracts.length, `${label}.timeline.views count differs from matrix`);
  views.forEach((view, index) => {
    const viewLabel = `${label}.timeline.views[${index}]`;
    add(errors, view.ordinal === index && view.viewId === contracts[index]?.id, `${viewLabel} is out of order`);
    const opened = requireTimestamp(errors, view.openedAtISO, `${viewLabel}.openedAtISO`);
    const closed = requireTimestamp(errors, view.closedAtISO, `${viewLabel}.closedAtISO`);
    add(errors, opened !== null && closed !== null && opened < closed, `${viewLabel} must close after opening`);
    const capture = timestampMs(actual.screenshots?.[index]?.captureAtISO);
    add(errors, opened !== null && capture !== null && capture >= opened && capture <= closed, `${viewLabel} does not contain its screenshot capture`);
    const targetTime = turn?.targetEvent?.event?.ts;
    if (targetTime !== undefined) add(errors, opened !== null && opened >= targetTime, `${viewLabel} opens before Tl target action`);
  });
  const idle = actual.timeline?.idle;
  if (requireObject(errors, idle, `${label}.timeline.idle`)) {
    const idleAt = requireTimestamp(errors, idle.observedAtISO, `${label}.timeline.idle.observedAtISO`);
    add(errors, idle.skill === '@be/idle' && idle.view === 'eyeView' && idle.listener === 'Idle' && idle.ttsTalking === false && idle.finalState === 'idle', `${label}.timeline.idle state is invalid`);
    add(errors, idle.observersRestored === true, `${label}.timeline.idle.observersRestored must be true`);
    add(errors, actual.timeline?.transitionToIdle === true, `${label}.timeline.transitionToIdle must be true`);
    views.forEach((view, index) => add(errors, timestampMs(view.closedAtISO) !== null && idleAt !== null && timestampMs(view.closedAtISO) < idleAt, `${label}.timeline.views[${index}] closes after final idle`));
  }
}

function v2ValidateContextAnchor(descriptor, actual, refs, preflight, flow, errors, label, captureWindow) {
  const anchor = validateContextAnchor(descriptor, actual, refs, preflight, errors, label, captureWindow);
  if (!anchor) return;
  const raw = parseJsonlLineAt(refs.rawWire, anchor.sourceLine, errors, `${label}.contextAnchor`);
  if (raw) {
    // The anchor belongs to the transaction that ran the report: Tl when the
    // WhoIsThis question intervened, otherwise the single global stage.
    const spec = flow?.spec || V2_SHAPES['two-stage'];
    const stage = flow?.target ?? flow?.stages?.[spec.target];
    add(errors, raw.value.kind === 'client-message' && raw.value.json?.type === 'CONTEXT', `${label}.contextAnchor source must be a ${spec.target} CONTEXT`);
    add(errors, v2RawTransId(raw.value) === stage?.transID, `${label}.contextAnchor source must bind ${spec.target} transID`);
    add(errors, raw.value.id === Number(String(stage?.connectionId).replace(/^wire-connection-/, '')) || v2SameConnection(stage, raw.value), `${label}.contextAnchor source connection must bind ${spec.target}`);
  }
}

function v2ValidateCaptureWindow(descriptor, actual, refs, turn, rawWire, externalAnchors, errors, label) {
  const window = externalAnchors?.captureWindow;
  if (!window) return;
  const values = [actual.captureISO, actual.timeline?.idle?.observedAtISO, ...(actual.screenshots || []).map((shot) => shot.captureAtISO), ...(actual.timeline?.views || []).flatMap((view) => [view.openedAtISO, view.closedAtISO])];
  for (const record of rawWire || []) if (v2RawAt(record)) values.push(v2RawAt(record));
  if (turn?.rawTurn?.started) values.push(turn.rawTurn.started);
  for (const item of turn?.rawTurn?.events || []) {
    const event = item?.event ?? item;
    if (event?.ts) values.push(new Date(event.ts).toISOString());
  }
  for (const snapshot of turn?.rawTurn?.snapshots || []) {
    if (Number.isFinite(snapshot?.elapsedMs) && timestampMs(turn.rawTurn.started) !== null) values.push(new Date(timestampMs(turn.rawTurn.started) + snapshot.elapsedMs).toISOString());
  }
  values.filter((value) => value !== undefined && value !== null).forEach((value, index) => validateCaptureWindowValue(value, window, errors, `${label}.captureWindow.value[${index}]`));
}

function v2ValidateArtifacts(descriptor, actual, root, globalReview, errors, label) {
  if (!requireObject(errors, actual.artifacts, `${label}.artifacts`)) return {};
  const refs = {};
  for (const name of ['stackReceipt', 'nativeReport', 'wireTrace', 'providerTrace', 'actionPayload', 'providerFixture', 'contextAnchor', 'rawTurn', 'rawWire', 'rawFixture']) {
    refs[name] = validateArtifactRef(actual.artifacts[name], root, errors, `${label}.artifacts.${name}`);
  }
  const rowReview = validateArtifactRef(actual.artifacts.visualReview, root, errors, `${label}.artifacts.visualReview`);
  refs.visualReview = rowReview || globalReview;
  add(errors, Boolean(refs.visualReview), `${label}.artifacts.visualReview must point at global visual-review-v2`);
  if (rowReview && globalReview) {
    add(errors, rowReview.path === globalReview.path && rowReview.sha256 === globalReview.sha256, `${label}.artifacts.visualReview must bind the shared global review artifact`);
  }
  return refs;
}

function validateStrictV2Row(descriptor, actual, root, errors, allowedRequest, preflight, screenshotIdentityState, externalAnchors, globalReview) {
  const label = `case ${descriptor.id}`;
  const refs = v2ValidateArtifacts(descriptor, actual, root, globalReview, errors, label);
  if (!refs.rawTurn || !refs.rawWire || !refs.rawFixture) return;
  validateActionArtifact(actual, refs, errors, label);
  v2ValidateProviderFixture(descriptor, actual, refs, errors, label);
  v2ValidateRawWire(descriptor, actual, refs, errors, label);
  const flow = v2ValidateFlow(descriptor, actual, refs, null, errors, label);
  const turn = v2ValidateRawTurn(descriptor, actual, refs, flow, errors, label);
  const sourceAction = actual.action?.sourceAction;
  if (requireObject(errors, sourceAction, `${label}.actual.action.sourceAction`)) {
    requireDigest(errors, sourceAction.rawTurnSha256, `${label}.actual.action.sourceAction.rawTurnSha256`);
    add(errors, sourceAction.rawTurnSha256 === refs.rawTurn.sha256, `${label}.actual.action.sourceAction.rawTurnSha256 does not bind rawTurn`);
    add(errors, sourceAction.eventIndex === turn.targetEvent?.index, `${label}.actual.action.sourceAction.eventIndex must identify final Tl action`);
    const rawAction = turn.targetEvent?.event?.data?.action;
    if (rawAction) {
      const digest = sha256Text(JSON.stringify(rawAction));
      add(errors, sourceAction.rawActionSha256 === digest, `${label}.actual.action.sourceAction.rawActionSha256 does not bind final raw action`);
      if (sourceAction.rawAction !== undefined) add(errors, same(sourceAction.rawAction, rawAction), `${label}.actual.action.sourceAction.rawAction does not bind final raw action`);
      for (const stream of ['phoenix', 'native', 'wire']) add(errors, actual.action.payload?.[stream]?.rawActionSha256 === undefined || actual.action.payload[stream].rawActionSha256 === digest, `${label}.actual.action.payload.${stream}.rawActionSha256 does not bind final raw action`);
    }
  }
  v2ValidateNative(descriptor, actual, refs, turn, flow, errors, label);
  v2ValidateProviders(descriptor, actual, refs, flow, flow?.rawWireRows || [], errors, label);
  v2ValidateContextAnchor(descriptor, actual, refs, preflight?.contextByCase?.[descriptor.id] ? { ...preflight, context: preflight.contextByCase[descriptor.id] } : preflight, flow, errors, label, externalAnchors?.captureWindow);
  v2ValidateScreenshots(descriptor, actual, refs, root, turn, errors, label, screenshotIdentityState);
  v2ValidateTimeline(descriptor, actual, turn, errors, label);
  v2ValidateCaptureWindow(descriptor, actual, refs, turn, flow?.rawWire || [], externalAnchors, errors, label);
  add(errors, actual.observersRestored === true, `${label}.actual.observersRestored must be true`);
  add(errors, actual.noBypass === true, `${label}.actual.noBypass must be true`);
}

function validatePhysicalRow(descriptor, row, runtime, root, errors, allowedRequest, preflight, screenshotIdentityState, externalAnchors, globalReview = null, strictMode = false) {
  const label = `case ${descriptor.id}`;
  if (descriptor.captureCondition) {
    add(errors, typeof runtime.captureConditions?.[descriptor.captureCondition.key] === 'boolean', `${label} must record ${descriptor.captureCondition.key} in runtime capture conditions`);
  }
  if (descriptor.captureCondition && row.status === 'skipped') {
    add(errors, runtime.captureConditions?.[descriptor.captureCondition.key] === false, `${label} may be skipped only when ${descriptor.captureCondition.key}=false`);
    requireString(errors, row.skipReason, `${label}.skipReason`);
    add(errors, row.skipReason === `conditional capture unavailable: ${descriptor.captureCondition.key}`, `${label}.skipReason does not state the conditional boundary`);
    if (requireObject(errors, row.actual, `${label}.actual`)) {
      add(errors, Array.isArray(row.actual.viewIds) && row.actual.viewIds.length === 0, `${label}.actual.viewIds must be empty when skipped`);
      add(errors, Array.isArray(row.actual.screenshots) && row.actual.screenshots.length === 0, `${label}.actual.screenshots must be empty when skipped`);
    }
    return;
  }
  if (descriptor.captureCondition) {
    add(errors, runtime.captureConditions?.[descriptor.captureCondition.key] === true, `${label} cannot be pass when ${descriptor.captureCondition.key}=false`);
  }
  add(errors, row.status === 'pass', `${label} status must be pass`);
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  if (!requireObject(errors, row.actual, `${label}.actual`)) return;
  const rowContext = preflight?.contextByCase?.[descriptor.id] || preflight?.context;
  const rowRuntime = {
    ...runtime,
    captureISO: row.actual.captureISO || runtime.captureISO,
    localDateISO: row.actual.localDateISO || runtime.localDateISO
  };
  requireString(errors, row.actual.captureISO, `${label}.actual.captureISO`);
  requireString(errors, row.actual.localDateISO, `${label}.actual.localDateISO`);
  add(errors, timestampMs(row.actual.captureISO) !== null, `${label}.actual.captureISO must be an ISO timestamp`);
  add(errors, row.actual.localDateISO === localDateForTimestamp(row.actual.captureISO, rowRuntime.timezone), `${label}.actual.localDateISO must derive from actual.captureISO`);
  validateCaptureWindowValue(row.actual.captureISO, externalAnchors?.captureWindow, errors, `${label}.actual.captureISO`);
  if (Array.isArray(row.actual.screenshots)) row.actual.screenshots.forEach((shot, index) => validateCaptureWindowValue(shot?.captureAtISO, externalAnchors?.captureWindow, errors, `${label}.screenshots[${index}].captureAtISO`));
  if (Array.isArray(row.actual.timeline?.views)) row.actual.timeline.views.forEach((view, index) => {
    validateCaptureWindowValue(view?.openedAtISO, externalAnchors?.captureWindow, errors, `${label}.timeline.views[${index}].openedAtISO`);
    validateCaptureWindowValue(view?.closedAtISO, externalAnchors?.captureWindow, errors, `${label}.timeline.views[${index}].closedAtISO`);
  });
  validateCaptureWindowValue(row.actual.timeline?.idle?.observedAtISO, externalAnchors?.captureWindow, errors, `${label}.timeline.idle.observedAtISO`);
  const rowPreflight = rowContext ? { ...preflight, context: rowContext } : preflight;
  validateRequest(descriptor, { ...row.actual.request, runtimeLocalDateISO: rowRuntime.localDateISO }, errors, `${label}.actual.request`, allowedRequest, rowPreflight);
  validateProvider(descriptor, { ...row.actual.provider, runtimeLocalDateISO: rowRuntime.localDateISO, calendarDateISO: row.actual.request?.calendarDateISO }, errors, `${label}.actual.provider`);
  validateAction(descriptor, row.actual.action, errors, `${label}.actual.action`, row.actual, allowedRequest?.operation);
  // Every captured physical row uses the v2 raw-evidence contract.  Keep the
  // legacy checks below for non-physical fixtures used by older callers, but
  // never let those checks accept a physical row that omits the raw turn,
  // raw wire, raw fixture, or two-stage proof.
  if (strictMode || globalReview !== null) {
    validateStrictV2Row(descriptor, row.actual, root, errors, allowedRequest, rowPreflight, screenshotIdentityState, externalAnchors, globalReview);
    return;
  }
  validateLogsAndCorrelation(descriptor, row.actual, errors, label, allowedRequest?.operation);
  validateTimeline(descriptor, row.actual, errors, label);
  validateScreenshots(descriptor, row.actual, root, errors, label, screenshotIdentityState);
  const artifactRefs = validateArtifacts(row.actual, root, errors, label, globalReview);
  validateActionArtifact(row.actual, artifactRefs, errors, label);
  validateVisualReview(descriptor, row.actual, artifactRefs, errors, label);
  validateContextAnchor(descriptor, row.actual, artifactRefs, rowPreflight, errors, label, externalAnchors?.captureWindow);
  validateProviderFixture(descriptor, row.actual, artifactRefs, root, errors, label);
  validateTraceArtifacts(descriptor, row.actual, artifactRefs, rowRuntime, root, errors, label, allowedRequest?.operation, externalAnchors?.captureWindow);
  add(errors, row.actual.observersRestored === true, `${label}.actual.observersRestored must be true`);
  add(errors, row.actual.noBypass === true, `${label}.actual.noBypass must be true`);
}

function validateRevalidationReferenceRow(descriptor, row, root, errors) {
  const label = `case ${descriptor.id}`;
  add(errors, row.status === 'referenced', `${label} status must be referenced when prior hardware evidence is reused`);
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  if (!requireObject(errors, row.actual, `${label}.actual`)) return;
  const source = row.actual.sourceReceipt;
  if (!requireObject(errors, source, `${label}.actual.sourceReceipt`)) return;
  add(errors, source.sourcePath === descriptor.reference.path, `${label}.actual.sourceReceipt.sourcePath does not match prior hardware receipt`);
  add(errors, source.sha256 === descriptor.reference.sha256, `${label}.actual.sourceReceipt.sha256 does not match prior hardware receipt`);
  add(errors, source.format === 's13-hardware-receipt', `${label}.actual.sourceReceipt.format is not the prior hardware receipt format`);
  const artifact = validateArtifactRef(source, root, errors, `${label}.actual.sourceReceipt`);
  if (!artifact) return;
  let prior;
  try { prior = JSON.parse(artifact.bytes.toString('utf8')); } catch (error) {
    errors.push(`${label}.actual.sourceReceipt is not JSON: ${error.message}`);
    return;
  }
  requireString(errors, prior.date, `${label}.prior.date`);
  requireRevision(errors, prior.candidateRevision, `${label}.prior.candidateRevision`);
  add(errors, prior.microphoneAcceptance === false, `${label}.prior.microphoneAcceptance must be false`);
  add(errors, typeof prior.input === 'string' && /original Jetstream SDK/i.test(prior.input), `${label}.prior.input must identify the original Jetstream SDK path`);
  add(errors, prior.observersRestored === true, `${label}.prior.observersRestored must be true`);
  const priorViews = Array.isArray(prior.views) ? prior.views : Array.isArray(prior.screenshots) ? prior.screenshots.map((item) => item?.file ? item.file : null) : (prior.screenshot ? [prior.screenshot] : []);
  add(errors, priorViews.length === descriptor.expected.viewIds.length, `${label}.prior view count does not match matrix`);
  if (descriptor.domain === 'weather') add(errors, priorViews.length === 1, `${label}.prior weather receipt must contain one view`);
  if (descriptor.domain === 'news') add(errors, priorViews.length === 3, `${label}.prior news receipt must contain three views`);
  add(errors, Array.isArray(row.actual.viewIds) && same(row.actual.viewIds, descriptor.expected.viewIds), `${label}.actual.viewIds must bind prior receipt view IDs`);
  add(errors, Array.isArray(row.actual.screenshots) && row.actual.screenshots.length === 0, `${label}.actual.screenshots must remain empty when prior hardware evidence is referenced`);
  add(errors, row.actual.transitionToIdle === true, `${label}.actual.transitionToIdle must be true`);
  add(errors, row.actual.action?.receiptSha256 === descriptor.reference.sha256, `${label}.actual.action.receiptSha256 must bind the prior receipt`);
}

function validateLinkedReference(expected, actual, root, errors, label) {
  if (!requireObject(errors, actual, label)) return null;
  add(errors, actual.lane === expected?.lane, `${label}.lane does not match matrix`);
  add(errors, actual.caseId === expected?.caseId, `${label}.caseId does not match matrix`);
  add(errors, actual.sourcePath === expected?.path, `${label}.sourcePath does not match matrix source path`);
  add(errors, actual.sha256 === expected?.sha256, `${label}.sha256 does not match matrix source digest`);
  requireDigest(errors, actual.sha256, `${label}.sha256`);
  const artifact = validateArtifactRef(actual, root, errors, label);
  if (artifact) {
    add(errors, artifact.sha256 === expected?.sha256, `${label} bytes do not match matrix source digest`);
    if (actual.bytes !== undefined) add(errors, actual.bytes === artifact.bytes.length, `${label}.bytes does not match linked receipt bytes`);
  }
  const expectedFormat = expected?.lane === 's11-http-graph' ? 's11-graph-matrix' : expected?.lane === 's12-calendar' ? 's12-differential-receipt' : null;
  requireString(errors, actual.format, `${label}.format`);
  add(errors, actual.format === expectedFormat, `${label}.format does not identify the expected linked receipt format`);
  return artifact;
}

function validateNoViewSource(descriptor, row, linked, errors, label) {
  if (!linked) return;
  let source;
  try { source = JSON.parse(linked.bytes.toString('utf8')); } catch (error) {
    errors.push(`${label} linked receipt is not JSON: ${error.message}`);
    return;
  }
  if (descriptor.reference.lane === 's11-http-graph') {
    add(errors, source.schema === 's11-report-commute-http-v1', `${label} linked S-11 source schema is invalid`);
    const sourceCase = Array.isArray(source.cases) ? source.cases.find((item) => item?.id === descriptor.reference.caseId) : null;
    if (!sourceCase) {
      errors.push(`${label} linked S-11 source does not contain case ${descriptor.reference.caseId}`);
      return;
    }
    add(errors, same(sourceCase.expected?.mims, expectedMimIds(descriptor)), `${label} linked S-11 MIM assertion does not match matrix`);
    add(errors, !('views' in sourceCase.expected) || (Array.isArray(sourceCase.expected.views) && sourceCase.expected.views.length === 0), `${label} linked S-11 source unexpectedly claims a view`);
  } else if (descriptor.reference.lane === 's12-calendar') {
    add(errors, source.schema === 's12-calendar-differential-v1', `${label} linked S-12 source schema is invalid`);
    add(errors, source.result === 'pass', `${label} linked S-12 differential did not pass`);
    const sourceCase = Array.isArray(source.rowResults) ? source.rowResults.find((item) => item?.id === descriptor.reference.caseId) : null;
    if (!sourceCase) {
      errors.push(`${label} linked S-12 source does not contain case ${descriptor.reference.caseId}`);
      return;
    }
    add(errors, sourceCase.semantic === true && sourceCase.prompt === true && sourceCase.action === true, `${label} linked S-12 row is not fully verified`);
  } else errors.push(`${label} linked source lane is not permitted for a no-view assertion`);
}

function validateNoViewRow(descriptor, row, root, errors) {
  const label = `case ${descriptor.id}`;
  add(errors, row.status === 'asserted', `${label} status must be asserted`);
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  if (!requireObject(errors, row.actual, `${label}.actual`)) return;
  const linked = validateLinkedReference(descriptor.reference, row.actual.sourceReceipt, root, errors, `${label}.actual.sourceReceipt`);
  validateNoViewSource(descriptor, row, linked, errors, `${label}.actual.sourceReceipt`);
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
  validateReference(descriptor.reference, row.reference, errors, `${label}.reference`);
  add(errors, row.blockedReason === descriptor.blocked?.reason, `${label}.blockedReason does not preserve the missing source asset decision`);
  if (requireObject(errors, row.actual, `${label}.actual`)) {
    add(errors, Array.isArray(row.actual.viewIds) && row.actual.viewIds.length === 0, `${label}.actual.viewIds must be empty while blocked`);
    add(errors, Array.isArray(row.actual.screenshots) && row.actual.screenshots.length === 0, `${label}.actual.screenshots must be empty while blocked`);
  }
  add(errors, row.claimed === false, `${label}.claimed must be false`);
}

function validateFalsification(receipt, matrix, root, errors, externalAnchors = null) {
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
  if (externalAnchors) {
    requireDigest(errors, falsification.receiptSha256, 'receipt.falsification.receiptSha256');
    add(errors, falsification.receiptSha256 === falsificationAnchorSha256(falsification), 'receipt.falsification.receiptSha256 does not match falsification evidence');
  }
  if (externalAnchors?.falsifierReceiptSha256) {
    add(errors, falsification.receiptSha256 === externalAnchors.falsifierReceiptSha256, 'receipt.falsification.receiptSha256 does not match the external falsifier receipt anchor');
  }
  if (!requireObject(errors, falsification.execution, 'receipt.falsification.execution')) return;
  const execution = falsification.execution;
  add(errors, execution.schema === 's13-falsification-execution-v1', 'receipt.falsification.execution.schema is invalid');
  add(errors, execution.command === 'node scripts/parity-s13-physical/falsify.mjs', 'receipt.falsification.execution.command is not the pinned falsifier command');
  add(errors, execution.codeRevision === receipt.phoenixRevision, 'receipt.falsification.execution.codeRevision does not bind Phoenix revision');
  add(errors, Array.isArray(execution.controls) && same(execution.controls, controlProjection), 'receipt.falsification.execution.controls do not bind receipt controls');
  requireDigest(errors, execution.codeArtifactSha256, 'receipt.falsification.execution.codeArtifactSha256');
  const executionRef = validateArtifactRef(falsification.executionArtifact, root, errors, 'receipt.falsification.executionArtifact');
  const codeRef = validateArtifactRef(execution.codeArtifact, root, errors, 'receipt.falsification.execution.codeArtifact');
  if (codeRef) {
    add(errors, execution.codeArtifact.sha256 === codeRef.sha256, 'receipt falsification execution code artifact hash is not self-consistent');
    add(errors, execution.codeArtifactSha256 === codeRef.sha256, 'receipt falsification execution codeArtifactSha256 does not bind source artifact');
    add(errors, codeRef.sha256 === receipt.provenance?.anchors?.falsifier?.sha256, 'receipt falsification code artifact is not the anchored falsifier source');
  }
  if (executionRef) {
    const executionDocument = parseJsonBytes(executionRef, errors, 'receipt.falsification.executionArtifact');
    if (executionDocument) {
      add(errors, executionDocument.schema === execution.schema, 'receipt falsification execution artifact schema does not bind execution metadata');
      add(errors, executionDocument.command === execution.command, 'receipt falsification execution artifact command does not bind execution metadata');
      add(errors, executionDocument.codeRevision === execution.codeRevision, 'receipt falsification execution artifact revision does not bind execution metadata');
      add(errors, same(executionDocument.controls, controlProjection), 'receipt falsification execution artifact controls do not bind receipt controls');
      add(errors, executionDocument.codeArtifactSha256 === execution.codeArtifact.sha256, 'receipt falsification execution artifact code hash does not bind source artifact');
    }
  }
}

export function validateReceipt(receipt, matrix, options = {}) {
  const { root = process.cwd() } = options || {};
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
  validateProvenance(receipt, matrix, root, errors);
  validateMatrixBinding(receipt, matrix, errors);
  const strictMode = hasV2CaptureEvidence(receipt);
  const externalAnchors = strictMode ? validateExternalAnchors(receipt, matrix, options, errors) : null;
  const globalReviewRef = externalAnchors?.globalVisualReview || globalVisualReviewRef(receipt);
  const globalReview = globalReviewRef
    ? validateArtifactRef(globalReviewRef, root, errors, 'receipt.globalVisualReview')
    : null;
  if (globalReview) validateGlobalVisualReview(receipt, matrix, globalReview, root, errors);
  const preflight = receipt.preflight;
  const allowedRequest = validatePreflight(receipt, matrix, errors);
  if (isObject(receipt.runtime) && isObject(preflight?.context)) {
    add(errors, receipt.runtime.captureISO === preflight.context.runtimeLocationISO, 'receipt.runtime.captureISO must bind the preflight runtime context');
  }
  validateFalsification(receipt, matrix, root, errors, externalAnchors);

  const descriptors = Array.isArray(matrix.cases) ? matrix.cases : [];
  if (!Array.isArray(receipt.cases)) {
    errors.push('receipt.cases must be an array');
  } else {
    add(errors, receipt.cases.length === descriptors.length, `receipt must contain exactly ${descriptors.length} ordered case rows`);
    const seen = new Set();
    const screenshotIdentityState = { paths: new Set(), captureKeys: new Set(), artifactIdentities: new Set() };
    descriptors.forEach((descriptor, index) => {
      const row = receipt.cases[index];
      const label = `receipt.cases[${index}]`;
      if (!requireObject(errors, row, label)) return;
      add(errors, row.ordinal === descriptor.ordinal, `${label}.ordinal does not match matrix`);
      add(errors, row.id === descriptor.id, `${label}.id/order does not match matrix`);
      if (seen.has(row.id)) errors.push(`receipt duplicate case id: ${row.id}`);
      seen.add(row.id);
      if (descriptor.kind === 'no-view') validateNoViewRow(descriptor, row, root, errors);
      else if (descriptor.kind === 'blocked') validateBlockedRow(descriptor, row, errors);
      else if (descriptor.kind === 'revalidation' && row.status === 'referenced') validateRevalidationReferenceRow(descriptor, row, root, errors);
      else validatePhysicalRow(descriptor, row, receipt.runtime || {}, root, errors, allowedRequest, preflight, screenshotIdentityState, externalAnchors, globalReview, strictMode);
    });
  }

  const blockedCount = descriptors.filter((item) => item.kind === 'blocked').length;
  if (blockedCount > 0) {
    // A blocked source asset limits the claim for that row.  It does not
    // invalidate independently complete physical/no-view evidence.
    add(errors, receipt.decision === 'verified_bounded', 'a source-asset-blocked row must produce a verified_bounded receipt with explicit limitations');
    add(errors, receipt.taskStatus === 'closed', 'a source-asset-blocked row does not keep an otherwise-complete receipt open');
    add(errors, receipt.complete === true, 'a source-asset-blocked row does not make complete physical evidence incomplete');
    if (!Array.isArray(receipt.limitations)) errors.push('receipt.limitations must list every blocked source-asset row');
    else descriptors.filter((item) => item.kind === 'blocked').forEach((descriptor) => {
      const limitation = receipt.limitations.find((item) => item?.caseId === descriptor.id);
      if (!limitation) errors.push(`receipt.limitations is missing ${descriptor.id}`);
      else {
        add(errors, limitation.reason === descriptor.blocked?.reason, `receipt.limitations.${descriptor.id} reason does not bind matrix`);
        add(errors, limitation.claimed === false, `receipt.limitations.${descriptor.id} must remain unclaimed`);
      }
    });
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
  const args = {
    matrix: DEFAULT_MATRIX_PATH,
    receipt: null,
    root: process.cwd(),
    out: null,
    externalAnchorsPath: null,
    visualReviewSha256: {},
    provenanceSha256: null,
    captureWindow: null,
    falsifierReceiptSha256: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--matrix') args.matrix = path.resolve(argv[++i]);
    else if (arg === '--root') args.root = path.resolve(argv[++i]);
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--external-anchors' || arg === '--anchors') args.externalAnchorsPath = path.resolve(argv[++i]);
    else if (arg === '--visual-review-sha256' || arg === '--visual-review-hash') {
      const value = argv[++i] || '';
      const separator = value.indexOf('=');
      if (separator <= 0) throw new Error(`${arg} expects CASE_ID=SHA256`);
      args.visualReviewSha256[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (arg === '--provenance-sha256' || arg === '--provenance-hash') args.provenanceSha256 = argv[++i];
    else if (arg === '--capture-window') args.captureWindow = { startISO: argv[++i], endISO: argv[++i] };
    else if (arg === '--falsifier-receipt-sha256' || arg === '--falsifier-receipt-hash') args.falsifierReceiptSha256 = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node scripts/parity-s13-physical/validate.mjs [--matrix PATH] [--root DIR] [--out PATH] [--external-anchors PATH] RECEIPT.json');
      console.log('       Individual anchors: --visual-review-sha256 CASE_ID=HASH (repeat) --provenance-sha256 HASH --capture-window START_ISO END_ISO --falsifier-receipt-sha256 HASH');
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
    const fileAnchors = args.externalAnchorsPath ? readJson(args.externalAnchorsPath) : {};
    const hasInlineAnchors = Object.keys(args.visualReviewSha256).length > 0 || args.provenanceSha256 || args.captureWindow || args.falsifierReceiptSha256;
    const externalAnchors = (args.externalAnchorsPath || hasInlineAnchors)
      ? {
          ...fileAnchors,
          ...(Object.keys(args.visualReviewSha256).length ? { visualReviewSha256: { ...(fileAnchors.visualReviewSha256 || {}), ...args.visualReviewSha256 } } : {}),
          ...(args.provenanceSha256 ? { provenanceSha256: args.provenanceSha256 } : {}),
          ...(args.captureWindow ? { captureWindow: args.captureWindow } : {}),
          ...(args.falsifierReceiptSha256 ? { falsifierReceiptSha256: args.falsifierReceiptSha256 } : {})
        }
      : undefined;
    report = validateReceipt(receipt, matrix, { root: args.root, externalAnchors });
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
