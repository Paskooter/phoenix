# I-01 — Match all history HTTP routes and payloads (w7 certification pass)

Review date: 2026-09-10 · Worktree `.parity/worktrees/w7-i01` (branch `w7/i01`, base `e525894`) ·
Task I-01 (P0, pegasus, implementation `partial`).
Pinned source: Pegasus `5c0a7390539663ba749d360de348a428c088505c` — read from the archive MCP at
`https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/…`
and from the local pinned checkout `.parity/reference/5c0a739…` (byte-identical).

Every claim is labelled **VERIFIED** (observed at runtime), **INFERRED** (reasoned from pinned
source), or **UNKNOWN**. This pass re-derives everything from pinned source and does not rely on
the earlier `w2-i01` report (`review.md` in this directory), which it also re-checks.

---

## 1. Route inventory, re-derived

`SkillLaunchRequestsHandler` registers five sub-routes on the router mounted at `/v1/skill/launch`
(`packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts:20-29`); `SpeechHistoryRequestsHandler`
registers two on `/v1/speech` (`…/speech/SpeechHistoryRequestsHandler.ts:19-20`);
`BaseService` adds `GET /healthcheck` (`packages/utils/src/service/BaseService.ts:123`).
`BaseHttpHandler` makes every successful route `res.status(200).json(result)`
(`packages/utils/src/service/handlers/BaseHttpHandler.ts:48-80`).

| # | Method | Wire path | Request carrier | Success body | Source |
|---|---|---|---|---|---|
| 1 | POST | `/v1/skill/launch` | JSON/urlencoded body | full saved record | `SkillLaunchRequestsHandler.ts:20,32-37` |
| 2 | PUT | `/v1/skill/launch/payload` | body | updated record \| `null` | `:21,39-44` |
| 3 | GET | `/v1/skill/launch/latest` | `req.query` | record \| `null` | `:24,46-49` |
| 4 | POST | `/v1/skill/launch/latest` | body | record \| `null` | `:25` |
| 5 | GET | `/v1/skill/launch/count` | `req.query` | `{count}` | `:28,51-55` |
| 6 | POST | `/v1/skill/launch/count` | body | `{count}` | `:29` |
| 7 | POST | `/v1/speech` | body | `{id}` | `SpeechHistoryRequestsHandler.ts:19,23-28` |
| 8 | PUT | `/v1/speech/:id` | body + `req.params.id` | `{id}` | `:20,30-34` |
| 9 | GET | `/healthcheck` | — | `HistoryService` override | `HistoryService.ts:60-76` |

Transport: plain Express HTTP/JSON, **not** AWS-JSON, so the generated-SDK "undeclared response
fields are stripped" rule does **not** apply here. Error framing:
`{type:'ERROR', msgID, ts, final:true, data:{message}}` with `err.statusCode||500`
(`BaseService.ts:319-322`); unknown path → 404 `URL not found: ${req.path}` (`BaseService.ts:315-317`).

The unmodified client wires every call to `${historyServiceURL}/v1${relativePath}`
(`history-client/lib/base/BaseHistoryServiceClient.js:26-28`), so the bare aliases Phoenix also
serves are never exercised by a real consumer (recorded divergence **I-01c**).

## 2. Method — a real reference HTTP oracle, not a reconstruction

`w7-ref-routes-oracle.mjs` boots the **compiled pinned classes** and drives them over real HTTP:

* `utils.service.BaseService` — real Express app, real body parsers, real 404/error envelope;
* the real `SkillLaunchRequestsHandler` / `SpeechHistoryRequestsHandler` routers;
* the real `SkillLaunchCollection` / `SpeechHistoryRecordsCollection` methods
  (`documentToJSON`, `saveSkillPayload`, `getLatest`, `getCount`, `updateRecord`).

Only the mongo **Model** is stubbed (`w7-ref-routes-oracle.json` records
`findOneAndUpdate: 2` for five payload-update cases). This is strictly stronger than the earlier
`ref-http-oracle.mjs`, which re-created the handler bodies by hand. `w7-runtime-probe.mjs` runs the
identical 34-case matrix against the **live Phoenix process** and repeats it after a real restart;
`w7-diff.mjs` compares all three artefacts case by case. Stated limitations:
record *selection/sorting* and BSON casting need a live mongod (none exists here) and stay INFERRED.

## 3. Gap found and closed — eager `payloadSize` evaluation

`SkillLaunchCollection.saveSkillPayload` builds the `$set` document **eagerly** as the second
argument to `findOneAndUpdate` (`SkillLaunchCollection.ts:42-57`):

```ts
{ $set: { payload: data.payload, payloadSize: Object.keys(data.payload).length } },
```

so `Object.keys(data.payload)` throws **before the query is issued and before any match is
evaluated**. Phoenix looked the record up first and returned `200 null` when nothing matched — a
status-code difference on a real route.

**VERIFIED** with the real compiled collection (`w7-ref-routes-oracle.json`):

