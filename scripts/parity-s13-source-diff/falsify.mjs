#!/usr/bin/env node

// Deliberately corrupt receipts, provenance, harness inputs, dependencies, and
// candidate files. Every mutation must be rejected by compare.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const reference = process.env.PHOENIX_S13_REFERENCE || path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
const contract = JSON.parse(fs.readFileSync(path.join(here, 'contract.json'), 'utf8'));
const matrix = JSON.parse(fs.readFileSync(path.join(here, 'matrix.json'), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
};
const rowHash = value => sha(JSON.stringify(stable(value)));
const args = (() => {
  const result = { runDir: null, out: null };
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--run-dir') result.runDir = path.resolve(process.argv[++i]);
    else if (process.argv[i] === '--out') result.out = path.resolve(process.argv[++i]);
    else if (process.argv[i] === '--help') { console.log('Usage: node falsify.mjs --run-dir DIR [--out FILE]'); process.exit(0); }
  }
  if (!result.runDir) throw new Error('--run-dir is required');
  result.out ||= path.join(result.runDir, 'falsification.json');
  return result;
})();

const sourcePath = path.join(args.runDir, 'source.json');
const candidatePath = path.join(args.runDir, 'candidate.json');
if (!fs.existsSync(sourcePath) || !fs.existsSync(candidatePath)) throw new Error('baseline source.json and candidate.json are required');
const baselineSource = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const baselineCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

function copyJson(value) { return JSON.parse(JSON.stringify(value)); }
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { mkdirp(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function spawnCompare(name, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-falsify-'));
  const output = path.join(dir, 'comparison');
  const source = options.source || path.join(dir, 'source.json');
  const candidate = options.candidate || path.join(dir, 'candidate.json');
  if (!options.source) writeJson(source, baselineSource);
  if (!options.candidate) writeJson(candidate, baselineCandidate);
  const command = [process.execPath, path.join(here, 'compare.mjs'), '--out', output, '--reference', options.reference || reference, '--source-receipt', source, '--candidate-receipt', candidate];
  if (options.harnessRoot) command.push('--harness-root', options.harnessRoot);
  if (options.candidateRoot) command.push('--candidate-root', options.candidateRoot, '--candidate-revision', contract.candidate.implementationRevision);
  else if (options.candidateRevision) command.push('--candidate-revision', options.candidateRevision);
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, 'log.txt'), `${result.stdout || ''}${result.stderr || ''}`);
  return { name, exit: result.status === null ? 1 : result.status, rejected: result.status !== 0, output: (result.stdout || result.stderr || '').trim(), dir };
}

function receiptMutation(name, mutateSource, mutateCandidate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-receipt-'));
  const source = copyJson(baselineSource);
  const candidate = copyJson(baselineCandidate);
  if (mutateSource) mutateSource(source);
  if (mutateCandidate) mutateCandidate(candidate);
  const sourceFile = path.join(dir, 'source.json');
  const candidateFile = path.join(dir, 'candidate.json');
  writeJson(sourceFile, source);
  writeJson(candidateFile, candidate);
  return spawnCompare(name, { source: sourceFile, candidate: candidateFile });
}

function copyHarness() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-harness-'));
  fs.cpSync(here, destination, { recursive: true });
  return destination;
}
function copyCandidateOverlay() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-candidate-'));
  const files = [...Object.keys(matrix.candidate.paths), ...Object.keys(matrix.candidate.resources), ...Object.keys(matrix.candidate.dependencies)];
  for (const relative of files) {
    const target = path.join(destination, relative);
    mkdirp(path.dirname(target));
    fs.copyFileSync(path.join(worktree, relative), target);
  }
  return destination;
}
function copyReferenceOverlay() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-reference-'));
  for (const entry of fs.readdirSync(reference)) {
    if (entry === 'parity-prepared.json') continue;
    fs.symlinkSync(path.join(reference, entry), path.join(destination, entry), fs.lstatSync(path.join(reference, entry)).isDirectory() ? 'dir' : 'file');
  }
  fs.copyFileSync(path.join(reference, 'parity-prepared.json'), path.join(destination, 'parity-prepared.json'));
  return destination;
}

