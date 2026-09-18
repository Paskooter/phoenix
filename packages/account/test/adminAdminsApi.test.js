// Granting and revoking administrator access from the console, and the two
// guards that stop an instance being left with nobody who can get back in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-admin-ops-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let store;
const jars = new Map();

async function call(method, path, body, jar = 'boss') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;

  await call('POST', '/api/signup', { email: 'boss@example.com', password: 'correct-horse-1' }, 'boss');
  await call('POST', '/api/signup', { email: 'second@example.com', password: 'correct-horse-2' }, 'second');
  await call('POST', '/api/signup', { email: 'plain@example.com', password: 'correct-horse-3' }, 'plain');

  store.accountByEmail('boss@example.com').isAdmin = true;
  store.flush();
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('listing accounts needs administrator access', async () => {
  assert.equal((await call('GET', '/api/admin/admins', null, 'nobody')).status, 401);
  assert.equal((await call('GET', '/api/admin/admins', null, 'plain')).status, 403);

  const ok = await call('GET', '/api/admin/admins');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accounts.length, 3);
  assert.equal(ok.body.adminCount, 1);
});

test('the listing carries identity only, never credentials', async () => {
  const { accounts } = (await call('GET', '/api/admin/admins')).body;
  for (const a of accounts) {
    assert.deepEqual(
      Object.keys(a).sort(),
      ['created', 'email', 'firstName', 'id', 'isActive', 'isAdmin', 'lastName'],
    );
  }
});

test('granting makes the flag real, and the promoted account can use the surface', async () => {
  const before = await call('GET', '/api/admin/config', null, 'second');
  assert.equal(before.status, 403);

  const res = await call('POST', '/api/admin/admins', { email: 'second@example.com', grant: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, true);
  assert.equal(res.body.account.isAdmin, true);
  assert.equal(store.accountByEmail('second@example.com').isAdmin, true);

  // Read per request, so it applies immediately to the session already open.
  assert.equal((await call('GET', '/api/admin/config', null, 'second')).status, 200);
});

test('granting twice is a no-op rather than an error', async () => {
  const res = await call('POST', '/api/admin/admins', { email: 'second@example.com', grant: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, false);
});

test('an administrator cannot revoke their own access from the console', async () => {
  const res = await call('POST', '/api/admin/admins', { email: 'boss@example.com', grant: false });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /your own/);
  assert.equal(store.accountByEmail('boss@example.com').isAdmin, true);
});

test('revoking someone else works, and takes effect on their open session', async () => {
  const res = await call('POST', '/api/admin/admins', { email: 'second@example.com', grant: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, true);
  assert.equal((await call('GET', '/api/admin/config', null, 'second')).status, 403);
});

test('the last administrator cannot be removed, leaving nobody able to get in', async () => {
  // boss is the only administrator again. Promote second, then have second try
  // to revoke boss — allowed — but boss revoking the last one is not.
  await call('POST', '/api/admin/admins', { email: 'second@example.com', grant: true });
  const viaSecond = await call('POST', '/api/admin/admins', { email: 'boss@example.com', grant: false }, 'second');
  assert.equal(viaSecond.status, 200, 'another administrator may revoke a peer');

  // Now `second` is the only one left, and cannot remove itself either way.
  const self = await call('POST', '/api/admin/admins', { email: 'second@example.com', grant: false }, 'second');
  assert.equal(self.status, 400);
  assert.equal(store.accountByEmail('second@example.com').isAdmin, true);
});

test('an unknown address is a 404, not a silent success', async () => {
  const res = await call('POST', '/api/admin/admins', { email: 'nobody@example.com', grant: true }, 'second');
  assert.equal(res.status, 404);
});
