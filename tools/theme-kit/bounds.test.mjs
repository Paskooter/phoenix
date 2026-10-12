// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, cpSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import theme from './themeFormat.cjs';
import { packDirectory, packTheme, ICON_TARGETS } from './pack.mjs';
import { explain } from './errors.mjs';
import { output } from './cli.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'tools/theme-kit/cli.mjs');
const pack = await packDirectory(join(root, 'themes/ember'));
function clone() { return structuredClone(pack.manifest); }
function temporary(t) { const d = mkdtempSync(join(tmpdir(), 'theme-bounds-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8);
  let c = 0xffffffff;
  for (const n of b.subarray(4, b.length - 4)) { c ^= n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  b.writeUInt32BE((c ^ 0xffffffff) >>> 0, b.length - 4); return b;
}
function png(width, height, color = 6, fill = 0) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = color;
  const channels = color === 6 ? 4 : 3, raw = Buffer.alloc((width * channels + 1) * height, fill);
  // Deterministic high-entropy synthetic pixels for byte-bound tests.
  if (fill === -1) {
    let state = 12345;
    for (let y = 0; y < height; y++) for (let x = 1; x <= width * channels; x++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      raw[y * (width * channels + 1) + x] = state & 255;
    }
  }
  for (let y = 0; y < height; y++) raw[y * (width * channels + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function paletteOnly() {
  const m = clone(); m.assets = []; m.theme.overrides = []; m.theme.background = { asset: null, opacity: 0 };
  delete m.theme.previewAsset; delete m.theme.storeAppIcon; return m;
}

test('palette-only pack needs no images or preview and remains checkable', async t => {
  const dir = temporary(t), m = paletteOnly();
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(m));
  const result = await packDirectory(dir);
  assert.equal(result.manifest.assets.length, 0);
  assert.equal(result.bytes.length, 12 + result.manifestBytes.length);
  const files = output(result, join(dir, 'out'), 'palette');
  assert.equal(files.length, 2); assert.ok(!files.some(f => f.endsWith('preview.png')));
});
for (const [name, mutate, code] of [
  ['icon width', m => { m.assets.find(a => a.role === 'icon').width = 257; }, 'theme_dimensions_invalid'],
  ['zero dimensions', m => { m.assets[0].height = 0; }, 'theme_dimensions_invalid'],
  ['background width', m => { m.assets.find(a => a.role === 'background').width = 1281; }, 'theme_dimensions_invalid'],
  ['preview height', m => { m.assets.find(a => a.role === 'preview').height = 721; }, 'theme_dimensions_invalid'],
  ['menu key length', m => { m.theme.overrides[0].menuKey = '@be/main-menu#' + 'a'.repeat(120); }, 'theme_menu_key_invalid'],
  ['item ID length', m => { m.theme.overrides[0].icons[0].itemId = 'x'.repeat(81); }, 'theme_item_invalid'],
  ['icon entry count', m => { m.theme.overrides[0].icons = Array(65).fill(m.theme.overrides[0].icons[0]); }, 'theme_icons_invalid'],
  ['asset entry count', m => { m.assets = Array(65).fill(m.assets[0]); }, 'theme_assets_invalid'],
  ['version overflow', m => { m.version = '9007199254740992.0.0'; }, 'invalid_version'],
  ['prerelease manifest', m => { m.minFirmware = '13.7.0-dev.1'; }, 'invalid_version'],
  ['asset ID length', m => { m.assets[0].id = 'a'.repeat(41); }, 'theme_invalid'],
  ['duplicate preview', m => { m.assets.find(a => a.id === 'about').role = 'preview'; }, 'theme_asset_role_invalid'],
]) {
  test(`manifest rejects ${name}`, () => {
    const m = clone(); mutate(m); assert.throws(() => theme.validateManifest(m), e => e.code === code);
  });
}
test('total pixel budget is enforced independently of encoded-byte budget', () => {
  const m = clone();
  for (let i = 0; i < 5; i++) {
    m.assets.push({ ...m.assets[0], id: `extra-${i}` });
    m.theme.overrides[0].icons.push({ itemId: `extra-${i}`, asset: `extra-${i}` });
  }
  m.assets.sort((a, b) => a.id < b.id ? -1 : 1);
  assert.throws(() => theme.validateManifest(m), e => e.code === 'theme_pixels_exceeded');
  assert.match(explain({ code: 'theme_pixels_exceeded' }), /4,194,304/);
});
test('canonical manifest has its own 65,536-byte bound', () => {
  const m = clone();
  for (let i = 0; i < 20; i++) m.theme.overrides.push({ menuKey: `@be/main-menu#extra${i}`, icons: Array.from({ length: 64 }, (_, k) => ({ itemId: `item${k}` + 'x'.repeat(70), asset: 'about' })) });
  assert.throws(() => theme.validateManifest(m), e => e.code === 'theme_manifest_too_large');
});
test('full normalized artifact has its own 8 MiB bound', async () => {
  const m = paletteOnly(), blobs = [], image = png(256, 256, 6, -1);
  let i = 0;
  m.theme.overrides = Object.entries(ICON_TARGETS).filter(([, items]) => items.length).map(([menuKey, items]) => ({ menuKey, icons: items.map(itemId => {
    const id = `icon-${String(i++).padStart(2, '0')}`; blobs.push({ id, role: 'icon', bytes: image }); return { itemId, asset: id };
  }) }));
  m.theme.storeAppIcon = 'store-app'; blobs.push({ id: 'store-app', role: 'icon', bytes: image });
  assert.ok(image.length < theme.LIMITS.assetBytes);
  assert.ok(blobs.length * 256 * 256 < theme.LIMITS.totalPixels);
  await assert.rejects(packTheme(m, blobs), e => e.code === 'theme_artifact_too_large');
  assert.match(explain({ code: 'theme_artifact_too_large' }), /8,388,608/);
});
test('static RGB/RGBA normalization strips approved ancillary chunks', async () => {
  const m = paletteOnly(); m.theme.storeAppIcon = 'app';
  const image = png(16, 16), at = 33;
  const withMetadata = Buffer.concat([image.subarray(0, at), chunk('pHYs', Buffer.alloc(9)), image.subarray(at)]);
  const a = await packTheme(m, [{ id: 'app', role: 'icon', bytes: image }]);
  const b = await packTheme(m, [{ id: 'app', role: 'icon', bytes: withMetadata }]);
  assert.equal(a.bytes.length, b.bytes.length); assert.deepEqual(a.bytes, b.bytes);
});
for (const [name, modify, code] of [
  ['APNG animation', b => Buffer.concat([b.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), b.subarray(33)]), 'image_chunk_rejected'],
  ['invalid pixel filter', b => { const raw = Buffer.alloc(16 * 65); raw[0] = 5; return Buffer.concat([b.subarray(0, 33), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }, 'image_invalid'],
  ['trailing deflate payload', b => { const raw = Buffer.alloc(16 * 65); return Buffer.concat([b.subarray(0, 33), chunk('IDAT', Buffer.concat([deflateSync(raw), Buffer.from('extra')])), chunk('IEND', Buffer.alloc(0))]); }, 'image_trailing_payload'],
  ['interlaced PNG', b => { const h = Buffer.from(b.subarray(16, 29)); h[12] = 1; return Buffer.concat([b.subarray(0, 8), chunk('IHDR', h), b.subarray(33)]); }, 'image_format_rejected'],
]) test(`image decode rejects ${name}`, async () => {
  const m = paletteOnly(); m.theme.storeAppIcon = 'app';
  await assert.rejects(packTheme(m, [{ id: 'app', role: 'icon', bytes: modify(png(16, 16)) }]), e => e.code === code);
});
test('baseline JPEG background is decoded and emitted as a clean PNG', async t => {
  const probe = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('optional JPEG decoder needs Python3/Pillow');
  const jpeg = spawnSync('python3', ['-c', "from PIL import Image; import sys; Image.new('RGB',(32,24),(80,90,100)).save(sys.stdout.buffer,format='JPEG')"]);
  assert.equal(jpeg.status, 0);
  const m = paletteOnly(); m.theme.background = { asset: 'background', opacity: 0.2 };
  const result = await packTheme(m, [{ id: 'background', role: 'background', bytes: jpeg.stdout }]);
  assert.equal(result.manifest.assets[0].mediaType, 'image/png');
  assert.equal(result.manifest.assets[0].width, 32); assert.equal(result.manifest.assets[0].height, 24);
});
test('JPEG cannot be used as an icon', async t => {
  const jpeg = spawnSync('python3', ['-c', "from PIL import Image; import sys; Image.new('RGB',(16,16)).save(sys.stdout.buffer,format='JPEG')"]);
  if (jpeg.status !== 0) return t.skip('optional JPEG decoder needs Python3/Pillow');
  const m = paletteOnly(); m.theme.storeAppIcon = 'app';
  await assert.rejects(packTheme(m, [{ id: 'app', role: 'icon', bytes: jpeg.stdout }]), e => e.code === 'theme_media_type_invalid');
});
for (const location of ['root', 'assets', 'manifest']) test(`source ${location} symlink is refused`, async t => {
  const dir = temporary(t), input = join(dir, 'input');
  if (location === 'root') symlinkSync(join(root, 'themes/ember'), input);
  else {
    cpSync(join(root, 'themes/ember'), input, { recursive: true });
    const local = join(input, location === 'assets' ? 'assets' : 'theme.json');
    rmSync(local, { recursive: true }); symlinkSync(join(root, 'themes/ember', location === 'assets' ? 'assets' : 'theme.json'), local);
  }
  await assert.rejects(packDirectory(input), e => e.code === 'theme_author_path_invalid');
});
test('output collision rolls back only newly created outputs and never follows a final symlink', t => {
  const dir = temporary(t), marker = join(dir, 'marker'); writeFileSync(marker, 'keep');
  symlinkSync(marker, join(dir, 'ember-1.0.0.manifest.json'));
  assert.throws(() => output(pack, dir, 'ember'), e => e.code === 'EEXIST');
  assert.deepEqual(readdirSync(dir).sort(), ['ember-1.0.0.manifest.json', 'marker']);
  assert.equal(readFileSync(marker, 'utf8'), 'keep');
});
test('partial output write failure removes the failed file as well as earlier derivatives', t => {
  const dir = temporary(t);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.writeFileSync;
    let calls = 0;
    fs.writeFileSync = (...args) => {
      original(...args);
      if (++calls === 2) { const error = new Error('synthetic full disk after partial write'); error.code = 'ENOSPC'; throw error; }
    };
    syncBuiltinESMExports();
    const { output } = await import(${JSON.stringify(new URL('./cli.mjs', import.meta.url).href)});
    try { output({ bytes: Buffer.from('fixture'), manifestBytes: Buffer.from('{}'), manifest: {version:'1.0.0', assets:[], theme:{}} }, ${JSON.stringify(dir)}, 'fixture'); process.exitCode = 2; }
    catch (error) { if (error.code !== 'ENOSPC') throw error; }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dir), [], 'no failed or half-written output survives');
});

test('author guide covers every source icon and exact semantic mapping', () => {
  const doc = readFileSync(join(root, 'docs/THEMES.md'), 'utf8');
  const table = doc.split('## Full icon role table')[1].split('## Check, pack')[0];
  const rows = [...table.matchAll(/^\| `([a-z][a-z0-9-]*)` \| (.*?) \| 256 × 256 \|$/gm)];
  const m = JSON.parse(readFileSync(join(root, 'themes/ember/theme.json')));
  assert.equal(rows.length, 38);
  assert.deepEqual(rows.map(r => r[1]).sort(), m.assets.filter(a => a.role === 'icon').map(a => a.id).sort());
  for (const o of m.theme.overrides) for (const icon of o.icons) assert.ok(rows.find(r => r[1] === icon.asset)[2].includes('`' + icon.itemId + '`'), icon.itemId);
  for (const value of [65536, 8388608, 1048576, 4194304]) assert.ok(doc.includes(value.toLocaleString('en-US')));
});
