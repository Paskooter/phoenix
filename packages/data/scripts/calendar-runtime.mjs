// D-04 runtime demonstration — drives the REAL `node packages/data/src/index.js`
// data service over HTTP and then drives the REAL report path against it.
//
//   phase A (pinned fixture):  GET/HEAD/cache/invalidation/endDate validation on both
//     providers, with the pinned lasso fixtures served by ETCO_lasso_calendarFixtureDir
//     (the D-04 analogue of ETCO_lasso_googleTokenUrl).
//   phase B (report):          reportCalendar.getData() -> LassoClient -> this binary,
//     proving a provider returning events reaches the report rather than failing
//     envelope parsing (acceptance item 3).
//   phase C (upstream params): a second real binary wired with
//     ETCO_lasso_calendarUpstreamUrl (the real HTTP provider) against a mock
//     Calendar API that records the pinned upstream query
//     (singleEvents/orderBy/timeMin/timeMax, Graph endDateTime/$orderby).
//
// Emits a JSON report on stdout:
//   node packages/data/scripts/calendar-runtime.mjs > runtime.json
//
// This is an operator/QA harness; the falsifiable gates are
// packages/data/test/calendar-relay.test.js and
// packages/skills/test/calendar-lasso-integration.test.js.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // packages/data/scripts -> repo root
const FIXTURES = join(REPO, 'packages', 'data', 'test', 'fixtures', 'calendar');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const PORT = 8913;
const base = `http://localhost:${PORT}`;
// Phase C: a second real binary wired to the real HTTP provider
// (ETCO_lasso_calendarUpstreamUrl) and a local mock Calendar API that records the
// exact upstream request (the pinned singleEvents/orderBy/timeMin/timeMax and
// Graph endDateTime/$orderby).
const UPSTREAM_SERVICE_PORT = 8914;
const MOCK_UPSTREAM_PORT = 8915;
const upstreamBase = `http://localhost:${UPSTREAM_SERVICE_PORT}`;
const mockUpstreamBase = `http://localhost:${MOCK_UPSTREAM_PORT}`;
const END_DATE_WEST = '2050-12-18T23:59:59-07:00';
const url = (service, accountId, extra = '') => `/v1/${service}_calendar?skillId=skill1&accountId=${accountId}&calendar=personalCalendar&endDate=${END_DATE_WEST}${extra}`;

const dir = mkdtempSync(join(tmpdir(), 'd04-calendar-runtime-'));
const fixtureDir = join(dir, 'calendar');
mkdirSync(fixtureDir, { recursive: true });
const credentialsFile = join(dir, 'credentials.json');
const credentialsFileUpstream = join(dir, 'credentials-upstream.json');

const googleFixture = join(FIXTURES, 'google-events.json');
const googleCalendarFixture = join(FIXTURES, 'google-calendar.json');
const chicagoFixture = join(FIXTURES, 'google-events-chicago.json');
const outlookFixture = join(FIXTURES, 'outlook-events.json');
const googleBody = () => JSON.parse(readFileSync(googleFixture, 'utf8'));
const outlookBody = () => JSON.parse(readFileSync(outlookFixture, 'utf8'));

// The fixture directory holds the raw API responses the real clients consume:
// Google events.list `{items}` + the calendar resource `{timeZone}`, Graph
// calendarView `{value}`.
const writeFixtures = () => {
  writeFileSync(join(fixtureDir, 'google.json'), JSON.stringify(googleBody()));
  writeFileSync(join(fixtureDir, 'google-calendar.json'), readFileSync(googleCalendarFixture));
  writeFileSync(join(fixtureDir, 'outlook.json'), JSON.stringify(outlookBody()));
};
writeFixtures();

const report = {
  harness: 'packages/data/scripts/calendar-runtime.mjs',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  fixtureSha256: {
    'google-events.json': sha256(googleFixture),
    'google-events-chicago.json': sha256(chicagoFixture),
    'outlook-events.json': sha256(outlookFixture),
    'google-calendar.json (timeZone America/Los_Angeles)': sha256(join(FIXTURES, 'google-calendar.json')),
    'google-calendar-chicago.json (timeZone America/Chicago)': sha256(join(FIXTURES, 'google-calendar-chicago.json')),
  },
  steps: [],
};

