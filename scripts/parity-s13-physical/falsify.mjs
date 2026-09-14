#!/usr/bin/env node

// Run isolated mutations against the checked-in S-13 contract.  Every
// mutation must be rejected by the same pure validator used for a real run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReceipt } from './test-fixture.mjs';
import { canonicalJson, canonicalSha256, matrixSha256, matrixInventory, sha256Bytes, validateReceipt } from './validate.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const matrixPath = path.join(here, 'matrix.json');
const baselineMatrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function rewriteJsonArtifact(root, ref, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}
function rewriteJsonlArtifact(root, ref, values) {
  const bytes = Buffer.from(`${values.map((value) => canonicalJson(value)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}
function recomputeSelfReports(matrix) {
  matrix.integrity.matrixSha256 = matrixSha256(matrix);
  matrix.integrity.caseInventorySha256 = canonicalSha256(matrixInventory(matrix));
}

function runReceiptMutation(name, mutate, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-falsify-'));
  try {
    const receipt = buildReceipt(baselineMatrix, root, options);
    mutate(receipt, root);
    const report = validateReceipt(receipt, baselineMatrix, { root });
    return { name, expected: 'fail', actual: report.result, rejected: report.result === 'fail', errors: report.errors.slice(0, 3) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runMatrixMutation(name, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-matrix-falsify-'));
  try {
    const matrix = clone(baselineMatrix);
    mutate(matrix);
    // An attacker may rewrite the self-reported hashes; the validator's code
    // pins the immutable values and must still reject the changed contract.
    recomputeSelfReports(matrix);
    const receipt = buildReceipt(matrix, root);
    const report = validateReceipt(receipt, matrix, { root });
    return { name, expected: 'fail', actual: report.result, rejected: report.result === 'fail', errors: report.errors.slice(0, 3) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-baseline-'));
let baseline;
try {
  baseline = validateReceipt(buildReceipt(baselineMatrix, baselineRoot), baselineMatrix, { root: baselineRoot });
} finally {
  fs.rmSync(baselineRoot, { recursive: true, force: true });
}
if (baseline.result !== 'pass') throw new Error(`baseline receipt does not pass: ${baseline.errors.slice(0, 5).join('; ')}`);

const checks = [
  runMatrixMutation('rehashed matrix case omission', (matrix) => matrix.cases.pop()),
  runMatrixMutation('rehashed matrix case reorder', (matrix) => [matrix.cases[0], matrix.cases[1]] = [matrix.cases[1], matrix.cases[0]]),
  runMatrixMutation('rehashed matrix action mutation', (matrix) => { matrix.cases[0].expected.mimIds[0] = 'ForgedMim'; }),
  runReceiptMutation('receipt case omission', (receipt) => receipt.cases.pop()),
  runReceiptMutation('receipt case reorder', (receipt) => [receipt.cases[0], receipt.cases[1]] = [receipt.cases[1], receipt.cases[0]]),
  runReceiptMutation('stale Phoenix revision', (receipt) => { receipt.phoenixRevision = '0'.repeat(40); }),
  runReceiptMutation('preflight operation changed', (receipt) => { receipt.preflight.operation = 'unprovenOperation'; }),
  runReceiptMutation('runtime client version omitted', (receipt) => { delete receipt.provenance.client.version; }),
  runReceiptMutation('request mutation with attempted prefs rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-bad-combined');
    row.actual.request.prefs.trafficSeconds = 600;
    row.actual.request.prefsResolution.sha256 = canonicalSha256(row.actual.request.prefs);
  }),
  runReceiptMutation('action view mutation with attempted payload rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-four-card-field-matrix');
    row.actual.action.projection.viewContracts[1].labels.summary = 'forged';
    for (const stream of ['phoenix', 'native', 'wire']) {
      row.actual.action.payload[stream].projection = row.actual.action.projection;
      row.actual.action[`${stream}CanonicalSha256`] = canonicalSha256(row.actual.action.payload[stream]);
    }
    row.actual.action.payloadSha256 = canonicalSha256(row.actual.action.payload);
  }),
  runReceiptMutation('correlation mismatch', (receipt) => { receipt.cases[0].actual.correlation.transID = 'wrong-trans'; }),
  runReceiptMutation('wire trace bytes changed', (receipt, root) => {
    const file = receipt.cases[0].actual.artifacts.wireTrace.path;
    fs.appendFileSync(path.join(root, file), 'forged');
  }),
  runReceiptMutation('native trace action content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const ref = row.actual.artifacts.nativeReport;
    const report = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    report.events[1].payload.projection.mimIds[0] = 'ForgedMim';
    rewriteJsonArtifact(root, ref, report);
  }),
  runReceiptMutation('provider trace content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const ref = row.actual.artifacts.providerTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    records[0].provider.trafficSeconds = 1;
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('private provider fixture content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const fixtureRef = row.actual.artifacts.providerFixture;
    const fixture = JSON.parse(fs.readFileSync(path.join(root, fixtureRef.path), 'utf8'));
    fixture.fixture = 'forged-fixture';
    rewriteJsonArtifact(root, fixtureRef, fixture);
    row.actual.provider.fixtureSha256 = fixtureRef.sha256;
    const traceRef = row.actual.artifacts.providerTrace;
    const records = fs.readFileSync(path.join(root, traceRef.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    records.forEach((record) => {
      if (record.type === 'provider-call' || record.type === 'provider-return') {
        record.fixtureSha256 = fixtureRef.sha256;
        record.provider.fixtureSha256 = fixtureRef.sha256;
      }
    });
    rewriteJsonlArtifact(root, traceRef, records);
  }),
  runReceiptMutation('capture timestamp moved outside artifact trace range', (receipt) => {
    receipt.runtime.captureISO = '1970-01-01T00:00:00.000Z';
    receipt.preflight.context.runtimeLocationISO = receipt.runtime.captureISO;
    receipt.preflight.contextSha256 = canonicalSha256(receipt.preflight.context);
  }),
  runReceiptMutation('PNG signature changed with rehashed screenshot', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const shot = row.actual.screenshots[0];
    const file = path.join(root, shot.path);
    const bytes = fs.readFileSync(file);
    bytes[0] = 0;
    fs.writeFileSync(file, bytes);
    shot.sha256 = sha256Bytes(bytes);
    shot.bytes = bytes.length;
  }),
  runReceiptMutation('final screenshot symlink substituted', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const shot = row.actual.screenshots[0];
    const file = path.join(root, shot.path);
    const target = path.join(root, 'symlink-target.png');
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
  }),
  runReceiptMutation('screenshot symlinked ancestor substituted', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const screenshotDir = path.dirname(path.join(root, row.actual.screenshots[0].path));
    const movedDir = path.join(root, 'moved-screenshot-dir');
    fs.renameSync(screenshotDir, movedDir);
    fs.symlinkSync(movedDir, screenshotDir, 'dir');
  }),
  runReceiptMutation('linked no-view receipt content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-no-view-empty');
    const ref = row.actual.sourceReceipt;
    const source = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    source.result = 'fail';
    rewriteJsonArtifact(root, ref, source);
  }),
  runReceiptMutation('same-ID screenshot reorder', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-concurrent-parallel');
    [row.actual.screenshots[0], row.actual.screenshots[1]] = [row.actual.screenshots[1], row.actual.screenshots[0]];
  }),
  runReceiptMutation('idle closure omitted', (receipt) => { delete receipt.cases[0].actual.timeline.idle; }),
  runReceiptMutation('no-view screenshot injected', (receipt) => { receipt.cases.find((item) => item.id === 'calendar-no-view-empty').actual.screenshots.push({ ordinal: 0, viewId: 'eventView' }); }),
  runReceiptMutation('blocked tree case claimed', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-tree-park-nature');
    row.status = 'pass';
    row.claimed = true;
  }),
  runReceiptMutation('falsification control omitted', (receipt) => receipt.falsification.controls.shift())
  ,runReceiptMutation('screenshot identity swapped across cases', (receipt) => {
    const first = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const second = receipt.cases.find((item) => item.id === 'commute-bad-combined');
    const source = first.actual.screenshots[0];
    first.actual.screenshots[0] = { ...second.actual.screenshots[0], path: source.path, sha256: source.sha256, bytes: source.bytes, pixelSha256: source.pixelSha256, artifactIdentity: source.artifactIdentity };
  }),
  runReceiptMutation('PNG chunk framing or CRC changed with rehash', (receipt, root) => {
    const shot = receipt.cases[0].actual.screenshots[0];
    const file = path.join(root, shot.path);
    const bytes = fs.readFileSync(file);
    bytes.writeUInt32BE(0xffffffff, 8);
    fs.writeFileSync(file, bytes);
    shot.sha256 = sha256Bytes(bytes);
    shot.pixelSha256 = shot.sha256;
    shot.artifactIdentity = canonicalSha256({ caseId: receipt.cases[0].id, caseOrdinal: receipt.cases[0].ordinal, viewOrdinal: shot.viewOrdinal, viewId: shot.viewId, pixelSha256: shot.pixelSha256 });
  }),
  runReceiptMutation('local-turn body contract changed after rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    row.actual.request.body.nluRules = ['forged'];
    row.actual.request.bodySha256 = canonicalSha256(row.actual.request.body);
  }, { selectedOperation: 'startLocalTurn' }),
  runReceiptMutation('PM availability false with a pass row', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-pm-departure-combined');
    row.status = 'pass';
    row.skipReason = undefined;
  }),
  runReceiptMutation('revalidation prior date changed', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'weather-revalidation');
    const ref = row.actual.sourceReceipt;
    const prior = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    prior.date = '2000-01-01';
    rewriteJsonArtifact(root, ref, prior);
  }),
  runReceiptMutation('native request record omitted', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.nativeReport;
    const report = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    report.events = report.events.filter((event) => event.type !== 'request');
    rewriteJsonArtifact(root, ref, report);
  }),
  runReceiptMutation('wire request record omitted', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.wireTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line)).filter((record) => record.type !== 'request');
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('ACK payload changed with rehash', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.wireTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    const ack = records.find((record) => record.type === 'ack');
    ack.payload.caseId = 'forged';
    ack.payloadSha256 = canonicalSha256(ack.payload);
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('timeline action/open/idle order changed', (receipt) => {
    const row = receipt.cases[0];
    row.actual.timeline.views[0].openedAtISO = row.actual.timeline.idle.observedAtISO;
  }),
  runReceiptMutation('falsification execution metadata changed', (receipt, root) => {
    receipt.falsification.execution.command = 'node forged.mjs';
    const ref = receipt.falsification.executionArtifact;
    const document = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    document.command = receipt.falsification.execution.command;
    rewriteJsonArtifact(root, ref, document);
  }),
  runReceiptMutation('provenance anchor changed with rehash', (receipt, root) => {
    const ref = receipt.provenance.anchors.validator;
    const bytes = Buffer.from(`${fs.readFileSync(path.join(root, ref.path), 'utf8')}\nforged`, 'utf8');
    fs.writeFileSync(path.join(root, ref.path), bytes);
    ref.sha256 = sha256Bytes(bytes);
    ref.bytes = bytes.length;
  })
  ,runReceiptMutation('context anchor omitted', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    delete row.actual.artifacts.contextAnchor;
  })
];

const summary = {
  schema: 'phoenix.parity.s13.physical-capture-falsification.v1', task: 'S-13', baseline: 'pass',
  checks, result: checks.every((check) => check.rejected) ? 'pass' : 'fail'
};
const outPath = process.env.S13_FALSIFICATION_OUT ? path.resolve(process.env.S13_FALSIFICATION_OUT) : null;
if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); writeJson(outPath, summary); }
console.log(JSON.stringify({ result: summary.result, checks: checks.map(({ name, actual, rejected }) => ({ name, actual, rejected })), out: outPath }));
if (summary.result !== 'pass') process.exitCode = 1;
