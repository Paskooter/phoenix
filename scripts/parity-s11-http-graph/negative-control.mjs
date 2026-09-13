#!/usr/bin/env node

// Prove that the differential fails closed when either receipt or the
// caller-supplied matrix is forged. Matrix controls deliberately forge both
// receipts where needed, so a paired but reduced/reordered/re-authored proof
// cannot pass by merely agreeing with itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [matrixPath, sourcePath, candidatePath] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) throw new Error('usage: negative-control.mjs <matrix.json> <source.json> <candidate.json>');

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare.mjs');
const require = createRequire(import.meta.url);
const contract = require('./contract.cjs');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's11-commute-negative-'));
const failures = [];
let controlsRun = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runComparison(name, matrixValue, sourceValue, candidateValue) {
  const forgedMatrixPath = path.join(tempDir, `${name}.matrix.json`);
  const forgedSourcePath = path.join(tempDir, `${name}.source.json`);
  const forgedCandidatePath = path.join(tempDir, `${name}.candidate.json`);
  const comparisonPath = path.join(tempDir, `${name}.comparison.json`);
  fs.writeFileSync(forgedMatrixPath, `${JSON.stringify(matrixValue, null, 2)}\n`);
  fs.writeFileSync(forgedSourcePath, `${JSON.stringify(sourceValue, null, 2)}\n`);
  fs.writeFileSync(forgedCandidatePath, `${JSON.stringify(candidateValue, null, 2)}\n`);
  const processResult = spawnSync(process.execPath, [comparator, forgedMatrixPath, forgedSourcePath, forgedCandidatePath, comparisonPath], {
    cwd: path.resolve(here, '../..'), encoding: 'utf8', stdio: 'pipe',
  });
  let comparison = null;
  try { comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')); } catch (error) {
    failures.push({ name, error: `comparator did not write a receipt: ${error.message}`, stderr: processResult.stderr });
  }
  return {
    processResult,
    comparison,
    rejected: processResult.status !== 0 && comparison && comparison.result === 'fail',
  };
}

function requireRejected(name, result, acceptedDifference) {
  controlsRun += 1;
  const matched = !!(result.comparison && result.comparison.differences.some(acceptedDifference));
  if (!result.rejected || !matched) {
    failures.push({
      name,
      rejected: result.rejected,
      matched,
      status: result.processResult.status,
      differences: result.comparison && result.comparison.differences && result.comparison.differences.slice(0, 5),
    });
  }
  console.log(JSON.stringify({ name, result: result.rejected && matched ? 'pass' : 'fail', differences: result.comparison ? result.comparison.differences.length : null }));
}

function runReceiptControl(name, mutate, acceptedDifference) {
  const forgedCandidate = clone(candidate);
  mutate(forgedCandidate);
  requireRejected(name, runComparison(name, matrix, source, forgedCandidate), acceptedDifference);
}

function runMatrixControl(name, mutate, acceptedDifference) {
  const forgedMatrix = clone(matrix);
  const forgedSource = clone(source);
  const forgedCandidate = clone(candidate);
  mutate(forgedMatrix, forgedSource, forgedCandidate);
  // Recompute the self-describing field to model an attacker who reauthors
  // the matrix and its hash together. The comparator must still use its
  // immutable expected digest and inventory.
  forgedMatrix.matrixSemanticSha256 = contract.matrixSemanticSha256(forgedMatrix);
  requireRejected(name, runComparison(name, forgedMatrix, forgedSource, forgedCandidate), acceptedDifference);
}

function firstWith(receipt, predicate, message) {
  const row = receipt.rows.find(predicate);
  if (!row) throw new Error(message);
  return row;
}

function eachSummary(row, callback) {
  if (row.response && typeof row.response === 'object') callback(row.response);
  if (Array.isArray(row.responses)) row.responses.forEach((summary) => {
    if (summary && typeof summary === 'object') callback(summary);
  });
}

function rowById(receipt, id) {
  return firstWith(receipt, (row) => row && row.id === id, `receipt has no row ${id}`);
}

function reorderRows(receipt, order) {
  const rows = new Map(receipt.rows.map((row) => [row.id, row]));
  receipt.rows = order.map((id) => rows.get(id));
}

// Establish that all controls start from a passing real receipt pair.
const baseline = runComparison('baseline', matrix, source, candidate);
if (baseline.processResult.status !== 0 || !baseline.comparison || baseline.comparison.result !== 'pass') {
  throw new Error(`baseline differential is not passing: ${JSON.stringify(baseline.comparison || baseline.processResult.stderr)}`);
}

runReceiptControl('mim-order', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.mimIds && entry.response.mimIds.length >= 2, 'candidate receipt has no mutable ordered MIM sequence');
  [row.response.mimIds[0], row.response.mimIds[1]] = [row.response.mimIds[1], row.response.mimIds[0]];
}, (difference) => difference.kind === 'mim-order');

runReceiptControl('prompt-id', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.promptIds && entry.response.promptIds.length >= 1, 'candidate receipt has no prompt IDs');
  row.response.promptIds[0] = 'forged-prompt-id';
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'promptIds');

runReceiptControl('esml', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.speeches && entry.response.speeches.length >= 1, 'candidate receipt has no ESML');
  row.response.speeches[0] = `${row.response.speeches[0]} forged`;
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'speeches');

