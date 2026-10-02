import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createOwnerAccount } from '../src/model.js';
import { createAccountService } from '../src/index.js';
import {
  requestEmailVerification, confirmEmailVerification, isEmailVerified, emailVerificationStatus,
  EMAIL_VERIFICATION_TTL_MS, EMAIL_VERIFICATION_COOLDOWN_MS,
} from '../src/emailVerification.js';

const extractToken = (message) => new URLSearchParams(new URL(message.options.url).hash.slice(1)).get('token');

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-email-verification-'));
  const file = join(dir, 'store.json');
  const store = new Store(file);
  const sent = [];
  let now = Date.now();
  let failing = false;
  const mail = { async send(to, data) {
    if (failing) throw new Error('private SMTP diagnostics must never reach the browser');
    sent.push({ to, options: data });
  } };
  const context = { mail, portalUrl: 'https://portal.fixture.test' };
  const service = createAccountService({
    store,
    identityProviders: { emailVerification: options.noMail ? null : mail, portalUrl: context.portalUrl },
    emailVerificationNow: () => now,
    ...options.service,
  });
  const server = await service.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store, file, sent, base, context,
    advance: (ms) => { now += ms; },
    clock: () => now,
    failMail: () => { failing = true; },
    recoverMail: () => { failing = false; },
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, body: await response.json(), headers: response.headers, setCookie };
    },
  };
}

async function loginLegacy(f, email = 'existing@fixture.test') {
  const account = createOwnerAccount(f.store, { email, password: 'ValidPass1', firstName: 'Existing' });
  assert.equal((await f.call('POST', '/api/login', { email, password: 'ValidPass1' })).status, 200);
  return account;
}

test('signup delivers a hashed, expiring link; mailbox proof activates the account once', async (t) => {
  const f = await fixture(t);
  const signup = await f.call('POST', '/api/signup', { email: ' New@fixture.test ', password: 'ValidPass1' });
  assert.equal(signup.status, 202);
  assert.equal(signup.body.emailSent, true);
  assert.equal(signup.setCookie, null);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'new@fixture.test');
  const token = extractToken(f.sent[0]);
  assert.match(token, /^[a-f0-9]{64}$/);
  const url = new URL(f.sent[0].options.url);
  assert.equal(url.origin, 'https://portal.fixture.test');
  assert.equal(url.pathname, '/verify-email');
  assert.equal(url.search, '', 'the bearer token is never in server URLs');
  assert.equal(readFileSync(f.file, 'utf8').includes(token), false, 'the raw token is not persisted');
  const account = f.store.accountByEmail('new@fixture.test');
  assert.equal(isEmailVerified(account), false);
  assert.equal(account.isActive, false);
  assert.equal((await f.call('POST', '/api/login', { email: account.email, password: 'ValidPass1' })).status, 401);
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token })).status, 200);
  assert.equal(isEmailVerified(f.store.accounts.get(account._id)), true);
  assert.equal(f.store.accounts.get(account._id).isActive, true);
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token })).status, 400);
  const login = await f.call('POST', '/api/login', { email: account.email, password: 'ValidPass1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.account.emailVerified, true);
  assert.equal((await f.call('GET', '/api/me')).body.account.emailVerified, true);
});

test('an existing active account is unverified and can resend without losing its session', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('POST', '/api/me/email-verification/resend')).status, 401);
  const account = await loginLegacy(f);
  assert.equal((await f.call('GET', '/api/me')).body.account.emailVerified, false);
  const status = await f.call('GET', '/api/me/email-verification');
  assert.equal(status.body.available, true);
  const sent = await f.call('POST', '/api/me/email-verification/resend', { email: 'attacker@fixture.test', accountId: 'another-account' });
  assert.equal(sent.status, 200);
  assert.equal(f.sent[0].to, account.email, 'the session selects the recipient; caller input cannot redirect delivery');
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token: extractToken(f.sent[0]) })).status, 200);
  assert.equal((await f.call('GET', '/api/me')).body.account.emailVerified, true);
  assert.equal((await f.call('POST', '/api/me/email-verification/resend')).body.sent, false);
  assert.equal(f.sent.length, 1, 'verified accounts receive no additional mail');
});

test('resend cooldown survives a restart and rotating a link invalidates its predecessor', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  await f.call('POST', '/api/me/email-verification/resend');
  const firstToken = extractToken(f.sent[0]);
  const limited = await f.call('POST', '/api/me/email-verification/resend');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(f.sent.length, 1);
  const reopened = new Store(f.file);
  await assert.rejects(requestEmailVerification(reopened, reopened.accounts.get(account._id), { ...f.context, now: f.clock() }),
    (error) => error.statusCode === 429 && error.retryAfterSeconds === 60);
  f.advance(EMAIL_VERIFICATION_COOLDOWN_MS);
  await f.call('POST', '/api/me/email-verification/resend');
  assert.equal(f.sent.length, 2);
  const secondToken = extractToken(f.sent[1]);
  assert.notEqual(firstToken, secondToken);
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token: firstToken })).status, 400);
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token: secondToken })).status, 200);
});

