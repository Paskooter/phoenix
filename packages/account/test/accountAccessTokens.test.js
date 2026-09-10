// A-03 access tokens and key rotation: CreateAccessToken, GetAccountByAccessToken,
// ResetKeys. Fixtures are synthetic. Source is srv-account-ws@6cea434,
// srv-server webtoken.ts, and srv-security-gw@43a692fe.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwt, signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a03-access-tokens-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;
process.env.WEB_TOKEN_SECRET = 'a03-web-token-secret';
process.env.HUB_TOKEN_SECRET = 'a03-hub-token-secret';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, createAuthenticatedHubToken } = await import('../src/model.js');
const { ACCOUNT_ERRORS, ACCOUNT_ANONYMOUS_TARGETS, ACCOUNT_IDENTITY_METHODS } = await import('../src/accountIdentity.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

const PASSWORD = 'ValidPass1';
const WEB_SECRET = 'a03-web-token-secret';
const HUB_SECRET = 'a03-hub-token-secret';

let store;
let accountService;
let accountBase;
let classicService;
let classicBase;
let owner;
let outsider;
let robot;

function live(account) {
  return store.accounts.get(account._id);
}

function signedHeaders(base, target, body, account, extraHeaders = {}) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  return signSigV4({
    method: 'POST',
    path: '/',
    headers: {
      host: new URL(base).host,
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...extraHeaders,
    },
    body: serialized,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
  }).headers;
}

async function post(base, target, body, account, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...extraHeaders,
  };
  if (account) Object.assign(headers, signedHeaders(base, target, body, account, extraHeaders));
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
    rawBody,
  };
}

async function postRaw(base, target, rawBody, account) {
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
  };
  if (account) {
    Object.assign(headers, signSigV4({
      method: 'POST',
      path: '/',
      headers: { host: new URL(base).host, ...headers },
      body: rawBody,
      accessKeyId: account.accessKeyId,
      secretAccessKey: account.secretAccessKey,
      region: 'global',
      service: 'jibo',
    }).headers);
  }
  const response = await fetch(`${base}/`, { method: 'POST', headers, body: rawBody });
  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let body;
  try { body = JSON.parse(raw); } catch { body = undefined; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body, rawBody: raw };
}

function assertHapi422(response, message) {
  assert.equal(response.status, 422);
  assert.equal(response.body.statusCode, 422);
  assert.equal(response.body.error, 'Unprocessable Entity');
  assert.equal(response.body.message, message);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
}

function assertAmzError(response, definition) {
  assert.equal(response.status, definition.statusCode);
  assert.equal(response.body.__type, definition.code);
  assert.equal(response.body.message, definition.message);
  assert.equal(response.headers['x-amzn-errortype'], definition.code);
}

function assertAccessTokenClaims(token, account, payload) {
  const claims = jwt.verify(token, WEB_SECRET);
  assert.deepEqual(Object.keys(claims), [
    'accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKey', 'iat', 'exp',
  ]);
  assert.equal(claims.id, String(account._id));
  assert.equal(claims.accessKeyId, account.accessKeyId);
  assert.equal(claims.email, account.email);
  assert.equal(claims.friendlyId, account.friendlyId);
  assert.equal(claims.payload, payload);
  assert.equal(claims.secretAccessKey, account.secretAccessKey);
  assert.equal(claims.exp - claims.iat, 3 * 60 * 60);
  return claims;
}

