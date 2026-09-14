#!/usr/bin/env node

/**
 * Close a raw S-13 capture only after its independent acquisition evidence is
 * available.  `produce.mjs` intentionally leaves a candidate open: it has no
 * authority to assert the Moth deployment, source checkout, visual review, or
 * adversarial test result.  This program stages those private inputs by exact
 * bytes, verifies their relationships, and asks the normal receipt validator
 * to accept the resulting terminal receipt with independently supplied
 * anchors.
 *
 * It never contacts a robot, starts Phoenix, or writes outside --out.
 */

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareSnapshots } from '../parity-s13-provenance/collect.mjs';
import {
  DEFAULT_MATRIX_PATH,
  canonicalJson,
  canonicalSha256,
  falsificationAnchorSha256,
  matrixSha256,
  provenanceAnchorSha256,
  sha256Bytes,
  validateReceipt,
} from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SOURCE_SCHEMA = 'phoenix-s13-source-manifest-v1';
const SNAPSHOT_SCHEMA = 'phoenix-s13-provenance-v1';
const COMPARISON_SCHEMA = 'phoenix-s13-provenance-comparison-v1';
const REVIEW_SCHEMA = 'phoenix-s13-visual-review-v2';
const FALSIFICATION_SCHEMA = 'phoenix-s13-real-receipt-falsification-v1';
const EXTERNAL_ANCHORS_SCHEMA = 'phoenix.parity.s13.external-validation-anchors.v1';
const MAX_PROVENANCE_GAP_MS = 5 * 60 * 1000;

function fail(message) { throw new Error(`S13 finalizer: ${message}`); }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireRegular(file, label) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) { fail(`${label} cannot be opened: ${error.code || error.message}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file`);
  if (fs.realpathSync(absolute) !== absolute) fail(`${label} has a symlinked ancestor`);
  return { absolute, bytes: fs.readFileSync(absolute), stat };
}

function readJson(file, label) {
  const input = requireRegular(file, label);
  try { return { ...input, value: JSON.parse(input.bytes.toString('utf8')) }; }
  catch (error) { fail(`${label} is not JSON: ${error.message}`); }
}

function ensureNewDirectory(directory) {
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute)) fail(`output directory already exists: ${absolute}`);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) fail('output parent must be a real directory');
  fs.mkdirSync(absolute, { mode: 0o700 });
  return absolute;
}

function writeBytes(root, relativePath, bytes) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    fail(`unsafe output path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target) || target === root) fail(`output escapes receipt root: ${relativePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`could not create regular artifact: ${relativePath}`);
  return { path: relativePath.split(path.sep).join('/'), sha256: sha256(bytes), bytes: bytes.length };
}

function writeJson(root, relativePath, value) {
  return writeBytes(root, relativePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function copyTree(source, destination) {
  const root = path.resolve(source);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) fail('candidate root must be a real directory');
  function descend(from, to) {
    const names = fs.readdirSync(from).sort();
    for (const name of names) {
      const child = path.join(from, name);
      const target = path.join(to, name);
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) fail(`candidate contains a symlink: ${path.relative(root, child)}`);
      if (childStat.isDirectory()) {
        fs.mkdirSync(target, { mode: 0o700 });
        descend(child, target);
      } else if (childStat.isFile()) {
        const bytes = fs.readFileSync(child);
        fs.writeFileSync(target, bytes, { mode: 0o600 });
      } else fail(`candidate contains a non-regular entry: ${path.relative(root, child)}`);
    }
  }
  descend(root, destination);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) fail(`${label} must be a safe relative path`);
  const normalized = value.split('\\').join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`${label} must be canonical without dot segments`);
  return normalized;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireISO(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
  return Date.parse(value);
}

function git(sourceRoot, args) {
  const result = childProcess.spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'buffer' });
  if (result.error) fail(`cannot run git for source manifest: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${(result.stderr || Buffer.alloc(0)).toString('utf8').trim()}`);
  return result.stdout;
}