test('five per hour and twenty per day bound delivery even when the minute cooldown has passed', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  const start = f.clock();
  const send = () => requestEmailVerification(f.store, account, { ...f.context, now: f.clock() });
  for (let hour = 0; hour < 4; hour += 1) {
    if (hour) f.advance(60 * 60 * 1000 - 5 * EMAIL_VERIFICATION_COOLDOWN_MS);
    for (let i = 0; i < 5; i += 1) {
      const delivery = await send();
      if (i === 4) assert.ok(delivery.retryAfterSeconds > 60, 'the UI countdown reflects the hourly/daily limit immediately');
      f.advance(EMAIL_VERIFICATION_COOLDOWN_MS);
    }
    await assert.rejects(send(), (error) => error.statusCode === 429);
  }
  assert.equal(f.sent.length, 20);
  f.advance(60 * 60 * 1000);
  await assert.rejects(send(), (error) => error.statusCode === 429 && error.retryAfterSeconds > 60);
  const persisted = new Store(f.file);
  assert.ok(emailVerificationStatus(persisted, account, { now: f.clock() }).retryAfterSeconds > 60);
  f.advance(EMAIL_VERIFICATION_TTL_MS - (f.clock() - start));
  await send();
  assert.equal(f.sent.length, 21, 'delivery is available again when the first daily slot expires');
});

test('concurrent requests reserve one delivery before the mail provider completes', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  let finish;
  let deliveries = 0;
  const mail = { send() { deliveries += 1; return new Promise((resolve) => { finish = resolve; }); } };
  const first = requestEmailVerification(f.store, account, { ...f.context, mail, now: f.clock() });
  await assert.rejects(requestEmailVerification(f.store, account, { ...f.context, mail, now: f.clock() }),
    (error) => error.statusCode === 429);
  assert.equal(deliveries, 1);
  finish();
  await first;
});

test('expired links, changed addresses, and deactivated accounts cannot be verified', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  await f.call('POST', '/api/me/email-verification/resend');
  const token = extractToken(f.sent[0]);
  account.email = 'different@fixture.test';
  assert.throws(() => confirmEmailVerification(f.store, token, { now: f.clock() }), /invalid or has expired/);
  account.email = 'existing@fixture.test';
  account.isActive = false;
  assert.throws(() => confirmEmailVerification(f.store, token, { now: f.clock() }), /invalid or has expired/);
  account.isActive = true;
  f.advance(EMAIL_VERIFICATION_TTL_MS);
  assert.throws(() => confirmEmailVerification(f.store, token, { now: f.clock() }), /invalid or has expired/);
  assert.equal(isEmailVerified(account), false);
});

test('delivery failure is reported safely and preserves the previous valid link', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  await f.call('POST', '/api/me/email-verification/resend');
  const token = extractToken(f.sent[0]);
  f.advance(EMAIL_VERIFICATION_COOLDOWN_MS);
  f.failMail();
  const failed = await f.call('POST', '/api/me/email-verification/resend');
  assert.equal(failed.status, 502);
  assert.equal(JSON.stringify(failed.body).includes('private SMTP'), false);
  assert.equal(isEmailVerified(account), false);
  assert.equal((await f.call('POST', '/api/me/email-verification/resend')).status, 429, 'failed attempts still consume the budget');
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token })).status, 200);
});

test('storage failure neither sends mail nor consumes a successful verification', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  const flush = f.store.flush.bind(f.store);
  f.store.flush = () => { throw new Error('disk failure'); };
  await assert.rejects(requestEmailVerification(f.store, account, { ...f.context, now: f.clock() }), /disk failure/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.emailVerifications.size, 0);
  f.store.flush = flush;
  await f.call('POST', '/api/me/email-verification/resend');
  const token = extractToken(f.sent[0]);
  f.store.flush = () => { throw new Error('disk failure'); };
  assert.throws(() => confirmEmailVerification(f.store, token, { now: f.clock() }), /disk failure/);
  assert.equal(isEmailVerified(f.store.accounts.get(account._id)), false);
  f.store.flush = flush;
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token })).status, 200);
});

