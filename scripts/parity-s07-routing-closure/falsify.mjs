#!/usr/bin/env node

// Exercise the aggregate's fail-closed checks against paired and single-sided
// corruptions.  Each mutation runs from a fresh copy of the compact receipt
// directory, so no raw batch capture is modified and no stale child receipt is
// trusted by the test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(process.argv[2]);
const aggregate = path.resolve(new URL('./aggregate.mjs', import.meta.url).pathname);
const summaryPath = path.join(dir, 'falsification.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function runAggregate(target) {
  return spawnSync(process.execPath, [aggregate, target], { encoding: 'utf8' });
}

const baseline = runAggregate(dir);
if (baseline.status !== 0) throw new Error(`baseline aggregate must pass before falsification (status ${baseline.status})`);

function copyReceipt() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 's07-routing-falsify-'));
  fs.cpSync(dir, target, { recursive: true });
  return target;
}

function batchFor(target, id) {
  const plan = readJson(path.join(target, 'plan.json'));
  const batch = plan.batches.find(item => item.ids.includes(id));
  if (!batch) throw new Error(`row is absent from plan: ${id}`);
  const specPath = path.join(target, batch.name);
  const spec = readJson(specPath);
  const sourcePath = path.join(target, `${batch.name}.source.json`);
  const candidatePath = path.join(target, `${batch.name}.candidate.json`);
  return { plan, batch, spec, specPath, sourcePath, candidatePath, source: readJson(sourcePath), candidate: readJson(candidatePath) };
}

const records = [];
function reject(label, mutate) {
  const target = copyReceipt();
  mutate(target);
  const result = runAggregate(target);
  if (result.status === 0) throw new Error(`${label}: aggregate unexpectedly accepted mutation`);
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  let aggregateResult = null;
  try { aggregateResult = JSON.parse(output); } catch { /* compact status is sufficient */ }
  records.push({ label, rejected: true, status: result.status, aggregateResult: aggregateResult ? { result: aggregateResult.result, coverageErrors: aggregateResult.coverageErrors } : null });
}

reject('paired plan/spec/source/candidate omission', target => {
  const item = batchFor(target, readJson(path.join(target, 'plan.json')).batches[0].ids[0]);
  const id = item.batch.ids[0];
  item.plan.rows -= 1;
  item.plan.batches[0].count -= 1;
  item.plan.batches[0].ids = item.plan.batches[0].ids.filter(value => value !== id);
  item.spec.cases = item.spec.cases.filter(row => row.id !== id);
  item.source.rows = item.source.rows.filter(row => row.id !== id);
  item.candidate.rows = item.candidate.rows.filter(row => row.id !== id);
  writeJson(path.join(target, 'plan.json'), item.plan);
  writeJson(item.specPath, item.spec);
  writeJson(item.sourcePath, item.source);
  writeJson(item.candidatePath, item.candidate);
});

reject('candidate row ID mutation', target => {
  const item = batchFor(target, 'direct-scripted:JBO_AreThereOthersLikeYou');
  const row = item.candidate.rows.find(value => value.id === 'direct-scripted:JBO_AreThereOthersLikeYou');
  row.id = 'FORGED_ROUTE_ID';
  writeJson(item.candidatePath, item.candidate);
});

reject('candidate routing mutation', target => {
  const item = batchFor(target, 'direct-scripted:JBO_AreThereOthersLikeYou');
  const row = item.candidate.rows.find(value => value.id === 'direct-scripted:JBO_AreThereOthersLikeYou');
  row.value.prompts[0].mim_id = 'FORGED_MIM_ID';
  writeJson(item.candidatePath, item.candidate);
});

reject('candidate result mutation', target => {
  const item = batchFor(target, 'ra-flipcoin-heads');
  const row = item.candidate.rows.find(value => value.id === 'ra-flipcoin-heads');
  row.value.prompts[0].esml = `${row.value.prompts[0].esml} forged`;
  writeJson(item.candidatePath, item.candidate);
});

reject('candidate error mutation', target => {
  const item = batchFor(target, 'malformed-result-omitted');
  const row = item.candidate.rows.find(value => value.id === 'malformed-result-omitted');
  row.error.message = 'forged error precedence';
  writeJson(item.candidatePath, item.candidate);
});

reject('paired candidate metadata mutation', target => {
  const plan = readJson(path.join(target, 'plan.json'));
  for (const batch of plan.batches) {
    const candidatePath = path.join(target, `${batch.name}.candidate.json`);
    const candidate = readJson(candidatePath);
    candidate.candidateRevision = 'forged-candidate-revision';
    candidate.runtime = 'v22.22.1-forged';
    writeJson(candidatePath, candidate);
  }
});

reject('normalization provenance mutation', target => {
  const normalizationPath = path.join(target, 'normalization-differential.json');
  const normalization = readJson(normalizationPath);
  normalization.candidateRevision = 'forged-normalization-revision';
  writeJson(normalizationPath, normalization);
});

reject('source metadata mutation', target => {
  const plan = readJson(path.join(target, 'plan.json'));
  const sourcePath = path.join(target, `${plan.batches[0].name}.source.json`);
  const source = readJson(sourcePath);
  source.runtime = 'v8.9.3';
  writeJson(sourcePath, source);
});

const summary = {
  schemaVersion: 1,
  task: 'S-07 routing closure falsification',
  baseline: { status: baseline.status, accepted: true },
  cases: records,
  result: records.every(record => record.rejected) ? 'pass' : 'fail',
};
writeJson(summaryPath, summary);
console.log(JSON.stringify({ result: summary.result, baseline: summary.baseline, cases: records.map(({ label, rejected, status }) => ({ label, rejected, status })) }));
if (summary.result !== 'pass') process.exitCode = 1;
