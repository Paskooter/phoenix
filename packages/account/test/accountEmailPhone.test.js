// A-03 email/phone/terms slice: ChangeEmail, ResetEmail, ConfirmEmailReset,
// SendPhoneVerificationCode, VerifyPhoneByCode, AcceptTerms.
// Fixtures are synthetic. Source is srv-account-ws@6cea434 and srv-security-gw@43a692fe.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a03-email-phone-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const {
  ACCOUNT_ERRORS,
  EMAIL_RESET_STATUS,
  TOKEN_ERRORS,
  randomPhoneVerificationCode,
} = await import('../src/accountIdentity.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

const PASSWORD = 'ValidPass1';
const OTHER_PASSWORD = 'ValidPass2';
const AUTHORIZED_UNDER_ADMIN = {
  code: 'AUTHORIZED_UNDER_ADMIN',
  message: 'Must be authorized under admin account',
  statusCode: 401,
};

let store;
let accountService;
let accountBase;
let classicService;
let classicBase;
let owner;
let outsider;
let admin;
let mail;
let sms;

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
  assert.equal(response.status, definition.statusCode);
  assert.equal(response.body.__type, definition.code);
  assert.equal(response.body.message, definition.message);
  assert.equal(response.headers['x-amzn-errortype'], definition.code);
}

function live(account) {
  return store.accounts.get(account._id);
}

describe('Account email/phone/terms slice', { concurrency: 1 }, () => {
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
  createLoop(store, { owner, robotId: 'a03-email-phone-robot' });
  mail = [];
  sms = [];
  accountService = await createAccountService({
    store,
    identityProviders: {
      portalUrl: 'http://portal.synthetic.invalid',
      emailReset: { send(to, options) { mail.push({ template: 'emailReset', to, options }); } },
      emailResetComplete: { send(to, options) { mail.push({ template: 'emailResetComplete', to, options }); } },
      sms: { send(payload) { sms.push(payload); } },
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

test('phone verification codes are six decimal digits from randomBytes % 10', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(randomPhoneVerificationCode(), /^\d{6}$/);
  }
});

test('ChangeEmail writes a pending reset row, keeps the old email live, and returns the reset id', async () => {
  mail.length = 0;
  const beforeEmail = live(owner).email;
  const beforeKeys = { accessKeyId: live(owner).accessKeyId, secretAccessKey: live(owner).secretAccessKey };
  const changed = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'New.Owner@synthetic.invalid',
    password: PASSWORD,
    campaign: 'ignored-missing',
  }, owner);
  assert.equal(changed.status, 200, changed.rawBody);
  assert.equal(typeof changed.body.id, 'string');
  assert.notEqual(changed.body.id, owner._id);
  const reset = store.emailResets.get(changed.body.id);
  assert.ok(reset);
  assert.equal(reset.email, 'new.owner@synthetic.invalid');
  assert.equal(reset.originalEmail, beforeEmail);
  assert.equal(reset.status, EMAIL_RESET_STATUS.NEW);
  assert.equal(reset.accountId, owner._id);
  assert.match(reset.code, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(live(owner).email, beforeEmail);
  assert.equal(live(owner).accessKeyId, beforeKeys.accessKeyId);

  const oldLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(oldLogin.status, 200);
  assert.equal(oldLogin.body.email, 'owner@synthetic.invalid');

  const pendingLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'new.owner@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(pendingLogin, ACCOUNT_ERRORS.ACCOUNT_EMAIL_CHANGE_INCOMPLETE);

  assert.equal(mail.length, 2);
  assert.equal(mail[0].template, 'emailReset');
  assert.equal(mail[0].to, 'new.owner@synthetic.invalid');
  assert.match(mail[0].options.url, /http:\/\/portal\.synthetic\.invalid\/confirmemailreset\?/);
  assert.match(mail[0].options.url, new RegExp(`code=${reset.code}`));
  assert.equal(mail[1].template, 'emailResetComplete');
  assert.equal(mail[1].to, 'owner@synthetic.invalid');
  assert.equal(mail[1].options.newEmailAddress, 'new.owner@synthetic.invalid');
});

test('ChangeEmail rejects unsigned, forged, inactive, wrong-password, unchanged, taken, and invalid payloads', async () => {
  const unsigned = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'unsigned@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const forged = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'forged@synthetic.invalid',
    password: PASSWORD,
  }, { accessKeyId: owner.accessKeyId, secretAccessKey: 'invented-wrong-secret' });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');

  const inactive = Object.assign(live(owner), { isActive: false });
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.ChangeEmail', {
      email: 'inactive@synthetic.invalid',
      password: PASSWORD,
    }, owner);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
  } finally {
    inactive.isActive = true;
    store.flush();
  }

  const wrong = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'wrong-pass@synthetic.invalid',
    password: OTHER_PASSWORD,
  }, owner);
  assertAmzError(wrong, ACCOUNT_ERRORS.WRONG_PASSWORD);

  const same = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'Owner@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  assertAmzError(same, ACCOUNT_ERRORS.EMAIL_WAS_NOT_CHANGED);

  const taken = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'outsider@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  assertAmzError(taken, ACCOUNT_ERRORS.EMAIL_ALREADY_EXISTS);

  const invalid = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'not-an-email',
    password: PASSWORD,
  }, owner);
  assertHapi422(invalid, 'child "email" fails because ["email" must be a valid email]');

  const missing = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'missing-pass@synthetic.invalid',
  }, owner);
  assertHapi422(missing, 'child "password" fails because ["password" is required]');
});

