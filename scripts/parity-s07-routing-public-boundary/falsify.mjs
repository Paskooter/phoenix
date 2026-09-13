#!/usr/bin/env node

// Run the public-boundary receipt verifier against fresh mutated copies.  The
// mutations are intentionally paired where a row and its malformed guard are
// removed together, proving the checker owns the complete planned inventory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const index = args.indexOf('--receipt');
const receiptPath = path.resolve(index === -1 ? args[0] : args[index + 1]);
const verifier = path.resolve(new URL('./verify.mjs', import.meta.url).pathname);
const summaryIndex = args.indexOf('--summary');
const summaryPath = path.resolve(summaryIndex === -1 ? `${receiptPath}.falsification.json` : args[summaryIndex + 1]);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function run(target) {
  return spawnSync(process.execPath, [verifier, '--receipt', target], { encoding: 'utf8' });
}
const baseline = run(receiptPath);
if (baseline.status !== 0) throw new Error(`baseline receipt failed verification (status ${baseline.status})`);
function freshCopy() {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 's07-public-boundary-falsify-'));
  const target = path.join(targetDir, 'receipt.json');
  fs.copyFileSync(receiptPath, target);
  return target;
}
const records = [];
function reject(label, mutate) {
  const target = freshCopy();
  const receipt = readJson(target);
  mutate(receipt);
  writeJson(target, receipt);
  const result = run(target);
  if (result.status === 0) throw new Error(`${label}: verifier unexpectedly accepted mutation`);
  const last = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  let verifierResult = null;
  try { verifierResult = JSON.parse(last); } catch { /* rejection status remains evidence */ }
  records.push({ label, rejected: true, status: result.status, verifierResult: verifierResult ? { result: verifierResult.result, errors: verifierResult.errors } : null });
}

reject('paired row and guard omission', receipt => {
  receipt.rows = receipt.rows.filter(row => row.id !== 'valid-hot-dogs');
  receipt.malformedGuards = receipt.malformedGuards.filter(guard => guard.id !== 'malformed-result-omitted');
});

reject('captured route mutation', receipt => {
  receipt.rows.find(row => row.id === 'valid-semispecific').request.data.result.memo.mim = 'FORGED_MIM';
});

reject('captured result-shape mutation', receipt => {
  receipt.rows.find(row => row.id === 'valid-hot-dogs').request.data.result = null;
});

reject('forged malformed guard', receipt => {
  receipt.malformedGuards.find(guard => guard.id === 'malformed-nlu-null').pass = false;
});

reject('scope hash mutation', receipt => {
  receipt.scope.scopeFiles['packages/gateway/src/intentRouter.js'] = 'FORGED_SCOPE_HASH';
});

const summary = {
  schemaVersion: 1,
  task: 'S-07 public Chitchat boundary proof falsification',
  baseline: { status: baseline.status, accepted: true },
  cases: records,
  result: records.every(record => record.rejected) ? 'pass' : 'fail',
};
writeJson(summaryPath, summary);
console.log(JSON.stringify({ result: summary.result, baseline: summary.baseline, cases: records.map(({ label, rejected, status }) => ({ label, rejected, status })) }));
if (summary.result !== 'pass') process.exitCode = 1;
