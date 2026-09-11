// D-04 — Google/Outlook calendar relay compatibility.
//
// Everything here replays the PINNED lasso fixtures
// (packages/lasso/tests/test-data/{google,outlook}/**.json@5c0a739, copied verbatim
// into test/fixtures/calendar/ — sha256 in docs/parity/evidence/2026-09-10/d04-calendar-relay/)
// through the real data service and compares every field to the pinned original
// expectations in packages/lasso/tests/relay/GoogleCalendar.test.ts:132-162 and
// packages/lasso/tests/relay/OutlookCalendar.test.ts:125-145 — the envelope,
// endDate default/validation, timezone/all-day normalization and invalid-event filtering.
//
// NOTE: the reference emits exactly `{ relayData, lassoDataFromRedis }`
// (AbstractRelayRequestHandler.ts:112-131) and both pinned relay tests deep-equal
// that two-key body (tests/relay/GoogleCalendar.test.ts:132-162,
// tests/relay/OutlookCalendar.test.ts:126-145). D-04 emits exactly those keys.
// The upstream request the real clients issue is ported as
// buildUpstreamQuery/createUpstreamCalendarProvider and pinned in D-04/16-19.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataService } from '../src/index.js';
import {
  normalizeEvent, normalizeOutlookEvent, validateCalendar, buildDefaultEndDate, endDateOffsetMinutes,
  buildUpstreamQuery, createUpstreamCalendarProvider,
} from '../src/calendar.js';
import { TTLCache } from '../src/cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'calendar');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const googleEvents = fixture('google-events.json');
const googleTimezone = fixture('google-calendar.json').timeZone;          // America/Los_Angeles
const chicagoEvents = fixture('google-events-chicago.json');
const chicagoTimezone = fixture('google-calendar-chicago.json').timeZone; // America/Chicago
const outlookEvents = fixture('outlook-events.json');

const PORT = 7804;
let base = `http://localhost:${PORT}`;
let server;
let portRetries = 0;

const providerCalls = [];
const googleProvider = async (req, ctx) => {
  providerCalls.push({ service: 'google', req, ctx });
  if (req.accountId === 'chi') return { events: chicagoEvents.items, calendarTimezone: chicagoTimezone };
  if (req.accountId === 'invalid') {
    return {
      events: [
        ...googleEvents.items,
        { summary: 'No start at all' },
        { summary: 'Start only', start: { dateTime: '2018-08-23T09:00:00-07:00' }, end: {} },
      ],
      calendarTimezone: googleTimezone,
    };
  }
  return { events: googleEvents.items, calendarTimezone: googleTimezone };
};
const outlookProvider = async (req, ctx) => {
  providerCalls.push({ service: 'outlook', req, ctx });
  if (req.accountId === 'o-windows') {
    return {
      events: [
        {
          subject: 'Windows Zone Event', isAllDay: false,
          start: { dateTime: '2018-04-25T08:00:00.0000000', timeZone: 'Eastern Standard Time' },
          end: { dateTime: '2018-04-25T08:30:00.0000000', timeZone: 'Eastern Standard Time' },
        },
      ],
    };
  }
  return { events: outlookEvents.value };
};

before(async () => {
  // Fixed-port collision guard: credential-durable.test.js also binds 7800+N in the same
  // parallel run (EADDRINUSE flake reported in w13/a05). Retry on the next port.
  for (let attempt = 0; ; attempt++) {
    const port = PORT + portRetries + attempt;
    try {
      server = await createDataService({ googleCalendarProvider: googleProvider, outlookCalendarProvider: outlookProvider }).listen(port);
      base = `http://localhost:${port}`;
      if (port !== PORT) portRetries += attempt;
      break;
    } catch (err) {
      if (err?.code === 'EADDRINUSE' && attempt < 5) continue;
      throw err;
    }
  }
});
after(() => { server?.close?.(); });

