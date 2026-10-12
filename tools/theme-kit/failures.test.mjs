// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'tools/theme-kit/cli.mjs');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'themes/ember'), join(dir, 'input'), { recursive: true });
  return { dir, input: join(dir, 'input') };
}
const cases = [
  ['source manifest bytes', null, (p) => writeFileSync(join(p, 'theme.json'), ' '.repeat(65537)), /theme_manifest_too_large.*65,536/],
  ['encoded image bytes', null, (p) => writeFileSync(join(p, 'assets/icons/about.png'), Buffer.alloc(1048577)), /theme_asset_too_large.*1,048,576/],
  ['asset count', m => { m.assets = Array(65).fill(m.assets[0]); }, null, /theme_json_too_large.*64/],
  ['override count', m => { m.theme.overrides = Array(33).fill(m.theme.overrides[0]); }, null, /theme_overrides_invalid.*32/],
  ['font title size', m => { m.theme.fonts.titleSize = 101; }, null, /theme_font_invalid.*48.*100/],
  ['font label size', m => { m.theme.fonts.labelSize = 39; }, null, /theme_font_invalid.*40.*56/],
  ['text name length', m => { m.name = 'a'.repeat(61); }, null, /theme_text_invalid.*60.*1,200/],
  ['description length', m => { m.description = 'a'.repeat(1201); }, null, /theme_text_invalid.*1,200/],
  ['background opacity', m => { m.theme.background.opacity = 0.36; }, null, /theme_background_invalid.*0.*0.35/],
  ['low text contrast', m => { m.theme.palette.text = m.theme.palette.surface; }, null, /theme_contrast_insufficient.*4.5:1.*3:1/],
  ['low muted contrast', m => { m.theme.palette.mutedText = m.theme.palette.background; }, null, /theme_contrast_insufficient.*4.5:1/],
  ['low accent contrast', m => { m.theme.palette.accent = m.theme.palette.surface; }, null, /theme_contrast_insufficient.*3:1/],
  ['unsafe path', m => { m.assets[0].path = '../outside.png'; }, null, /theme_author_path_invalid.*assets/],
  ['asset symlink', null, p => { const f = join(p, 'assets/icons/about.png'); unlinkSync(f); symlinkSync(join(root, 'themes/ember/assets/icons/about.png'), f); }, /theme_author_path_invalid.*symlink/],
  ['unknown target', m => { m.theme.overrides[0].menuKey = '@be/unknown#menu'; }, null, /theme_target_not_allowed/],
  ['protected safety icon', m => { m.theme.overrides[6].icons[0].itemId = 'shutdown'; }, null, /theme_icon_not_allowed/],
  ['unreferenced asset', m => { delete m.theme.storeAppIcon; }, null, /theme_asset_unused/],
  ['missing asset', m => { m.theme.previewAsset = 'missing'; }, null, /theme_asset_missing/],
  ['duplicate asset', m => { m.assets[0] = m.assets[1]; }, null, /theme_duplicate_asset/],
  ['duplicate override', m => { m.theme.overrides[1].menuKey = m.theme.overrides[0].menuKey; }, null, /theme_duplicate_override/],
  ['wrong permission', m => { m.permissions.push('speech'); }, null, /invalid_permissions/],
  ['raw view config', m => { m.theme.type = 'MenuView'; }, null, /theme_invalid/],
  ['SVG disguised as PNG', null, p => writeFileSync(join(p, 'assets/icons/about.png'), '<svg>' + ' '.repeat(80) + '</svg>'), /image_type_mismatch/],
  ['malformed PNG CRC', null, p => { const f = join(p, 'assets/icons/about.png'); const b = readFileSync(f); b[29] ^= 1; writeFileSync(f, b); }, /image_invalid/],
  ['trailing PNG payload', null, p => { const f = join(p, 'assets/icons/about.png'); writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from('extra')])); }, /image_invalid/],
  ['duplicate JSON key', null, p => { const f = join(p, 'theme.json'); writeFileSync(f, readFileSync(f, 'utf8').replace('"schema": 2', '"schema": 2, "schema": 2')); }, /theme_json_duplicate_key/],
  ['prototype key', null, p => writeFileSync(join(p, 'theme.json'), '{"__proto__":{}}'), /theme_json_forbidden_key/],
  ['JSON depth', null, p => writeFileSync(join(p, 'theme.json'), '['.repeat(13) + '0' + ']'.repeat(13)), /theme_json_too_deep.*12/],
  ['malformed UTF-8', null, p => writeFileSync(join(p, 'theme.json'), Buffer.from([255])), /theme_json_invalid/],
  ['missing image', null, p => unlinkSync(join(p, 'assets/icons/about.png')), /ENOENT.*missing/i],
];
for (const [name, mutate, files, error] of cases) {
  test(`check rejects ${name} with an actionable error`, t => {
    const { input, dir } = fixture(t);
    if (mutate) { const m = JSON.parse(readFileSync(join(input, 'theme.json'))); mutate(m); writeFileSync(join(input, 'theme.json'), JSON.stringify(m)); }
    if (files) files(input);
    const result = spawnSync(process.execPath, [cli, 'pack', input, '--out', join(dir, 'output')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(dir), ['input'], 'invalid packs produce no output directory');
  });
}
test('CLI rejects unsupported verbs and missing/unknown options', () => {
  for (const args of [[], ['sign'], ['check'], ['check', 'themes/ember', '--out', 'out'], ['pack', 'themes/ember'], ['pack', 'themes/ember', '--out'], ['pack', 'themes/ember', '--publish', 'out']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /Usage:/);
  }
});
