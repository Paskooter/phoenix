import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, copyFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
test('staging cannot activate; missing telemetry cannot restart; guarded health failure rolls back', { timeout: 15000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'native-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); const bin = join(root, 'bin'); const runtime = join(root, 'run');
  for (const dir of [repo, bin, runtime, join(repo, 'scripts'), join(repo, 'packages/common/src')]) mkdirSync(dir, { recursive: true });
  for (const name of ['deploy-native-release.sh', 'activate-native-release.sh', 'deployment-quiescence.mjs']) copyFileSync(join(source, name), join(repo, 'scripts', name));
  copyFileSync(resolve(source, '../packages/common/src/deploymentActivity.js'), join(repo, 'packages/common/src/deploymentActivity.js'));
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  writeFileSync(join(repo, 'scripts/run-compose-stack.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'scripts/run-compose-stack.sh'), 0o755);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const previous = join(root, 'previous'); mkdirSync(previous);
  const current = join(root, 'current'); symlinkSync(previous, current);
  const calls = join(root, 'systemctl-calls'); writeFileSync(calls, '');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nmkdir -p "$2/node_modules"\n');
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "$*" >> "$FIXTURE_CALLS"\nexit 0\n');
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
  for (const name of ['npm', 'systemctl', 'curl']) chmodSync(join(bin, name), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PHOENIX_RELEASE_REPOSITORY: repo,
    PHOENIX_RELEASE_ROOT: join(root, 'releases'), PHOENIX_CURRENT_LINK: current, PHOENIX_SERVICE: 'fixture',
    PHOENIX_NPM_BIN: join(bin, 'npm'), PHOENIX_DEPLOY_RUNTIME_DIR: runtime, FIXTURE_CALLS: calls,
    PHOENIX_DEPLOY_NO_RESTART: '1', PHOENIX_HEALTHCHECK_ATTEMPTS: '1', PHOENIX_HEALTHCHECK_URLS: 'http://fixture.invalid/healthcheck' };
  const deploy = () => spawnSync('bash', [join(source, 'deploy-native-release.sh'), sha], { env, encoding: 'utf8' });
  const staged = deploy();
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(readlinkSync(current), previous);
  assert.equal(readFileSync(calls, 'utf8'), '');
  env.PHOENIX_DEPLOY_NO_RESTART = '0';
  const missing = deploy();
  assert.notEqual(missing.status, 0);
  assert.equal(readlinkSync(current), previous);
  assert.equal(readFileSync(calls, 'utf8'), '');
  const release = join(root, 'releases', sha);
  const activate = () => spawnSync('bash', [join(release, 'scripts/activate-native-release.sh'), release, current, 'fixture', previous], { env, encoding: 'utf8' });
  assert.notEqual(activate().status, 0, 'direct activation without a guard lease is refused');
  const directory = join(runtime, 'deployment'); mkdirSync(directory, { recursive: true });
  const now = Date.now();
  writeFileSync(join(runtime, 'services.json'), JSON.stringify({ services: Object.fromEntries(['hub', 'ota'].map(name => [name, { pid: process.pid, state: 'running' }])) }));
  for (const name of ['hub', 'ota']) writeFileSync(join(directory, name + '.json'), JSON.stringify({ version: 1, service: name, pid: process.pid,
    heartbeatAt: now, lastActivityAt: now - 60000, active: {}, drainId: 'fixture-lease' }));
  writeFileSync(join(directory, 'drain.json'), JSON.stringify({ version: 1, id: 'fixture-lease', ownerPid: process.pid, expiresAt: now + 15000 }));
  env.PHOENIX_DEPLOY_LEASE = 'fixture-lease';
  const failedHealth = activate();
  assert.equal(failedHealth.status, 1, failedHealth.stderr);
  assert.equal(readlinkSync(current), previous, 'failed health sweep restores the previous release');
  assert.equal(readFileSync(calls, 'utf8').split('\n').filter(line => line === 'restart fixture').length, 2);
});