test('ConfirmEmailReset is public, rotates keys, stamps USED/CANCELED, and rejects reuse/expiry', async () => {
  const first = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'owner-confirm-a@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  const second = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'owner-confirm-b@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  const firstRow = store.emailResets.get(first.body.id);
  const secondRow = store.emailResets.get(second.body.id);
  const oldKeys = { accessKeyId: live(owner).accessKeyId, secretAccessKey: live(owner).secretAccessKey };

  const missing = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: 'no-such-code' });
  assertAmzError(missing, TOKEN_ERRORS.EMAIL_RESET_TOKEN_NOT_FOUND);

  const invalid = await post(accountBase, 'Account_20151111.ConfirmEmailReset', {});
  assertHapi422(invalid, 'child "code" fails because ["code" is required]');

  const confirmed = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: firstRow.code });
  assert.equal(confirmed.status, 200, confirmed.rawBody);
  assert.equal(confirmed.rawBody, '');
  assert.equal(live(owner).email, 'owner-confirm-a@synthetic.invalid');
  assert.notEqual(live(owner).accessKeyId, oldKeys.accessKeyId);
  assert.notEqual(live(owner).secretAccessKey, oldKeys.secretAccessKey);
  assert.equal(store.emailResets.get(first.body.id).status, EMAIL_RESET_STATUS.USED);
  assert.equal(store.emailResets.get(second.body.id).status, EMAIL_RESET_STATUS.CANCELED);

  const oldLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner@synthetic.invalid',
    password: PASSWORD,
  });
  assertAmzError(oldLogin, ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);
  const newLogin = await post(accountBase, 'Account_20151111.Login', {
    email: 'owner-confirm-a@synthetic.invalid',
    password: PASSWORD,
  });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.body.accessKeyId, live(owner).accessKeyId);

  const staleSigner = await post(accountBase, 'Account_20151111.Get', {}, owner);
  assert.equal(staleSigner.status, 401);
  assert.equal(staleSigner.body.__type, 'ACCESS_KEY_NOT_FOUND');
  owner = live(owner);

  const reused = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: firstRow.code });
  assertAmzError(reused, TOKEN_ERRORS.EMAIL_RESET_TOKEN_EXPIRED);
  const canceled = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: secondRow.code });
  assertAmzError(canceled, TOKEN_ERRORS.EMAIL_RESET_TOKEN_EXPIRED);

  const aged = await post(accountBase, 'Account_20151111.ChangeEmail', {
    email: 'owner-aged@synthetic.invalid',
    password: PASSWORD,
  }, owner);
  const agedRow = store.emailResets.get(aged.body.id);
  agedRow.created = Date.now() - 86400000 - 1;
  store.flush();
  const expired = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: agedRow.code });
  assertAmzError(expired, TOKEN_ERRORS.EMAIL_RESET_TOKEN_EXPIRED);
  assert.equal(live(owner).email, 'owner-confirm-a@synthetic.invalid');

  const forged = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: agedRow.code }, {
    accessKeyId: owner.accessKeyId,
    secretAccessKey: 'invented-wrong-secret',
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');
});

