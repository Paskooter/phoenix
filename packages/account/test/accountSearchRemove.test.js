// A-03 Search and Remove. Fixtures are synthetic.
// Source: srv-account-ws@6cea434 and srv-security-gw@43a692fe.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a03-search-remove-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, fillAccessKeys, newId } = await import('../src/model.js');
const {
  ACCOUNT_ERRORS,
  ACCOUNT_ANONYMOUS_TARGETS,
  ACCOUNT_UNACTIVE_TARGETS,
  escapeRegexp,
} = await import('../src/accountIdentity.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

const PASSWORD = 'ValidPass1';

let store;
let accountService;
let accountBase;
let classicService;
let classicBase;
let owner;
let outsider;
let admin;
let robot;
let loop;

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

function assertHapi422(response, message) {
  assert.equal(response.status, 422);
  assert.equal(response.body.statusCode, 422);
  assert.equal(response.body.error, 'Unprocessable Entity');
  assert.equal(response.body.message, message);
}

function assertAmzError(response, definition) {
  assert.equal(response.status, definition.statusCode, response.rawBody);
  assert.equal(response.body.__type, definition.code);
  assert.equal(response.body.message, definition.message);
  assert.equal(response.headers['x-amzn-errortype'], definition.code);
}

function assertSafeAccount(body) {
  assert.ok(!('password' in body));
  assert.ok(!('secretAccessKey' in body));
  assert.ok(!('accessKeyId' in body));
  assert.ok(!('activationCode' in body));
  assert.ok(!('passwordResetCode' in body));
  assert.ok(!('facebookAccessToken' in body));
  assert.ok(!('created' in body));
  assert.equal(typeof body.facebookConnected, 'boolean');
}

function createEmailless(store, { firstName, lastName }) {
  const account = {
    _id: newId(),
    firstName,
    lastName,
    isActive: true,
    isDeleted: false,
    ...fillAccessKeys(),
    created: Date.now(),
    updated: Date.now(),
  };
  store.accounts.set(account._id, account);
  store.flush();
  return account;
}

function addAcceptedMember(targetStore, loop, accountId) {
  loop.members = loop.members || [];
  loop.members.push({
    _id: newId(),
    accountId,
    status: 'accepted',
    enrolled: { face: false, voice: false },
    created: Date.now(),
  });
  targetStore.loops.set(loop._id, loop);
  targetStore.flush();
}

describe('Account Search and Remove', { concurrency: 1 }, () => {
before(async () => {
  store = new Store(storeFile);
  owner = createOwnerAccount(store, {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Owner',
    lastName: 'Fixture',
  });
  outsider = createOwnerAccount(store, {
    email: 'outsider@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Out',
    lastName: 'Sider',
  });
  admin = createOwnerAccount(store, {
    email: 'admin@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Admin',
    lastName: 'Root',
  });
  admin.isAdmin = true;
  store.flush();
  ({ loop, robot } = createLoop(store, { owner, robotId: 'a03-search-remove-robot' }));
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
  rmSync(dir, { recursive: true, force: true });
});

test('escape-regexp@0.0.1 escapes regex metacharacters and leaves hyphens', () => {
  assert.equal(escapeRegexp('a.b+c?'), 'a\\.b\\+c\\?');
  assert.equal(escapeRegexp('foo-bar'), 'foo-bar');
  assert.equal(escapeRegexp('(*)'), '\\(\\*\\)');
});

test('Search is not a gateway anonymous target; Remove is the only unactive target', () => {
  assert.equal(ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.Search'), false);
  assert.deepEqual([...ACCOUNT_UNACTIVE_TARGETS], ['Account_20151111.Remove']);
});

test('Search requires a signature, a query string, and uses the safe projection', async () => {
  const unauth = await post(accountBase, 'Account_20151111.Search', { query: 'Owner' });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.__type, 'MISSING_AUTH_HEADER');

  const missing = await post(accountBase, 'Account_20151111.Search', {}, owner);
  assertHapi422(missing, 'child "query" fails because ["query" is required]');

  const empty = await post(accountBase, 'Account_20151111.Search', { query: '' }, owner);
  assertHapi422(empty, 'child "query" fails because ["query" is not allowed to be empty]');

  const byFirst = await post(accountBase, 'Account_20151111.Search', { query: 'owner' }, owner);
  assert.equal(byFirst.status, 200, byFirst.rawBody);
  assert.equal(Array.isArray(byFirst.body), true);
  const hit = byFirst.body.find((row) => row.id === owner._id);
  assert.ok(hit);
  assert.equal(hit.email, 'owner@synthetic.invalid');
  assert.equal(hit.firstName, 'Owner');
  assertSafeAccount(hit);

  const stored = store.accounts.get(owner._id);
  assert.equal(typeof stored.password, 'string');
  assert.equal(typeof stored.secretAccessKey, 'string');
});

test('Search matches lastName, firstName or email case-insensitively and excludes isDeleted true', async () => {
  const byLast = await post(accountBase, 'Account_20151111.Search', { query: 'FIXTURE' }, owner);
  assert.ok(byLast.body.some((row) => row.id === owner._id));

  const byEmail = await post(accountBase, 'Account_20151111.Search', { query: 'OUTSIDER@synthetic.invalid' }, owner);
  assert.ok(byEmail.body.some((row) => row.id === outsider._id));
  assert.equal(byEmail.body.some((row) => row.id === owner._id), false);

  const noMatch = await post(accountBase, 'Account_20151111.Search', { query: 'no-such-account-xyz' }, owner);
  assert.deepEqual(noMatch.body, []);

  const previous = owner.isDeleted;
  owner.isDeleted = true;
  store.flush();
  try {
    const deleted = await post(accountBase, 'Account_20151111.Search', { query: 'Owner' }, outsider);
    assert.equal(deleted.body.some((row) => row.id === owner._id), false);
  } finally {
    owner.isDeleted = previous;
    store.flush();
  }

  const hadFlag = Object.prototype.hasOwnProperty.call(outsider, 'isDeleted');
  const previousFlag = outsider.isDeleted;
  delete outsider.isDeleted;
  store.flush();
  try {
    const absent = await post(accountBase, 'Account_20151111.Search', { query: 'Sider' }, owner);
    assert.ok(absent.body.some((row) => row.id === outsider._id), '$ne true matches a missing isDeleted');
  } finally {
    if (hadFlag) outsider.isDeleted = previousFlag;
    store.flush();
  }
});

test('Search escapes the query so metacharacters are literal, not a regex', async () => {
  const star = await post(accountBase, 'Account_20151111.Search', { query: '*' }, owner);
  assert.equal(star.status, 200);
  assert.equal(star.body.length, 0);

  const pattern = await post(accountBase, 'Account_20151111.Search', { query: 'Own.*' }, owner);
  assert.equal(pattern.body.some((row) => row.id === owner._id), false);
});

test('Search with an inactive signer is ACCOUNT_NOT_ACTIVE; a supplied signature is still verified', async () => {
  const inactive = Object.assign(owner, { isActive: false });
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.Search', { query: 'Out' }, owner);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
  } finally {
    inactive.isActive = true;
    store.flush();
  }

  const forged = await post(accountBase, 'Account_20151111.Search', { query: 'Out' }, {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: 'invented-wrong-secret',
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');
});

test('Search on Classic uses the same safe projection', async () => {
  const found = await post(classicBase, 'Account_20151111.Search', { query: 'Admin' }, admin);
  assert.equal(found.status, 200, found.rawBody);
  const hit = found.body.find((row) => row.id === admin._id);
  assert.ok(hit);
  assertSafeAccount(hit);
});

test('Remove without id deletes the caller after loops are suspended, and preserves passwordResetCode', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-remove-self-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  const self = createOwnerAccount(persistStore, {
    email: 'self-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Self',
    lastName: 'Remove',
  });
  self.passwordResetCode = 'pre-delete-code';
  persistStore.flush();
  const created = createLoop(persistStore, { owner: self, robotId: 'a03-self-remove-robot' });
  const other = createOwnerAccount(persistStore, {
    email: 'host-loop@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Host',
  });
  const host = createLoop(persistStore, { owner: other, robotId: 'a03-host-remove-robot' });
  addAcceptedMember(persistStore, host.loop, self._id);

  let persistService = await createAccountService({ store: persistStore }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const blocked = await post(persistBase, 'Account_20151111.Remove', {}, self);
    assertAmzError(blocked, ACCOUNT_ERRORS.LOOPS_MUST_BE_SUSPENDED);
    assert.notEqual(persistStore.accounts.get(self._id).isDeleted, true);
    assert.equal(persistStore.loops.get(created.loop._id).isDeleted, undefined);
    assert.equal(persistStore.accounts.get(other._id).isDeleted, undefined);

    created.loop.isSuspended = true;
    persistStore.flush();
    const removed = await post(persistBase, 'Account_20151111.Remove', {}, self);
    assert.equal(removed.status, 200, removed.rawBody);
    assert.equal(removed.body.id, self._id);
    assert.equal(removed.body.isDeleted, true);
    assertSafeAccount(removed.body);

    const persisted = persistStore.accounts.get(self._id);
    assert.equal(persisted.isDeleted, true);
    assert.equal(persisted.passwordResetCode, 'pre-delete-code');
    assert.equal(persisted.email, 'self-remove@synthetic.invalid');
    assert.equal(typeof persisted.password, 'string');

    const owned = persistStore.loops.get(created.loop._id);
    assert.equal(owned.isDeleted, true);
    assert.equal(owned.robot, undefined);

    const hostAfter = persistStore.loops.get(host.loop._id);
    assert.notEqual(hostAfter.isDeleted, true);
    assert.equal((hostAfter.members || []).some((member) => member.accountId === self._id), false);
    assert.equal(persistStore.accounts.get(other._id).isDeleted, undefined);
    assert.equal(persistStore.accounts.get(created.robot._id).isDeleted, undefined);

    persistService.close();
    persistService = await createAccountService({ store: new Store(persistFile) }).listen(0);
    const reopened = new Store(persistFile);
    assert.equal(reopened.accounts.get(self._id).isDeleted, true);
    assert.equal(reopened.accounts.get(self._id).passwordResetCode, 'pre-delete-code');
    assert.equal(reopened.loops.get(created.loop._id).isDeleted, true);
    assert.equal((reopened.loops.get(host.loop._id).members || []).some((member) => member.accountId === self._id), false);
  } finally {
    persistService.close();
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('Remove with id rejects emailed accounts and unauthorized callers, then deletes only the emailless target', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-remove-id-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  const caller = createOwnerAccount(persistStore, {
    email: 'caller-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Caller',
    lastName: 'Owner',
  });
  const stranger = createOwnerAccount(persistStore, {
    email: 'stranger-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Stranger',
  });
  const created = createLoop(persistStore, { owner: caller, robotId: 'a03-id-remove-robot' });
  const dependent = createEmailless(persistStore, { firstName: 'Dep', lastName: 'Endent' });
  addAcceptedMember(persistStore, created.loop, dependent._id);

  const persistService = await createAccountService({ store: persistStore }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const emailed = await post(persistBase, 'Account_20151111.Remove', { id: stranger._id }, caller);
    assertAmzError(emailed, ACCOUNT_ERRORS.OWNER_CAN_MANIPULATE);
    assert.notEqual(persistStore.accounts.get(stranger._id).isDeleted, true);
    assert.notEqual(persistStore.accounts.get(caller._id).isDeleted, true);

    const selfById = await post(persistBase, 'Account_20151111.Remove', { id: caller._id }, caller);
    assertAmzError(selfById, ACCOUNT_ERRORS.OWNER_CAN_REMOVE);
    assert.notEqual(persistStore.accounts.get(caller._id).isDeleted, true);

    const guest = await post(persistBase, 'Account_20151111.Remove', { id: dependent._id }, stranger);
    assertAmzError(guest, ACCOUNT_ERRORS.OWNER_CAN_MANIPULATE);
    assert.notEqual(persistStore.accounts.get(dependent._id).isDeleted, true);

    const emailedMember = createOwnerAccount(persistStore, {
      email: 'loop-guest@synthetic.invalid',
      password: PASSWORD,
      firstName: 'Guest',
    });
    addAcceptedMember(persistStore, created.loop, emailedMember._id);
    const emailedInLoop = await post(persistBase, 'Account_20151111.Remove', { id: emailedMember._id }, caller);
    assertAmzError(emailedInLoop, ACCOUNT_ERRORS.OWNER_CAN_REMOVE);
    assert.notEqual(persistStore.accounts.get(emailedMember._id).isDeleted, true);
    assert.equal(persistStore.loops.get(created.loop._id).isDeleted, undefined);

    const removed = await post(persistBase, 'Account_20151111.Remove', { id: dependent._id }, caller);
    assert.equal(removed.status, 200, removed.rawBody);
    assert.equal(removed.body.id, dependent._id);
    assert.equal(removed.body.isDeleted, true);
    assertSafeAccount(removed.body);

    assert.equal(persistStore.accounts.get(dependent._id).isDeleted, true);
    assert.notEqual(persistStore.accounts.get(caller._id).isDeleted, true);
    assert.equal(persistStore.loops.get(created.loop._id).isDeleted, undefined);
    assert.equal(persistStore.loops.get(created.loop._id).robot, created.robot._id);
    assert.equal(
      (persistStore.loops.get(created.loop._id).members || []).some((member) => member.accountId === dependent._id),
      false,
    );
    assert.equal(persistStore.accounts.get(stranger._id).isDeleted, undefined);
  } finally {
    persistService.close();
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('admin can remove an emailless account with no membership; inactive callers may Remove themselves', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-remove-admin-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  const adminCaller = createOwnerAccount(persistStore, {
    email: 'admin-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Admin',
  });
  adminCaller.isAdmin = true;
  persistStore.flush();
  const orphan = createEmailless(persistStore, { firstName: 'Orphan', lastName: 'Acct' });
  const inactive = createOwnerAccount(persistStore, {
    email: 'inactive-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Inactive',
  });
  inactive.isActive = false;
  persistStore.flush();

  const persistService = await createAccountService({ store: persistStore }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const removed = await post(persistBase, 'Account_20151111.Remove', { id: orphan._id }, adminCaller);
    assert.equal(removed.status, 200, removed.rawBody);
    assert.equal(persistStore.accounts.get(orphan._id).isDeleted, true);
    assert.notEqual(persistStore.accounts.get(adminCaller._id).isDeleted, true);

    const self = await post(persistBase, 'Account_20151111.Remove', {}, inactive);
    assert.equal(self.status, 200, self.rawBody);
    assert.equal(persistStore.accounts.get(inactive._id).isDeleted, true);
  } finally {
    persistService.close();
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('Remove requires a signature and validates optional id', async () => {
  const unauth = await post(accountBase, 'Account_20151111.Remove', {});
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.__type, 'MISSING_AUTH_HEADER');

  const notObject = await post(accountBase, 'Account_20151111.Remove', null, owner);
  assertHapi422(notObject, '"value" must be an object');

  const badId = await post(accountBase, 'Account_20151111.Remove', { id: 1 }, owner);
  assertHapi422(badId, 'child "id" fails because ["id" must be a string]');
});

test('Remove on Classic self-deletes a loopless account', async () => {
  const created = await post(classicBase, 'Account_20151111.Create', {
    email: 'classic-remove@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Classic',
  });
  assert.equal(created.status, 200, created.rawBody);
  const caller = store.accountByEmail('classic-remove@synthetic.invalid');
  caller.isActive = true;
  store.flush();
  const removed = await post(classicBase, 'Account_20151111.Remove', {}, caller);
  assert.equal(removed.status, 200, removed.rawBody);
  assert.equal(removed.body.isDeleted, true);
  assertSafeAccount(removed.body);
  assert.equal(store.accounts.get(caller._id).isDeleted, true);
});
});
