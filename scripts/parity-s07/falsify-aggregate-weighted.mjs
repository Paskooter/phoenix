#!/usr/bin/env node

// Deliberately mutate one raw source receipt while leaving its already-passing
// differential receipt untouched. The aggregate must reject the stale diff by
// its recorded input byte/SHA-256 metadata. The raw file is restored in a
// finally block before this process exits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name) { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; }
const reportPath = arg('--out');
if (!reportPath) throw new Error('usage: falsify-aggregate-weighted.mjs AGGREGATE_ARGS... --out REPORT');
const aggregate = path.join(path.dirname(new URL(import.meta.url).pathname), 'aggregate-weighted.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-weighted-aggregate-falsify-'));
const rewrittenArgs = [...args];
const sourceTemplate = arg('--source-template');
const planTemplate = arg('--plan-template');
const candidateTemplate = arg('--candidate-template');
const diffTemplate = arg('--diff-template');
const contextsPath = arg('--contexts');
const eligibilityPath = arg('--eligibility');
if (!sourceTemplate || !planTemplate || !candidateTemplate || !diffTemplate || !contextsPath || !eligibilityPath) throw new Error('missing aggregate input option');
const batchCount = Number(arg('--batch-count') || 24);
const batchSize = Number(arg('--batch-size') || 1000);
function expand(template, offset) {
  const five = String(offset).padStart(5, '0');
  const source = offset === 0 ? '000' : five;
  return template.replaceAll('{offset}', five).replaceAll('{sourceOffset}', source);
}
function replacePathOption(name, value) {
  const index = rewrittenArgs.indexOf(name);
  if (index === -1) rewrittenArgs.push(name, value);
  else rewrittenArgs[index + 1] = value;
}
function replaceOption(name, value) {
  const index = rewrittenArgs.indexOf(name);
  if (index === -1) rewrittenArgs.push(name, value);
  else rewrittenArgs[index + 1] = value;
}
replaceOption('--out-summary', path.join(temp, 'summary.json'));
replaceOption('--out-manifest', path.join(temp, 'manifest.json'));
// Rebuild a lightweight input directory with symlinks. Only the first source
// receipt is copied and forged, so the original root-owned /tmp files remain
// untouched and every differential's recorded paths can be rewritten to the
// exact temporary paths used by the aggregate.
const tempContexts = path.join(temp, 'contexts.json');
const tempEligibility = path.join(temp, 'eligibility.json');
fs.symlinkSync(contextsPath, tempContexts);
fs.symlinkSync(eligibilityPath, tempEligibility);
for (let batch = 0; batch < batchCount; batch += 1) {
  const start = batch * batchSize;
  const key = String(start).padStart(5, '0');
  for (const [template, prefix] of [[planTemplate, 'plan'], [candidateTemplate, 'candidate']]) {
    const originalPath = expand(template, start);
    fs.symlinkSync(originalPath, path.join(temp, `${prefix}-${key}.json`));
  }
  const originalSource = expand(sourceTemplate, start);
  const tempSource = path.join(temp, `source-${key}.json`);
  if (batch === 0) {
    const forged = JSON.parse(fs.readFileSync(originalSource, 'utf8'));
    forged.falsifiedRawReceipt = true;
    fs.writeFileSync(tempSource, `${JSON.stringify(forged, null, 2)}\n`);
  } else fs.symlinkSync(originalSource, tempSource);
  const originalDiff = expand(diffTemplate, start);
  const diff = JSON.parse(fs.readFileSync(originalDiff, 'utf8'));
  diff.inputs = [
    path.join(temp, `plan-${key}.json`),
    tempSource,
    path.join(temp, `candidate-${key}.json`),
    tempEligibility,
  ].map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  // Deliberately leave the forged source's recorded bytes/hash stale.
  if (batch === 0) {
    const originalInput = JSON.parse(fs.readFileSync(originalDiff, 'utf8')).inputs[1];
    diff.inputs[1] = { path: tempSource, bytes: originalInput.bytes, sha256: originalInput.sha256 };
  }
  fs.writeFileSync(path.join(temp, `diff-${key}.json`), `${JSON.stringify(diff, null, 2)}\n`);
}
replacePathOption('--contexts', tempContexts);
replacePathOption('--eligibility', tempEligibility);
replacePathOption('--plan-template', path.join(temp, 'plan-{offset}.json'));
replacePathOption('--source-template', path.join(temp, 'source-{offset}.json'));
replacePathOption('--candidate-template', path.join(temp, 'candidate-{offset}.json'));
replacePathOption('--diff-template', path.join(temp, 'diff-{offset}.json'));
let status = null;
let output = '';
const result = spawnSync(process.execPath, [aggregate, ...rewrittenArgs.filter((value, index) => !(value === '--out' && index + 1 < rewrittenArgs.length))], { encoding: 'utf8' });
status = result.status;
output = `${result.stdout || ''}${result.stderr || ''}`;
const passed = status !== 0 && /diff-input-(?:bytes|sha256)/.test(output);
const staleCheck = {
  name: 'stale-differential-rejects-mutated-raw-source',
  passed,
  exitStatus: status,
  failureCodeObserved: (output.match(/diff-input-(?:bytes|sha256)/) || [null])[0],
  temporaryDirectory: temp,
};

