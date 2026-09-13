#!/usr/bin/env node

// Deliberate comparator falsification for the weighted S-07 lane.  The input
// files are one bounded batch; each mutation is written to a private /tmp
// directory and must make compare-weighted exit nonzero.  The production
// receipts are never edited.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [planPath, sourcePath, candidatePath, eligibilityPath, outPath] = process.argv.slice(2);
if (!planPath || !sourcePath || !candidatePath || !eligibilityPath || !outPath) {
  throw new Error('usage: falsify-weighted.mjs PLAN SOURCE CANDIDATE ELIGIBILITY OUT');
}
const comparator = path.join(path.dirname(new URL(import.meta.url).pathname), 'compare-weighted.mjs');
const base = {
  plan: JSON.parse(fs.readFileSync(planPath, 'utf8')),
  source: JSON.parse(fs.readFileSync(sourcePath, 'utf8')),
  candidate: JSON.parse(fs.readFileSync(candidatePath, 'utf8')),
  eligibility: JSON.parse(fs.readFileSync(eligibilityPath, 'utf8')),
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-weighted-falsify-'));
const checks = [];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
function run(name, mutate, expectedCodes, mutateEligibility = null) {
  const plan = clone(base.plan);
  const source = clone(base.source);
  const candidate = clone(base.candidate);
  const eligibility = clone(base.eligibility);
  mutate(plan, source, candidate);
  if (mutateEligibility) mutateEligibility(eligibility);
  const prefix = path.join(temp, name);
  const p = `${prefix}-plan.json`; const s = `${prefix}-source.json`; const c = `${prefix}-candidate.json`; const e = `${prefix}-eligibility.json`; const d = `${prefix}-diff.json`;
  write(p, plan); write(s, source); write(c, candidate); write(e, eligibility);
  const result = spawnSync(process.execPath, [comparator, p, s, c, d, e], { encoding: 'utf8' });
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(d, 'utf8')); } catch (err) { summary = { result: 'missing', failures: [{ code: 'no-summary', detail: String(err) }] }; }
  const codes = (summary.failures || []).map((failure) => failure.code);
  const matched = result.status !== 0 && summary.result === 'fail' && expectedCodes.some((code) => codes.includes(code));
  checks.push({ name, passed: matched, exitStatus: result.status, result: summary.result, failureCodes: codes.slice(0, 5) });
}

run('forged-expected-prompt', (plan) => {
  plan.cases[0].expectedPrompt = `${plan.cases[0].expectedPrompt || 'forged'}-FORGED`;
}, ['expected-prompt-outside-eligible', 'source-expected-prompt', 'candidate-expected-prompt']);

run('forged-weight', (plan) => {
  plan.cases[0].expectedEligible[0].weight += 1;
}, ['expected-weight-total', 'expected-eligible-oracle']);

run('forged-outer-rng-input', (plan, source) => {
  source.rows[0].rngInput[0] = source.rows[0].rngInput[0] + 0.001;
}, ['source-rng-input']);

run('forged-vm-rng-call-count', (plan, source, candidate) => {
  candidate.rows[0].vmRngCalls += 1;
}, ['candidate-vm-rng-call-count', 'source-candidate-observable-difference']);

run('forged-vm-control-flag', (plan, source, candidate) => {
  candidate.vmRandomControlled = false;
}, ['candidate-vm-random-control']);

run('forged-source-runtime', (plan, source) => {
  source.runtime = 'v8.9.3';
}, ['source-runtime']);

run('forged-candidate-runtime', (plan, source, candidate) => {
  candidate.runtime = 'v22.21.0';
}, ['candidate-runtime']);

run('forged-candidate-revision', (plan, source, candidate) => {
  candidate.candidateRevision = '0000000000000000000000000000000000000000';
}, ['candidate-revision']);

run('forged-no-eligible-control', (plan) => {
  const row = plan.cases.find((item) => item.expectedEligible.length === 0);
  if (!row) throw new Error('batch does not contain a no-eligible control');
  row.expectedEligible = [{ prompt_id: 'forged-no-eligible', weight: 1 }];
  row.expectedWeightTotal = 1;
}, ['expected-eligible-oracle']);

run('forged-eligibility-revision', () => {}, ['eligibility-source-revision'], (eligibility) => {
  eligibility.sourceRevision = 'forged-source-revision';
});

