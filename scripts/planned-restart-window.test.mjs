// The planned-restart window behind the public /health check
// (scripts/planned-restart-window.sh + deploy/nginx/phoenix-health*.conf).
//
// nginx answers /health from the window file named after the CURRENT 10-second
// slot of the clock while the account service is down. These tests pin the
// three things that keep that honest: the files cover only about a minute from
// the restart, nginx's slot map names the same files the script writes, and the
// release activation opens the window only around its restart and closes it once
// the service is healthy again.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, chmodSync,
  symlinkSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const script = join(source, 'planned-restart-window.sh');

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'restart-window-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function windowCommand(action, env) {
  return spawnSync('bash', [script, action], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

function slots(dir) {
  return readdirSync(dir).filter(name => /^window-\d+\.json$/.test(name))
    .map(name => Number(name.slice('window-'.length, -'.json'.length))).sort((a, b) => a - b);
}

/** nginx's own slot rule, read from the shipped http-context file. */
function nginxSlot(msec) {
  const conf = readFileSync(resolve(source, '../deploy/nginx/phoenix-health-http.conf'), 'utf8');
  const rule = /"~(\^\(\?<phoenix_slot>[^"]+)"\s+\$phoenix_slot;/.exec(conf);
  assert.ok(rule, 'phoenix-health-http.conf keeps its $phoenix_restart_slot regex');
  const match = new RegExp(rule[1]).exec(msec);
  return match ? match.groups.phoenix_slot : 'none';
}