const checks = [];
checks.push(receiptMutation('paired row omission is rejected', source => { source.rows.pop(); }, candidate => { candidate.rows.pop(); }));
checks.push(receiptMutation('row reorder is rejected', null, candidate => { [candidate.rows[0], candidate.rows[1]] = [candidate.rows[1], candidate.rows[0]]; }));
checks.push(receiptMutation('duplicate row is rejected', null, candidate => { candidate.rows[1].id = candidate.rows[0].id; }));
checks.push(receiptMutation('row self-hash corruption is rejected', null, candidate => { candidate.rows[0].runs[0].outcome.value.componentConfigs[0].assets[0].src = 'corrupt'; }));
checks.push(receiptMutation('rehash output mutation is rejected by differential', null, candidate => {
  candidate.rows[0].runs[0].outcome.value.componentConfigs[0].assets[0].src = 'corrupt';
  candidate.rows[0].runs[0].sha256 = rowHash(candidate.rows[0].runs[0].outcome);
}));
checks.push(receiptMutation('input provenance substitution is rejected', null, candidate => { candidate.rows[0].specSha256 = '0'.repeat(64); }));
checks.push(receiptMutation('source provenance mutation is rejected', source => { source.source.revision = '0'.repeat(40); }));
checks.push(receiptMutation('candidate tested revision mutation is rejected', null, candidate => { candidate.candidate.testedRevision = '0'.repeat(40); }));
checks.push(spawnCompare('non-descendant candidate revision is rejected', { candidateRevision: '9195ce30a6d2b8c3a2b2985c1dfc8d49b48ae066' }));
checks.push(receiptMutation('explicit tagged error substitution is rejected', null, candidate => {
  const outcome = { status: 'rejected', error: { name: 'Error', message: 'falsified' } };
  candidate.rows[0].runs[0].outcome = outcome;
  candidate.rows[0].runs[0].sha256 = rowHash(outcome);
}));

for (const [name, file] of [['source runner substitution is rejected', 'run-source.cjs'], ['candidate runner substitution is rejected', 'run-candidate.mjs']]) {
  const harness = copyHarness();
  fs.appendFileSync(path.join(harness, file), '\n// falsified harness mutation\n');
  checks.push(spawnCompare(name, { harnessRoot: harness }));
}
{
  const harness = copyHarness();
  const replacement = copyJson(matrix);
  replacement.rows.pop();
  writeJson(path.join(harness, 'matrix.json'), replacement);
  checks.push(spawnCompare('matrix replacement/paired omission is rejected', { harnessRoot: harness }));
}
{
  const candidate = copyCandidateOverlay();
  fs.appendFileSync(path.join(candidate, 'packages/skills/src/report/weatherViews.js'), '\n// falsified candidate implementation mutation\n');
  checks.push(spawnCompare('candidate implementation mutation is rejected', { candidateRoot: candidate }));
}
{
  const candidate = copyCandidateOverlay();
  fs.appendFileSync(path.join(candidate, 'packages/skills/resources/views/weatherHiLo.json'), '\n');
  checks.push(spawnCompare('candidate resource mutation is rejected', { candidateRoot: candidate }));
}
{
  const source = copyReferenceOverlay();
  fs.appendFileSync(path.join(source, 'parity-prepared.json'), '\n');
  checks.push(spawnCompare('source dependency record mutation is rejected', { reference: source }));
}

const summary = {
  schema: 'phoenix.parity.s13.report-view-falsification.v1',
  task: 'S-13',
  baseline: { runDir: args.runDir, sourceRows: baselineSource.rows && baselineSource.rows.length, candidateRows: baselineCandidate.rows && baselineCandidate.rows.length, result: 'pass' },
  checks: checks.map(item => ({ name: item.name, expected: 'rejected', exit: item.exit, actual: item.rejected ? 'rejected' : 'accepted', rejected: item.rejected })),
  result: checks.every(item => item.rejected) ? 'pass' : 'fail',
};
writeJson(args.out, summary);
console.log(JSON.stringify({ result: summary.result, checks: summary.checks.map(({ name, actual, exit }) => ({ name, actual, exit })), out: args.out }));
if (summary.result !== 'pass') process.exitCode = 1;
