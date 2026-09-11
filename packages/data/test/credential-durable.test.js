// D-02 candidate tests — credential CRUD, uniqueness and durable state.
//
// Fixtures are ported 1:1 from the pinned reference tree
// (5c0a7390539663ba749d360de348a428c088505c):
//   packages/lasso/tests/credential/Credential.test.ts
//   packages/lasso/tests/credential/Credential.deletion.test.ts
// The reference tests stub the OAuth exchange with nock; here RedeemStore
// overrides CredentialStore._redeem the same way (canonical test tokens).
// The reference unique compound index (accountId, skillId, serviceName,
// serviceAccountName, scopes) is reproduced by the store's 5-tuple key.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialStore, credentialQueryFromParams } from '../src/credentials.js';
import { createDataService } from '../src/index.js';

const GOOGLE_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_READWRITE = 'https://www.googleapis.com/auth/calendar.readwrite';
const GOOGLE_CLIENT_ID = '668620580899';
const OUTLOOK_CLIENT_ID = 'c3d45ff5-07c5-466c-b785-de98f4207281';
const REDIRECT_URI = 'http://test-redirect-uri-2.com';

// Base credentials carry NO tokens by default (authCode path); callers that
// need the direct-token path spread googleTokens()/outlookTokens().
const googleCred = (over = {}) => ({
  accountId: 'acct9', skillId: 'report-skill', serviceName: 'google',
  serviceAccountName: 'personalCalendar', scopes: [GOOGLE_READONLY],
  clientId: GOOGLE_CLIENT_ID, redirectUri: REDIRECT_URI, ...over,
});
const googleTokens = () => ({
  accessToken: 'googleAccessToken2', refreshToken: 'googleRefreshToken2', expiresAt: Date.now() + 3600 * 1000,
});
const outlookCred = (over = {}) => ({
  accountId: 'acct9', skillId: 'report-skill', serviceName: 'outlook',
  serviceAccountName: 'personalCalendar', scopes: ['offline_access', 'Calendars.Read'],
  clientId: OUTLOOK_CLIENT_ID, redirectUri: REDIRECT_URI, ...over,
});
const outlookTokens = () => ({
  accessToken: 'outlookAccessToken2', refreshToken: 'outlookRefreshToken2', expiresAt: Date.now() + 3600 * 1000,
});

/** Test double for the reference's nocked Google/Outlook token endpoints. */
class RedeemStore extends CredentialStore {
  _redeem(cred) {
    cred.oauth2.accessToken = 'canonicalAccessToken';
    cred.oauth2.refreshToken = 'canonicalRefreshToken';
    cred.oauth2.expiresAt = Date.now() + 3600 * 1000;
  }
}

const tmpDir = () => mkdtempSync(join(tmpdir(), 'phoenix-data-creds-'));

// The default store is now durable (packages/data/data/credentials.json), so a
// bare `new CredentialStore()` would share one snapshot across tests. Each test
// gets its own file; the env/default-resolution tests below opt in explicitly.
const ROOT = mkdtempSync(join(tmpdir(), 'phoenix-data-creds-root-'));
let seq = 0;
const nextFile = () => join(ROOT, `credentials-${++seq}.json`);
const plainStore = (opts = {}) => new CredentialStore({ file: nextFile(), ...opts });
const redeemStore = (opts = {}) => new RedeemStore({ file: nextFile(), ...opts });
/** A store that resolves its file from the env override / built-in default. */
const defaultStore = () => new CredentialStore();

// ---------------------------------------------------------------------------
// Credential.test.ts — POST store / replace / duplicate / scope coexistence
// ---------------------------------------------------------------------------

test('D2 store google:personalCalendar with authCode (Credential.test.ts #1)', () => {
  const s = redeemStore();
  const data = googleCred({ accountId: 'account10', skillId: 'skill10', authCode: 'authCode' });
  const c = s.save(data);
  assert.equal(c.oauth2.authCode, 'authCode');
  const found = s.find(data);
  assert.equal(found.oauth2.authCode, 'authCode');
  assert.equal(found.oauth2.accessToken, 'canonicalAccessToken');
  assert.equal(found.oauth2.refreshToken, 'canonicalRefreshToken');
  assert.ok(Math.abs(found.oauth2.expiresAt - (Date.now() + 3600 * 1000)) < 500);
});

test('D2 replace credential with a NEW authCode in the same slot (#2)', () => {
  const s = redeemStore();
  const accountParams = { accountId: 'account3', skillId: 'skill3' };
  const c1 = googleCred({ ...accountParams, authCode: 'authCode1' });
  const c2 = googleCred({ ...accountParams, authCode: 'authCode2' });
  assert.equal(s.save(c1).oauth2.authCode, 'authCode1');
  assert.equal(s.save(c2).oauth2.authCode, 'authCode2');
  assert.equal(s.find(c1).oauth2.authCode, 'authCode2', 'same slot keeps the newest authCode');
  assert.equal(s.find(c1).oauth2.accessToken, 'canonicalAccessToken', 'redeem ran for the second code');
});

test('D2 same slot with OTHER scopes coexist under the 5-tuple unique key (#3)', () => {
  const s = redeemStore();
  const accountParams = { accountId: 'account4', skillId: 'skill4', serviceAccountName: 'personalCalendar' };
  const c1 = googleCred({ ...accountParams, scopes: [GOOGLE_READONLY], authCode: 'authCode1' });
  const c2 = googleCred({ ...accountParams, scopes: [GOOGLE_READWRITE], authCode: 'authCode2' });
  s.save(c1);
  s.save(c2);
  const f1 = s.find(c1);
  const f2 = s.find(c2);
  assert.equal(f1.oauth2.authCode, 'authCode1');
  assert.equal(f1.scopes[0], GOOGLE_READONLY);
  assert.equal(f2.oauth2.authCode, 'authCode2');
  assert.equal(f2.scopes[0], GOOGLE_READWRITE);
  assert.equal(s.m.size, 2, 'two distinct scopes => two stored credentials');
});

