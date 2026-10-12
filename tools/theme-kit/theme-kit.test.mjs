// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'tools/theme-kit/cli.mjs');
const expected = JSON.parse(readFileSync(new URL('./expected-sha256.json', import.meta.url)));
function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-kit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const name of ['ember', 'orbit']) {
  test(`check ${name} validates the real pack without writing files`, t => {
    const dir = temporary(t);
    const result = run(['check', join(root, 'themes', name)], dir);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    for (const [key, value] of Object.entries(expected[name])) assert.equal(report[key], value, key);
    assert.equal(report.runtime, 'phoenix-menu-theme-v1');
    assert.ok(report.contrast.textOnSurface >= 4.5);
    assert.deepEqual(readdirSync(dir), []);
  });
  test(`pack ${name} matches the pinned reference SHA and emits canonical derivatives`, t => {
    const dir = temporary(t), source = join(root, 'themes', name);
    const before = readFileSync(join(source, 'theme.json'));
    const result = run(['pack', source, '--out', dir]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const artifact = readFileSync(join(dir, `${name}-1.0.0.phtheme`));
    assert.equal(createHash('sha256').update(artifact).digest('hex'), expected[name].sha256);
    assert.equal(artifact.length, expected[name].bytes);
    assert.equal(artifact.subarray(0, 8).toString(), 'PHXTHM1\n');
    const manifestBytes = artifact.subarray(12, 12 + artifact.readUInt32BE(8));
    assert.deepEqual(readFileSync(join(dir, `${name}-1.0.0.manifest.json`)), manifestBytes);
    const manifest = JSON.parse(manifestBytes);
    assert.ok(manifest.assets.every(a => !('path' in a)));
    const preview = manifest.assets.find(a => a.id === manifest.theme.previewAsset);
    assert.equal(createHash('sha256').update(readFileSync(join(dir, `${name}-1.0.0.preview.png`))).digest('hex'), preview.sha256);
    assert.deepEqual(readFileSync(join(source, 'theme.json')), before);
    assert.equal(report.sha256, expected[name].sha256);
    assert.equal(run(['pack', source, '--out', dir]).status, 1, 'never overwrite an artifact');
  });
}
