# A-12 — independent verification: log ingestion & binary-upload behavior

Date: 2026-09-10 · Verifier: independent worker (not the implementer) · Worktree: `.parity/worktrees/verify-a12`
Revision under test: `ed6b6fe` (main at the time of verification) · Branch: `verify/a12`
Implementation: `packages/classic/src/log.js` (`sha256 cd7dc87ef75dc0c489fdfbcf8ddcfc31ac8ffc833116cc979fc6d59dab6d2bcb` before and after falsification)

**Verdict: do NOT mark verified yet.** Criterion 2 is fully demonstrated and criterion 3 is mostly
demonstrated, but criterion 1 has three client-reachable mismatches against the pinned source, and the
criterion-2 "retrievable durable sink" clause fails across a process restart. Details below. All findings
are re-derived from the pinned artifacts and from a runtime probe; the candidate report's claims were not
taken on trust, and two of them are contradicted by the source (see "Where the candidate report is wrong").

## Pinned artifacts used (independently fetched)

| Artifact | How obtained | sha256 |
|---|---|---|
| `jiborobot/srv-jibo-server-client:apis/log-2015-03-09.normal.json` | `gitea_read_file` over the Jibo MCP (`https://pvindex.org/mcp`) | `e57b564831b0acdb7f112dfb2c8bfa7188b66a342f0619966da59344d8d0dcab` |
| `jiborobot/srv-jibo-server-client:apis/logadmin-2015-03-09.normal.json` | same | `f173238dc466541923fae39197f8a13033bb72e23a346d724cf7fb80f5719fca` |
| `jiborobot/srv-log-ws` handlers/controllers/errors/index | local archive clone, HEAD `d72f82d` | — |
| `@jibo/server` plumbing (`validate.ts`, `parseCredentials.ts`, `boom.ts`, `errors.ts`, `server.ts`) | local `srv-server-archive` clone, HEAD `0a39764` | — |
| **The original client** `@jibo/jibo-server-client` **3.0.105** (lib + the pinned `.normal.json` models) | `/home/shell/work/phoenix-jibo-server-client` | run live against Phoenix — see below |

Checksum proof the MCP copies are what was analysed: both pinned files fetched over the MCP compare
byte-identical to the local archive clones (`log-2015-03-09.normal.json` 6728 B, `logadmin-…` 1524 B).
Copies are committed under `pinned/` in this evidence directory.

**Note on the client:** the pinned SDK repo is 3.0.105, whose `apis/*.normal.json` are the models under
test; the SDK's generated `clients/all` entry point is absent from that checkout, so the probe loads
`lib/node_loader.js` + `lib/core.js` and constructs `new AWS.Service({ apiConfig: <pinned model> })`
directly. That is the pinned client code with the pinned models — not a reimplementation. (The
`@jibo/jibo-server-client` installed in `/home/shell/hermes-jibo-be` is an older 3.0.79 whose `log` model
predates `PutAsrBinary`; it was **not** used.)

## Method

`probe.mjs` in this directory does four independent things and writes `probe-output.json`:

1. **Wire capture** — the original client is pointed at a local echo server to record the exact request it
   emits per operation.
2. **Source-envelope emulation** — the original client is pointed at a mock that returns the *source's*
   Boom/Hapi error payloads, to observe the `err.code` the source produced. (Boom's payload `error` field is
   `Http.STATUS_CODES[status]`; confirmed against `boom@2.10.1` `lib/index.js:70`, and the archive pins
   `boom ^5.1.0` with the same contract. The pinned client's `lib/protocol/json.js:extractError` reads
   `x-amzn-errortype || body.__type || body.code || body.error`.)
