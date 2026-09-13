#!/usr/bin/env node

// Run the pinned Node 8 Pegasus graph in a network-isolated container, run
// the current Phoenix graph under Node 22, then apply the fail-closed and
// negative-control checks.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const matrixPath = path.join(here, 'commute-graph-matrix.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const require = createRequire(import.meta.url);
const contract = require('./contract.cjs');
const matrixErrors = contract.validateMatrix(matrix, contract.EXPECTED_MATRIX_SEMANTIC_SHA256);
if (matrixErrors.length) throw new Error(`matrix contract mismatch: ${JSON.stringify(matrixErrors)}`);
const sourceImage = `${matrix.sourceImage}@${matrix.sourceImageDigest}`;

function parseArgs(argv) {
  const args = {
    reference: process.env.PHOENIX_S11_REFERENCE
      || path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'),
    out: path.join(worktree, '.parity/runs/s11-http-graph'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reference') args.reference = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node scripts/parity-s11-http-graph/run.mjs [--reference PATH] [--out DIR]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: worktree,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (options.capture) fs.writeFileSync(options.log, `${result.stdout || ''}${result.stderr || ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status || result.signal}`);
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.reference)) throw new Error(`reference checkout not found: ${args.reference}`);
if (!fs.existsSync(args.out)) fs.mkdirSync(args.out, { recursive: true });

const sourceOut = path.join(args.out, 'source.json');
const candidateOut = path.join(args.out, 'candidate.json');
const comparisonOut = path.join(args.out, 'comparison.json');
const sourceLog = path.join(args.out, 'source.log');
const candidateLog = path.join(args.out, 'candidate.log');
const negativeLog = path.join(args.out, 'negative-control.log');

run('docker', [
  'run', '--rm', '--pull', 'never', '--network', 'none',
  '--mount', `type=bind,source=${args.reference},target=/ref,readonly`,
  '--mount', `type=bind,source=${worktree},target=/work,readonly`,
  '--mount', `type=bind,source=${args.out},target=/out`,
  '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
  sourceImage, 'node', '/work/scripts/parity-s11-http-graph/run-source.cjs',
  '/ref', '/matrix.json', '/out/source.json',
], { capture: true, log: sourceLog });

const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' });
if (revisionResult.error || revisionResult.status !== 0) throw new Error('unable to determine Phoenix revision');
run('node', [path.join(here, 'run-candidate.mjs'), matrixPath, candidateOut], {
  capture: true,
  log: candidateLog,
  env: { PHOENIX_CANDIDATE_REVISION: revisionResult.stdout.trim() },
});
run('node', [path.join(here, 'compare.mjs'), matrixPath, sourceOut, candidateOut, comparisonOut]);
run('node', [path.join(here, 'negative-control.mjs'), matrixPath, sourceOut, candidateOut], {
  capture: true,
  log: negativeLog,
});

const comparison = JSON.parse(fs.readFileSync(comparisonOut, 'utf8'));
console.log(JSON.stringify({ result: comparison.result, cases: comparison.cases, counts: comparison.counts, out: args.out }));
