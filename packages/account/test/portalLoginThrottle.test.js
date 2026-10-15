// Console auth throttling behind the public edge.
//
// The account service listens on loopback behind nginx (deploy/nginx/phoenix.conf), which rewrites
// X-Forwarded-For / X-Real-IP with the direct client address; a CDN in front is configured as a
// trusted real-IP source there (docs/DEPLOYMENT.md). The throttle maintains a separate bucket
// for each client address supplied by the trusted proxy and a higher per-email ceiling.
// Requests from other peers use the socket address.
//
// These tests drive the real service over HTTP from loopback (the trusted proxy address), using
// forwarding headers the way the shipped nginx does, and one unit set on the resolver itself.
// The attempt counts derive from the implementation's exported limits.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-login-throttle-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { Store } = await import('../src/store.js');
const { createOwnerAccount } = await import('../src/model.js');
const { createAccountService } = await import('../src/index.js');
const { hashAccountPassword } = await import('../src/accountIdentity.js');
import * as portalApi from '../src/portalApi.js';

// The limits are read from the module so this file cannot drift from them. The fallbacks only
// matter on a tree that predates the exports (where the guard test below fails loudly).
const AUTH_LIMIT = portalApi.PORTAL_AUTH_LIMIT ?? 10;
const EMAIL_LIMIT = portalApi.PORTAL_AUTH_EMAIL_LIMIT ?? 30;

let server; let base; let store;

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  const service = createAccountService({ store });
  await new Promise((resolve) => service.server.listen(0, resolve));
  server = service.server;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

/** A kept account with a fast-compare (source-format) password; the tests only fail logins. */
function account(email) {
  const owner = createOwnerAccount(store, { email, password: 'placeholder', firstName: 'Throttle' });
  owner.password = hashAccountPassword('Fixture-pass-1');
  store.flush();
  return email;
}

async function attempt(email, { forwarded, headers = {} } = {}) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }),
      ...headers,
    },
    body: JSON.stringify({ email, password: 'not-the-password' }),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

// --- the throttle keys -----------------------------------------------------------------------

test('the throttle limits are exported so tests derive from the implementation', () => {
  assert.equal(typeof portalApi.PORTAL_AUTH_LIMIT, 'number');
  assert.equal(typeof portalApi.PORTAL_AUTH_EMAIL_LIMIT, 'number');
  assert.ok(EMAIL_LIMIT > AUTH_LIMIT, 'the per-email ceiling is separate and higher');
});

test('two forwarded clients behind the trusted loopback proxy get separate buckets', async () => {
  const email = account('throttle-separate@fixture.test');
  for (let i = 0; i < AUTH_LIMIT; i++) {
    assert.equal((await attempt(email, { forwarded: '203.0.113.10' })).status, 401, `client one failure ${i}`);
  }
  const limited = await attempt(email, { forwarded: '203.0.113.10' });
  assert.equal(limited.status, 429, 'the failing client is limited once its own bucket is spent');
  assert.ok(Number(limited.retryAfter) > 0, 'the refusal says when to retry');
  assert.equal((await attempt(email, { forwarded: '203.0.113.11' })).status, 401,
    'a different client address is not limited by the first client');
});

test('the per-email ceiling still trips when attempts come from many addresses', async () => {
  assert.equal(EMAIL_LIMIT % AUTH_LIMIT, 0, 'fixture assumes whole client buckets reach the ceiling exactly');
  const email = account('throttle-ceiling@fixture.test');
  const buckets = EMAIL_LIMIT / AUTH_LIMIT;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const address = `198.51.100.${bucket + 1}`;
    for (let i = 0; i < AUTH_LIMIT; i++) {
      assert.equal((await attempt(email, { forwarded: address })).status, 401, `${address} failure ${i}`);
    }
  }
  assert.equal((await attempt(email, { forwarded: '198.51.100.200' })).status, 429,
    'a fresh address is refused once the account ceiling is reached');
});

test('forwarding headers from an untrusted peer do not choose the throttle bucket', async () => {
  const email = account('throttle-untrusted@fixture.test');
  // A deliberately different trusted set: loopback is no longer a trusted proxy here, so the
  // headers must be ignored for these requests.
  process.env.PHOENIX_TRUSTED_PROXIES = '192.0.2.10';
  try {
    for (let i = 0; i < AUTH_LIMIT; i++) {
      assert.equal((await attempt(email, { forwarded: '198.51.100.71' })).status, 401, `failure ${i}`);
    }
    assert.equal((await attempt(email, { forwarded: '198.51.100.72' })).status, 429,
      'the peer address still keys the bucket when the headers change');
    assert.equal((await attempt(email, { forwarded: '198.51.100.73' })).status, 429,
      'a further header change is still the same client');
  } finally {
    delete process.env.PHOENIX_TRUSTED_PROXIES;
  }
});

// --- the resolver (unit) ----------------------------------------------------------------------

test('clientAddress accepts forwarding headers only from a trusted proxy peer', async () => {
  const { clientAddress } = await import('../src/portal/clientAddress.js');
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

  assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientAddress(req('::1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientAddress(req('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9',
    'an IPv4-mapped loopback peer is the same trusted proxy');

  // An untrusted peer never supplies its own address, whatever headers it sends.
  const spoofed = req('198.51.100.5', {
    'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.44', 'cf-connecting-ip': '203.0.113.45',
  });
  assert.equal(clientAddress(spoofed), '198.51.100.5');

  process.env.PHOENIX_TRUSTED_PROXIES = '127.0.0.1, 10.1.2.3';
  try {
    // Right-most untrusted entry wins: everything to its right was appended by trusted hops.
    const chain = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 10.1.2.3, 127.0.0.1' });
    assert.equal(clientAddress(chain), '203.0.113.9');
    // An all-trusted chain falls back to the single-value header, then to the peer.
    assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '10.1.2.3, 127.0.0.1', 'x-real-ip': '203.0.113.44' })), '203.0.113.44');
    assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '10.1.2.3, 127.0.0.1' })), '127.0.0.1');
    // Entries that are not addresses never become one.
    assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': 'not-an-address, 127.0.0.1' })), '127.0.0.1');
  } finally {
    delete process.env.PHOENIX_TRUSTED_PROXIES;
  }
});

test('CF-Connecting-IP is honoured only when the deployment opts in', async () => {
  const { clientAddress } = await import('../src/portal/clientAddress.js');
  const proxied = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '203.0.113.78' },
  };
  assert.equal(clientAddress(proxied), '203.0.113.78', 'without the option the forwarded chain decides');
  process.env.PHOENIX_TRUST_CF_CONNECTING_IP = '1';
  try {
    assert.equal(clientAddress(proxied), '203.0.113.77', "with the option Cloudflare's header wins from a trusted peer");
    const direct = { socket: { remoteAddress: '198.51.100.5' }, headers: { 'cf-connecting-ip': '203.0.113.77' } };
    assert.equal(clientAddress(direct), '198.51.100.5', 'an untrusted peer never supplies CF-Connecting-IP');
  } finally {
    delete process.env.PHOENIX_TRUST_CF_CONNECTING_IP;
  }
});
