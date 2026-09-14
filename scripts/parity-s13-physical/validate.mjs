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
  matrixSha256: 'dcf5f2b1d02884341e446be433ec2a1981d41b7dee8e81210495e0427341b0c0',
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

function isRawTwoStage(actual) {
  return isObject(actual?.stages) || Boolean(actual?.artifacts?.rawTurn && actual?.artifacts?.rawWire);
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

function timestampMs(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return Date.parse(value);
}

function requireTimestamp(errors, value, label) {
  const parsed = timestampMs(value);
  add(errors, parsed !== null, `${label} must be an ISO timestamp`);
  return parsed;
}

function validateTraceIdentity(record, descriptor, actual, selectedOperation, errors, label) {
  if (!requireObject(errors, record, label)) return null;
  add(errors, record.caseId === descriptor.id, `${label}.caseId does not bind matrix case`);
  add(errors, record.requestID === actual.correlation?.requestID, `${label}.requestID does not bind receipt correlation`);
  add(errors, record.transID === actual.correlation?.transID, `${label}.transID does not bind receipt correlation`);
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
  if (descriptor.domain === 'commute' && actual.request?.prefsResolution?.generatedFrom === 'private-fixture-work-time') {
    if (requireObject(errors, fixture.workTime, `${label}.providerFixture.workTime`)) {
      add(errors, fixture.workTime.source === 'private-fixture-work-time', `${label}.providerFixture.workTime.source must bind immutable fixture bytes`);
      const rawFixture = refs?.rawFixture ? parseJsonBytes(refs.rawFixture, errors, `${label}.artifacts.rawFixture`) : null;
      const sourceKey = fixture.sourceFixture?.caseKey;
      const sourceCase = rawFixture?.cases?.[sourceKey];
      add(errors, Boolean(sourceCase), `${label}.providerFixture.workTime source fixture case is missing`);
      if (sourceCase) {
        add(errors, fixture.workTime.dateISO === sourceCase.meta?.date, `${label}.providerFixture.workTime.dateISO does not bind fixture date`);
        add(errors, fixture.workTime.timeZone === sourceCase.meta?.timeZone, `${label}.providerFixture.workTime.timeZone does not bind fixture timezone`);
        add(errors, fixture.workTime.hour === sourceCase.meta?.workTime?.hour, `${label}.providerFixture.workTime.hour does not bind fixture work time`);
        add(errors, fixture.workTime.min === sourceCase.meta?.workTime?.min, `${label}.providerFixture.workTime.min does not bind fixture work time`);
        add(errors, actual.request?.prefs?.workDateISO === sourceCase.meta?.date, `${label}.request.prefs.workDateISO does not bind fixture date`);
        add(errors, actual.request?.prefs?.workHour === sourceCase.meta?.workTime?.hour, `${label}.request.prefs.workHour does not bind fixture work time`);
        add(errors, actual.request?.prefs?.workMin === sourceCase.meta?.workTime?.min, `${label}.request.prefs.workMin does not bind fixture work time`);
      }
    }
    if (requireObject(errors, actual.request?.prefsResolution, `${label}.request.prefsResolution`)) {
      add(errors, actual.request.prefsResolution.sourceFixture?.sha256 === actual.artifacts?.rawFixture?.sha256, `${label}.request.prefsResolution source fixture hash does not bind raw fixture`);
      add(errors, actual.request.prefsResolution.sourceFixture?.path === actual.artifacts?.rawFixture?.path, `${label}.request.prefsResolution source fixture path does not bind raw fixture`);
      add(errors, same(actual.request.prefsResolution.workTime, {
        dateISO: fixture.workTime?.dateISO,
        timeZone: fixture.workTime?.timeZone,
        hour: fixture.workTime?.hour,
        min: fixture.workTime?.min
      }), `${label}.request.prefsResolution.workTime does not bind provider fixture work time`);
    }
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
        if (sourceRun.wireMappingManifest !== undefined) {
          const mappingRef = validateArtifactRef(sourceRun.wireMappingManifest, root, errors, 'receipt raw run wireMappingManifest');
          const mapping = mappingRef ? parseJsonBytes(mappingRef, errors, 'receipt raw run wireMappingManifest') : null;
          add(errors, mapping?.schema === 'phoenix-s13-bundle-manifest-v1', 'receipt raw run wire mapping manifest schema is invalid');
          if (mapping && requireObject(errors, mapping.cases, 'receipt raw run wire mapping manifest cases')) {
            for (const [caseId, entry] of Object.entries(mapping.cases)) {
              const sourceBundle = sourceRun.bundles?.[caseId];
              if (!sourceBundle) {
                errors.push(`receipt raw run wire mapping manifest ${caseId} has no source bundle`);
                continue;
              }
              const configuredDir = typeof entry === 'string' ? entry : entry?.dir || entry?.bundle || entry?.path;
              if (configuredDir) add(errors, path.resolve(sourceRun.runDirectory, configuredDir) === sourceBundle.directory, `receipt raw run wire mapping manifest ${caseId} directory does not bind source bundle`);
              const configuredWire = typeof entry === 'object' ? entry.wire : undefined;
              const configured = typeof configuredWire === 'string' ? configuredWire : configuredWire?.path;
              const bundleDirectory = path.resolve(sourceBundle.directory);
              const configuredName = typeof configured === 'string' ? path.relative(bundleDirectory, path.resolve(bundleDirectory, configured)) : null;
              add(errors, configuredName === sourceBundle.sourceNames?.wire, `receipt raw run wire mapping manifest ${caseId}.wire does not bind source file`);
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
    add(errors, fixtureWorkTime || actual.locationMode === 'capture-local-clock', `${label}.locationMode must be capture-local-clock or private-fixture-work-time`);
    add(errors, isObject(actual.prefs) && actual.prefs.mode === descriptor.input?.prefsPolicy?.mode, `${label}.prefs.mode does not match the matrix policy`);
    add(errors, actual.prefs?.baseSeconds === descriptor.input?.prefsPolicy?.baseSeconds, `${label}.prefs.baseSeconds does not match the matrix policy`);
    add(errors, actual.prefs?.trafficSeconds === descriptor.input?.prefsPolicy?.trafficSeconds, `${label}.prefs.trafficSeconds does not match the matrix policy`);
    add(errors, Number.isInteger(actual.prefs?.workHour) && Number.isInteger(actual.prefs?.workMin), `${label}.prefs must contain resolved wall-clock workHour/workMin`);
    requireString(errors, actual.prefs?.workDateISO, `${label}.prefs.workDateISO`);
    add(errors, /^\d{4}-\d{2}-\d{2}$/.test(actual.prefs?.workDateISO || ''), `${label}.prefs.workDateISO must be YYYY-MM-DD`);
    const resolvedSchedule = fixtureWorkTime ? null : resolveCommuteSchedule(actual.locationISO, descriptor.input?.prefsPolicy?.schedule, 'America/New_York');
    if (resolvedSchedule) {
      add(errors, actual.prefs.workHour === resolvedSchedule.hour, `${label}.prefs.workHour is not derived from capture-local-clock`);
      add(errors, actual.prefs.workMin === resolvedSchedule.minute, `${label}.prefs.workMin is not derived from capture-local-clock`);
      add(errors, actual.prefs.workDateISO === resolvedSchedule.dateISO, `${label}.prefs.workDateISO is not derived from capture-local-clock`);
    } else if (!fixtureWorkTime) errors.push(`${label}.prefs policy cannot be resolved`);
    if (requireObject(errors, actual.prefsResolution, `${label}.prefsResolution`)) {
      add(errors, actual.prefsResolution.schedule === descriptor.input?.prefsPolicy?.schedule, `${label}.prefsResolution.schedule does not match the matrix policy`);
      add(errors, ['capture-local-clock', 'private-fixture-work-time'].includes(actual.prefsResolution.generatedFrom), `${label}.prefsResolution.generatedFrom is unsupported`);
      if (fixtureWorkTime) {
        add(errors, actual.prefsResolution.generatedFrom === 'private-fixture-work-time', `${label}.prefsResolution.generatedFrom must bind private fixture work time`);
        add(errors, actual.prefsResolution.source === 'private-fixture-work-time', `${label}.prefsResolution.source must bind private fixture work time`);
        add(errors, isObject(actual.prefsResolution.sourceFixture), `${label}.prefsResolution.sourceFixture must identify raw fixture bytes`);
        add(errors, isObject(actual.prefsResolution.workTime), `${label}.prefsResolution.workTime must identify fixture work time`);
      }
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
  const rawTwoStage = isRawTwoStage(actual);
  requireString(errors, correlation.requestID, `${label}.correlation.requestID`);
  requireString(errors, correlation.ackRequestID, `${label}.correlation.ackRequestID`);
  requireString(errors, correlation.transID, `${label}.correlation.transID`);
  add(errors, correlation.requestID === correlation.transID, `${label}.correlation requestID/transID mismatch`);
  add(errors, rawTwoStage ? correlation.ackRequestID === correlation.initialRequestID : correlation.ackRequestID === correlation.transID, rawTwoStage ? `${label}.correlation ACK must bind Tg initial request` : `${label}.correlation ackRequestID/transID mismatch`);
  add(errors, correlation.caseId === descriptor.id, `${label}.correlation.caseId does not bind matrix case`);
  add(errors, correlation.operation === selectedOperation, `${label}.correlation.operation does not bind selected operation`);
  requireString(errors, correlation.connectionId, `${label}.correlation.connectionId`);
  requireString(errors, correlation.nativeActionEventId, `${label}.correlation.nativeActionEventId`);
  requireString(errors, correlation.wireActionMessageId, `${label}.correlation.wireActionMessageId`);
  if (rawTwoStage) {
    if (requireObject(errors, actual.stages, `${label}.stages`)) {
      const initial = actual.stages.initial;
      const followup = actual.stages.followup;
      const shared = actual.stages.sharedSkillSession;
      requireString(errors, initial?.requestID, `${label}.stages.initial.requestID`);
      requireString(errors, followup?.requestID, `${label}.stages.followup.requestID`);
      add(errors, initial?.requestID === correlation.ackRequestID, `${label}.stages.initial.requestID does not bind turn ACK`);
      add(errors, followup?.requestID === correlation.requestID, `${label}.stages.followup.requestID does not bind final correlation`);
      add(errors, followup?.transID === correlation.transID, `${label}.stages.followup.transID does not bind final correlation`);
      add(errors, initial?.connectionId === 'wire-connection-1', `${label}.stages.initial must bind conn1`);
      add(errors, followup?.connectionId === 'wire-connection-2', `${label}.stages.followup must bind conn2`);
      add(errors, followup?.call?.statusBeforeUpdate === 'ACTIVE', `${label}.stages.followup.call must bind ACTIVE status before update`);
      add(errors, followup?.call?.updateCompleted === true, `${label}.stages.followup.call must bind updateCompleted:true`);
      add(errors, shared?.same === true, `${label}.stages.sharedSkillSession must bind one skill session`);
      add(errors, shared?.id === correlation.skillSessionId, `${label}.stages.sharedSkillSession.id does not bind correlation`);
      add(errors, initial?.ack?.source === 'turn.json.ack.requestID', `${label}.stages.initial ACK source must be turn.json`);
      add(errors, initial?.ack?.requestID === initial?.requestID, `${label}.stages.initial ACK requestID does not bind Tg`);
      add(errors, initial?.action?.viewId === 'whoIsThisMenu', `${label}.stages.initial action must bind whoIsThisMenu`);
      add(errors, Array.isArray(initial?.action?.mimIds) && initial.action.mimIds.includes('PersonalReportWhoIsThis'), `${label}.stages.initial action must bind PersonalReportWhoIsThis`);
      requireDigest(errors, initial?.action?.rawActionSha256, `${label}.stages.initial.action.rawActionSha256`);
      requireDigest(errors, followup?.action?.rawActionSha256, `${label}.stages.followup.action.rawActionSha256`);
    }
  }
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
    add(errors, rawTwoStage ? wire.ackMessageIndex === -1 : (Number.isInteger(wire.ackMessageIndex) && wire.ackMessageIndex >= 0 && wire.ackMessageIndex < wire.messageCount), rawTwoStage ? `${label}.logs.wire.ackMessageIndex must be -1 when raw wire has no ACK` : `${label}.logs.wire.ackMessageIndex is out of range`);
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
    const screenshotRef = validateArtifactRef(shot, root, errors, `${label}.screenshots[${index}]`);
    if (screenshotRef) {
      add(errors, shot.pixelSha256 === screenshotRef.sha256, `${label}.screenshots[${index}].pixelSha256 does not match screenshot bytes`);
      add(errors, shot.artifactIdentity === canonicalSha256({ caseId: descriptor.id, caseOrdinal: descriptor.ordinal, viewOrdinal: shot.viewOrdinal, viewId: shot.viewId, pixelSha256: shot.pixelSha256 }), `${label}.screenshots[${index}].artifactIdentity does not bind case/view/pixels`);
    }
    validatePngArtifact(screenshotRef, errors, `${label}.screenshots[${index}]`);
  });
  return identityState;
}

function validateArtifacts(actual, root, errors, label) {
  if (!requireObject(errors, actual.artifacts, `${label}.artifacts`)) return;
  const refs = {};
  for (const name of ['stackReceipt', 'nativeReport', 'wireTrace', 'providerTrace', 'actionPayload', 'providerFixture', 'contextAnchor', 'visualReview']) {
    refs[name] = validateArtifactRef(actual.artifacts[name], root, errors, `${label}.artifacts.${name}`);
  }
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
  if (review.schema === 'phoenix-s13-visual-review-v2') {
    requireString(errors, review.reviewer, `${label}.visualReview.reviewer`);
    add(errors, timestampMs(review.reviewedAt) !== null, `${label}.visualReview.reviewedAt must be an ISO timestamp`);
    add(errors, review.allPassed === true, `${label}.visualReview.allPassed must be true`);
    const records = Array.isArray(review.reviews) ? review.reviews : null;
    if (!records) {
      errors.push(`${label}.visualReview.reviews must be an array`);
      return;
    }
    const expected = Array.isArray(actual.screenshots) ? actual.screenshots : [];
    const matches = expected.map((shot, index) => {
      const sourcePath = shot?.sourceScreenshot?.filename;
      const relative = typeof review.captureRoot === 'string' && typeof sourcePath === 'string'
        ? path.relative(path.resolve(review.captureRoot), path.resolve(sourcePath)).split(path.sep).join('/')
        : null;
      const captureOrdinal = shot?.sourceScreenshot?.captureOrdinal;
      const record = records.find((item) => item?.case === descriptor.id && item?.captureOrdinal === captureOrdinal && item?.viewId === shot?.viewId && item?.sha256 === shot?.sha256);
      add(errors, Boolean(record), `${label}.visualReview.reviews does not bind screenshot ${index}`);
      if (record) {
        add(errors, record.path === relative, `${label}.visualReview review path does not bind screenshot ${index}`);
        add(errors, record.bytes === shot.bytes, `${label}.visualReview review byte count does not bind screenshot ${index}`);
        add(errors, record.verdict === 'pass', `${label}.visualReview review verdict must be pass for screenshot ${index}`);
      }
      return record;
    });
    add(errors, matches.every(Boolean), `${label}.visualReview does not cover every captured screenshot`);
    return;
  }
  add(errors, review.schema === 's13-visual-review-v1', `${label}.visualReview.schema is unsupported`);
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

function validateContextAnchor(descriptor, actual, refs, preflight, errors, label) {
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
  add(errors, anchor.sourceTraceSha256 === actual.artifacts?.wireTrace?.sha256, `${label}.contextAnchor.sourceTraceSha256 does not bind wire trace bytes`);
  return anchor;
}

function validateRawTwoStageEvidence(descriptor, actual, refs, errors, label) {
  add(errors, Boolean(refs?.rawTurn), `${label}.artifacts.rawTurn is required for raw two-stage identity`);
  add(errors, Boolean(refs?.rawWire), `${label}.artifacts.rawWire is required for raw two-stage identity`);
  add(errors, Boolean(refs?.rawFixture), `${label}.artifacts.rawFixture is required for raw two-stage identity`);
  const rawTurn = parseJsonBytes(refs?.rawTurn, errors, `${label}.artifacts.rawTurn`);
  const rawWire = parseJsonlBytes(refs?.rawWire, errors, `${label}.artifacts.rawWire`);
  if (!rawTurn || !Array.isArray(rawWire) || !requireObject(errors, actual.stages, `${label}.stages`)) return;
  const initialID = rawTurn.ack?.requestID;
  const followup = rawTurn.followup?.calls?.[0];
  const followupID = followup?.requestID;
  const eventRows = Array.isArray(rawTurn.events) ? rawTurn.events : [];
  const actionFor = (id) => eventRows.find((row) => row?.event?.type === 'SKILL_ACTION' && (row.event.requestID === id || row.event.transID === id));
  const initialAction = actionFor(initialID);
  const finalAction = actionFor(followupID);
  const connectionFor = (id) => rawWire.find((row) => row?.kind === 'connection' && row.transID === id)?.id;
  const initialConnection = connectionFor(initialID);
  const followupConnection = connectionFor(followupID);
  const hasOnConnection = (id, predicate) => rawWire.some((row) => row?.id === id && predicate(row));
  add(errors, typeof initialID === 'string' && initialID.length > 0, `${label}.rawTurn ACK requestID (Tg) is missing`);
  add(errors, typeof followupID === 'string' && followupID.length > 0, `${label}.rawTurn followup requestID (Tl) is missing`);
  add(errors, Boolean(initialAction), `${label}.rawTurn Tg action is missing`);
  add(errors, Boolean(finalAction), `${label}.rawTurn Tl action is missing`);
  add(errors, initialConnection === 1, `${label}.rawWire Tg action must bind conn1`);
  add(errors, followupConnection === 2, `${label}.rawWire Tl stages must bind conn2`);
  add(errors, rawWire.filter((row) => row?.kind === 'connection' && row.transID === initialID).length === 1, `${label}.rawWire must contain exactly one Tg connection`);
  add(errors, rawWire.filter((row) => row?.kind === 'connection' && row.transID === followupID).length === 1, `${label}.rawWire must contain exactly one Tl connection`);
  add(errors, hasOnConnection(1, (row) => row.kind === 'server-message' && row.json?.type === 'SKILL_ACTION'), `${label}.rawWire conn1 initial action is missing`);
  add(errors, hasOnConnection(2, (row) => row.kind === 'client-message' && row.json?.type === 'CONTEXT' && row.json?.transID === followupID), `${label}.rawWire conn2 Tl context is missing`);
  add(errors, hasOnConnection(2, (row) => row.kind === 'server-message' && row.json?.type === 'SKILL_ACTION'), `${label}.rawWire conn2 final action is missing`);
  add(errors, rawWire.filter((row) => row?.id === 1 && row.kind === 'server-message' && row.json?.type === 'SKILL_ACTION').length === 1, `${label}.rawWire conn1 must contain exactly one action`);
  add(errors, rawWire.filter((row) => row?.id === 2 && row.kind === 'server-message' && row.json?.type === 'SKILL_ACTION').length === 1, `${label}.rawWire conn2 must contain exactly one action`);
  const stageIDs = new Set([initialID, followupID].filter(Boolean));
  rawWire.forEach((row, index) => {
    if (row?.kind === 'connection' && row.transID && !stageIDs.has(row.transID)) errors.push(`${label}.rawWire line ${index} is a shadow connection`);
    if (row?.kind === 'client-message' && ['CONTEXT', 'CLIENT_ASR'].includes(row.json?.type) && row.json?.transID && !stageIDs.has(row.json.transID)) errors.push(`${label}.rawWire line ${index} is a shadow ${row.json.type}`);
  });
  add(errors, !rawWire.some((row) => row?.type === 'ack'), `${label}.rawWire must not contain a synthetic ACK`);
  add(errors, !rawWire.some((row) => row?.type === 'idle'), `${label}.rawWire must not contain synthetic idle`);
  const stages = actual.stages;
  add(errors, stages.initial?.requestID === initialID, `${label}.stages.initial.requestID does not bind raw turn ACK`);
  add(errors, stages.followup?.requestID === followupID, `${label}.stages.followup.requestID does not bind raw turn followup`);
  add(errors, same(stages.followup?.call, followup), `${label}.stages.followup.call does not bind raw turn followup`);
  add(errors, stages.initial?.ack?.rawTurnSha256 === refs.rawTurn?.sha256, `${label}.stages.initial ACK does not bind raw turn bytes`);
  add(errors, stages.sharedSkillSession?.same === true, `${label}.stages.sharedSkillSession is not shared`);
  add(errors, stages.sharedSkillSession?.id === initialAction?.event?.data?.skill?.session?.id, `${label}.stages.sharedSkillSession does not bind Tg session`);
  add(errors, stages.sharedSkillSession?.id === finalAction?.event?.data?.skill?.session?.id, `${label}.stages.sharedSkillSession does not bind Tl session`);
  if (initialAction?.event?.data?.action) {
    add(errors, stages.initial?.action?.rawActionSha256 === sha256Text(JSON.stringify(initialAction.event.data.action)), `${label}.stages.initial action hash does not bind raw turn bytes`);
    add(errors, stages.initial?.action?.viewId === 'whoIsThisMenu', `${label}.stages.initial action does not bind whoIsThisMenu`);
  }
  if (finalAction?.event?.data?.action) add(errors, stages.followup?.action?.rawActionSha256 === sha256Text(JSON.stringify(finalAction.event.data.action)), `${label}.stages.followup action hash does not bind raw turn bytes`);
}

function validateTraceArtifacts(descriptor, actual, refs, runtime, root, errors, label, selectedOperation) {
  if (!refs) return;
  const rawTwoStage = isRawTwoStage(actual);
  if (rawTwoStage) validateRawTwoStageEvidence(descriptor, actual, refs, errors, label);
  const stack = parseJsonBytes(refs.stackReceipt, errors, `${label}.artifacts.stackReceipt`);
  const native = parseJsonBytes(refs.nativeReport, errors, `${label}.artifacts.nativeReport`);
  const wire = parseJsonlBytes(refs.wireTrace, errors, `${label}.artifacts.wireTrace`);
  const provider = parseJsonlBytes(refs.providerTrace, errors, `${label}.artifacts.providerTrace`);
  const records = [];
  const times = [];
  const identity = (record, recordLabel) => {
    const time = validateTraceIdentity(record, descriptor, actual, selectedOperation, errors, recordLabel);
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
    nativeEvents.forEach((event, index) => identity(event, `${label}.nativeReport.events[${index}]`));
    const actionIndex = nativeEvents.findIndex((event) => event?.type === 'action');
    const idleIndex = nativeEvents.findIndex((event) => event?.type === 'idle');
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
    const requestIndex = nativeEvents.findIndex((event) => event?.type === 'request');
    add(errors, requestIndex >= 0, `${label}.nativeReport must contain a request record`);
    add(errors, nativeEvents.filter((event) => event?.type === 'request').length === 1, `${label}.nativeReport must contain exactly one request record`);
    if (requestIndex >= 0) {
      add(errors, same(nativeEvents[requestIndex]?.body, actual.request?.body), `${label}.nativeReport request body does not bind actual request`);
      add(errors, nativeEvents[requestIndex]?.operation === selectedOperation, `${label}.nativeReport request operation does not bind selected operation`);
      add(errors, nativeEvents[requestIndex]?.endpoint === actual.request?.endpoint, `${label}.nativeReport request endpoint does not bind actual request`);
      add(errors, nativeEvents[requestIndex]?.bodySha256 === actual.request?.bodySha256, `${label}.nativeReport request body hash does not bind actual request`);
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
    wire.forEach((record, index) => identity(record, `${label}.wireTrace[${index}]`));
    const actionIndex = wire.findIndex((record) => record?.type === 'action');
    const ackIndex = wire.findIndex((record) => record?.type === 'ack');
    const idleIndex = wire.findIndex((record) => record?.type === 'idle');
    add(errors, actionIndex === actual.logs?.wire?.actionMessageIndex, `${label}.wireTrace action index does not bind receipt logs`);
    add(errors, ackIndex === actual.logs?.wire?.ackMessageIndex, `${label}.wireTrace ack index does not bind receipt logs`);
    add(errors, wire.length === actual.logs?.wire?.messageCount, `${label}.wireTrace message count does not bind receipt logs`);
    add(errors, actionIndex >= 0 && same(wire[actionIndex]?.payload, actual.action?.payload?.wire), `${label}.wireTrace action payload does not bind wire action`);
    add(errors, actionIndex >= 0 && wire[actionIndex]?.messageId === actual.correlation?.wireActionMessageId, `${label}.wireTrace action message ID does not bind correlation`);
    add(errors, wire.every((record) => record?.connectionId === actual.correlation?.connectionId), `${label}.wireTrace connection IDs do not bind correlation`);
    add(errors, rawTwoStage ? idleIndex === -1 : idleIndex === wire.length - 1, rawTwoStage ? `${label}.wireTrace must preserve raw wire without synthetic idle` : `${label}.wireTrace final record must be idle`);
    if (idleIndex >= 0) {
      add(errors, wire[idleIndex]?.finalState === 'idle', `${label}.wireTrace final idle state is not idle`);
      add(errors, wire[idleIndex]?.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.wireTrace idle timestamp does not bind timeline idle`);
    }
    const requestIndex = wire.findIndex((record) => record?.type === 'request');
    add(errors, requestIndex >= 0, `${label}.wireTrace must contain a request record`);
    add(errors, wire.filter((record) => record?.type === 'request').length === 1, `${label}.wireTrace must contain exactly one request record`);
    if (requestIndex >= 0) {
      add(errors, same(wire[requestIndex]?.body, actual.request?.body), `${label}.wireTrace request body does not bind actual request`);
      add(errors, wire[requestIndex]?.operation === selectedOperation, `${label}.wireTrace request operation does not bind selected operation`);
      add(errors, wire[requestIndex]?.endpoint === actual.request?.endpoint, `${label}.wireTrace request endpoint does not bind actual request`);
      add(errors, wire[requestIndex]?.bodySha256 === actual.request?.bodySha256, `${label}.wireTrace request body hash does not bind actual request`);
      add(errors, wire[requestIndex]?.bodySha256 === canonicalSha256(wire[requestIndex]?.body), `${label}.wireTrace request body hash is invalid`);
    }
    if (ackIndex >= 0) {
      const ack = wire[ackIndex];
      requireDigest(errors, ack.payloadSha256, `${label}.wireTrace ack.payloadSha256`);
      requireDigest(errors, ack.actionPayloadSha256, `${label}.wireTrace ack.actionPayloadSha256`);
      add(errors, ack.ackFor === actual.correlation?.wireActionMessageId, `${label}.wireTrace ack.ackFor does not bind action message`);
      add(errors, same(ack.payload, actual.action?.payload?.wire), `${label}.wireTrace ack payload does not bind wire action payload`);
      add(errors, ack.payloadSha256 === canonicalSha256(ack.payload), `${label}.wireTrace ack.payloadSha256 does not match ACK payload`);
      add(errors, ack.payloadSha256 === actual.action?.wireCanonicalSha256, `${label}.wireTrace ack.payloadSha256 does not bind wire payload hash`);
      add(errors, ack.actionPayloadSha256 === actual.action?.payloadSha256, `${label}.wireTrace ack.actionPayloadSha256 does not bind action payload hash`);
      add(errors, actual.logs?.wire?.ackPayloadSha256 === ack.payloadSha256, `${label}.logs.wire.ackPayloadSha256 does not bind ACK payload hash`);
    } else if (!rawTwoStage) errors.push(`${label}.wireTrace must contain an ACK record`);
  }

  if (provider.length) {
    provider.forEach((record, index) => {
      const recordLabel = `${label}.providerTrace[${index}]`;
      // Provider fixture calls are preserved byte-for-byte from the raw
      // capture.  The SDK only stamped transID on the settings call; maps,
      // Google Calendar, and Outlook records intentionally have no request
      // identity.  Validate their local binding and source bytes without
      // inventing an identity the wire did not provide.
      if (rawTwoStage && record?.type === 'provider-call' && !record.requestID && !record.transID) {
        if (!requireObject(errors, record, recordLabel)) return;
        add(errors, record.caseId === descriptor.id, `${recordLabel}.caseId does not bind matrix case`);
        add(errors, record.operation === selectedOperation, `${recordLabel}.operation does not bind selected preflight`);
        const time = requireTimestamp(errors, record.timestampISO, `${recordLabel}.timestampISO`);
        requireObject(errors, record.rawRecord, `${recordLabel}.rawRecord`);
        requireObject(errors, record.source, `${recordLabel}.source`);
        if (record.rawRecord && record.source) {
          add(errors, record.source.sha256 === canonicalSha256(record.rawRecord), `${recordLabel}.source.sha256 does not bind raw provider bytes`);
          add(errors, record.rawRecord.kind === 'fixture-provider', `${recordLabel}.rawRecord.kind must be fixture-provider`);
          add(errors, record.rawRecord.at === record.timestampISO, `${recordLabel}.rawRecord timestamp does not bind normalized call`);
        }
        if (time !== null) {
          records.push({ record, time, label: recordLabel });
          times.push(time);
        }
        return;
      }
      identity(record, recordLabel);
    });
    const calls = provider.filter((record) => record?.type === 'provider-call');
    add(errors, calls.length > 0, `${label}.providerTrace must contain a provider-call record`);
    calls.forEach((record, index) => {
      add(errors, same(record.provider, actual.provider), `${label}.providerTrace call ${index} does not bind actual provider projection`);
      add(errors, record.fixturePath === actual.artifacts?.providerFixture?.path, `${label}.providerTrace fixturePath does not bind provider fixture artifact`);
      add(errors, record.fixtureSha256 === actual.provider?.fixtureSha256, `${label}.providerTrace fixtureSha256 does not bind provider fixture artifact`);
    });
    const returns = provider.filter((record) => record?.type === 'provider-return');
    add(errors, rawTwoStage || returns.length > 0, rawTwoStage ? `${label}.providerTrace preserves raw provider call records without synthetic return` : `${label}.providerTrace must contain a provider-return record`);
    returns.forEach((record, index) => add(errors, same(record.provider, actual.provider), `${label}.providerTrace return ${index} does not bind actual provider projection`));
    const providerIdleIndex = provider.findIndex((record) => record?.type === 'idle');
    add(errors, rawTwoStage ? providerIdleIndex === -1 : providerIdleIndex === provider.length - 1, rawTwoStage ? `${label}.providerTrace must not synthesize idle` : `${label}.providerTrace final record must be idle`);
    if (providerIdleIndex >= 0) {
      add(errors, provider[providerIdleIndex]?.finalState === 'idle', `${label}.providerTrace final idle state is not idle`);
      add(errors, provider[providerIdleIndex]?.timestampISO === actual.timeline?.idle?.observedAtISO, `${label}.providerTrace idle timestamp does not bind timeline idle`);
    }
  }

  // The receipt's timeline is meaningful only if the independently parsed
  // traces tell the same causal story: request, action, ordered view opens,
  // captures, closes, ACK, and final idle.  These comparisons deliberately
  // use parsed artifact timestamps rather than the receipt's booleans.
  const nativeActionTime = nativeEvents.find((event) => event?.type === 'action') ? timestampMs(nativeEvents.find((event) => event?.type === 'action').timestampISO) : null;
  const nativeRequestTime = nativeEvents.find((event) => event?.type === 'request') ? timestampMs(nativeEvents.find((event) => event?.type === 'request').timestampISO) : null;
  const nativeIdleTime = nativeEvents.find((event) => event?.type === 'idle') ? timestampMs(nativeEvents.find((event) => event?.type === 'idle').timestampISO) : null;
  const wireActionTime = wireRecords.find((record) => record?.type === 'action') ? timestampMs(wireRecords.find((record) => record?.type === 'action').timestampISO) : null;
  const wireRequestTime = wireRecords.find((record) => record?.type === 'request') ? timestampMs(wireRecords.find((record) => record?.type === 'request').timestampISO) : null;
  const wireAckTime = wireRecords.find((record) => record?.type === 'ack') ? timestampMs(wireRecords.find((record) => record?.type === 'ack').timestampISO) : null;
  const wireIdleTime = wireRecords.find((record) => record?.type === 'idle') ? timestampMs(wireRecords.find((record) => record?.type === 'idle').timestampISO) : null;
  add(errors, nativeActionTime !== null, `${label} native action timestamp is missing`);
  add(errors, wireActionTime !== null, `${label} wire action timestamp is missing`);
  add(errors, rawTwoStage
    ? (nativeActionTime !== null && wireActionTime !== null && Math.abs(nativeActionTime - wireActionTime) <= 1000)
    : (nativeActionTime !== null && wireActionTime !== null && nativeActionTime === wireActionTime),
  rawTwoStage ? `${label} native and wire action timestamps differ by more than raw capture skew` : `${label} native and wire action timestamps diverge`);
  add(errors, nativeRequestTime !== null && nativeActionTime !== null && nativeRequestTime <= nativeActionTime, `${label} native request occurs after native action`);
  add(errors, wireRequestTime !== null && wireActionTime !== null && wireRequestTime <= wireActionTime, `${label} wire request occurs after wire action`);
  add(errors, rawTwoStage || (wireAckTime !== null && wireActionTime !== null && wireAckTime >= wireActionTime), `${label} wire ACK occurs before wire action`);
  add(errors, nativeIdleTime !== null && nativeActionTime !== null && nativeIdleTime > nativeActionTime, `${label} native idle occurs before native action`);
  add(errors, rawTwoStage || (wireIdleTime !== null && wireAckTime !== null && wireIdleTime > wireAckTime), `${label} wire idle occurs before wire ACK`);
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
  add(errors, rawTwoStage || (wireIdleTime !== null && idleTime !== null && wireIdleTime === idleTime), `${label} wire idle does not bind timeline idle`);

  const declaredStart = timestampMs(actual.traceRange?.startISO);
  const declaredEnd = timestampMs(actual.traceRange?.endISO);
  add(errors, declaredStart !== null, `${label}.traceRange.startISO must be an ISO timestamp`);
  add(errors, declaredEnd !== null, `${label}.traceRange.endISO must be an ISO timestamp`);
  if (declaredStart !== null && declaredEnd !== null) {
    add(errors, declaredEnd >= declaredStart, `${label}.traceRange.endISO must follow startISO`);
    times.forEach((time, index) => add(errors, time >= declaredStart && time <= declaredEnd, `${label} trace timestamp ${index} falls outside declared traceRange`));
    const capture = timestampMs(runtime.captureISO);
    add(errors, capture !== null && capture >= declaredStart && capture <= declaredEnd, `${label}.runtime.captureISO falls outside artifact traceRange`);
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
  add(errors, width >= 320 && width <= 10000, `${label} width is outside physical-display bounds`);
  add(errors, height >= 200 && height <= 10000, `${label} height is outside physical-display bounds`);
  add(errors, width * height >= 64000, `${label} dimensions are too small for physical acceptance`);
  add(errors, ihdr.data[8] === 8, `${label} bit depth must be 8`);
  add(errors, [0, 2, 3, 4, 6].includes(ihdr.data[9]), `${label} has an unsupported PNG color type`);
  if (chunks.at(-1)?.type === 'IEND') add(errors, chunks.at(-1).length === 0, `${label} IEND chunk must be empty`);
  add(errors, idatIndexes.every((index) => chunks[index].length > 0), `${label} IDAT chunks must contain data`);
}

function validatePhysicalRow(descriptor, row, runtime, root, errors, allowedRequest, preflight, screenshotIdentityState) {
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
  const rowPreflight = rowContext ? { ...preflight, context: rowContext } : preflight;
  validateRequest(descriptor, { ...row.actual.request, runtimeLocalDateISO: rowRuntime.localDateISO }, errors, `${label}.actual.request`, allowedRequest, rowPreflight);
  validateProvider(descriptor, { ...row.actual.provider, runtimeLocalDateISO: rowRuntime.localDateISO, calendarDateISO: row.actual.request?.calendarDateISO }, errors, `${label}.actual.provider`);
  validateAction(descriptor, row.actual.action, errors, `${label}.actual.action`, row.actual, allowedRequest?.operation);
  validateLogsAndCorrelation(descriptor, row.actual, errors, label, allowedRequest?.operation);
  validateTimeline(descriptor, row.actual, errors, label);
  validateScreenshots(descriptor, row.actual, root, errors, label, screenshotIdentityState);
  const artifactRefs = validateArtifacts(row.actual, root, errors, label);
  validateActionArtifact(row.actual, artifactRefs, errors, label);
  validateVisualReview(descriptor, row.actual, artifactRefs, errors, label);
  validateContextAnchor(descriptor, row.actual, artifactRefs, rowPreflight, errors, label);
  validateProviderFixture(descriptor, row.actual, artifactRefs, root, errors, label);
  validateTraceArtifacts(descriptor, row.actual, artifactRefs, rowRuntime, root, errors, label, allowedRequest?.operation);
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

function validateFalsification(receipt, matrix, root, errors) {
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
  validateProvenance(receipt, matrix, root, errors);
  validateMatrixBinding(receipt, matrix, errors);
  const preflight = receipt.preflight;
  const allowedRequest = validatePreflight(receipt, matrix, errors);
  if (isObject(receipt.runtime) && isObject(preflight?.context)) {
    add(errors, receipt.runtime.captureISO === preflight.context.runtimeLocationISO, 'receipt.runtime.captureISO must bind the preflight runtime context');
  }
  validateFalsification(receipt, matrix, root, errors);

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
      else validatePhysicalRow(descriptor, row, receipt.runtime || {}, root, errors, allowedRequest, preflight, screenshotIdentityState);
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
