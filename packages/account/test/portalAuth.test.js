// G.1 — store persistence, password hashing, sessions, portal/admin auth over the wire.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-account-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
// No ADMIN_PASSWORD: administrator access is a flag on the account, not a shared
// secret, so the admin face is exercised by promoting an ordinary account below.

const { Store } = await import('../src/store.js');
const { fillAccessKeys, hashPassword, verifyPassword, createOwnerAccount, createLoop, mintSetupToken, takeValidToken, ACCESS_TOKEN_LIFETIME_MS } = await import('../src/model.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let store;
const jars = new Map(); // name -> cookie

async function call(method, path, body, jar = 'default') {
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
  // An explicit store, so a test can promote an account to administrator the way
  // scripts/portal-grant-admin.mjs does.
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('fillAccessKeys: 20/40 alnum (reference account.ts shape)', () => {
  const { accessKeyId, secretAccessKey } = fillAccessKeys();
  assert.match(accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(secretAccessKey, /^[A-Za-z0-9]{40}$/);
});

test('scrypt password hashing round-trips and rejects wrong passwords', () => {
  const stored = hashPassword('hunter22');
  assert.ok(verifyPassword('hunter22', stored));
  assert.ok(!verifyPassword('hunter23', stored));
  assert.ok(!verifyPassword('hunter22', 'plaintext'));
});

test('signup -> me -> logout -> me (session lifecycle over the wire)', async () => {
  const r1 = await call('POST', '/api/signup', { email: 'george@jetson.test', password: 'spacely-sprockets', firstName: 'George' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.account.email, 'george@jetson.test');
  assert.ok(!JSON.stringify(r1.body).includes('password'), 'password never leaves the server');

  const me = await call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.account.firstName, 'George');

  await call('POST', '/api/logout');
  const after2 = await call('GET', '/api/me');
  assert.equal(after2.status, 401);
});

test('login: wrong password 401, right password 200; duplicate signup 409', async () => {
  const bad = await call('POST', '/api/login', { email: 'george@jetson.test', password: 'nope-nope-nope' }, 'j2');
  assert.equal(bad.status, 401);
  const good = await call('POST', '/api/login', { email: 'george@jetson.test', password: 'spacely-sprockets' }, 'j2');
  assert.equal(good.status, 200);
  const dup = await call('POST', '/api/signup', { email: 'george@jetson.test', password: 'whatever-else' }, 'j3');
  assert.equal(dup.status, 409);
});

test('admin: only an administrator ACCOUNT reaches the admin face; adopt returns credentials.json', async () => {
  // Signed out: 401, "sign in".
  const anon = await call('GET', '/api/admin/robots', null, 'admin');
  assert.equal(anon.status, 401);

  // Signed in as an ordinary account: 403, not another sign-in prompt. Telling a
  // signed-in user to sign in again would be a lie.
  const asUser = await call('GET', '/api/admin/robots', null, 'j2');
  assert.equal(asUser.status, 403);
  assert.match(asUser.body.error, /not an administrator/);

  // The shared-password endpoint is gone, so no password can unlock anything.
  const gone = await call('POST', '/api/admin/login', { password: 'test-admin-pass' }, 'admin');
  assert.ok(gone.status === 404 || gone.status === 405, `admin password login is gone (got ${gone.status})`);

  // Promote the account exactly as scripts/portal-grant-admin.mjs does, and the
  // SAME session now has access — no second login, no separate credential.
  store.accountByEmail('george@jetson.test').isAdmin = true;
  store.flush();

  const me = await call('GET', '/api/admin/me', null, 'j2');
  assert.equal(me.status, 200);
  assert.equal(me.body.admin, true);
  assert.equal(me.body.account.email, 'george@jetson.test');

  // The console decides what to show from this flag on the ordinary session
  // projection, so it must be present there and nowhere else.
  const meAfter = await call('GET', '/api/me', null, 'j2');
  assert.equal(meAfter.body.account.isAdmin, true);
  assert.ok(!JSON.stringify(meAfter.body).includes('password'), 'still no password material');

  const adopt = await call('POST', '/api/admin/adopt', { friendlyId: 'castle-cylinder-fig-quilt' }, 'j2');
  assert.equal(adopt.status, 200);
  assert.match(adopt.body.credentialsJson.accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(adopt.body.credentialsJson.secretAccessKey, /^[A-Za-z0-9]{40}$/);
  assert.equal(adopt.body.robot.friendlyId, 'castle-cylinder-fig-quilt');

  const robots = await call('GET', '/api/admin/robots', null, 'j2');
  assert.equal(robots.status, 200);
  assert.ok(robots.body.some((r) => r.friendlyId === 'castle-cylinder-fig-quilt'));
  assert.ok(!JSON.stringify(robots.body).includes(adopt.body.secretAccessKey), 'secret only shown at adoption');

  // adopting the same robot again reuses the account/loop (idempotent), keys unchanged
  const again = await call('POST', '/api/admin/adopt', { friendlyId: 'castle-cylinder-fig-quilt' }, 'j2');
  assert.equal(again.body.credentialsJson.accessKeyId, adopt.body.credentialsJson.accessKeyId);

  // Revoking takes access away from the live session immediately: the flag is
  // read per request, so there is no stale admin session to wait out.
  store.accountByEmail('george@jetson.test').isAdmin = false;
  store.flush();
  const revoked = await call('GET', '/api/admin/robots', null, 'j2');
  assert.equal(revoked.status, 403);
});

test('owner /api/robots: 401 anonymous; owner sees only their loops', async () => {
  const anon = await call('GET', '/api/robots', null, 'fresh');
  assert.equal(anon.status, 401);
  const mine = await call('GET', '/api/robots', null, 'j2'); // george, owns nothing
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, []);
});

test('store persists across instances (robot creds survive restart)', () => {
  const file = join(dir, 'p.json');
  const s1 = new Store(file);
  const owner = createOwnerAccount(s1, { email: 'jane@jetson.test', password: 'orbit-city-4ever' });
  const { robot } = createLoop(s1, { owner, robotId: 'rosie-robot-maid-xj9' });
  const s2 = new Store(file);
  assert.equal(s2.accountByFriendlyId('rosie-robot-maid-xj9').accessKeyId, robot.accessKeyId);
  assert.ok(readFileSync(file, 'utf8').includes('rosie-robot-maid-xj9'));
});

test('setup tokens: 15-minute TTL; expiry rejects without deleting (reference findById)', () => {
  const s = new Store(join(dir, 't.json'));
  const owner = createOwnerAccount(s, { email: 'judy@jetson.test', password: 'teenage-dreams' });
  const t = mintSetupToken(s, owner._id);
  assert.ok(takeValidToken(s, t._id), 'fresh token is valid');
  assert.equal(mintSetupToken(s, owner._id)._id, t._id, 'live token reused for same account+loop');
  s.tokens.get(t._id).created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1000;
  assert.equal(takeValidToken(s, t._id), null, 'expired token rejected');
  assert.ok(s.tokens.has(t._id), 'expiry does not delete (token.ctrl.ts findById)');
});
