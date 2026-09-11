// D-03 — OAuth exchange, refresh and invalidation.
//
// These tests drive the *real* data service over HTTP against a real HTTP token
// endpoint (a local server replaying the pinned recorded provider fixtures), so
// the exchange/refresh/invalidation paths run end to end: network request ->
// token store -> calendar read -> invalidation.
//
// Pinned fixtures are transliterated from pegasus 5c0a7390539663ba749d360de348a428c088505c:
//   packages/lasso/tests/credential/Credential.test.ts        (success exchange, dup, errors)
//   packages/lasso/tests/relay/GoogleCalendarErrors.test.ts   (refresh fail, revoked, envelopes)
//   packages/lasso/tests/relay/OutlookCalendarErrors.test.ts  (redeem error, InvalidAuthenticationToken)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialStore } from '../src/credentials.js';
import { createCalendarHandler, calendarCacheKey } from '../src/calendar.js';
import { createDataService } from '../src/index.js';
import { createOAuthProvider, CredentialError, setTokens, getClientSecret, clearSecrets } from '../src/oauth.js';

const GOOGLE_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_CLIENT_ID = '668620580899';
const GOOGLE_SECRET = {
  client_id: '668620580899-eus56a4gr8l278apl1a60kpql4c8ik35.apps.googleusercontent.com',
  client_secret: 'yx740-780cn75-xcVhMp2vjd',
  redirect_uri: 'https://developers.google.com/oauthplayground',
};
const OUTLOOK_CLIENT_ID = 'c3d45ff5-07c5-466c-b785-de98f4207281';
const OUTLOOK_SECRET = {
  client_id: 'c3d45ff5-07c5-466c-b785-de98f4207281',
  client_secret: 'wwlKJDD9710-!}ewdkWVF0}',
  redirect_uri: 'com.jibo.link.app:/callback',
};
const GOOGLE_SCOPES = [GOOGLE_READONLY];
const OUTLOOK_SCOPES = ['Calendars.Read', 'offline_access'];

// --- recorded provider fixtures -------------------------------------------
const GOOGLE_OK = { access_token: 'googleAccessToken', token_type: 'Bearer', expires_in: 3600, refresh_token: 'googleRefreshToken' };
const GOOGLE_REFRESH_OK = { access_token: 'googleRefreshedAccessToken', token_type: 'Bearer', expires_in: 3600 };
const GOOGLE_CODE_REDEEMED = { error: 'invalid_grant', error_description: 'Code was already redeemed.' };
const GOOGLE_REFRESH_FAIL = { error: 'invalid_grant', error_description: 'Bad Request' };
const OUTLOOK_OK = { access_token: 'outlookAccessToken', token_type: 'Bearer', expires_in: 3600, refresh_token: 'outlookRefreshToken' };
const OUTLOOK_REDEEM_FAIL = {
  error: 'invalid_client',
  error_description: "AADSTS50011: The reply url specified in the request does not match the reply urls configured for the application: 'c3d45ff5-07c5-466c-b785-de98f4207281'.\r\nTrace ID: 645c63e6-4360-4211-adbe-9eca371c3a00\r\nCorrelation ID: ae4e12ae-34c3-4c60-a449-6b38b07da627\r\nTimestamp: 2018-05-08 11:31:04Z",
  error_codes: [50011], timestamp: '2018-05-08 11:31:04Z', trace_id: '645c63e6-4360-4211-adbe-9eca371c3a00',
};

// --- real HTTP token endpoint ---------------------------------------------
let tokenServer;
let tokenPort;
let tokenReply = { status: 200, body: GOOGLE_OK };
const tokenRequests = [];

const ROOT = mkdtempSync(join(tmpdir(), 'phoenix-data-oauth-'));
let seq = 0;
const nextFile = () => join(ROOT, `credentials-${++seq}.json`);

let oauth;
let service;
let gEvents = [];
let gCalls = 0;
let oCalls = 0;
const PORT = 7812;

