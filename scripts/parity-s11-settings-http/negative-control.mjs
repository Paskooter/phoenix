#!/usr/bin/env node

// Falsify the receipt independently. A differential is useful only when a
// shrunk, reordered, rewritten, or wire-mutated candidate is rejected.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [matrixPathArg, sourcePathArg, candidatePathArg] = process.argv.slice(2);
if (!matrixPathArg || !sourcePathArg || !candidatePathArg) {
  throw new Error('usage: negative-control.mjs <matrix.json> <source.json> <candidate.json>');
}
const matrixPath = path.resolve(matrixPathArg);
const sourcePath = path.resolve(sourcePathArg);
const candidatePath = path.resolve(candidatePathArg);
const comparator = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compare.mjs');
const provenancePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'provenance.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's11-settings-negative-'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const originalMatrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const originalProvenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
const failures = [];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function row(receipt, id) {
  const found = receipt.rows.find((entry) => entry && entry.id === id);
  if (!found) throw new Error(`candidate receipt has no row ${id}`);
  return found;
}

function runComparator(matrixArg, sourceArg, candidateArg, comparisonArg, provenanceArg) {
  const args = [comparator, matrixArg, sourceArg, candidateArg, comparisonArg];
  if (provenanceArg) args.push(provenanceArg);
  return spawnSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
}