test('D2 store with accessToken/refreshToken skips the exchange and keeps slots (#4)', () => {
  const s = redeemStore();
  const data = googleCred({
    accountId: 'account11', skillId: 'skill11',
    accessToken: 'testAccessToken', refreshToken: 'testRefreshToken', expiresAt: Date.now() + 3600 * 1000,
  });
  const c = s.save(data);
  assert.equal(c.oauth2.accessToken, 'testAccessToken');
  assert.equal(c.oauth2.refreshToken, 'testRefreshToken');
  assert.ok(c.oauth2.expiresAt);
});

test('D2 duplicate authCode -> DUPLICATE_KEY (11000), leave slot intact (#5)', () => {
  const s = redeemStore();
  const accountParams = { accountId: 'account5', skillId: 'skill5' };
  const data1 = googleCred({ ...accountParams, authCode: 'authCode' });
  const data2 = googleCred({ ...accountParams, authCode: 'authCode' });
  s.save(data1);
  assert.throws(() => s.save(data2), (e) => e.code === 'DUPLICATE_KEY' && /already exists/.test(e.message));
  assert.deepEqual(s.checkExists(data1), { credentialExists: true });
  assert.equal(s.m.size, 1);
});

test('D2 testAuthCode stores without a token exchange (#6)', () => {
  const s = plainStore();
  const data = googleCred({ accountId: 'account12', skillId: 'skill12', serviceAccountName: 'workCalendar', authCode: 'testAuthCode' });
  const c = s.save(data);
  assert.equal(c.oauth2.accessToken, 'testAccessToken');
  assert.equal(c.oauth2.refreshToken, 'testRefreshToken');
});

test('D2 outlook credential stored under its own clientId (#7/#8)', () => {
  const s = redeemStore();
  const data = outlookCred({ accountId: 'account13', skillId: 'skill13', serviceAccountName: 'workCalendar', authCode: 'authCode' });
  const c = s.save(data);
  assert.equal(c.serviceName, 'outlook');
  assert.equal(c.serviceAccountName, 'workCalendar');
  assert.equal(c.oauth2.authCode, 'authCode');
  assert.equal(c.oauth2.clientId, OUTLOOK_CLIENT_ID);
});

test('D2 redirectUri is stored for authCode and token arrivals (#9/#10)', () => {
  const s = redeemStore();
  const a = s.save(googleCred({ accountId: 'account5', serviceAccountName: 'workCalendar', authCode: 'authCode6', redirectUri: 'http://test-redirect-uri-1.com' }));
  assert.equal(a.oauth2.redirectUri, 'http://test-redirect-uri-1.com');
  const b = s.save(googleCred({ accountId: 'account6', serviceAccountName: 'workCalendar', accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 1000, redirectUri: 'http://test-redirect-uri-2.com' }));
  assert.equal(b.oauth2.redirectUri, 'http://test-redirect-uri-2.com');
});

test('D2 required fields: accountId/skillId/serviceName/serviceAccountName/scopes/clientId', () => {
  const s = redeemStore();
  assert.throws(() => s.save(googleCred({ accountId: null })), /Missing accountId in request/);
  assert.throws(() => s.save(googleCred({ skillId: null })), /Missing skillId in request/);
  assert.throws(() => s.save(googleCred({ serviceName: null })), /Missing serviceName in request/);
  assert.throws(() => s.save(googleCred({ serviceAccountName: null })), /Missing serviceAccountName in request/);
  assert.throws(() => s.save(googleCred({ scopes: null })), /Missing scopes in request/);
  assert.throws(() => s.save(googleCred({ clientId: null })), /Missing clientId in request/);
  assert.throws(() => s.save(googleCred({ authCode: '' })), /Missing authCode or tokens/);
  assert.throws(() => s.save(googleCred({ scopes: [] })), /Scopes should be not empty array/);
  assert.throws(() => s.save(googleCred({ scopes: 'read' })), /Scopes should be an array/);
  assert.throws(() => s.save(googleCred({ scopes: ['read', 3] })), /Scopes should be strings/);
});

// ---------------------------------------------------------------------------
// Credential.test.ts — GET lookup semantics
// ---------------------------------------------------------------------------

test('D2 GET: exists, reordered scopes, fewer scopes, extra/non-matching scopes, wrong ids', () => {
  const s = redeemStore();
  const data = outlookCred({ accountId: 'account8', skillId: 'skill8', authCode: 'testAuthCode' });
  s.save(data);
  assert.deepEqual(s.checkExists(data), { credentialExists: true });
  assert.deepEqual(s.checkExists({ ...data, scopes: ['Calendars.Read', 'offline_access'] }), { credentialExists: true }, 'same scopes, different order');
  assert.deepEqual(s.checkExists({ ...data, scopes: ['Calendars.Read'] }), { credentialExists: true }, 'fewer scopes requested');
  assert.deepEqual(s.checkExists({ ...data, scopes: ['Calendars.Read', 'offline_access', 'someOtherScope'] }), { credentialExists: false }, 'more scopes requested');
  assert.deepEqual(s.checkExists({ ...data, scopes: ['someOtherScope'] }), { credentialExists: false }, 'non-matching scopes');
  assert.deepEqual(s.checkExists({ ...data, accountId: 'account3' }), { credentialExists: false }, 'wrong accountId');
  assert.deepEqual(s.checkExists({ ...data, skillId: 'skill2' }), { credentialExists: false }, 'wrong skillId');
  ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes'].forEach((p) => {
    const q = { ...data }; q[p] = null;
    assert.throws(() => s.checkExists(q), new RegExp(`Missing ${p} in request`));
  });
});