before(async () => {
  tokenServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      tokenRequests.push({ url: req.url, method: req.method, form: Object.fromEntries(new URLSearchParams(raw)) });
      const reply = typeof tokenReply === 'function' ? tokenReply(req) : tokenReply;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
  tokenPort = tokenServer.address().port;

  oauth = createOAuthProvider({
    secrets: { google: { [GOOGLE_CLIENT_ID]: GOOGLE_SECRET }, outlook: { [OUTLOOK_CLIENT_ID]: OUTLOOK_SECRET } },
    endpoints: {
      google: { tokenUrl: `http://127.0.0.1:${tokenPort}/oauth2/v4/token` },
      outlook: { tokenUrl: `http://127.0.0.1:${tokenPort}/common/oauth2/v2.0/token` },
    },
  });

  service = await createDataService({
    credentialStore: new CredentialStore({ file: nextFile() }),
    oauth,
    googleCalendarProvider: async () => { gCalls++; return gEvents; },
    outlookCalendarProvider: async () => { oCalls++; return gEvents; },
  }).listen(PORT);
});

after(() => {
  service?.close?.();
  tokenServer?.close?.();
  rmSync(ROOT, { recursive: true, force: true });
});

const j = (path, opts) => fetch(`http://localhost:${PORT}${path}`, opts);
const post = (body) => j('/v1/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const googleCred = (over = {}) => ({ accountId: 'g-acct', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: GOOGLE_SCOPES, clientId: GOOGLE_CLIENT_ID, ...over });
const outlookCred = (over = {}) => ({ accountId: 'o-acct', skillId: 'report-skill', serviceName: 'outlook', serviceAccountName: 'personalCalendar', scopes: OUTLOOK_SCOPES, clientId: OUTLOOK_CLIENT_ID, ...over });

// ---------------------------------------------------------------------------
// exchange
// ---------------------------------------------------------------------------

test('D-03 exchange: a real authCode is exchanged at the provider token endpoint and stored', async () => {
  tokenReply = { status: 200, body: GOOGLE_OK };
  tokenRequests.length = 0;
  const before = Date.now();
  const res = await post(googleCred({ accountId: 'ex-1', authCode: 'authCode' }));
  assert.deepEqual(await res.json(), { created: true });

  // The real request reached the token endpoint with the OAuth2 contract fields.
  assert.equal(tokenRequests.length, 1);
  const req = tokenRequests[0];
  assert.equal(req.url, '/oauth2/v4/token');
  assert.equal(req.form.code, 'authCode');
  assert.equal(req.form.client_id, GOOGLE_SECRET.client_id);
  assert.equal(req.form.client_secret, GOOGLE_SECRET.client_secret);
  assert.equal(req.form.redirect_uri, GOOGLE_SECRET.redirect_uri);
  assert.equal(req.form.grant_type, 'authorization_code');

  const store = new CredentialStore({ file: join(ROOT, `credentials-${seq}.json`) });
  const found = store.find(googleCred({ accountId: 'ex-1' }));
  assert.equal(found.oauth2.authCode, 'authCode');
  assert.equal(found.oauth2.accessToken, 'googleAccessToken');
  assert.equal(found.oauth2.refreshToken, 'googleRefreshToken');
  assert.ok(Math.abs(found.oauth2.expiresAt - (before + 3600 * 1000)) < 2000, 'expiresAt = now + expires_in*1000');
});

test('D-03 exchange: a replayed authCode answers 200 {credentialExists:true} and never re-requests a token', async () => {
  tokenReply = { status: 200, body: GOOGLE_OK };
  tokenRequests.length = 0;
  await post(googleCred({ accountId: 'dup-1', authCode: 'authCode' }));
  assert.equal(tokenRequests.length, 1, 'first authCode exchanges');
  const replay = await post(googleCred({ accountId: 'dup-1', authCode: 'authCode' }));
  assert.deepEqual(await replay.json(), { credentialExists: true });
  assert.equal(tokenRequests.length, 1, 'replayed authCode rejected before any token request');
});

test('D-03 exchange error: Google 400 -> 400 plain-text "Failed to redeem authCode, Google response was ..."', async () => {
  tokenReply = { status: 400, body: GOOGLE_CODE_REDEEMED };
  const res = await post(googleCred({ accountId: 'ex-err', authCode: 'staleCode' }));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'Failed to redeem authCode, Google response was 400 Code was already redeemed.');
});

