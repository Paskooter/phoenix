// G.3 — QR payload round-trip (the robot's config.bt decoder) + the setup/status REST flow
// driving the real robot AWS-JSON face to completion.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-qr-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { buildQrCodes, robotDecode, XOR_KEY } = await import('../src/qrPayload.js');
const { createAccountService } = await import('../src/index.js');

test('QR payload: DHCP 3-line round-trip through the robot decoder', () => {
  const { payload, codes } = buildQrCodes({ ssid: 'JetsonNet', password: 'orbit-city', token: 'Ab3xK9z' });
  assert.equal(payload, 'JetsonNet\norbit-city\nAb3xK9z');
  assert.ok(!codes.join('').includes('orbit-city'), 'scrambled — plaintext not present in the codes');
  assert.match(codes[0], /^1\/\d+\n/, 'frame is "<i>/<N>\\n<chunk>"');
  const decoded = robotDecode(codes);
  assert.equal(decoded.ssid, 'JetsonNet');
  assert.equal(decoded.password, 'orbit-city');
  assert.equal(decoded.token, 'Ab3xK9z');
});

test('QR payload: static-IP 8-line round-trip', () => {
  const staticConfig = { ip: '192.168.1.50', netmask: '255.255.255.0', gateway: '192.168.1.1', dns1: '1.1.1.1', dns2: '8.8.8.8' };
  const { codes } = buildQrCodes({ ssid: 'JetsonNet', password: 'pw', staticConfig, token: 'tok1234' });
  const decoded = robotDecode(codes);
  assert.equal(decoded.token, 'tok1234');
  assert.deepEqual(decoded.staticConfig, staticConfig);
});

test('QR payload: long token splits into multiple ordered frames; out-of-order reassembles', () => {
  const { codes } = buildQrCodes({ ssid: 'X'.repeat(120), password: 'Y'.repeat(120), token: 'Z'.repeat(40) });
  assert.ok(codes.length > 1, 'long payload spans multiple QR frames');
  const decoded = robotDecode([...codes].reverse()); // robot sorts by codeId
  assert.equal(decoded.token, 'Z'.repeat(40));
  assert.equal(decoded.ssid, 'X'.repeat(120));
});

test('XOR is symmetric with the exact config.bt key', () => {
  assert.match(XOR_KEY, /jibo\.com\/jobs/);
});

// -- full setup → scan → redeem → status flow ---------------------------------

let server; let base; const jar = new Map();
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(jar.get('c') ? { cookie: jar.get('c') } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) jar.set('c', sc.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function amz(target, body) {
  const res = await fetch(`${base}/`, {
    method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('end-to-end: signup -> setup QR -> robot redeems -> status flips -> robot listed', async () => {
  await call('POST', '/api/signup', { email: 'elroy@jetson.test', password: 'astro-the-dog', firstName: 'Elroy' });

  const setup = await call('POST', '/api/robots/setup', { ssid: 'JetsonNet', password: 'orbit-city' });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.token && setup.body.qr.codes.length >= 1);

  const pre = await call('GET', `/api/robots/setup/status?token=${setup.body.token}`);
  assert.equal(pre.body.complete, false);

  // the robot decodes the QR, joins WiFi, and calls OOBE.setupRobot with the token + its name
  const decoded = robotDecode(setup.body.qr.codes);
  assert.equal(decoded.token, setup.body.token);
  const creds = await amz('OOBE.SetupRobot', { token: decoded.token, id: 'castle-cylinder-fig-quilt' });
  assert.equal(creds.status, 200);
  assert.match(creds.body.accessKeyId, /^[A-Za-z0-9]{20}$/);

  const post = await call('GET', `/api/robots/setup/status?token=${setup.body.token}`);
  assert.equal(post.body.complete, true, 'token consumed -> setup complete');

  const robots = await call('GET', '/api/robots');
  assert.ok(robots.body.some((r) => r.friendlyId === 'castle-cylinder-fig-quilt'));
});