function validateSourceManifest(input, sourceRoot, revision) {
  const manifest = input.value;
  if (!isObject(manifest) || manifest.schema !== SOURCE_SCHEMA) fail('source manifest has an unsupported schema');
  if (manifest.revision !== revision || !/^[a-f0-9]{40}$/.test(manifest.revision)) fail('source manifest revision does not bind the capture revision');
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('source manifest must contain file rows');
  const seen = new Set();
  let prior = '';
  const rows = manifest.files.map((row, index) => {
    if (!isObject(row)) fail(`source manifest files[${index}] must be an object`);
    const relative = safeRelativePath(row.path, `source manifest files[${index}].path`);
    if (relative <= prior || seen.has(relative)) fail('source manifest file paths must be unique and strictly sorted');
    prior = relative;
    seen.add(relative);
    if (!Number.isInteger(row.bytes) || row.bytes < 0) fail(`source manifest files[${index}].bytes must be a non-negative integer`);
    requireHash(row.sha256, `source manifest files[${index}].sha256`);
    return { path: relative, bytes: row.bytes, sha256: row.sha256 };
  });
  const treeSha256 = sha256(Buffer.from(JSON.stringify(rows), 'utf8'));
  if (manifest.treeSha256 !== treeSha256) fail('source manifest treeSha256 does not bind its ordered file rows');
  const root = path.resolve(sourceRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) fail('source root must be a real directory');
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== revision) fail('source root HEAD does not match the capture revision');
  if (git(root, ['status', '--porcelain=v1']).length !== 0) fail('source root has uncommitted changes');
  const tracked = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (tracked.length !== rows.length || tracked.some((name, index) => name !== rows[index].path)) fail('source manifest does not exactly enumerate the clean tracked source tree');
  for (const row of rows) {
    const file = path.resolve(root, row.path);
    if (!isInside(root, file)) fail(`source manifest file escapes source root: ${row.path}`);
    const opened = requireRegular(file, `source manifest file ${row.path}`);
    if (opened.bytes.length !== row.bytes || sha256(opened.bytes) !== row.sha256) fail(`source manifest file bytes differ: ${row.path}`);
  }
  return { treeSha256, sourceManifestSha256: sha256(input.bytes), revision };
}

function collectorStableProjection(snapshot) {
  return {
    target: snapshot.target,
    electron: {
      page: { slot: snapshot.electron?.page?.slot, url: snapshot.electron?.page?.url, type: snapshot.electron?.page?.type },
      process: { cwd: snapshot.electron?.process?.cwd, argv: snapshot.electron?.process?.argv },
    },
    timezone: snapshot.capturedAt?.timezone,
    be: snapshot.be,
    jetstreamClient: snapshot.jetstreamClient || snapshot.client,
    native: snapshot.native,
    nimbus: snapshot.nimbus,
    ssm: snapshot.ssm,
    // Only the firmware identity is stable across a capture.  The collector
    // also records `rawOutputSha256`, the digest of the robot's rolling
    // `/tmp/messages` syslog, which the robot appends to while the capture
    // runs; folding it into the runtime identity would make every genuine
    // before/after pair differ.  The log is deliberately excluded from the
    // collector's immutable file rows, and those rows are compared separately
    // and exactly, so nothing that can be tampered with escapes this check.
    firmware: { release: snapshot.firmware?.release, source: snapshot.firmware?.source },
  };
}

