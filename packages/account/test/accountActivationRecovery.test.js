// A-03 activation/recovery: ActivateByCode, ActivateById, ResendActivationCode,
// SendPasswordReset, PasswordResetByCode.
// Fixtures are synthetic. Source is srv-account-ws@6cea434 and srv-security-gw@43a692fe.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a03-activation-recovery-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount } = await import('../src/model.js');
const {
  ACCOUNT_ERRORS,
  compareAccountPassword,
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
let admin;
let mail;
let mailErrors;

function capturingMail() {
  return {
    send(to, options) {
      mail.push({ to, options: { ...options } });
      return Promise.resolve();
    },
  };
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

async function createInactive(email, firstName = 'Inactive') {
  const created = await post(accountBase, 'Account_20151111.Create', {
    email,
    password: PASSWORD,
    firstName,
  });
  assert.equal(created.status, 200, created.rawBody);
  return store.accountByEmail(email);
}

describe('Account activation and recovery', { concurrency: 1 }, () => {
before(async () => {
  store = new Store(storeFile);
  owner = createOwnerAccount(store, {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Owner',
  });
  admin = createOwnerAccount(store, {
    email: 'admin@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Admin',
  });
  admin.isAdmin = true;
  store.flush();
  mail = [];
  mailErrors = [];
  accountService = await createAccountService({
    store,
    invitationProviders: {
      portalUrl: 'https://portal.fixture.test',
      campaign: {
        salesforce: {
          activation: 'https://campaign.fixture.test/activate',
          resetPassword: 'https://campaign.fixture.test/reset',
        },
      },
      activation: capturingMail(),
      passwordReset: capturingMail(),
      onError(error, kind) { mailErrors.push({ message: error.message, kind }); },
    },
  }).listen(0);
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

test('Create issues a dashless activation code and fires contained activation mail', async () => {
  mail.length = 0;
  const account = await createInactive('create-mail@synthetic.invalid', 'Newbie');
  assert.equal(account.isActive, false);
  assert.equal(typeof account.activationCode, 'string');
  assert.equal(account.activationCode.includes('-'), false);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'create-mail@synthetic.invalid');
  assert.equal(mail[0].options.firstName, 'Newbie');
  assert.equal(mail[0].options.email, 'create-mail@synthetic.invalid');
  assert.equal(
    mail[0].options.url,
    `https://portal.fixture.test/activate?code=${account.activationCode}&email=create-mail%40synthetic.invalid`,
  );
});

test('ActivateByCode is public, returns unsafe keys, clears the code, and is single-use', async () => {
  const account = await createInactive('activate-code@synthetic.invalid');
  const code = account.activationCode;
  const accessKeyId = account.accessKeyId;
  const secretAccessKey = account.secretAccessKey;

  const missing = await post(accountBase, 'Account_20151111.ActivateByCode', {});
  assertHapi422(missing, 'child "code" fails because ["code" is required]');

  const unknown = await post(accountBase, 'Account_20151111.ActivateByCode', { code: 'missingcode' });
  assertAmzError(unknown, ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);

  const activated = await post(accountBase, 'Account_20151111.ActivateByCode', { code });
  assert.equal(activated.status, 200, activated.rawBody);
  assert.equal(activated.body.email, 'activate-code@synthetic.invalid');
  assert.equal(activated.body.isActive, true);
  assert.equal(activated.body.accessKeyId, accessKeyId);
  assert.equal(activated.body.secretAccessKey, secretAccessKey);
  assert.ok(!('activationCode' in activated.body));
  assert.ok(!('password' in activated.body));
  assert.equal(store.accountByEmail('activate-code@synthetic.invalid').isActive, true);
  assert.equal(store.accountByEmail('activate-code@synthetic.invalid').activationCode, undefined);

  const reused = await post(accountBase, 'Account_20151111.ActivateByCode', { code });
  assertAmzError(reused, ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);

  const got = await post(accountBase, 'Account_20151111.Get', {}, store.accountByEmail('activate-code@synthetic.invalid'));
  assert.equal(got.status, 200);
  assert.equal(got.body[0].id, activated.body.id);
});

test('ActivateByCode on an already-active leftover code is ACCOUNT_ACTIVATED', async () => {
  const account = await createInactive('already-active@synthetic.invalid');
  account.isActive = true;
  store.flush();
  const response = await post(accountBase, 'Account_20151111.ActivateByCode', { code: account.activationCode });
  assertAmzError(response, ACCOUNT_ERRORS.ACCOUNT_ACTIVATED);
  assert.equal(store.accountByEmail('already-active@synthetic.invalid').activationCode, account.activationCode);
});

test('ActivateByCode of a deleted account is ACCOUNT_IS_DELETED', async () => {
  const account = await createInactive('deleted-activate@synthetic.invalid');
  const code = account.activationCode;
  account.isDeleted = true;
  store.flush();
  try {
    const response = await post(accountBase, 'Account_20151111.ActivateByCode', { code });
    assertAmzError(response, ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  } finally {
    account.isDeleted = false;
    store.flush();
  }
});

test('signed ActivateByCode with an inactive signer is ACCOUNT_NOT_ACTIVE at the gateway', async () => {
  const account = await createInactive('signed-inactive@synthetic.invalid');
  const response = await post(accountBase, 'Account_20151111.ActivateByCode', {
    code: account.activationCode,
  }, account);
  assert.equal(response.status, 403);
  assert.equal(response.body.__type, 'ACCOUNT_NOT_ACTIVE');
  assert.equal(store.accountByEmail('signed-inactive@synthetic.invalid').isActive, false);
});

test('ActivateById requires a live admin signer; ownership is the payload id', async () => {
  const account = await createInactive('activate-id@synthetic.invalid');
  const unauth = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.__type, 'MISSING_AUTH_HEADER');

  const nonAdminMissingId = await post(accountBase, 'Account_20151111.ActivateById', {}, owner);
  assertAmzError(nonAdminMissingId, ACCOUNT_ERRORS.AUTHORIZED_UNDER_ADMIN);

  const nonAdmin = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id }, owner);
  assertAmzError(nonAdmin, ACCOUNT_ERRORS.AUTHORIZED_UNDER_ADMIN);
  assert.equal(store.accountByEmail('activate-id@synthetic.invalid').isActive, false);

  const missingId = await post(accountBase, 'Account_20151111.ActivateById', {}, admin);
  assertHapi422(missingId, 'child "id" fails because ["id" is required]');

  const unknown = await post(accountBase, 'Account_20151111.ActivateById', { id: 'missing-id' }, admin);
  assertAmzError(unknown, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);

  const activated = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id }, admin);
  assert.equal(activated.status, 200, activated.rawBody);
  assert.equal(activated.body.isActive, true);
  assert.equal(activated.body.id, account._id);
  assert.ok(!('accessKeyId' in activated.body));
  assert.ok(!('secretAccessKey' in activated.body));
  assert.ok(!('activationCode' in activated.body));
  assert.equal(store.accounts.get(account._id).isActive, true);
  assert.equal(store.accounts.get(account._id).activationCode, undefined);

  const again = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id }, admin);
  assertAmzError(again, ACCOUNT_ERRORS.ACCOUNT_ACTIVATED);

  const forged = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id }, {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: 'invented-wrong-secret',
  }, { 'x-amz-credentials': JSON.stringify({ id: admin._id, isAdmin: true }) });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');
});