describe('Account access tokens and key rotation', { concurrency: 1 }, () => {
before(async () => {
  store = new Store(storeFile);
  owner = createOwnerAccount(store, {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Owner',
  });
  outsider = createOwnerAccount(store, {
    email: 'outsider@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Out',
  });
  ({ robot } = createLoop(store, { owner, robotId: 'a03-access-robot' }));
  accountService = await createAccountService({ store }).listen(0);
  accountBase = `http://127.0.0.1:${accountService.address().port}`;
  process.env.NET_account = `localhost:${accountService.address().port}`;
  classicService = await createClassicEntrypoint().listen(0);
  classicBase = `http://127.0.0.1:${classicService.address().port}`;
});

after(() => {
  accountService.close();
  classicService.close();
  delete process.env.NET_account;
  delete process.env.ETCO_account_dataFile;
  delete process.env.WEB_TOKEN_SECRET;
  delete process.env.HUB_TOKEN_SECRET;
  rmSync(dir, { recursive: true, force: true });
});

test('constant tables list the three operations and none of them is anonymous', () => {
  assert.ok(ACCOUNT_IDENTITY_METHODS.includes('createAccessToken'));
  assert.ok(ACCOUNT_IDENTITY_METHODS.includes('getAccountByAccessToken'));
  assert.ok(ACCOUNT_IDENTITY_METHODS.includes('resetKeys'));
  // All three carry @parseCredentials({}) in the pinned source handler, so none
  // belongs in the anonymous-target list.
  assert.ok(!ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.GetAccountByAccessToken'));
  assert.ok(!ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.CreateAccessToken'));
  assert.ok(!ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.ResetKeys'));
});

test('CreateAccessToken is signed, issues a 3h web token, and uses null for an omitted payload', async () => {
  const unsigned = await post(accountBase, 'Account_20151111.CreateAccessToken', {});
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const issued = await post(accountBase, 'Account_20151111.CreateAccessToken', {
    payload: 'source-compatible-payload',
  }, owner);
  assert.equal(issued.status, 200, issued.rawBody);
  assert.equal(typeof issued.body.token, 'string');
  assert.ok(issued.body.expires > Date.now());
  const claims = assertAccessTokenClaims(issued.body.token, live(owner), 'source-compatible-payload');
  assert.ok(issued.body.expires >= claims.exp * 1000);
  assert.ok(issued.body.expires <= claims.exp * 1000 + 999);
  assert.throws(() => jwt.verify(issued.body.token, HUB_SECRET));

  const omitted = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, owner);
  assert.equal(omitted.status, 200, omitted.rawBody);
  assertAccessTokenClaims(omitted.body.token, live(owner), null);

  const extra = await post(accountBase, 'Account_20151111.CreateAccessToken', { extra: true }, owner);
  assert.equal(extra.status, 200);
  assertAccessTokenClaims(extra.body.token, live(owner), null);
});

test('CreateAccessToken uses exact source 422 validation and does not change hub-token output', async () => {
  for (const [raw, message] of [
    ['null', '"value" must be an object'],
    ['[]', '"value" must be an object'],
    ['1', '"value" must be an object'],
    ['{"payload":null}', 'child "payload" fails because ["payload" must be a string]'],
    ['{"payload":""}', 'child "payload" fails because ["payload" is not allowed to be empty]'],
    ['{"payload":4}', 'child "payload" fails because ["payload" must be a string]'],
    ['{"payload":{}}', 'child "payload" fails because ["payload" must be a string]'],
  ]) {
    const response = await postRaw(accountBase, 'Account_20151111.CreateAccessToken', raw, owner);
    assertHapi422(response, message);
  }

  const hub = await post(accountBase, 'Account_20151111.CreateHubToken', {
    payload: 'hub-must-stay-on-hub-secret',
  }, robot);
  assert.equal(hub.status, 200, hub.rawBody);
  const hubClaims = jwt.verify(hub.body.token, HUB_SECRET);
  assert.equal(hubClaims.payload, 'hub-must-stay-on-hub-secret');
  assert.equal(hubClaims.id, robot._id);
  assert.equal(hubClaims.secretAccessKey, robot.secretAccessKey);
  assert.throws(() => jwt.verify(hub.body.token, WEB_SECRET));
});

test('CreateAccessToken rejects forged, inactive, and stale signatures before validation', async () => {
  const forged = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: 'invented-wrong-secret',
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');

  const unknown = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, {
    accessKeyId: 'UNKNOWN-A03-KEY',
    secretAccessKey: owner.secretAccessKey,
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.__type, 'ACCESS_KEY_NOT_FOUND');

  const previous = live(owner).isActive;
  live(owner).isActive = false;
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, owner);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
  } finally {
    live(owner).isActive = previous;
    store.flush();
  }
});

test('GetAccountByAccessToken requires credentials, returns the verified claim object, and requires a live account', async () => {
  const minted = await post(accountBase, 'Account_20151111.CreateAccessToken', {
    payload: 'lookup-payload',
  }, owner);
  assert.equal(minted.status, 200, minted.rawBody);

  // Source carries @parseCredentials({}) on this operation, so an
  // unauthenticated caller is rejected before the token is ever read. This
  // matters: the response body contains secretAccessKey, so a public lookup
  // would disclose account credentials to anyone holding a valid token.
  const unsigned = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: minted.body.token,
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const signed = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: minted.body.token,
  }, owner);
  assert.equal(signed.status, 200, signed.rawBody);
  assert.equal(signed.body.id, owner._id);
  assert.equal(signed.body.accessKeyId, live(owner).accessKeyId);
  assert.equal(signed.body.secretAccessKey, live(owner).secretAccessKey);
  assert.equal(signed.body.email, live(owner).email);
  assert.equal(signed.body.friendlyId, live(owner).friendlyId);
  assert.equal(signed.body.payload, 'lookup-payload');
  assert.equal(typeof signed.body.iat, 'number');
  assert.equal(typeof signed.body.exp, 'number');

  // Source does not bind the lookup to the caller: any authenticated caller
  // may resolve another account's token. Retained as source behavior and
  // reported for root classification rather than silently tightened.
  const asOutsider = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: minted.body.token,
  }, outsider);
  assert.equal(asOutsider.status, 200);
  assert.equal(asOutsider.body.id, owner._id);

  const missing = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {}, owner);
  assertHapi422(missing, 'child "token" fails because ["token" is required]');
  const empty = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', { token: '' }, owner);
  assertHapi422(empty, 'child "token" fails because ["token" is not allowed to be empty]');
  const notString = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', { token: 7 }, owner);
  assertHapi422(notString, 'child "token" fails because ["token" must be a string]');
});

