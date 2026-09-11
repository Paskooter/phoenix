// A-05 criterion 2 — QR payload framing against the original robot consumer.
//
// Contract source (Jibo archive MCP):
//   gitea_read_file skills/oobe-config src/behaviors/oobe/config.bt
//     ReadBarcode / onBarcode:
//       var metaEnd = barcode.indexOf("\n");
//       var metaData = barcode.substring(0, metaEnd).split("/");
//       var codeId = parseInt(metaData[0]);
//       notepad.totalCodes = parseInt(metaData[1]);
//       notepad.qrData[codeId - 1] = barcode.substring(metaEnd + 1);
//     Parse QR data:
//       for(...) barcode += notepad.qrData[i];
//       var aKey = 'Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.';
//       barcode = xorString(barcode, aKey);
//       let barcodeData = barcode.split("\n");
//       let _accessToken = barcodeData.pop();
//       let [_ssid, _password, _staticIP, _netmask, _gateway, _dns1, _dns2] = barcodeData;
//
// packages/account/src/qrPayload.js is the encoder half; robotDecode reimplements the decoder
// half. This file pins the framing the robot's parser depends on, so an encoder change that
// silently breaks the real decoder fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQrCodes, buildPlaintext, robotDecode, XOR_KEY, xorScramble } from '../src/qrPayload.js';

/** The robot's own frame parse, reimplemented from config.bt (ReadBarcode/onBarcode). */
function robotParseFrames(frames) {
  const data = [];
  let total = null;
  for (const barcode of frames) {
    const metaEnd = barcode.indexOf('\n');
    const metaData = barcode.substring(0, metaEnd).split('/');
    const codeId = parseInt(metaData[0]);
    total = parseInt(metaData[1]);
    data[codeId - 1] = barcode.substring(metaEnd + 1);
  }
  return { data, total };
}

test('every QR frame is "<codeId>/<totalCodes>\\n<chunk>" with a 1-based codeId', () => {
  const { codes } = buildQrCodes({ ssid: 'JetsonNet', password: 'orbit-city', token: 'Ab3xK9z' });
  const { data, total } = robotParseFrames(codes);
  assert.equal(total, codes.length, 'totalCodes matches the frame count');
  assert.equal(data.length, codes.length, 'every frame lands on its own codeId-1 slot');
  for (const [i, frame] of codes.entries()) {
    // config.bt: the header is everything before the FIRST "\n", split on "/" and parseInt-ed.
    const nl = frame.indexOf('\n');
    assert.ok(nl > 0, `frame ${i} carries the "<id>/<total>\\n" header`);
    const parts = frame.substring(0, nl).split('/');
    assert.equal(parts.length, 2, 'the header is exactly "<codeId>/<totalCodes>"');
    assert.equal(parseInt(parts[0]), i + 1, 'codeId is 1-based');
    assert.equal(parseInt(parts[1]), codes.length);
    assert.equal(data[i], frame.substring(nl + 1), 'the chunk is everything after the first newline');
  }
});

test('the robot takes the chunk after the FIRST newline, so a scrambled \\n inside a chunk is harmless', () => {
  // XOR scrambling is not newline-safe: a chunk byte can decrypt-time-encode as 0x0A. config.bt
  // keys the header off the first "\n" only and takes substring(metaEnd + 1), so the parse keeps
  // the raw chunk intact. Pin that so an encoder change cannot start treating the first embedded
  // newline as a header terminator.
  const { data, total } = robotParseFrames(['1/1\nab\ncd']);
  assert.equal(total, 1);
  assert.equal(data[0], 'ab\ncd');
});

test('reassembly in codeId order reproduces the XOR plaintext, token last', () => {
  const opts = { ssid: 'X'.repeat(120), password: 'Y'.repeat(120), token: 'Z'.repeat(40) };
  const { payload, codes } = buildQrCodes(opts);
  assert.ok(codes.length > 1, 'a long payload spans several frames');

  const { data } = robotParseFrames(codes);
  const joined = data.join('');                        // config.bt: barcode += qrData[i]
  assert.equal(xorScramble(joined), payload, 'the concatenated chunks XOR back to the plaintext');

  const lines = xorScramble(joined).split('\n');
  assert.equal(lines.pop(), 'Z'.repeat(40), 'the token is the LAST line the robot .pop()s');
  assert.equal(lines.length, 2, 'DHCP payload keeps ssid/password only');
});

test('the XOR key is the exact config.bt literal', () => {
  assert.equal(XOR_KEY, 'Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.');
  // Symmetric: the robot decrypts with the same routine.
  assert.equal(xorScramble(xorScramble('hello')), 'hello');
});

test('static network fields travel in the robot destructure order ip,netmask,gateway,dns1,dns2', () => {
  const staticConfig = { ip: '192.168.1.50', netmask: '255.255.255.0', gateway: '192.168.1.1', dns1: '1.1.1.1', dns2: '8.8.8.8' };
  const { payload, codes } = buildQrCodes({ ssid: 'JetsonNet', password: 'pw', staticConfig, token: 'tok1234' });
  const lines = payload.split('\n');
  assert.deepEqual(lines, ['JetsonNet', 'pw', '192.168.1.50', '255.255.255.0', '192.168.1.1', '1.1.1.1', '8.8.8.8', 'tok1234']);
  // The robot assigns positionally: _staticIP,_netmask,_gateway,_dns1,_dns2 (indices 2..6).
  assert.equal(lines[2], staticConfig.ip);
  assert.equal(lines[3], staticConfig.netmask);
  assert.equal(lines[4], staticConfig.gateway);
  assert.equal(lines[5], staticConfig.dns1);
  assert.equal(lines[6], staticConfig.dns2);

  // And the robot-decode half recovers the same values from the wire frames.
  const decoded = robotDecode(codes);
  assert.equal(decoded.token, 'tok1234');
  assert.deepEqual(decoded.staticConfig, staticConfig);
});

test('omitted dns fields travel as empty strings; the robot applies its own 8.8.8.8/8.8.4.4 defaults', () => {
  // config.bt: dns1: (_dns1 ? _dns1 : "8.8.8.8"), dns2: (_dns2 ? _dns2 : "8.8.4.4").
  // The encoder therefore leaves them empty rather than inventing values; document that here so
  // the empty-string wire form is a deliberate, pinned contract and not mistaken for a bug.
  const staticConfig = { ip: '10.0.0.5', netmask: '255.255.255.0', gateway: '10.0.0.1' };
  const { codes } = buildQrCodes({ ssid: 'S', password: 'p', staticConfig, token: 't' });
  const decoded = robotDecode(codes);
  assert.equal(decoded.staticConfig.dns1, '', 'empty dns1 lets the robot default to 8.8.8.8');
  assert.equal(decoded.staticConfig.dns2, '', 'empty dns2 lets the robot default to 8.8.4.4');
  assert.equal(decoded.staticConfig.ip, '10.0.0.5');
});

test('buildPlaintext rejects a newline inside a field (it would silently split the robot payload)', () => {
  assert.throws(() => buildPlaintext({ ssid: 'bad\nssid', password: 'p', token: 't' }), /newlines/);
  assert.throws(() => buildPlaintext({ ssid: 's', password: 'p', token: 'bad\ntoken' }), /newlines/);
});
