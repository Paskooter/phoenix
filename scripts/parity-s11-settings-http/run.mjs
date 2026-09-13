#!/usr/bin/env node

// Run the pinned Node 8 source client, Phoenix client, fail-closed comparator,
// and receipt falsifiers as one reproducible acceptance command.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const matrixPath = path.join(here, 'matrix.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const sourceImage = `${matrix.sourceImage}@${matrix.sourceImageDigest}`;
if (matrix.schema !== 's11-settings-http-v1') throw new Error('unsupported S-11 settings matrix schema');
if (matrix.sourceImage !== 'node' || matrix.sourceImageDigest !== 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c') throw new Error('unexpected source image pin');
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const matrixSha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const expectedCaseIds = [
  'convert-mode-0', 'convert-mode-1', 'convert-mode-2', 'convert-mode-3',
  'convert-mode-negative', 'convert-mode-four', 'convert-mode-large', 'convert-mode-fraction',
  'convert-mode-nan', 'convert-mode-string-driving', 'convert-mode-string-invalid', 'convert-mode-null',
  'convert-mode-missing', 'convert-missing-origin-lat', 'convert-missing-origin-lng',
  'convert-missing-destination-lat', 'convert-missing-destination-lng', 'convert-missing-work-hour',
  'convert-missing-work-minute', 'convert-presence-zero-and-out-of-range', 'convert-out-of-range-work-time',
  'convert-malformed-partial', 'convert-malformed-null', 'convert-malformed-undefined', 'convert-malformed-zero',
  'prefs-default-no-speaker', 'prefs-default-not-in-loop', 'prefs-default-child', 'prefs-adult-transid',
  'prefs-adult-null-transid', 'prefs-adult-missing-transid', 'prefs-http-503', 'prefs-http-400-malformed',
  'prefs-http-200-null', 'prefs-http-200-empty', 'prefs-http-200-missing-report', 'prefs-http-200-missing-data',
  'prefs-http-200-wrong-shape', 'prefs-http-200-malformed-array', 'get-settings-valid',
  'get-settings-missing-account', 'get-settings-missing-loop', 'get-settings-no-auth',
];
if (matrix.caseCount !== expectedCaseIds.length
  || JSON.stringify(matrix.cases.map((item) => item && item.id)) !== JSON.stringify(expectedCaseIds)
  || matrix.caseInventorySha256 !== 'caac62ef04775f8cc02496adc7aaf626a7d33fba0e9cb8d53fd034be6b5e261a'
  || matrixSha256(JSON.stringify(matrix.cases.map((item) => item && item.id))) !== matrix.caseInventorySha256
  || matrixSha256(JSON.stringify(stable(matrix))) !== '32739ae87fae1c0928d0acaa6db3ffe2230ac09187df1acacc2655beca39ae80') {
  throw new Error('unexpected S-11 settings case inventory/semantic pin');
}

function parseArgs(argv) {
  const args = {
    reference: process.env.PHOENIX_S11_SETTINGS_REFERENCE
      || path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'),
    out: path.join(worktree, '.parity/runs/s11-settings-http'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reference') args.reference = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node scripts/parity-s11-settings-http/run.mjs [--reference PATH] [--out DIR]');
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

const sourcePath = path.join(args.out, 'source.json');
const candidatePath = path.join(args.out, 'candidate.json');
const comparisonPath = path.join(args.out, 'comparison.json');
const sourceLog = path.join(args.out, 'source.log');
const candidateLog = path.join(args.out, 'candidate.log');
const negativeLog = path.join(args.out, 'negative-control.log');

run('docker', [
  'run', '--rm', '--pull', 'never', '--network', 'none',
  '--mount', `type=bind,source=${args.reference},target=/ref,readonly`,
  '--mount', `type=bind,source=${worktree},target=/work,readonly`,
  '--mount', `type=bind,source=${args.out},target=/out`,
  '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
  sourceImage, 'node', '/work/scripts/parity-s11-settings-http/run-source.cjs',
  '/ref', '/matrix.json', '/out/source.json',
], { capture: true, log: sourceLog });

const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' });
if (revisionResult.error || revisionResult.status !== 0) throw new Error('unable to determine Phoenix revision');
run('node', [path.join(here, 'run-candidate.mjs'), matrixPath, candidatePath], {
  capture: true,
  log: candidateLog,
  env: { PHOENIX_CANDIDATE_REVISION: revisionResult.stdout.trim() },
});
run('node', [path.join(here, 'compare.mjs'), matrixPath, sourcePath, candidatePath, comparisonPath]);
run('node', [path.join(here, 'negative-control.mjs'), matrixPath, sourcePath, candidatePath], {
  capture: true,
  log: negativeLog,
});

const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8'));
console.log(JSON.stringify({
  result: comparison.result,
  cases: matrix.cases.length,
  out: args.out,
  sourceRevision: matrix.referenceRevision,
  candidateRevision: revisionResult.stdout.trim(),
  sourceImage,
}));