// ---------------------------------------------------------------------------
// Credential.test.ts — DELETE fixtures
// ---------------------------------------------------------------------------

test('D2 delete a credential; delete with fewer scopes; delete twice; wildcard per account', () => {
  const s = plainStore();
  const credential = googleCred({ accountId: 'account1', skillId: 'skill1', scopes: ['offline_access', 'Calendars.Read'], authCode: 'testAuthCode' });
  s.save(credential);
  s.delete({ ...credential });
  assert.deepEqual(s.checkExists(credential), { credentialExists: false });
  assert.doesNotThrow(() => s.delete({ ...credential }), 'deleting twice does not fail');

  s.save(credential);
  s.delete({ ...credential, scopes: ['Calendars.Read'] });
  assert.deepEqual(s.checkExists(credential), { credentialExists: false }, 'fewer scopes still delete');

  const c2 = { ...credential, accountId: 'account2' };
  s.save(credential);
  s.save(c2);
  s.delete({ accountId: 'account2', skillId: '*', serviceName: '*', serviceAccountName: '*' });
  assert.deepEqual(s.checkExists(c2), { credentialExists: false });
  assert.deepEqual(s.checkExists(credential), { credentialExists: true }, 'wildcard delete is scoped to the account');

  ['accountId', 'skillId', 'serviceName', 'serviceAccountName'].forEach((p) => {
    const q = { accountId: 'account2', skillId: 'skill1', serviceName: 'google', serviceAccountName: 'personalCalendar' };
    q[p] = null;
    assert.throws(() => s.delete(q), new RegExp(`Missing ${p} in request`));
  });
});

// ---------------------------------------------------------------------------
// Credential.deletion.test.ts — cross-provider replacement
// ---------------------------------------------------------------------------

async function assertDeletedPair(s, c1, c2, shouldBeDeleted) {
  s.save(c1);
  assert.equal(s.find(c1).oauth2.accessToken, c1.accessToken);
  s.save(c2);
  assert.equal(s.find(c2).oauth2.accessToken, c2.accessToken);
  const again = s.find(c1);
  if (shouldBeDeleted) assert.equal(again, null, `${c1.serviceName}:${c1.serviceAccountName} should be gone`);
  else {
    assert.ok(again, `${c1.serviceName}:${c1.serviceAccountName} should remain`);
    assert.equal(again.oauth2.accessToken, c1.accessToken);
  }
}

test('D2 google:personalCalendar removed when outlook:personalCalendar arrives (report-skill)', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123' });
  assertDeletedPair(s, g, o, true);
});

test('D2 outlook:personalCalendar removed when google:personalCalendar arrives (report-skill)', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123' });
  assertDeletedPair(s, o, g, true);
});

test('D2 workCalendar pair: google removed when outlook arrives (report-skill)', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  assertDeletedPair(s, g, o, true);
});

test('D2 workCalendar pair: outlook removed when google arrives (report-skill)', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  assertDeletedPair(s, o, g, true);
});

test('D2 different calendars are NOT cross-deleted (workCalendar vs personalCalendar)', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', serviceAccountName: 'personalCalendar' });
  assertDeletedPair(s, g, o, false);
  s.delete({ accountId: 'account-test-123', skillId: '*', serviceName: '*', serviceAccountName: '*' });
});

test('D2 non-report-skill credentials are NOT cross-deleted', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123', skillId: 'some-other-skill', serviceAccountName: 'workCalendar' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', skillId: 'some-other-skill', serviceAccountName: 'workCalendar' });
  assertDeletedPair(s, g, o, false);
});

test('D2 serviceAccountName outside workCalendar/personalCalendar is NOT cross-deleted', () => {
  const s = plainStore();
  const g = googleCred({ ...googleTokens(), accountId: 'account-test-123', skillId: 'some-other-skill', serviceAccountName: 'someOtherCalendar' });
  const o = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', skillId: 'some-other-skill', serviceAccountName: 'someOtherCalendar' });
  assertDeletedPair(s, g, o, false);
});

// ---------------------------------------------------------------------------
// CRITERION 3 — assignment-bug decision, pinned by a regression fixture
// ---------------------------------------------------------------------------

test('D2 REGRESSION FIXTURE: a NON-report-skill save does NOT trigger cross-provider deletion (Phoenix fix; reference assignment bug would delete)', () => {
  // Reference Credentials.ts line 143: `if (newCredential.skillId = 'report-skill')`
  // is an ASSIGNMENT (always truthy) — the reference would fire the deletion for
  // ANY arriving skill, deleting existing *report-skill* credentials of the other
  // provider for the account. Phoenix keeps a comparison, so the exact scenario
  // below preserves the report-skill google credential. Recorded divergence —
  // see docs/parity/candidates/D-02-candidate-20260910.md.
  const s = plainStore();
  const reportGoogle = googleCred({ ...googleTokens(), accountId: 'account-test-123', serviceAccountName: 'workCalendar' });
  const otherOutlook = outlookCred({ ...outlookTokens(), accountId: 'account-test-123', skillId: 'some-other-skill', serviceAccountName: 'workCalendar' });
  s.save(reportGoogle);
  s.save(otherOutlook);
  const survivor = s.find(reportGoogle);
  assert.ok(survivor, 'report-skill google:workCalendar must survive a non-report-skill outlook save');
  assert.equal(survivor.oauth2.accessToken, 'googleAccessToken2');
  assert.equal(s.find(otherOutlook).oauth2.accessToken, 'outlookAccessToken2');
});

