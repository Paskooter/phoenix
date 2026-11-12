import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

test('the checker removes its directory when it is interrupted', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tmp-leak-check-outer-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawn(process.execPath, [checker, fixture('waits.probe.mjs')], {
    env: { ...env, TMPDIR: outer },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const started = () => readdirSync(outer).some((name) => existsSync(join(outer, name, 'tmp', 'started')));
  for (let waited = 0; !started(); waited += 50) {
    assert.ok(waited < 15_000, 'the probe test never started');
    await sleep(50);
  }
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.deepEqual(readdirSync(outer), []);
});
