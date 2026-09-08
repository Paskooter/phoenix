import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMPILED_FST_PROFILE } from '../src/compiledFstProfile.js';
import {
  COMPILED_FST_INSTALL_KIND,
  COMPILED_FST_INSTALL_SCHEMA,
  COMPILED_FST_INSTALL_VERSION,
  DEFAULT_COMPILED_HOME_RELATIVE,
  defaultCompiledHome,
  readCompiledInstallReceipt,
  resolveProvisionedApprovedHome,
} from '../src/compiledFstHome.js';

function approvedReceipt(overrides = {}) {
  return {
    schema: COMPILED_FST_INSTALL_SCHEMA,
    version: COMPILED_FST_INSTALL_VERSION,
    kind: COMPILED_FST_INSTALL_KIND,
    runtime: COMPILED_FST_PROFILE.runtime,
    profile: {
      approvedLaunchSha256: COMPILED_FST_PROFILE.approvedLaunchSha256,
      approvedInventorySha256: COMPILED_FST_PROFILE.approvedInventorySha256,
      factoryManifestSha256: COMPILED_FST_PROFILE.factoryManifestSha256,
      sourceRevision: COMPILED_FST_PROFILE.sourceRevision,
      referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
      sourceRuntime: COMPILED_FST_PROFILE.sourceRuntime,
      nativeParserSha256: COMPILED_FST_PROFILE.nativeParserSha256,
    },
    inventory: {
      referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
      sha256: COMPILED_FST_PROFILE.approvedInventorySha256,
      publicRuleCount: 98,
      factoryFileCount: 16,
    },
    layout: {
      launch: 'rules_fst/launch.fst',
      rulesDir: '.',
      factoryDir: 'factories',
    },
    ...overrides,
  };
}

function writeHome(receipt = approvedReceipt()) {
  const home = mkdtempSync(join(tmpdir(), 'phoenix-nlu-home-'));
  mkdirSync(join(home, 'rules_fst'), { recursive: true });
  mkdirSync(join(home, 'factories'), { recursive: true });
  writeFileSync(join(home, 'rules_fst', 'launch.fst'), 'placeholder-launch');
  writeFileSync(join(home, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return home;
}

test('the default compiled home is the gitignored runtime path', () => {
  assert.equal(defaultCompiledHome('/repo'), join('/repo', DEFAULT_COMPILED_HOME_RELATIVE));
});

test('a valid receipt resolves launch, rules and factory paths', () => {
  const home = writeHome();
  try {
    const resolved = readCompiledInstallReceipt(home);
    assert.equal(resolved.home, home);
    assert.equal(resolved.fstPath, join(home, 'rules_fst', 'launch.fst'));
    assert.equal(resolved.rulesDir, home);
    assert.equal(resolved.factoryDir, join(home, 'factories'));
    assert.equal(resolved.expectedFstSha256, COMPILED_FST_PROFILE.approvedLaunchSha256);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('receipt provenance and layout escapes are rejected', () => {
  const home = writeHome(approvedReceipt({
    profile: { ...approvedReceipt().profile, approvedLaunchSha256: '0'.repeat(64) },
  }));
  try {
    assert.throws(() => readCompiledInstallReceipt(home), /provenance is unsupported/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const escaped = writeHome(approvedReceipt({
    layout: { launch: '../launch.fst', rulesDir: '.', factoryDir: 'factories' },
  }));
  try {
    assert.throws(() => readCompiledInstallReceipt(escaped), /unsafe path segment|relative POSIX path/);
  } finally {
    rmSync(escaped, { recursive: true, force: true });
  }
});

test('an explicit home is required to exist; the default path is silent when empty', () => {
  const missing = join(tmpdir(), 'phoenix-nlu-missing-home');
  assert.throws(() => resolveProvisionedApprovedHome({
    env: { PHOENIX_NLU_COMPILED_HOME: missing },
    repoRoot: '/repo',
  }), /unavailable/);
  const resolved = resolveProvisionedApprovedHome({
    env: {},
    repoRoot: join(tmpdir(), 'phoenix-nlu-empty-repo'),
  });
  assert.equal(resolved, null);
});
