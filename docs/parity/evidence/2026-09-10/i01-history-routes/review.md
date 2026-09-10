# I-01 — Match all history HTTP routes and payloads

Review date: 2026-09-10 · Worktree: `.parity/worktrees/w2-i01` (branch `w2/i01`) · Task: I-01 (P0, pegasus, implementation: partial)
Pinned source: Pegasus `5c0a7390539663ba749d360de348a428c088505c`, local checkout
`/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`
(referred to below as `ref:`). Candidate: `docs/parity/candidates/I-01-candidate-20260910.md`.

Every claim is labelled **VERIFIED** (observed at runtime), **INFERRED** (reasoned from pinned
source), or **UNKNOWN**.

---

## 1. Transport determination (required before any shape reasoning)

**VERIFIED — History is plain HTTP/JSON over Express, not AWS-JSON.** The AWS-SDK
shape-stripping rule does **not** apply here.

| Evidence | Result |
|---|---|
| `ref:packages/history/src/HistoryService.ts:24-33` | `addHttpHandler('/v1/skill/launch'|'/v1/speech', {handler, authenticationRequired: false})` |
| `ref:packages/utils/src/service/handlers/BaseHttpHandler.ts:48-80` | `router.get/post/put(path, …)` → `res.status(200).json(result)` |
| `ref:packages/history-client/src/base/BaseHistoryServiceClient.ts:12-29` | client is **axios** (`axios.post/put`), URL = `` `${historyServiceURL}/v1${relativePath}` `` |
| runtime probe `runtime-probe.json` | every JSON route answers `content-type: application/json; charset=utf-8` |

### Gateway and the two-layer auth question

**VERIFIED — the history surface does not sit behind the gateway, and it is unauthenticated.**

* Reference: `HistoryService` is its own `BaseService` process; the hub reaches it through the
  outbound history client. There is no gateway package in the pinned tree
  (`ref:packages/` — baseskill, chitchat-skill, example-skill, history, history-client, hub,
  hub-client, hub-client-cli, integration-tests-*, interfaces, lasso, parser, report-skill,
  template-skill, test-utils, utils, utils-common).
* Phoenix: `packages/gateway/src/historyClient.js:9-17` fetches `` `${this.base}${path}` `` with
  `path` = `/v1/skill/launch…`; `packages/gateway/src/config.js:52` points `historyURL` at the
  **history peer service** (`ETCO_hub_historyUrl`, default `…:9006`). The gateway's own route
  table (`packages/gateway/src/index.js:89-97`) contains no history route, so it never proxies or
  allow-lists history.
* Handler decorators: both handlers are mounted with `authenticationRequired: false`
  (`HistoryService.ts:26,31`), and `BaseService.addHttpHandler` only installs the auth middleware
  when that flag is true and `disableAuth` is false (`BaseService.ts:142-146`). **Neither layer
  gates history.**

---

## 2. Complete route inventory (re-derived from pinned source)

Two Express routers plus the base service route. `:id` is an Express path parameter.

| # | Method | Path (router-relative → wire) | Params | Request body | Success | Source |
|---|---|---|---|---|---|---|
| 1 | POST | `/` → `/v1/skill/launch` | — | `SkillLaunchData` | 200 full record | `SkillLaunchRequestsHandler.ts:20,32-37` |
| 2 | PUT | `/payload` → `/v1/skill/launch/payload` | — | `SkillPayloadData` | 200 record \| `null` | `:21,39-44` |
| 3 | GET | `/latest` → `/v1/skill/launch/latest` | — | IHQuery from **query string** (`req.query`) | 200 record \| `null` | `:24,46-49` |
| 4 | POST | `/latest` → `/v1/skill/launch/latest` | — | IHQuery | 200 record \| `null` | `:25` |
| 5 | GET | `/count` → `/v1/skill/launch/count` | — | IHQuery from query string | 200 `{count}` | `:28,51-55` |
| 6 | POST | `/count` → `/v1/skill/launch/count` | — | IHQuery | 200 `{count}` | `:29` |
| 7 | POST | `/` → `/v1/speech` | — | `SpeechHistoryRecordData` | 200 `{id}` | `SpeechHistoryRequestsHandler.ts:19,23-28` |
| 8 | PUT | `/:id` → `/v1/speech/:id` | path `id` | `SpeechHistoryUpdate` | 200 `{id}` | `:20,30-34` |
| 9 | GET | `/healthcheck` | — | — | 200 `{status,skillLaunchDB,speechHistoryDB}` / 500 | `BaseService.ts:123-126`, overridden by `HistoryService.ts:60-76` |

Notes re-derived from source:

* Route 7/8 are registered **by default** — `ETCO_history_speechHistory_enabled` defaults to
  `'true'` (`HistoryServiceConfigProvider.ts:16`) and `HistoryService.ts:28-33` guards on it.
* `:id` path parameter is read with `req.params.id` (`SpeechHistoryRequestsHandler.ts:20`).
* GET routes exist even though the shipped client always uses POST
  (`SkillLaunchHistoryClient.ts:36-43`: *“According to REST here should be GET … but POST is used
  because in GET requests all values are converted to strings”*). GET/DELETE/HEAD still resolve
  through the same Express router.
* Request body parsing: `bodyParser.urlencoded({extended:true})` then `bodyParser.json()`
  (`BaseService.ts:121,128`), both **app-level**.
* Response/error framing: `res.status(200).json(result)`; unhandled errors →
  `res.status(err.statusCode || 500).json({type:'ERROR',msgID,ts,final,data:{message}})`
  (`BaseService.ts:319-322`); unknown URL → 404 `URL not found: ${req.path}`
  (`BaseService.ts:315-317`); message via `getErrorMessage` = `e.message`
  (`ref:packages/utils-common/src/Utils.ts:30-38`).

### Error/edge matrix (source-derived)

| Case | Reference status | Reference body | Phoenix status (runtime) |
|---|---|---|---|
| `latest`/`count` without `robotID` | 500 | `ERROR` envelope | 500 ✓ (`runtime-probe.json`) |
| Unknown path / unsupported method | 404 | `URL not found: <path>` | 404 ✓ |
| Empty or non-JSON body on any write route | **200** (body-parser gives `{}`) | normal handler result | 200 ✓ |
| Malformed JSON | 400 | envelope, Node-8 message | 400 ✓ (`extra-cases.json`) |
| `PUT /skill/launch/payload` without `payload` | 500 | envelope | 500 ✓ (`history.routes.test.js`) |
| `PUT /speech/:id` unknown id | 500 | envelope | 500 ✓ |
| Bad rule field (`Unknown field: bogus`) | 500 | envelope, exact message | 500, same message ✓ |
| Bad explicit `match` / conflicting `intent`+rule | 500 | envelope | 200 `null` when the store is empty — **I-02** (see §7) |

---

## 3. Runtime verification — every route is actually served

Started the real service (`createHistoryService(new HistoryStore()).listen(0)`) and sent real
requests: `runtime-probe.json` (28 requests, script `probe.mjs`).

**VERIFIED** — all 8 history routes answer at runtime (none 404), including the two GET routes
that P05 reported as 404. Response statuses: all eight 200 for valid input; `latest`/`count`
no-match → 200 `null` (never 404); unknown route / unsupported methods → 404 envelope.
The 404 and 500 envelopes carry exactly `{type, msgID, ts, final, data:{message}}`.

Additional HTTP-boundary facts confirmed at runtime (`runtime-probe.json`):
trailing slash `/v1/skill/launch/` matches (200); path matching is case-insensitive
(`/V1/SKILL/LAUNCH/COUNT` 200); `HEAD` on a GET route returns 200 with an empty body;
`DELETE`/`PATCH` on known paths return the 404 envelope (Express has no 405).

### Reference-runtime cross-check

`ref-http-oracle.mjs` rebuilds the **exact** BaseService middleware chain
(`urlencoded` → `/healthcheck` → `json` → `app.use(path, router)` → 404 → error handler) using the
pinned tree's **own** `express@4.16.2` + `body-parser@1.18.2`, and drives it over HTTP
(`reference-http-oracle.json`). Confirmed there: trailing slash 200, case-insensitive 200,
`HEAD` 200 empty, `DELETE` 404, unknown path 404 `URL not found: …`, and the bare `/skill/launch`
alias **404** (the reference registers only `/v1/...`).

---

## 4. Field-by-field payload comparison

Launch record: reference `SkillLaunchCollection.documentToJSON` (`SkillLaunchCollection.ts:90-101`)
= `JSON.parse(JSON.stringify(document))`, `id := _id`, then delete `_id`/`__v`/`type`. The schema
(`SkillLaunchSchema.ts:5-43`) declares exactly
`type, timestamp, sessionID, robotID, skillID, intent, personIDs, payload, payloadSize`.
Phoenix `RECORD_FIELDS` (`packages/history/src/store.js:29`) declares
`id, timestamp, sessionID, robotID, skillID, intent, personIDs, payload, payloadSize`.

