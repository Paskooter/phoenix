import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = path => readFileSync(resolve(root, path), 'utf8');
const point = read('scripts/point-robot-at-phoenix.sh');
const repoint = read('scripts/parity-robot/repoint-robot.sh');
const robotSide = read('scripts/robot-repoint-server-client.sh');
const compose = read('scripts/run-compose-stack.sh');
const sim = read('scripts/run-sim-stack.sh');
const diagnosticStack = read('scripts/parity-robot/stack.mjs');

function run(script, args, env = {}) {
  return spawnSync('bash', [resolve(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('SSH repoint launchers do not carry password or host-key bypass paths', () => {
  const forbidden = [
    new RegExp(['ssh', 'pass'].join('')),
    new RegExp(['SSH', '_PASS'].join('')),
    new RegExp(['root', 'jibo'].join(':')),
    new RegExp(`StrictHostKeyChecking=${'no'}`),
    new RegExp(`UserKnownHostsFile=${'/dev/null'}`),
  ];
  for (const source of [point, repoint]) {
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
    assert.match(source, /StrictHostKeyChecking=yes/);
    assert.match(source, /UserKnownHostsFile/);
    assert.match(source, /validate_host/);
    assert.match(source, /validate_port/);
  }
  assert.doesNotMatch(point, /remote_cmd/);
  assert.match(point, /sh -s --/);
});

test('stack launchers load dotenv data without evaluating it and fail closed for auth', () => {
  assert.doesNotMatch(compose, /(?:^|[;|&])[[:space:]]*\.[[:space:]]+\.?\/?\.env/);
  assert.doesNotMatch(compose, /source[[:space:]]+[^\n]*\.env/);
  assert.match(compose, /load_phoenix_env/);
  assert.doesNotMatch(compose, new RegExp(['dev-hub', '-token-secret'].join('')));
  assert.doesNotMatch(sim, /known fallback secret/);
  assert.doesNotMatch(sim, new RegExp(['dev-hub', '-token-secret'].join('')));
  assert.doesNotMatch(sim, new RegExp(`HUB_AUTH_SECRET:-known`));
  for (const source of [compose, sim]) {
    assert.match(source, /PHOENIX_DEV_MODE/);
    assert.match(source, /HUB_TOKEN_SECRET/);
  }
});

test('canonical hub port is shared by authenticated and repoint launchers', () => {
  const ports = JSON.parse(readFileSync(resolve(root, 'scripts/parity-robot/ports.json'), 'utf8'));
  assert.equal(ports.hubPort, 9000);
  assert.match(read('scripts/parity-robot/authenticated-stack.mjs'), /DEFAULT_HUB_PORT/);
  assert.match(diagnosticStack, /ports\.json/);
  assert.match(diagnosticStack, /PHOENIX_DEV_MODE/);
  assert.doesNotMatch(diagnosticStack, /PHOENIX_ROBOT_AUTH !== 'true'/);
  assert.match(repoint, /phoenix_canonical_port/);
  assert.match(point, /phoenix_canonical_port/);
  assert.match(compose, /phoenix_canonical_port/);
});

test('compose auth guard rejects missing secrets and non-development auth bypasses', () => {
  const guard = resolve(root, 'scripts/require-auth.mjs');
  const command = [process.execPath, '-e', 'process.exit(0)'];
  const missing = spawnSync(process.execPath, [guard, ...command], {
    cwd: root, env: { ...process.env, ETCO_hub_disableAuth: 'false', PHOENIX_DEV_MODE: '0' }, encoding: 'utf8',
  });
  assert.equal(missing.status, 78);
  const bypass = spawnSync(process.execPath, [guard, ...command], {
    cwd: root, env: { ...process.env, ETCO_server_hubTokenSecret: 'offline-test-secret', ETCO_hub_disableAuth: 'true', PHOENIX_DEV_MODE: '0' }, encoding: 'utf8',
  });
  assert.equal(bypass.status, 78);
  const development = spawnSync(process.execPath, [guard, ...command], {
    cwd: root, env: { ...process.env, ETCO_server_hubTokenSecret: 'offline-test-secret', ETCO_hub_disableAuth: 'true', PHOENIX_DEV_MODE: '1' }, encoding: 'utf8',
  });
  assert.equal(development.status, 0, development.stderr);
});

test('dotenv loader treats shell syntax as data and preserves existing values', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-dotenv-safe-'));
  const envFile = resolve(dir, '.env');
  const marker = resolve(dir, 'executed');
  writeFileSync(envFile, [
    '# comment',
    'SAFE_FROM_FILE=literal',
    `SHOULD_NOT_EXECUTE=$(touch ${marker})`,
    'QUOTED="hello world"',
    'export EMPTY_OVERRIDE=from-file',
    '',
  ].join('\n'));
  try {
    const helper = resolve(root, 'scripts/load-dotenv.sh');
    const result = spawnSync('bash', ['-c', [
      'set -e',
      'source "$1"',
      'load_phoenix_env "$2"',
      'printf "%s\\n" "$SAFE_FROM_FILE" "$SHOULD_NOT_EXECUTE" "$QUOTED" "$EMPTY_OVERRIDE"',
    ].join('\n'), '--', helper, envFile], {
      cwd: root,
      env: { ...process.env, SAFE_FROM_FILE: 'from-environment', EMPTY_OVERRIDE: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      'from-environment',
      `$(touch ${marker})`,
      'hello world',
      'from-file',
    ]);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('point launcher rejects an invalid host and port before invoking SSH', () => {
  const badHost = run('scripts/point-robot-at-phoenix.sh', ['not a host', '127.0.0.1']);
  assert.equal(badHost.status, 2);
  assert.match(badHost.stderr, /host/i);
  const badPort = run('scripts/point-robot-at-phoenix.sh', ['127.0.0.1', '127.0.0.1', '0']);
  assert.equal(badPort.status, 2);
  assert.match(badPort.stderr, /port/i);
});

test('robot-side launcher rejects malformed endpoint and hub port before reading robot state', () => {
  const badUrl = run('scripts/robot-repoint-server-client.sh', ['http://bad host:9012']);
  assert.equal(badUrl.status, 2);
  assert.match(badUrl.stderr, /host|endpoint/i);
  const badPort = run('scripts/robot-repoint-server-client.sh', ['http://127.0.0.1:9012', '--hub', '127.0.0.1:0']);
  assert.equal(badPort.status, 2);
  assert.match(badPort.stderr, /port/i);
});

test('repoint launcher rejects malformed hub port before making an SSH connection', () => {
  const result = run('scripts/parity-robot/repoint-robot.sh', ['--robot', 'root@127.0.0.1', '--phoenix', '127.0.0.1', '--hub-port', '65536', '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /port/i);
  assert.doesNotMatch(result.stderr, /preflight|connecting/i);
});

assert.doesNotMatch(robotSide, new RegExp(['ssh', 'pass'].join('')));