test('ResetEmail is admin-only, does not lowercase before EMAIL_WAS_NOT_CHANGED, and rewrites a deleted occupant', async () => {
  const unsigned = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'admin-reset@synthetic.invalid',
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const nonAdmin = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'admin-reset@synthetic.invalid',
  }, owner);
  assertAmzError(nonAdmin, AUTHORIZED_UNDER_ADMIN);

  const forgedAdmin = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'admin-reset@synthetic.invalid',
  }, owner, { 'x-amz-credentials': JSON.stringify({ id: admin._id, isAdmin: true }) });
  assertAmzError(forgedAdmin, AUTHORIZED_UNDER_ADMIN);

  const badSignature = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'admin-reset@synthetic.invalid',
  }, { accessKeyId: admin.accessKeyId, secretAccessKey: 'invented-wrong-secret' });
  assert.equal(badSignature.status, 401);
  assert.equal(badSignature.body.__type, 'SIGNATURE_MISMATCH');

  const unchanged = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'outsider@synthetic.invalid',
  }, admin);
  assertAmzError(unchanged, ACCOUNT_ERRORS.EMAIL_WAS_NOT_CHANGED);

  const mixedCaseSame = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'Outsider@synthetic.invalid',
  }, admin);
  assert.equal(mixedCaseSame.status, 200, mixedCaseSame.rawBody);
  assert.equal(store.emailResets.get(mixedCaseSame.body.id).email, 'outsider@synthetic.invalid');

  const deleted = createOwnerAccount(store, {
    email: 'deleted-occupant@synthetic.invalid',
    password: PASSWORD,
  });
  deleted.isDeleted = true;
  store.flush();
  const reused = await post(accountBase, 'Account_20151111.ResetEmail', {
    id: outsider._id,
    email: 'deleted-occupant@synthetic.invalid',
  }, admin);
  assert.equal(reused.status, 200, reused.rawBody);
  assert.equal(store.accounts.get(deleted._id).email, `deleted-occupant@synthetic.invalid-reused-by-${outsider._id}`);
  const reset = store.emailResets.get(reused.body.id);
  assert.equal(reset.accountId, outsider._id);
  assert.equal(reset.email, 'deleted-occupant@synthetic.invalid');
  assert.equal(live(outsider).email, 'outsider@synthetic.invalid');

  const confirmed = await post(accountBase, 'Account_20151111.ConfirmEmailReset', { code: reset.code });
  assert.equal(confirmed.status, 200);
  assert.equal(live(outsider).email, 'deleted-occupant@synthetic.invalid');
  outsider = live(outsider);

  const missingId = await post(accountBase, 'Account_20151111.ResetEmail', {
    email: 'needs-id@synthetic.invalid',
  }, admin);
  assertHapi422(missingId, 'child "id" fails because ["id" is required]');
});

