import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TTLCache } from '../src/cache.js';
import { openMeteoGet, openMeteoToDarkSky } from '../src/weather.js';
import { defaultOrsGet } from '../src/maps.js';
import {
  calendarCacheKey,
  createUpstreamCalendarProvider,
} from '../src/calendar.js';
import { postForm, outlookRefreshCredentials, createOAuthProvider, CredentialError } from '../src/oauth.js';
import { CredentialStore } from '../src/credentials.js';
import { createDataService } from '../src/index.js';
import { createNewsPoller } from '../src/news.js';
import { HistoryStore, SKILL_LAUNCH_RETENTION_MS } from '../../history/src/store.js';

const FEED = '<rss><channel><title>Headlines</title><item><title>Story</title><description>Text</description></item></channel></rss>';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortableHang(_url, { signal }) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function tempFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-data-regression-'));
  return { dir, file: join(dir, name) };
}

test('weather upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  await assert.rejects(
    () => openMeteoGet(1, 2, {
      timeoutMs: 15,
      fetchImpl: (url, options) => {
        seenSignal = options.signal;
        return abortableHang(url, options);
      },
    }),
    (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError',
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('caller cancellation reaches the weather upstream signal before its deadline', async () => {
  const controller = new AbortController();
  let seenSignal;
  const pending = openMeteoGet(1, 2, {
    signal: controller.signal,
    timeoutMs: 1000,
    fetchImpl: (url, options) => {
      seenSignal = options.signal;
      return abortableHang(url, options);
    },
  });
  await delay(5);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(seenSignal?.aborted, 'caller aborts the child request signal');
});


test('maps upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  await assert.rejects(
    () => defaultOrsGet({ origin: { lat: 1, lon: 2 }, destination: { lat: 3, lon: 4 }, mode: 'driving' }, {
      timeoutMs: 15,
      fetchImpl: (url, options) => {
        seenSignal = options.signal;
        return abortableHang(url, options);
      },
    }),
    (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError',
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('calendar upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  const provider = createUpstreamCalendarProvider({
    serviceName: 'outlook',
    baseUrl: 'http://calendar.invalid',
    timeoutMs: 15,
    getToken: () => 'token',
    fetchImpl: (url, options) => {
      seenSignal = options.signal;
      return abortableHang(url, options);
    },
  });
  await assert.rejects(
    () => provider({ endDate: '2050-01-01T00:00:00Z' }, {}),
    (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError',
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
      text: async () => JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'token expired' } }),
    }),
  });
  await assert.rejects(
    () => provider({ endDate: '2050-01-01T00:00:00Z' }),
    (error) => error?.code === 'InvalidAuthenticationToken',
  );
});

test('Microsoft OAuth error wrapping retains InvalidAuthenticationToken as its code', async () => {
  const providerError = Object.assign(new Error('token rejected'), {
    code: 'InvalidAuthenticationToken', statusCode: 401,
  });
  await assert.rejects(
    () => outlookRefreshCredentials({ client_id: 'id', client_secret: 'secret' }, 'refresh', [], {
      post: async () => { throw providerError; },
    }),
    (error) => error?.code === 'InvalidAuthenticationToken',
  );
});

