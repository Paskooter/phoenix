#!/usr/bin/env node

// Run the closure in deterministic bounded source/candidate batches.  Runtime
// captures are written only to the supplied temporary directory.  Use
// --start/--limit for a focused replay; the default runs the complete plan.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const dir = path.resolve(arg('--dir', ''));
const sourceRoot = path.resolve(arg('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'));
const image = arg('--image', 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c');
const start = Number(arg('--start', '0'));
const limit = Number(arg('--limit', '0'));
if (!dir) throw new Error('usage: run-all.mjs --dir /tmp/s07-routing-plan [--source-root PATH] [--start N] [--limit N]');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
if (!Number.isInteger(start) || start < 0 || start >= plan.batches.length) throw new Error(`invalid --start ${start}`);
if (!Number.isInteger(limit) || limit < 0) throw new Error(`invalid --limit ${limit}`);
const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const sourceRunner = path.join(repoRoot, 'scripts/parity-s07-boundaries/run-source.cjs');
const candidateRunner = path.join(repoRoot, 'scripts/parity-s07-boundaries/run-candidate.mjs');
const end = limit ? Math.min(plan.batches.length, start + limit) : plan.batches.length;

function run(command, commandArgs, logPath, env = process.env) {
  const fd = fs.openSync(logPath, 'w');
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}; see ${logPath}`);
}

for (let index = start; index < end; index += 1) {
  const batch = plan.batches[index];
  const specPath = path.join(dir, batch.name);
  const candidateOut = path.join(dir, `${batch.name}.candidate.json`);
  const sourceOutInContainer = `/out/${batch.name}.source.json`;
  run(process.execPath, [candidateRunner, specPath, candidateOut], path.join(dir, `${batch.name}.candidate.log`));
  run('docker', [
    'run', '--rm', '--network', 'none',
    '--mount', `type=bind,source=${sourceRoot},target=/ref,readonly`,
    '--mount', `type=bind,source=${repoRoot},target=/work,readonly`,
    '--mount', `type=bind,source=${specPath},target=/spec.json,readonly`,
    '--mount', `type=bind,source=${dir},target=/out`,
    '-e', 'TZ=UTC',
    '-w', '/ref/packages/chitchat-skill', image, 'node',
    '/work/scripts/parity-s07-boundaries/run-source.cjs', '/ref', '/spec.json', sourceOutInContainer,
  ], path.join(dir, `${batch.name}.source.log`));
  process.stdout.write(`completed ${batch.name} (${batch.count} rows)\n`);
}

if (start === 0 && end === plan.batches.length) {
  run(process.execPath, [path.join(repoRoot, 'scripts/parity-s07-routing-closure/run-normalization.mjs'), path.join(dir, 'normalization.json'), path.join(dir, 'normalization-candidate.json')], path.join(dir, 'normalization.log'));
  run(process.execPath, [path.join(repoRoot, 'scripts/parity-s07-routing-closure/compare-normalization.mjs'), path.join(dir, 'normalization.json'), path.join(dir, 'normalization-candidate.json')], path.join(dir, 'normalization-compare.log'));
  run(process.execPath, [path.join(repoRoot, 'scripts/parity-s07-routing-closure/aggregate.mjs'), dir], path.join(dir, 'aggregate.log'));
}
console.log(JSON.stringify({ dir, start, end, batches: end - start, totalBatches: plan.batches.length }));