test('SendPhoneVerificationCode stores a 6-digit row and VerifyPhoneByCode is latest-only, 10-minute, single-use', async () => {
  sms.length = 0;
  const first = await post(accountBase, 'Account_20151111.SendPhoneVerificationCode', {
    phoneNumber: '+15555550100',
  }, owner);
  assert.equal(first.status, 200, first.rawBody);
  assert.equal(typeof first.body.id, 'string');
  const firstRow = store.phoneVerifications.get(first.body.id);
  assert.equal(firstRow.accountId, owner._id);
  assert.equal(firstRow.phoneNumber, '+15555550100');
  assert.match(firstRow.code, /^\d{6}$/);
  assert.deepEqual(sms[0], { to: '+15555550100', body: `Jibo verification code: ${firstRow.code}` });

  const second = await post(accountBase, 'Account_20151111.SendPhoneVerificationCode', {
    phoneNumber: '+15555550101',
  }, owner);
  const secondRow = store.phoneVerifications.get(second.body.id);
  assert.match(secondRow.code, /^\d{6}$/);

  const unsigned = await post(accountBase, 'Account_20151111.SendPhoneVerificationCode', {
    phoneNumber: '+15555550999',
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const missingPhone = await post(accountBase, 'Account_20151111.SendPhoneVerificationCode', {}, owner);
  assertHapi422(missingPhone, 'child "phoneNumber" fails because ["phoneNumber" is required]');

  const staleCode = await post(accountBase, 'Account_20151111.VerifyPhoneByCode', { code: firstRow.code }, owner);
  assertAmzError(staleCode, TOKEN_ERRORS.PHONE_TOKEN_EXPIRED);
  assert.equal(live(owner).phoneNumber, undefined);

  const unknown = await post(accountBase, 'Account_20151111.VerifyPhoneByCode', { code: '000000' }, owner);
  assertAmzError(unknown, TOKEN_ERRORS.PHONE_TOKEN_NOT_FOUND);

  secondRow.created = Date.now() - (1000 * 60 * 10) - 1;
  store.flush();
  const expired = await post(accountBase, 'Account_20151111.VerifyPhoneByCode', { code: secondRow.code }, owner);
  assertAmzError(expired, TOKEN_ERRORS.PHONE_TOKEN_EXPIRED);

  const fresh = await post(accountBase, 'Account_20151111.SendPhoneVerificationCode', {
    phoneNumber: '+15555550102',
  }, owner);
  const freshRow = store.phoneVerifications.get(fresh.body.id);
  const verified = await post(accountBase, 'Account_20151111.VerifyPhoneByCode', { code: freshRow.code }, owner);
  assert.equal(verified.status, 200, verified.rawBody);
  assert.equal(verified.body.phoneNumber, '+15555550102');
  assert.equal(verified.body.id, owner._id);
  assert.ok(!('accessKeyId' in verified.body));
  assert.ok(!('secretAccessKey' in verified.body));
  assert.equal(live(owner).phoneNumber, '+15555550102');
  assert.equal([...store.phoneVerifications.values()].filter((row) => row.accountId === owner._id).length, 0);

  const reused = await post(accountBase, 'Account_20151111.VerifyPhoneByCode', { code: freshRow.code }, owner);
  assertAmzError(reused, TOKEN_ERRORS.PHONE_TOKEN_NOT_FOUND);
});

test('SendPhoneVerificationCode keeps the row when the SMS provider fails', async () => {
  const failing = await createAccountService({
    store,
    identityProviders: {
      sms: {
        send() {
          throw new Error('twilio down');
        },
      },
    },
  }).listen(0);
  const base = `http://127.0.0.1:${failing.address().port}`;
  try {
    const before = store.phoneVerifications.size;
    const response = await post(base, 'Account_20151111.SendPhoneVerificationCode', {
      phoneNumber: '+15555550900',
    }, owner);
    assertAmzError(response, ACCOUNT_ERRORS.PHONE_VERIFICATION_SERVICE_FAILED);
    assert.equal(store.phoneVerifications.size, before + 1);
    const row = [...store.phoneVerifications.values()].find((item) => item.phoneNumber === '+15555550900');
    assert.ok(row);
    assert.equal(row.accountId, owner._id);
  } finally {
    await new Promise((resolve) => failing.close(() => resolve()));
  }
});

test('AcceptTerms stamps termsAccepted, overwrites on a later call, and requires a live signature', async () => {
  const unsigned = await post(accountBase, 'Account_20151111.AcceptTerms', {});
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

  const first = await post(accountBase, 'Account_20151111.AcceptTerms', {}, owner);
  assert.equal(first.status, 200, first.rawBody);
  assert.equal(typeof first.body.termsAccepted, 'number');
  assert.ok(first.body.termsAccepted > 0);
  assert.equal(first.body.id, owner._id);
  assert.ok(!('accessKeyId' in first.body));
  const firstStamp = live(owner).termsAccepted;

  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await post(accountBase, 'Account_20151111.AcceptTerms', {}, owner);
  assert.equal(second.status, 200);
  assert.ok(second.body.termsAccepted >= firstStamp);
  assert.ok(live(owner).termsAccepted >= firstStamp);

  const inactive = Object.assign(live(owner), { isActive: false });
  store.flush();
  try {
    const blocked = await post(accountBase, 'Account_20151111.AcceptTerms', {}, owner);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.__type, 'ACCOUNT_NOT_ACTIVE');
  } finally {
    inactive.isActive = true;
    store.flush();
  }
});

test('email reset, phone number, and termsAccepted survive store reopen; rejected writes do not', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'phx-a03-email-phone-persist-'));
  const persistFile = join(persistDir, 'store.json');
  const persistStore = new Store(persistFile);
  const persistOwner = createOwnerAccount(persistStore, {
    email: 'persist-owner@synthetic.invalid',
    password: PASSWORD,
  });
  persistOwner.isAdmin = true;
  persistStore.flush();
  let persistService = await createAccountService({
    store: persistStore,
    identityProviders: {
      portalUrl: 'http://portal.synthetic.invalid',
      sms: { send() {} },
    },
  }).listen(0);
  const persistBase = `http://127.0.0.1:${persistService.address().port}`;
  try {
    const changed = await post(persistBase, 'Account_20151111.ChangeEmail', {
      email: 'persist-new@synthetic.invalid',
      password: PASSWORD,
    }, persistOwner);
    assert.equal(changed.status, 200, changed.rawBody);
    const rejected = await post(persistBase, 'Account_20151111.ChangeEmail', {
      email: 'persist-owner@synthetic.invalid',
      password: PASSWORD,
    }, persistOwner);
    assertAmzError(rejected, ACCOUNT_ERRORS.EMAIL_WAS_NOT_CHANGED);
    const sent = await post(persistBase, 'Account_20151111.SendPhoneVerificationCode', {
      phoneNumber: '+15555550800',
    }, persistOwner);
    const phoneRow = persistStore.phoneVerifications.get(sent.body.id);
    const verified = await post(persistBase, 'Account_20151111.VerifyPhoneByCode', { code: phoneRow.code }, persistOwner);
    assert.equal(verified.status, 200);
    const terms = await post(persistBase, 'Account_20151111.AcceptTerms', {}, persistOwner);
    assert.equal(terms.status, 200);

    await new Promise((resolve, reject) => persistService.close((error) => error ? reject(error) : resolve()));
    persistService = null;
    const reopened = new Store(persistFile);
    const saved = reopened.accountByEmail('persist-owner@synthetic.invalid');
    assert.ok(saved);
    assert.equal(saved.phoneNumber, '+15555550800');
    assert.equal(typeof saved.termsAccepted, 'number');
    const pending = [...reopened.emailResets.values()].find((row) => row._id === changed.body.id);
    assert.ok(pending);
    assert.equal(pending.email, 'persist-new@synthetic.invalid');
    assert.equal(pending.status, EMAIL_RESET_STATUS.NEW);
    assert.equal(reopened.phoneVerifications.size, 0);

    const persistService2 = await createAccountService({ store: reopened }).listen(0);
    const persistBase2 = `http://127.0.0.1:${persistService2.address().port}`;
    try {
      const confirmed = await post(persistBase2, 'Account_20151111.ConfirmEmailReset', { code: pending.code });
      assert.equal(confirmed.status, 200);
    } finally {
      await new Promise((resolve, reject) => persistService2.close((error) => error ? reject(error) : resolve()));
    }
    const again = new Store(persistFile);
    assert.equal(again.accountByEmail('persist-new@synthetic.invalid')._id, persistOwner._id);
    assert.equal(again.accountByEmail('persist-owner@synthetic.invalid'), null);
    assert.equal(again.emailResets.get(pending._id).status, EMAIL_RESET_STATUS.USED);
  } finally {
    if (persistService) {
      await new Promise((resolve) => persistService.close(() => resolve()));
    }
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('the six operations share the Classic proxy boundary', async () => {
  const caller = createOwnerAccount(store, {
    email: 'classic-email@synthetic.invalid',
    password: PASSWORD,
  });
  const changed = await post(classicBase, 'Account_20151111.ChangeEmail', {
    email: 'classic-new@synthetic.invalid',
    password: PASSWORD,
  }, caller);
  assert.equal(changed.status, 200, changed.rawBody);
  const reset = store.emailResets.get(changed.body.id);
  const confirmed = await post(classicBase, 'Account_20151111.ConfirmEmailReset', { code: reset.code });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.rawBody, '');
  const refreshed = live(caller);
  const phone = await post(classicBase, 'Account_20151111.SendPhoneVerificationCode', {
    phoneNumber: '+15555550700',
  }, refreshed);
  assert.equal(phone.status, 200, phone.rawBody);
  const phoneRow = store.phoneVerifications.get(phone.body.id);
  const verified = await post(classicBase, 'Account_20151111.VerifyPhoneByCode', { code: phoneRow.code }, refreshed);
  assert.equal(verified.body.phoneNumber, '+15555550700');
  const terms = await post(classicBase, 'Account_20151111.AcceptTerms', {}, refreshed);
  assert.equal(typeof terms.body.termsAccepted, 'number');
  const adminReset = await post(classicBase, 'Account_20151111.ResetEmail', {
    id: refreshed._id,
    email: 'classic-admin@synthetic.invalid',
  }, admin);
  assert.equal(adminReset.status, 200, adminReset.rawBody);
});

test('local HTTP SMS seam posts the source message shape and never uses Twilio', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        url: req.url,
        method: req.method,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { createHttpSmsProvider } = await import('../src/accountIdentity.js');
  const smsService = await createAccountService({
    store,
    identityProviders: {
      sms: createHttpSmsProvider({ url: `http://127.0.0.1:${server.address().port}/sms` }),
    },
  }).listen(0);
  try {
    const response = await post(`http://127.0.0.1:${smsService.address().port}`, 'Account_20151111.SendPhoneVerificationCode', {
      phoneNumber: '+15555550600',
    }, owner);
    assert.equal(response.status, 200, response.rawBody);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].body.to, '+15555550600');
    assert.match(received[0].body.body, /^Jibo verification code: \d{6}$/);
  } finally {
    await new Promise((resolve) => smsService.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
});
