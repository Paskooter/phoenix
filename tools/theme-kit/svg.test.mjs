// SPDX-License-Identifier: BSD-3-Clause
import testCase from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { packDirectory, packTheme } from './pack.mjs';
import theme from './themeFormat.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const probe = spawnSync('python3', ['-I', '-c', 'import resource, cairosvg, defusedxml; from PIL import Image'], { timeout: 10000 });
const skip = probe.status !== 0 && process.env.PHOENIX_THEME_SVG_REQUIRED !== '1'
  && 'Optional SVG tests require isolated Python3 with CairoSVG/Pillow and Unix resource limits.';
function test(name, fn) { return testCase(name, { skip }, fn); }
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><rect x="8" width="16" height="16" fill="#336699"/></svg>';
function manifest() {
  const m = JSON.parse(readFileSync(join(root, 'themes/ember/theme.json')));
  m.assets = [{ id: 'mark', role: 'icon', path: 'assets/icons/mark.svg' }];
  m.theme.overrides = []; m.theme.background = { asset: null, opacity: 0 };
  m.theme.storeAppIcon = 'mark'; delete m.theme.previewAsset;
  return m;
}
function fixture(t, svg = icon) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-svg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets/icons'), { recursive: true });
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(manifest()));
  writeFileSync(join(dir, 'assets/icons/mark.svg'), svg);
  return dir;
}
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8);
  let c = 0xffffffff;
  for (const n of b.subarray(4, b.length - 4)) { c ^= n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  b.writeUInt32BE((c ^ 0xffffffff) >>> 0, b.length - 4); return b;
}
function manualPng() {
  const h = Buffer.alloc(13); h.writeUInt32BE(256); h.writeUInt32BE(256, 4); h[8] = 8; h[9] = 6;
  const raw = Buffer.alloc(256 * 1025);
  for (let y = 64; y < 192; y++) for (let x = 64; x < 192; x++) raw.set([51, 102, 153, 255], y * 1025 + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('static SVG icon becomes the same validated 256px PNG pack as manual conversion', async t => {
  const dir = fixture(t), before = readFileSync(join(dir, 'assets/icons/mark.svg'));
  const result = await packDirectory(dir);
  const m = manifest(); m.assets = [];
  const manual = await packTheme(m, [{ id: 'mark', role: 'icon', bytes: manualPng() }]);
  assert.deepEqual(result.bytes, manual.bytes, 'aspect ratio, centered padding, pixels and normalized artifact match');
  const [asset] = result.manifest.assets;
  assert.equal(asset.mediaType, 'image/png'); assert.equal(asset.width, 256); assert.equal(asset.height, 256);
  assert.equal(theme.validateManifest(result.manifest).manifest.assets.length, 1);
  assert.doesNotMatch(result.manifestBytes.toString(), /svg|path/);
  assert.deepEqual(readFileSync(join(dir, 'assets/icons/mark.svg')), before, 'source remains untouched');
});

const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">${body}</svg>`;
for (const [name, svg] of [
  ['script', wrap('<script>alert(1)</script>')],
  ['foreignObject', wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">text</div></foreignObject>')],
  ['foreign namespace', wrap('<path xmlns="https://invalid.example/svg" d="M0 0"/>')],
  ['root onload', icon.replace('width="32"', 'onload="alert(1)" width="32"')],
  ['mixed-case event handler', wrap('<rect onClick="alert(1)" width="12" height="12"/>')],
  ['DOCTYPE', '<!DOCTYPE svg>' + icon],
  ['external entity', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///not-an-input">]>' + wrap('&x;')],
  ['entity expansion', '<!DOCTYPE svg [<!ENTITY x "ha"><!ENTITY y "&x;&x;&x;">]>' + wrap('&y;')],
  ['encoded entity', wrap('<path fill="&#117;rl(file:///not-an-input)" d="M0 0"/>')],
  ['external href', wrap('<use href="https://invalid.example/icon.svg#shape"/>')],
  ['file href', wrap('<use href="file:///not-an-input"/>')],
  ['relative href', wrap('<use href="other.svg#shape"/>')],
  ['xlink href', wrap('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://invalid.example/icon.svg#shape"/>')],
  ['external paint URL', wrap('<path fill="url(https://invalid.example/paint.svg#g)" d="M0 0"/>')],
  ['file paint URL', wrap('<path fill="url(file:///not-an-input#g)" d="M0 0"/>')],
  ['relative paint URL', wrap('<path fill="url(other.svg#g)" d="M0 0"/>')],
  ['CSS-escaped URL', wrap('<path fill="u\\72l(file:///not-an-input)" d="M0 0"/>')],
  ['stylesheet', wrap('<style>@import "https://invalid.example/style.css";</style>')],
  ['style attribute', wrap('<path style="fill:url(file:///not-an-input)" d="M0 0"/>')],
  ['stylesheet instruction', '<?xml-stylesheet href="https://invalid.example/style.css"?>' + icon],
  ['XML base', icon.replace('width="32"', 'xml:base="https://invalid.example/" width="32"')],
  ['embedded raster data', wrap('<image href="data:image/png;base64,eA==" width="24" height="24"/>')],
  ['animation', wrap('<animate attributeName="width" from="0" to="100" dur="1s"/>')],
  ['text/font lookup', wrap('<text x="1" y="10">text</text>')],
  ['recursive use', wrap('<defs><g id="a"><use href="#a"/></g></defs><use href="#a"/>')],
]) test(`SVG rejects ${name} before rendering`, async t => {
  await assert.rejects(packDirectory(fixture(t, svg)), e => e.code === 'svg_unsafe');
});

for (const [name, dimensions] of [
  ['oversized width', 'width="4097" height="16"'],
  ['unbounded numeric size', 'width="1e300" height="16"'],
  ['nonfinite width', 'width="NaN" height="16"'],
  ['zero height', 'width="16" height="0"'],
  ['negative size', 'width="-16" height="16"'],
  ['percentage size', 'width="100%" height="100%"'],
  ['missing dimensions', ''],
  ['oversized viewBox', 'viewBox="0 0 1000000 1000000"'],
  ['zero viewBox', 'viewBox="0 0 0 16"'],
  ['source pixel budget', 'width="4096" height="4096"'],
]) test(`SVG rejects ${name}`, async t => {
  await assert.rejects(packDirectory(fixture(t, `<svg xmlns="http://www.w3.org/2000/svg" ${dimensions}><rect width="1" height="1"/></svg>`)), e => e.code === 'svg_dimensions_invalid');
});

test('SVG rejects compressed input without expanding it', async t => {
  const { gzipSync } = await import('node:zlib');
  await assert.rejects(packDirectory(fixture(t, gzipSync(Buffer.alloc(8 * 1024 * 1024, 32)))), e => e.code === 'svg_invalid');
});
test('SVG source byte cap is checked before reading/decoding', async t => {
  await assert.rejects(packDirectory(fixture(t, icon + ' '.repeat(262144))), e => e.code === 'theme_asset_too_large');
});
test('SVG rejects too many elements', async t => {
  await assert.rejects(packDirectory(fixture(t, wrap('<path d="M0 0"/>'.repeat(2048)))), e => e.code === 'svg_too_complex');
});
test('SVG rejects excessive nesting', async t => {
  await assert.rejects(packDirectory(fixture(t, wrap('<g>'.repeat(32) + '<path d="M0 0"/>' + '</g>'.repeat(32)))), e => e.code === 'svg_too_complex');
});
test('SVG rejects non-icon roles', async t => {
  const dir = fixture(t), m = manifest();
  m.assets[0].role = 'background'; m.theme.background = { asset: 'mark', opacity: 0.2 }; delete m.theme.storeAppIcon;
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(m));
  await assert.rejects(packDirectory(dir), e => e.code === 'theme_media_type_invalid');
});

test('static paths, transforms, fragment gradients and clips accept viewBox-only input', async t => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="paint"><stop offset="0%" stop-color="#336699"/><stop offset="100%" stop-color="#669933"/></linearGradient>
        <clipPath id="crop"><circle cx="12" cy="12" r="10"/></clipPath>
      </defs>
      <g transform="translate(1 1) rotate(5 12 12)" clip-path="url(#crop)">
        <path d="M2 2 H22 V22 H2 Z" fill="url(#paint)"/>
        <polyline points="4,8 8,4 12,8" fill="none" stroke="#ffffff" stroke-width="1"/>
      </g>
    </svg>`;
  const result = await packDirectory(fixture(t, svg));
  const png = result.bytes.subarray(12 + result.manifestBytes.length);
  const info = theme.inspectImage(png, result.manifest.assets[0]);
  assert.equal(info.width, 256); assert.equal(info.height, 256); assert.equal(info.channels, 4);
});

for (const [name, svg, code] of [
  ['malformed XML', '<svg width="24" height="24"><path></svg>', 'svg_invalid'],
  ['invalid UTF-8', Buffer.from([255, 254, 60, 0, 115, 0]), 'svg_invalid'],
  ['missing fragment', wrap('<path d="M0 0" fill="url(#missing)"/>'), 'svg_unsafe'],
  ['reference cycle', wrap('<defs><clipPath id="crop"><path d="M0 0" clip-path="url(#crop)"/></clipPath></defs><path d="M0 0" clip-path="url(#crop)"/>'), 'svg_too_complex'],
  ['oversized path coordinate', wrap('<path d="M1e300 0"/>'), 'svg_invalid'],
  ['oversized path value', wrap(`<path d="M${'0 '.repeat(32769)}"/>`), 'svg_too_complex'],
]) test(`SVG rejects ${name}`, async t => {
  await assert.rejects(packDirectory(fixture(t, svg)), e => e.code === code);
});

test('SVG paths keep the regular local file and no-symlink boundary', async t => {
  const dir = fixture(t), file = join(dir, 'assets/icons/mark.svg');
  unlinkSync(file); symlinkSync(join(root, 'themes/ember/assets/icons/about.png'), file);
  await assert.rejects(packDirectory(dir), e => e.code === 'theme_author_path_invalid');
});

test('SVG external references do not contact a real loopback listener', async t => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; res.end(icon); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/not-an-input.svg`;
  for (const svg of [wrap(`<use href="${url}"/>`), wrap(`<path fill="url(${url}#paint)" d="M0 0"/>`), wrap(`<image href="${url}"/>`)]) {
    await assert.rejects(packDirectory(fixture(t, svg)), e => e.code === 'svg_unsafe');
  }
  assert.equal(requests, 0);
});

function decoderResult(t, body, svg = icon) {
  const dir = fixture(t, svg), bin = join(dir, 'bin'); mkdirSync(bin);
  if (body) writeFileSync(join(bin, 'python3'), `#!${process.execPath}\n${body(dir)}\n`, { mode: 0o700 });
  const source = `import {packDirectory} from ${JSON.stringify(new URL('./pack.mjs', import.meta.url).href)};
    try { await packDirectory(${JSON.stringify(dir)}); console.log('accepted'); }
    catch (error) { console.log(error.code); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return { code: result.stdout.trim(), dir };
}

test('SVG decoder absolute deadline kills and reaps a stalled child', t => {
  const { code, dir } = decoderResult(t, dir => `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child-pid'))}, String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);`);
  assert.equal(code, 'svg_decode_timeout');
  const pid = Number(readFileSync(join(dir, 'child-pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', 'the promise settles only after the child is gone');
});
test('SVG decoder output byte cap kills and reaps an overproducing child', t => {
  const { code } = decoderResult(t, () => 'process.stdin.resume(); process.stdout.write(Buffer.alloc(1048577)); setInterval(()=>{},1000);');
  assert.equal(code, 'theme_asset_too_large');
});
function decoderPng(t, png) {
  return decoderResult(t, () => `process.stdin.resume(); process.stdout.end(Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));`).code;
}
test('SVG decoder output must still have the declared PNG dimensions', t => {
  const p = manualPng(), h = Buffer.from(p.subarray(16, 29)); h.writeUInt32BE(512);
  assert.equal(decoderPng(t, Buffer.concat([p.subarray(0, 8), chunk('IHDR', h), p.subarray(33)])), 'image_dimensions_mismatch');
});
test('SVG decoder output cannot bypass the PNG decompression limit', t => {
  const p = manualPng();
  const bomb = Buffer.concat([p.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(8 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(decoderPng(t, bomb), 'image_invalid');
});
test('SVG decoder failure and missing dependencies refuse without fallback', t => {
  assert.equal(decoderResult(t, null).code, 'svg_decoder_unavailable');
  assert.equal(decoderResult(t, () => "process.stdin.resume();process.stderr.write('svg_decoder_unavailable');process.exitCode=2;").code, 'svg_decoder_unavailable');
  assert.equal(decoderResult(t, () => 'process.stdin.resume();process.exitCode=2;').code, 'svg_invalid');
});

test('SVG fixed output pixels participate in the pre-decode total pixel budget', async () => {
  const m = manifest(); m.assets = []; m.theme.storeAppIcon = 'mark-0'; m.theme.background = { asset: 'backing', opacity: 0.2 };
  const h = Buffer.alloc(13); h.writeUInt32BE(1280); h.writeUInt32BE(720, 4); h[8] = 8; h[9] = 6;
  const background = Buffer.concat([manualPng().subarray(0, 8), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.alloc(720 * 5121))), chunk('IEND', Buffer.alloc(0))]);
  const blobs = Array.from({ length: 63 }, (_, i) => ({ id: `mark-${i}`, role: 'icon', mediaType: 'image/svg+xml', bytes: Buffer.from('<invalid/>') }));
  blobs.push({ id: 'backing', role: 'background', bytes: background });
  await assert.rejects(packTheme(m, blobs), e => e.code === 'theme_pixels_exceeded', 'reject before parsing or rendering any SVG');
});

test('CLI check and pack convert SVG while keeping only existing PNG runtime metadata', t => {
  const dir = fixture(t), cli = join(root, 'tools/theme-kit/cli.mjs');
  const check = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8', timeout: 15000 });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).pixels, 65536);
  assert.deepEqual(readdirSync(dir).sort(), ['assets', 'theme.json']);
  const out = join(dir, 'out');
  const pack = spawnSync(process.execPath, [cli, 'pack', dir, '--out', out], { encoding: 'utf8', timeout: 15000 });
  assert.equal(pack.status, 0, pack.stderr);
  const report = JSON.parse(pack.stdout);
  assert.equal(report.sha256, JSON.parse(check.stdout).sha256);
  assert.equal(report.files.length, 2);
  const packedManifest = JSON.parse(readFileSync(report.files.find(f => f.endsWith('.manifest.json'))));
  assert.equal(packedManifest.assets[0].mediaType, 'image/png');
  assert.equal(packedManifest.assets[0].width, 256);
});
