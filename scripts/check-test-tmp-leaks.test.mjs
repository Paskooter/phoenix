import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'check-test-tmp-leaks.mjs');
const fixture = (name) => join(here, 'tmp-leak-check-fixtures', name);

// Run the checker under a permissive umask (this host uses 002), as a shell would.
// Drop NODE_TEST_CONTEXT so the nested `node --test` really runs the probe file.
function runChecker(file) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync('/bin/sh', ['-c', 'umask 002 && exec "$0" "$1" "$2"', process.execPath, checker, file], {
    encoding: 'utf8',
    env,
  });
}

test('the checker gives tests a 0700 TMPDIR even under umask 002', () => {
  const run = runChecker(fixture('tmpdir-mode.probe.mjs'));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 1$/m);
  assert.match(run.stdout, /No temporary files were left behind/);
});

test('the checker fails and lists what a test left in TMPDIR', () => {
  const run = runChecker(fixture('leaks.probe.mjs'));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /1 temporary entry was left behind:\n {2}left-behind\.txt/);
});
