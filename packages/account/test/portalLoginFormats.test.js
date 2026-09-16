// The portal must authenticate BOTH password encodings.
//
// Found live: the owner could not log into the portal with the email and
// password they use on the phone. Not a typo and not a UI problem — their
// account came from the restored original household, so its password is stored
// in the source encoding `sha512$512$10000$<salt>$<hash>` (utils/password.ts
// pbkdf2), while the portal's login route called model.js `verifyPassword`,
// which returns false for anything not prefixed `scrypt:`. The real account
// could never authenticate, no matter what was typed.
//
// compareAccountPassword is the source-shaped comparison and already handled
// both. These tests pin the login, change-password and change-email routes to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, createAccountService } from '../src/index.js';
import { hashAccountPassword } from '../src/accountIdentity.js';
import { hashPassword, createOwnerAccount } from '../src/model.js';

function service() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-login-'));
  const store = new Store(join(dir, 'account.json'));
  const svc = createAccountService({ store });
  return { store, svc };
}

async function listen(svc) {
  await new Promise((resolve) => svc.server.listen(0, resolve));
  return svc.server.address().port;
}

async function login(port, email, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, cookie: Boolean(res.headers.get('set-cookie')) };
}

test('portal login accepts the SOURCE pbkdf2 encoding an imported household carries', async () => {
  const { store, svc } = service();
  // Exactly the shape of the owner's restored record.
  const account = createOwnerAccount(store, { email: 'restored@example.com', password: 'placeholder', firstName: 'R' });
  account.password = hashAccountPassword('the-phone-password');
  store.flush();
  assert.ok(account.password.startsWith('sha512$'), 'fixture must use the source encoding');

  const port = await listen(svc);
  try {
    assert.deepEqual(await login(port, 'restored@example.com', 'the-phone-password'), { status: 200, cookie: true });
    assert.deepEqual(await login(port, 'restored@example.com', 'wrong'), { status: 401, cookie: false });
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
});

test('portal login still accepts a portal-created scrypt account', async () => {
  const { store, svc } = service();
  const account = createOwnerAccount(store, { email: 'portal@example.com', password: 'placeholder', firstName: 'P' });
  account.password = hashPassword('portal-password');
  store.flush();
  assert.ok(account.password.startsWith('scrypt:'), 'fixture must use the portal encoding');

  const port = await listen(svc);
  try {
    assert.deepEqual(await login(port, 'portal@example.com', 'portal-password'), { status: 200, cookie: true });
    assert.deepEqual(await login(port, 'portal@example.com', 'wrong'), { status: 401, cookie: false });
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
});

test('change-password and change-email verify the current password in either encoding', async () => {
  const { store, svc } = service();
  const account = createOwnerAccount(store, { email: 'both@example.com', password: 'placeholder', firstName: 'B' });
  account.password = hashAccountPassword('original-format');
  store.flush();

  const port = await listen(svc);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'both@example.com', password: 'original-format' }),
    });
    assert.equal(res.status, 200);
    const cookie = String(res.headers.get('set-cookie')).split(';')[0];
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const wrong = await post('/api/me/password', { currentPassword: 'nope', newPassword: 'a-new-password' });
    assert.equal(wrong.status, 401, 'a wrong current password must be refused');

    const ok = await post('/api/me/password', { currentPassword: 'original-format', newPassword: 'a-new-password' });
    assert.equal(ok.status, 200, 'the source encoding must satisfy the current-password check');

    assert.deepEqual(await login(port, 'both@example.com', 'a-new-password'), { status: 200, cookie: true });
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
});
