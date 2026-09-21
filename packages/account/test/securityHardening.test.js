// Focused regressions for the Internet-facing account/portal boundaries.
// These intentionally exercise authorization before the downstream provider
// seams so an IDOR or spoofed identity cannot be hidden by a test double.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');
const { signSigV4 } = await import('../../common/src/sigv4.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const {
  handleAccountIdentity,
} = await import('../src/accountIdentity.js');
const { createSession, getSession, sessionCookie } = await import('../src/sessions.js');
const { robotFaceRoutes } = await import('../src/robotFace.js');
const { settingsAwsDispatch } = await import('../src/settingsFace.js');
const { portalProfileRoutes } = await import('../src/portal/profile.js');
const { portalPeopleRoutes } = await import('../src/portal/people.js');
const { portalMediaRoutes } = await import('../src/portal/media.js');
const { portalMessagingRoutes } = await import('../src/portal/messaging.js');
const { validateIcalUrl, fetchIcalText } = await import('../src/icalSubscriptions.js');
const { checkPortalOrigin, isStateChangingPortalRoute, protectPortalRoutes } = await import('../src/portalCsrf.js');

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'phx-security-hardening-'));
  const store = new Store(join(dir, 'store.json'));
  return { dir, store };
}

function response() {
  return {
    statusCode: 200,
    shouldKeepAlive: false,
    headersSent: false,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value));
      this.headersSent = true;
    },
    end(body = '') {
      this.body = body;
      this.headersSent = true;
    },
  };
}

function request(target, body = {}, headers = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    url: '/',
    originalUrl: '/',
    rawBody,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: 'localhost',
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...headers,
    },
  };
}

function parsedBody(res) {
  return res.body ? JSON.parse(res.body) : null;
}

function log() {
  return { info() {}, warn() {}, error() {} };
}

async function accountOp(store, target, body) {
  const req = request(target, body);
  const res = response();
  await handleAccountIdentity({
    store, req, res, body, log: log(), loopConfig: {},
    mailProviders: {}, identityProviders: {}, loopUpdatedOutbox: { record() {} },
  });
  return { req, res, body: parsedBody(res) };
}