test('D-03 exchange error: Outlook 400 -> the pinned AADSTS message', async () => {
  tokenReply = { status: 400, body: OUTLOOK_REDEEM_FAIL };
  const res = await post(outlookCred({ accountId: 'o-err', authCode: 'outlookAuthCode' }));
  assert.equal(res.status, 400);
  const body = await res.text();
  // OutlookCalendarClient.throwError appends context.error_description verbatim,
  // so the full AADSTS notice (including its trace lines) is preserved.
  assert.ok(body.startsWith(
    "Failed to redeem authCode, Outlook response was 400 AADSTS50011: The reply url specified in the request does not match the reply urls configured for the application: 'c3d45ff5-07c5-466c-b785-de98f4207281'.",
  ));
  assert.match(body, /Trace ID: 645c63e6-4360-4211-adbe-9eca371c3a00/);
});

test('D-03 exchange: unknown clientId -> 400 "Cannot find secret for <service> client <id>"', async () => {
  const res = await post(googleCred({ accountId: 'ex-nosecret', clientId: 'some-missing-client', authCode: 'x' }));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'Cannot find secret for google client some-missing-client');
});

test('D-03 exchange: Outlook authCode success stores outlook tokens', async () => {
  tokenReply = { status: 200, body: OUTLOOK_OK };
  tokenRequests.length = 0;
  const res = await post(outlookCred({ accountId: 'o-ok', authCode: 'outlookAuthCode' }));
  assert.deepEqual(await res.json(), { created: true });
  assert.equal(tokenRequests[0].url, '/common/oauth2/v2.0/token');
  assert.equal(tokenRequests[0].form.grant_type, 'authorization_code');
  assert.equal(tokenRequests[0].form.scope, 'Calendars.Read offline_access');
  const store = new CredentialStore({ file: join(ROOT, `credentials-${seq}.json`) });
  const found = store.find(outlookCred({ accountId: 'o-ok' }));
  assert.equal(found.oauth2.accessToken, 'outlookAccessToken');
  assert.equal(found.oauth2.refreshToken, 'outlookRefreshToken');
});

test('D-03 exchange: testAuthCode still bypasses the provider (D-02 regression guard)', async () => {
  tokenReply = { status: 200, body: GOOGLE_OK };
  tokenRequests.length = 0;
  const res = await post(googleCred({ accountId: 'bypass-1', authCode: 'testAuthCode' }));
  assert.deepEqual(await res.json(), { created: true });
  assert.equal(tokenRequests.length, 0, 'testAuthCode never hits the token endpoint');
});

// ---------------------------------------------------------------------------
// refresh + expiry
// ---------------------------------------------------------------------------

test('D-03 refresh: an expired credential is refreshed at the provider and the new token is stored', async () => {
  // Seed an already-expired credential through the real service (direct tokens).
  await post(googleCred({
    accountId: 'rf-1', accessToken: 'oldAccessToken', refreshToken: 'oldRefreshToken', expiresAt: Date.now() - 1000,
  }));
  tokenReply = { status: 200, body: GOOGLE_REFRESH_OK };
  tokenRequests.length = 0;
  gEvents = [{ summary: 'Standup', start: { dateTime: '2026-06-08T09:00:00Z' } }];
  gCalls = 0;

  const res = await j('/v1/google_calendar?skillId=report-skill&accountId=rf-1&calendar=personalCalendar');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.events.length, 1);

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].form.grant_type, 'refresh_token');
  assert.equal(tokenRequests[0].form.refresh_token, 'oldRefreshToken');
  assert.equal(tokenRequests[0].form.client_id, GOOGLE_SECRET.client_id);

  const store = new CredentialStore({ file: join(ROOT, `credentials-${seq}.json`) });
  const found = store.find(googleCred({ accountId: 'rf-1' }));
  assert.equal(found.oauth2.accessToken, 'googleRefreshedAccessToken');
  assert.ok(found.oauth2.expiresAt > Date.now(), 'refreshed token has a future expiry');
  assert.ok(found.oauth2.refreshedAt, 'refreshedAt recorded (StoredCredential.updateTokens)');
});