// The reference's own guard, executed verbatim (Credentials.ts:143). The
// single `=` is the source defect D-02a: it is an ASSIGNMENT, so it is always
// truthy AND it rewrites `skillId` to 'report-skill' on the in-memory document
// before the remove() below reads it.
function referenceDeleteOtherCredentials(newCredential, db) {
  // eslint-disable-next-line no-cond-assign
  if (newCredential.skillId = 'report-skill') {
    if (['workCalendar', 'personalCalendar'].includes(newCredential.serviceAccountName)) {
      for (const [k, c] of [...db]) {
        if (c.accountId !== newCredential.accountId) continue;
        if (c.skillId !== newCredential.skillId) continue;
        if (c.serviceName === newCredential.serviceName) continue;
        if (c.serviceAccountName !== newCredential.serviceAccountName) continue;
        db.delete(k);
      }
    }
  }
}

test('D2 DIVERGENCE (D-02a): the reference guard is an assignment — always truthy, and it rewrites skillId', () => {
  const arriving = { skillId: 'some-other-skill', accountId: 'acct', serviceName: 'outlook', serviceAccountName: 'workCalendar' };
  assert.equal(arriving.skillId, 'some-other-skill');
  // eslint-disable-next-line no-cond-assign
  const truthy = (arriving.skillId = 'report-skill');
  assert.equal(truthy, 'report-skill', 'the assignment expression evaluates to the assigned value → always truthy');
  assert.equal(arriving.skillId, 'report-skill', 'the guard also OVERWRITES the arriving skillId');
});

test('D2 DIVERGENCE (D-02a): the source defect deletes an existing report-skill other-provider credential; Phoenix keeps it', () => {
  // Source side: an existing report-skill google:workCalendar credential, then
  // a NON-report-skill outlook:workCalendar save. The buggy guard rewrites the
  // arriving skillId to 'report-skill', so the remove() query matches the
  // report-skill google row and deletes it — the source's own deletion fixture
  // suite misses this because every "not report-skill" case there saves BOTH
  // credentials under the same non-report skill (Credential.deletion.test.ts
  // :182-198). Faithfulness would mean deleting a healthy credential here.
  const sourceDb = new Map();
  const existing = { accountId: 'acct', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'workCalendar' };
  sourceDb.set('existing', existing);
  referenceDeleteOtherCredentials({ skillId: 'some-other-skill', accountId: 'acct', serviceName: 'outlook', serviceAccountName: 'workCalendar' }, sourceDb);
  assert.equal(sourceDb.size, 0, 'the reference (with the assignment bug) deletes the report-skill google credential');

  // Phoenix side: the same scenario keeps the report-skill credential, because
  // `_deleteOther` compares instead of assigning (the deliberate D-02a fix,
  // recorded in DIVERGENCES.md and regression-pinned above).
  const s = plainStore();
  const reportGoogle = googleCred({ ...googleTokens(), accountId: 'acct', serviceAccountName: 'workCalendar' });
  s.save(reportGoogle);
  s.save(outlookCred({ ...outlookTokens(), accountId: 'acct', skillId: 'some-other-skill', serviceAccountName: 'workCalendar' }));
  assert.ok(s.find(reportGoogle), 'Phoenix preserves the report-skill credential (correctness over faithfulness)');
  assert.equal(s.m.size, 2);
});

// ---------------------------------------------------------------------------
// Durable state — unique keys + atomic updates surviving restarts
// ---------------------------------------------------------------------------

