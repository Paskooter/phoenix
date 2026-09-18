// W3 sockcert — the region an adopted robot is told to use.
//
// A robot builds `<region>.jibo.com` and `<region>-socket.jibo.com` from this value
// and verifies them against the serving certificate, which scripts/ensure-tls-certs.mjs
// issues for PHOENIX_TLS_REGIONS (default 'api'). The adopt endpoint must therefore
// default to the same region as the certificate, not the historical 'phx' placeholder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-w3-region-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
delete process.env.ETCO_account_region;

const { accountRegion, DEFAULT_ACCOUNT_REGION } = await import('../src/portalApi.js');
const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let cookie; let store;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;
  // The admin face follows the signed-in account now, so sign up and promote —
  // exactly what scripts/portal-grant-admin.mjs does. No shared password.
  const signup = await call('POST', '/api/signup', { email: 'w3@region.test', password: 'w3-region-pass' });
  assert.equal(signup.status, 200);
  store.accountByEmail('w3@region.test').isAdmin = true;
  store.flush();
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('accountRegion falls back to api, never phx, and an explicit region wins', () => {
  assert.equal(DEFAULT_ACCOUNT_REGION, 'api');
  assert.equal(accountRegion({}), 'api');
  assert.equal(accountRegion({ ETCO_account_region: '' }), 'api');
  assert.equal(accountRegion({ ETCO_account_region: 'eu-west-1' }), 'eu-west-1');
  assert.notEqual(accountRegion({}), 'phx', 'phx is a historical placeholder, not a region');
});

test('POST /api/admin/adopt writes the cert-backed region into credentials.json', async () => {
  const adopted = await call('POST', '/api/admin/adopt', { friendlyId: 'w3-default-region-robot' });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.credentialsJson.region, 'api',
    'the default must match the certificate ensure-tls-certs issues for PHOENIX_TLS_REGIONS=api');

  process.env.ETCO_account_region = 'eu-west-1';
  try {
    const overridden = await call('POST', '/api/admin/adopt', { friendlyId: 'w3-override-region-robot' });
    assert.equal(overridden.status, 200);
    assert.equal(overridden.body.credentialsJson.region, 'eu-west-1');
  } finally {
    delete process.env.ETCO_account_region;
  }
});