const url = (service, accountId, extra = '') => `/v1/${service}_calendar?skillId=skill1&accountId=${accountId}&calendar=personalCalendar${extra}`;
const get = (p) => fetch(`${base}${p}`);
const json = async (p) => (await get(p)).json();
const callsFor = (accountId) => providerCalls.filter((c) => c.req.accountId === accountId);

// ---------------------------------------------------------------------------
// envelope — the D-04 finding ("missing relay envelope")
// ---------------------------------------------------------------------------

test('D-04/1 a miss answers the relay envelope with the pinned Google fixture events', async () => {
  const res = await get(url('google', 'env-1', '&endDate=2050-12-18T23:59:59-07:00'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();

  // reference shape: { relayData, lassoDataFromRedis } (AbstractRelayRequestHandler.ts:112-117)
  assert.deepEqual(body.relayData, {
    events: [
      {
        summary: 'Event With Start and End Date',
        fullDay: true,
        start: { timestamp: 1524294000000, dateTime: '2018-04-21T00:00:00-07:00' },
        end: { timestamp: 1524466800000, dateTime: '2018-04-23T00:00:00-07:00' },
      },
      {
        summary: 'Event With Start and End Time',
        fullDay: false,
        start: { timestamp: 1535034600000, dateTime: '2018-08-23T07:30:00-07:00' },
        end: { timestamp: 1535038200000, dateTime: '2018-08-23T08:30:00-07:00' },
      },
    ],
  });
  assert.equal(body.lassoDataFromRedis, false);
  assert.deepEqual(Object.keys(body), ['relayData', 'lassoDataFromRedis'],
    'exactly the reference relay keys (AbstractRelayRequestHandler.ts:112-117)');
  // the pinned suite also asserts dateTime is the exact representation of timestamp
  for (const event of body.relayData.events) {
    assert.equal(new Date(event.start.dateTime).getTime(), event.start.timestamp);
    assert.equal(new Date(event.end.dateTime).getTime(), event.end.timestamp);
  }
});

test('D-04/2 the calendar timezone (not the server) decides full-day boundaries', async () => {
  const body = await json(url('google', 'chi', '&endDate=2050-12-18T23:59:59-07:00'));
  assert.deepEqual(body.relayData.events, [
    {
      summary: 'Event With Start and End Date',
      fullDay: true,
      start: { timestamp: 1524286800000, dateTime: '2018-04-21T00:00:00-05:00' },
      end: { timestamp: 1524373200000, dateTime: '2018-04-22T00:00:00-05:00' },
    },
    {
      summary: 'Event With Start and End Time',
      fullDay: false,
      start: { timestamp: 1535027400000, dateTime: '2018-08-23T07:30:00-05:00' },
      end: { timestamp: 1535031000000, dateTime: '2018-08-23T08:30:00-05:00' },
    },
  ]);
});

test('D-04/3 events without a usable start are filtered and a missing end is omitted', async () => {
  const body = await json(url('google', 'invalid'));
  assert.deepEqual(body.relayData.events.map((e) => e.summary),
    ['Event With Start and End Date', 'Event With Start and End Time', 'Start only']);
  const startOnly = body.relayData.events[2];
  assert.equal(startOnly.fullDay, false);
  assert.equal(Object.hasOwn(startOnly, 'end'), false, 'reference deletes event.end');
});

// ---------------------------------------------------------------------------
// HEAD + the 60-second cache
// ---------------------------------------------------------------------------

test('D-04/4 HEAD answers an empty 200 with no entity headers and warms the cache', async () => {
  const before405 = callsFor('head-1').length;
  const head = await fetch(`${base}${url('google', 'head-1')}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), null);
  assert.equal(head.headers.get('content-length'), null);
  assert.equal(await head.text(), '');
  assert.equal(callsFor('head-1').length, before405 + 1, 'HEAD still fetched to warm the cache');

  // the warmed key serves the GET from the cache
  const res = await get(url('google', 'head-1'));
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const body = await res.json();
  assert.equal(body.lassoDataFromRedis, true);
  assert.equal(body.relayData.events.length, 2);
  assert.equal(callsFor('head-1').length, before405 + 1, 'the GET was a cache hit');
});

test('D-04/5 a cache hit echoes the stored bytes and does not re-call the provider', async () => {
  const miss = await (await get(url('google', 'cache-1'))).json();
  const callsAfterMiss = callsFor('cache-1').length;
  const hitRes = await get(url('google', 'cache-1'));
  assert.equal(hitRes.headers.get('content-type'), 'text/html; charset=utf-8');
  const hitText = await hitRes.text();
  const hit = JSON.parse(hitText);
  assert.equal(callsFor('cache-1').length, callsAfterMiss, 'provider not called on a hit');
  assert.deepEqual(hit.relayData, miss.relayData);
  assert.equal(hit.lassoDataFromRedis, true);
  assert.match(hit.lassoInsertedIntoRedisAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(hit),
    ['relayData', 'lassoDataFromRedis', 'lassoInsertedIntoRedisAt'],
    'the stored string is sent verbatim, not re-serialized');
  assert.equal(hitText, JSON.stringify(hit));
});

test('D-04/6 skipCache keeps the relay truthiness inside the calendar route', async () => {
  await get(url('google', 'skip-1'));
  const callsAfterFirst = callsFor('skip-1').length;
  const skipped = await (await get(url('google', 'skip-1', '&skipCache=1'))).json();
  assert.equal(skipped.lassoDataFromRedis, false, 'skipCache=1 refetched');
  assert.equal(callsFor('skip-1').length, callsAfterFirst + 1);
  const bare = await (await get(url('google', 'skip-1', '&skipCache='))).json();
  assert.equal(bare.lassoDataFromRedis, true, 'a bare skipCache= is falsy -> cache hit');
  assert.equal(callsFor('skip-1').length, callsAfterFirst + 1);
});

test('D-04/7 a new credential drops the cached 60-second payload end to end', async () => {
  const accountId = 'inv-1';
  await get(url('google', accountId));
  const cached = await (await get(url('google', accountId))).json();
  assert.equal(cached.lassoDataFromRedis, true);
  assert.equal(callsFor(accountId).length, 1);

  const seed = await fetch(`${base}/v1/credential`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId, skillId: 'skill1', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'c1',
      accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000,
    }),
  });
  assert.equal(seed.status, 200);
  assert.deepEqual(await seed.json(), { created: true });

  const after = await (await get(url('google', accountId))).json();
  assert.equal(after.lassoDataFromRedis, false, 'the new credential invalidated the key');
  assert.equal(callsFor(accountId).length, 2, 'the provider was consulted again');
});

// ---------------------------------------------------------------------------
// endDate defaults + validation
// ---------------------------------------------------------------------------

test('D-04/8 an omitted endDate defaults to the end of tomorrow (DateTimeUtils.buildDefaultEndDate)', async () => {
  await json(url('google', 'end-1'));
  const { endDate } = callsFor('end-1')[0].req;
  const expected = new Date();
  expected.setDate(expected.getDate() + 1);
  expected.setHours(23, 59, 59, 999);
  assert.equal(Date.parse(endDate), expected.getTime());
  assert.equal(endDate, buildDefaultEndDate(1));
});

test('D-04/9 an unparsable endDate is a 400 with the pinned message; a valid one reaches the provider', async () => {
  const bad = await get(url('google', 'end-2', '&endDate=2018-13-45'));
  assert.equal(bad.status, 400);
  assert.equal(await bad.text(), 'Invalid end date: 2018-13-45');

  const good = await json(url('google', 'end-3', '&endDate=2050-12-18T23:59:59-07:00'));
  assert.equal(good.lassoDataFromRedis, false);
  assert.equal(callsFor('end-3')[0].req.endDate, '2050-12-18T23:59:59-07:00');
});

test('D-04/10 missing required inputs answer the pinned 400 messages per service', async () => {
  const cases = [
    ['/v1/google_calendar?accountId=a&calendar=c', 'Missing skillId in Google Calendar request'],
    ['/v1/google_calendar?skillId=s&calendar=c', 'Missing accountId in Google Calendar request'],
    ['/v1/google_calendar?skillId=s&accountId=a', 'Missing calendar type in Google Calendar request'],
    ['/v1/outlook_calendar?accountId=a&calendar=c', 'Missing skillId in Outlook Calendar request'],
    ['/v1/outlook_calendar?skillId=s&calendar=c', 'Missing accountId in Outlook Calendar request'],
    ['/v1/outlook_calendar?skillId=s&accountId=a', 'Missing calendar type in Outlook Calendar request'],
  ];
  for (const [path, message] of cases) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), message);
  }
});

// ---------------------------------------------------------------------------
// Outlook presentation (subject/isAllDay + the request endDate offset)
// ---------------------------------------------------------------------------

test('D-04/11 Outlook replay: offsets come from endDate, not the event timezone', async () => {
  const utc = await json(url('outlook', 'o-default'));
  assert.deepEqual(utc.relayData.events, [
    { summary: 'Outlook Event 1', fullDay: false, start: { timestamp: 1524668400000, dateTime: '2018-04-25T15:00:00+00:00' }, end: { timestamp: 1524670200000, dateTime: '2018-04-25T15:30:00+00:00' } },
    { summary: 'Outlook Event 2', fullDay: false, start: { timestamp: 1524582000000, dateTime: '2018-04-24T15:00:00+00:00' }, end: { timestamp: 1524583800000, dateTime: '2018-04-24T15:30:00+00:00' } },
    { summary: 'Outlook Event 3', fullDay: true, start: { timestamp: 1524528000000, dateTime: '2018-04-24T00:00:00+00:00' }, end: { timestamp: 1524614400000, dateTime: '2018-04-25T00:00:00+00:00' } },
  ]);

  const west = await json(url('outlook', 'o-offset', '&endDate=2050-12-18T23:59:59-07:00'));
  assert.deepEqual(west.relayData.events, [
    { summary: 'Outlook Event 1', fullDay: false, start: { timestamp: 1524668400000, dateTime: '2018-04-25T08:00:00-07:00' }, end: { timestamp: 1524670200000, dateTime: '2018-04-25T08:30:00-07:00' } },
    { summary: 'Outlook Event 2', fullDay: false, start: { timestamp: 1524582000000, dateTime: '2018-04-24T08:00:00-07:00' }, end: { timestamp: 1524583800000, dateTime: '2018-04-24T08:30:00-07:00' } },
    { summary: 'Outlook Event 3', fullDay: true, start: { timestamp: 1524553200000, dateTime: '2018-04-24T00:00:00-07:00' }, end: { timestamp: 1524639600000, dateTime: '2018-04-25T00:00:00-07:00' } },
  ]);
});

test('D-04/12 an event timezone is honoured (IANA and the Graph Windows id)', async () => {
  const body = await json(url('outlook', 'o-windows'));
  assert.deepEqual(body.relayData.events, [{
    summary: 'Windows Zone Event',
    fullDay: false,
    start: { timestamp: Date.parse('2018-04-25T12:00:00Z'), dateTime: '2018-04-25T12:00:00+00:00' },
    end: { timestamp: Date.parse('2018-04-25T12:30:00Z'), dateTime: '2018-04-25T12:30:00+00:00' },
  }]);
  // 'Eastern Standard Time' == America/New_York in April == UTC-4
  assert.deepEqual(normalizeOutlookEvent({
    subject: 'x', isAllDay: false,
    start: { dateTime: '2018-04-25T08:00:00.0000000', timeZone: 'America/New_York' },
  }, 0).start, { timestamp: Date.parse('2018-04-25T12:00:00Z'), dateTime: '2018-04-25T12:00:00+00:00' });
});

// ---------------------------------------------------------------------------
// unit-level contract details
// ---------------------------------------------------------------------------

test('D-04/13 normalizeEvent returns null for an unusable start and keeps the verbatim dateTime', () => {
  assert.equal(normalizeEvent({ summary: 'no start', start: {} }, 'America/New_York'), null);
  assert.equal(normalizeEvent({ summary: 'no start field' }, 'America/New_York'), null);
  assert.deepEqual(normalizeEvent({
    summary: 'timed', start: { dateTime: '2018-08-23T07:30:00-07:00' }, end: {},
  }, 'America/New_York'), {
    summary: 'timed', fullDay: false,
    start: { dateTime: '2018-08-23T07:30:00-07:00', timestamp: 1535034600000 },
  });
  assert.deepEqual(normalizeEvent({ summary: 'day', start: { date: '2018-08-23' } }, 'America/New_York').start,
    { dateTime: '2018-08-23T00:00:00-04:00', timestamp: 1534996800000 });
});

test('D-04/14 endDateOffsetMinutes reads the offset written in endDate (moment.parseZone)', () => {
  assert.equal(endDateOffsetMinutes('2050-12-18T23:59:59-07:00'), -420);
  assert.equal(endDateOffsetMinutes('2050-12-18T23:59:59+05:30'), 330);
  assert.equal(endDateOffsetMinutes('2050-12-18T23:59:59.000Z'), 0);
});

test('D-04/15 validateCalendar defaults the endDate and rejects a bad one', () => {
  const q = (s) => new URLSearchParams(s);
  const parsed = validateCalendar(q('skillId=s&accountId=a&calendar=personalCalendar'));
  assert.equal(parsed.endDate, buildDefaultEndDate(1));
  assert.throws(() => validateCalendar(q('skillId=s&accountId=a&calendar=c&endDate=nope')),
    /^Error: Invalid end date: nope$/);
  assert.throws(() => validateCalendar(q('accountId=a&calendar=c'), 'outlook'),
    /^Error: Missing skillId in Outlook Calendar request$/);
});

// ---------------------------------------------------------------------------
// upstream request params — the D04a gap: unported client pagination/ordering
// ---------------------------------------------------------------------------

test('D-04/16 the upstream query shows exactly the reference client params', () => {
  const endDate = '2050-12-18T23:59:59-07:00';
  const timeMax = new Date(endDate).toISOString(); // pinned test: new Date(endDate).toISOString()

  const google = buildUpstreamQuery('google', { endDate, now: Date.parse('2026-06-12T12:00:00Z') });
  assert.deepEqual(google, {
    method: 'GET',
    path: '/calendar/v3/calendars/primary/events',
    calendarId: 'primary',
    params: {
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: '2026-06-12T12:00:00.000Z',
      timeMax,
    },
  });

  const outlook = buildUpstreamQuery('outlook', { endDate, now: Date.parse('2026-06-12T12:00:00Z') });
  assert.deepEqual(outlook, {
    method: 'GET',
    path: '/v1.0/me/calendarView',
    params: {
      startDateTime: '2026-06-12T12:00:00.000Z',
      endDateTime: timeMax,
      $select: 'subject,start,end,isAllDay',
      $orderby: 'start/dateTime ASC',
    },
  });
});

test('D-04/17 a GET reaches the provider with the Google upstream query attached', async () => {
  const endDate = '2050-12-18T23:59:59-07:00';
  await json(url('google', 'up-g', `&endDate=${endDate}`));
  const { ctx } = callsFor('up-g')[0];
  const up = ctx.upstreamQuery;
  assert.equal(up.method, 'GET');
  assert.equal(up.path, '/calendar/v3/calendars/primary/events');
  assert.equal(up.calendarId, 'primary');
  assert.equal(up.params.singleEvents, true, 'GoogleCalendarClient.ts:125');
  assert.equal(up.params.orderBy, 'startTime', 'GoogleCalendarClient.ts:128');
  assert.equal(up.params.timeMax, new Date(endDate).toISOString(), 'GoogleCalendarClient.ts:127');
  assert.ok(Math.abs(Date.parse(up.params.timeMin) - Date.now()) < 10_000,
    'timeMin is "now" (GoogleCalendarClient.ts:126)');
});

test('D-04/18 a GET reaches the provider with the Graph upstream query attached', async () => {
  const endDate = '2050-12-18T23:59:59-07:00';
  await json(url('outlook', 'up-o', `&endDate=${endDate}`));
  const { ctx } = callsFor('up-o')[0];
  const up = ctx.upstreamQuery;
  assert.equal(up.method, 'GET');
  assert.equal(up.path, '/v1.0/me/calendarView');
  assert.equal(up.params.endDateTime, new Date(endDate).toISOString(), 'OutlookCalendarClient.ts:148');
  assert.equal(up.params.$orderby, 'start/dateTime ASC', 'OutlookCalendarClient.ts:152');
  assert.equal(up.params.$select, 'subject,start,end,isAllDay', 'OutlookCalendarClient.ts:151');
  assert.ok(Math.abs(Date.parse(up.params.startDateTime) - Date.now()) < 10_000,
    'startDateTime is "now" (OutlookCalendarClient.ts:147)');
});

test('D-04/19 createUpstreamCalendarProvider issues the pinned wire query and returns the fixtures', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/calendar/v3/calendars/primary/events')) { res.end(JSON.stringify(googleEvents)); return; }
    if (req.url.startsWith('/calendar/v3/calendars/primary')) { res.end(JSON.stringify({ timeZone: 'America/Los_Angeles' })); return; }
    if (req.url.startsWith('/v1.0/me/calendarView')) { res.end(JSON.stringify(outlookEvents)); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => upstream.listen(7810, resolve));
  const upstreamBase = 'http://localhost:7810';
  const service = await createDataService({
    cache: new TTLCache(),
    googleCalendarProvider: createUpstreamCalendarProvider({ serviceName: 'google', baseUrl: upstreamBase, getToken: () => 'goog-token' }),
    outlookCalendarProvider: createUpstreamCalendarProvider({ serviceName: 'outlook', baseUrl: upstreamBase, getToken: () => 'graph-token' }),
  }).listen(7811);
  try {
    const wireBase = 'http://localhost:7811';
    const endDate = '2050-12-18T23:59:59-07:00';
    const g = await (await fetch(`${wireBase}${url('google', 'wire-g', `&endDate=${endDate}`)}`)).json();
    assert.deepEqual(Object.keys(g), ['relayData', 'lassoDataFromRedis'], 'no top-level mirror');
    assert.deepEqual(g.relayData.events.map((e) => e.summary),
      ['Event With Start and End Date', 'Event With Start and End Time'],
      'the Google fixture reached the envelope through the real HTTP provider');

    const o = await (await fetch(`${wireBase}${url('outlook', 'wire-o', `&endDate=${endDate}`)}`)).json();
    assert.deepEqual(o.relayData.events.map((e) => e.summary),
      ['Outlook Event 1', 'Outlook Event 2', 'Outlook Event 3']);

    // what actually went on the wire
    const gq = new URLSearchParams(seen.find((u) => u.startsWith('/calendar/v3/calendars/primary/events')).split('?')[1]);
    assert.equal(gq.get('singleEvents'), 'true', 'pinned GoogleCalendar.test.ts:170');
    assert.equal(gq.get('orderBy'), 'startTime', 'pinned GoogleCalendar.test.ts:169');
    assert.equal(gq.get('timeMax'), new Date(endDate).toISOString(), 'pinned GoogleCalendar.test.ts:171');
    assert.ok(Math.abs(Date.parse(gq.get('timeMin')) - Date.now()) < 10_000);

    const oq = new URLSearchParams(seen.find((u) => u.startsWith('/v1.0/me/calendarView')).split('?')[1]);
    assert.equal(oq.get('endDateTime'), new Date(endDate).toISOString(), 'pinned OutlookCalendar.test.ts:190');
    assert.equal(oq.get('$orderby'), 'start/dateTime ASC', 'pinned OutlookCalendar.test.ts:189');
    assert.equal(oq.get('$select'), 'subject,start,end,isAllDay');
    assert.ok(seen.includes('/calendar/v3/calendars/primary'), 'getCalendarTimezone issued (GoogleCalendarHandler.ts:109)');
  } finally {
    service.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