test('D2 credentials survive store restart; delete survives restart too', () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'credentials.json');
    const s1 = new CredentialStore({ file });
    const c = s1.save(googleCred({ accountId: 'acct-dup', authCode: 'testAuthCode' }));
    assert.equal(c.oauth2.accessToken, 'testAccessToken');

    const s2 = new CredentialStore(file);
    assert.deepEqual(s2.checkExists(googleCred({ accountId: 'acct-dup', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID, accessToken: 'x', refreshToken: 'y', expiresAt: 1 })), { credentialExists: true });
    const found = s2.find(googleCred({ accountId: 'acct-dup', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID }));
    assert.equal(found.oauth2.authCode, 'testAuthCode');
    assert.equal(found.oauth2.accessToken, 'testAccessToken');
    assert.equal(found.isActive, true);

    s2.delete({ accountId: 'acct-dup', skillId: '*', serviceName: '*', serviceAccountName: '*' });
    const s3 = new CredentialStore(file);
    assert.deepEqual(s3.checkExists(googleCred({ accountId: 'acct-dup', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID, accessToken: 'x', refreshToken: 'y', expiresAt: 1 })), { credentialExists: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 unique 5-tuple keys are enforced across a reload; scopes are part of the key', () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'credentials.json');
    const s1 = new CredentialStore(file);
    const p = { accountId: 'acct-x', skillId: 'skill-x', serviceName: 'google', serviceAccountName: 'personalCalendar', clientId: GOOGLE_CLIENT_ID, accessToken: 't', refreshToken: 'r', expiresAt: 1 };
    s1.save({ ...p, scopes: [GOOGLE_READONLY] });
    s1.save({ ...p, scopes: [GOOGLE_READWRITE] });
    assert.equal(s1.m.size, 2, 'two scope variants live as two unique-key records');
    const s2 = new CredentialStore(file);
    assert.equal(s2.m.size, 2, 'reload preserves both unique-key records');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 atomic flush: 0600 file, 0700 dir, no tmp litter, failed rename keeps committed bytes', () => {
  const dir = tmpDir();
  try {
    const parent = join(dir, 'state');
    const file = join(parent, 'credentials.json');
    const s = new CredentialStore({ file });
    s.save(googleCred({ authCode: 'testAuthCode' }));
    assert.equal(statSync(parent).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(parent), ['credentials.json'], 'no temporary snapshots left behind');

    const committed = readFileSync(file);
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    s.file = blocked;
    assert.throws(() => s.save(googleCred({ serviceAccountName: 'workCalendar', authCode: 'testAuthCode' })), (e) => ['EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(e.code), 'renaming over a directory must fail');
    assert.deepEqual(readFileSync(file), committed, 'committed snapshot untouched after a failed save');
    s.file = file;
    s._flush();
    assert.deepEqual(new CredentialStore(file).m.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 ETCO_data_credentialsFile env var gives default-resolved stores a durable file', () => {
  const dir = tmpDir();
  const prev = process.env.ETCO_data_credentialsFile;
  try {
    process.env.ETCO_data_credentialsFile = join(dir, 'env.json');
    const s = defaultStore();
    assert.equal(s.file, join(dir, 'env.json'), 'env override wins over the built-in default');
    s.save(googleCred({ accountId: 'env-acct', authCode: 'testAuthCode' }));
    const t = defaultStore(); // same env -> same file
    assert.deepEqual(t.checkExists(googleCred({ accountId: 'env-acct', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID, accessToken: 'x', refreshToken: 'y', expiresAt: 1 })), { credentialExists: true });
  } finally {
    if (prev === undefined) delete process.env.ETCO_data_credentialsFile; else process.env.ETCO_data_credentialsFile = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 with no env configured the default store is durable at the package data path; a path string is honored', () => {
  const dir = tmpDir();
  const prev = process.env.ETCO_data_credentialsFile;
  try {
    delete process.env.ETCO_data_credentialsFile;
    const s = defaultStore();
    assert.ok(s.file.endsWith(join('packages', 'data', 'data', 'credentials.json')),
      `default store points at the durable package data snapshot, got ${s.file}`);
    assert.ok(s.file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s.file), 'default store path is absolute');

    const s2 = new CredentialStore({ file: join(dir, 'string.json') });
    s2.save(googleCred({ accountId: 'string-acct', authCode: 'testAuthCode' }));
    const s3 = new CredentialStore(join(dir, 'string.json'));
    assert.deepEqual(s3.checkExists(googleCred({ accountId: 'string-acct', scopes: [GOOGLE_READONLY], clientId: GOOGLE_CLIENT_ID, accessToken: 'x', refreshToken: 'y', expiresAt: 1 })), { credentialExists: true });
  } finally {
    if (prev === undefined) delete process.env.ETCO_data_credentialsFile; else process.env.ETCO_data_credentialsFile = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 a corrupt snapshot file fails loudly instead of silently losing credentials', () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'credentials.json');
    writeFileSync(file, '{definitely not json');
    assert.throws(() => new CredentialStore(file), /credential store unreadable/);
    writeFileSync(file, '{"not":"an array"}');
    assert.throws(() => new CredentialStore(file), /credential store unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 uniqueness (D-02b CLOSED): a same-slot save whose scopes OVERLAP an existing record is rejected like the Mongo multikey index', () => {
  // Mongoose builds the unique `credentials_index` on the ARRAY field `scopes`
  // as a MULTIKEY index (StoredCredential.ts:107-119), so the SECOND insert in
  // a slot collides whenever the two scope lists SHARE a value: E11000 →
  // CredentialRequestsHandler.ts:36-39 → 200 {credentialExists:true}, nothing
  // stored. Phoenix keys the slot by the sorted scope set and now also refuses
  // the insert when any scope value is shared, so its state space matches the
  // reference's: no two same-slot records can share a scope, so find() can
  // never multi-match and a stored scope can never read back as
  // `credentialExists:false`.
  const s = redeemStore();
  const slot = { accountId: 'ov', skillId: 'sk', serviceName: 'google', serviceAccountName: 'personalCalendar' };
  s.save(googleCred({ ...slot, scopes: ['a'], authCode: 'a1' }));
  assert.throws(() => s.save(googleCred({ ...slot, scopes: ['a', 'b'], authCode: 'a2' })),
    (e) => e.code === 'DUPLICATE_KEY' && /already exists/.test(e.message), 'shared scope value → E11000-equivalent');
  assert.throws(() => s.save(googleCred({ ...slot, scopes: ['c', 'a'], authCode: 'a3' })),
    (e) => e.code === 'DUPLICATE_KEY', 'the overlap need only be one value');
  assert.equal(s.m.size, 1, 'only the first record exists (reference would reject #2/#3)');
  assert.equal(s.find({ ...slot, scopes: ['a'] }).oauth2.authCode, 'a1', 'the stored scope still resolves — no multi-match');
  assert.deepEqual(s.checkExists({ ...slot, scopes: ['a'] }), { credentialExists: true });
  assert.deepEqual(s.checkExists({ ...slot, scopes: ['b'] }), { credentialExists: false }, 'the rejected record was never stored');
  // DISJOINT scope sets still coexist — the original "other scopes" fixture.
  s.save(googleCred({ ...slot, scopes: ['x'], authCode: 'a4' }));
  s.save(googleCred({ ...slot, scopes: ['y'], authCode: 'a5' }));
  assert.equal(s.m.size, 3, 'disjoint scope sets remain distinct unique-key records');
  assert.equal(s.find({ ...slot, scopes: ['y'] }).oauth2.authCode, 'a5');
});

test('D2 uniqueness (D-02b CLOSED) over HTTP: an overlapping-scope save answers 200 {credentialExists:true}', async () => {
  const store = plainStore();
  const svc = await createDataService({ credentialStore: store, googleCalendarProvider: async () => [] }).listen(0);
  const p7 = svc.address().port;
  const post = (body) => fetch(`http://localhost:${p7}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = { ...googleCred({ accountId: 'ov-http', scopes: [GOOGLE_READONLY] }), accessToken: 't', refreshToken: 'r', expiresAt: 1 };
    assert.deepEqual(await (await post(first)).json(), { created: true });
    assert.deepEqual(await (await post({ ...first, accessToken: 't2', refreshToken: 'r2', expiresAt: 2 })).json(), { created: true }, 'equal scope set → same record updated');
    assert.deepEqual(await (await post({ ...first, scopes: [GOOGLE_READWRITE, GOOGLE_READONLY], accessToken: 't3', refreshToken: 'r3', expiresAt: 3 })).json(),
      { credentialExists: true }, 'overlapping scope set → the reference\'s E11000 envelope, nothing stored');
    assert.equal(store.m.size, 1);
    assert.deepEqual(await (await fetch(`http://localhost:${p7}/v1/credential?accountId=ov-http&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar&scopes[]=${encodeURIComponent(GOOGLE_READONLY)}`)).json(),
      { credentialExists: true }, 'the shared scope still resolves — no multi-match false negative');
  } finally {
    svc.close();
  }
});

test('D2 inactive credentials are hidden from lookup and reactivated on save (allowInactive)', () => {
  const s = plainStore();
  const data = googleCred({ accountId: 'inactive-acct', authCode: 'testAuthCode' });
  s.save(data);
  const stored = s.find(data);
  stored.isActive = false; // D-03 marks this via setInactive; simulate the flag
  assert.deepEqual(s.checkExists(data), { credentialExists: false }, 'inactive hidden from normal lookup');
  assert.ok(s.find(data, true), 'visible with allowInactive');
  s.save({ ...data, authCode: undefined, accessToken: 'at2', refreshToken: 'rt2', expiresAt: 2 });
  assert.deepEqual(s.checkExists(data), { credentialExists: true }, 'save reactivates the slot');
  assert.equal(s.find(data).oauth2.accessToken, 'at2');
});

// ---------------------------------------------------------------------------
// HTTP wire level: validation status codes and a persisted-store restart e2e
// ---------------------------------------------------------------------------

// Ports are ephemeral (listen(0)) and read back from the bound server. Fixed
// ports collide when suites run concurrently: 7804 was taken by another file's
// service and this suite failed with EADDRINUSE rather than a real assertion.
let basePort;
let tmp;
let service1;
let persistedFile;

before(async () => {
  tmp = tmpDir();
  persistedFile = join(tmp, 'live.json');
  service1 = await createDataService({
    credentialStore: new CredentialStore({ file: persistedFile }),
    googleCalendarProvider: async () => [],
  }).listen(0);
  basePort = service1.address().port;
});
after(() => { service1?.close?.(); rmSync(tmp, { recursive: true, force: true }); rmSync(ROOT, { recursive: true, force: true }); });

const j = (path, opts) => fetch(`http://localhost:${basePort}${path}`, opts);

test('D2 HTTP: missing fields -> 400 plain-text messages', async () => {
  const postMissing = await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(postMissing.status, 400);
  assert.equal(await postMissing.text(), 'Missing accountId in request');
  const getMissing = await j('/v1/credential?accountId=x&skillId=y&serviceName=google&serviceAccountName=z');
  assert.equal(getMissing.status, 400);
  assert.equal(await getMissing.text(), 'Missing scopes in request');
  const delMissing = await j('/v1/credential?accountId=x&skillId=y&serviceName=google', { method: 'DELETE' });
  assert.equal(delMissing.status, 400);
  assert.equal(await delMissing.text(), 'Missing serviceAccountName in request');
});

test('D2 HTTP: duplicate authCode -> 200 {credentialExists:true}', async () => {
  const body = JSON.stringify(googleCred({ accountId: 'http-acct', authCode: 'testAuthCode' }));
  assert.deepEqual(await (await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json(), { created: true });
  assert.deepEqual(await (await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json(), { credentialExists: true });
});

test('D2 HTTP: exact 400 plain-text envelope for every required GET/DELETE field', async () => {
  const getBase = { accountId: 'a', skillId: 'b', serviceName: 'google', serviceAccountName: 'c', scopes: 'read' };
  for (const p of ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes']) {
    const qs = new URLSearchParams(getBase); qs.delete(p);
    const r = await j(`/v1/credential?${qs}`);
    assert.equal(r.status, 400, `GET missing ${p}`);
    assert.equal(await r.text(), `Missing ${p} in request`, `GET missing ${p} message`);
  }
  const delBase = { accountId: 'a', skillId: 'b', serviceName: 'google', serviceAccountName: 'c' };
  for (const p of ['accountId', 'skillId', 'serviceName', 'serviceAccountName']) {
    const qs = new URLSearchParams(delBase); qs.delete(p);
    const r = await j(`/v1/credential?${qs}`, { method: 'DELETE' });
    assert.equal(r.status, 400, `DELETE missing ${p}`);
    assert.equal(await r.text(), `Missing ${p} in request`, `DELETE missing ${p} message`);
  }
});

test('D2 HTTP: an unsupported serviceName on the authCode path -> 400 "Service is not supported by Lasso"', async () => {
  const body = JSON.stringify({ accountId: 'svc-acct', skillId: 'skill', serviceName: 'yahoo', serviceAccountName: 'personalCalendar', scopes: ['read'], clientId: 'c', authCode: 'ac' });
  const r = await j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 400);
  assert.equal(await r.text(), 'Service is not supported by Lasso: yahoo');
});

test('D2 HTTP: a credential persisted by one service instance is found by the next (restart)', async () => {
  // Wire form: the pinned axios 0.17.1 client (used by the original lasso
  // fixtures) serializes an array param as `scopes[]=`; Express/qs parses that
  // back into an array. A single bare `scopes=` value is NOT this form and the
  // reference rejects it (see the D-02c test below).
  const qs = 'accountId=http-acct&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar&scopes[]=https://www.googleapis.com/auth/calendar.readonly';
  const beforeRestart = await (await j(`/v1/credential?${qs}`)).json();
  assert.deepEqual(beforeRestart, { credentialExists: true }, 'still live on the first instance');
  service1.close(); service1 = null;
  const service2 = await createDataService({ credentialStore: new CredentialStore(persistedFile), googleCalendarProvider: async () => [] }).listen(0);
  const p1 = service2.address().port;
  try {
    const afterRestart = await (await fetch(`http://localhost:${p1}/v1/credential?${qs}`)).json();
    assert.deepEqual(afterRestart, { credentialExists: true }, 'a brand-new store on the same file sees the credential');
    const del = await (await fetch(`http://localhost:${p1}/v1/credential?accountId=http-acct&skillId=*&serviceName=*&serviceAccountName=*`, { method: 'DELETE' })).json();
    assert.deepEqual(del, { deleted: true });
    const gone = await (await fetch(`http://localhost:${p1}/v1/credential?${qs}`)).json();
    assert.deepEqual(gone, { credentialExists: false }, 'delete persists too');
  } finally {
    service2.close();
  }
});

// D-02c: the reference parses its query with Express 4.16.2's default
// 'extended' (qs 6.5.1) parser. These shapes were produced by running the
// pinned qs from .parity/reference/5c0a739…; each is asserted here so the
// parser cannot drift away from the reference's validateScopes outcomes.
test('D2 credentialQueryFromParams reproduces the pinned qs shapes (D-02c CLOSED)', () => {
  const p = (qs) => new URL(`http://x/v1/credential?${qs}`).searchParams;
  // Indexed brackets — the wire form the Settings service sends
  // (srv-settings-ws src/clients/lasso.ts:38-40) and the reason a real
  // Settings -> Lasso GET used to 400 in Phoenix.
  assert.deepEqual(credentialQueryFromParams(p('scopes[0]=a&scopes[1]=b')).scopes, ['a', 'b']);
  assert.deepEqual(credentialQueryFromParams(p('scopes[0]=a')).scopes, ['a'], 'single indexed value is an ARRAY');
  // Bracketed — the wire form the pinned axios 0.17.1 client sends (the shape
  // the original lasso fixtures use).
  assert.deepEqual(credentialQueryFromParams(p('scopes[]=a&scopes[]=b')).scopes, ['a', 'b']);
  // Repeated bare params.
  assert.deepEqual(credentialQueryFromParams(p('scopes=a&scopes=b')).scopes, ['a', 'b']);
  // A single bare param stays a STRING, exactly like qs — so validateScopes
  // rejects it with the reference's message rather than accepting it.
  assert.equal(credentialQueryFromParams(p('scopes=a')).scopes, 'a');
  assert.equal(credentialQueryFromParams(p('scopes=a,b')).scopes, 'a,b');
  assert.equal(credentialQueryFromParams(p('accountId=a')).scopes, null, 'absent → null → Missing scopes in request');
});

test('D2 HTTP (D-02c CLOSED): a single bare scopes param is 400 "Scopes should be an array"; the indexed and bracketed client forms are 200', async () => {
  const store = plainStore();
  const svc = await createDataService({ credentialStore: store, googleCalendarProvider: async () => [] }).listen(0);
  const p8 = svc.address().port;
  const base = `http://localhost:${p8}/v1/credential`;
  const head = 'accountId=form-acct&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar';
  try {
    await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(googleCred({ accountId: 'form-acct', authCode: 'testAuthCode' })),
    });
    // Reference: qs yields the string 'read' → validateScopes → 400.
    for (const single of [`${head}&scopes=${encodeURIComponent(GOOGLE_READONLY)}`, `${head}&scopes=a,b`]) {
      const r = await fetch(`${base}?${single}`);
      assert.equal(r.status, 400, single);
      assert.equal(await r.text(), 'Scopes should be an array');
    }
    // Reference: qs yields an array → 200 {credentialExists:true}.
    for (const form of [
      `${head}&scopes[0]=${encodeURIComponent(GOOGLE_READONLY)}`,                       // Settings service
      `${head}&scopes[]=${encodeURIComponent(GOOGLE_READONLY)}`,                         // pinned axios 0.17.1
      `${head}&scopes=${encodeURIComponent(GOOGLE_READONLY)}&scopes=${encodeURIComponent(GOOGLE_READONLY)}`,
      `${head}&scopes[2]=${encodeURIComponent(GOOGLE_READONLY)}`,
    ]) {
      const r = await fetch(`${base}?${form}`);
      assert.equal(r.status, 200, form);
      assert.deepEqual(await r.json(), { credentialExists: true }, form);
    }
    // A requested scope the credential lacks stays a 200 false (no regression
    // from making the indexed form parse).
    const absent = await fetch(`${base}?${head}&scopes[0]=${encodeURIComponent(GOOGLE_READWRITE)}`);
    assert.deepEqual(await absent.json(), { credentialExists: false });
    // Absent scopes still reports the reference's missing-field message.
    const missing = await fetch(`${base}?accountId=form-acct&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar`);
    assert.equal(missing.status, 400);
    assert.equal(await missing.text(), 'Missing scopes in request');
    // DELETE: scopes are optional for the reference and are not validated, so a
    // non-matching scope list must NOT delete the record (the indexed form is
    // now parsed instead of being ignored).
    const notMatching = await fetch(`${base}?${head}&scopes[0]=${encodeURIComponent('some-other-scope')}`, { method: 'DELETE' });
    assert.deepEqual(await notMatching.json(), { deleted: true }, 'DELETE still answers {deleted:true}');
    assert.equal(store.m.size, 1, 'a DELETE naming a scope the credential lacks removed nothing');
    const matching = await fetch(`${base}?${head}&scopes[0]=${encodeURIComponent(GOOGLE_READONLY)}`, { method: 'DELETE' });
    assert.deepEqual(await matching.json(), { deleted: true });
    assert.equal(store.m.size, 0, 'a DELETE naming the stored scope removes it');
  } finally {
    svc.close();
  }
});

test('D2 HTTP: report-skill + google with no clientId gets the default clientId; a non-report skill 400s', async () => {
  const store = plainStore();
  const svc = await createDataService({ credentialStore: store, googleCalendarProvider: async () => [] }).listen(0);
  const p4 = svc.address().port;
  try {
    const post = (body) => fetch(`http://localhost:${p4}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const base = { accountId: 'dflt-acct', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: ['read'], authCode: 'testAuthCode' };
    assert.deepEqual(await (await post({ ...base, skillId: 'report-skill' })).json(), { created: true });
    const found = store.find({ accountId: 'dflt-acct', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: ['read'] });
    assert.equal(found.oauth2.clientId, '830717411721', 'handler injected DEFAULT_GOOGLE_CLIENT_ID');
    const other = await post({ ...base, accountId: 'dflt-acct2', skillId: 'chitchat-skill' });
    assert.equal(other.status, 400, 'no injection for a non-report skill');
    assert.equal(await other.text(), 'Missing clientId in request');
  } finally {
    svc.close();
  }
});

test('D2 end-to-end (D-02c CLOSED): the Settings Lasso client resolves against the data service', async () => {
  // The deployed Settings face talks to Lasso with indexed scope params
  // (packages/account/src/settingsProviders.js:1307,1350 — ported from
  // srv-settings-ws src/clients/lasso.ts, which does
  // `uri.searchParams.set(`scopes[${i}]`, scope)`). Before D-02c was closed,
  // that GET answered 400 "Missing scopes in request" from the data service, so
  // the Settings → Lasso hop could never report an existing credential. This
  // test drives the real client code against the real service code.
  const { createSettingsProviders } = await import('../../account/src/settingsProviders.js');
  const store = plainStore();
  const svc = await createDataService({ credentialStore: store, googleCalendarProvider: async () => [] }).listen(0);
  const p9 = svc.address().port;
  try {
    const saved = await fetch(`http://localhost:${p9}/v1/credential`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(googleCred({ accountId: 'e2e-acct', authCode: 'testAuthCode' })),
    });
    assert.deepEqual(await saved.json(), { created: true });

    const lasso = createSettingsProviders({ store: {}, env: { NET_settings_lasso: `127.0.0.1:${p9}` } }).lasso;
    const context = { loopId: 'loop-1', userId: 'e2e-acct', transactionId: 'tx-1' };
    const params = { skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: [GOOGLE_READONLY] };
    // getCredential rejects (throws) on a non-2xx or a body without
    // credentialExists, so a 400 from the data service fails loudly here.
    assert.deepEqual(await lasso.getCredential(context, params), { credentialExists: true });
    assert.deepEqual(await lasso.getCredential(context, { ...params, skillId: 'other-skill' }), { credentialExists: false });
    await lasso.deleteCredential(context, params);
    assert.equal(store.m.size, 0, 'the Settings DELETE removed the credential');
    assert.deepEqual(await lasso.getCredential(context, params), { credentialExists: false });
  } finally {
    svc.close();
  }
});

test('D2 HTTP: the DEFAULT store (createDataService with no store arg) survives a service restart', async () => {
  const dir = tmpDir();
  const prev = process.env.ETCO_data_credentialsFile;
  const qs = 'accountId=dflt-durable&skillId=report-skill&serviceName=google&serviceAccountName=personalCalendar&scopes[]=https://www.googleapis.com/auth/calendar.readonly';
  try {
    process.env.ETCO_data_credentialsFile = join(dir, 'credentials.json');
    const svcA = await createDataService({ googleCalendarProvider: async () => [] }).listen(0);
  const p5 = svcA.address().port;
    assert.deepEqual(await (await fetch(`http://localhost:${p5}/v1/credential`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(googleCred({ accountId: 'dflt-durable', authCode: 'testAuthCode' })),
    })).json(), { created: true });
    svcA.close();
    const svcB = await createDataService({ googleCalendarProvider: async () => [] }).listen(0);
  const p6 = svcB.address().port;
    try {
      assert.deepEqual(await (await fetch(`http://localhost:${p6}/v1/credential?${qs}`)).json(),
        { credentialExists: true }, 'default-resolved store persisted across a restart');
    } finally { svcB.close(); }
  } finally {
    if (prev === undefined) delete process.env.ETCO_data_credentialsFile; else process.env.ETCO_data_credentialsFile = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});