test('inactive admin cannot ActivateById', async () => {
  const account = await createInactive('inactive-admin-target@synthetic.invalid');
  admin.isActive = false;
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.ActivateById', { id: account._id }, admin);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
    assert.equal(store.accountByEmail('inactive-admin-target@synthetic.invalid').isActive, false);
  } finally {
    admin.isActive = true;
    store.flush();
  }
});

test('ResendActivationCode replaces the dashless code, mails, and rejects active accounts', async () => {
  mail.length = 0;
  const account = await createInactive('resend@synthetic.invalid', 'Resend');
  const original = account.activationCode;
  mail.length = 0;

  const invalid = await post(accountBase, 'Account_20151111.ResendActivationCode', { email: 'not-an-email' });
  assertHapi422(invalid, 'child "email" fails because ["email" must be a valid email]');

  const missing = await post(accountBase, 'Account_20151111.ResendActivationCode', {
    email: 'nobody@synthetic.invalid',
  });
  assertAmzError(missing, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);

  const resent = await post(accountBase, 'Account_20151111.ResendActivationCode', {
    email: 'Resend@synthetic.invalid',
  });
  assert.equal(resent.status, 200, resent.rawBody);
  assert.equal(resent.body.email, 'resend@synthetic.invalid');
  assert.equal(resent.body.isActive, false);
  assert.ok(!('accessKeyId' in resent.body));
  assert.ok(!('activationCode' in resent.body));
  const next = store.accountByEmail('resend@synthetic.invalid');
  assert.notEqual(next.activationCode, original);
  assert.equal(next.activationCode.includes('-'), false);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].options.firstName, 'Resend');
  assert.match(mail[0].options.url, new RegExp(`code=${next.activationCode}`));

  const stale = await post(accountBase, 'Account_20151111.ActivateByCode', { code: original });
  assertAmzError(stale, ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);

  next.isActive = true;
  store.flush();
  const active = await post(accountBase, 'Account_20151111.ResendActivationCode', {
    email: 'resend@synthetic.invalid',
  });
  assertAmzError(active, ACCOUNT_ERRORS.ACCOUNT_ACTIVATED);
});

