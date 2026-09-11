# D-04 evidence — Google/Outlook calendar relay compatibility

Track: pegasus · P0 · worktree `.parity/worktrees/w11-d04` (branch `w11/d04`, base `b541630`).
Reference revision: `5c0a7390539663ba749d360de348a428c088505c` (pinned tree at
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`, re-read through the archive MCP).
Evidence labels: **VERIFIED** (observed by running something) / **INFERRED**
(reasoned from pinned source) / **UNKNOWN** (no claim).

## Pinned contract (source, quoted)

Read through the Jibo archive MCP (`gitea_read_file`, repo `jiboV2/pegasus`) at
`5c0a7390539663ba749d360de348a428c088505c`; the MCP content is byte-identical to
the local pinned tree for every quoted file.

* <https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/AbstractRelayRequestHandler.ts>
  — the shared relay contract this task had to reproduce:
  * `:17-23` `this.router.head("/", …)` **before** `this.router.get("/", …)`,
    `cacheSecondsToLive` abstract, `LassoResponse<R> = { relayData: R }`.
  * `:69-73` `if (request.method === "HEAD") { response.send(); }` then carry on.
  * `:77-98` `const skipRedisCheck = request.query && request.query.skipCache;`
    — a truthiness test on the qs value, then the cache read.
  * `:88-94` a hit is sent with `response.send(redisPayload)` (stored **string**).
  * `:112-117` `const relayResponse = this.addRelayParams(finalData, { lassoDataFromRedis: false }); response.json(relayResponse);`
  * `:119-131` `redisSet` runs **regardless of request type** and stores
    `{relayData, lassoDataFromRedis: true, lassoInsertedIntoRedisAt}` at `EX cacheSecondsToLive`.
  * `:143-145` `addRelayParams` = `Object.assign({}, data, params)`.
* <https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/GoogleCalendarHandler.ts>
  * `:16` `protected cacheSecondsToLive = 60;`
  * `:26-35` `onNewCredentialArrived` deletes `google_calendar:<skillId>:<accountId>:<calendar>`
    when `credential.serviceName === 'google'`.
  * `:37-58` `validateAndExtractInputs`: throws `Missing skillId in Google Calendar request`,
    `Missing accountId in Google Calendar request`, `Missing calendar type in Google Calendar request`,
    `DateTimeUtils.validateEndDate(endDate)` when endDate is present, and defaults
    `endDate: request.query.endDate || DateTimeUtils.buildDefaultEndDate(1)`.
  * `:60-62` `createRedisKey` = `` `google_calendar:${data.skillId}:${data.accountId}:${data.calendar}` ``.
  * `:71-77` credential lookup by `serviceAccountName: request.calendar` and
    `scopes: [ lasso.GoogleCalendarScopes.read ]`; `:79-82` no credential →
    `Error: No credentials for <calendar>` (→ 502 through `fetchData`).
  * `:91-103` refresh when `Date.now() > expiresAt`; failure → `setInactive(REFRESH_FAILED)`.
  * `:108-117` `client.getCalendarTimezone(calendarId)` then `client.getEvents(calendarId, endDate)`,
    `presentEvent(event, calendarTimezone)` and `.filter(event => event !== null)`,
    returning `{ events }`.
  * `:118-125` `/expired or revoked/` → `setInactive(REVOKED_ACCESS)`.
* `OutlookCalendarHandler.ts:18,28-37,39-59,61-63,71-80,93-105,107-116,117-124` — the mirror
  image: `cacheSecondsToLive = 60`, `outlook_calendar:<skillId>:<accountId>:<calendar>`,
  scopes `[Calendars.Read, offline_access]`, `client.getEvents(request.endDate)`,
  `moment.parseZone(request.endDate).utcOffset()` fed to `OutlookCalendarUtils.presentEvent`,
  `InvalidAuthenticationToken` → `INVALID_TOKEN`.
* `packages/lasso/src/utils/DateTimeUtils.ts:9-14` `validateEndDate` →
  `` throw new Error(`Invalid end date: ${endDate}`) `` on `Number.isNaN(Date.parse(endDate))`;
  `:19-23` `buildDefaultEndDate(1)` = `moment().add(1,'day').endOf('day').toDate().toISOString()`.
* `packages/lasso/src/utils/GoogleCalendarUtils.ts:16-62` `presentEvent` — `start.date` →
  `moment.tz(date, calendarTimezone).startOf('day')` + `fullDay = true`; `start.dateTime` →
  the string **verbatim** plus `moment(...).toDate().getTime()`; no usable start →
  `throw` inside `try` → `return null`; end `date`/`dateTime` mirrored, `delete event.end`
  when absent; `EVENT_DATETIME_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ'` (interfaces/src/lasso.ts:27).
* `packages/lasso/src/utils/OutlookCalendarUtils.ts:14-54` `presentEvent` — `summary = subject`,
  `fullDay = !!isAllDay`, `moment.tz(start.dateTime, start.timeZone)`, an all-day event
  `subtract(tzOffset, 'minutes')`, output rendered `utcOffset(tzOffset)`; no `start.dateTime` → null.
* `packages/lasso/tests/relay/GoogleCalendar.test.ts:132-162` — the exact expected body:
  `{ lassoDataFromRedis: false, relayData: { events: [ … ] } }` with the two fixture events
  and their `timestamp`/`dateTime` pairs; `:168-172` the upstream query must carry
  `orderBy: 'startTime'`, `singleEvents: 'true'`, `timeMax = new Date(endDate).toISOString()`.
* `packages/lasso/tests/relay/OutlookCalendar.test.ts:125-145` and `:179-199` — the same body with
  `+00:00` rendering for a default endDate and `-07:00` rendering + shifted all-day timestamps
  for `endDate=2050-12-18T23:59:59-07:00`; `:151-153` upstream `$orderby: 'start/dateTime ASC'`.
* `packages/lasso/tests/relay/GoogleCalendar.test.ts:53-99` / `OutlookCalendar.test.ts:53-99` —
  the pinned 400 bodies and the 502 body
  `Error getting GoogleCalendar data: Error: No credentials for personalCalendar`.
* `packages/lasso/tests/test-data/google/{fake-events-response.json,chicago-events-response.json,fake-calendar-response.json}`
  and `tests/test-data/outlook/fake-events-response.json` — the fixtures replayed below,
  copied verbatim into `packages/data/test/fixtures/calendar/` (sha256 in `runtime.json`).
* <https://pvindex.org/confluence/display/SDK/Mobile-Settings-Lasso+support+for+Personal+Report+credentials>
  — the Settings↔Lasso credential flow the calendar route's credential lookup serves
  (read via `jibo_read`; it is the settings/credential side, not the relay shape).

## What was missing before this change

`packages/data/src/calendar.js` answered a bare `{ events }`, had no HEAD route, no endDate
default/validation, and normalized events with a generic UTC formatter
(`new Date(iso).toISOString()`), which (a) shifted full-day boundaries into UTC, (b) threw on an
event with no usable start instead of dropping it, (c) used `ev.summary` for Outlook instead of
`subject`, and (d) ignored `fullDay`/`isAllDay` timezone arithmetic. The report's own
`extractResponseData` requires `response.data.relayData`, so a working provider could not reach
the report at all.

## Runtime observations — VERIFIED

Harness: `packages/data/scripts/calendar-runtime.mjs` → `runtime.json` (spawns the real
`node packages/data/src/index.js`, the D-03 pattern; the events provider comes from
`ETCO_lasso_calendarFixtureDir`, the D-04 analogue of the existing `ETCO_lasso_googleTokenUrl`
override).

| step | observed |
| --- | --- |
| A1 GET `/v1/google_calendar?…&endDate=2050-12-18T23:59:59-07:00` | 200, `application/json; charset=utf-8`, keys `[relayData, lassoDataFromRedis, events]`, `lassoDataFromRedis=false`, `relayData.events` **byte-equal to the pinned expectation** (`matchesPinnedExpectation: true`): 1524294000000/`2018-04-21T00:00:00-07:00` + 1524466800000/`2018-04-23T00:00:00-07:00`, 1535034600000/`2018-08-23T07:30:00-07:00` + 1535038200000/`2018-08-23T08:30:00-07:00` |
| A2 GET `/v1/outlook_calendar` | 200, `relayData.events` = the pinned Outlook expectation (Event 1/2 timed at `-07:00`, Event 3 all-day 1524553200000/`2018-04-24T00:00:00-07:00`) |
| A3 HEAD | 200, `content-type` null, `content-length` null, `bodyBytes: 0` — an empty 200, then the cache is warmed |
| A3b GET after that HEAD | `text/html; charset=utf-8`, `lassoDataFromRedis: true`, `lassoInsertedIntoRedisAt` present, 2 events — the warmed key |
| A4 miss vs hit | miss `application/json`, hit `text/html; charset=utf-8`, `hitIsStoredBytes: true`, hit keys `[relayData, lassoDataFromRedis, events, lassoInsertedIntoRedisAt]` |
| A5 60 s cache vs invalidation | provider fixture changed to `AFTER FIXTURE CHANGE` → still `Event With Start and End Date (fromRedis=true)`; then `POST /v1/credential` (direct tokens) → 200 `{created:true}` → next GET `afterCredentialFromRedis: false`, `afterCredentialSummary: "AFTER FIXTURE CHANGE"` |
| A6 validation | `endDate=2018-13-45` → 400 `text/html; charset=utf-8` `Invalid end date: 2018-13-45`; `/v1/outlook_calendar?accountId=a&calendar=c` → 400 `Missing skillId in Outlook Calendar request` |
| B report path | `reportCalendar.getData()` → `LassoClient` → this binary returned category `calendar` with 3 events (`Work standup` 09:00, `Dinner with Sam` 18:00 tomorrow, `Dentist` the day after), `calendarParse` = `{numEventsToday: 0, numEventsTomorrow: 2}`, MIM path `["NothingToday"]` (run before local noon), and **no** report log error |

Unit gates (also VERIFIED): `packages/data/test/calendar-relay.test.js` (15 tests, replays the
pinned fixtures + HEAD/cache/skipCache/invalidation/validation) and
`packages/skills/test/calendar-lasso-integration.test.js` (3 tests: report→data→fixture
integration). Full suite: `npm test` → `# tests 1754 / # pass 1747 / # fail 0 / # cancelled 0 /
# skipped 7`, `EXIT=0`; `parity:check` “Tracker structure, dependencies, evidence links and
generated checklist are valid” (49/79) and `parity:gate`
`{"result":"match","cases":43,"differences":0,"invariants":0,"coverageGaps":0}`.

## Falsification — VERIFIED

Anchor: `packages/data/src/calendar.js:416`

```
      return isHead ? undefined : relayEnvelope(events, false);
```

replaced with

```
      return isHead ? undefined : { events };
```

(the pre-D-04 bare body, GET miss path only). Result: **9 named tests in
`packages/data/test/calendar-relay.test.js` failed** (D-04/1, /2, /3, /5, /6, /7, /9, /11, /12 —
`# pass 6 / # fail 9`) and **2 in
`packages/skills/test/calendar-lasso-integration.test.js`** failed (D-04/i1, D-04/i3),
with the report-side error captured directly as
`Incomplete Lasso data from: google calendar` — the exact failure acceptance item 3 removes.
Restored the line, both files returned `18 tests / 18 pass / 0 fail`. Full detail:
`falsification.json`.

## Divergences recorded (not closed here)

1. **Top-level `events` mirror** (documented in code). The reference emits exactly
   `{relayData, lassoDataFromRedis}` (`tests/relay/GoogleCalendar.test.ts:132-162` deep-equals it),
   but the certified D-02/D-03 Phoenix tests assert `body.events`
   (`packages/data/test/credential.test.js:98-103`; `packages/data/test/oauth.test.js:211-331`).
   D-04 emits both so no certified test breaks. Dropping the mirror is a root decision (it
   requires editing those two certified test files).
2. **Report-side `endDate` rendering**. `packages/skills/src/report/calendar.js:28-33`
   (`endOfTomorrowISO` → `toISOString()`) sends the same *instant* as the pinned
   `moment.parseZone(iso).add(1,'day').endOf('day').format()` (CalendarData.ts:22) but as UTC, so
   no offset designator survives to Lasso: the Outlook `tzOffset` is always 0 for report-initiated
   requests and an all-day Outlook event keeps its UTC midnight instead of the location offset.
   The data service handles an offset endDate correctly (D-04/11); the fix belongs to the report
   file, which is outside D-04's `phoenix` file list. Pinned observationally by D-04/i3.
3. **`skipCache` on the calendar route** now matches the relay truthiness (`relay.js` uses the
   identical `skipCacheRequested`); this duplicates a private helper because `relay.js` does not
   export it (D-01's file is off-limits for this task).

## Status

* **VERIFIED**: relay envelope on GET miss; HEAD empty 200 + cache warm; 60 s cache storing the
  envelope and echoing the stored bytes as `text/html`; `skipCache` truthiness; credential-triggered
  invalidation end to end (real binary + real `POST /v1/credential`); endDate default
  (end of tomorrow, server-local → ISO UTC) and validation; missing-input 400 wording per service;
  Google/Outlook presentation parity against the pinned fixtures (timezone/all-day, verbatim
  dateTimes, invalid-event filtering, missing end); report→data→provider-fixture integration.
* **INFERRED**: the reference `redisClient.del`/`set EX 60` semantics map onto `TTLCache`
  (D-01 already certified the relay/cache contract); `moment.parseZone(...).utcOffset()` ↔
  `endDateOffsetMinutes` for the `±HH:MM`/`Z` forms the reference emits.
* **UNKNOWN**: the live Google/Outlook API clients (`getCalendarTimezone`, `events.list` with
  `singleEvents/orderBy/timeMin/timeMax`, Graph `calendarView` with `$orderby`) are still not
  ported — D-04 consumes a provider of that shape, so upstream pagination/params are unverified
  against the real APIs (the same external gate D-03 recorded for live credentials); Windows zone
  ids outside the small alias table in `calendar.js` fall back to UTC because Node's Intl has no
  CLDR zone mapping.
