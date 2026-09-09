// A-03 account identity core: Create, Login, Get, Update, CheckEmail, ChangePassword.
// Fixtures are synthetic. Source is srv-account-ws@6cea434 and srv-security-gw@43a692fe.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a03-account-identity-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const {
  ACCOUNT_ERRORS,
  ACCOUNT_PASSWORD_REGEX,
  accountMethodName,
  accountToSourceJson,
  compareAccountPassword,
  hashAccountPassword,
  parseInternalCredentials,
} = await import('../src/accountIdentity.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

const PASSWORD = 'ValidPass1';
const OTHER_PASSWORD = 'ValidPass2';

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

describe('Account identity core', { concurrency: 1 }, () => {
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
  });
  admin = createOwnerAccount(store, {
    email: 'admin@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Admin',
  });
  admin.isAdmin = true;
  store.flush();
  ({ loop, robot } = createLoop(store, { owner, robotId: 'a03-identity-robot' }));
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

test('source target mapping lowercases only the first character of split(.)[1]', () => {
  assert.equal(accountMethodName('Account_20151111.Create'), 'create');
  assert.equal(accountMethodName('Account_20151111.ChangePassword'), 'changePassword');
  assert.equal(accountMethodName('Account_20151111.CheckEmail'), 'checkEmail');
  assert.equal(accountMethodName('Account_20151111.ActivateByCode'), 'activateByCode');
  assert.equal(accountMethodName('Account_20151111.ResendActivationCode'), 'resendActivationCode');
  assert.equal(accountMethodName('Account_20151111.PasswordResetByCode'), 'passwordResetByCode');
  assert.equal(accountMethodName('Account_20151111.Create.extra'), 'create');
  assert.equal(accountMethodName('Account_20151111.GET'), 'gET');
  assert.equal(accountMethodName('Create'), '');
});

test('parseCredentials reads only x-amz-credentials; malformed JSON is {}; null is retained', () => {
  assert.deepEqual(parseInternalCredentials({ headers: {} }), {});
  assert.deepEqual(parseInternalCredentials({ headers: { 'x-amz-credentials': 'not-json' } }), {});
  assert.equal(parseInternalCredentials({ headers: { 'x-amz-credentials': 'null' } }), null);
  assert.deepEqual(parseInternalCredentials({ headers: { 'x-amz-credentials': '{"id":"acct-1"}' } }), { id: 'acct-1' });
  const credentials = parseInternalCredentials({ headers: { 'x-amz-credentials': 'null' } });
  assert.throws(() => credentials.id, TypeError);
});

test('account password hashing is source pbkdf2 sha512$512$10000$salt$hash', () => {
  const stored = hashAccountPassword(PASSWORD);
  assert.match(stored, /^sha512\$512\$10000\$[0-9a-f]{64}\$[0-9a-f]+$/);
  assert.equal(compareAccountPassword(PASSWORD, stored), true);
  assert.equal(compareAccountPassword(OTHER_PASSWORD, stored), false);
  assert.equal(ACCOUNT_PASSWORD_REGEX.test(PASSWORD), true);
  assert.equal(ACCOUNT_PASSWORD_REGEX.test('short1A'), false);
  assert.equal(ACCOUNT_PASSWORD_REGEX.test('alllowercase1'), false);
});

test('Create persists an inactive unsafe account and rejects duplicates, children, and invalid secrets', async () => {
  const created = await post(accountBase, 'Account_20151111.Create', {
    email: 'New.User@synthetic.invalid',
    password: PASSWORD,
    firstName: 'New',
    lastName: 'User',
    gender: 'they',
  });
  assert.equal(created.status, 200, created.rawBody);
  assert.equal(created.body.email, 'new.user@synthetic.invalid');
  assert.equal(created.body.firstName, 'New');
  assert.equal(created.body.isActive, false);
  assert.equal(created.body.facebookConnected, false);
  assert.equal(typeof created.body.accessKeyId, 'string');
  assert.equal(created.body.accessKeyId.length, 20);
  assert.equal(typeof created.body.secretAccessKey, 'string');
  assert.equal(created.body.secretAccessKey.length, 40);
  assert.equal(created.body.id, created.body._id);
  assert.ok(!('password' in created.body));
  assert.ok(!('activationCode' in created.body));
  assert.ok(!('created' in created.body));
  const persisted = store.accountByEmail('new.user@synthetic.invalid');
  assert.ok(persisted);
  assert.match(persisted.password, /^sha512\$512\$10000\$/);
  assert.equal(typeof persisted.activationCode, 'string');
  assert.equal(persisted.activationCode.includes('-'), false);

  const duplicate = await post(accountBase, 'Account_20151111.Create', {
    email: 'new.user@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(duplicate, ACCOUNT_ERRORS.EMAIL_ALREADY_EXISTS);
  assert.equal([...store.accounts.values()].filter((account) => account.email === 'new.user@synthetic.invalid').length, 1);

  const child = await post(accountBase, 'Account_20151111.Create', {
    email: 'child@synthetic.invalid',
    password: PASSWORD,
    birthday: Date.now() - 10 * 365.25 * 24 * 3600 * 1000,
  });
  assertAmzError(child, ACCOUNT_ERRORS.CHILD_NOT_ALLOWED_TO_CREATE);
  assert.equal(store.accountByEmail('child@synthetic.invalid'), null);

  const short = await post(accountBase, 'Account_20151111.Create', {
    email: 'short@synthetic.invalid',
    password: 'Short1',
  });
  assertAmzError(short, ACCOUNT_ERRORS.PASSWORD_NOT_VALID_LENGTH);

  const weak = await post(accountBase, 'Account_20151111.Create', {
    email: 'weak@synthetic.invalid',
    password: 'alllowercase1',
  });
  assertAmzError(weak, ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);

  const invalidEmail = await post(accountBase, 'Account_20151111.Create', {
    email: 'not-an-email',
    password: PASSWORD,
  });
  assertAmzError(invalidEmail, ACCOUNT_ERRORS.EMAIL_NOT_VALID);

  const adult = await post(accountBase, 'Account_20151111.Create', {
    email: 'adult@synthetic.invalid',
    password: PASSWORD,
    birthday: Date.now() - 20 * 365.25 * 24 * 3600 * 1000,
  });
  assert.equal(adult.status, 200);
  assert.equal(adult.body.isActive, false);
});

test('Create and Login omit auth; supplied Authorization is still verified', async () => {
  const missing = await postRaw(accountBase, 'Account_20151111.Create', 'null');
  assertHapi422(missing, '"value" must be an object');

  const forged = await post(accountBase, 'Account_20151111.Create', {
    email: 'forged-create@synthetic.invalid',
    password: PASSWORD,
  }, { accessKeyId: owner.accessKeyId, secretAccessKey: 'invented-wrong-secret' });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');
  assert.equal(store.accountByEmail('forged-create@synthetic.invalid'), null);

  const credentialsHeader = JSON.stringify({ id: admin._id, isAdmin: true });
  const anonymous = await post(accountBase, 'Account_20151111.CheckEmail', { email: 'owner@synthetic.invalid' }, null, {
    'x-amz-credentials': credentialsHeader,
  });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.exists, true);
});

test('Login returns unsafe keys, lowercases email, and uses declared error codes', async () => {
  const ok = await post(accountBase, 'Account_20151111.Login', {
    email: 'Owner@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'owner@synthetic.invalid');
  assert.equal(ok.body.accessKeyId, owner.accessKeyId);
  assert.equal(ok.body.secretAccessKey, owner.secretAccessKey);
  assert.ok(!('password' in ok.body));

  const wrong = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner@synthetic.invalid',
    password: OTHER_PASSWORD,
  });
  assertAmzError(wrong, ACCOUNT_ERRORS.WRONG_PASSWORD);

  const missing = await post(accountBase, 'Account_20151111.Login', {
    email: 'nobody@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(missing, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);

  owner.isDeleted = true;
  store.flush();
  try {
    const deleted = await post(accountBase, 'Account_20151111.Login', {
      email: 'owner@synthetic.invalid',
      password: PASSWORD,
    });
    assertAmzError(deleted, ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  } finally {
    owner.isDeleted = false;
    store.flush();
  }

  store.emailResets.set('pending', {
    _id: 'pending',
    email: 'pending-reset@synthetic.invalid',
    status: 'new',
  });
  const pending = await post(accountBase, 'Account_20151111.Login', {
    email: 'pending-reset@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(pending, ACCOUNT_ERRORS.ACCOUNT_EMAIL_CHANGE_INCOMPLETE);
});

test('CheckEmail is a public existence lookup and treats deleted rows as absent', async () => {
  const beforeBytes = readFileSync(storeFile);
  const present = await post(accountBase, 'Account_20151111.CheckEmail', { email: 'Owner@synthetic.invalid' });
  assert.equal(present.status, 200);
  assert.deepEqual(present.body, { exists: true });

  const absent = await post(accountBase, 'Account_20151111.CheckEmail', { email: 'missing@synthetic.invalid' });
  assert.deepEqual(absent.body, { exists: false });
  assert.deepEqual(readFileSync(storeFile), beforeBytes);

  outsider.isDeleted = true;
  store.flush();
  try {
    const deleted = await post(accountBase, 'Account_20151111.CheckEmail', { email: 'outsider@synthetic.invalid' });
    assert.deepEqual(deleted.body, { exists: false });
  } finally {
    outsider.isDeleted = false;
    store.flush();
  }
  const invalid = await post(accountBase, 'Account_20151111.CheckEmail', { email: 'not-an-email' });
  assertHapi422(invalid, 'child "email" fails because ["email" must be a valid email]');
});

test('Get requires a verified signature, defaults empty ids to the caller, and enforces loop membership', async () => {
  const self = await post(accountBase, 'Account_20151111.Get', {}, robot);
  assert.equal(self.status, 200);
  assert.equal(self.body.length, 1);
  assert.equal(self.body[0].id, robot._id);
  assert.equal(self.body[0].friendlyId, 'a03-identity-robot');
  assert.ok(!('secretAccessKey' in self.body[0]));
  assert.ok(!('accessKeyId' in self.body[0]));
  assert.ok(!('password' in self.body[0]));

  const emptyIds = await post(accountBase, 'Account_20151111.Get', { ids: [] }, owner);
  assert.equal(emptyIds.body[0].id, owner._id);

  const member = await post(accountBase, 'Account_20151111.Get', { ids: [owner._id, robot._id] }, owner);
  assert.equal(member.status, 200);
  assert.equal(member.body.length, 2);

  const denied = await post(accountBase, 'Account_20151111.Get', { ids: [outsider._id] }, owner);
  assertAmzError(denied, ACCOUNT_ERRORS.MEMBER_CAN_REQUEST);

  const adminRead = await post(accountBase, 'Account_20151111.Get', { ids: [outsider._id] }, admin);
  assert.equal(adminRead.status, 200);
  assert.equal(adminRead.body[0].id, outsider._id);

  const unauth = await post(accountBase, 'Account_20151111.Get', {});
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.__type, 'MISSING_AUTH_HEADER');

  const forged = await post(accountBase, 'Account_20151111.Get', {}, {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: 'invented-wrong-secret',
  }, { 'x-amz-credentials': JSON.stringify({ id: admin._id, isAdmin: true }) });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');

  const inactive = Object.assign(owner, { isActive: false });
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.Get', {}, owner);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
  } finally {
    inactive.isActive = true;
    store.flush();
  }
});

test('Update mutates the authenticated owner, ignores email/password/keys, and rejects robots and stale writes', async () => {
  const beforeBytes = readFileSync(storeFile);
  const updated = await post(accountBase, 'Account_20151111.Update', {
    firstName: 'Renamed',
    lastName: 'Owner',
    gender: 'other',
    messagingAllowed: false,
    email: 'ignored@synthetic.invalid',
    password: OTHER_PASSWORD,
    accessKeyId: 'should-not-apply',
  }, owner);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.firstName, 'Renamed');
  assert.equal(updated.body.email, 'owner@synthetic.invalid');
  assert.ok(!('accessKeyId' in updated.body));
  assert.equal(store.accounts.get(owner._id).email, 'owner@synthetic.invalid');
  assert.equal(store.accounts.get(owner._id).accessKeyId, owner.accessKeyId);
  assert.equal(compareAccountPassword(PASSWORD, store.accounts.get(owner._id).password), true);
  assert.ok(!readFileSync(storeFile).equals(beforeBytes));

  const robotUpdate = await post(accountBase, 'Account_20151111.Update', { firstName: 'Bot' }, robot);
  assertAmzError(robotUpdate, ACCOUNT_ERRORS.ROBOT_CANNOT_BE_UPDATED);
  assert.equal(store.accounts.get(robot._id).firstName, '');

  const current = store.accounts.get(owner._id);
  current.updated = Date.now() + 60_000;
  store.flush();
  const stale = await post(accountBase, 'Account_20151111.Update', {
    firstName: 'Stale',
    updated: Date.now() - 60_000,
  }, owner);
  assertAmzError(stale, ACCOUNT_ERRORS.STALE_VERSION);
  assert.equal(store.accounts.get(owner._id).firstName, 'Renamed');

  const invalidGender = await post(accountBase, 'Account_20151111.Update', { gender: 'robot' }, owner);
  assertHapi422(invalidGender, 'child "gender" fails because ["gender" must be one of [male, female, other, they]]');
});

test('ChangePassword requires the old secret, writes pbkdf2, and rejects the previous password on Login', async () => {
  const changed = await post(accountBase, 'Account_20151111.ChangePassword', {
    oldPassword: PASSWORD,
    newPassword: OTHER_PASSWORD,
  }, owner);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.id, owner._id);
  assert.ok(!('password' in changed.body));
  assert.ok(!('secretAccessKey' in changed.body));
  const stored = store.accounts.get(owner._id);
  assert.match(stored.password, /^sha512\$512\$10000\$/);
  assert.equal(compareAccountPassword(OTHER_PASSWORD, stored.password), true);
  assert.equal(compareAccountPassword(PASSWORD, stored.password), false);

  const oldLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(oldLogin, ACCOUNT_ERRORS.WRONG_PASSWORD);
  const newLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner@synthetic.invalid',
    password: OTHER_PASSWORD,
  });
  assert.equal(newLogin.status, 200);

  const wrongOld = await post(accountBase, 'Account_20151111.ChangePassword', {
    oldPassword: PASSWORD,
    newPassword: 'ValidPass3',
  }, owner);
  assertAmzError(wrongOld, ACCOUNT_ERRORS.WRONG_PASSWORD);
  assert.equal(compareAccountPassword(OTHER_PASSWORD, store.accounts.get(owner._id).password), true);

  const weak = await post(accountBase, 'Account_20151111.ChangePassword', {
    oldPassword: OTHER_PASSWORD,
    newPassword: 'nouppercase1',
  }, owner);
  assertAmzError(weak, ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
});

test('Create/Login/Get/Update/CheckEmail/ChangePassword share the Classic proxy boundary', async () => {
  const created = await post(classicBase, 'Account_20151111.Create', {
    email: 'classic-user@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Classic',
  });
  assert.equal(created.status, 200, created.rawBody);
  assert.equal(created.body.email, 'classic-user@synthetic.invalid');
  assert.equal(typeof created.body.secretAccessKey, 'string');

  const login = await post(classicBase, 'Account_20151111.Login', {
    email: 'classic-user@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.accessKeyId, created.body.accessKeyId);

  const exists = await post(classicBase, 'Account_20151111.CheckEmail', {
    email: 'classic-user@synthetic.invalid',
  });
  assert.deepEqual(exists.body, { exists: true });

  const caller = store.accountByEmail('classic-user@synthetic.invalid');
  caller.isActive = true;
  store.flush();
  const got = await post(classicBase, 'Account_20151111.Get', {}, caller);
  assert.equal(got.status, 200);
  assert.equal(got.body[0].id, caller._id);
  assert.ok(!('secretAccessKey' in got.body[0]));

  const updated = await post(classicBase, 'Account_20151111.Update', { firstName: 'ViaClassic' }, caller);
  assert.equal(updated.body.firstName, 'ViaClassic');

  const changed = await post(classicBase, 'Account_20151111.ChangePassword', {
    oldPassword: PASSWORD,
    newPassword: OTHER_PASSWORD,
  }, caller);
  assert.equal(changed.status, 200);
  const relogin = await post(classicBase, 'Account_20151111.Login', {
    email: 'classic-user@synthetic.invalid',
    password: OTHER_PASSWORD,
  });
  assert.equal(relogin.status, 200);
});

// Search/Remove are implemented by this slice. CreateAccessToken is still
// unimplemented (owned by a different A-03 agent) and remains the
// proxy-fallback control.
test('unimplemented Account operations keep the unknown-target response', async () => {
  const response = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, owner);
  assert.equal(response.status, 400);
  assert.equal(response.body.__type, 'UnknownOperationException');
});

test('Account JSON omits secrets unless unsafe Create/Login projection is requested', () => {
  const account = {
    _id: 'acct-1',
    email: 'wire@synthetic.invalid',
    password: 'secret',
    activationCode: 'code',
    accessKeyId: 'access',
    secretAccessKey: 'secret-key',
    firstName: 'Wire',
    isActive: 1,
    facebookAccessToken: 'token',
    created: 1,
  };
  const safe = accountToSourceJson(account, { unsafe: false });
  assert.equal(safe.id, 'acct-1');
  assert.equal(safe._id, 'acct-1');
  assert.equal(safe.isActive, true);
  assert.equal(safe.facebookConnected, true);
  assert.ok(!('password' in safe));
  assert.ok(!('accessKeyId' in safe));
  assert.ok(!('created' in safe));
  const unsafe = accountToSourceJson(account, { unsafe: true });
  assert.equal(unsafe.accessKeyId, 'access');
  assert.equal(unsafe.secretAccessKey, 'secret-key');
});

test('gateway anonymous list is exact-target; extra-dot Create still maps after a signature', async () => {
  const lower = await post(accountBase, 'Account_20151111.create', {
    email: 'lower-create@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(lower.status, 401);
  assert.equal(lower.body.__type, 'MISSING_AUTH_HEADER');
  assert.equal(store.accountByEmail('lower-create@synthetic.invalid'), null);

  const unsignedExtra = await post(accountBase, 'Account_20151111.Create.extra', {
    email: 'extra-dot@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(unsignedExtra.status, 401);
  assert.equal(unsignedExtra.body.__type, 'MISSING_AUTH_HEADER');

  const extraDot = await post(accountBase, 'Account_20151111.Create.extra', {
    email: 'extra-dot@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  assert.equal(extraDot.status, 200, extraDot.rawBody);
  assert.equal(extraDot.body.email, 'extra-dot@synthetic.invalid');
});

test('Create/Login/Update/ChangePassword survive store reopen; rejected writes do not', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-account-persist-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  let persistService = await createAccountService({ store: persistStore }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const created = await post(persistBase, 'Account_20151111.Create', {
      email: 'persist@synthetic.invalid',
      password: PASSWORD,
      firstName: 'Persist',
    });
    assert.equal(created.status, 200, created.rawBody);
    const rejected = await post(persistBase, 'Account_20151111.Create', {
      email: 'persist@synthetic.invalid',
      password: PASSWORD,
    });
    assertAmzError(rejected, ACCOUNT_ERRORS.EMAIL_ALREADY_EXISTS);

    await new Promise((resolve, reject) => persistService.close((error) => error ? reject(error) : resolve()));
    persistService = null;
    const reopened = new Store(persistFile);
    const saved = reopened.accountByEmail('persist@synthetic.invalid');
    assert.ok(saved);
    assert.equal(saved.firstName, 'Persist');
    assert.match(saved.password, /^sha512\$512\$10000\$/);
    assert.equal(saved.isActive, false);
    assert.equal(compareAccountPassword(PASSWORD, saved.password), true);
    assert.equal([...reopened.accounts.values()].filter((account) => account.email === 'persist@synthetic.invalid').length, 1);

    saved.isActive = true;
    reopened.flush();
    const persistService2 = await createAccountService({ store: reopened }).listen(0);
    const persistBase2 = `http://127.0.0.1:${persistService2.address().port}`;
    try {
      const updated = await post(persistBase2, 'Account_20151111.Update', { firstName: 'Reloaded' }, saved);
      assert.equal(updated.status, 200);
      const changed = await post(persistBase2, 'Account_20151111.ChangePassword', {
        oldPassword: PASSWORD,
        newPassword: OTHER_PASSWORD,
      }, saved);
      assert.equal(changed.status, 200);
    } finally {
      await new Promise((resolve, reject) => persistService2.close((error) => error ? reject(error) : resolve()));
    }
    const again = new Store(persistFile);
    const after = again.accountByEmail('persist@synthetic.invalid');
    assert.equal(after.firstName, 'Reloaded');
    assert.equal(compareAccountPassword(OTHER_PASSWORD, after.password), true);
    assert.equal(compareAccountPassword(PASSWORD, after.password), false);
  } finally {
    if (persistService) {
      await new Promise((resolve) => persistService.close(() => resolve()));
    }
    rmSync(persistDir, { recursive: true, force: true });
  }
});
});