test('ResendActivationCode campaign URL and deleted/pending-email errors', async () => {
  mail.length = 0;
  const account = await createInactive('resend-campaign@synthetic.invalid');
  mail.length = 0;
  const campaign = await post(accountBase, 'Account_20151111.ResendActivationCode', {
    email: 'resend-campaign@synthetic.invalid',
    campaign: 'salesforce',
  });
  assert.equal(campaign.status, 200, campaign.rawBody);
  assert.equal(
    mail[0].options.url.startsWith('https://campaign.fixture.test/activate?'),
    true,
    mail[0].options.url,
  );

  account.isDeleted = true;
  store.flush();
  try {
    const deleted = await post(accountBase, 'Account_20151111.ResendActivationCode', {
      email: 'resend-campaign@synthetic.invalid',
    });
    assertAmzError(deleted, ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  } finally {
    account.isDeleted = false;
    store.flush();
  }

  store.emailResets.set('pending-activation', {
    _id: 'pending-activation',
    email: 'pending-activation@synthetic.invalid',
    status: 'new',
  });
  const pending = await post(accountBase, 'Account_20151111.ResendActivationCode', {
    email: 'pending-activation@synthetic.invalid',
  });
  assertAmzError(pending, ACCOUNT_ERRORS.ACCOUNT_EMAIL_CHANGE_INCOMPLETE);
});

test('SendPasswordReset issues a dashless code for active or inactive accounts', async () => {
  mail.length = 0;
  const inactive = await createInactive('reset-inactive@synthetic.invalid', 'ResetMe');
  mail.length = 0;

  const missingObject = await post(accountBase, 'Account_20151111.SendPasswordReset', {});
  assertHapi422(missingObject, 'child "email" fails because ["email" is required]');

  const invalid = await post(accountBase, 'Account_20151111.SendPasswordReset', { email: 'not-an-email' });
  assertAmzError(invalid, ACCOUNT_ERRORS.EMAIL_NOT_VALID);

  const missing = await post(accountBase, 'Account_20151111.SendPasswordReset', {
    email: 'nobody@synthetic.invalid',
  });
  assertAmzError(missing, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);

  const sent = await post(accountBase, 'Account_20151111.SendPasswordReset', {
    email: 'Reset-Inactive@synthetic.invalid',
  });
  assert.equal(sent.status, 200, sent.rawBody);
  assert.equal(sent.body.email, 'reset-inactive@synthetic.invalid');
  assert.ok(!('accessKeyId' in sent.body));
  assert.ok(!('passwordResetCode' in sent.body));
  const stored = store.accountByEmail('reset-inactive@synthetic.invalid');
  assert.equal(typeof stored.passwordResetCode, 'string');
  assert.equal(stored.passwordResetCode.includes('-'), false);
  assert.equal(stored.isActive, false);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].options.firstName, 'ResetMe');
  assert.equal(
    mail[0].options.url,
    `https://portal.fixture.test/reset?email=reset-inactive%40synthetic.invalid&code=${stored.passwordResetCode}`,
  );

  const original = stored.passwordResetCode;
  mail.length = 0;
  const campaign = await post(accountBase, 'Account_20151111.SendPasswordReset', {
    email: 'reset-inactive@synthetic.invalid',
    campaign: 'salesforce',
  });
  assert.equal(campaign.status, 200);
  const replaced = store.accountByEmail('reset-inactive@synthetic.invalid').passwordResetCode;
  assert.notEqual(replaced, original);
  assert.equal(mail[0].options.url.startsWith('https://campaign.fixture.test/reset?'), true);

  owner.passwordResetCode = undefined;
  const active = await post(accountBase, 'Account_20151111.SendPasswordReset', {
    email: 'owner@synthetic.invalid',
  });
  assert.equal(active.status, 200, active.rawBody);
  assert.equal(typeof store.accounts.get(owner._id).passwordResetCode, 'string');

  inactive.isDeleted = true;
  store.flush();
  try {
    const deleted = await post(accountBase, 'Account_20151111.SendPasswordReset', {
      email: 'reset-inactive@synthetic.invalid',
    });
    assertAmzError(deleted, ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  } finally {
    inactive.isDeleted = false;
    store.flush();
  }
});