function validateCollectorEvidence(beforeInput, afterInput, comparisonInput, matrix) {
  const before = beforeInput.value;
  const after = afterInput.value;
  const comparison = comparisonInput.value;
  if (!isObject(before) || before.schema !== SNAPSHOT_SCHEMA || !isObject(after) || after.schema !== SNAPSHOT_SCHEMA) fail('collector snapshots have an unsupported schema');
  let derived;
  try { derived = compareSnapshots(before, after); } catch (error) { fail(`collector snapshots are invalid: ${error.message}`); }
  if (!derived.matched || derived.differences.length) fail('collector before/after immutable rows differ');
  if (!isObject(comparison) || comparison.schema !== COMPARISON_SCHEMA || comparison.matched !== true || !Array.isArray(comparison.differences) || comparison.differences.length) fail('collector comparison is not a successful empty-difference receipt');
  if (comparison.before?.immutableFileHashesSha256 !== derived.before.immutableFileHashesSha256 || comparison.after?.immutableFileHashesSha256 !== derived.after.immutableFileHashesSha256) fail('collector comparison does not bind recomputed immutable row digests');
  if (canonicalJson(collectorStableProjection(before)) !== canonicalJson(collectorStableProjection(after))) fail('collector before/after active runtime identity differs');
  const target = after.target;
  if (!isObject(target) || typeof target.slot !== 'string' || target.remoteRoot !== `/opt/jibo/Jibo/Skills/${target.slot}`) fail('collector target does not bind the active BE slot root');
  const client = after.jetstreamClient || after.client;
  if (!isObject(after.be?.package) || !isObject(client?.package) || !isObject(client?.main) || !isObject(after.nimbus?.package) || !isObject(after.nimbus?.index) || !isObject(after.nimbus?.assets) || !isObject(after.ssm?.package) || !isObject(after.native?.jetstream?.binary) || !isObject(after.native?.jetstream?.config)) fail('collector snapshot is incomplete');
  requireHash(after.be.package.sha256, 'collector BE package hash');
  requireHash(client.package.sha256, 'collector client package hash');
  requireHash(client.main.sha256, 'collector client entry hash');
  requireHash(after.nimbus.package.sha256, 'collector Nimbus package hash');
  requireHash(after.nimbus.index.sha256, 'collector Nimbus index hash');
  requireHash(after.nimbus.assets.auditSha256, 'collector Nimbus report asset audit hash');
  requireHash(after.ssm.package.sha256, 'collector SSM package hash');
  requireHash(after.native.jetstream.binary.sha256, 'collector native Jetstream binary hash');
  requireHash(after.native.jetstream.config.sha256, 'collector native Jetstream config hash');
  // The terminal receipt validator compares this exact mapped value to the
  // matrix pin.  Keep this collector routine reusable for deterministic
  // fixture tests whose otherwise-valid archive inventory is intentionally
  // not the production Nimbus inventory.
  if (after.ssm.package.version !== '16.0.0') fail('collector SSM version is not the supported 16.0.0');
  if (typeof after.native.node?.version !== 'string' || !/^v?\d+\.\d+\.\d+/.test(after.native.node.version)) fail('collector native Node version is invalid');
  if (typeof after.firmware?.release !== 'string' || typeof after.firmware?.source !== 'string') fail('collector firmware binding is incomplete');
  return { before, after, comparison: derived };
}

function validateReview(input, session) {
  const review = input.value;
  if (!isObject(review) || review.schema !== REVIEW_SCHEMA || review.allPassed !== true || !Array.isArray(review.reviews)) fail('visual review is not a passing v2 review');
  if (typeof review.reviewer !== 'string' || !review.reviewer || review.reviewer === 'root-agent-direct-visual-inspection') fail('visual review does not identify an independent reviewer');
  if (review.independentReviewer !== true) fail('visual review must explicitly record independentReviewer:true');
  requireISO(review.reviewedAt, 'visual review reviewedAt');
  if (review.session?.candidateReceiptSha256 !== session.candidateReceiptSha256 || review.session?.sourceRunSha256 !== session.sourceRunSha256) fail('visual review does not bind this candidate and raw-run session');
  return review;
}

function validateFalsificationInput(input, matrix, candidateReceipt, session, falsifierBytes, { allowProvisional = false } = {}) {
  const record = input.value;
  if (!isObject(record) || record.schema !== FALSIFICATION_SCHEMA || record.task !== 'S-13' || record.result !== 'pass') fail('falsification evidence is not a passing real-receipt record');
  if (record.provisional === true && !allowProvisional) fail('provisional falsification evidence may only create a pending receipt, never a terminal receipt');
  if (record.provisional !== undefined && typeof record.provisional !== 'boolean') fail('falsification provisional flag must be boolean when present');
  if (record.target?.phoenixRevision !== candidateReceipt.phoenixRevision || record.target?.candidateReceiptSha256 !== session.candidateReceiptSha256 || record.target?.sourceRunSha256 !== session.sourceRunSha256) fail('falsification evidence does not bind this candidate receipt, raw run, and revision');
  if (record.codeRevision !== candidateReceipt.phoenixRevision || record.codeSha256 !== sha256(falsifierBytes)) fail('falsification evidence does not bind the current falsifier bytes');
  requireISO(record.startedAtISO, 'falsification startedAtISO');
  requireISO(record.endedAtISO, 'falsification endedAtISO');
  if (Date.parse(record.endedAtISO) < Date.parse(record.startedAtISO)) fail('falsification end precedes start');
  if (!Array.isArray(record.controls) || record.controls.length !== matrix.falsificationControls.length) fail('falsification evidence has the wrong control count');
  const controls = record.controls.map((item, index) => {
    if (!isObject(item) || item.id !== matrix.falsificationControls[index] || item.status !== 'rejected' || !Number.isInteger(item.exitCode) || item.exitCode <= 0 || typeof item.evidence !== 'string' || !item.evidence) fail(`falsification control ${index} is invalid`);
    return { id: item.id, status: item.status, exitCode: item.exitCode, evidence: item.evidence };
  });
  return { record, controls };
}