| Field | Reference | Phoenix (runtime) | Observable? |
|---|---|---|---|
| `id` | Mongo ObjectId hex string (`_id`) | `randomUUID()` 36-char UUID | **Infrastructure-only extension.** Pinned client treats it as an opaque string (`SkillLaunchHistoryClient.ts:23`, `BaseHistoryServiceClient`). Recorded as a candidate (§7). |
| `timestamp` | ISO-8601 string (BSON `Date` → `JSON.stringify`) | numeric ms | **Recorded divergence I-01a.** `ref:packages/history/tests/speech/SpeechHistoryRequestsHandler.test.ts:59` pins the ISO wire form. |
| `sessionID/robotID/skillID/intent` | present iff set | same | match ✓ |
| `personIDs` | sorted in place before save (`Preformatter.ts:13-17`) | sorted in place (`store.js:47`) | match ✓ |
| `payload` | Mixed | passed through | match ✓ |
| `payloadSize` | only set by `saveSkillPayload` = `Object.keys(payload).length` (`SkillLaunchCollection.ts:41-59`) | only set by `saveSkillPayload` = key count (`store.js:59-70`) | match ✓ |
| unknown request fields | mongoose strict mode drops | dropped (`_toJSON` whitelist) | match ✓ |
| `type`/`_id`/`__v` | deleted server-side | never emitted | match ✓ |

* **POST /v1/skill/launch** → full record; `timestamp` defaults via `data.timestamp || Date.now()`
  (`SkillLaunchRequestsHandler.ts:34` ↔ `store.js:51`); no `payloadSize`. **VERIFIED**
  (`runtime-probe.json`, `history.http.test.js`).
* **PUT /v1/skill/launch/payload** → updated record with `payloadSize`; no-match → 200 body
  `null`, exactly `res.status(200).json(result)` with `result = null`
  (`SkillLaunchCollection.ts:58`). **VERIFIED**.
* **latest / count** → record \| `null`; `{count}`; no-match `null` never 404. **VERIFIED**.
* **GET variants** read `req.query` exactly like `addGetHandler` (`BaseHttpHandler.ts:48-54`);
  both trees run `express@4.16.2` + `qs@6.5.1` (verified in `node_modules`) so nested bracket
  rules and string leaf values parse identically. **VERIFIED** (version check + GET probes).
* **POST /v1/speech** → `{id}`. **PUT /v1/speech/:id** → `{id}`, whitelist of eight fields,
  `null`/`undefined` stripped and never erasing (`SpeechHistoryRecordsCollection.ts:29-50` ↔
  `store.js:95-105`) — **VERIFIED**, including the pinned test's null-strip scenario.
* `id` is stable across the payload update — **VERIFIED**.

### Unmodified client harness

`client-harness.mjs` loads the **compiled pinned** `@jibo/history-client`
(`ref:packages/history-client/lib/history-client.js`, its own axios fork) and drives the Phoenix
service with it (`client-harness.json`). Results: `writeSkillLaunch`→id; `writeSkillPayload` on
the same `{sessionID,robotID,skillID}` returns the **same** id (pinned
`SkillPayloadEvent.test.ts:60-73`); `getLatestSkillLaunch` by robotID/no-match/`notSessionID`;
`getSkillLaunchCount`; `createRecord`/`updateRecord` including the null-strip scenario
(`SpeechHistoryRequestsHandler.test.ts:105-153`); unknown speech id → 500; `SpeechHistoryRecord`
`save()` create path. All behave as the pinned tests require.

---

## 5. Candidate claims re-derived — where the source disagrees

The candidate is substantially correct. Two of its statements do **not** survive re-derivation:

1. **Candidate divergence #3 is FALSE.** It claims *“the reference body-parser leaves `req.body`
   undefined and the handler throws (500)”* for an empty/text-plain `PUT /speech/:id`.
   `body-parser@1.18.2` sets `req.body = req.body || {}` **before** the content-type/`hasBody`
   checks — `ref:node_modules/body-parser/lib/types/json.js:104` and `…/urlencoded.js:86` (the
   checks follow at json.js:107). Both parsers are app-level (`BaseService.ts:121,128`), so
   `req.body` is **always `{}`** on these routes. Re-ran the pinned stack to confirm: empty body,
   no content-type, and `text/plain` bodies all reach the handler as `{}` → 200 `{id}`
   (`reference-http-oracle.json`). **Phoenix's 200 matches the reference**; the reported
   divergence does not exist. A regression test now pins this (`history.routes.test.js`).
2. **Candidate's “findOneAndUpdate … most recent wins” is unsupported by source.**
   `SkillLaunchCollection.saveSkillPayload` (`:41-59`) has **no `sort`** (unlike `getLatest`,
   which sets `{timestamp:-1,_id:-1}` at `:70`). `findOneAndUpdate` without a sort returns the
   first document in natural order. Phoenix deliberately selects the **newest**
   (`store.js:61-63`). Exact reference behaviour needs a live Mongo — **UNKNOWN**, recorded
   below. The candidate's parenthetical “most recent wins” should not be read as verified.
