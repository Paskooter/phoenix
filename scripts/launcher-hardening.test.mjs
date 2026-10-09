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
  for (const path of ['scripts/run-compose-stack.sh']) {
    const source = read(path);
    assert.match(source, /load_phoenix_env/, path);
    assert.doesNotMatch(source, /(^|[;&|]|\bthen)\s*\.\s+["']?\$?\{?(ENV_FILE|\.\/\.env|\.env)/m, path);
    assert.doesNotMatch(source, /\bsource\s+["']?\$?\{?(ENV_FILE|\.\/\.env|\.env)/, path);
  }
});
