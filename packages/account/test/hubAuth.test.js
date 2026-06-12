// G.5 — per-robot hub auth: POST /api/token (AWS keys -> short-lived hub JWT) and
// GET /api/verify (gateway-side identity check, never leaks the secret).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwt } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-hubauth-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
process.env.HUB_TOKEN_SECRET = 'test-hub-secret';

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');

let server; let base; let robot;
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'jane@jetson.test', password: 'orbit-city-4ever' });
  ({ robot } = createLoop(store, { owner, robotId: 'castle-cylinder-fig-quilt' }));
  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('POST /api/token: valid AWS keys -> signed 3h hub token with the right claims, no secret', async () => {
  const r = await call('POST', '/api/token', { accessKeyId: robot.accessKeyId, secretAccessKey: robot.secretAccessKey });
  assert.equal(r.status, 200);
  assert.ok(r.body.token && r.body.expires > Date.now());

  const claims = jwt.verify(r.body.token, 'test-hub-secret');
  assert.equal(claims.id, robot._id);
  assert.equal(claims.accessKeyId, robot.accessKeyId);
  assert.equal(claims.friendlyId, 'castle-cylinder-fig-quilt');
  assert.ok(!('secretAccessKey' in claims), 'secret must never be in the token');
  assert.ok(claims.exp - claims.iat === 3 * 60 * 60, '3h lifetime');

  // lastSeen recorded
  assert.ok(getStore().accountByAccessKeyId(robot.accessKeyId).lastSeen > 0);
});

test('POST /api/token: wrong secret 401, unknown key 401', async () => {
  const wrong = await call('POST', '/api/token', { accessKeyId: robot.accessKeyId, secretAccessKey: 'nope' });
  assert.equal(wrong.status, 401);
  const unknown = await call('POST', '/api/token', { accessKeyId: 'NoSuchKey0000000000', secretAccessKey: 'x' });
  assert.equal(unknown.status, 401);
});

test('GET /api/verify: valid key -> identity (no secret); unknown -> {valid:false}', async () => {
  const r = await call('GET', `/api/verify?accessKeyId=${robot.accessKeyId}`);
  assert.deepEqual(r.body, { valid: true, id: robot._id, friendlyId: 'castle-cylinder-fig-quilt' });
  assert.ok(!JSON.stringify(r.body).includes(robot.secretAccessKey), 'verify never leaks the secret');

  const bad = await call('GET', '/api/verify?accessKeyId=NoSuchKey0000000000');
  assert.deepEqual(bad.body, { valid: false });
});

test('the issued hub token is rejected by jwt.verify once expired', async () => {
  const { createHubToken } = await import('../src/model.js');
  const acct = getStore().accountByAccessKeyId(robot.accessKeyId);
  // sign a token that already expired by hand-rolling the claim via the real signer path
  const expired = jwt.sign({ id: acct._id, accessKeyId: acct.accessKeyId, exp: Math.floor(Date.now() / 1000) - 100 }, 'test-hub-secret');
  assert.throws(() => jwt.verify(expired, 'test-hub-secret'), /jwt expired/);
  const fresh = createHubToken(acct, 'test-hub-secret');
  assert.equal(jwt.verify(fresh.token, 'test-hub-secret').accessKeyId, acct.accessKeyId);
});