3. Candidate route table is otherwise confirmed, including that the reference **404s** the bare
   aliases (verified in `reference-http-oracle.json`).

---

## 6. Gaps closed and tests added

Implementation gaps for the I-01 acceptance: **none remaining** — the four acceptance behaviours
(GET+POST variants, complete saved launch/payload records, no-match `null`, speech
create/update) are present and verified. The candidate's earlier work (P04/P05/P07) is intact.

Coverage gaps closed: new `packages/history/test/history.routes.test.js` (10 tests) adds what the
candidate's file did not cover —

* the full route table asserted non-404 and `application/json` for every registered route;
* 404 envelope for unknown path **and** unsupported methods (`DELETE`/`PATCH`/wrong-method `PUT`);
* Express routing rules: trailing slash, case-insensitive path, `HEAD` via `GET`;
* `timestamp` default to numeric ms when omitted;
* `GET latest` **and** `GET count` without `robotID` → 500 envelope;
* `PUT /skill/launch/payload` without `payload` → 500;
* launch `id` stable across the payload update;
* empty / non-JSON bodies reach the handler as `{}` (the falsified candidate claim, now pinned);
* `/healthcheck` current contract (pins the I-01b divergence so a silent change is caught);
* bare-alias extension guarded so it stays intentional.

---

## 7. Verification ledger, residuals and divergence candidates

### VERIFIED

* History transport is plain Express HTTP/JSON; the surface is **not** behind the gateway and
  requires **no** auth (handler `authenticationRequired: false`; gateway has no history route).
* All eight history routes + `/healthcheck` are served at runtime with the statuses and payload
  shapes in §2/§4; GET/POST `latest`+`count`; no-match 200 `null`; unknown route/method 404
  envelope; malformed JSON 400.
* Full saved launch record with sorted `personIDs` and no computed `payloadSize`; `payloadSize`
  only from `PUT /payload`; `PUT /payload` record-or-`null`.