test('public resend responses do not reveal unknown, unverified, or verified accounts', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  const unknown = await f.call('POST', '/api/signup/resend', { email: 'unknown@fixture.test' });
  const pending = await f.call('POST', '/api/signup/resend', { email: account.email });
  const throttled = await f.call('POST', '/api/signup/resend', { email: account.email });
  assert.deepEqual([unknown.status, pending.status, throttled.status], [202, 202, 202]);
  assert.deepEqual(unknown.body, pending.body);
  assert.deepEqual(throttled.body, pending.body);
  assert.equal(f.sent.length, 1);
  await f.call('POST', '/api/email-verification/confirm', { token: extractToken(f.sent[0]) });
  assert.deepEqual((await f.call('POST', '/api/signup/resend', { email: account.email })).body, unknown.body);
  assert.equal(f.sent.length, 1);
});

test('public resend acknowledges the request without waiting for SMTP delivery', async (t) => {
  let finish;
  let deliveries = 0;
  const f = await fixture(t, { service: { identityProviders: {
    portalUrl: 'https://portal.fixture.test',
    emailVerification: { send() {
      deliveries += 1;
      return new Promise((resolve) => { finish = resolve; });
    } },
  } } });
  const account = await loginLegacy(f);
  let timer;
  try {
    const response = await Promise.race([
      f.call('POST', '/api/signup/resend', { email: account.email }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('public resend waited for SMTP')), 2000); }),
    ]);
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(deliveries, 1);
    assert.ok(f.store.emailVerifications.get(account._id).tokenHash, 'the delivery budget/token was reserved before acknowledgement');
  } finally {
    clearTimeout(timer);
    finish?.();
  }
});

test('bulk requests from one client and cross-origin resends are rejected', async (t) => {
  const f = await fixture(t);
  await loginLegacy(f);
  const csrf = await f.call('POST', '/api/me/email-verification/resend', {}, { origin: 'https://attacker.fixture.test', 'user-agent': 'Mozilla/5.0' });
  assert.equal(csrf.status, 403);
  assert.equal(f.sent.length, 0);
  for (let i = 0; i < 40; i += 1) {
    assert.equal((await f.call('POST', '/api/signup/resend', { email: `unknown${i}@fixture.test` })).status, 202);
  }
  assert.equal((await f.call('POST', '/api/signup/resend', { email: 'one-more@fixture.test' })).status, 429);
});

test('profile updates cannot assert verification and a verified flag is bound to its mailbox', async (t) => {
  const f = await fixture(t);
  const account = await loginLegacy(f);
  const edit = await f.call('PUT', '/api/me', { emailVerified: true, emailVerifiedAddress: account.email, emailVerifiedAt: Date.now() });
  assert.equal(edit.body.account.emailVerified, false);
  await f.call('POST', '/api/me/email-verification/resend');
  await f.call('POST', '/api/email-verification/confirm', { token: extractToken(f.sent[0]) });
  const verified = f.store.accounts.get(account._id);
  verified.email = 'another@fixture.test';
  assert.equal(isEmailVerified(verified), false, 'a mailbox change cannot inherit a previous proof');
  const projection = (await f.call('GET', '/api/me')).body.account;
  assert.equal(projection.emailVerified, false);
  assert.equal(JSON.stringify(projection).includes('tokenHash'), false);
  assert.equal(JSON.stringify(projection).includes('emailVerifiedAddress'), false);
});

test('signup without mail keeps an honest unverified state and the resend API reports unavailable', async (t) => {
  const f = await fixture(t, { noMail: true });
  const signup = await f.call('POST', '/api/signup', { email: 'lan@fixture.test', password: 'ValidPass1' });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.account.emailVerified, false);
  assert.equal(signup.body.emailSent, false);
  assert.equal((await f.call('GET', '/api/me/email-verification')).body.available, false);
  assert.equal((await f.call('POST', '/api/me/email-verification/resend')).status, 503);
});

test('signup delivery failure remains recoverable after a restart without claiming mail was sent', async (t) => {
  const f = await fixture(t);
  f.failMail();
  const signup = await f.call('POST', '/api/signup', { email: 'failed@fixture.test', password: 'ValidPass1' });
  assert.equal(signup.status, 202);
  assert.equal(signup.body.emailSent, false);
  const restarted = new Store(f.file);
  assert.equal(restarted.accountByEmail('failed@fixture.test').emailActivationPending, true);
  f.recoverMail();
  f.advance(EMAIL_VERIFICATION_COOLDOWN_MS);
  assert.equal((await f.call('POST', '/api/signup/resend', { email: 'failed@fixture.test' })).status, 202);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.call('POST', '/api/email-verification/confirm', { token: extractToken(f.sent[0]) })).status, 200);
  assert.equal((await f.call('POST', '/api/login', { email: 'failed@fixture.test', password: 'ValidPass1' })).status, 200);
});