function physicalTimestamps(receipt) {
  const values = [receipt.runtime?.captureISO, receipt.preflight?.context?.runtimeLocationISO];
  for (const row of receipt.cases || []) {
    const actual = row?.actual;
    if (!actual) continue;
    values.push(actual.captureISO, actual.contextLocationISO, actual.timeline?.idle?.observedAtISO);
    for (const view of actual.timeline?.views || []) values.push(view.openedAtISO, view.closedAtISO);
    for (const shot of actual.screenshots || []) values.push(shot.captureAtISO);
  }
  const timestamps = values.filter((value) => typeof value === 'string').map((value) => requireISO(value, 'capture timestamp'));
  if (!timestamps.length) fail('candidate does not contain capture timestamps');
  return { start: Math.min(...timestamps), end: Math.max(...timestamps) };
}

function validateTemporalRelationship(before, after, receipt, anchors) {
  const start = requireISO(anchors.captureWindow?.startISO, 'external anchors captureWindow.startISO');
  const end = requireISO(anchors.captureWindow?.endISO, 'external anchors captureWindow.endISO');
  if (end < start) fail('external anchors capture window ends before it starts');
  const physical = physicalTimestamps(receipt);
  if (physical.start < start || physical.end > end) fail('capture timestamps fall outside the independently anchored capture window');
  const beforeEnd = requireISO(before.capturedAt?.utcEnded, 'collector before utcEnded');
  const afterStart = requireISO(after.capturedAt?.utcStarted, 'collector after utcStarted');
  if (beforeEnd > physical.start || afterStart < physical.end) fail('collector snapshots do not bracket the capture');
  if (physical.start - beforeEnd > MAX_PROVENANCE_GAP_MS || afterStart - physical.end > MAX_PROVENANCE_GAP_MS) fail('collector snapshots are not close enough to the capture for same-session provenance');
}

function normalizeExternalAnchors(value, session) {
  if (!isObject(value) || value.schema !== EXTERNAL_ANCHORS_SCHEMA) fail('external anchors have an unsupported schema');
  const visual = typeof value.visualReviewSha256 === 'string' ? value.visualReviewSha256 : value.visualReviewSha256?.global;
  requireHash(visual, 'external anchors visualReviewSha256');
  requireHash(value.provenanceSha256, 'external anchors provenanceSha256');
  requireHash(value.falsifierReceiptSha256, 'external anchors falsifierReceiptSha256');
  requireISO(value.captureWindow?.startISO, 'external anchors captureWindow.startISO');
  requireISO(value.captureWindow?.endISO, 'external anchors captureWindow.endISO');
  if (value.session?.candidateReceiptSha256 !== session.candidateReceiptSha256 || value.session?.sourceRunSha256 !== session.sourceRunSha256) fail('external anchors do not bind this candidate and raw-run session');
  return {
    schema: value.schema, visualReviewSha256: visual, provenanceSha256: value.provenanceSha256,
    captureWindow: { startISO: value.captureWindow.startISO, endISO: value.captureWindow.endISO },
    falsifierReceiptSha256: value.falsifierReceiptSha256, session: clone(value.session),
  };
}

function stageToolkitAnchors(root) {
  return {
    matrix: writeBytes(root, 'provenance/anchors/matrix.json', requireRegular(path.join(here, 'matrix.json'), 'matrix anchor').bytes),
    validator: writeBytes(root, 'provenance/anchors/validate.mjs', requireRegular(path.join(here, 'validate.mjs'), 'validator anchor').bytes),
    falsifier: writeBytes(root, 'provenance/anchors/falsify.mjs', requireRegular(path.join(here, 'falsify.mjs'), 'falsifier anchor').bytes),
    collector: writeBytes(root, 'provenance/anchors/collect.mjs', requireRegular(path.join(repoRoot, 'scripts/parity-s13-provenance/collect.mjs'), 'collector anchor').bytes),
  };
}

