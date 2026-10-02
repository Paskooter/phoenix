// Portal surface 3: account profile + password/email change over the same session cookie.
// Fixture account only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, verifyPassword } = await import('../src/model.js');
const { MemberPhotoStorage } = await import('../src/memberPhotoStorage.js');
const { updatePhoto } = await import('../src/accountIdentity.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-profile-'));
const store = new Store(join(dir, 'store.json'));
let server; let base;
let owner;
const mail = [];
const jars = new Map();

async function call(method, path, body, jar = 'owner') {
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
  owner = createOwnerAccount(store, { email: 'profile-owner@fixture.test', password: 'profile-pass-1', firstName: 'Guy' });
  server = await createAccountService({
    store,
    memberPhotoProvider: new MemberPhotoStorage({ directory: join(dir, 'photos'), publicBaseUrl: '/member-photos' }),
    identityProviders: {
      portalUrl: 'http://portal.fixture.test',
      emailReset: { send(to, options) { mail.push({ template: 'emailReset', to, options }); } },
      emailResetComplete: { send(to, options) { mail.push({ template: 'emailResetComplete', to, options }); } },
      passwordChanged: { send(to, options) { mail.push({ template: 'passwordChanged', to, options }); } },
    },
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await call('POST', '/api/login', { email: owner.email, password: 'profile-pass-1' }, 'owner');
  assert.equal(login.status, 200);
});

test('profile JPEG upload and removal are session-bound and serve the image MIME type', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 0x44), Buffer.from([0xff, 0xd9])]);
  const unauthenticated = await fetch(`${base}/api/me/photo`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg,
  });
  assert.equal(unauthenticated.status, 401);
  const invalid = await fetch(`${base}/api/me/photo`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg', cookie: jars.get('owner') }, body: Buffer.alloc(40, 0x44),
  });
  assert.equal(invalid.status, 400);
  const uploaded = await fetch(`${base}/api/me/photo`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg', cookie: jars.get('owner') }, body: jpeg,
  });
  assert.equal(uploaded.status, 200);
  const photoUrl = (await uploaded.json()).account.photoUrl;
  assert.match(photoUrl, /^\/member-photos\/[a-zA-Z0-9_-]+$/);
  const privateRead = await fetch(`${base}${photoUrl}`);
  assert.equal(privateRead.status, 401);
  const read = await fetch(`${base}${photoUrl}`, { headers: { cookie: jars.get('owner') } });
  assert.equal(read.status, 200);
  assert.match(read.headers.get('content-type'), /^image\/jpeg/);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), jpeg);
  const removed = await call('DELETE', '/api/me/photo');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.account.photoUrl, null);
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/me carries the fuller profile and source-compatible Jot alert preference', async () => {
  const r = await call('GET', '/api/me');
  assert.equal(r.status, 200);
  assert.ok('messagingAllowed' in r.body.account);
  assert.equal(r.body.account.jotNotificationMode, 'tagged');
  assert.equal(r.body.account.email, owner.email);
});

