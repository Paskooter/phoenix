#!/usr/bin/env node

// Reproducible S-09 differential harness.  It runs the archived compiled
// source in Node 8.9.4, runs Phoenix in the host Node runtime, then compares
// every named case and expanded run.  Missing, extra, malformed, or
// non-pass rows are failures; the comparator never silently drops coverage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const matrixPath = path.join(here, 'matrix.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function quote(value) { return typeof value === 'string' ? value.slice(0, 240) : value; }
function firstDifference(a, b, at = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return { path: at, source: quote(a), candidate: quote(b) };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { path: at, source: quote(a), candidate: quote(b) };
    for (let i = 0; i < a.length; i += 1) { const d = firstDifference(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return { path: at, source: quote(a), candidate: quote(b) };
  }
  if (typeof a === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) { const d = firstDifference(a[key], b[key], `${at}.${key}`); if (d) return d; }
  }
  return { path: at, source: quote(a), candidate: quote(b) };
}
function parseArgs(argv) {
  const args = { out: path.join(worktree, '.parity/runs/s09-weather'), reference: process.env.PHOENIX_S09_REFERENCE || path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--reference') args.reference = path.resolve(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node compare.mjs [--reference PATH] [--out DIR]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}
function run(argv, cwd, logPath, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  fs.writeFileSync(logPath, `${result.stdout || ''}${result.stderr || ''}`);
  return { argv, status: result.status, signal: result.signal, log: path.basename(logPath) };
}
function assertReceipt(receipt, side, expectedRuns) {
  if (!receipt || receipt.result !== 'pass') throw new Error(`${side} receipt is not pass`);
  if (!receipt.cases || receipt.cases.length !== matrix.counts.namedCases) throw new Error(`${side} named case count mismatch`);
  let runs = 0;
  const ids = new Set();
  for (const item of receipt.cases) {
    if (ids.has(item.id)) throw new Error(`${side} duplicate case ${item.id}`);
    ids.add(item.id);
    if (!Array.isArray(item.runs)) throw new Error(`${side} missing runs for ${item.id}`);
    for (const row of item.runs) {
      const actual = sha(canonical(row.value));
      if (actual !== row.sha256) throw new Error(`${side} tampered row hash ${item.id}/${row.index}`);
      runs += 1;
    }
  }
  if (runs !== expectedRuns) throw new Error(`${side} expanded run count mismatch: ${runs}`);
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.out, { recursive: true });
const sourceOut = path.join(args.out, 'source.json');
const candidateOut = path.join(args.out, 'candidate.json');
const sourceLog = path.join(args.out, 'source.log');
const candidateLog = path.join(args.out, 'candidate.log');
const commands = [];
let fatal = null;

try {
  const imageID = spawnSync('docker', ['image', 'inspect', `${matrix.runtime.sourceImage}@${matrix.runtime.sourceImageDigest}`, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (imageID.status !== 0 || imageID.stdout.trim() !== matrix.runtime.sourceImageDigest) throw new Error(`pinned source image unavailable or changed: ${imageID.stdout.trim()}`);
  const sourceImage = `${matrix.runtime.sourceImage}@${matrix.runtime.sourceImageDigest}`;
  const sourceArgv = [
    'docker', 'run', '--rm', '--network', 'none',
    '--mount', `type=bind,source=${args.reference},target=/ref,readonly`,
    '--mount', `type=bind,source=${here},target=/harness,readonly`,
    '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
    '--mount', `type=bind,source=${args.out},target=/out`,
    sourceImage, 'node', '/harness/run-source.cjs', '/ref', '/matrix.json', '/out/source.json',
  ];
  const sourceRun = run(sourceArgv, worktree, sourceLog);
  commands.push({ side: 'source', ...sourceRun });
  if (sourceRun.status !== 0) throw new Error(`source runner failed (see ${sourceLog})`);

  const candidateRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim();
  const candidateArgv = ['node', path.join(here, 'run-candidate.mjs'), matrixPath, candidateOut];
  const candidateRun = run(candidateArgv, worktree, candidateLog, { PHOENIX_S09_REVISION: candidateRevision });
  commands.push({ side: 'candidate', ...candidateRun });
  if (candidateRun.status !== 0) throw new Error(`candidate runner failed (see ${candidateLog})`);
} catch (error) {
  fatal = String(error && error.stack || error);
}

let source;
let candidate;
const differences = [];
if (!fatal) {
  try {
    source = JSON.parse(fs.readFileSync(sourceOut, 'utf8'));
    candidate = JSON.parse(fs.readFileSync(candidateOut, 'utf8'));
    assertReceipt(source, 'source', matrix.counts.expandedRuns);
    assertReceipt(candidate, 'candidate', matrix.counts.expandedRuns);
    const sourceById = new Map(source.cases.map(item => [item.id, item]));
    const candidateById = new Map(candidate.cases.map(item => [item.id, item]));
    for (const expected of matrix.cases) {
      const a = sourceById.get(expected.id);
      const b = candidateById.get(expected.id);
      if (!a || !b) { differences.push({ id: expected.id, kind: !a ? 'missing-source' : 'missing-candidate' }); continue; }
      if (a.group !== b.group || a.sourceName !== b.sourceName || a.sourceLine !== b.sourceLine) differences.push({ id: expected.id, kind: 'metadata', source: { group: a.group, sourceName: a.sourceName, sourceLine: a.sourceLine }, candidate: { group: b.group, sourceName: b.sourceName, sourceLine: b.sourceLine } });
      if (a.runs.length !== b.runs.length) { differences.push({ id: expected.id, kind: 'run-count', source: a.runs.length, candidate: b.runs.length }); continue; }
      for (let i = 0; i < a.runs.length; i += 1) {
        const ar = a.runs[i]; const br = b.runs[i];
        if (ar.index !== br.index) { differences.push({ id: expected.id, run: i, kind: 'run-index', source: ar.index, candidate: br.index }); continue; }
        if (ar.sha256 !== br.sha256) differences.push({ id: expected.id, run: i, kind: 'value', sourceSha256: ar.sha256, candidateSha256: br.sha256, firstDifference: firstDifference(stable(ar.value), stable(br.value)) });
      }
    }
    for (const id of candidateById.keys()) if (!sourceById.has(id)) differences.push({ id, kind: 'unexpected-candidate' });
  } catch (error) { fatal = String(error && error.stack || error); }
}

const groupCounts = Object.fromEntries(Object.keys(matrix.counts.groups).map(group => [group, matrix.cases.filter(item => item.group === group).length]));
const report = {
  schema: 'phoenix.parity.s09.weather-differential.v1',
  result: fatal ? 'fail' : (differences.length ? 'diff' : 'pass'),
  task: matrix.task,
  base: '311dd623e3d5b8ff73785a10edfd25514d513b57',
  branch: 'w-s09-source-diff',
  reference: { ...matrix.reference, sourceImage: matrix.runtime.sourceImage, sourceImageDigest: matrix.runtime.sourceImageDigest, path: args.reference },
  candidate: { worktree, revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim() },
  coverage: { namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, groups: groupCounts, source: source && source.counts, candidate: candidate && candidate.counts },
  commands,
  receipts: source && candidate ? { sourceSha256: fileSha(sourceOut), candidateSha256: fileSha(candidateOut) } : null,
  differences,
  fatal,
};
fs.writeFileSync(path.join(args.out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.result, namedCases: report.coverage.namedCases, expandedRuns: report.coverage.expandedRuns, differences: differences.length, out: args.out }));
if (report.result !== 'pass') process.exitCode = 1;