test('GetAccountByAccessToken maps jsonwebtoken failures to 500 and findById errors after verify', async () => {
  const malformed = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: 'not-a-jwt',
  }, owner);
  assert.equal(malformed.status, 500);
  assert.equal(malformed.body.__type, 'InternalFailure');
  assert.equal(malformed.body.message, 'Internal server error');

  const hub = createAuthenticatedHubToken(live(owner), HUB_SECRET, 'hub-not-web');
  const hubLookup = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: hub.token,
  }, owner);
  assert.equal(hubLookup.status, 500);
  assert.equal(hubLookup.body.__type, 'InternalFailure');

  const expiredPayload = {
    accessKeyId: owner.accessKeyId,
    email: owner.email,
    friendlyId: owner.friendlyId,
    id: String(owner._id),
    payload: null,
    secretAccessKey: owner.secretAccessKey,
    iat: Math.floor(Date.now() / 1000) - 4 * 60 * 60,
    exp: Math.floor(Date.now() / 1000) - 60,
  };
  const expired = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: jwt.sign(expiredPayload, WEB_SECRET),
  }, owner);
  assert.equal(expired.status, 500);
  assert.equal(expired.body.__type, 'InternalFailure');

  const ghost = jwt.sign({
    accessKeyId: 'gone',
    email: 'gone@synthetic.invalid',
    friendlyId: null,
    id: 'missing-account-id',
    payload: null,
    secretAccessKey: 'gone-secret',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
  }, WEB_SECRET);
  const missing = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', { token: ghost }, owner);
  assertAmzError(missing, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);

  const minted = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, owner);
  const previous = live(owner).isDeleted;
  live(owner).isDeleted = true;
  store.flush();
  try {
    // The owner row is soft-deleted for this assertion, so the owner can no
    // longer authenticate: credential parsing would reject with 401 before the
    // handler ever reads the token. Sign as a different live account so the
    // request reaches findById and yields the ACCOUNT_IS_DELETED path.
    const deleted = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
      token: minted.body.token,
    }, outsider);
    assertAmzError(deleted, ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  } finally {
    live(owner).isDeleted = previous;
    store.flush();
  }
});

