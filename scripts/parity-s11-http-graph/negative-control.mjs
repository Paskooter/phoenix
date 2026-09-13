#!/usr/bin/env node

// Prove that independently forged receipt fields are rejected. A differential
// lane that only checks its happy path can accept a plausible but incomplete
// graph, so each control mutates one observable contract at a time.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [matrixPath, sourcePath, candidatePath] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) throw new Error('usage: negative-control.mjs <matrix.json> <source.json> <candidate.json>');
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's11-commute-negative-'));
const comparator = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compare.mjs');
const failures = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runControl(name, mutate, acceptedDifference) {
  const forged = clone(candidate);
  mutate(forged);
  const forgedPath = path.join(tempDir, `${name}.candidate.json`);
  const comparisonPath = path.join(tempDir, `${name}.comparison.json`);
  fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
  const result = spawnSync(process.execPath, [comparator, matrixPath, sourcePath, forgedPath, comparisonPath], {
    cwd: path.resolve(path.dirname(comparator), '../..'), encoding: 'utf8', stdio: 'pipe',
  });
  let comparison;
  try { comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')); } catch (error) {
    failures.push({ name, error: `comparator did not write a receipt: ${error.message}` });
    return;
  }
  const rejected = result.status !== 0 && comparison.result === 'fail';
  const matched = comparison.differences.some(acceptedDifference);
  if (!rejected || !matched) failures.push({ name, rejected, matched, differences: comparison.differences.slice(0, 3) });
  console.log(JSON.stringify({ name, result: rejected && matched ? 'pass' : 'fail', differences: comparison.differences.length }));
}

const firstWith = (receipt, predicate, message) => {
  const row = receipt.rows.find(predicate);
  if (!row) throw new Error(message);
  return row;
};

runControl('mim-order', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.mimIds && entry.response.mimIds.length >= 2, 'candidate receipt has no mutable ordered MIM sequence');
  [row.response.mimIds[0], row.response.mimIds[1]] = [row.response.mimIds[1], row.response.mimIds[0]];
}, (difference) => difference.kind === 'mim-order');

runControl('prompt-id', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.promptIds && entry.response.promptIds.length >= 1, 'candidate receipt has no prompt IDs');
  row.response.promptIds[0] = 'forged-prompt-id';
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'promptIds');

runControl('esml', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.speeches && entry.response.speeches.length >= 1, 'candidate receipt has no ESML');
  row.response.speeches[0] = `${row.response.speeches[0]} forged`;
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'speeches');

runControl('view', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.commuteViews && entry.response.commuteViews.length >= 1, 'candidate receipt has no commute view');
  row.response.commuteViews[0].view.trafficSource = 'forged-traffic.crn';
}, (difference) => difference.kind === 'traffic-view-source' || (difference.kind === 'source-candidate-response' && difference.field === 'commuteViews'));

runControl('analytics', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.resultsAnalytics, 'candidate receipt has no results analytics');
  row.response.resultsAnalytics.config_state = 'forged';
}, (difference) => difference.kind === 'results-analytics-expected' || (difference.kind === 'source-candidate-response' && difference.field === 'resultsAnalytics'));

runControl('transition', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.transitions && entry.response.transitions.length >= 1, 'candidate receipt has no graph transitions');
  row.response.transitions[0] = 'forged-transition';
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'transitions');

runControl('action', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.response && entry.response.action, 'candidate receipt has no normalized action');
  row.response.action = { forged: true };
}, (difference) => difference.kind === 'source-candidate-response' && difference.field === 'action');

runControl('provider-call', (receipt) => {
  const row = firstWith(receipt, (entry) => entry.dataRequests && entry.dataRequests.length >= 1, 'candidate receipt has no provider call');
  row.dataRequests[0].rawQuery = `${row.dataRequests[0].rawQuery}&forged=1`;
}, (difference) => difference.kind === 'provider-requests' || (difference.kind === 'source-candidate-requests' && difference.field === 'dataRequests'));

console.log(JSON.stringify({ result: failures.length ? 'fail' : 'pass', controls: 8, failures: failures.length, tempDir }));
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
