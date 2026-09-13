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
const matrixPath = path.join(here, 'matrix.json');
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
function recomputeMatrixSelfHashes(matrix) {
  const inventory = matrix.cases.map(({ id, group, sourceName, sourceLine, assertionCount, runs }) => ({
    id, group, sourceName, sourceLine, assertionCount, runCount: runs.length,
  }));
  matrix.inventorySha256 = sha(JSON.stringify(inventory));
  matrix.caseMatrixSha256 = sha(JSON.stringify(matrix.cases));
  matrix.supplementalMatrixSha256 = sha(JSON.stringify(matrix.supplemental));
}

const args = parseArgs(process.argv.slice(2));
const baselineSourcePath = path.join(args.runDir, 'source.json');
const baselineCandidatePath = path.join(args.runDir, 'candidate.json');
const baselineSource = readJson(baselineSourcePath);
const baselineCandidate = readJson(baselineCandidatePath);
const baselineRevision = baselineCandidate.candidate && baselineCandidate.candidate.revision;
if (!/^[0-9a-f]{40}$/.test(baselineRevision || '')) throw new Error('baseline candidate revision is missing or malformed');
const referenceCandidates = [
  process.env.PHOENIX_S11_REFERENCE,
  path.join(root, '.parity/reference', baselineSource.reference && baselineSource.reference.revision || ''),
  '/home/shell/work/phoenix/.parity/reference/' + (baselineSource.reference && baselineSource.reference.revision || ''),
].filter(Boolean);
const referencePath = referenceCandidates.find(file => fs.existsSync(file));
if (!referencePath) throw new Error('pinned S-11 reference checkout is unavailable');

function invokeComparator(sourcePath, candidatePath, outDir, extra = {}) {
  fs.mkdirSync(outDir);
  const baseRoot = extra.root || root;
  const comparatorPath = extra.root ? path.join(extra.root, 'scripts/parity-s11-source-diff/compare.mjs') : comparator;
  const argv = [
    comparatorPath,
    '--source-receipt', sourcePath,
    '--candidate-receipt', candidatePath,
    '--candidate-revision', baselineRevision,
    '--out', outDir,
  ];
  if (extra.matrix) argv.push('--matrix', extra.matrix);
  if (extra.reference) argv.push('--reference', extra.reference);
  return spawnSync(process.execPath, argv, { cwd: baseRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}

const baselineCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-baseline-check-'));
try {
  const baselineOutDir = path.join(baselineCheck, 'check');
  const baselineResult = invokeComparator(baselineSourcePath, baselineCandidatePath, baselineOutDir, { reference: referencePath });
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
    const result = invokeComparator(sourcePath, candidatePath, outDir, { reference: referencePath });
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

function executeMatrix(name, mutate) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-matrix-falsify-'));
  const mutatedMatrixPath = path.join(temp, 'matrix.json');
  const outDir = path.join(temp, 'check');
  try {
    const matrix = clone(readJson(matrixPath));
    mutate(matrix);
    recomputeMatrixSelfHashes(matrix);
    writeJson(mutatedMatrixPath, matrix);
    const result = invokeComparator(baselineSourcePath, baselineCandidatePath, outDir, {
      matrix: mutatedMatrixPath,
      reference: referencePath,
    });
    const report = readJson(path.join(outDir, 'comparison.json'));
    return {
      name,
      expectedResult: 'fail',
      actualResult: report.result,
      exit: result.status,
      rejected: result.status !== 0 && report.result === 'fail',
      fatal: report.fatal ? String(report.fatal).split('\n')[0] : null,
      differences: report.differences.length,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function executeCandidateMutation(name, mutate) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-candidate-falsify-'));
  fs.rmSync(temp, { recursive: true, force: true });
  const added = spawnSync('git', ['worktree', 'add', '--detach', temp, baselineRevision], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (added.status !== 0) throw new Error('cannot create candidate falsification worktree: ' + (added.stderr || added.status));
  try {
    const sourceHarness = path.join(root, 'scripts/parity-s11-source-diff');
    const targetHarness = path.join(temp, 'scripts/parity-s11-source-diff');
    fs.readdirSync(sourceHarness).forEach(namePart => {
      fs.cpSync(path.join(sourceHarness, namePart), path.join(targetHarness, namePart), { recursive: true, force: true });
    });
    mutate(temp);
    const outDir = path.join(temp, '.parity-falsify-check');
    const result = invokeComparator(baselineSourcePath, baselineCandidatePath, outDir, {
      root: temp,
      reference: referencePath,
    });
    const report = readJson(path.join(outDir, 'comparison.json'));
    return {
      name,
      expectedResult: 'fail',
      actualResult: report.result,
      exit: result.status,
      rejected: result.status !== 0 && report.result === 'fail',
      fatal: report.fatal ? String(report.fatal).split('\n')[0] : null,
      differences: report.differences.length,
    };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', temp], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function replaceOnce(worktree, file, before, after) {
  const target = path.join(worktree, file);
  const text = fs.readFileSync(target, 'utf8');
  if (text.indexOf(before) === -1) throw new Error('falsification target was not found: ' + file);
  fs.writeFileSync(target, text.replace(before, after));
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

checks.push(
  execute('undefined-to-null projection mutation is detected', 'diff', (_source, candidate) => {
    const row = candidate.cases.find(item => item.id === 's11:commute:16');
    row.runs[0].value = null;
    row.runs[0].sha256 = rowHash(row.runs[0].value);
  }),
  execute('MIM path prefix projection mutation is detected', 'diff', (_source, candidate) => {
    const row = candidate.cases.find(item => item.id === 's11:commute:17');
    row.runs[0].value.mims[0] = 'mims/corrupt-prefix/' + row.runs[0].value.mims[0];
    row.runs[0].sha256 = rowHash(row.runs[0].value);
  }),
  executeMatrix('rehashed primary row replacement is rejected', matrix => {
    const row = matrix.cases[15];
    row.id = 's11:forged:16';
    row.sourceName = 'forged primary row';
    row.sourceLine = 999;
    row.runs[0].operation = 'logic';
  }),
  executeMatrix('rehashed supplemental driving rewrite is rejected', matrix => {
    matrix.supplemental.cases[0].runs[0].prefs.commute.mode = 'invalid-mode';
  }),
  executeMatrix('reference testPath replacement is rejected', matrix => {
    matrix.reference.testPath = matrix.reference.testSupportPath;
    matrix.reference.testSha256 = matrix.reference.testSupportSha256;
  }),
  executeCandidateMutation('undefined-to-null implementation mutation is rejected', worktree => {
    replaceOnce(worktree, 'packages/skills/src/report/commute.js',
      'if (!userPrefs || !userPrefs.commute.complete) return undefined;',
      'if (!userPrefs || !userPrefs.commute.complete) return null;');
  }),
  executeCandidateMutation('MIM path prefix implementation mutation is rejected', worktree => {
    replaceOnce(worktree, 'packages/skills/src/report/utils.js',
      'return join(MIM_DIR, ', "return join(MIM_DIR, 'corrupt-prefix', ");
  }),
  executeCandidateMutation('stale receipt after current implementation change is rejected', worktree => {
    replaceOnce(worktree, 'packages/skills/src/report/commute.js',
      'if (!userPrefs || !userPrefs.commute.complete) return undefined;',
      'if (!userPrefs || !userPrefs.commute.complete) return null;');
  }),
);

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
