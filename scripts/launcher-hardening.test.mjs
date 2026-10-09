// Offline checks for the shell launchers. Nothing here opens an SSH session,
// contacts a robot or starts a server: robot-facing scripts are exercised only
// up to their argument validation, which runs before any network use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = path => readFileSync(resolve(root, path), 'utf8');

test('the dotenv loader treats shell syntax as data and preserves existing values', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-dotenv-safe-'));
  const envFile = resolve(dir, '.env');
  const marker = resolve(dir, 'executed');
  // Synthetic values only.
  writeFileSync(envFile, [
    '# comment',
    '   # indented comment',
    'SAFE_FROM_FILE=literal',
    `SHOULD_NOT_EXECUTE=$(touch ${marker})`,
    'BACKTICKS=`touch also-not-run`',
    'QUOTED="hello world"',
    "SINGLE='single quoted'",
    'export EMPTY_OVERRIDE=from-file',
    'CRLF=value\r',
    '',
  ].join('\n'));
  try {
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$1"',
      'load_phoenix_env "$2"',
      'printf "%s\\n" "$SAFE_FROM_FILE" "$SHOULD_NOT_EXECUTE" "$BACKTICKS" "$QUOTED" "$SINGLE" "$EMPTY_OVERRIDE" "$CRLF"',
    ].join('\n'), '--', resolve(root, 'scripts/load-dotenv.sh'), envFile], {
      cwd: dir,
      env: { PATH: process.env.PATH, SAFE_FROM_FILE: 'from-environment', EMPTY_OVERRIDE: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      'from-environment',
      `$(touch ${marker})`,
      '`touch also-not-run`',
      'hello world',
      'single quoted',
      'from-file',
      'value',
    ]);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(resolve(dir, 'also-not-run')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dotenv loader rejects a line that is not KEY=VALUE without executing it', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-dotenv-invalid-'));
  const envFile = resolve(dir, '.env');
  const marker = resolve(dir, 'executed');
  writeFileSync(envFile, `GOOD=1\ntouch ${marker}\n`);
  try {
    const result = spawnSync('bash', ['-c', 'source "$1"; load_phoenix_env "$2"', '--',
      resolve(root, 'scripts/load-dotenv.sh'), envFile], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid dotenv entry/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stack launchers load dotenv files as data instead of sourcing them', () => {
  for (const path of ['scripts/run-compose-stack.sh', 'scripts/run-sim-stack.sh']) {
    const source = read(path);
    assert.match(source, /load_phoenix_env/, path);
    assert.doesNotMatch(source, /(^|[;&|]|\bthen)\s*\.\s+["']?\$?\{?(ENV_FILE|\.\/\.env|\.env)/m, path);
    assert.doesNotMatch(source, /\bsource\s+["']?\$?\{?(ENV_FILE|\.\/\.env|\.env)/, path);
  }
});

// A sandbox whose PATH starts with a stub `ssh` (and `sshpass`) that only
// records its arguments and stdin. Nothing can leave the machine even if a
// script under test reaches its SSH step.
function sshSandbox() {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-ssh-stub-'));
  const bin = resolve(dir, 'bin');
  const log = resolve(dir, 'ssh.log');
  const knownHosts = resolve(dir, 'known_hosts');
  writeFileSync(knownHosts, '# synthetic known_hosts for offline tests\n');
  spawnSync('mkdir', ['-p', bin]);
  for (const name of ['ssh', 'sshpass']) {
    writeFileSync(resolve(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name}" "$@" >> "${log}"\nprintf '%s\\n' '--- stdin ---' >> "${log}"\ncat >> "${log}"\nexit 0\n`, { mode: 0o755 });
  }
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, PHOENIX_SSH_KNOWN_HOSTS: knownHosts },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script, args, env) {
  return spawnSync('bash', [resolve(root, script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 20_000, input: '' });
}

test('point-robot-at-phoenix validates hosts and ports before any SSH', () => {
  const sandbox = sshSandbox();
  try {
    for (const [args, pattern] of [
      [['not a host', '192.0.2.10'], /robot host/],
      [['192.0.2.20', 'bad;host'], /Phoenix host/],
      [['192.0.2.20', '192.0.2.10', '0'], /classic port/],
      [['192.0.2.20', '192.0.2.10', '9012', '65536'], /hub port/],
      [['192.0.2.20', '192.0.2.10', "9012'; touch /tmp/x; '"], /classic port/],
      [['192.0.2.20', '--reset', 'extra'], /usage/],
    ]) {
      const result = run('scripts/point-robot-at-phoenix.sh', args, sandbox.env);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
    assert.equal(sandbox.calls(), '', 'no SSH attempted');
  } finally {
    sandbox.cleanup();
  }
});

test('point-robot-at-phoenix uses only OpenSSH with strict host keys and quoted arguments', () => {
  const sandbox = sshSandbox();
  try {
    const apply = run('scripts/point-robot-at-phoenix.sh', ['192.0.2.20', '192.0.2.10', '9012', '9000'], sandbox.env);
    assert.equal(apply.status, 0, apply.stderr);
    const reset = run('scripts/point-robot-at-phoenix.sh', ['192.0.2.20', '--reset'], sandbox.env);
    assert.equal(reset.status, 0, reset.stderr);
    const calls = sandbox.calls();
    assert.doesNotMatch(calls, /^sshpass$/m, 'never supplies a password');
    assert.doesNotMatch(calls, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
    assert.match(calls, /StrictHostKeyChecking=yes/);
    assert.match(calls, /^root@192\.0\.2\.20$/m);
    assert.match(calls, /^sh -s -- apply http:\/\/192\.0\.2\.10:9012 192\.0\.2\.10 9000 $/m);
    // Empty endpoint values stay positional in reset mode.
    assert.match(calls, /^sh -s -- reset '' '' 9000 $/m);
  } finally {
    sandbox.cleanup();
  }
});

test('point-robot-at-phoenix refuses to run without a readable known-hosts file', () => {
  const sandbox = sshSandbox();
  try {
    const result = run('scripts/point-robot-at-phoenix.sh', ['192.0.2.20', '192.0.2.10'],
      { ...sandbox.env, PHOENIX_SSH_KNOWN_HOSTS: resolve(sandbox.env.HOME, 'missing_known_hosts') });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /known-hosts/);
    assert.equal(sandbox.calls(), '');
  } finally {
    sandbox.cleanup();
  }
});

test('repoint-robot validates its inputs and pins host keys before connecting', () => {
  const sandbox = sshSandbox();
  try {
    for (const [args, pattern] of [
      [['--robot', 'root@192.0.2.20', '--phoenix', '192.0.2.10', '--hub-port', '65536', '--dry-run'], /hub port/],
      [['--robot', 'root@bad host', '--phoenix', '192.0.2.10', '--dry-run'], /robot SSH target/],
      [['--robot', 'root@192.0.2.20', '--phoenix', "192.0.2.10'", '--dry-run'], /Phoenix host/],
      [['--robot', 'root@192.0.2.20', '--phoenix', '192.0.2.10', '--regions', 'api,$(id)', '--dry-run'], /region/],
      [['--robot', 'root@192.0.2.20', '--phoenix', '192.0.2.10', '--classic-url', 'http://192.0.2.10:9012/x', '--dry-run'], /classic URL/],
    ]) {
      const result = run('scripts/parity-robot/repoint-robot.sh', args, sandbox.env);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
    assert.equal(sandbox.calls(), '', 'no SSH attempted');
    const source = read('scripts/parity-robot/repoint-robot.sh');
    assert.match(source, /StrictHostKeyChecking=yes/);
    assert.match(source, /UserKnownHostsFile=\$SSH_KNOWN_HOSTS/);
  } finally {
    sandbox.cleanup();
  }
});

test('the robot-side repoint rejects malformed endpoints before reading robot state', () => {
  // Only rejected inputs are exercised: a valid run would edit the host it runs on.
  for (const [args, pattern] of [
    [['http://bad host:9012'], /REST endpoint/],
    [['http://192.0.2.10:9012/path'], /REST endpoint/],
    [['http://user@192.0.2.10:9012'], /REST endpoint/],
    [['http://192.0.2.10:9012', '--hub', '192.0.2.10:0'], /hub host or port/],
    [['http://192.0.2.10:9012', '--socket', 'wss://bad;host'], /socket endpoint/],
    [['http://192.0.2.10:9012', '--region', 'api;id'], /region/],
  ]) {
    const result = run('scripts/robot-repoint-server-client.sh', args, { PATH: process.env.PATH });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test('the simulator launcher has no built-in hub secret and stops before starting services without one', () => {
  const source = read('scripts/run-sim-stack.sh');
  assert.doesNotMatch(source, /uHGhXhdXzBybGX7YHuEwAFZC/);
  assert.doesNotMatch(source, /^PHX=\/home\//m, 'the checkout is located from the script, not a fixed path');
  // Exits at the secret check, before any service or the simulator is launched.
  const result = spawnSync('bash', [resolve(root, 'scripts/run-sim-stack.sh')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PHOENIX_ENV_FILE: '/dev/null', PHOENIX_DEV_MODE: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HUB_TOKEN_SECRET must be set/);
  const mismatch = spawnSync('bash', [resolve(root, 'scripts/run-sim-stack.sh')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PHOENIX_ENV_FILE: '/dev/null',
      HUB_TOKEN_SECRET: 'synthetic-a', HUB_AUTH_SECRET: 'synthetic-b' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(mismatch.status, 1, mismatch.stderr);
  assert.match(mismatch.stderr, /disagree/);
});

test('the diagnostic robot stack requires explicit development mode or real authentication', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-diagnostic-stack-'));
  const base = { PATH: process.env.PATH, HOME: dir, PHOENIX_ENV_FILE: '/dev/null', PHOENIX_ROBOT_RUN: resolve(dir, 'run'), PHOENIX_ROBOT_PORT: '47100' };
  try {
    // Both refusals happen before any directory or listener is created.
    const unauthenticated = spawnSync(process.execPath, [resolve(root, 'scripts/parity-robot/stack.mjs')], {
      cwd: root, env: base, encoding: 'utf8', timeout: 15_000,
    });
    assert.notEqual(unauthenticated.status, 0);
    assert.match(unauthenticated.stderr, /PHOENIX_DEV_MODE=1/);
    const noSecret = spawnSync(process.execPath, [resolve(root, 'scripts/parity-robot/stack.mjs')], {
      cwd: root, env: { ...base, PHOENIX_ROBOT_AUTH: 'true' }, encoding: 'utf8', timeout: 15_000,
    });
    assert.notEqual(noSecret.status, 0);
    assert.match(noSecret.stderr, /HUB_TOKEN_SECRET is required/);
    assert.equal(existsSync(resolve(dir, 'run')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
