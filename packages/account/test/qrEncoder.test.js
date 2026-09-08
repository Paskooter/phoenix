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
  });
}

test('qrSvg produces a valid square SVG with a quiet zone', () => {
  const svg = qrSvg('1/1\nhello', 5);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 (\d+) \1"/, 'square viewBox');
  assert.match(svg, /<rect[^>]*fill="#fff"/, 'white background');
  assert.ok(svg.includes('fill="#000"'), 'dark modules');
});

for (const input of [
  { ssid: '網'.repeat(10), password: 'ü'.repeat(30), token: 't'.repeat(32) },
  { ssid: 's'.repeat(32), password: '😀'.repeat(15), token: 't'.repeat(32) },
]) {
  test(`UTF-8 setup frames survive QR rendering and decoding (${Buffer.byteLength(input.password)} password bytes)`, () => {
    const { codes } = buildQrCodes(input);
    const scanned = codes.map(code => {
      const result = decode(code);
      assert.ok(result, 'QR image can be read');
      assert.equal(result.data, code, 'UTF-8 survives the actual encoder and image decoder');
      return result.data;
    });
    const decoded = robotDecode(scanned.reverse());
    assert.equal(decoded.ssid, input.ssid);
    assert.equal(decoded.password, input.password);
    assert.equal(decoded.token, input.token);
  });
}