| Case | reference | Phoenix before | Phoenix after |
|---|---|---|---|
| `PUT /v1/skill/launch/payload`, no `payload` key, **no match** | 500 `Cannot convert undefined or null to object` | 200 `null` | 500 ✓ |
| `PUT /v1/skill/launch/payload`, `payload: null`, **no match** | 500 `Cannot convert undefined or null to object` | 200 `null` | 500 ✓ |
| `PUT /v1/skill/launch/payload`, no `payload` key, match | 500 | 500 | 500 ✓ |

`findOneAndUpdate` was invoked **2** times across the five payload cases — the three malformed ones
never reached the model, proving the throw precedes the lookup.

Fix (`packages/history/src/store.js`, owned file): hoist the key-count computation above the
lookup. The success path is unchanged (`payload` + `payloadSize`, stable `id`).

## 4. Runtime verification — every route served, twice, across a real restart

`node packages/history/src/index.js` was started as a real child process on port 19306, 34 requests
were sent, the process was `SIGKILL`ed, restarted, and the same 34 requests were sent again
(`w7-runtime-probe.json`).

* Both passes: **34 cases, identical label set, identical statuses, identical content-types**.
  The only body differences between passes are the two `timestamp` fields the handler defaults to
  `Date.now()` (expected — the store is process-local, I-03).
* `History service is successfully started on port 19306` appears in both process logs.
* All eight history routes answer 200 on valid input; `latest`/`count` no-match is 200 `null`,
  never 404; unknown path and unsupported methods give the 404 envelope; malformed JSON is 400.

## 5. Case-by-case diff against the reference (34 cases)

`w7-diff.json`: **28/34 cases match exactly** on status *and* body (after normalising the
generated `msgID`/`ts`/`id`). Remaining differences — none of them in I-01's acceptance:

| # | Case | reference | Phoenix | Owner |
|---|---|---|---|---|
| 1 | `POST /v1/skill/launch` with empty / `text/plain` body | 500 Joi envelope | 200 record | **I-02** (event validation matrix) |
| 2 | `GET /v1/skill/launch/latest` / `POST …/count` with no `robotID` | 500 `child "robotID" fails because ["robotID" is required]` | 500 `Robot ID is required` | **I-02** (failure payload wording; status already matches) |
| 3 | bare `/skill/launch/count`, `/speech/:id` aliases | 404 | 200 / 500 | **I-01c** (recorded additive divergence) |
| 4 | `/healthcheck` on the `HistoryService` subclass | `{status, skillLaunchDB, speechHistoryDB}` 200/500 | base `ok` | **I-01b** (recorded; needs a `createService` hook, C-01-owned) |

Everything in the acceptance matches: GET **and** POST `latest`/`count`, complete saved launch
record (sorted `personIDs`, no computed `payloadSize`), `payloadSize` only from `PUT /payload`,
no-match `null`, speech create/update with the eight-field whitelist and null-strip, stable `id`
across the payload update, `URL not found:` 404 envelope, trailing slash, case-insensitive paths,
HEAD-via-GET.

## 6. New observation for I-03 (retention)

Phoenix prunes only when **the first array element** is expired
(`store.js:_pruneExpired`, `this.skillLaunches[0].timestamp < cutoff`), and the array is in
insertion order, not timestamp order. Runtime (`w7-runtime-probe.json`, cases
`RETENTION: …`): a launch written with a timestamp 40 days old survives, and
`GET /v1/skill/launch/count?robotID=R-old` returns `{count: 1}` immediately after. The reference
delegates retention to Mongo's TTL index (`SkillLaunchSchema.ts:10-14`, `expires: 14*86400`), whose
sweeper removes such a document within ~60 s. **UNKNOWN** for the exact real-Mongo timing (no
mongod available); **VERIFIED** for the Phoenix side. Retention/pruning is explicitly I-03's
acceptance, so it is reported, not changed.

## 7. Falsification (required)

Anchor: the full code line introduced by the fix,
`packages/history/src/store.js:68`

```js
    const payloadSize = Object.keys(data.payload).length;
```

Broken to

```js
    const payloadSize = Object.keys(data.payload || {}).length;
```

`node --test packages/history/test/*.test.js` → **39 tests, 36 pass, 3 fail**:

* `not ok 21 - PUT /v1/skill/launch/payload without a payload is a 500 (reference requires payload)`
* `not ok 22 - PUT /v1/skill/launch/payload without payload is 500 even when nothing would match`
* `not ok 23 - PUT /v1/skill/launch/payload with payload null is 500 (reference Object.keys(null))`

Restored from a byte-identical copy → sha256 `ed7df237092b5597e7f5e6d117a145edbe93d3d66a115ac0b05841c8cc5065fc`
(both before and after), re-run → **39 tests, 39 pass, 0 fail**.

## 8. Files

* `packages/history/src/store.js` — `saveSkillPayload` hoists the eager key-count computation.
* `packages/history/test/history.routes.test.js` — +3 tests (13 total in that file).
* `docs/parity/evidence/2026-09-10/i01-history-routes/w7-ref-routes-oracle.{mjs,json}` — real
  compiled-class reference oracle.
* `…/w7-runtime-probe.{mjs,json}` / `w7-runtime-probe-BEFORE.json` — live process runs, before the
  fix and after a restart.
* `…/w7-diff.{mjs,json}` — case-by-case comparison and the gap-closure table.