runReceiptControl('view', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.commuteViews && entry.response.commuteViews.length >= 1, 'candidate receipt has no commute view');
  row.response.commuteViews[0].view.trafficSource = 'forged-traffic.crn';
}, (difference) => difference.kind === 'traffic-view-source' || (difference.kind === 'source-candidate-response' && difference.field === 'commuteViews'));

runReceiptControl('analytics', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.resultsAnalytics, 'candidate receipt has no results analytics');
  row.response.resultsAnalytics.config_state = 'forged';
}, (difference) => difference.kind === 'results-analytics-expected' || (difference.kind === 'source-candidate-response' && difference.field === 'resultsAnalytics'));

runReceiptControl('transition', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.transitions && entry.response.transitions.length >= 1, 'candidate receipt has no graph transitions');
  row.response.transitions[0] = 'forged-transition';
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'transitions');

runReceiptControl('action', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.action, 'candidate receipt has no normalized action');
  row.response.action = { forged: true };
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'action');

runReceiptControl('provider-call', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.dataRequests && entry.dataRequests.length >= 1, 'candidate receipt has no provider call');
  row.dataRequests[0].rawQuery = `${row.dataRequests[0].rawQuery}&forged=1`;
}, (difference) => difference.kind === 'provider-requests' || (difference.kind === 'source-candidate-requests' && difference.field === 'dataRequests'));

const firstCase = contract.EXPECTED_CASE_IDS[0];

runMatrixControl('matrix-removed-case', (forgedMatrix, forgedSource, forgedCandidate) => {
  forgedMatrix.cases = forgedMatrix.cases.filter((item) => item.id !== firstCase);
  [forgedSource, forgedCandidate].forEach((receipt) => {
    receipt.rows = receipt.rows.filter((row) => row.id !== firstCase);
    receipt.counts = contract.receiptCounts(receipt.rows);
  });
}, (difference) => difference.side === 'matrix' && (difference.kind === 'matrix-case-count' || difference.kind === 'matrix-case-inventory' || difference.kind === 'matrix-semantic-hash'));

runMatrixControl('matrix-reordered', (forgedMatrix, forgedSource, forgedCandidate) => {
  [forgedMatrix.cases[0], forgedMatrix.cases[1]] = [forgedMatrix.cases[1], forgedMatrix.cases[0]];
  const order = forgedMatrix.cases.map((item) => item.id);
  reorderRows(forgedSource, order);
  reorderRows(forgedCandidate, order);
}, (difference) => difference.side === 'matrix' && (difference.kind === 'matrix-case-inventory' || difference.kind === 'matrix-case-order' || difference.kind === 'matrix-semantic-hash'));

runMatrixControl('matrix-expected-mim-reauthored', (forgedMatrix, forgedSource, forgedCandidate) => {
  const item = forgedMatrix.cases.find((entry) => entry.id === firstCase);
  item.expected.mims[0] = 'ForgedMimSemantic';
  [forgedSource, forgedCandidate].forEach((receipt) => {
    const row = rowById(receipt, firstCase);
    eachSummary(row, (summary) => { summary.mimIds[0] = 'ForgedMimSemantic'; });
  });
}, (difference) => difference.side === 'matrix' && (difference.kind === 'matrix-semantic-field' || difference.kind === 'matrix-semantic-hash'));

runMatrixControl('matrix-expected-speech-reauthored', (forgedMatrix, forgedSource, forgedCandidate) => {
  const token = 'forged speech semantic';
  const item = forgedMatrix.cases.find((entry) => entry.id === firstCase);
  item.expected.speechIncludes[0] = token;
  [forgedSource, forgedCandidate].forEach((receipt) => {
    const row = rowById(receipt, firstCase);
    eachSummary(row, (summary) => { summary.speeches[0] = `${summary.speeches[0]} ${token}`; });
  });
}, (difference) => difference.side === 'matrix' && (difference.kind === 'matrix-semantic-field' || difference.kind === 'matrix-semantic-hash'));

runMatrixControl('matrix-expected-provider-reauthored', (forgedMatrix, forgedSource, forgedCandidate) => {
  const item = forgedMatrix.cases.find((entry) => entry.id === firstCase);
  item.prefs.mode = 'transit';
  [forgedSource, forgedCandidate].forEach((receipt) => {
    const row = rowById(receipt, firstCase);
    [row.dataRequests, row.mapRequests, row.requestExpectation.requests].forEach((requests) => {
      requests.forEach((request) => {
        if (request.path === '/v1/google_maps') {
          request.query.mode = 'transit';
          request.rawQuery = request.rawQuery.replace(/mode=[^&]*$/, 'mode=transit');
        }
      });
    });
  });
}, (difference) => difference.side === 'matrix' && (difference.kind === 'matrix-semantic-field' || difference.kind === 'matrix-semantic-hash'));

runReceiptControl('receipt-row-removal', (receipt) => {
  receipt.rows = receipt.rows.filter((row) => row.id !== firstCase);
  receipt.counts = contract.receiptCounts(receipt.rows);
}, (difference) => difference.kind === 'row-count' || difference.kind === 'receipt-counts' || difference.kind === 'receipt-derived-counts' || difference.kind === 'missing-row' || difference.kind === 'row-order');

console.log(JSON.stringify({ result: failures.length ? 'fail' : 'pass', controls: controlsRun, failures: failures.length, tempDir }));
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