test('open covers about one minute from now in 10-second slot files; close removes them', t => {
  const dir = join(sandbox(t), 'window');
  const before = Math.floor(Date.now() / 1000);
  const opened = windowCommand('open', { PHOENIX_RESTART_WINDOW_DIR: dir });
  const after = Math.floor(Date.now() / 1000);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout, '', 'a successful open prints nothing into the activation log');
  const written = slots(dir);
  assert.ok(written.length === 6 || written.length === 7, `six or seven slots, got ${written}`);
  assert.ok(Math.floor(before / 10) <= written[0] && written[0] <= Math.floor(after / 10), 'the window starts now');
  for (let i = 1; i < written.length; i += 1) assert.equal(written[i], written[i - 1] + 1, 'slots are contiguous');
  const end = (written.at(-1) + 1) * 10;
  assert.ok(end - before >= 59 && end - after <= 70, `window ends 60-70 s after opening (ends +${end - before}s)`);
  assert.equal(statSync(dir).mode & 0o777, 0o755);
  for (const slot of written) {
    const file = join(dir, `window-${slot}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o644, 'nginx workers can read the window');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'ok', restarting: true });
  }
  // nginx names the current slot's file, and stops matching after the window.
  const now = Date.now() / 1000;
  const msec = (s) => `${Math.floor(s)}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`;
  assert.ok(existsSync(join(dir, `window-${nginxSlot(msec(now))}.json`)), 'nginx finds the window right now');
  assert.ok(!existsSync(join(dir, `window-${nginxSlot(msec(end + 0.5))}.json`)), 'and not once it has ended');
  assert.equal(nginxSlot('not-a-time'), 'none');

  const closed = windowCommand('close', { PHOENIX_RESTART_WINDOW_DIR: dir });
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(slots(dir), []);
});

test('the window refuses to stretch past two minutes and never fails a deploy', t => {
  const root = sandbox(t);
  const tooLong = windowCommand('open', { PHOENIX_RESTART_WINDOW_DIR: join(root, 'a'), PHOENIX_RESTART_WINDOW_SECONDS: '600' });
  assert.equal(tooLong.status, 0);
  assert.match(tooLong.stderr, /10-120 seconds/);
  assert.equal(existsSync(join(root, 'a')), false);
  const relative = windowCommand('open', { PHOENIX_RESTART_WINDOW_DIR: 'relative/dir' });
  assert.equal(relative.status, 0);
  assert.match(relative.stderr, /absolute/);
  const blocked = join(root, 'file'); writeFileSync(blocked, '');
  const unwritable = windowCommand('open', { PHOENIX_RESTART_WINDOW_DIR: join(blocked, 'window') });
  assert.equal(unwritable.status, 0, 'a window that cannot be written only warns');
  assert.match(unwritable.stderr, /skipped/);
});

test('release activation opens the window only around its restart and closes it once healthy', { timeout: 15000 }, t => {
  const root = sandbox(t);
  const release = join(root, 'release'); const bin = join(root, 'bin'); const runtime = join(root, 'run');
  const window = join(root, 'window');
  for (const dir of [bin, runtime, join(release, 'scripts'), join(release, 'packages/common/src')]) mkdirSync(dir, { recursive: true });
  for (const name of ['activate-native-release.sh', 'deployment-quiescence.mjs', 'planned-restart-window.sh']) {
    copyFileSync(join(source, name), join(release, 'scripts', name));
  }
  copyFileSync(resolve(source, '../packages/common/src/deploymentActivity.js'), join(release, 'packages/common/src/deploymentActivity.js'));
  writeFileSync(join(release, 'package.json'), '{"type":"module"}');
  const git = (...args) => execFileSync('git', ['-C', release, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const previous = join(root, 'previous'); mkdirSync(previous);
  const current = join(root, 'current');
  const calls = join(root, 'calls');
  // systemctl records whether the window was open at the moment of each restart.
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nif [ "$1" = restart ]; then echo "restart window=$(ls "$FIXTURE_WINDOW" 2>/dev/null | grep -c "^window-")" >> "$FIXTURE_CALLS"; fi\nexit 0\n');
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit "$FIXTURE_CURL_EXIT"\n');
  for (const name of ['systemctl', 'curl']) chmodSync(join(bin, name), 0o755);
  const lease = 'fixture-lease';
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PHOENIX_DEPLOY_RUNTIME_DIR: runtime, PHOENIX_DEPLOY_LEASE: lease,
    PHOENIX_RESTART_WINDOW_DIR: window, PHOENIX_HEALTHCHECK_ATTEMPTS: '1', PHOENIX_HEALTHCHECK_URLS: 'http://fixture.invalid/healthcheck',
    FIXTURE_CALLS: calls, FIXTURE_WINDOW: window };
  const activate = (curlExit) => {
    rmSync(current, { force: true }); symlinkSync(previous, current);
    writeFileSync(calls, '');
    const directory = join(runtime, 'deployment'); mkdirSync(directory, { recursive: true });
    const now = Date.now();
    writeFileSync(join(runtime, 'services.json'), JSON.stringify({ services: Object.fromEntries(['hub', 'ota'].map(name => [name, { pid: process.pid, state: 'running' }])) }));
    for (const name of ['hub', 'ota']) writeFileSync(join(directory, `${name}.json`), JSON.stringify({ version: 1, service: name, pid: process.pid,
      heartbeatAt: now, lastActivityAt: now - 60000, active: {}, drainId: lease }));
    writeFileSync(join(directory, 'drain.json'), JSON.stringify({ version: 1, id: lease, ownerPid: process.pid, expiresAt: now + 15000 }));
    return spawnSync('bash', [join(release, 'scripts/activate-native-release.sh'), release, current, 'fixture', previous],
      { env: { ...env, FIXTURE_CURL_EXIT: String(curlExit) }, encoding: 'utf8' });
  };

  const healthy = activate(0);
  assert.equal(healthy.status, 0, healthy.stderr);
  const restarts = readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(restarts.length, 1);
  assert.match(restarts[0], /^restart window=[67]$/, 'the window is open when the service restarts');
  assert.deepEqual(slots(window), [], 'and closed as soon as the new release is healthy');
  assert.doesNotMatch(healthy.stdout + healthy.stderr, /planned restart window/, 'the activation log gains no lines on success');

  const failed = activate(1);
  assert.equal(failed.status, 1, failed.stderr);
  const rollbackRestarts = readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(rollbackRestarts.length, 2, 'failed health rolls back with a second restart');
  for (const line of rollbackRestarts) assert.match(line, /^restart window=[67]$/);
  // The rollback's window is left to expire by itself: nothing must run later.
  assert.ok(slots(window).length >= 6);
});
