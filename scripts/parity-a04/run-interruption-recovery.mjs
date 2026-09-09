#!/usr/bin/env node
// Repeat the A-04 gate-3 interruption tests and record the pass/fail
// distribution. Interruption cases are process-kill and reconnect races;
// a single lucky pass is not the evidence.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'packages/account/test/loopFlushInterruption.test.js',
  'packages/classic/test/accountClassicReconnectInterruption.test.js',
];
const repeats = Number(process.env.INTERRUPTION_REPEATS || 3);
const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : null;

function parseTap(text) {
  const names = [];
  for (const line of text.split('\n')) {
    const ok = /^(not )?ok \d+ - (.+)$/.exec(line);
    if (ok) names.push({ name: ok[2], passed: !ok[1] });
  }
  const tests = Number((/# tests (\d+)/.exec(text) || [])[1] || names.length);
  const pass = Number((/# pass (\d+)/.exec(text) || [])[1] || names.filter((row) => row.passed).length);
  const fail = Number((/# fail (\d+)/.exec(text) || [])[1] || names.filter((row) => !row.passed).length);
  return { tests, pass, fail, names };
}

function runOnce(index) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...FILES], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => {
      const tap = parseTap(stdout);
      resolve({
        index,
        code,
        signal,
        passed: code === 0 && tap.fail === 0,
        ...tap,
        stderr: stderr.trim(),
      });
    });
  });
}

const runs = [];
for (let index = 1; index <= repeats; index += 1) {
  const run = await runOnce(index);
  runs.push(run);
  process.stdout.write(`run ${index}/${repeats}: ${run.passed ? 'pass' : 'FAIL'} ${run.pass}/${run.tests}\n`);
  if (!run.passed) {
    for (const row of run.names.filter((item) => !item.passed)) {
      process.stdout.write(`  fail: ${row.name}\n`);
    }
  }
}

const byName = {};
for (const run of runs) {
  for (const row of run.names) {
    const current = byName[row.name] || { name: row.name, pass: 0, fail: 0 };
    if (row.passed) current.pass += 1;
    else current.fail += 1;
    byName[row.name] = current;
  }
}

const summary = {
  command: `node --test ${FILES.join(' ')}`,
  repeats,
  runs: runs.map((run) => ({
    index: run.index,
    code: run.code,
    signal: run.signal,
    passed: run.passed,
    tests: run.tests,
    pass: run.pass,
    fail: run.fail,
    failedNames: run.names.filter((row) => !row.passed).map((row) => row.name),
  })),
  distribution: Object.values(byName),
  allPassed: runs.every((run) => run.passed),
};

if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
}

if (!summary.allPassed) process.exit(1);