3. **Model screening** — which malformed inputs the original client rejects *before* the wire (its
   `param_validator` enforces the model's required/min/enum constraints).
4. **Live probe** — all seven declared operations driven against a running Phoenix classic entrypoint by
   both the original client and raw HTTP, plus upload→PUT→GET round trips, retry behavior, the throttle
   gate, the ASR sampling gate and validation/error matrices.

Reproduce: from the worktree root, `node docs/parity/evidence/2026-09-10/a12-log-ingestion/probe.mjs`.

---

## Criterion 1 — six normal + one admin operation, validation/errors, sync vs async ack

### Operation inventory (read from both pinned models)

`log` (`endpointPrefix: log`) and `logadmin` (`endpointPrefix: logadmin`) share `targetPrefix: Log_20150309`
— the same two-file/one-prefix pattern as Account/AccountAdmin. Seven operations in total:

| # | Model | Operation | wireName | input | output shape (required) |
|---|---|---|---|---|---|
| 1 | log | `PutEvents` | `Log_20150309.PutEvents` | `PutEventsRequest` | `Response` — string (min 1, max 32768) |
| 2 | log | `PutEventsAsync` | `Log_20150309.PutEventsAsync` | `PutEventsAsyncRequest` | `PutEventsAsyncResponse` (`contentEncoding`, `uploadUrl`) |
| 3 | log | `NewKinesisCredentials` | `Log_20150309.NewKinesisCredentials` | `NewKinesisCredentialsRequest` (empty) | `NewKinesisCredentialsResponse` (`credentials`, `region`, `streamName`) |
| 4 | log | `PutBinary` | `Log_20150309.PutBinary` | `PutBinaryRequest` (`payload: body`, `trackingId` header `x-tracking-id`) | `PutBinaryResponse` (`url`) |
| 5 | log | `PutBinaryAsync` | `Log_20150309.PutBinaryAsync` | `PutBinaryAsyncRequest` | `PutBinaryAsyncResponse` (`url`, `uploadUrl`) |
| 6 | log | `PutAsrBinary` | `Log_20150309.PutAsrBinary` | `PutAsrBinaryRequest` (`trackingId`) | `PutAsrBinaryResponse` (`bucketName`, `key`, `uploadUrl`) |
| 7 | logadmin | `SetLevel` | `Log_20150309.SetLevel` | `SetLevelRequest` (`friendlyIds`, `namespaces`) | `CommandResponse` (`result`) |

### Runtime probe: all seven are actually served

`servedNotUnknown = 7 / 7` (`probe-output.json` → `servedOperations`, `summary`). Every wireName above was
POSTed to a live entrypoint and answered `200` with a body (none 404, none
`no classic service for target`). This is a runtime observation, not static dispatch detection.

The **original client** drives them too: `PutEvents`, `PutEventsAsync`, `NewKinesisCredentials`,
`PutBinary`, `PutBinaryAsync`, `PutAsrBinary` and `SetLevel` all round-trip through the SDK's own
serializer/deserializer with no protocol error (`liveProbe`).

Wire capture confirms the SDK's content-type behaviour: six ops are sent as `application/json`; `PutBinary`
is sent with **no content-type** (`payload` blob branch in `lib/protocol/json.js:populateBody`). Phoenix
therefore receives a raw stream for `PutBinary` and does not attempt JSON parsing — correct.

### Sync vs async acknowledgment split — matches the source exactly

* **Synchronous ack** (result returned in the POST reply): `PutEvents` → `{"result":"Successfully added events"}`
  (`log.ctrl.ts:81`); `NewKinesisCredentials` → credentials/region/streamName; `PutBinary` → `{path,url}`
  (`log.ctrl.ts:114`); `SetLevel` → `{"result":"Command accepted"}` (`COMMAND_RESULT`, `log.ctrl.ts:11`).
  All four observed with those bodies.
* **Asynchronous ack** (an upload grant; the producer then PUTs separately): `PutEventsAsync` →
  `{contentEncoding:"gzip", uploadUrl}` (`log.ctrl.ts:99`); `PutBinaryAsync` → `{path,url,uploadUrl}`
  (`log.ctrl.ts:133`); `PutAsrBinary` → `{bucketName,key,metadata,uploadUrl}` (`log.ctrl.ts:153`).
  All three observed with exactly those key sets.

The key layouts match the source too, including the source's own quirk of a **0-based month**
(`date.getMonth()`): `asr-binary/year=2026/month=8/day=10/…` for September 10 — faithful.

### Validation — three client-reachable mismatches (source wins)

The source validates with Joi (`handlers/log.handler.ts` `@validatePayload`) under
`{ allowUnknown: true }` (`srv-server-archive/src/validate.ts:23`), so unknown members are allowed (Phoenix
matches). Failures are `Boom.badData` → **422**. That status is correct in Phoenix for every case probed.
But the *rules* are not identical:

| Case | Source (Joi) | Phoenix | Client-reachable? |
|---|---|---|---|
| `SetLevel.namespaces = [{}]` | valid → 200 | **422** | yes (`VerbosityLevel` has no required members) |
| `SetLevel.namespaces = [{namespace:"x"}]` (no level) | valid → 200 | **422** | yes |
| `SetLevel.namespaces = [{level:"info"}]` (no namespace) | valid → 200 | **422** | yes |
| `SetLevel.friendlyIds = [""]` | `Joi.string()` rejects `""` → 422 | **200** | yes (`FriendlyId` is `{"type":"string"}`, no min) |
| `PutEvents.deviceId = ""` | `Joi.string()` rejects → 422 | 200 | no — SDK screens it (`MinRangeError`) |
| `PutEventsAsync.serial = ""` | rejects → 422 | 200 | no — SDK screens it |
| `PutAsrBinary.trackingId = ""` | rejects → 422 | 200 | no — SDK screens it |
| `PutEventsAsync.kind = "k"` | rejects → 422 | 422 ✓ | yes (enum is not client-screened) |
| `PutEvents.events = []` | `Joi.array().required()` allows → 200 | 200 ✓ | no — SDK screens it (`MinRangeError`) |

So the empty-string over-permissiveness in `PutEvents`/`PutEventsAsync`/`PutAsrBinary` is **not reachable
through the original client** (the model's `min:1` is enforced client-side) and should not be reported as a
client-visible defect on its own. The `SetLevel` mismatches *are* reachable, but only from admin tooling.

### Error envelopes — status codes match, the client-visible error CODE does not

Statuses observed in Phoenix: validation **422**, `REQUEST_THROTTLED` **429**, `ROBOT_ONLY` **403**,
`AUTHORIZED_UNDER_ADMIN` **401**, unknown op **404** — all matching the source's
`Boom.badData`/`createWithCode`/`Boom.notFound`. The **code** differs where the source had no `code`:

| Case | Original client sees on the SOURCE (emulated from the source's actual Boom payloads) | Original client sees on PHOENIX | Match |
|---|---|---|---|
| 422 validation | `code = "Unprocessable Entity"` | `code = "ValidationException"` | ✗ |
| 404 unknown op | `code = "Not Found"` | `code = "NotFoundException"` | ✗ |
| 429 throttle | `REQUEST_THROTTLED` | `REQUEST_THROTTLED` | ✓ |
| 403 robot-only | `ROBOT_ONLY` | `ROBOT_ONLY` | ✓ |
| 401 admin | `AUTHORIZED_UNDER_ADMIN` | `AUTHORIZED_UNDER_ADMIN` | ✓ |

The source's Boom payload is `{statusCode, error, message}` (+`code` for codified errors); the pinned client's
`extractError` falls back to `body.error`, i.e. the HTTP reason phrase. Both rows are reachable and
client-visible (`err.code`), though the robot's use of `err.code` on a 422/404 cannot be observed without
firmware.

Two secondary, wording/leniency notes (not client-visible from the real client): the 404 message uses the
raw op name in Phoenix (`Method PutFaceBinary not found.`) where the source printed the lower-first name
(`Method putFaceBinary not found.`); and Phoenix dispatches case-insensitively
(`op.toLowerCase()`) where the source's `lowerMethodName` lower-cases only the first character, so
`Log_20150309.putevents` returns 200 in Phoenix and 404 in the source. The SDK always sends the exact model
name, so this is unreachable in practice.

**Criterion 1 verdict: NOT fully met** — the seven operations, the sync/async split and the status codes are
right; the `SetLevel` validation (over-strict) and the 422/404 error codes (wrong) are genuine, source-wins
mismatches.

---

## Criterion 2 — usable binary/ASR upload destinations and a retrievable durable sink

All four upload destinations are **usable and round-trip byte-identical**:

| Grant | PUT | GET | bytesMatch |
|---|---|---|---|
| `PutEventsAsync.uploadUrl` (`log-async/…gz`) | 200, ETag | 200 | true |
| `PutBinaryAsync.uploadUrl` (`log-binary/…`) | 200, ETag | 200 | true (5/5 B) |
| `PutAsrBinary.uploadUrl` (`asr-binary/…bin`) | 200, ETag | 200 | true (5/5 B) |
| `PutBinary` (sync, written at request time) → `url` | — | 200 | true |

`uploadRoundTripsOk = 3/3` (the three async grants) plus the sync blob; the probe wrote each object with
`fetch(uploadUrl,{method:'PUT'})` and read it back with the returned `url`/`GET /log/blob` — no test-only
shortcut. `logHttpRoutes` opts out of JSON body parsing (`putBlob.rawBody = true`), so arbitrary bytes and
any content-type work.

**But the "durable sink" clause is only partly met.** The store indexes objects in an in-memory `Map`
(`LogStore.index`). After restarting the entrypoint against the same `ETCO_classic_logDir`, the earlier
object's file is still on disk yet `GET /log/blob?key=…` returns **404 `no such log object`**:

```
before restart GET 200 DURABLE
after restart  GET 404 no such log object
file on disk: true
```

The source's objects were S3 objects reachable through a 24-hour presigned GET; Phoenix's `url` is only
retrievable for the life of the server process that accepted the PUT. Given Moth restarts the service,
this is a real (if bounded) divergence.

Value-shape differences already flagged by the candidate are confirmed and are genuinely client-visible in
the declared `path`/`bucketName`/`url` members: `bucketName` is the virtual `"log"` instead of the real S3
bucket, `path` carries a leading slash for `PutBinary` where the source did not, and the URLs are local
sink URLs rather than `https://<s3-host>/…`.

**Criterion 2 verdict: partially met** — upload destinations usable (demonstrated); retrievability is
process-lifetime only, so not a fully "retrievable durable sink".

---

## Criterion 3 — producer retries, trace metadata, retention (original client)

The **robot firmware is not available**, so real producer retry *timing/backoff* cannot be observed and is
recorded as unknown. What can be checked, was:

* **Trace metadata — verified with the original client.** A single `putEvents` call through the pinned SDK
  produced this JSONL sink line (verbatim, `probe-output.json.eventSink`):

  ```json
  {"ts":1789062205086,"level":"info","message":"via-sdk","created":1789062205078,
   "deviceId":"dev","robotId":"fid","trackingId":"trk","accountId":"acct"}
  ```

  `deviceId`/`trackingId` come from the request, `robotId`/`accountId` from the `x-amz-credentials`
  header, and `level` was derived exactly as `log.ctrl.ts:73-75` (`message.includes("error") ? "error" : "info"`).
  Matches the source's stamping order and its level rule.
* **Retried uploads — verified.** A second PUT to the *same* `uploadUrl` answers **200** and the sink keeps
  the latest bytes (last-write-wins, like S3); re-handshaking returns a **fresh uuid key** so a retried
  handshake cannot collide with the previous object.
* **Retention — verified.** Nothing in either source or Phoenix evicts; a blob written at the start was
  still readable after a later workload, and `events.jsonl` only accumulates. S3 lifecycle retention was
  bucket-level and is not in any pinned repo (unknown by construction).
* **Throttle gate — verified.** At `ETCO_log_probability=0` (source default 1, `index.ts`):
  `PutEventsAsync`, `PutBinaryAsync` and `PutBinary` → 429 `REQUEST_THROTTLED` with the source's exact
  message; `NewKinesisCredentials` is *not* throttled — matching the source, whose Kinesis controller has no
  probability gate.
* **ASR sampling gate — verified independently.** Reimplementing the Java `hashCode % 10000 <= p*10000`
  rule predicted pass/fail for five tracking IDs at `p=0.5`; Phoenix's observed statuses matched all five
  (`alpha` 9918 → 429, `beta` 272 → 200, `asr-t1..3` ~1978-1980 → 200).

**Criterion 3 verdict: partially met** — retry *tolerance*, trace metadata and retention are verified with
the original client; producer retry *timing/backoff* and the robot's reaction to each error code are
unobservable without firmware.

---

## Falsification (required)

Two single-line corruptions of `packages/classic/src/log.js`, each confirmed to change the code line by
grep (anchored on the full line, not a substring that also appears in the quoting comments), then run
against `packages/classic/test/logClassic.test.js` (15 tests). Full record: `falsification.json`.

* **F1 — PutEvents ack string.** Changed `'Successfully added events'` → `'Successfully added events!!'`
  (line 165). Result: **14 pass / 1 fail**, `not ok 1 - PutEvents: synchronous ack, level derivation, trace
  stamping, durable events file`. Restored → 15/15.
* **F2 — the async upload destination.** Changed the route key `'PUT /log/upload'` → `'PUT /log/uploads'`
  (line 306) so every advertised `uploadUrl` stops resolving. Result: **11 pass / 4 fail** —
  `not ok 4` (PutEventsAsync), `not ok 7` (PutBinaryAsync), `not ok 9` (PutAsrBinary), `not ok 15`
  (retention). The independent probe rerun on the broken tree dropped `uploadRoundTripsOk` from **3 → 0**
  with `handler threw: URL not found: /log/upload`. Restored → 15/15 and the probe back to 3/3.

After restore `sha256(packages/classic/src/log.js)` equals the pre-falsification
`cd7dc87ef75dc0c489fdfbcf8ddcfc31ac8ffc833116cc979fc6d59dab6d2bcb`, so no corruption survived. Both
assertions are load-bearing: the tests fail when the behaviour is broken.

## Full suite

`npm test` from the worktree root, log saved as `npm-test.log`:

```
# tests 1139   # suites 7   # pass 1132   # fail 0   # cancelled 0   # skipped 7   # todo 0
NPM_TEST_EXIT=0
Checklist: 15/79 verified (19.0%)   Tracker structure, dependencies, evidence links … are valid.
parity:gate -> {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

The count differs from the candidate report's 1022 because main has advanced since (A-13/C-02 etc. merged);
what matters is 0 failures and a clean parity gate on this tree.

## Where the candidate report is wrong (source wins)

1. *"Phoenix keeps its `__type` + `x-amzn-errortype` envelope (strictly more informative … same statuses)."*
   The statuses match, but the client-visible **code** does not: 422 → `ValidationException` vs the source's
   `Unprocessable Entity`; 404 → `NotFoundException` vs `Not Found`. Demonstrated by running the pinned
   client against both envelope shapes.
2. *"validates … exactly as the source's Joi rules."* Not exact: `SetLevel` namespaces are over-strict
   (Joi's inner `namespace`/`level` are both optional, so `[{}]`, `[{namespace}]`, `[{level}]` are valid
   upstream and 422 in Phoenix), and `SetLevel.friendlyIds` accepts `""` where `Joi.string()` rejects it.
3. *"a durable local LogStore … making the object retrievable."* Durable on disk, but **not retrievable
   after a process restart** (in-memory index) — see criterion 2.
4. Confirmed-correct candidate claims: op inventory (7), sync/async split, level rule, ASR hash, key
   layouts, no server-side retention, throttle/gate behaviour, upload round trips, fresh-key-per-handshake
   and same-URL retry.

## Verified / inferred / unknown

**Verified (observed, not inferred):** the 7 declared operations and their wireNames; all 7 served 200 at
runtime; the sync/async ack bodies and key sets; 422/429/403/401/404 status codes; the 429/403/401 error
codes; `SetLevel`/`PutEvents*`/`PutAsrBinary` validation behaviour (matrix above); `PutEvents` wire shape and
raw-stream `PutBinary`; upload→PUT→GET byte-identical round trips for all four kinds; same-URL retry
(last-write-wins) and fresh key per handshake; trace stamping and level derivation through the original
client; the ASR sampling rule (5/5 independent predictions); no server-side eviction; falsification of two
assertions; full-suite counts and the parity gate.

**Inferred:** the source's *client-visible* 422/404 codes are derived from Boom's payload contract
(`output.payload.error = http.STATUS_CODES[status]`, confirmed on `boom@2.10.1`; the archive pins
`boom ^5.1.0`, the same contract) plus the pinned client's `extractError` fallback chain — the original
server itself is not runnable, so this is a contract-level inference, not a live observation.

**Unknown:** producer retry timing/backoff and any behaviour that lives in the robot firmware, including
whether the client branches on `err.code` for 422/404; the exact robot reaction to the empty STS
credentials; S3 bucket-level lifecycle retention.

## Divergences for root (candidate)

1. **422 error code** — Phoenix `ValidationException` vs source-client-visible `Unprocessable Entity`.
2. **404 error code** — Phoenix `NotFoundException` vs source-client-visible `Not Found`.
3. **`SetLevel` validation is over-strict** — `namespaces` items must carry both `namespace` and `level`;
   the source's Joi accepts either/both missing. Reachable from admin tooling.
4. **`SetLevel.friendlyIds: [""]`** accepted by Phoenix, rejected by the source's `Joi.string()`.
5. **Log sink retrievability is process-lifetime** — objects survive on disk but `GET /log/blob` 404s after
   a restart (source objects were retrievable from S3).
6. Pre-existing/carried: upload URLs point at the local sink instead of S3 presigned URLs; `bucketName`
   is the virtual `"log"`; no SNS `RobotVerbosityChanged` fan-out on `SetLevel`; dead Kinesis returns empty
   STS-shaped credentials; `path` leading-slash difference on `PutBinary`.