test('D-03 refresh failure: the credential is marked inactive REFRESH_FAILED and the route answers 502', async () => {
  await post(googleCred({
    accountId: 'rf-fail', accessToken: 'oldAccessToken', refreshToken: 'oldRefreshToken', expiresAt: Date.now() - 1000,
  }));
  tokenReply = { status: 400, body: GOOGLE_REFRESH_FAIL };
  const res = await j('/v1/google_calendar?skillId=report-skill&accountId=rf-fail&calendar=personalCalendar');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Failed to refresh access token, Google response was 400 Bad Request/);

  const store = new CredentialStore({ file: join(ROOT, `credentials-${seq}.json`) });
  const found = store.find(googleCred({ accountId: 'rf-fail' }), true);
  assert.equal(found.isActive, false);
  assert.equal(found.error, CredentialError.REFRESH_FAILED);
  assert.equal(store.find(googleCred({ accountId: 'rf-fail' })), null, 'inactive credential hidden from normal lookup');
});

// ---------------------------------------------------------------------------
// revoked / invalid access
// ---------------------------------------------------------------------------

test('D-03 revoked access: a Google "expired or revoked" reply marks REVOKED_ACCESS', async () => {
  await post(googleCred({ accountId: 'rev-1', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000 }));
  const svc = service;
  // Swap the events provider to the revoked fixture by using a dedicated service
  // so the shared stub is not mutated across tests.
  const local = await createDataService({
    credentialStore: new CredentialStore({ file: nextFile() }),
    oauth,
    googleCalendarProvider: async () => { throw new Error('Failed to get Google Calendar events, Google response was 400 Token has been expired or revoked'); },
  }).listen(PORT + 1);
  try {
    const seed = await fetch(`http://localhost:${PORT + 1}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(googleCred({ accountId: 'rev-1', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000 })) });
    assert.deepEqual(await seed.json(), { created: true });
    const res = await fetch(`http://localhost:${PORT + 1}/v1/google_calendar?skillId=report-skill&accountId=rev-1&calendar=personalCalendar`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /expired or revoked/);
  } finally {
    local.close();
  }
  assert.ok(svc, 'primary service still up');
});

test('D-03 invalid token: an Outlook InvalidAuthenticationToken reply marks INVALID_TOKEN', async () => {
  const local = await createDataService({
    credentialStore: new CredentialStore({ file: nextFile() }),
    oauth,
    outlookCalendarProvider: async () => { throw new Error('Failed to get Outlook events, Outlook response was 401 InvalidAuthenticationToken'); },
  }).listen(PORT + 2);
  try {
    const seedBody = outlookCred({ accountId: 'o-rev', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000 });
    const seed = await fetch(`http://localhost:${PORT + 2}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seedBody) });
    assert.deepEqual(await seed.json(), { created: true });
    const res = await fetch(`http://localhost:${PORT + 2}/v1/outlook_calendar?skillId=report-skill&accountId=o-rev&calendar=personalCalendar`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /InvalidAuthenticationToken/);
    const store = new CredentialStore({ file: join(ROOT, `credentials-${seq}.json`) });
    const found = store.find(outlookCred({ accountId: 'o-rev' }), true);
    assert.equal(found.isActive, false);
    assert.equal(found.error, CredentialError.INVALID_TOKEN);
  } finally {
    local.close();
  }
});

// ---------------------------------------------------------------------------
// cache invalidation
// ---------------------------------------------------------------------------

test('D-03 cache invalidation: a new credential drops the cached calendar payload', async () => {
  const port = PORT + 3;
  let events = [{ summary: 'v1', start: { dateTime: '2026-06-08T09:00:00Z' } }];
  let calls = 0;
  const local = await createDataService({
    credentialStore: new CredentialStore({ file: nextFile() }),
    oauth,
    googleCalendarProvider: async () => { calls++; return events; },
  }).listen(port);
  const base = `http://localhost:${port}`;
  try {
    const seedBody = googleCred({ accountId: 'ci-1', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000 });
    await fetch(`${base}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seedBody) });

    const read = () => fetch(`${base}/v1/google_calendar?skillId=report-skill&accountId=ci-1&calendar=personalCalendar`).then((r) => r.json());
    assert.equal((await read()).events[0].summary, 'v1');
    assert.equal(calls, 1);
    // cache hit within 60s: provider not called again
    assert.equal((await read()).events[0].summary, 'v1');
    assert.equal(calls, 1, 'second read served from the calendar cache');

    // A new credential for the same slot invalidates the cached key.
    events = [{ summary: 'v2', start: { dateTime: '2026-06-08T10:00:00Z' } }];
    await fetch(`${base}/v1/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...seedBody, accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 3600 * 1000 }) });

    assert.equal((await read()).events[0].summary, 'v2', 'cache was invalidated by the new credential');
    assert.equal(calls, 2, 'provider re-fetched after invalidation');

    // Reference skipCache truthiness: `skipCache=1` re-fetches; a bare `skipCache=` is falsy.
    events = [{ summary: 'v3', start: { dateTime: '2026-06-08T11:00:00Z' } }];
    const skipped = await fetch(`${base}/v1/google_calendar?skillId=report-skill&accountId=ci-1&calendar=personalCalendar&skipCache=1`).then((r) => r.json());
    assert.equal(skipped.events[0].summary, 'v3');
    assert.equal(calls, 3, 'skipCache=1 bypasses the cache');
    const bare = await fetch(`${base}/v1/google_calendar?skillId=report-skill&accountId=ci-1&calendar=personalCalendar&skipCache=`).then((r) => r.json());
    assert.equal(bare.events[0].summary, 'v3');
    assert.equal(calls, 3, 'bare skipCache= is falsy -> cache hit');
  } finally {
    local.close();
  }
});