function buildReceipt({ candidate, candidateReceiptRef, source, collector, beforeRef, afterRef, comparisonRef, sourceManifestRef, reviewRef, falsificationInputRef, anchors, matrix }) {
  const receipt = clone(candidate);
  const active = collector.after;
  const client = active.jetstreamClient || active.client;
  const activeObservation = {
    schema: 'phoenix-s13-be-active-observation-v1',
    sourceSnapshots: { before: beforeRef, after: afterRef },
    target: active.target,
    electron: active.electron,
    be: active.be,
    capturedAt: { before: collector.before.capturedAt, after: active.capturedAt },
  };
  const observationRef = writeJson(anchors.root, 'provenance/be-active-observation.json', activeObservation);
  const toolkit = stageToolkitAnchors(anchors.root);
  receipt.decision = 'verified_bounded';
  receipt.taskStatus = 'closed';
  receipt.complete = true;
  receipt.provenance = {
    ...receipt.provenance,
    candidateReceipt: candidateReceiptRef,
    phoenix: {
      ...receipt.provenance?.phoenix,
      revision: source.revision,
      baseRevision: matrix.baseRevision,
      treeSha256: source.treeSha256,
      sourceManifestSha256: source.sourceManifestSha256,
      sourceManifest: sourceManifestRef,
    },
    be: {
      packageName: active.be.package.name, version: active.be.package.version, slot: active.target.slot,
      packageSha256: active.be.package.sha256, deploymentReceiptSha256: observationRef.sha256,
    },
    client: {
      packageName: client.package.name, version: client.package.version, node: active.native.node.version,
      packageJsonSha256: client.package.sha256, entrySha256: client.main.sha256, loadedPath: client.main.path,
    },
    nimbus: {
      packageName: active.nimbus.package.name, version: active.nimbus.package.version, root: path.dirname(active.nimbus.package.path),
      packageJsonSha256: active.nimbus.package.sha256, indexSha256: active.nimbus.index.sha256,
      assetManifestSha256: active.nimbus.assets.auditSha256,
    },
    native: {
      firmware: active.firmware.release, ssmVersion: active.ssm.package.version, ssmSha256: active.ssm.package.sha256,
      jetstreamBinarySha256: active.native.jetstream.binary.sha256, jetstreamConfigSha256: active.native.jetstream.config.sha256,
    },
    collector: { before: beforeRef, after: afterRef, comparison: comparisonRef, immutableFileHashesSha256: collector.comparison.after.immutableFileHashesSha256 },
    anchors: toolkit,
    visualReview: reviewRef,
  };
  receipt.visualReview = reviewRef;
  // The rows arrive pointing at the candidate's staged copy of the review.
  // The terminal receipt stages the session-bound review at its own path, and
  // the validator requires every row to bind that one shared artifact, so the
  // row refs are re-pointed at it here rather than left dangling at the
  // candidate path.
  for (const row of receipt.cases || []) {
    if (isObject(row?.actual?.artifacts) && row.actual.artifacts.visualReview !== undefined) {
      row.actual.artifacts.visualReview = reviewRef;
    }
  }
  const controls = anchors.falsification.controls;
  const execution = {
    schema: 's13-falsification-execution-v1',
    command: 'node scripts/parity-s13-physical/falsify.mjs',
    codeRevision: receipt.phoenixRevision,
    codeArtifact: toolkit.falsifier,
    codeArtifactSha256: toolkit.falsifier.sha256,
    controls,
    startedAtISO: anchors.falsification.record.startedAtISO,
    endedAtISO: anchors.falsification.record.endedAtISO,
    sourceReceipt: falsificationInputRef,
  };
  const executionArtifact = writeJson(anchors.root, 'falsification/execution.json', execution);
  receipt.falsification = {
    result: 'pass', controls, controlsSha256: canonicalSha256(controls), execution, executionArtifact,
    sourceReceipt: falsificationInputRef,
  };
  receipt.falsification.receiptSha256 = falsificationAnchorSha256(receipt.falsification);
  return receipt;
}

