import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  ignoredCommandDependencyErrors,
  verificationScope,
  verificationSummary,
} from './parity-status-lib.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);

// This deliberately uses synthetic revisions; no evidence is promoted by the
// test merely because it has a plausible-looking hash.
test('verification scope separates exact current HEAD from bounded historical evidence', () => {
  const head = 'a'.repeat(40);
  const old = 'b'.repeat(40);
  assert.equal(verificationScope({ phoenixRevision: head }, head), 'current-head');
  assert.equal(verificationScope({ phoenixRevision: `${head} plus working tree` }, head), 'historical-bounded');
  assert.equal(verificationScope({ phoenixRevision: old }, head), 'historical-bounded');
  assert.equal(verificationScope({ phoenixRevision: 'not-a-revision' }, head), 'unbounded');

  const summary = verificationSummary([
    { id: 'T-01', verification: [{ artifact: 'a', phoenixRevision: head }] },
    { id: 'T-02', verification: [{ artifact: 'b', phoenixRevision: old }] },
  ], head);
  assert.equal(summary.counts.currentHead, 1);
  assert.equal(summary.counts.historicalBounded, 1);
  assert.equal(summary.counts.unbounded, 0);
});

test('ignored command dependencies fail closed when a declared dependency is absent', () => {
  const available = dependency => dependency === 'node';
  const missing = ignoredCommandDependencyErrors({
    owner: 'T-01.verification[0]',
    value: [{ command: 'optional probe', dependencies: ['node', 'missing-tool'] }],
    root,
    isAvailable: available,
  });
  assert.deepEqual(missing, ['T-01.verification[0].ignoredCommands[0]: missing ignored-command dependency missing-tool']);

  const valid = ignoredCommandDependencyErrors({
    owner: 'T-01',
    value: { 'optional probe': ['node'] },
    root,
    isAvailable: available,
  });
  assert.deepEqual(valid, []);
});

test('parity-status JSON reports the current revision and evidence scopes', () => {
  const result = spawnSync('node', ['scripts/parity-status.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.verification.currentHead, /^[0-9a-f]{40}$/);
  assert.ok(report.verification.counts.historicalBounded > 0);
  assert.equal(report.verification.counts.currentHead, 0);
  assert.equal(report.verification.historicalBoundedEvidence.length, report.verification.counts.historicalBounded);
});

test('ignored dependency declarations can require a repository file', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'phoenix-status-dependency-'));
  try {
    writeFileSync(resolve(dir, 'present'), 'ok');
    const errors = ignoredCommandDependencyErrors({
      owner: 'T-02',
      value: [{ command: 'offline check', dependencies: ['./present', './missing'] }],
      root: dir,
    });
    assert.deepEqual(errors, ['T-02.ignoredCommands[0]: missing ignored-command dependency ./missing']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
