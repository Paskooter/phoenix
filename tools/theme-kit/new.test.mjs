// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'tools/theme-kit/cli.mjs');
function run(args, cwd) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000 }); }
function temporary(t) { const d = mkdtempSync(join(tmpdir(), 'theme-new-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
for (const template of ['ember', 'orbit']) {
  test(`new from ${template} gives a fresh valid identity, author credit and editable copy`, t => {
    const dir = temporary(t), source = join(root, 'themes', template);
    const originalBytes = readFileSync(join(source, 'theme.json'));
    const original = JSON.parse(originalBytes);
    const r = run(['new', 'copper', '--from', template, '--author', 'Example Artist'], dir);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    const m = JSON.parse(readFileSync(join(dir, 'copper/theme.json')));
    assert.match(m.appId, /^app-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.notEqual(m.appId, original.appId);
    assert.equal(m.name, 'copper');
    assert.match(m.description, /Example Artist/);
    assert.match(readFileSync(join(dir, 'copper/AUTHOR.md'), 'utf8'), /Example Artist/);
    assert.match(readFileSync(join(dir, 'copper/README.md'), 'utf8'), /placeholder.*publisher-assigned/s);
    assert.deepEqual(m.theme, original.theme);
    assert.deepEqual(readFileSync(join(dir, 'copper/LICENSE.md')), readFileSync(join(source, 'LICENSE.md')));
    for (const a of m.assets) assert.deepEqual(readFileSync(join(dir, 'copper', a.path)), readFileSync(join(source, a.path)));
    assert.equal(run(['check', join(dir, 'copper')], dir).status, 0);
    assert.equal(run(['pack', join(dir, 'copper'), '--out', join(dir, 'packed')], dir).status, 0);
    assert.equal(result.author, 'Example Artist');
    const second = run(['new', 'silver', '--from', template], dir);
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(JSON.parse(second.stdout).appId, m.appId);
    assert.equal(JSON.parse(second.stdout).author, 'Your name');
    assert.equal(run(['new', 'copper', '--from', template], dir).status, 1);
    assert.deepEqual(readFileSync(join(source, 'theme.json')), originalBytes);
  });
}
test('new rejects unsafe names, templates and author text without creating directories', t => {
  const dir = temporary(t);
  for (const args of [
    ['new', '../escape', '--from', 'ember'], ['new', 'Uppercase', '--from', 'ember'],
    ['new', 'a'.repeat(41), '--from', 'ember'], ['new', 'copper'],
    ['new', 'copper', '--from', 'unknown'], ['new', 'copper', '--from'],
    ['new', 'copper', '--from', 'ember', '--from', 'orbit'],
    ['new', 'copper', '--from', 'ember', '--author', ''],
    ['new', 'copper', '--from', 'ember', '--author', 'bad\nname'],
    ['new', 'copper', '--from', 'ember', '--author', 'x'.repeat(101)],
    ['new', 'copper', '--from', 'ember', '--publish', 'yes'],
  ]) { assert.equal(run(args, dir).status, 1, JSON.stringify(args)); assert.deepEqual(readdirSync(dir), []); }
});
test('kit works detached from the repository without npm or server modules', t => {
  const dir = temporary(t);
  cpSync(join(root, 'tools/theme-kit'), join(dir, 'tools/theme-kit'), { recursive: true });
  cpSync(join(root, 'themes'), join(dir, 'themes'), { recursive: true });
  const r = spawnSync(process.execPath, [join(dir, 'tools/theme-kit/cli.mjs'), 'check', join(dir, 'themes/orbit')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
