#!/usr/bin/env node

// Reproduce S-11 from a clean checkout: run the pinned Pegasus build in its
// immutable Node 8 image with --network none, run Phoenix against a local ORS
// seam, compare receipts, then run the fail-closed falsifiers.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const defaultReference = fs.existsSync(path.join(root, '.parity/reference/5c0a7390539663ba749d360de348a428c088505c'))
  ? path.join(root, '.parity/reference/5c0a7390539663ba749d360de348a428c088505c')
  : path.join(path.dirname(root), 'phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
const reference = path.resolve(option('--reference', defaultReference));
const matrixPath = path.resolve(option('--matrix', path.join(here, 'matrix.json')));
const outDir = path.resolve(option('--out', path.join(root, '.parity/runs/s11-data-maps-diff')));
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const sourceImageRef = `${matrix.reference.sourceImage}@${matrix.reference.sourceImageDigest}`;

function fail(message) { throw new Error(message); }
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}
function runChecked(label, command, commandArgs, options = {}) {
  const result = run(command, commandArgs, options);
  if (result.status !== 0) {
    const detail = `${String(result.stdout || '').trim()}\n${String(result.stderr || '').trim()}`.trim();
    fail(`${label} failed (${result.status}): ${detail.slice(-4000)}`);
  }
  return result;
}
function writeLog(name, result) {
  fs.writeFileSync(path.join(outDir, name), `${String(result.stdout || '')}${String(result.stderr || '')}`);
}

if (matrix.schema !== 'phoenix.parity.s11.data-maps-http-matrix.v1') fail('unexpected matrix schema');
if (matrix.base !== '55e23ac') fail(`unexpected base: ${matrix.base}`);
if (!fs.existsSync(reference)) fail(`reference checkout missing: ${reference}`);
fs.mkdirSync(outDir, { recursive: true });

const image = runChecked('pinned source image inspection', 'docker', ['image', 'inspect', sourceImageRef, '--format', '{{.Id}}']);
if (image.stdout.trim() !== matrix.reference.sourceImageDigest) fail(`source image digest mismatch: ${image.stdout.trim()}`);

const sourceReceipt = path.join(outDir, 'source.json');
const candidateReceipt = path.join(outDir, 'candidate.json');
const comparison = path.join(outDir, 'comparison.json');
const falsifier = path.join(outDir, 'falsifier.json');

const sourceArgs = [
  'run', '--rm', '--pull', 'never', '--network', 'none',
  '--mount', `type=bind,source=${reference},target=/ref,readonly`,
  '--mount', `type=bind,source=${root},target=/work,readonly`,
  '--mount', `type=bind,source=${outDir},target=/out`,
  '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
  sourceImageRef, 'node', '/work/scripts/parity-s11-data-maps-diff/run-source.cjs',
  '/ref', '/matrix.json', '/out/source.json',
];
const sourceRun = runChecked('pinned source runtime', 'docker', sourceArgs);
writeLog('source.log', sourceRun);

const revision = runChecked('candidate revision', 'git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
const candidateRun = runChecked('Phoenix candidate runtime', process.execPath, [
  path.join(here, 'run-candidate.mjs'), matrixPath, candidateReceipt,
], { cwd: root, env: { ...process.env, PHOENIX_CANDIDATE_REVISION: revision } });
writeLog('candidate.log', candidateRun);

const compareRun = runChecked('runtime differential', process.execPath, [
  path.join(here, 'compare.mjs'), matrixPath, sourceReceipt, candidateReceipt, comparison,
], { cwd: root, env: { ...process.env, PHOENIX_S11_EXPECTED_REVISION: revision } });
writeLog('compare.log', compareRun);

const falsifyRun = runChecked('fail-closed falsifiers', process.execPath, [
  path.join(here, 'falsify.mjs'), matrixPath, sourceReceipt, candidateReceipt, falsifier,
], { cwd: root });
writeLog('falsifier.log', falsifyRun);

const differential = JSON.parse(fs.readFileSync(comparison, 'utf8'));
const falsifierReceipt = JSON.parse(fs.readFileSync(falsifier, 'utf8'));
process.stdout.write(`${JSON.stringify({
  result: differential.result === 'pass' && falsifierReceipt.result === 'pass' ? 'pass' : 'fail',
  reference,
  sourceImage: sourceImageRef,
  candidateRevision: revision,
  cases: differential.cases,
  differences: differential.differences.length,
  receiptErrors: differential.receiptErrors.length,
  falsifiers: falsifierReceipt.mutations.map(item => ({ name: item.name, rejected: item.rejected })),
  out: outDir,
})}\n`);
