// A-04 — OOBE_20161026.GetServiceToken.
//
// Pinned source: jiborobot/srv-account-ws@6cea434
//   src/handlers/oobe.handler.ts  -> mapping.getServiceToken, @parseCredentials({ adminOnly: true })
//   src/controllers/oobe.ctrl.ts:127-135 -> getServiceToken()
//   src/constants.ts -> SERVICE_MODE_EMAIL_PREFIX = 'service-mode-owner-'
//
// The controller mints a fresh owner account with a uuid-derived
// service-mode email and returns a setup token bound to it with loopId null.
// The handler carries NO @validatePayload, so the request body is ignored.

import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-servicetoken-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, mintSetupToken } = await import('../src/model.js');

let server; let base;

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...headers,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

// The robot face resolves identity from the SigV4 Authorization access key
// (accountForClassicRequest -> accessKeyIdFromAuth), not from x-amz-credentials.
function signed(store, target, body, accessKeyId) {
  return signedLoopHeaders(store, base, target, body, accessKeyId);
}

before(async () => {
  const svc = await createAccountService({ log: { info() {}, warn() {}, error() {} } });
  server = svc.server ?? svc;
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test('GetServiceToken mints a service-mode owner account and a loopId-null setup token', async () => {
  const store = getStore();
  const admin = createOwnerAccount(store, { email: 'admin-gst@example.com', password: 'pw' });
  admin.isAdmin = true;
  store.flush();

  const beforeAccounts = new Set(store.accounts.keys());
  const res = await amz('OOBE_20161026.GetServiceToken', {},
    signed(store, 'OOBE_20161026.GetServiceToken', {}, admin.accessKeyId));

  assert.equal(res.status, 200);
  // Output shape is TokenContainer { token, expires } (oobeadmin-2016-10-26:
  // GetServiceToken -> TokenContainer; token.ctrl.ts create() returns
  // `{ token: token._id, expires: currentTimestamp + ACCESS_TOKEN_LIFETIME }`).
  // A raw token document would leave `token` undefined for the generated client.
  assert.equal(typeof res.body.token, 'string', 'TokenContainer.token is the access token');
  assert.ok(res.body.expires > Date.now(), 'TokenContainer.expires is created + 15 minutes');
  assert.equal(res.body._id, undefined, 'not the raw token document');

  // A new account was created; the token is bound to it with loopId null.
  const minted = [...store.accounts.keys()].filter((id) => !beforeAccounts.has(id));
  assert.equal(minted.length, 1, 'exactly one new account');
  const account = store.accounts.get(minted[0]);
  assert.ok(account, 'the new service-mode account exists');
  const token = store.tokens.get(res.body.token);
  assert.ok(token, 'the returned token resolves in the store');
  assert.equal(token.accountId, account._id, 'token is bound to the minted account');
  assert.equal(token.loopId, null, 'loopId is null, not omitted');

  // `${SERVICE_MODE_EMAIL_PREFIX}${uuid}@jibo.com` with the FULL prefix.
  assert.ok(account.email.startsWith('service-mode-owner-'),
    `email should carry the full source prefix, got ${account.email}`);
  assert.ok(account.email.endsWith('@jibo.com'), 'email domain is jibo.com');
  assert.equal(account.isActive, true, 'created with isActive: true');
  assert.equal(res.body.expires, token.created + 15 * 60 * 1000, 'expires tracks the token TTL');
});

test('GetServiceToken rejects a non-admin caller and creates nothing', async () => {
  const store = getStore();
  const plain = createOwnerAccount(store, { email: 'plain-gst@example.com', password: 'pw' });
  store.flush();

  const before = store.accounts.size;
  const res = await amz('OOBE_20161026.GetServiceToken', {},
    signed(store, 'OOBE_20161026.GetServiceToken', {}, plain.accessKeyId));

  // errors/*.ts gives AUTHORIZED_UNDER_ADMIN statusCode 401 (not 403).
  assert.equal(res.status, 401);
  assert.equal(res.body.__type, 'AUTHORIZED_UNDER_ADMIN');
  // The adminOnly decorator runs before the method, so no account is minted.
  assert.equal(store.accounts.size, before, 'no account created for a rejected caller');
});

test('GetServiceToken rejects an unauthenticated caller', async () => {
  const store = getStore();
  const before = store.accounts.size;
  const res = await amz('OOBE_20161026.GetServiceToken', {});
  // errors/*.ts gives AUTHORIZED_UNDER_ADMIN statusCode 401 (not 403).
  assert.equal(res.status, 401);
  assert.equal(res.body.__type, 'AUTHORIZED_UNDER_ADMIN');
  assert.equal(store.accounts.size, before, 'no account created without credentials');
});

test('each GetServiceToken call yields a distinct account and token', async () => {
  const store = getStore();
  const admin = createOwnerAccount(store, { email: 'admin-gst2@example.com', password: 'pw' });
  admin.isAdmin = true;
  store.flush();

  const a = await amz('OOBE_20161026.GetServiceToken', {},
    signed(store, 'OOBE_20161026.GetServiceToken', {}, admin.accessKeyId));
  const b = await amz('OOBE_20161026.GetServiceToken', {},
    signed(store, 'OOBE_20161026.GetServiceToken', {}, admin.accessKeyId));

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // mintSetupToken reuses a live token for the same (account, loop) pair, but
  // getServiceToken creates a NEW account each call, so tokens never collide.
  assert.notEqual(store.tokens.get(a.body.token).accountId, store.tokens.get(b.body.token).accountId,
    'distinct accounts');
  assert.notEqual(a.body.token, b.body.token, 'distinct tokens');
});

test('the handler carries no validatePayload, so a junk body is ignored', async () => {
  const store = getStore();
  const admin = createOwnerAccount(store, { email: 'admin-gst3@example.com', password: 'pw' });
  admin.isAdmin = true;
  store.flush();

  // oobe.handler.ts declares only @parseCredentials({ adminOnly: true }) for
  // this method — no Joi schema — so unexpected fields must not 422.
  const junk = { unexpected: 'field', loopId: 'ignored' };
  const res = await amz('OOBE_20161026.GetServiceToken', junk,
    signed(store, 'OOBE_20161026.GetServiceToken', junk, admin.accessKeyId));

  assert.equal(res.status, 200);
  assert.equal(store.tokens.get(res.body.token).loopId, null, 'a body loopId does not bind the token');
});

// REGRESSION: SERVICE_MODE_EMAIL_PREFIX must be the FULL 'service-mode-owner-'.
// Phoenix previously used the truncated 'service-mode-'.
//
// This must exercise the CONSTANT's real effect, not re-assert a literal: the
// prefix decides the setupRobot `serviceMode` credential flag. An account named
// 'service-mode-decoy@...' does NOT match the source prefix, so a robot set up
// by that owner must come back WITHOUT serviceMode. Under the truncated prefix
// it would be flagged true.
test('REGRESSION: a service-mode-* owner that is not service-mode-owner-* gets no serviceMode flag', async () => {
  const store = getStore();
  const decoy = createOwnerAccount(store, { email: 'service-mode-decoy@jibo.com', password: 'pw' });
  const token = mintSetupToken(store, decoy._id, null);
  store.flush();

  const body = { id: 'decoy-maple-pixel-comet', token: token._id };
  const res = await amz('OOBE_20161026.SetupRobot', body,
    signedLoopHeaders(store, base, 'OOBE_20161026.SetupRobot', body, decoy.accessKeyId));

  assert.equal(res.status, 200);
  assert.ok(res.body.accessKeyId, 'returns robot credentials');
  assert.equal(res.body.serviceMode, undefined,
    'a service-mode-* (non -owner-) email must NOT be treated as service mode');
});

// The positive half: a real service-mode owner minted by GetServiceToken DOES
// get the flag, so the constant is pinned from both directions.
test('a GetServiceToken-minted owner does get serviceMode on setupRobot', async () => {
  const store = getStore();
  const admin = createOwnerAccount(store, { email: 'admin-gst4@example.com', password: 'pw' });
  admin.isAdmin = true;
  store.flush();

  const gst = await amz('OOBE_20161026.GetServiceToken', {},
    signed(store, 'OOBE_20161026.GetServiceToken', {}, admin.accessKeyId));
  assert.equal(gst.status, 200);

  const owner = store.accounts.get(store.tokens.get(gst.body.token).accountId);
  const body = { id: 'service-maple-pixel-comet', token: gst.body.token };
  const res = await amz('OOBE_20161026.SetupRobot', body,
    signedLoopHeaders(store, base, 'OOBE_20161026.SetupRobot', body, owner.accessKeyId));

  assert.equal(res.status, 200);
  assert.equal(res.body.serviceMode, true,
    'the service-mode owner minted by GetServiceToken must be flagged');
});