run('forged-oracle-context-metadata', () => {}, ['oracle-context-metadata'], (eligibility) => {
  eligibility.rows[0].profile = 'weighted|referent=not-a-real-value';
});

run('forged-profile-value', (plan) => {
  plan.cases[0].profile = 'weighted|referent=not-a-real-value';
}, ['source-plan-row-metadata', 'candidate-plan-row-metadata']);

run('paired-row-omission', (plan, source, candidate) => {
  plan.cases.pop();
  source.rows.pop();
  candidate.rows.pop();
}, ['source-plan-count', 'candidate-plan-count', 'source-row-count', 'candidate-row-count']);

run('paired-context-omission', (plan, source, candidate) => {
  const contextId = plan.cases[0].contextId;
  plan.cases = plan.cases.filter((row) => row.contextId !== contextId);
  source.rows = source.rows.filter((row) => row.id !== undefined && !row.id.startsWith(`weighted:${contextId}:`));
  candidate.rows = candidate.rows.filter((row) => row.id !== undefined && !row.id.startsWith(`weighted:${contextId}:`));
}, ['context-inventory']);

run('forged-wire-action', (plan, source, candidate) => {
  if (candidate.rows[0].result && candidate.rows[0].result.action) candidate.rows[0].result.action.type = 'FORGED';
}, ['source-candidate-observable-difference']);

// These paired mutations model the prior blind spot: source and candidate
// must not be allowed to agree on a forged wire envelope.  The comparator's
// source-derived invariants must reject both copies independently.
run('paired-response-envelope-omission', (plan, source, candidate) => {
  delete source.rows[0].result.responseType;
  delete candidate.rows[0].result.responseType;
}, ['source-result-envelope', 'candidate-result-envelope']);

run('paired-final-corruption', (plan, source, candidate) => {
  source.rows[0].result.final = false;
  candidate.rows[0].result.final = false;
}, ['source-final', 'candidate-final']);

run('paired-fire-and-forget-corruption', (plan, source, candidate) => {
  source.rows[0].result.fireAndForget = true;
  candidate.rows[0].result.fireAndForget = true;
}, ['source-fire-and-forget', 'candidate-fire-and-forget']);

run('paired-analytics-omission', (plan, source, candidate) => {
  delete source.rows[0].result.analytics;
  delete candidate.rows[0].result.analytics;
}, ['source-result-envelope', 'candidate-result-envelope']);

run('paired-analytics-value-corruption', (plan, source, candidate) => {
  source.rows[0].result.analytics['chitchat-skill'][1].properties.type = 'forged_query_type';
  candidate.rows[0].result.analytics['chitchat-skill'][1].properties.type = 'forged_query_type';
}, ['source-analytics-query', 'candidate-analytics-query']);

run('paired-action-type-corruption', (plan, source, candidate) => {
  source.rows[0].result.action.type = 'FORGED';
  candidate.rows[0].result.action.type = 'FORGED';
}, ['source-action-type', 'candidate-action-type']);

run('paired-jcp-type-corruption', (plan, source, candidate) => {
  source.rows[0].result.action.config.jcp.type = 'FORGED';
  candidate.rows[0].result.action.config.jcp.type = 'FORGED';
}, ['source-action-jcp-type', 'candidate-action-jcp-type']);

run('paired-normalized-envelope-omission', (plan, source, candidate) => {
  delete source.rows[0].result.mims;
  delete candidate.rows[0].result.mims;
}, ['source-result-envelope', 'candidate-result-envelope']);

run('paired-rng-vector-corruption', (plan, source, candidate) => {
  plan.cases[0].rngValues = [0.875];
  source.rows[0].rngInput = [0.875];
  candidate.rows[0].rngInput = [0.875];
}, ['plan-rng-vector']);

run('forged-mim-tree-digest', (plan, source, candidate) => {
  plan.inventory.promptSourceTreeSha256 = '0'.repeat(64);
  source.mimInventory.treeSha256 = '0'.repeat(64);
  candidate.mimInventory.treeSha256 = '0'.repeat(64);
}, ['plan-mim-tree-digest', 'source-mim-inventory', 'candidate-mim-inventory']);

const failed = checks.filter((check) => !check.passed);
const report = {
  schemaVersion: 1,
  task: 'S-07',
  lane: 'weighted',
  result: failed.length ? 'fail' : 'pass',
  checks,
  tempDirectory: temp,
};
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;