// A stale-diff hash check alone does not prove semantic aggregation.  Build a
// second private input set with both source and candidate response envelopes
// corrupted, refresh every diff input hash, and require the aggregate's
// per-batch comparator rerun to reject the paired forgery.
const pairedTemp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-weighted-aggregate-paired-falsify-'));
const pairedContexts = path.join(pairedTemp, 'contexts.json');
const pairedEligibility = path.join(pairedTemp, 'eligibility.json');
fs.symlinkSync(contextsPath, pairedContexts);
fs.symlinkSync(eligibilityPath, pairedEligibility);
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
for (let batch = 0; batch < batchCount; batch += 1) {
  const start = batch * batchSize;
  const key = String(start).padStart(5, '0');
  const originalPlan = expand(planTemplate, start);
  const originalCandidate = expand(candidateTemplate, start);
  const originalSource = expand(sourceTemplate, start);
  const originalDiff = expand(diffTemplate, start);
  fs.symlinkSync(originalPlan, path.join(pairedTemp, `plan-${key}.json`));
  if (batch !== 0) fs.symlinkSync(originalCandidate, path.join(pairedTemp, `candidate-${key}.json`));
  const pairedSource = path.join(pairedTemp, `source-${key}.json`);
  if (batch === 0) {
    const forgedSource = JSON.parse(fs.readFileSync(originalSource, 'utf8'));
    const forgedCandidate = JSON.parse(fs.readFileSync(originalCandidate, 'utf8'));
    delete forgedSource.rows[0].result.responseType;
    delete forgedCandidate.rows[0].result.responseType;
    fs.writeFileSync(pairedSource, `${JSON.stringify(forgedSource, null, 2)}\n`);
    fs.writeFileSync(path.join(pairedTemp, `candidate-${key}.json`), `${JSON.stringify(forgedCandidate, null, 2)}\n`);
  } else fs.symlinkSync(originalSource, pairedSource);
  const diff = JSON.parse(fs.readFileSync(originalDiff, 'utf8'));
  diff.inputs = [
    path.join(pairedTemp, `plan-${key}.json`),
    pairedSource,
    path.join(pairedTemp, `candidate-${key}.json`),
    pairedEligibility,
  ].map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: digest(file) }));
  fs.writeFileSync(path.join(pairedTemp, `diff-${key}.json`), `${JSON.stringify(diff, null, 2)}\n`);
}
const pairedArgs = [...args];
function setPairedOption(name, value) {
  const index = pairedArgs.indexOf(name);
  if (index === -1) pairedArgs.push(name, value);
  else pairedArgs[index + 1] = value;
}
setPairedOption('--out-summary', path.join(pairedTemp, 'summary.json'));
setPairedOption('--out-manifest', path.join(pairedTemp, 'manifest.json'));
setPairedOption('--contexts', pairedContexts);
setPairedOption('--eligibility', pairedEligibility);
setPairedOption('--plan-template', path.join(pairedTemp, 'plan-{offset}.json'));
setPairedOption('--source-template', path.join(pairedTemp, 'source-{offset}.json'));
setPairedOption('--candidate-template', path.join(pairedTemp, 'candidate-{offset}.json'));
setPairedOption('--diff-template', path.join(pairedTemp, 'diff-{offset}.json'));
const pairedResult = spawnSync(process.execPath, [aggregate, ...pairedArgs.filter((value, index) => !(value === '--out' && index + 1 < pairedArgs.length))], { encoding: 'utf8' });
const pairedOutput = `${pairedResult.stdout || ''}${pairedResult.stderr || ''}`;
const pairedPassed = pairedResult.status !== 0 && /aggregate-comparator-(?:status|result|drift)/.test(pairedOutput);
const pairedCheck = {
  name: 'aggregate-rerun-rejects-paired-response-corruption',
  passed: pairedPassed,
  exitStatus: pairedResult.status,
  failureCodeObserved: (pairedOutput.match(/aggregate-comparator-(?:status|result|drift)/) || [null])[0],
  temporaryDirectory: pairedTemp,
};

const report = {
  schemaVersion: 1,
  task: 'S-07',
  lane: 'weighted',
  result: passed && pairedPassed ? 'pass' : 'fail',
  passed: passed && pairedPassed,
  checks: [staleCheck, pairedCheck],
  rawUnchanged: true,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.passed || !report.rawUnchanged) process.exitCode = 1;
