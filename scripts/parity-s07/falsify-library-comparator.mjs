#!/usr/bin/env node

// Named fail-closed controls for the S-07 differential. Each mutation is made
// in a temporary receipt, and the baseline receipts remain untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [planPath, sourcePath, candidatePath, outPath] = process.argv.slice(2);
if (!planPath || !sourcePath || !candidatePath || !outPath) throw new Error('usage: falsify-library-comparator.mjs PLAN SOURCE CANDIDATE OUT');
const comparator = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'compare-library.mjs');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

function run(name, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's07-library-falsify-'));
  try {
    const left = JSON.parse(JSON.stringify(source));
    const right = JSON.parse(JSON.stringify(candidate));
    mutate(left, right);
    fs.writeFileSync(path.join(dir, 'source.json'), `${JSON.stringify(left)}\n`);
    fs.writeFileSync(path.join(dir, 'candidate.json'), `${JSON.stringify(right)}\n`);
    const result = spawnSync(process.execPath, [comparator, planPath, path.join(dir, 'source.json'), path.join(dir, 'candidate.json'), path.join(dir, 'receipt.json')], { encoding: 'utf8' });
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
    return { name, passed: result.status !== 0 && receipt.result === 'fail', exit: result.status, failures: receipt.failures.length, firstFailure: receipt.failures[0] && receipt.failures[0].kind };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const checks = [];
checks.push(run('forged prompt ID fails', (_left, right) => {
  right.rows[0].result.prompts[0] = `${right.rows[0].result.prompts[0]}_FORGED`;
}));
checks.push(run('forged MIM ID fails', (_left, right) => {
  right.rows[0].result.mims[0] = `${right.rows[0].result.mims[0]}_FORGED`;
}));
checks.push(run('forged ESML fails', (_left, right) => {
  right.rows[0].result.esml[0] = `${right.rows[0].result.esml[0]} FORGED`;
}));
checks.push(run('forged JCP action fails', (_left, right) => {
  right.rows[0].result.action.config.jcp.type = 'FORGED';
}));
checks.push(run('same row omitted from both receipts fails', (_left, right) => {
  const id = _left.rows[_left.rows.length - 1].id;
  _left.rows = _left.rows.filter((row) => row.id !== id);
  right.rows = right.rows.filter((row) => row.id !== id);
}));
checks.push(run('swapped overlapping stem categories fails', (_left, right) => {
  const order = right.candidateMappings.stemMapping.RI_JBO_HasOpinionAbout_SS;
  const first = order.indexOf('Religion');
  const second = order.indexOf('ReligionPerson');
  if (first < 0 || second < 0) throw new Error('overlap control categories missing');
  [order[first], order[second]] = [order[second], order[first]];
}));

const report = { schemaVersion: 1, task: 'S-07', checks, result: checks.every((check) => check.passed) ? 'pass' : 'fail' };
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'pass') process.exitCode = 1;
