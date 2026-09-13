#!/usr/bin/env node

// Run isolated mutations against the checked-in S-13 contract.  Every
// mutation must be rejected by the same pure validator used for a real run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReceipt } from './test-fixture.mjs';
import { canonicalSha256, matrixSha256, matrixInventory, validateReceipt } from './validate.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const matrixPath = path.join(here, 'matrix.json');
const baselineMatrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function recomputeSelfReports(matrix) {
  matrix.integrity.matrixSha256 = matrixSha256(matrix);
  matrix.integrity.caseInventorySha256 = canonicalSha256(matrixInventory(matrix));
}

function runReceiptMutation(name, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-falsify-'));
  try {
    const receipt = buildReceipt(baselineMatrix, root);
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
];

const summary = {
  schema: 'phoenix.parity.s13.physical-capture-falsification.v1', task: 'S-13', baseline: 'pass',
  checks, result: checks.every((check) => check.rejected) ? 'pass' : 'fail'
};
const outPath = process.env.S13_FALSIFICATION_OUT ? path.resolve(process.env.S13_FALSIFICATION_OUT) : null;
if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); writeJson(outPath, summary); }
console.log(JSON.stringify({ result: summary.result, checks: checks.map(({ name, actual, rejected }) => ({ name, actual, rejected })), out: outPath }));
if (summary.result !== 'pass') process.exitCode = 1;