function runControl(name, mutate, expected) {
  const forged = clone(candidate);
  mutate(forged);
  const forgedPath = path.join(tempDir, `${name}.candidate.json`);
  const comparisonPath = path.join(tempDir, `${name}.comparison.json`);
  fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
  const result = runComparator(matrixPath, sourcePath, forgedPath, comparisonPath);
  let comparison;
  try { comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')); }
  catch (error) {
    failures.push({ name, error: `comparator did not write receipt: ${error.message}` });
    return;
  }
  const rejected = result.status !== 0 && comparison.result === 'fail';
  const matched = comparison.differences.some(expected);
  if (!rejected || !matched) failures.push({ name, rejected, matched, differences: comparison.differences.slice(0, 5) });
  console.log(JSON.stringify({ name, result: rejected && matched ? 'pass' : 'fail', differences: comparison.differences.length }));
}

function runProvenanceControl() {
  const forged = clone(originalProvenance);
  forged.source.files[0].sha256 = '0'.repeat(64);
  const forgedPath = path.join(tempDir, 'provenance-manifest-rewrite.provenance.json');
  const comparisonPath = path.join(tempDir, 'provenance-manifest-rewrite.comparison.json');
  fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
  const result = runComparator(matrixPath, sourcePath, candidatePath, comparisonPath, forgedPath);
  let comparison;
  try { comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')); }
  catch (error) {
    failures.push({ name: 'provenance-manifest-rewrite', error: `comparator did not write receipt: ${error.message}` });
    return;
  }
  const rejected = result.status !== 0 && comparison.result === 'fail';
  const matched = comparison.differences.some((difference) => difference.side === 'provenance' && difference.kind === 'manifest-hash');
  if (!rejected || !matched) failures.push({ name: 'provenance-manifest-rewrite', rejected, matched, differences: comparison.differences.slice(0, 5) });
  console.log(JSON.stringify({ name: 'provenance-manifest-rewrite', result: rejected && matched ? 'pass' : 'fail', differences: comparison.differences.length }));
}

function runPairedControl(name, mutateMatrix, mutateSource, mutateCandidate, expected) {
  const forgedMatrix = clone(originalMatrix);
  const forgedSource = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const forgedCandidate = clone(candidate);
  mutateMatrix(forgedMatrix);
  if (mutateSource) mutateSource(forgedSource);
  if (mutateCandidate) mutateCandidate(forgedCandidate);
  const matrixRaw = `${JSON.stringify(forgedMatrix, null, 2)}\n`;
  const matrixOut = path.join(tempDir, `${name}.matrix.json`);
  const sourceOut = path.join(tempDir, `${name}.source.json`);
  const candidateOut = path.join(tempDir, `${name}.candidate.json`);
  const comparisonPath = path.join(tempDir, `${name}.comparison.json`);
  fs.writeFileSync(matrixOut, matrixRaw);
  forgedSource.matrixSha256 = sha(matrixRaw);
  forgedCandidate.matrixSha256 = sha(matrixRaw);
  fs.writeFileSync(sourceOut, `${JSON.stringify(forgedSource, null, 2)}\n`);
  fs.writeFileSync(candidateOut, `${JSON.stringify(forgedCandidate, null, 2)}\n`);
  const result = spawnSync(process.execPath, [comparator, matrixOut, sourceOut, candidateOut, comparisonPath], {
    encoding: 'utf8', stdio: 'pipe',
  });
  let comparison;
  try { comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')); }
  catch (error) {
    failures.push({ name, error: `comparator did not write receipt: ${error.message}` });
    return;
  }
  const rejected = result.status !== 0 && comparison.result === 'fail';
  const matched = comparison.differences.some(expected);
  if (!rejected || !matched) failures.push({ name, rejected, matched, differences: comparison.differences.slice(0, 5) });
  console.log(JSON.stringify({ name, result: rejected && matched ? 'pass' : 'fail', differences: comparison.differences.length }));
}

runControl('shrink-row', (receipt) => {
  receipt.rows = receipt.rows.slice(1);
}, (difference) => difference.side === 'candidate' && (difference.kind === 'row-count' || difference.kind === 'missing-row'));

runControl('reorder-rows', (receipt) => {
  [receipt.rows[0], receipt.rows[1]] = [receipt.rows[1], receipt.rows[0]];
}, (difference) => difference.side === 'candidate' && difference.kind === 'row-order');

runControl('rewrite-converted-value', (receipt) => {
  row(receipt, 'convert-mode-0').value.commute.mode = 'forged-mode';
}, (difference) => difference.id === 'convert-mode-0' && (difference.kind === 'source-candidate' || difference.kind === 'source-candidate-row'));

runControl('rewrite-error', (receipt) => {
  row(receipt, 'prefs-http-503').error.message = 'forged-settings-error';
}, (difference) => difference.id === 'prefs-http-503' && (difference.kind === 'source-candidate' || difference.kind === 'source-candidate-row'));

runControl('rewrite-request', (receipt) => {
  row(receipt, 'prefs-adult-transid').requests[0].bodyRaw += ' forged';
}, (difference) => difference.id === 'prefs-adult-transid' && (difference.kind === 'source-candidate' || difference.kind === 'source-candidate-row'));

runControl('rewrite-provenance-receipt', (receipt) => {
  receipt.provenanceManifestSha256 = '0'.repeat(64);
}, (difference) => difference.side === 'candidate' && difference.kind === 'provenance-manifest-receipt');

runProvenanceControl();

runPairedControl('paired-shrink', (matrix) => {
  matrix.cases = matrix.cases.slice(1);
  matrix.caseCount = matrix.cases.length;
  matrix.caseInventorySha256 = sha(JSON.stringify(matrix.cases.map((item) => item.id)));
}, (receipt) => { receipt.rows = receipt.rows.slice(1); }, (receipt) => { receipt.rows = receipt.rows.slice(1); },
  (difference) => difference.side === 'matrix' && (difference.kind === 'case-count-pin' || difference.kind === 'case-inventory-hash'));

runPairedControl('paired-reorder', (matrix) => {
  [matrix.cases[0], matrix.cases[1]] = [matrix.cases[1], matrix.cases[0]];
  matrix.caseInventorySha256 = sha(JSON.stringify(matrix.cases.map((item) => item.id)));
}, (receipt) => { [receipt.rows[0], receipt.rows[1]] = [receipt.rows[1], receipt.rows[0]]; },
  (receipt) => { [receipt.rows[0], receipt.rows[1]] = [receipt.rows[1], receipt.rows[0]]; },
  (difference) => difference.side === 'matrix' && difference.kind === 'case-inventory-hash');

runPairedControl('paired-mode-rewrite', (matrix) => {
  row({ rows: matrix.cases }, 'convert-mode-0').mode = 3;
}, (receipt) => { row(receipt, 'convert-mode-0').value.commute.mode = 'walking'; },
  (receipt) => { row(receipt, 'convert-mode-0').value.commute.mode = 'walking'; },
  (difference) => difference.side === 'matrix' && difference.kind === 'matrix-semantic-hash');

runPairedControl('paired-response-rewrite', (matrix) => {
  row({ rows: matrix.cases }, 'prefs-http-503').response.status = 502;
}, (receipt) => { row(receipt, 'prefs-http-503').error.response.status = 502; },
  (receipt) => { row(receipt, 'prefs-http-503').error.response.status = 502; },
  (difference) => difference.side === 'matrix' && difference.kind === 'matrix-semantic-hash');

const result = { result: failures.length ? 'fail' : 'pass', controls: 11, failures: failures.length, tempDir };
console.log(JSON.stringify(result));
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
