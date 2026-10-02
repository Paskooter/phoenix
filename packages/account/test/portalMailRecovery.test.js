// Portal email lifecycle: mailbox proof for sign-up and recovery. These tests
// keep all delivery in memory; SMTP itself has separate transport coverage.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createAccountService, Store } = await import('../src/index.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-mail-'));
const store = new Store(join(dir, 'store.json'));
const sent = [];
const jars = new Map();
let server; let base;
let now = Date.now();
const activationToken = (mail) => new URLSearchParams(new URL(mail.options.url).hash.slice(1)).get('token');

async function call(method, path, body, jar = 'default') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createAccountService({
    store,
    emailVerificationNow: () => now,
    invitationProviders: {
      portalUrl: 'http://portal.fixture.test',
      activation: { send(to, options) { sent.push({ template: 'activation', to, options }); } },
      passwordReset: { send(to, options) { sent.push({ template: 'passwordReset', to, options }); } },
    },
    identityProviders: {
      portalUrl: 'http://portal.fixture.test',
      passwordChanged: { send(to, options) { sent.push({ template: 'passwordChanged', to, options }); } },
    },
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('portal sign-up sends a one-time activation link and cannot sign in before mailbox proof', async () => {
  sent.length = 0;
  const signup = await call('POST', '/api/signup', {
    email: 'mail-owner@fixture.test', password: 'ValidPass1', firstName: 'Mail',
  });
  assert.equal(signup.status, 202);
  assert.equal(signup.body.verificationRequired, true);
  assert.equal(jars.has('default'), false, 'inactive accounts receive no session cookie');
  const account = store.accountByEmail('mail-owner@fixture.test');
  assert.equal(account.isActive, false);
  assert.match(activationToken(sent[0]), /^[0-9a-f]{64}$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template, 'activation');
  assert.equal(sent[0].to, account.email);
  assert.match(sent[0].options.url, /\/verify-email#token=/);

  const loginBefore = await call('POST', '/api/login', { email: account.email, password: 'ValidPass1' }, 'before');
  assert.equal(loginBefore.status, 401);

  const firstCode = activationToken(sent[0]);
  now += 60 * 1000;
  const resend = await call('POST', '/api/signup/resend', { email: account.email });
  assert.equal(resend.status, 202);
  const secondCode = activationToken(sent[1]);
  assert.notEqual(secondCode, firstCode, 'resend invalidates the earlier activation link');

  const verified = await call('POST', '/api/signup/verify', { code: secondCode });
  assert.equal(verified.status, 200);
  assert.equal(store.accounts.get(account._id).isActive, true);
  assert.equal(store.accounts.get(account._id).emailVerified, true);
  assert.equal(account.activationCode, undefined);
  const loginAfter = await call('POST', '/api/login', { email: account.email, password: 'ValidPass1' }, 'after');
  assert.equal(loginAfter.status, 200);
});

test('portal password recovery is non-enumerating, one-time, and invalidates prior sessions', async () => {
  sent.length = 0;
  const unknown = await call('POST', '/api/password/reset/request', { email: 'nobody@fixture.test' }, 'unknown');
  const known = await call('POST', '/api/password/reset/request', { email: 'mail-owner@fixture.test' }, 'known');
  assert.equal(unknown.status, 202);
  assert.equal(known.status, 202);
  const account = store.accountByEmail('mail-owner@fixture.test');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template, 'passwordReset');
  assert.match(sent[0].options.url, /\/reset\?email=.*&code=/);

  const oldSession = await call('GET', '/api/me', undefined, 'after');
  assert.equal(oldSession.status, 200);
  const reset = await call('POST', '/api/password/reset/confirm', {
    code: account.passwordResetCode,
    password: 'NewValidPass2',
  }, 'reset');
  assert.equal(reset.status, 200);
  assert.equal(account.passwordResetCode, undefined);
  assert.equal(sent.filter((entry) => entry.template === 'passwordChanged').length, 1);
  const stale = await call('GET', '/api/me', undefined, 'after');
  assert.equal(stale.status, 401);
  const oldLogin = await call('POST', '/api/login', { email: account.email, password: 'ValidPass1' }, 'old');
  assert.equal(oldLogin.status, 401);
  const newLogin = await call('POST', '/api/login', { email: account.email, password: 'NewValidPass2' }, 'new');
  assert.equal(newLogin.status, 200);
});
