// Calendar, OAuth and credential hardening regressions, re-ported from the September week review
// (fix/week-review-hardening bbe5dfbb/34cc9064). Every account, credential, token
// and URL below is synthetic test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TTLCache } from '../src/cache.js';
import { calendarCacheKey, createCalendarHandler, createUpstreamCalendarProvider } from '../src/calendar.js';
import { postForm, outlookRefreshCredentials, createOAuthProvider, CredentialError } from '../src/oauth.js';
import { CredentialStore } from '../src/credentials.js';
import { createDataService } from '../src/index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDeadline = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

function abortableHang(_url, { signal }) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function tempFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-data-hardening-'));
  return { dir, file: join(dir, name) };
}

test('calendar upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  const provider = createUpstreamCalendarProvider({
    serviceName: 'outlook',
    baseUrl: 'http://calendar.invalid',
    timeoutMs: 15,
    getToken: () => 'synthetic-token',
    fetchImpl: (url, options) => { seenSignal = options.signal; return abortableHang(url, options); },
  });
  await assert.rejects(() => provider({ endDate: '2050-01-01T00:00:00Z' }, {}), isDeadline);
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('OAuth token fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  await assert.rejects(
    () => postForm('http://oauth.invalid/token', { grant_type: 'refresh_token' }, {
      timeoutMs: 15,
      fetchImpl: (url, options) => { seenSignal = options.signal; return abortableHang(url, options); },
    }),
    isDeadline,
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('Microsoft calendar HTTP errors retain InvalidAuthenticationToken as their code', async () => {
  const provider = createUpstreamCalendarProvider({
    serviceName: 'outlook',
    baseUrl: 'http://calendar.invalid',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'synthetic token expired' } }),
    }),
  });
  await assert.rejects(
    () => provider({ endDate: '2050-01-01T00:00:00Z' }),
    (error) => error?.code === 'InvalidAuthenticationToken',
  );
});

test('Microsoft OAuth error wrapping retains InvalidAuthenticationToken as its code', async () => {
  const providerError = Object.assign(new Error('synthetic token rejected'), {
    code: 'InvalidAuthenticationToken', statusCode: 401,
  });
  await assert.rejects(
    () => outlookRefreshCredentials({ client_id: 'synthetic-id', client_secret: 'synthetic-secret' }, 'synthetic-refresh', [], {
      post: async () => { throw providerError; },
    }),
    (error) => error?.code === 'InvalidAuthenticationToken',
  );
});

test('calendar keys include endDate and remain collision-safe for delimiter-containing fields', () => {
  const base = { skillId: 'skill', accountId: 'synthetic-account', calendar: 'personalCalendar' };
  const first = calendarCacheKey('google', { ...base, endDate: '2050-01-01T00:00:00Z' });
  const second = calendarCacheKey('google', { ...base, endDate: '2050-01-02T00:00:00Z' });
  assert.notEqual(first, second, 'different endDate values cannot share a key');
  assert.notEqual(
    calendarCacheKey('google', { skillId: 'a:b', accountId: 'c', calendar: 'd', endDate: 'e' }),
    calendarCacheKey('google', { skillId: 'a', accountId: 'b:c', calendar: 'd', endDate: 'e' }),
    'tuple fields cannot collide at delimiters',
  );
});

