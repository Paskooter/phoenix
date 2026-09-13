#!/usr/bin/env node

// Exercise the same receipt validation and semantic comparison used by the
// normal S-11 run.  Mutations are isolated temporary copies and never alter
// the baseline receipts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const comparator = path.join(here, 'compare.mjs');
const fixture = createRequire(import.meta.url)(path.join(here, 'fixtures.cjs'));

function parseArgs(argv) {
  const args = { runDir: path.join(root, '.parity/runs/s11-commute'), out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run-dir') args.runDir = path.resolve(argv[++index]);
    else if (argv[index] === '--out') args.out = path.resolve(argv[++index]);
    else if (argv[index] === '--help') {
      console.log('Usage: node falsify.mjs [--run-dir DIR] [--out PATH]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function rowHash(value) { return sha(JSON.stringify(fixture.stable(value))); }

const args = parseArgs(process.argv.slice(2));
const baselineSourcePath = path.join(args.runDir, 'source.json');
const baselineCandidatePath = path.join(args.runDir, 'candidate.json');
const baselineSource = readJson(baselineSourcePath);
const baselineCandidate = readJson(baselineCandidatePath);
const baselineRevision = baselineCandidate.candidate && baselineCandidate.candidate.revision;
if (!/^[0-9a-f]{40}$/.test(baselineRevision || '')) throw new Error('baseline candidate revision is missing or malformed');

function invokeComparator(sourcePath, candidatePath, outDir) {
  fs.mkdirSync(outDir);
  return spawnSync(process.execPath, [
    comparator,
    '--source-receipt', sourcePath,
    '--candidate-receipt', candidatePath,
    '--candidate-revision', baselineRevision,
    '--out', outDir,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}

const baselineCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-baseline-check-'));
try {
  const baselineOutDir = path.join(baselineCheck, 'check');
  const baselineResult = invokeComparator(baselineSourcePath, baselineCandidatePath, baselineOutDir);
  const baselineReport = readJson(path.join(baselineOutDir, 'comparison.json'));
  if (baselineResult.status !== 0 || baselineReport.result !== 'pass') throw new Error('baseline receipt check did not pass');
} finally {
  fs.rmSync(baselineCheck, { recursive: true, force: true });
}

function execute(name, expectedResult, mutate) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-falsify-'));
  const sourcePath = path.join(temp, 'source.json');
  const candidatePath = path.join(temp, 'candidate.json');
  const outDir = path.join(temp, 'check');
  try {
    const source = clone(baselineSource);
    const candidate = clone(baselineCandidate);
    mutate(source, candidate);
    writeJson(sourcePath, source);
    writeJson(candidatePath, candidate);
    const result = invokeComparator(sourcePath, candidatePath, outDir);
    const report = readJson(path.join(outDir, 'comparison.json'));
    const rejected = result.status !== 0 && report.result === expectedResult;
    return {
      name,
      expectedResult,
      actualResult: report.result,
      exit: result.status,
      rejected,
      fatal: report.fatal ? String(report.fatal).split('\n')[0] : null,
      differences: report.differences.length,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const checks = [
  execute('missing archived row is rejected', 'fail', (source, candidate) => {
    source.cases.pop();
    candidate.cases.pop();
  }),
  execute('candidate row reorder is rejected', 'fail', (_source, candidate) => {
    [candidate.cases[0], candidate.cases[1]] = [candidate.cases[1], candidate.cases[0]];
  }),
  execute('rehashed candidate semantic mutation is detected', 'diff', (_source, candidate) => {
    const row = candidate.cases.find(item => item.id === 's11:commute:03');
    row.runs[0].value.mims[0] = `${row.runs[0].value.mims[0]}-FORGED`;
    row.runs[0].sha256 = rowHash(row.runs[0].value);
  }),
];

const summary = {
  schema: 'phoenix.parity.s11.commute-falsification.v1',
  task: 'S-11',
  baseline: { runDir: args.runDir, candidateRevision: baselineRevision, result: 'pass' },
  checks,
  result: checks.every(item => item.rejected) ? 'pass' : 'fail',
};
const outPath = args.out || path.join(args.runDir, 'falsification.json');
writeJson(outPath, summary);
console.log(JSON.stringify({ result: summary.result, checks: checks.map(({ name, expectedResult, actualResult, exit, rejected }) => ({ name, expectedResult, actualResult, exit, rejected })), out: outPath }));
if (summary.result !== 'pass') process.exitCode = 1;
