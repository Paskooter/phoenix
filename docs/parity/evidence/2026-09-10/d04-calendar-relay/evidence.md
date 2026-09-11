# D-04 evidence — Google/Outlook calendar relay compatibility

Track: pegasus · P0 · worktree `.parity/worktrees/w14-d04` (branch `w14/d04`, base `6c94aac`).
Reference revision: `5c0a7390539663ba749d360de348a428c088505c` (pinned tree at
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`).
Evidence labels: **VERIFIED** (observed by running something) / **INFERRED**
(reasoned from pinned source) / **UNKNOWN** (no claim).

> Note on sources: this subagent's runtime did not expose the Jibo archive MCP
> (`jibo_search`/`jibo_read`/`gitea_read_file`) and `pvindex.org` resolved to a
> private address (web_extract: "URL targets a private or internal network
> address"), so every pinned quote below is read from the byte-identical local
> pinned tree at the same commit (the w11 evidence already recorded the MCP copy
> as byte-identical). MCP-equivalence is therefore **INFERRED**, and every
> source:line citation is against the pinned tree at `5c0a739`.

## Pinned contract (source, quoted)

* `packages/lasso/src/relay/AbstractRelayRequestHandler.ts`
  — the shared relay contract this task reproduces:
  `:17-23` `this.router.head("/", …)` before `get("/", …)`, `LassoResponse<R> = { relayData: R }`;
  `:69-73` an empty 200 for HEAD then carry on; `:77-98` the `skipCache` truthiness + cache read;
  `:88-94` a hit is sent as the stored **string** (`response.send`, i.e. text/html);
  `:112-117` `const relayResponse = this.addRelayParams(finalData, { lassoDataFromRedis: false }); response.json(relayResponse);`
  — **exactly two keys**; `:119-131` `redisSet` runs regardless of request type and adds
  `lassoDataFromRedis: true` + `lassoInsertedIntoRedisAt` at `EX cacheSecondsToLive`; `:143-145`
  `addRelayParams` = `Object.assign({}, data, params)`.
* `packages/lasso/src/relay/GoogleCalendarHandler.ts`
  * `:16` `protected cacheSecondsToLive = 60;`
  * `:26-35` `onNewCredentialArrived` deletes `google_calendar:<skillId>:<accountId>:<calendar>`
    when `credential.serviceName === 'google'`.
  * `:37-58` `validateAndExtractInputs` throws `Missing skillId/accountId/calendar type in Google
    Calendar request`, validates a supplied endDate, defaults `request.query.endDate ||
    DateTimeUtils.buildDefaultEndDate(1)`.
  * `:60-62` the redis key; `:71-82` credential lookup and `Error: No credentials for <calendar>`;
    `:91-103` refresh on expiry, `REFRESH_FAILED` on failure; `:106` `const calendarId = 'primary';`
    `:108-117` `client.getCalendarTimezone(calendarId)` then `client.getEvents(calendarId, endDate)`,
    `presentEvent` + `.filter(event => event !== null)` → `{ events }`;
    `:118-125` `/expired or revoked/` → `REVOKED_ACCESS`.
* `packages/lasso/src/relay/OutlookCalendarHandler.ts:18,28-37,39-59,61-63,71-80,93-105,107-116,117-124`
  — the mirror image: `cacheSecondsToLive = 60`, `outlook_calendar:<skillId>:<accountId>:<calendar>`,
  scopes `[Calendars.Read, offline_access]`, `client.getEvents(request.endDate)`,
  `moment.parseZone(request.endDate).utcOffset()` fed to `OutlookCalendarUtils.presentEvent`,
  `InvalidAuthenticationToken` → `INVALID_TOKEN`.
* **Upstream client params (the D04a gap, now ported):**
  * `packages/lasso/src/calendar-client/GoogleCalendarClient.ts:119-138`
    ```ts
    const response = await calendar.events.list({
        auth: this.oAuth2Client,
        calendarId: calendarId,
        singleEvents: true,
        timeMin: new Date().toISOString(),
        timeMax: new Date(endDate).toISOString(),
        orderBy: 'startTime',
    });
    ```
    pinned wire assertion `tests/relay/GoogleCalendar.test.ts:168-172`
    (`orderBy: 'startTime'`, `singleEvents: 'true'`, `timeMax = new Date(endDate).toISOString()`).
  * `packages/lasso/src/calendar-client/OutlookCalendarClient.ts:138-162`
    ```ts
    const startDateTime = new Date().toISOString();
    const endDateTime = new Date(endDate).toISOString();
    const result = await graphClient
        .api(`/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}`)
        .select('subject,start,end,isAllDay')
        .orderby('start/dateTime ASC')
        .get();
    ```
    pinned wire assertion `tests/relay/OutlookCalendar.test.ts:179-199`
    (`$orderby: 'start/dateTime ASC'`, `endDateTime = new Date(endDate).toISOString()`).
* `packages/lasso/src/utils/DateTimeUtils.ts:9-23`, `GoogleCalendarUtils.ts:16-62`,
  `OutlookCalendarUtils.ts:14-54` — endDate validation/default, event presentation
  (timezone/all-day, verbatim dateTimes, invalid-event filtering) as recorded in the w11 evidence.
* `tests/relay/GoogleCalendar.test.ts:132-162` / `OutlookCalendar.test.ts:126-145` — the exact
  expected body `{ lassoDataFromRedis: false, relayData: { events: [ … ] } }` (a deep-equal:
  no third key).
* fixtures `tests/test-data/google/{fake-events-response.json,chicago-events-response.json,fake-calendar-response.json}`
  and `tests/test-data/outlook/fake-events-response.json` — copied verbatim into
  `packages/data/test/fixtures/calendar/` (sha256 in `runtime.json`).

## What this change closes (the two items that held D-04 unverified)

1. **Top-level `events` mirror removed.** `packages/data/src/calendar.js` `relayEnvelope` now
   returns exactly `{ relayData, lassoDataFromRedis }` (+ `lassoInsertedIntoRedisAt` on a hit),
   matching `AbstractRelayRequestHandler.ts:112-131` and the pinned deep-equal bodies. The only
   reason the mirror existed was the certified D-02/D-03 assertions on `body.events`; those two
   files were edited to read the reference path `body.relayData.events` with justification inline
   (`packages/data/test/credential.test.js:98-107`, `packages/data/test/oauth.test.js:211-215`,
   `:310-332`). Their findings are unchanged: a stored credential still reaches the calendar route
   with the provider events, and refresh/revocation/skipCache/invalidation still observe the same
   events — just at `relayData.events`.
2. **Upstream pagination/ordering params ported and proved at runtime.**
   `packages/data/src/calendar.js` gains `buildUpstreamQuery(serviceName, {endDate, now})` — the
   exact Google (`singleEvents/orderBy/timeMin/timeMax`) and Graph (`startDateTime/endDateTime/
   $select/$orderby`) descriptor — and `createUpstreamCalendarProvider(...)`, a real HTTP provider
   that issues it. The handler passes the descriptor to the provider as `ctx.upstreamQuery`
   (`calendar.js` provider call), and `packages/data/src/index.js` wires the real provider behind
   `ETCO_lasso_calendarUpstreamUrl` (takes precedence over the fixture directory).

## Runtime observations — VERIFIED

Harness: `packages/data/scripts/calendar-runtime.mjs` → `runtime.json`.

| step | observed |
| --- | --- |
| A1 GET `/v1/google_calendar?…&endDate=2050-12-18T23:59:59-07:00` | 200, `application/json; charset=utf-8`, **exactly** keys `[relayData, lassoDataFromRedis]`, `relayData.events` byte-equal to the pinned expectation (`matchesPinnedExpectation: true`) |
| A2 GET `/v1/outlook_calendar` | 200, the pinned Outlook expectation (timed `-07:00`, all-day `1524553200000`) |
| A3 HEAD | 200, null content-type/length, 0 body bytes, then the cache is warmed |
| A3b GET after that HEAD | `text/html; charset=utf-8`, `lassoDataFromRedis: true`, `lassoInsertedIntoRedisAt` present |
| A4 miss vs hit | miss `application/json` `[relayData, lassoDataFromRedis]`; hit `text/html` `[relayData, lassoDataFromRedis, lassoInsertedIntoRedisAt]`, `hitIsStoredBytes: true` |
| A5 60 s cache vs invalidation | provider fixture change still served from cache, then `POST /v1/credential` → next GET `lassoDataFromRedis: false` with the new summary |
| A6 validation | `endDate=2018-13-45` → 400 `Invalid end date: 2018-13-45`; missing skillId → 400 `Missing skillId in Outlook Calendar request` |
| **C upstream params on the wire** | a second real binary (`ETCO_lasso_calendarUpstreamUrl` → the real HTTP provider) against a mock Calendar API recorded: Google `/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=<now ISO>&timeMax=2050-12-19T06:59:59.000Z` and Graph `/v1.0/me/calendarView?startDateTime=<now ISO>&endDateTime=2050-12-19T06:59:59.000Z&$select=subject,start,end,isAllDay&$orderby=start/dateTime+ASC`; `timezoneRequestIssued: true`; envelope keys `[relayData, lassoDataFromRedis]`; both fixtures reached the envelope |
| B report path | `reportCalendar.getData()` → `LassoClient` → this binary → category `calendar`, 3 events, `calendarParse` `{numEventsToday: 0, numEventsTomorrow: 2}`, MIM `["NothingToday"]`, no report log error |

Unit gates (VERIFIED): `packages/data/test/calendar-relay.test.js` — 19 tests, incl. D-04/16 (the
descriptor deep-equals the pinned params), D-04/17//18 (the provider receives `ctx.upstreamQuery`),
D-04/19 (the real HTTP provider puts the pinned query on the wire and returns the fixtures); and
`packages/skills/test/calendar-lasso-integration.test.js` (3 report-integration tests).
Full suite `npm test` → `# tests 1840 / # pass 1833 / # fail 0 / # cancelled 0 / # skipped 7`,
`EXIT=0`; `parity:check` valid (51/79); `parity:gate`
`{"result":"match","cases":43,"differences":0,"invariants":0,"coverageGaps":0}`.

## Falsification — VERIFIED (details in `falsification.json`)

* **f1** `calendar.js` `orderBy: 'startTime',` → `'startTime-BROKEN',`: **D-04/16, D-04/17, D-04/19
  fail** (`# pass 16 / # fail 3`). Restored → 19/19 green.
* **f2** `relayEnvelope` body re-adds `events`: **D-04/1, D-04/5, D-04/19 and the certified D-02
  `credential.test.js` test fail** (`# pass 24 / # fail 4`). Restored → 28/28 green.

## Divergences

1. ~~Top-level `events` mirror~~ — **closed**: removed, both certified test files edited to the
   reference path, findings preserved, falsified above.
2. Report-side `endDate` rendering (unchanged). `packages/skills/src/report/calendar.js:28-33`
   (`endOfTomorrowISO` → `toISOString()`) sends the same *instant* as the pinned
   `moment.parseZone(iso).add(1,'day').endOf('day').format()` (CalendarData.ts:22) but as UTC, so no
   offset designator survives to Lasso. The data service handles an offset endDate correctly
   (D-04/11); the fix belongs to the report file, outside D-04's `phoenix` file list. Pinned
   observationally by D-04/i3.
3. `skipCache` on the calendar route duplicates a private `relay.js` helper because `relay.js` does
   not export it (D-01's file is off-limits for this task).

## Status

* **VERIFIED**: relay envelope on GET miss with exactly the reference keys (no mirror); HEAD empty
  200 + cache warm; 60 s cache storing the envelope and echoing the stored bytes as `text/html`;
  `skipCache` truthiness; credential-triggered invalidation end to end (real binary + real
  `POST /v1/credential`); endDate default/validation; missing-input 400 wording per service; the
  pinned Google/Graph upstream query issued on the wire by the real provider (params, paths and
  bearer token observed by a mock upstream); Google/Outlook presentation parity against the pinned
  fixtures; report→data→provider-fixture integration.
* **INFERRED**: TTLcache ↔ `redisClient.del`/`set EX 60` (D-01 certified); `moment.parseZone(…)
  .utcOffset()` ↔ `endDateOffsetMinutes`; the pinned-tree quotes are MCP-equivalent (MCP/pvindex
  unreachable from this runtime, see note); the upstream error-body → message mapping
  (`Failed to get Google Calendar events, Google response was <status> <detail>`) matches the
  reference `throwError` shape only in structure, not byte-for-byte.
* **UNKNOWN**: live Google/Outlook API behaviour (rate limits, real pagination tokens — the pinned
  clients issue no `pageToken`/`@odata.nextLink` loop, so none is ported); Windows zone ids outside
  the small alias table fall back to UTC because Node's `Intl` has no CLDR zone mapping.