test('calendar requests for different endDate windows do not share a cached payload', async () => {
  const calls = [];
  const svc = createDataService({
    calendarCache: new TTLCache(),
    googleCalendarProvider: async (input) => {
      calls.push(input.endDate);
      return [{ summary: `until ${input.endDate}`, start: { dateTime: '2050-01-01T09:00:00Z' } }];
    },
  });
  const server = await svc.listen(0);
  try {
    const run = async (endDate) => (await fetch(`http://127.0.0.1:${server.address().port}/v1/google_calendar?skillId=s&accountId=synthetic&calendar=personalCalendar&endDate=${encodeURIComponent(endDate)}`)).json();
    await run('2050-01-02T00:00:00Z');
    const second = await run('2050-01-03T00:00:00Z');
    assert.deepEqual(calls, ['2050-01-02T00:00:00Z', '2050-01-03T00:00:00Z']);
    assert.equal(second.lassoDataFromRedis, false, 'the second window was fetched, not served from the first');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('calendar cache invalidation removes every endDate entry on deletion and provider replacement', async () => {
  const { dir, file } = tempFile('credentials.json');
  let server;
  try {
    const calendarCache = new TTLCache();
    const events = [{ summary: 'synthetic v1', start: { dateTime: '2050-01-01T09:00:00Z' } }];
    const svc = createDataService({
      calendarCache,
      credentialStore: new CredentialStore({ file }),
      googleCalendarProvider: async () => events,
      outlookCalendarProvider: async () => events,
    });
    server = await svc.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const calendarUrl = (service, endDate) => `${base}/v1/${service}_calendar?skillId=report-skill&accountId=synthetic-account&calendar=personalCalendar&endDate=${encodeURIComponent(endDate)}`;
    const credential = {
      accountId: 'synthetic-account', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'synthetic-google-client', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000,
    };
    const post = (body) => fetch(`${base}/v1/credential`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const calendarKeys = () => calendarCache.keys().filter((key) => key.includes('calendar'));
    const end1 = '2050-01-02T00:00:00Z';
    const end2 = '2050-01-03T00:00:00Z';
    await post(credential);
    await fetch(calendarUrl('google', end1));
    await fetch(calendarUrl('google', end2));
    await fetch(calendarUrl('outlook', end1));
    assert.equal(calendarKeys().length, 3);

    const replaced = await post({
      ...credential,
      serviceName: 'outlook', scopes: ['read-outlook'], clientId: 'synthetic-outlook-client',
      accessToken: 'at2', refreshToken: 'rt2',
    });
    assert.deepEqual(await replaced.json(), { created: true });
    assert.equal(calendarKeys().length, 0, 'replacement invalidates old and new provider keys');

    await post(credential);
    await fetch(calendarUrl('google', end1));
    await fetch(calendarUrl('google', end2));
    const deleted = await fetch(`${base}/v1/credential?accountId=synthetic-account&skillId=report-skill&serviceName=*&serviceAccountName=*`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal(calendarKeys().length, 0, 'deletion invalidates all date variants');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Microsoft InvalidAuthenticationToken code is preserved and deactivates the credential', async () => {
  const { dir, file } = tempFile('credentials.json');
  try {
    const store = new CredentialStore({ file });
    const credential = {
      accountId: 'synthetic-microsoft-account', skillId: 'skill', serviceName: 'outlook', serviceAccountName: 'personalCalendar',
      scopes: ['Calendars.Read', 'offline_access'], clientId: 'synthetic-client', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000,
    };
    store.save(credential);
    // The provider error carries the code but not the marker text in its message.
    const providerError = Object.assign(new Error('Microsoft rejected the access token'), { code: 'InvalidAuthenticationToken' });
    const cache = new TTLCache();
    const endDate = '2050-01-02T00:00:00Z';
    const cacheKey = calendarCacheKey('outlook', {
      skillId: 'skill', accountId: 'synthetic-microsoft-account', calendar: 'personalCalendar', endDate,
    });
    cache.set(cacheKey, { cached: true }, 60);
    const handler = createCalendarHandler({
      provider: async () => { throw providerError; }, store, serviceName: 'outlook', oauth: { refresh: async () => ({}) }, cache,
    });
    store.onChange = (change) => {
      for (const changed of [change?.credential, ...(change?.credentials || []), ...(change?.removed || [])].filter(Boolean)) handler.invalidate(changed);
    };
    const response = { writableEnded: false, writeHead: () => {}, setHeader: () => {}, end: (body) => { response.body = body; response.writableEnded = true; } };
    await handler({
      req: { method: 'GET', once() {}, removeListener() {} },
      res: response,
      url: new URL(`http://localhost/v1/outlook_calendar?skillId=skill&accountId=synthetic-microsoft-account&calendar=personalCalendar&endDate=${endDate}&skipCache=1`),
    });
    const stored = store.find(credential, true);
    assert.equal(providerError.code, 'InvalidAuthenticationToken', 'provider code was not overwritten');
    assert.match(response.body, /InvalidAuthenticationToken|Microsoft rejected/);
    assert.equal(cache.get(cacheKey), null, 'invalid credentials evict every cached date range');
    assert.equal(stored.isActive, false);
    assert.equal(stored.error, CredentialError.INVALID_TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth client secrets are isolated to each provider instance', async () => {
  const forms = [];
  const p1 = createOAuthProvider({
    secrets: { google: { alias: { client_id: 'synthetic-one-id', client_secret: 'synthetic-one-secret', redirect_uri: 'one://' } } },
    post: async (_url, form) => { forms.push(form); return { access_token: 'one', expires_in: 60, refresh_token: 'one-refresh' }; },
  });
  const p2 = createOAuthProvider({
    secrets: { google: { alias: { client_id: 'synthetic-two-id', client_secret: 'synthetic-two-secret', redirect_uri: 'two://' } } },
    post: async (_url, form) => { forms.push(form); return { access_token: 'two', expires_in: 60, refresh_token: 'two-refresh' }; },
  });
  await p1.redeem('google', { clientId: 'alias', authCode: 'one-code' });
  await p2.redeem('google', { clientId: 'alias', authCode: 'two-code' });
  assert.equal(forms[0].client_id, 'synthetic-one-id');
  assert.equal(forms[0].client_secret, 'synthetic-one-secret');
  assert.equal(forms[1].client_id, 'synthetic-two-id');
  assert.equal(forms[1].client_secret, 'synthetic-two-secret');
});

test('concurrent credential saves serialize OAuth exchange and leave one ordered replacement', async () => {
  const { dir, file } = tempFile('credentials.json');
  try {
    let active = 0;
    let maxActive = 0;
    const oauth = {
      supports: () => true,
      redeem: async (_service, params) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        return { access_token: params.authCode, refresh_token: `${params.authCode}-refresh`, expires_in: 60 };
      },
    };
    const store = new CredentialStore({ file, oauth });
    const base = {
      accountId: 'synthetic-race-account', skillId: 'skill', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'synthetic-client',
    };
    const [, second] = await Promise.all([
      store.saveCredential({ ...base, authCode: 'first' }),
      store.saveCredential({ ...base, authCode: 'second' }),
    ]);
    assert.equal(maxActive, 1, 'OAuth exchanges are serialized');
    assert.equal(second.oauth2.accessToken, 'second');
    assert.equal(store.find(base).oauth2.accessToken, 'second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
