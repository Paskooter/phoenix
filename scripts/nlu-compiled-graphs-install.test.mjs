import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { COMPILED_FST_PROFILE } from '../packages/nlu/src/compiledFstProfile.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(REPO_ROOT, 'scripts/install-nlu-compiled-graphs.mjs');
const REFERENCE_PARSER = process.env.PHOENIX_NLU_REFERENCE_PARSER || resolve(
  REPO_ROOT,
  '../../reference/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser',
);
const REFERENCE_FACTORY = join(REFERENCE_PARSER, 'build/data/en-us/factory_rules');
const hasReference = (() => {
  try {
    return readFileSync(join(REFERENCE_PARSER, 'rules_fst', 'launch.fst')).length > 0
      && readFileSync(join(REFERENCE_FACTORY, 'factory_list.txt')).length > 0;
  } catch {
    return false;
  }
})();

function runInstaller(args, outputParent = tmpdir()) {
  const output = join(outputParent, `nlu-compiled-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const result = spawnSync(process.execPath, [INSTALLER, ...args, '--output', output], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
  });
  return { result, output };
}

test('the compiled-graph installer rejects a missing rules directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-missing-'));
  try {
    const { result } = runInstaller([
      '--rules-dir', join(dir, 'missing-rules'),
      '--factory-dir', dir,
    ], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rules-dir is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compiled-graph installer rejects a launch hash mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-mismatch-'));
  try {
    mkdirSync(join(dir, 'rules_fst'), { recursive: true });
    mkdirSync(join(dir, 'factories'), { recursive: true });
    writeFileSync(join(dir, 'rules_fst', 'launch.fst'), 'not-the-approved-launch');
    const { result } = runInstaller([
      '--rules-dir', dir,
      '--factory-dir', join(dir, 'factories'),
    ], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch|unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compiled-graph installer copies the approved 98-rule tree', {
  skip: !hasReference,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-ok-'));
  try {
    const { result, output } = runInstaller([
      '--rules-dir', REFERENCE_PARSER,
      '--factory-dir', REFERENCE_FACTORY,
    ], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verified, true);
    assert.equal(payload.graphCount, 98);
    assert.equal(payload.factoryFileCount, Object.keys(COMPILED_FST_PROFILE.factoryFiles).length);
    assert.equal(receipt.profile.approvedLaunchSha256, COMPILED_FST_PROFILE.approvedLaunchSha256);
    assert.equal(payload.runtimeMetadata.ruleCount, 98);
    assert.equal(payload.runtimeMetadata.compiledHome, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