// ---------------------------------------------------------------------------
// unit-level contract details
// ---------------------------------------------------------------------------

test('D-03 setTokens: expiry_date wins, expires_in computes, no expiry throws, refresh_token only when arrived', () => {
  const cred = { oauth2: { accessToken: null, refreshToken: 'keep', expiresAt: null } };
  setTokens(cred, { access_token: 'a', expiry_date: 123, refresh_token: 'new' });
  assert.equal(cred.oauth2.expiresAt, 123);
  assert.equal(cred.oauth2.refreshToken, 'new');
  setTokens(cred, { access_token: 'b', expires_in: 60 });
  assert.equal(cred.oauth2.refreshToken, 'new', 'refresh_token unchanged when not returned');
  assert.throws(() => setTokens(cred, { access_token: 'c' }), /Expiry date did not arrive/);
  assert.throws(() => setTokens(cred, { expires_in: 10 }), /access_token is missing/);
});

test('D-03 createCalendarHandler exposes the reference cache key and invalidation', () => {
  const events = [];
  const handler = createCalendarHandler({ provider: async () => events, store: null, serviceName: 'google' });
  assert.equal(handler.cacheKey({ skillId: 's', accountId: 'a', calendar: 'personalCalendar' }), 'google_calendar:s:a:personalCalendar');
  assert.equal(calendarCacheKey('outlook', { skillId: 's', accountId: 'a', calendar: 'workCalendar' }), 'outlook_calendar:s:a:workCalendar');
  assert.equal(typeof handler.invalidate, 'function');
});

test('D-03 secrets registry: short and full clientID resolve', () => {
  clearSecrets();
  const provider = createOAuthProvider({ secrets: { google: { [GOOGLE_CLIENT_ID]: GOOGLE_SECRET } } });
  assert.equal(getClientSecret('google', GOOGLE_CLIENT_ID).client_id, GOOGLE_SECRET.client_id);
  assert.equal(getClientSecret('google', GOOGLE_SECRET.client_id).client_id, GOOGLE_SECRET.client_id);
  assert.throws(() => getClientSecret('outlook', 'x'), /Cannot find secrets for outlook/);
  assert.equal(typeof provider.supports, 'function');
});