export function prepareFinalization(options) {
  const matrixInput = readJson(options.matrix || DEFAULT_MATRIX_PATH, 'matrix');
  const matrix = matrixInput.value;
  if (matrixSha256(matrix) !== matrix.integrity?.matrixSha256) fail('matrix integrity is invalid');
  const candidateRoot = path.resolve(options.candidateRoot);
  const requestedOut = path.resolve(options.out);
  if (isInside(candidateRoot, requestedOut) || isInside(requestedOut, candidateRoot)) fail('candidate and output roots must be disjoint');
  const candidateInput = readJson(path.join(candidateRoot, 'receipt.json'), 'candidate receipt');
  const candidate = candidateInput.value;
  if (!isObject(candidate) || candidate.task !== 'S-13' || !/^[a-f0-9]{40}$/.test(candidate.phoenixRevision)) fail('candidate receipt is not an S-13 capture');
  if (candidate.decision !== 'open' || candidate.taskStatus !== 'open' || candidate.complete !== false || candidate.falsification?.result !== 'not-run') fail('candidate must be an open pre-terminal receipt with falsification not-run');
  const beforeInput = readJson(options.before, 'collector before snapshot');
  const afterInput = readJson(options.after, 'collector after snapshot');
  const comparisonInput = readJson(options.comparison, 'collector comparison');
  const sourceManifestInput = readJson(options.sourceManifest, 'Phoenix source manifest');
  const reviewInput = readJson(options.visualReview, 'visual review');
  const falsificationInput = readJson(options.falsification, 'falsification evidence');
  if (isInside(candidateRoot, reviewInput.absolute) || isInside(candidateRoot, falsificationInput.absolute)) fail('independent review and falsification evidence must be outside the candidate root');
  const sourceRun = candidate.provenance?.sourceRun;
  if (!isObject(sourceRun) || typeof sourceRun.path !== 'string' || !/^[a-f0-9]{64}$/.test(sourceRun.sha256) || !Number.isInteger(sourceRun.bytes) || sourceRun.bytes < 0) fail('candidate must bind a raw run manifest before finalization');
  const sourceRunPath = path.resolve(candidateRoot, sourceRun.path);
  if (!isInside(candidateRoot, sourceRunPath)) fail('candidate raw run manifest escapes candidate root');
  const sourceRunInput = requireRegular(sourceRunPath, 'candidate raw run manifest');
  if (sourceRunInput.bytes.length !== sourceRun.bytes || sha256(sourceRunInput.bytes) !== sourceRun.sha256) fail('candidate raw run manifest hash does not bind opened bytes');
  const session = { candidateReceiptSha256: sha256(candidateInput.bytes), sourceRunSha256: sourceRun.sha256 };
  const falsifierBytes = requireRegular(path.join(here, 'falsify.mjs'), 'falsifier source').bytes;
  const source = validateSourceManifest(sourceManifestInput, options.sourceRoot, candidate.phoenixRevision);
  const collector = validateCollectorEvidence(beforeInput, afterInput, comparisonInput, matrix);
  validateReview(reviewInput, session);
  const falsification = validateFalsificationInput(falsificationInput, matrix, candidate, session, falsifierBytes, { allowProvisional: options.allowProvisional === true });
  const root = ensureNewDirectory(options.out);
  copyTree(candidateRoot, root);
  const candidateReceiptRef = writeBytes(root, 'candidate/receipt-open.json', candidateInput.bytes);
  const beforeRef = writeBytes(root, 'provenance/collector/before.json', beforeInput.bytes);
  const afterRef = writeBytes(root, 'provenance/collector/after.json', afterInput.bytes);
  const comparisonRef = writeBytes(root, 'provenance/collector/comparison.json', comparisonInput.bytes);
  const sourceManifestRef = writeBytes(root, 'provenance/phoenix/source-manifest.json', sourceManifestInput.bytes);
  const reviewRef = writeBytes(root, 'review/visual-review.json', reviewInput.bytes);
  const falsificationInputRef = writeBytes(root, 'falsification/real-receipt.json', falsificationInput.bytes);
  const receipt = buildReceipt({ candidate, candidateReceiptRef, source, collector, beforeRef, afterRef, comparisonRef, sourceManifestRef, reviewRef, falsificationInputRef, anchors: { root, falsification }, matrix });
  const expectedExternalAnchors = {
    schema: EXTERNAL_ANCHORS_SCHEMA,
    visualReviewSha256: reviewRef.sha256,
    provenanceSha256: provenanceAnchorSha256(receipt),
    captureWindow: null,
    falsifierReceiptSha256: falsificationAnchorSha256(receipt.falsification),
  };
  expectedExternalAnchors.session = session;
  return { root, receipt, matrix, collector, expectedExternalAnchors, reviewRef, session };
}