test('Account.Create ignores privilege mass assignment', async () => {
  const { dir, store } = tempStore();
  try {
    const result = await accountOp(store, 'Account_20151111.Create', {
      email: 'mass-assignment@example.test',
      password: 'Valid-pass1',
      isAdmin: true,
      isActive: true,
      isDeleted: true,
      roles: ['developer'],
      accessKeyId: 'attacker-controlled',
      secretAccessKey: 'attacker-controlled',
    });
    assert.equal(result.res.statusCode, 200);
    const account = store.accountByEmail('mass-assignment@example.test');
    assert.equal(account.isAdmin, false);
    assert.equal(account.isActive, false);
    assert.equal(account.isDeleted, false);
    assert.deepEqual(account.roles, ['user']);
    assert.notEqual(account.accessKeyId, 'attacker-controlled');
    assert.notEqual(account.secretAccessKey, 'attacker-controlled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('password reset rejects expired codes and revokes existing sessions', async () => {
  const { dir, store } = tempStore();
  try {
    const account = createOwnerAccount(store, {
      email: 'reset@example.test', password: 'Old-pass1', firstName: 'Reset',
    });
    const session = createSession(store, { kind: 'user', accountId: account._id });
    const issued = await accountOp(store, 'Account_20151111.SendPasswordReset', { email: account.email });
    assert.equal(issued.res.statusCode, 200);
    const code = account.passwordResetCode;
    account.passwordResetExpiresAt = Date.now() - 1;
    store.flush();
    const reset = await accountOp(store, 'Account_20151111.PasswordResetByCode', {
      code, password: 'New-pass1',
    });
    assert.equal(reset.res.statusCode, 404);
    assert.equal(reset.body.__type, 'PASSWORD_CODE_WRONG');
    assert.equal(getSession(store, { headers: { cookie: sessionCookie(session) } }), session,
      'an expired code does not revoke a session before a successful reset');

    account.passwordResetExpiresAt = Date.now() + 60_000;
    account.passwordResetCreated = Date.now();
    store.flush();
    const successful = await accountOp(store, 'Account_20151111.PasswordResetByCode', {
      code, password: 'New-pass1',
    });
    assert.equal(successful.res.statusCode, 200);
    assert.equal(getSession(store, { headers: { cookie: sessionCookie(session) } }), null);
    assert.equal(store.accounts.get(account._id).passwordResetCode, undefined);
    const replay = await accountOp(store, 'Account_20151111.PasswordResetByCode', {
      code, password: 'Another-pass1',
    });
    assert.equal(replay.res.statusCode, 404);
    assert.equal(replay.body.__type, 'PASSWORD_CODE_WRONG');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portal password change revokes the session that made the change', () => {
  const { dir, store } = tempStore();
  try {
    const account = createOwnerAccount(store, {
      email: 'change@example.test', password: 'Old-pass1', firstName: 'Change',
    });
    const session = createSession(store, { kind: 'user', accountId: account._id });
    const req = { headers: { cookie: sessionCookie(session) } };
    const res = response();
    portalProfileRoutes(store)['POST /api/me/password']({
      req, res, body: { currentPassword: 'Old-pass1', newPassword: 'New-pass1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(getSession(store, req), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsigned Settings requests cannot choose another account', async () => {
  const { dir, store } = tempStore();
  const previous = process.env.ETCO_account_internalPeerToken;
  try {
    delete process.env.ETCO_account_internalPeerToken;
    const account = createOwnerAccount(store, {
      email: 'settings@example.test', password: 'Settings-pass1',
    });
    const routes = robotFaceRoutes(store, {
      settingsProviders: {
        account: { checkUserBelongsToLoop: async () => {} },
        hub: { getSkillConfigs: async () => [] },
      },
    });
    const req = request('Settings_20171219.GetSettings', { loopId: 'loop-owned-by-someone-else' }, {
      'x-amz-credentials': JSON.stringify({ id: account._id }),
    });
    delete req.headers.authorization;
    const res = response();
    await routes['POST /']({ req, res, body: { loopId: 'loop-owned-by-someone-else' }, log: log() });
    assert.equal(res.statusCode, 401);
    assert.equal(parsedBody(res).__type, 'CREDENTIALS_REQUIRED');
  } finally {
    if (previous === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Settings dispatch uses the verified caller rather than forwarded identity', async () => {
  const { dir, store } = tempStore();
  try {
    const account = createOwnerAccount(store, {
      email: 'verified-settings@example.test', password: 'Settings-pass1',
    });
    let seen;
    const providers = {
      account: { checkUserBelongsToLoop: async (context) => { seen = context; } },
      hub: { getSkillConfigs: async () => [] },
    };
    const req = request('Settings_20171219.GetSettings', { loopId: 'loop-1' }, {
      'content-type': 'application/json',
      'x-amz-credentials': JSON.stringify({ id: 'spoofed-account' }),
    });
    req._phoenixVerifiedCredentials = account;
    const res = response();
    await settingsAwsDispatch(store, {
      req, res, body: { loopId: 'loop-1' }, op: 'GetSettings', providers, log: log(),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seen.userId, account._id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OOBE PrepareRobot rejects an invalid SigV4 signature', async () => {
  const { dir, store } = tempStore();
  try {
    const account = createOwnerAccount(store, {
      email: 'oobe@example.test', password: 'Oobe-pass1',
    });
    const routes = robotFaceRoutes(store);
    const req = request('Account_20151111.PrepareRobot');
    const signed = signSigV4({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: req.rawBody,
      accessKeyId: account.accessKeyId,
      secretAccessKey: account.secretAccessKey,
      region: 'us-east-1',
      service: 'account',
    });
    const validAuthorization = signed.headers.Authorization || signed.headers.authorization;
    req.headers = {
      ...req.headers,
      ...signed.headers,
      authorization: validAuthorization.replace(/Signature=[^,\s]+/, `Signature=${'0'.repeat(64)}`),
    };
    const res = response();
    await routes['POST /']({ req, res, body: {}, log: log() });
    assert.equal(res.statusCode, 401);
    assert.equal(parsedBody(res).__type, 'SIGNATURE_MISMATCH');
    assert.equal(store.tokens.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portal Classic surfaces refuse loop IDs outside the caller membership', async () => {
  const { dir, store } = tempStore();
  try {
    const owner = createOwnerAccount(store, { email: 'owner@example.test', password: 'Owner-pass1' });
    const stranger = createOwnerAccount(store, { email: 'stranger@example.test', password: 'Stranger-pass1' });
    const { loop } = createLoop(store, { owner, robotId: 'idor-robot' });
    const session = createSession(store, { kind: 'user', accountId: stranger._id });
    const req = { headers: { cookie: sessionCookie(session) } };
    let calls = 0;
    const classicCall = async () => { calls += 1; throw new Error('must not call Classic'); };
    const url = new URL(`http://localhost/api/people?loopId=${loop._id}`);
    const peopleRes = response();
    await portalPeopleRoutes(store, { classicCall })['GET /api/people']({ req, res: peopleRes, url });
    assert.equal(peopleRes.statusCode, 403);

    const mediaRes = response();
    await portalMediaRoutes(store, { classicCall })['GET /api/media']({
      req, res: mediaRes, url: new URL(`http://localhost/api/media?loopId=${loop._id}`),
    });
    assert.equal(mediaRes.statusCode, 403);

    const jotRes = response();
    await portalMessagingRoutes(store, { classicCall })['GET /api/jot']({
      req, res: jotRes, url: new URL(`http://localhost/api/jot?loopId=${loop._id}`),
    });
    assert.equal(jotRes.statusCode, 403);
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calendar URL validation rejects SSRF destinations', async () => {
  assert.throws(() => validateIcalUrl('http://127.0.0.1:8080/calendar.ics'), /host is not allowed/i);
  assert.throws(() => validateIcalUrl('http://169.254.169.254/latest/meta-data'), /host is not allowed/i);
  assert.throws(() => validateIcalUrl('http://user:pass@example.test/feed.ics'), /userinfo is not allowed/i);
  let called = false;
  await assert.rejects(fetchIcalText('http://127.0.0.1:8080/calendar.ics', {
    fetchImpl: async () => { called = true; return { ok: true, status: 200 }; },
  }), /host is not allowed/i);
  assert.equal(called, false);
});

test('portal mutating routes enforce same-origin requests with a conservative API exception', () => {
  let calls = 0;
  const routes = protectPortalRoutes({
    'POST /api/mutate': () => { calls += 1; },
    'GET /api/read': () => { calls += 1; },
  }, { env: { ETCO_account_csrfOrigins: 'https://portal.example.test' } });

  const blocked = response();
  routes['POST /api/mutate']({
    req: { headers: { origin: 'https://evil.example.test', 'user-agent': 'Mozilla/5.0' } },
    res: blocked,
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(calls, 0);

  const allowed = response();
  routes['POST /api/mutate']({
    req: { headers: { origin: 'https://portal.example.test', 'user-agent': 'Mozilla/5.0' } },
    res: allowed,
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls, 1);

  const browserWithoutOrigin = response();
  routes['POST /api/mutate']({
    req: { headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-site': 'same-origin' } },
    res: browserWithoutOrigin,
  });
  assert.equal(browserWithoutOrigin.statusCode, 403);
  assert.equal(calls, 1);

  const apiClient = response();
  routes['POST /api/mutate']({
    req: { headers: { 'user-agent': 'curl/8.0' } },
    res: apiClient,
  });
  assert.equal(apiClient.statusCode, 200);
  assert.equal(calls, 2);

  const markedWebView = response();
  routes['POST /api/mutate']({
    req: { headers: { 'user-agent': 'Mozilla/5.0', 'x-phoenix-api-client': 'native' } },
    res: markedWebView,
  });
  assert.equal(markedWebView.statusCode, 200);
  assert.equal(calls, 3);

  const safeRead = response();
  routes['GET /api/read']({
    req: { headers: { origin: 'https://evil.example.test', 'user-agent': 'Mozilla/5.0' } },
    res: safeRead,
  });
  assert.equal(safeRead.statusCode, 200);
  assert.equal(calls, 4);
  assert.equal(isStateChangingPortalRoute('POST', '/api/mutate'), true);
  assert.equal(isStateChangingPortalRoute('GET', '/api/mutate'), false);
});

test('direct Account member-photo ingress requires an owning session', async () => {
  const { dir, store } = tempStore();
  let server;
  try {
    const owner = createOwnerAccount(store, { email: 'photo-owner@example.test', password: 'Photo-owner1' });
    const stranger = createOwnerAccount(store, { email: 'photo-stranger@example.test', password: 'Photo-stranger1' });
    owner.photoUrl = 'http://account.invalid/member-photos/owner-photo';
    store.flush();
    const file = join(dir, 'owner-photo');
    writeFileSync(file, Buffer.from('private-photo'));
    const provider = {
      open(key) { return createReadStream(join(dir, key)); },
      publicBaseUrl: 'http://account.invalid/member-photos',
    };
    server = await createAccountService({ store, memberPhotoProvider: provider }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const unauthenticated = await fetch(`${base}/member-photos/owner-photo`);
    assert.equal(unauthenticated.status, 401);
    const strangerSession = createSession(store, { kind: 'user', accountId: stranger._id });
    const strangerResponse = await fetch(`${base}/member-photos/owner-photo`, {
      headers: { cookie: sessionCookie(strangerSession) },
    });
    assert.equal(strangerResponse.status, 404);
    const ownerSession = createSession(store, { kind: 'user', accountId: owner._id });
    const ownerResponse = await fetch(`${base}/member-photos/owner-photo`, {
      headers: { cookie: sessionCookie(ownerSession) },
    });
    assert.equal(ownerResponse.status, 200);
    assert.equal(await ownerResponse.text(), 'private-photo');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