* Speech create `{id}` and whitelist/null-strip/non-erasing update; unknown id → 500 envelope.
* `express@4.16.2`, `qs@6.5.1`, `body-parser@1.18.2` identical in both trees.
* Empty/non-JSON body → `{}` → 200 on both sides (candidate claim #3 falsified).
* Rule field error `Unknown field: bogus` → 500 with the same message in both.

### INFERRED

* `id` value format (UUID vs ObjectId) is invisible to the pinned client, which stores and returns
  it as an opaque string.
* `findOneAndUpdate` without `sort` picks the first natural-order match (oldest) in the reference;
  Phoenix picks newest. Reasoned from `SkillLaunchCollection.ts:41-59` — not executable here.
* Rule defaulting: a rule without `match` takes the first `ALLOWED_METHODS` entry
  (`validators/rule.ts:127-133`) — ported at `query.js:23-67`.

### UNKNOWN

* Exact reference record selected by `PUT /skill/launch/payload` when two launches share
  `{sessionID, robotID, skillID}` — needs a live-Mongo oracle (I-02/I-03).
* Reference `_id` tie-break when two records share a timestamp but were inserted in a different
  wall-clock order than insertion order (cosmetic; Phoenix uses insertion-desc).
* Exact Joi failure wording / status for the I-02 validation matrix (not part of I-01 acceptance).

### Residuals owned by other tasks (NOT closed here)

* **P06 input-validation** — a launch missing `sessionID`/`robotID`/`skillID` is accepted (200)
  where the reference's `validators/event.ts:5-32` Joi schema rejects it (500), and
  `latest`/`count` without `robotID` return `Robot ID is required` where the reference's Joi layer
  fires first with a `child "robotID" fails because …` message (`validators/query.ts:9-18` +
  `common/validation/index.ts:16-20` + `Utils.ts:30-38`). This is **I-02's** explicit acceptance
  (“Port the original event/query/rule validation matrix … and failure payloads”). I-01's
  acceptance covers routes/payloads, so it is out of scope here — but flagged so the finding's
  “input-validation” phrase is not mistaken for closed.
* Also I-02: explicit invalid `match` (`Match method … cannot be used`) and conflicting
  `intent`/`personID`/`skillID` vs a rule (`You specified … both in exact match and rules`) are
  500 in the reference but 200 `null` in Phoenix when the store is empty — Phoenix validates
  lazily inside the predicate, so an empty store never triggers the throw.
* I-02: urlencoded `timestamp` stays the string `'1'` in Phoenix, while the reference's mongoose
  schema casts it to a `Date` before serialization.
* I-03: process-local store, retention/pruning, crash recovery.

### Divergence candidates for root (not written to DIVERGENCES.md)

1. **History route aliases without `/v1`** (`/skill/launch/…`, `/speech`, `/speech/:id`) — served
   by Phoenix, **404** in the reference (`reference-http-oracle.json`). Not found in
   DIVERGENCES.md; the candidate calls it “documented” but the register does not carry it. Impact:
   additive only; no reference request changes behaviour.
2. **`PUT /skill/launch/payload` record selection** — Phoenix newest vs reference
   natural-order-first (no `sort` in source). Needs a Mongo oracle; recommend I-02/I-03.
3. **Launch/speech `id` format** — UUID vs ObjectId hex. Client-opaque.
4. Confirm I-01a (numeric ms `timestamp`) remains the accepted tradeoff — re-confirmed here on the
   launch, latest and payload-update responses.
5. **I-01b `/healthcheck`** stays as recorded (reported, not changed): reference
   `HistoryService.ts:60-76` returns `{status, skillLaunchDB, speechHistoryDB}` with 200/500;
   Phoenix serves base `ok` text/html. Changing it needs a `packages/common/src/service.js`
   override hook (C-01-owned) and would invalidate the register entry, so it was left alone and
   pinned by a test instead.

---

## 8. Falsification (required)

Highest-risk assertion: **the GET query routes are actually served at runtime** — the exact
defect class P05 reported (static greps said served; runtime returned 404).

* **Broke:** `packages/history/src/index.js`, full code line
  `    'GET /skill/launch/count': ({ req }) => ({ count: store.getCount(req.query) }),`
  → `    'GET /skill/launch/counted': ({ req }) => ({ count: store.getCount(req.query) }),`
  (whole-line anchor, renaming the route key — no comment/substring anchor).
* **Result:** `node --test packages/history/test/history.http.test.js packages/history/test/history.routes.test.js`
  → **25 tests, 20 pass, 5 fail**, including
  `not ok 16 - every reference history route is served as application/json (never 404)` with
  diagnostic `GET /v1/skill/launch/count must be routed`, plus
  `not ok 8 - POST and GET /v1/skill/launch/count return { count }`,
  `not ok 18 - Express routing rules …`, `not ok 20 - GET latest and count without robotID …`,
  `not ok 25 - bare (non-/v1) aliases …`.
* **Restored:** byte-identical (`diff /tmp/index.js.orig packages/history/src/index.js` → clean).
* **Re-run:** **25 tests, 25 pass, 0 fail, 0 cancelled, 0 skipped.**

A second executable check was performed while re-deriving the candidate: the reference HTTP
oracle distinguishes the reference's `{}` body default from the claimed `undefined`, so the
candidate's divergence #3 is falsified against the pinned stack rather than accepted.

---

## 9. Final `npm test` and parity gate

Run on `w2/i01` after the falsification restore, with no other agent's `npm test` running
(checked with `ps`; earlier a peer worktree `w2-d01` was mid-run and was waited out to avoid the
known bogus-`cancelled` artefact).

`npm test` (= `test:unit` → `parity:check` → `parity:gate`):

```
1..1087
# tests 1149
# suites 7
# pass 1142
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 58790.386046
```

```
Checklist: 16/79 verified (20.3%)
management: 3/3 verified; 0 in progress; 0 blocked
verification: 4/4 verified; 0 in progress; 0 blocked
pegasus: 3/46 verified; 0 in progress; 0 blocked
classic: 6/20 verified; 0 in progress; 0 blocked
restoration: 0/1 verified; 0 in progress; 0 blocked
release: 0/5 verified; 0 in progress; 0 blocked
Tracker structure, dependencies, evidence links and generated checklist are valid.
```

Parity gate JSON (strict production smoke, 43 cases):

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

The 7 skips are the known NLU compiled-artifact/profile class gated on per-worktree
`node_modules` contents; no history test is skipped.

## 10. Files

* `packages/history/test/history.routes.test.js` — new: route table + HTTP error cases (10 tests).
* `docs/parity/evidence/2026-09-10/i01-history-routes/` — `review.md` (this file),
  `probe.mjs` / `runtime-probe.json`, `ref-http-oracle.mjs` / `reference-http-oracle.json`,
  `client-harness.mjs` / `client-harness.json`, `extra-cases.mjs` / `extra-cases.json`.

No production code change was required for the I-01 acceptance; `packages/history/src/*` is
unchanged from the candidate (restored byte-identical after the falsification).