function startService() {
  const child = spawn(process.execPath, [join(REPO, 'packages/data/src/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ETCO_data_credentialsFile: credentialsFile,
      ETCO_lasso_calendarFixtureDir: fixtureDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

/** Phase C: the same binary with the real upstream HTTP provider wired in. */
function startUpstreamService() {
  const child = spawn(process.execPath, [join(REPO, 'packages/data/src/index.js')], {
    env: {
      ...process.env,
      PORT: String(UPSTREAM_SERVICE_PORT),
      ETCO_data_credentialsFile: credentialsFileUpstream,
      ETCO_lasso_calendarUpstreamUrl: mockUpstreamBase,
      ETCO_lasso_calendarUpstreamToken: 'rt-upstream-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

async function waitHealthy(origin = base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${origin}/healthcheck`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`service at ${origin} did not become healthy`);
}

const get = (p) => fetch(`${base}${p}`);
const read = async (p) => {
  const r = await get(p);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, contentType: r.headers.get('content-type'), body, text };
};
const readAt = async (origin, p) => {
  const r = await fetch(`${origin}${p}`);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, contentType: r.headers.get('content-type'), body, text };
};

// Mock Calendar API for phase C: records every request and serves the pinned
// raw client responses (Google `{items}` + calendar resource, Graph `{value}`).
const upstreamRequests = [];
const mockUpstream = http.createServer((req, res) => {
  upstreamRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/calendar/v3/calendars/primary/events')) { res.end(readFileSync(googleFixture)); return; }
  if (req.url.startsWith('/calendar/v3/calendars/')) { res.end(readFileSync(googleCalendarFixture)); return; }
  if (req.url.startsWith('/v1.0/me/calendarView')) { res.end(readFileSync(outlookFixture)); return; }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((resolve) => mockUpstream.listen(MOCK_UPSTREAM_PORT, resolve));

const child = startService();
const upstreamChild = startUpstreamService();
try {
  await waitHealthy();
  await waitHealthy(upstreamBase);

  // --- A1. pinned Google replay through the real binary ---------------------
  const a1 = await read(url('google', 'rt-google'));
  report.steps.push({
    step: 'A1_get_pinned_google_fixture',
    status: a1.status,
    contentType: a1.contentType,
    envelopeKeys: Object.keys(a1.body),
    lassoDataFromRedis: a1.body.lassoDataFromRedis,
    relayData: a1.body.relayData,
    matchesPinnedExpectation: JSON.stringify(a1.body.relayData) === JSON.stringify({
      events: [
        {
          summary: 'Event With Start and End Date',
          fullDay: true,
          start: { dateTime: '2018-04-21T00:00:00-07:00', timestamp: 1524294000000 },
          end: { dateTime: '2018-04-23T00:00:00-07:00', timestamp: 1524466800000 },
        },
        {
          summary: 'Event With Start and End Time',
          fullDay: false,
          start: { dateTime: '2018-08-23T07:30:00-07:00', timestamp: 1535034600000 },
          end: { dateTime: '2018-08-23T08:30:00-07:00', timestamp: 1535038200000 },
        },
      ],
    }),
  });

  // --- A2. Outlook replay (endDate offset drives the rendering) ------------
  const a2 = await read(url('outlook', 'rt-outlook'));
  report.steps.push({
    step: 'A2_get_pinned_outlook_fixture',
    status: a2.status,
    lassoDataFromRedis: a2.body.lassoDataFromRedis,
    relayData: a2.body.relayData,
  });

  // --- A3. HEAD: empty 200, no entity headers, warms the cache -------------
  const head = await fetch(`${base}${url('google', 'rt-head')}`, { method: 'HEAD' });
  report.steps.push({
    step: 'A3_head',
    status: head.status,
    contentType: head.headers.get('content-type'),
    contentLength: head.headers.get('content-length'),
    bodyBytes: (await head.text()).length,
  });
  const afterHead = await read(url('google', 'rt-head'));
  report.steps.push({
    step: 'A3b_get_after_head_is_a_cache_hit',
    lassoDataFromRedis: afterHead.body.lassoDataFromRedis,
    contentType: afterHead.contentType,
    hasInsertedAt: typeof afterHead.body.lassoInsertedIntoRedisAt === 'string',
    events: afterHead.body.relayData.events.length,
  });

  // --- A4. cache hit is byte-identical plus lassoInsertedIntoRedisAt -------
  const first = await read(url('google', 'rt-cache'));
  const second = await read(url('google', 'rt-cache'));
  const expectedHit = JSON.stringify({
    ...JSON.parse(JSON.stringify(first.body)),
    lassoDataFromRedis: true,
    lassoInsertedIntoRedisAt: second.body.lassoInsertedIntoRedisAt,
  });
  report.steps.push({
    step: 'A4_cache_hit_echoes_stored_bytes',
    missContentType: first.contentType,
    hitContentType: second.contentType,
    hitIsStoredBytes: second.text === expectedHit,
    missKeyOrder: Object.keys(first.body),
    hitKeyOrder: Object.keys(second.body),
  });

  // --- A5. 60s cache survives a provider change; a new credential drops it --
  writeFileSync(join(fixtureDir, 'google.json'), JSON.stringify({
    items: [{
      summary: 'AFTER FIXTURE CHANGE', fullDay: false,
      start: { dateTime: '2018-08-23T10:00:00-07:00' }, end: { dateTime: '2018-08-23T10:30:00-07:00' },
    }],
  }));
  const stillCached = await read(url('google', 'rt-cache'));
  const seeded = await fetch(`${base}/v1/credential`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: 'rt-cache', skillId: 'skill1', serviceName: 'google', serviceAccountName: 'personalCalendar',
      scopes: ['read'], clientId: 'c1', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600 * 1000,
    }),
  });
  const afterCredential = await read(url('google', 'rt-cache'));
  writeFixtures(); // restore the pinned fixture for the remaining steps
  report.steps.push({
    step: 'A5_credential_invalidation',
    cachedStillV1: stillCached.body && stillCached.body.relayData
      ? `${stillCached.body.relayData.events[0].summary} (fromRedis=${stillCached.body.lassoDataFromRedis})`
      : `UNEXPECTED ${stillCached.status} ${stillCached.text}`,
    credentialPostStatus: seeded.status,
    credentialPostBody: await seeded.json(),
    afterCredentialFromRedis: afterCredential.body.lassoDataFromRedis,
    afterCredentialSummary: afterCredential.body.relayData.events[0].summary,
  });

  // --- A6. endDate validation + default ------------------------------------
  const badDate = await read(url('google', 'rt-date', '').replace(END_DATE_WEST, '2018-13-45'));
  const missing = await read('/v1/outlook_calendar?accountId=a&calendar=c');
  report.steps.push({
    step: 'A6_validation',
    invalidEndDate: { status: badDate.status, contentType: badDate.contentType, body: badDate.body },
    missingSkillIdOutlook: { status: missing.status, body: missing.body },
  });

  // --- C. upstream params on the wire through the REAL HTTP provider --------
  // The second real binary (startUpstreamService) is wired with
  // ETCO_lasso_calendarUpstreamUrl; the mock Calendar API records every request,
  // proving the pinned singleEvents/orderBy/timeMin/timeMax and Graph
  // endDateTime/$orderby actually leave the service.
  const cg = await readAt(upstreamBase, url('google', 'rt-up-g'));
  const co = await readAt(upstreamBase, url('outlook', 'rt-up-o'));
  const parseUpstream = (u) => Object.fromEntries(new URLSearchParams(u.split('?')[1] || ''));
  const googleReq = upstreamRequests.find((r) => r.url.startsWith('/calendar/v3/calendars/primary/events'));
  const graphReq = upstreamRequests.find((r) => r.url.startsWith('/v1.0/me/calendarView'));
  report.steps.push({
    step: 'C_upstream_params_on_the_wire',
    googleEnvelopeKeys: Object.keys(cg.body),
    googleEvents: cg.body.relayData.events.map((e) => e.summary),
    outlookEvents: co.body.relayData.events.map((e) => e.summary),
    googleEventsRequest: { url: googleReq.url, authorization: googleReq.authorization, params: parseUpstream(googleReq.url) },
    outlookEventsRequest: { url: graphReq.url, authorization: graphReq.authorization, params: parseUpstream(graphReq.url) },
    timezoneRequestIssued: upstreamRequests.some((r) => r.url === '/calendar/v3/calendars/primary'),
    allUpstreamRequests: upstreamRequests.map((r) => r.url),
  });

  // --- B. the real report path against this binary -------------------------
  const reportFixtureEvents = (() => {
    const now = new Date();
    const day = (offset) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    return [
      { summary: 'Work standup', start: { dateTime: `${day(1)}T09:00:00Z` }, end: { dateTime: `${day(1)}T09:30:00Z` } },
      { summary: 'Dinner with Sam', start: { dateTime: `${day(1)}T18:00:00Z` }, end: { dateTime: `${day(1)}T19:30:00Z` } },
      { summary: 'Dentist', start: { dateTime: `${day(2)}T09:00:00Z` }, end: { dateTime: `${day(2)}T09:30:00Z` } },
    ];
  })();
  writeFileSync(join(fixtureDir, 'google.json'), JSON.stringify({ items: reportFixtureEvents }));
  writeFileSync(join(fixtureDir, 'google-calendar.json'), JSON.stringify({ timeZone: 'UTC' }));

  process.env.NET_lasso = `localhost:${PORT}`;
  const { clearReportEnvCache } = await import('../../skills/src/report/env.js');
  clearReportEnvCache();
  const { LassoClient } = await import('../../skills/src/report/lassoClient.js');
  const { getData, calendarParse } = await import('../../skills/src/report/calendar.js');
  const { CalendarMimLogic } = await import('../../skills/src/report/calendar.js');

  const log = { debug() {}, info() {}, warn() {}, error(...a) { report.steps.push({ step: 'report_log_error', args: a.map(String) }); } };
  const data = {
    log,
    skill: { id: 'report-skill', session: { data: { _personalReport: { singleSkill: null } } } },
    local: { userPrefs: {} },
    runtime: {
      location: { iso: new Date().toISOString().replace('Z', '+00:00') },
      loop: { loopId: 'loop-1', users: [{ id: 'u1', name: 'Alice Smith', accountId: 'acct-1', birthdate: '1990-01-01' }] },
      perception: { speaker: 'u1' },
    },
    req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 'rt-transid', 'x-jibo-robotid': 'rt-robot', 'x-jibo-logging-config': '{}' }) } },
  };

  const direct = await LassoClient.fetchCalendarEvents(data, 'google', 'personalCalendar', new Date(Date.now() + 86400000).toISOString());
  const [name, events] = await getData({ calendar: { googlePersonalCreds: true } }, data);
  const parsed = calendarParse(events, data);
  const mimPaths = new CalendarMimLogic('runtime').getFullReportMims({
    ...data, local: { ...data.local, calendar: parsed },
  });
  report.steps.push({
    step: 'B_report_reaches_the_report',
    lassoClientRelayData: direct,
    reportCategory: name,
    reportEvents: events.map((e) => ({ summary: e.summary, start: e.start.dateTime, timestamp: e.start.timestamp })),
    parse: { numEventsToday: parsed.numEventsToday, numEventsTomorrow: parsed.numEventsTomorrow },
    mimPaths,
  });
} finally {
  child.kill('SIGKILL');
  upstreamChild.kill('SIGKILL');
  await new Promise((resolve) => mockUpstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