test('ResetKeys is signed, returns the unsafe projection, and invalidates previous SigV4 keys', async () => {
  const unsigned = await post(accountBase, 'Account_20151111.ResetKeys');
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const primitive = await postRaw(accountBase, 'Account_20151111.ResetKeys', 'null', owner);
  assert.equal(primitive.status, 200, primitive.rawBody);
  owner = live(owner);

  const before = {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: owner.secretAccessKey,
  };
  const rotated = await post(accountBase, 'Account_20151111.ResetKeys', { ignored: true }, owner);
  assert.equal(rotated.status, 200, rotated.rawBody);
  assert.equal(rotated.body.id, owner._id);
  assert.equal(rotated.body.email, live(owner).email);
  assert.equal(rotated.body.accessKeyId, live(owner).accessKeyId);
  assert.equal(rotated.body.secretAccessKey, live(owner).secretAccessKey);
  assert.notEqual(rotated.body.accessKeyId, before.accessKeyId);
  assert.notEqual(rotated.body.secretAccessKey, before.secretAccessKey);
  assert.match(rotated.body.accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(rotated.body.secretAccessKey, /^[A-Za-z0-9]{40}$/);
  assert.ok(!('password' in rotated.body));
  assert.ok(!('created' in rotated.body));

  const stale = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, {
    accessKeyId: before.accessKeyId,
    secretAccessKey: before.secretAccessKey,
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.__type, 'ACCESS_KEY_NOT_FOUND');
  owner = live(owner);
});

test('ResetKeys snapshot in a previously issued web token is not rewritten', async () => {
  const minted = await post(accountBase, 'Account_20151111.CreateAccessToken', {
    payload: 'pre-rotation',
  }, owner);
  const oldKeys = {
    accessKeyId: live(owner).accessKeyId,
    secretAccessKey: live(owner).secretAccessKey,
  };
  const rotated = await post(accountBase, 'Account_20151111.ResetKeys', {}, owner);
  assert.equal(rotated.status, 200);
  owner = live(owner);
  const lookup = await post(accountBase, 'Account_20151111.GetAccountByAccessToken', {
    token: minted.body.token,
  }, owner);
  assert.equal(lookup.status, 200, lookup.rawBody);
  assert.equal(lookup.body.accessKeyId, oldKeys.accessKeyId);
  assert.equal(lookup.body.secretAccessKey, oldKeys.secretAccessKey);
  assert.notEqual(lookup.body.accessKeyId, owner.accessKeyId);
});

test('CreateAccessToken, GetAccountByAccessToken, and ResetKeys survive store reopen', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-access-tokens-persist-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  let persistOwner = createOwnerAccount(persistStore, {
    email: 'persist-token@synthetic.invalid',
    password: PASSWORD,
  });
  let persistService = await createAccountService({ store: persistStore }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const minted = await post(persistBase, 'Account_20151111.CreateAccessToken', {
      payload: 'persist-payload',
    }, persistOwner);
    assert.equal(minted.status, 200, minted.rawBody);
    const oldKeys = {
      accessKeyId: persistOwner.accessKeyId,
      secretAccessKey: persistOwner.secretAccessKey,
    };
    const rotated = await post(persistBase, 'Account_20151111.ResetKeys', {}, persistOwner);
    assert.equal(rotated.status, 200, rotated.rawBody);
    persistOwner = persistStore.accounts.get(persistOwner._id);

    await new Promise((resolve, reject) => persistService.close((error) => error ? reject(error) : resolve()));
    persistService = null;
    const reopened = new Store(persistFile);
    const saved = reopened.accountByEmail('persist-token@synthetic.invalid');
    assert.equal(saved.accessKeyId, persistOwner.accessKeyId);
    assert.equal(saved.secretAccessKey, persistOwner.secretAccessKey);
    assert.notEqual(saved.accessKeyId, oldKeys.accessKeyId);

    const persistService2 = await createAccountService({ store: reopened }).listen(0);
    const persistBase2 = `http://127.0.0.1:${persistService2.address().port}`;
    try {
      // After ResetKeys the owner's signing keys rotated, so the caller must
      // sign with the saved (current) credentials.
      const lookup = await post(persistBase2, 'Account_20151111.GetAccountByAccessToken', {
        token: minted.body.token,
      }, saved);
      assert.equal(lookup.status, 200, lookup.rawBody);
      assert.equal(lookup.body.payload, 'persist-payload');
      assert.equal(lookup.body.accessKeyId, oldKeys.accessKeyId);
      const fresh = await post(persistBase2, 'Account_20151111.CreateAccessToken', {}, saved);
      assert.equal(fresh.status, 200, fresh.rawBody);
      assertAccessTokenClaims(fresh.body.token, saved, null);
    } finally {
      await new Promise((resolve, reject) => persistService2.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    if (persistService) {
      await new Promise((resolve) => persistService.close(() => resolve()));
    }
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('the three operations share the Classic proxy boundary', async () => {
  const caller = createOwnerAccount(store, {
    email: 'classic-token@synthetic.invalid',
    password: PASSWORD,
  });
  const minted = await post(classicBase, 'Account_20151111.CreateAccessToken', {
    payload: 'via-classic',
  }, caller);
  assert.equal(minted.status, 200, minted.rawBody);
  assertAccessTokenClaims(minted.body.token, store.accounts.get(caller._id), 'via-classic');

  const lookup = await post(classicBase, 'Account_20151111.GetAccountByAccessToken', {
    token: minted.body.token,
  }, owner);
  assert.equal(lookup.status, 200, lookup.rawBody);
  assert.equal(lookup.body.id, caller._id);
  assert.equal(lookup.body.payload, 'via-classic');

  const rotated = await post(classicBase, 'Account_20151111.ResetKeys', {}, store.accounts.get(caller._id));
  assert.equal(rotated.status, 200, rotated.rawBody);
  assert.equal(rotated.body.accessKeyId, store.accounts.get(caller._id).accessKeyId);
  assert.notEqual(rotated.body.accessKeyId, caller.accessKeyId);
});
});