test('PasswordResetByCode writes pbkdf2, activates, is single-use, and keeps access keys', async () => {
  const account = await createInactive('reset-by-code@synthetic.invalid');
  const sent = await post(accountBase, 'Account_20151111.SendPasswordReset', {
    email: 'reset-by-code@synthetic.invalid',
  });
  assert.equal(sent.status, 200, sent.rawBody);
  const stored = store.accountByEmail('reset-by-code@synthetic.invalid');
  const code = stored.passwordResetCode;
  const accessKeyId = stored.accessKeyId;
  const secretAccessKey = stored.secretAccessKey;

  const missing = await post(accountBase, 'Account_20151111.PasswordResetByCode', { password: OTHER_PASSWORD });
  assertHapi422(missing, 'child "code" fails because ["code" is required]');

  const weak = await post(accountBase, 'Account_20151111.PasswordResetByCode', {
    code,
    password: 'nouppercase1',
  });
  assertAmzError(weak, ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
  assert.equal(compareAccountPassword(PASSWORD, store.accountByEmail('reset-by-code@synthetic.invalid').password), true);

  const unknown = await post(accountBase, 'Account_20151111.PasswordResetByCode', {
    code: 'not-a-reset-code',
    password: OTHER_PASSWORD,
  });
  assertAmzError(unknown, ACCOUNT_ERRORS.PASSWORD_CODE_WRONG);

  const reset = await post(accountBase, 'Account_20151111.PasswordResetByCode', {
    code,
    password: OTHER_PASSWORD,
  });
  assert.equal(reset.status, 200, reset.rawBody);
  assert.equal(reset.body.isActive, true);
  assert.equal(reset.body.accessKeyId, accessKeyId);
  assert.equal(reset.body.secretAccessKey, secretAccessKey);
  assert.ok(!('password' in reset.body));
  assert.ok(!('passwordResetCode' in reset.body));
  const after = store.accountByEmail('reset-by-code@synthetic.invalid');
  assert.equal(after.isActive, true);
  assert.equal(after.passwordResetCode, undefined);
  assert.equal(after.accessKeyId, accessKeyId);
  assert.equal(after.secretAccessKey, secretAccessKey);
  assert.equal(compareAccountPassword(OTHER_PASSWORD, after.password), true);
  assert.equal(compareAccountPassword(PASSWORD, after.password), false);

  const oldLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'reset-by-code@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(oldLogin, ACCOUNT_ERRORS.WRONG_PASSWORD);
  const newLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'reset-by-code@synthetic.invalid',
    password: OTHER_PASSWORD,
  });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.body.accessKeyId, accessKeyId);

  const reused = await post(accountBase, 'Account_20151111.PasswordResetByCode', {
    code,
    password: 'ValidPass3',
  });
  assertAmzError(reused, ACCOUNT_ERRORS.PASSWORD_CODE_WRONG);

  const got = await post(accountBase, 'Account_20151111.Get', {}, after);
  assert.equal(got.status, 200);
  assert.equal(got.body[0].id, after._id);
});

test('PasswordResetByCode of a deleted account with a leftover code follows source (no isDeleted check)', async () => {
  const account = await createInactive('deleted-reset@synthetic.invalid');
  await post(accountBase, 'Account_20151111.SendPasswordReset', { email: 'deleted-reset@synthetic.invalid' });
  const code = store.accountByEmail('deleted-reset@synthetic.invalid').passwordResetCode;
  account.isDeleted = true;
  store.flush();
  const reset = await post(accountBase, 'Account_20151111.PasswordResetByCode', {
    code,
    password: OTHER_PASSWORD,
  });
  assert.equal(reset.status, 200, reset.rawBody);
  const stored = store.accountByEmail('deleted-reset@synthetic.invalid');
  assert.equal(stored.isDeleted, true);
  assert.equal(stored.isActive, true);
  assert.equal(compareAccountPassword(OTHER_PASSWORD, stored.password), true);
});