test('OAuth token fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  await assert.rejects(
    () => postForm('http://oauth.invalid/token', { grant_type: 'refresh_token' }, {
      timeoutMs: 15,
      fetchImpl: (url, options) => {
        seenSignal = options.signal;
        return abortableHang(url, options);
      },
    }),
    (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError',
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('calendar keys include endDate and remain collision-safe for delimiter-containing fields', () => {
  const base = { skillId: 'skill', accountId: 'account', calendar: 'personalCalendar' };
  const first = calendarCacheKey('google', { ...base, endDate: '2050-01-01T00:00:00Z' });
  const second = calendarCacheKey('google', { ...base, endDate: '2050-01-02T00:00:00Z' });
  assert.notEqual(first, second, 'different endDate values cannot share a key');
  assert.notEqual(
    calendarCacheKey('google', { skillId: 'a:b', accountId: 'c', calendar: 'd', endDate: 'e' }),
    calendarCacheKey('google', { skillId: 'a', accountId: 'b:c', calendar: 'd', endDate: 'e' }),
    'tuple fields cannot collide at delimiters',
  );
});

test('calendar cache invalidation removes every endDate entry on deletion and provider replacement', async () => {
  const { dir, file } = tempFile('credentials.json');
  let server;
  try {
    const cache = new TTLCache();
    const events = [{ summary: 'v1', start: { dateTime: '2050-01-01T09:00:00Z' } }];
    const svc = createDataService({
      cache,
      credentialStore: new CredentialStore({ file }),
      googleCalendarProvider: async () => events,
      outlookCalendarProvider: async () => events,
    });
    server = await svc.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const calendarUrl = (service, endDate) => `${base}/v1/${service}_calendar?skillId=report-skill&accountId=account&calendar=personalCalendar&endDate=${encodeURIComponent(endDate)}`;
    const credential = {
      accountId: 'account', skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'google-client', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000,
    };
    const post = (body) => fetch(`${base}/v1/credential`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const end1 = '2050-01-02T00:00:00Z';
    const end2 = '2050-01-03T00:00:00Z';
    await post(credential);
    await fetch(calendarUrl('google', end1));
    await fetch(calendarUrl('google', end2));
    await fetch(calendarUrl('outlook', end1));
    assert.equal([...cache.m.keys()].filter((key) => key.includes('calendar')).length, 3);

    const replaced = await post({
      ...credential,
      serviceName: 'outlook', scopes: ['read-outlook'], clientId: 'outlook-client',
      accessToken: 'at2', refreshToken: 'rt2',
    });
    assert.deepEqual(await replaced.json(), { created: true });
    assert.equal([...cache.m.keys()].filter((key) => key.includes('calendar')).length, 0, 'replacement invalidates old and new provider keys');

    await post(credential);
    await fetch(calendarUrl('google', end1));
    await fetch(calendarUrl('google', end2));
    const deleted = await fetch(`${base}/v1/credential?accountId=account&skillId=report-skill&serviceName=*&serviceAccountName=*`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal([...cache.m.keys()].filter((key) => key.includes('calendar')).length, 0, 'deletion invalidates all date variants');
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
      accountId: 'microsoft-account', skillId: 'skill', serviceName: 'outlook', serviceAccountName: 'personalCalendar',
      scopes: ['Calendars.Read', 'offline_access'], clientId: 'client', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000,
    };
    store.save(credential);
    const providerError = Object.assign(new Error('Microsoft rejected the access token'), { code: 'InvalidAuthenticationToken' });
    const cache = new TTLCache();
    const endDate = '2050-01-02T00:00:00Z';
    const cacheKey = calendarCacheKey('outlook', {
      skillId: 'skill', accountId: 'microsoft-account', calendar: 'personalCalendar', endDate,
    });
    cache.set(cacheKey, { cached: true }, 60);
    const handler = (await import('../src/calendar.js')).createCalendarHandler({
      provider: async () => { throw providerError; }, store, serviceName: 'outlook', oauth: { refresh: async () => ({}) }, cache,
    });
    store.onChange = (change) => {
      for (const changed of [change?.credential, ...(change?.credentials || []), ...(change?.removed || [])].filter(Boolean)) handler.invalidate(changed);
    };
    const response = { writableEnded: false, writeHead: () => {}, end: (body) => { response.body = body; response.writableEnded = true; } };
    await handler({
        req: { method: 'GET' },
        res: response,
        url: new URL(`http://localhost/v1/outlook_calendar?skillId=skill&accountId=microsoft-account&calendar=personalCalendar&endDate=${endDate}&skipCache=1`),
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
    secrets: { google: { alias: { client_id: 'provider-one-id', client_secret: 'provider-one-secret', redirect_uri: 'one://' } } },
    post: async (_url, form) => { forms.push(form); return { access_token: 'one', expires_in: 60, refresh_token: 'one-refresh' }; },
  });
  const p2 = createOAuthProvider({
    secrets: { google: { alias: { client_id: 'provider-two-id', client_secret: 'provider-two-secret', redirect_uri: 'two://' } } },
    post: async (_url, form) => { forms.push(form); return { access_token: 'two', expires_in: 60, refresh_token: 'two-refresh' }; },
  });
  await p1.redeem('google', { clientId: 'alias', authCode: 'one-code' });
  await p2.redeem('google', { clientId: 'alias', authCode: 'two-code' });
  assert.equal(forms[0].client_id, 'provider-one-id');
  assert.equal(forms[0].client_secret, 'provider-one-secret');
  assert.equal(forms[1].client_id, 'provider-two-id');
  assert.equal(forms[1].client_secret, 'provider-two-secret');
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
      accountId: 'race-account', skillId: 'skill', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'client',
    };
    const [first, second] = await Promise.all([
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

test('Open-Meteo local timestamps use the response timezone, including DST-aware sunrise', () => {
  const result = openMeteoToDarkSky({
    timezone: 'America/New_York',
    daily: {
      time: ['2026-07-04'],
      temperature_2m_max: [80], temperature_2m_min: [60], weathercode: [0],
      sunrise: ['2026-07-04T05:30'], sunset: ['2026-07-04T20:30'],
      precipitation_sum: [0], precipitation_probability_max: [0],
    },
    current_weather: { time: '2026-07-04T12:00', temperature: 75, weathercode: 0 },
  }, { lat: 1, lon: 2, secondsSinceEpoch: 0 });
  assert.equal(result.daily.data[0].time, Date.parse('2026-07-04T04:00:00Z') / 1000);
  assert.equal(result.daily.data[0].sunriseTime, Date.parse('2026-07-04T09:30:00Z') / 1000);
  assert.equal(result.daily.data[0].sunsetTime, Date.parse('2026-07-05T00:30:00Z') / 1000);
  assert.equal(result.currently.time, Date.parse('2026-07-04T16:00:00Z') / 1000);
});

test('news stop wins a start/stop race while the initial poll is still in flight', async () => {
  const cache = new TTLCache();
  const intervals = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const poller = createNewsPoller({
    cache,
    pollingEnabled: true,
    get: async () => { fetches += 1; await gate; return FEED; },
    timers: { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 0; }, clearInterval: () => {} },
  });
  const starting = poller.start();
  while (fetches < 11) await delay(1);
  poller.stop();
  release();
  assert.equal(await starting, false, 'a stopped start does not arm a timer');
  assert.equal(intervals.length, 0);
  assert.equal(poller.isPolling(), false);
});

test('history malformed payload validation leaves expired launches and snapshot untouched', () => {
  const { dir, file } = tempFile('history.json');
  try {
    const store = new HistoryStore(file);
    const timestamp = Date.now();
    store.addSkillLaunch({ robotID: 'robot', sessionID: 'fresh', skillID: 'skill', timestamp });
    store.addSkillLaunch({
      robotID: 'robot', sessionID: 'expired', skillID: 'skill',
      timestamp: timestamp - SKILL_LAUNCH_RETENTION_MS - 1,
    });
    const before = readFileSync(file, 'utf8');

    assert.throws(
      () => store.saveSkillPayload({ robotID: 'robot', sessionID: 'expired', skillID: 'skill', payload: null }),
      /Cannot convert undefined or null to object/,
    );
    assert.deepEqual(store.skillLaunches.map((record) => record.sessionID), ['fresh', 'expired']);
    assert.equal(readFileSync(file, 'utf8'), before, 'a rejected payload must not flush retention changes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history payload update prunes expired launches before matching', () => {
  const store = new HistoryStore();
  const now = Date.now();
  store.addSkillLaunch({ robotID: 'robot', sessionID: 'fresh', skillID: 'skill', timestamp: now });
  store.addSkillLaunch({ robotID: 'robot', sessionID: 'expired', skillID: 'skill', timestamp: now - SKILL_LAUNCH_RETENTION_MS - 1 });
  assert.equal(store.saveSkillPayload({ robotID: 'robot', sessionID: 'expired', skillID: 'skill', payload: { stale: true } }), null);
  assert.deepEqual(store.skillLaunches.map((record) => record.sessionID), ['fresh']);
});
