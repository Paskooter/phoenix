// G.3 — the vendored pure-JS QR encoder, verified by decoding its output with jsQR (dev-only
// oracle). Covers versions 1-5 (the OOBE frames are small) across byte-mode payloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg } from '../portal/qr.js';
import { buildQrCodes, robotDecode } from '../src/qrPayload.js';

function decode(text) {
  const { size, rows } = qrMatrix(text);
  const scale = 4; const q = 4; const dim = (size + 2 * q) * scale;
  const img = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!rows[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((y + q) * scale + dy) * dim + (x + q) * scale + dx;
          img[px * 4] = img[px * 4 + 1] = img[px * 4 + 2] = 0;
        }
      }
    }
  }
  return jsQR(img, dim, dim);
}

for (const text of [
  '1/1\nhello world',
  'x'.repeat(30),
  '2/3\nABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$',
  'JetsonNet\norbit-city\nAb3xK9z',
  '1/1\n' + Array.from({ length: 84 }, (_, i) => String.fromCharCode(33 + (i % 90))).join(''),
]) {
  test(`QR encodes+decodes (${text.length} bytes)`, () => {
    const out = decode(text);
    assert.ok(out, 'jsQR located and read the code');
    assert.equal(out.data, text, 'decoded payload matches the input exactly');
    assert.deepEqual(out.binaryData, [...Buffer.from(text, 'utf8')], 'ASCII bytes stay unchanged');
  });
}

test('non-ASCII QR byte mode declares UTF-8 to the robot ZBar 0.10 decoder', () => {
  const { codes } = buildQrCodes({ ssid: 'Kim’s iPhone', password: 'example-pass', token: 'EXAMPLE_TOKEN' });
  const result = decode(codes[0]);
  assert.ok(result, 'QR image can be read');
  // ZBar 0.10 qrdectxt.c tries Shift-JIS before UTF-8 without a BOM; this
  // exact scrambled SSID is valid Shift-JIS and corrupts every later field.
  // It strips a leading UTF-8 BOM before returning content to config.bt.
  assert.deepEqual(result.binaryData.slice(0, 3), [0xef, 0xbb, 0xbf]);
  assert.deepEqual(result.binaryData.slice(3), [...Buffer.from(codes[0], 'utf8')]);
});

test('UTF-8 BOM bytes count towards version selection and the v6 capacity limit', () => {
  const boundary = 'é' + 'x'.repeat(101); // 103 UTF-8 bytes + 3 BOM bytes = v6-M's 106
  assert.equal(qrMatrix(boundary).version, 6);
  assert.deepEqual(decode(boundary).binaryData, [0xef, 0xbb, 0xbf, ...Buffer.from(boundary)]);
  assert.throws(() => qrMatrix(boundary + 'x'), /payload too long.*107 bytes/);
});

test('qrSvg produces a valid square SVG with a quiet zone', () => {
  const svg = qrSvg('1/1\nhello', 5);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 (\d+) \1"/, 'square viewBox');
  assert.match(svg, /<rect[^>]*fill="#fff"/, 'white background');
  assert.ok(svg.includes('fill="#000"'), 'dark modules');
});

for (const input of [
  { ssid: '網'.repeat(10), password: 'ü'.repeat(30), token: 't'.repeat(32) },
  { ssid: 's'.repeat(32), password: '😀'.repeat(15), token: 't'.repeat(32) },
  { ssid: 'Kim’s iPhone', password: 'example-pass', token: 'EXAMPLE_TOKEN' },
  { ssid: 'Example-Net', password: 'example-’', token: 'EXAMPLE_TOKEN' },
  { ssid: 'Café-Net', password: 'naïve-pass', token: 'EXAMPLE_TOKEN' },
]) {
  test(`UTF-8 setup frames survive QR rendering and decoding (${Buffer.byteLength(input.password)} password bytes)`, () => {
    const { codes } = buildQrCodes(input);
    const scanned = codes.map(code => {
      const result = decode(code);
      assert.ok(result, 'QR image can be read');
      // jsQR exposes the BOM as a character; the robot's ZBar strips it.
      const content = result.data.replace(/^\uFEFF/, '');
      assert.equal(content, code, 'UTF-8 survives the actual encoder and image decoder');
      const bytes = [...Buffer.from(code, 'utf8')];
      assert.deepEqual(result.binaryData, bytes.some(byte => byte >= 0x80)
        ? [0xef, 0xbb, 0xbf, ...bytes] : bytes, 'BOM is transport metadata, not XOR payload');
      return content;
    });
    const decoded = robotDecode(scanned.reverse());
    assert.equal(decoded.ssid, input.ssid);
    assert.equal(decoded.password, input.password);
    assert.equal(decoded.token, input.token);
  });
}