test('rejected activation and reset writes do not persist; mail rejection is contained', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-activation-persist-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  const rejectedMail = [];
  const failures = [];
  let persistService = await createAccountService({
    store: persistStore,
    invitationProviders: {
      portalUrl: 'https://portal.fixture.test',
      activation: {
        send(to, options) {
          rejectedMail.push({ kind: 'activation', to, options: { ...options } });
          return Promise.reject(new Error('smtp down'));
        },
      },
      passwordReset: {
        send(to, options) {
          rejectedMail.push({ kind: 'passwordReset', to, options: { ...options } });
          return Promise.reject(new Error('smtp down'));
        },
      },
      onError(error, kind) { failures.push(kind); },
    },
  }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const created = await post(persistBase, 'Account_20151111.Create', {
      email: 'persist-activate@synthetic.invalid',
      password: PASSWORD,
      firstName: 'Persist',
    });
    assert.equal(created.status, 200, created.rawBody);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejectedMail.some((item) => item.kind === 'activation'), true);
    assert.equal(failures.includes('activation-mail'), true);

    const unknownActivate = await post(persistBase, 'Account_20151111.ActivateByCode', { code: 'nope' });
    assertAmzError(unknownActivate, ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);

    const code = persistStore.accountByEmail('persist-activate@synthetic.invalid').activationCode;
    const activated = await post(persistBase, 'Account_20151111.ActivateByCode', { code });
    assert.equal(activated.status, 200, activated.rawBody);

    const sent = await post(persistBase, 'Account_20151111.SendPasswordReset', {
      email: 'persist-activate@synthetic.invalid',
    });
    assert.equal(sent.status, 200, sent.rawBody);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.includes('password-reset-mail'), true);
    const resetCode = persistStore.accountByEmail('persist-activate@synthetic.invalid').passwordResetCode;
    const reset = await post(persistBase, 'Account_20151111.PasswordResetByCode', {
      code: resetCode,
      password: OTHER_PASSWORD,
    });
    assert.equal(reset.status, 200, reset.rawBody);

    await new Promise((resolve, reject) => persistService.close((error) => error ? reject(error) : resolve()));
    persistService = null;
    const reopened = new Store(persistFile);
    const saved = reopened.accountByEmail('persist-activate@synthetic.invalid');
    assert.equal(saved.isActive, true);
    assert.equal(saved.activationCode, undefined);
    assert.equal(saved.passwordResetCode, undefined);
    assert.equal(compareAccountPassword(OTHER_PASSWORD, saved.password), true);
    assert.equal(compareAccountPassword(PASSWORD, saved.password), false);
  } finally {
    if (persistService) {
      await new Promise((resolve) => persistService.close(() => resolve()));
    }
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('activation and recovery share the Classic proxy boundary', async () => {
  const created = await post(classicBase, 'Account_20151111.Create', {
    email: 'classic-activate@synthetic.invalid',
    password: PASSWORD,
    firstName: 'Classic',
  });
  assert.equal(created.status, 200, created.rawBody);
  const stored = store.accountByEmail('classic-activate@synthetic.invalid');
  const activated = await post(classicBase, 'Account_20151111.ActivateByCode', {
    code: stored.activationCode,
  });
  assert.equal(activated.status, 200, activated.rawBody);
  assert.equal(activated.body.isActive, true);

  const reset = await post(classicBase, 'Account_20151111.SendPasswordReset', {
    email: 'classic-activate@synthetic.invalid',
  });
  assert.equal(reset.status, 200, reset.rawBody);
  const code = store.accountByEmail('classic-activate@synthetic.invalid').passwordResetCode;
  const changed = await post(classicBase, 'Account_20151111.PasswordResetByCode', {
    code,
    password: OTHER_PASSWORD,
  });
  assert.equal(changed.status, 200, changed.rawBody);

  const byId = await post(classicBase, 'Account_20151111.Create', {
    email: 'classic-admin-activate@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(byId.status, 200, byId.rawBody);
  const target = store.accountByEmail('classic-admin-activate@synthetic.invalid');
  const adminActivate = await post(classicBase, 'Account_20151111.ActivateById', { id: target._id }, admin);
  assert.equal(adminActivate.status, 200, adminActivate.rawBody);
  assert.equal(adminActivate.body.isActive, true);
});

test('exact-target anonymous list; extra-dot ActivateByCode still requires a signature', async () => {
  const lower = await post(accountBase, 'Account_20151111.activateByCode', { code: 'nope' });
  assert.equal(lower.status, 401);
  assert.equal(lower.body.__type, 'MISSING_AUTH_HEADER');

  const extra = await post(accountBase, 'Account_20151111.ActivateByCode.extra', { code: 'nope' });
  assert.equal(extra.status, 401);
  assert.equal(extra.body.__type, 'MISSING_AUTH_HEADER');
});

// Search/Remove are implemented; CreateAccessToken is still genuinely
// unimplemented (owned by a different A-03 agent) and remains the
// proxy-fallback control.
test('unimplemented Account operations keep the unknown-target response', async () => {
  const response = await post(accountBase, 'Account_20151111.CreateAccessToken', {}, owner);
  assert.equal(response.status, 400);
  assert.equal(response.body.__type, 'UnknownOperationException');
});
});