export function finalizeCapture(options) {
  const requestedOut = path.resolve(options.out);
  if (fs.existsSync(requestedOut)) fail(`output directory already exists: ${requestedOut}`);
  const stagingOut = `${requestedOut}.pending-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const prepared = prepareFinalization({ ...options, out: stagingOut });
  const anchorsInput = readJson(options.externalAnchors, 'external anchors');
  const anchors = normalizeExternalAnchors(anchorsInput.value, prepared.session);
  prepared.expectedExternalAnchors.captureWindow = anchors.captureWindow;
  validateTemporalRelationship(prepared.collector.before, prepared.collector.after, prepared.receipt, anchors);
  if (anchors.visualReviewSha256 !== prepared.expectedExternalAnchors.visualReviewSha256
    || anchors.provenanceSha256 !== prepared.expectedExternalAnchors.provenanceSha256
    || anchors.falsifierReceiptSha256 !== prepared.expectedExternalAnchors.falsifierReceiptSha256) {
    fail('external anchors do not match the finalized receipt; obtain a fresh independent review');
  }
  writeBytes(prepared.root, 'external-anchors.json', anchorsInput.bytes);
  const receiptRef = writeJson(prepared.root, 'receipt.json', prepared.receipt);
  const report = validateReceipt(prepared.receipt, prepared.matrix, { root: prepared.root, externalAnchors: anchors });
  writeJson(prepared.root, 'validation.json', report);
  if (report.result !== 'pass') fail(`terminal receipt was rejected: ${report.errors.slice(0, 5).join('; ')}`);
  fs.renameSync(prepared.root, requestedOut);
  return { root: requestedOut, receipt: { ...receiptRef, path: receiptRef.path }, externalAnchors: anchors, validation: report };
}

function parseArgs(argv) {
  const args = { matrix: DEFAULT_MATRIX_PATH, preview: false };
  const names = new Map([
    ['candidate-root', 'candidateRoot'], ['out', 'out'], ['before', 'before'], ['after', 'after'], ['comparison', 'comparison'],
    ['source-manifest', 'sourceManifest'], ['source-root', 'sourceRoot'], ['visual-review', 'visualReview'],
    ['falsification', 'falsification'], ['external-anchors', 'externalAnchors'], ['matrix', 'matrix'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--preview') { args.preview = true; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    const name = names.get(token.slice(2));
    if (!token.startsWith('--') || !name) fail(`unknown option ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${token} requires a value`);
    args[name] = path.resolve(value);
  }
  if (args.help) return args;
  const required = ['candidateRoot', 'out', 'before', 'after', 'comparison', 'sourceManifest', 'sourceRoot', 'visualReview', 'falsification'];
  for (const name of required) if (!args[name]) fail(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  if (!args.preview && !args.externalAnchors) fail('--external-anchors is required unless --preview is used');
  return args;
}

function usage() {
  return 'Usage: finalize.mjs --candidate-root DIR --out DIR --before FILE --after FILE --comparison FILE --source-manifest FILE --source-root DIR --visual-review FILE --falsification FILE --external-anchors FILE\n       Add --preview to write receipt.pending-independent-anchor.json and expected-external-anchors.json without accepting a receipt.';
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  if (args.preview) {
    const prepared = prepareFinalization({ ...args, allowProvisional: true });
    const pending = writeJson(prepared.root, 'receipt.pending-independent-anchor.json', prepared.receipt);
    const expected = writeJson(prepared.root, 'expected-external-anchors.json', prepared.expectedExternalAnchors);
    console.log(JSON.stringify({ result: 'awaiting-independent-anchors', root: prepared.root, pendingReceipt: pending, expectedExternalAnchors: expected }));
    return 0;
  }
  const result = finalizeCapture(args);
  console.log(JSON.stringify({ result: 'pass', root: result.root, receipt: result.receipt, checkedCases: result.validation.checkedCases }));
  return 0;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message || error); process.exitCode = 1; }
}