test('PUT /api/me updates profile fields and persists', async () => {
  const r = await call('PUT', '/api/me', {
    firstName: 'Guy', lastName: 'Fixtures', gender: 'other',
    birthday: 727286400000, phoneNumber: '+1-555-0100', messagingAllowed: false, jotNotificationMode: 'none',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.account.lastName, 'Fixtures');
  assert.equal(r.body.account.gender, 'other');
  assert.equal(r.body.account.birthday, 727286400000);
  assert.equal(r.body.account.messagingAllowed, false);
  assert.equal(r.body.account.jotNotificationMode, 'none');
  const stored = store.accounts.get(owner._id);
  assert.equal(stored.lastName, 'Fixtures');
  assert.equal(stored.messagingAllowed, false);
  assert.equal(stored.jotNotificationMode, 'none');
});

test('invalid profile values are rejected without mutating', async () => {
  const before = JSON.stringify(store.accounts.get(owner._id));
  const bad = await call('PUT', '/api/me', { gender: 'nonsense' });
  assert.equal(bad.status, 400);
  const badBirthday = await call('PUT', '/api/me', { birthday: 'not-a-ms' });
  assert.equal(badBirthday.status, 400);
  const badNotificationMode = await call('PUT', '/api/me', { jotNotificationMode: 'unrestricted' });
  assert.equal(badNotificationMode.status, 400);
  assert.equal(JSON.stringify(store.accounts.get(owner._id)), before);
});

test('a rejected profile update preserves all earlier fields in memory and on disk', async () => {
  const before = structuredClone(store.accounts.get(owner._id));
  for (const invalid of [{ lastName: 42 }, { gender: 'invalid' }, { birthday: 'invalid' },
    { phoneNumber: 42 }, { messagingAllowed: 'yes' }, { jotNotificationMode: 'invalid' }]) {
    const result = await call('PUT', '/api/me', { firstName: 'Rejected change', ...invalid });
    assert.equal(result.status, 400);
    assert.deepEqual(store.accounts.get(owner._id), before);
    assert.deepEqual(new Store(store.file).accounts.get(owner._id), before);
  }
});

test('a failed profile write does not leave an unsaved profile in memory', async () => {
  const before = structuredClone(store.accounts.get(owner._id));
  const flush = store.flush;
  store.flush = () => { throw new Error('fixture storage failure'); };
  try {
    const result = await call('PUT', '/api/me', { firstName: 'Unsaved change' });
    assert.equal(result.status, 500);
    assert.deepEqual(store.accounts.get(owner._id), before);
    assert.deepEqual(new Store(store.file).accounts.get(owner._id), before);
  } finally { store.flush = flush; }
});

test('a profile edit survives a photo upload that was already in progress', async () => {
  let finishUpload;
  const uploaded = new Promise((resolve) => { finishUpload = resolve; });
  const pending = updatePhoto(store, { ownerId: owner._id, photoProvider: {
    createPublic: () => uploaded,
    async remove() {},
  } });
  try {
    const result = await call('PUT', '/api/me', { firstName: 'Concurrent fixture' });
    assert.equal(result.status, 200);
  } finally {
    finishUpload({ url: 'https://photos.fixture.test/overlapping-upload' });
    await pending;
  }
  assert.equal(store.accounts.get(owner._id).firstName, 'Concurrent fixture');
  assert.equal(new Store(store.file).accounts.get(owner._id).firstName, 'Concurrent fixture');
});

test('change password: wrong current 401, success keeps the new credential', async () => {
  mail.length = 0;
  const wrong = await call('POST', '/api/me/password', { currentPassword: 'wrong-pass', newPassword: 'brand-new-pass-1' });
  assert.equal(wrong.status, 401);

  const ok = await call('POST', '/api/me/password', { currentPassword: 'profile-pass-1', newPassword: 'brand-new-pass-1' });
  assert.equal(ok.status, 200);
  assert.equal(verifyPassword('brand-new-pass-1', store.accounts.get(owner._id).password), true);
  assert.equal(mail.filter((entry) => entry.template === 'passwordChanged').length, 1);

  // old password no longer logs in, new one does
  const oldLogin = await call('POST', '/api/login', { email: owner.email, password: 'profile-pass-1' }, 'old');
  assert.equal(oldLogin.status, 401);
  const newLogin = await call('POST', '/api/login', { email: owner.email, password: 'brand-new-pass-1' }, 'fresh');
  assert.equal(newLogin.status, 200);
});

test('change email: wrong password 401, duplicate 409, then confirmation relinks login and invalidates sessions', async () => {
  mail.length = 0;
  const dup = createOwnerAccount(store, { email: 'taken@fixture.test', password: 'taken-pass-1' });
  void dup;
  const wrongPw = await call('POST', '/api/me/email', { currentPassword: 'nope', email: 'new@fixture.test' }, 'fresh');
  assert.equal(wrongPw.status, 401);
  const conflict = await call('POST', '/api/me/email', { currentPassword: 'brand-new-pass-1', email: 'taken@fixture.test' }, 'fresh');
  assert.equal(conflict.status, 409);
  const ok = await call('POST', '/api/me/email', { currentPassword: 'brand-new-pass-1', email: 'new@fixture.test' }, 'fresh');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pending, true);
  assert.equal(store.accounts.get(owner._id).email, 'profile-owner@fixture.test');
  const pending = [...store.emailResets.values()].find((row) => row.accountId === owner._id && row.email === 'new@fixture.test');
  assert.ok(pending);
  assert.equal(mail.filter((entry) => entry.template === 'emailReset').length, 1);
  const confirmed = await call('POST', '/api/me/email/confirm', { code: pending.code }, 'confirm');
  assert.equal(confirmed.status, 200);
  assert.equal(store.accounts.get(owner._id).email, 'new@fixture.test');
  assert.equal(mail.filter((entry) => entry.template === 'emailResetComplete').length, 1);
  const stale = await call('GET', '/api/me', undefined, 'fresh');
  assert.equal(stale.status, 401);
  const reLogin = await call('POST', '/api/login', { email: 'new@fixture.test', password: 'brand-new-pass-1' }, 'relogin');
  assert.equal(reLogin.status, 200);
});
