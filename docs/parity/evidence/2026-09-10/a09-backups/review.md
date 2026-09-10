# A-09 — Make backups durable and match ownership/restore semantics

Date: 2026-09-10 · Worktree: `.parity/worktrees/w3-a09` (branch `w3/a09`) · Task: A-09 (P0, classic)
Result: durability and ownership are **implemented and demonstrated at runtime**; evidence below
labelled VERIFIED / INFERRED / UNKNOWN.

## Specification (from `docs/parity/tasks.json` A-09 row)

```
reference:   jibo:jiborobot/srv-jibo-server-client/apis/backup-2017-02-22.normal.json
phoenix:     packages/classic/src/backup.js, packages/classic/test/backup.test.js
finding:     "The uncommitted backup implementation stores blobs on disk but its index is in memory
              and ownership enforcement is dropped."
acceptance:  1. Preserve New/List shapes, signed upload/download semantics, content integrity,
                 limits, ordering and source ownership checks.
             2. Recover index and blobs across process crashes/restarts; verify backup -> restart ->
                 list -> restore with the original client sequence.
             3. Perform destructive wipe/restore only in a separately authorized controlled
                 hardware run after backup validation.
```

This worktree had **no pre-existing A-09 candidate report**; every claim below is re-derived from
the pinned source, and where the pinned source and the old code comment disagreed, the source won
(recorded under "Source vs the old comment").

## Pins actually read

| Source | Revision | File(s) |
| --- | --- | --- |
| `jiborobot/srv-backup-ws` | `1153de1e343310a3f48f74ea3cbbe01e4bccab65` | `src/handlers/handler.js`, `src/controllers/ctrl.js`, `src/errors/backup.js`, `src/clients/account.client.js`, `src/index.js` |
| `jiborobot/srv-server` (`@jibo/server`) | `/home/shell/work/srv-server-archive/src` (clone used by A-02/A-12) | `validate.ts`, `boom.ts`, `parseCredentials.ts`, `server.ts`, `wreck.ts` |
| `jiborobot/srv-jibo-server-client` (the robot's aws-sdk fork) | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | `apis/backup-2017-02-22.normal.json`, `lib/protocol/json.js`, `lib/json/{builder,parser}.js`, `lib/model/shape.js` |

The `srv-*` repos' HEAD is a 2026 pvindex URL-migration commit; the pre-migration parents above are
the last original Jibo revisions (same convention as A-01's attributes candidate).

## 1. The full backup surface (pinned source)

**Operations — exactly two** (`backup-2017-02-22.normal.json:12-25`, `targetPrefix: Backup_20170222`):

| Op | input | output | source handler |
| --- | --- | --- | --- |
| `New` | `NewBackupRequest { loopId required }` | `NewBackupResponse { uploadUrl required }` | `handler.js:17-22` → `ctrl.js:24-40` |
| `List` | `ListRequest { loopId required }` | `ListResponse = [BackupItem]` | `handler.js:29-35` → `ctrl.js:42-81` |

`BackupItem = { modified, etag, size, location:{expires,url} }` (`normal.json:56-75`). Note the model
declares `size`/`expires` as **string** while `ctrl.js:67,69` emits a **number** (S3 `Size`, epoch ms) —
a source/model mismatch the source shipped; see "Not defects" below.

**Validation** (`handler.js:13-16,24-28`) — both ops are `@parseCredentials({})` + `@validatePayload`:

- `New`: `loopId: Joi.string().required()`.
- `List`: `loopId: Joi.string().required()`, `max: Joi.number().integer().min(1).max(1000)`.
- `srv-server validate.ts:23` runs `Joi.validate(payload, schema, { allowUnknown: true })`; a failure
  rejects with `Boom.badData(err)` (`validate.ts:26`) → **HTTP 422**, Hapi body
  `{statusCode:422, error:"Unprocessable Entity", message:"<joi message>"}` and **no** `code` field.
- `ctrl.js:44-46` also guards `max<1 || max>1000` with `INVALID_MAX_RESULTS_RANGE` (422,
  `errors/backup.js:7-11`) — **dead on the wire**: Joi rejects out-of-range `max` first, and `max` is
  not even a declared member of `ListRequest` (see "Not defects").

**Ownership — both ops** (`ctrl.js:26-28,48-50`; `errors/backup.js:1-5`):

```
const loop = await this.accountClient.getLoop(loopId);
if (loop.robot !== accountId) throw Boom.createWithCode(Errors.ROBOT_SHOULD_BELONG_TO_LOOP);
```

- `accountId` = `request.auth.credentials.id` (`handler.js:19,31`).
- `credentials` come from the security gateway's `x-amz-credentials` header:
  `srv-server parseCredentials.ts:15` is literally `JSON.parse(request.headers["x-amz-credentials"])`.
  **The gateway, not the handler, is the verifier** — this is the source trust boundary.
- `getLoop` is `GET http://<account>/loop?loopId=<id>` (`account.client.js:10-18`).
- The refusal is `boom.createWithCode` (`boom.ts:3-7`), which sets `error.output.payload.code`, so the
  wire body is `{statusCode:403, error:"Forbidden", message:"Robot should belong to the loop",
  code:"ROBOT_SHOULD_BELONG_TO_LOOP"}`.
- Annexed fact (from A-01 attributes, `candidates/A-01-attributes-device-20260910.md:50,56`): the
  security gateway's `unauthorizedMethods`/`unsignedMethods`/`unactiveMethods` lists do **not** contain
  `Backup_20170222`, so the source always had credentials at this handler. Not re-derived here.

**Dispatch / errors** (`srv-server server.ts`): an unknown operation is
`Boom.notFound("Method " + methodName + " not found.")` at **404** (`server.ts:182-183`), where
`methodName` lowercases only the first character of the target's second segment (`server.ts:139-143`).
Boom replies go out verbatim (`server.ts:156-158`).

**Restore semantics.** `List` returns `location.url` = an S3 **presigned GET** (`ctrl.js:70-74`,
`Expires: 24h`); restore is a plain GET of that URL. There is **no server-side owner check at
restore** — the URL signature is the authorization. `New`'s `uploadUrl` is an S3 presigned **PUT**
(`ctrl.js:31-39`).

**Client-visible error code** (`lib/protocol/json.js:62-71`): `x-amzn-errortype` first, then
overridden by body `__type || code || error`, `#`-suffixed; `message` = body `message`.

## 2. Runtime proof that both operations are SERVED

Started the real entrypoint (`node packages/classic/src/index.js`) and sent live requests (raw curl
transcript, `/tmp/a09-wire.sh`):

| Request | Observed |
| --- | --- |
| `Backup_20170222.New {loopId}` | `200` + `{uploadUrl: "http://localhost:8793/backup/blob?loopId=…&key=…"}` |
| `PUT <uploadUrl>` | `200` + `ETag: "<md5>"` |
| `Backup_20170222.List {loopId}` | `200` + `[{modified,etag,size,location:{expires,url}}]` with `etag` == the PUT ETag |
| `GET <location.url>` | `200` + the exact bytes |
| `Backup_20170222.New {}` | `422` `{"statusCode":422,"error":"Unprocessable Entity","message":"child \"loopId\" fails because [\"loopId\" is required]"}` |
| `Backup_20170222.Bogus {loopId}` | `404` `{"statusCode":404,"error":"Not Found","message":"Method bogus not found."}` |
| `PUT /backup/blob?loopId=..%2f..%2fetc&key=passwd` | `400 bad loopId/key` |
| `Nope_1.Ping` | `400` `UnknownOperationException` (router; unchanged) |

VERIFIED: both wire operations are dispatched in-process and answered; the round trip is byte-exact.

## 3. Durability — demonstrated by ACTUALLY RESTARTING

**Mechanism** (`backup.js:70-101`): the in-memory `index` is a cache; `_entries()` re-indexes a
loop's object directory via `recover()` on a miss, recomputing size, mtime and the quoted md5 ETag
from the file. `put` writes the object then records the entry (`backup.js:104-118`); `recover` scans
`<dir>/<loopId>/` (`backup.js:79-99`). On-disk layout is unchanged — no sidecars.

**Test** `packages/classic/test/backup.test.js:189` spawns the real entrypoint as a **child process**,
does `Backup.New → PUT`, `SIGKILL`s it, starts a **second process on a different port** with the same
`ETCO_classic_backupDir`, then `List` + `GET`. It asserts the post-restart `etag` equals the
pre-restart PUT ETag, the size matches, and the restored bytes are identical. Test `:171` proves the
in-process case (`new BackupStore(dir).index.size === 0` → `list()` still returns the entry).

**Manual out-of-band transcript** (`/tmp/a09-run.sh`, separate OS processes):

```
blob sha256: 282bc8cd18a5e8779e6b7626821bed1d39b4d4ba763b17952253428aa874ddf2
== child 1 pid=276640 ==
PUT -> ETag: "b15977bcf63c36bc0bd5b192975ae21e"
list before restart: [{"modified":"2026-09-10T19:16:17.792Z","etag":"\"b15977bcf63c36bc0bd5b192975ae21e\"","size":27,...}]
killed -9 child 1
on-disk object files:
  /tmp/a09-manual/loop-manual/8210932222276-4724c1c0 27 bytes
== child 2 pid=276712 (new process) ==
list after restart:  [{"modified":"2026-09-10T19:16:17.786Z","etag":"\"b15977bcf63c36bc0bd5b192975ae21e\"","size":27,...}]
GET .../backup/blob?loopId=loop-manual&key=8210932222276-4724c1c0 -> 27 bytes, sha256 282bc8cd…ddf2
RESTORED BYTES IDENTICAL: yes
etag identical after restart: True
```

VERIFIED: after `SIGKILL` of the accepting process, a **new** process re-reads the object from disk,
returns the identical ETag/size, and serves byte-identical content.
(`modified` shifts by 6 ms between runs because the fresh process uses the file mtime — the source's
`LastModified` was likewise the write time, not a stored field.)

The original client sequence is preserved across the restart: `New → PUT → List(etag match) → GET`.

## 4. Ownership / restore semantics — verified concretely

Implemented in `backup.js:196-256`:

- `credentialsAccountId(req)` (`:196`) reads the gateway's `x-amz-credentials` (`.id ?? ._id`), the
  exact source seam (`parseCredentials.ts:15`).
- `accountLoopRobot(loopId)` (`:220`) reproduces `AccountClient.getLoop` — `GET <account>/loop?loopId=`.
  A new internal Account route backs it: `packages/account/src/backupPeerRoutes.js:12-19`, registered
  at `packages/account/src/index.js:307`. Returns the loop's `robot` (account id); 404 → `null`
  ("no such loop"); network/other failure → `undefined` ("could not resolve").
- `ownershipRefusal` (`:244-255`): no caller identity → **allow** (Phoenix has no security gateway;
  documented LAN trust). Unresolved lookup → **allow** + warn (an account outage must not fail a
  legitimate backup). Otherwise `String(loop.robot) === caller` → allow, else **403
  ROBOT_SHOULD_BELONG_TO_LOOP**.

Runtime results (tests `backup.test.js:227-317`):

| Case | Result |
| --- | --- |
| caller == the loop's robot | `New` 200, `List` 200 |
| a different account, same loop | `New` **403**, `List` **403**, body `{statusCode:403,error:"Forbidden",message:"Robot should belong to the loop",code:"ROBOT_SHOULD_BELONG_TO_LOOP"}`; the pinned client's `extractError` yields `ROBOT_SHOULD_BELONG_TO_LOOP` |
| no identity supplied | 200 (LAN-trust path, logged) |
| account service unreachable | 200 (unresolved, warned) |
| **end-to-end against a real Account service**: robot-1 owns loop-1 | robot-1 200; robot-2 **403**; a loop the account service does not know **403** |

**Restore authorization** (test `:319`): the source's presigned GET *was* the authorization.
Phoenix's self-hosted URL is unsigned, so possession of `location.url` is the only gate — an
unauthenticated GET of another loop's URL returns the blob. This is the pre-existing H-backup
self-hosting divergence, now stated precisely; it is not newly introduced by A-09.

## 5. Falsification (required)

Both high-risk mechanisms were broken on a **full code line**, the relevant test confirmed RED, then
restored and confirmed GREEN. Anchors are exact lines, not substrings, so no comment can match.

1. **Durability.** `packages/classic/src/backup.js:74`
   `    if (!a) a = this.recover(loopId);`
   was replaced with `    if (!a) { a = []; this.index.set(loopId, a); }` (the old in-memory-index
   behaviour: never rebuild from disk).
   → `not ok 6 - durable: a fresh in-process store re-indexes a loop directory from disk` and
   `not ok 7 - durable: Backup.New -> PUT -> List -> GET survive a real service restart`
   (`the restarted service lists the backup written before the kill / 0 !== 1`); 12 pass / 2 fail.
   Restored (`diff` byte-identical) → 14/14 pass.
2. **Ownership.** `packages/classic/src/backup.js:253`
   `    if (String(robot) === caller) return null;`
   was replaced with `    if (true) return null; // FALSIFICATION: ownership check disabled`.
   → `not ok 9 - ownership: a different account is refused…` and
   `not ok 12 - ownership: end-to-end through a real Account service…`; 12 pass / 2 fail.
   Restored (`diff` byte-identical) → 14/14 pass.

## 6. VERIFIED / INFERRED / UNKNOWN

**VERIFIED** (observed at runtime or read directly in a pinned file)
- Both operations served; `New`/`List` shapes, the PUT ETag, the List etag match and the GET bytes —
  runtime, both in-process and across a real restart.
- 403 ROBOT_SHOULD_BELONG_TO_LOOP on a foreign loop for both ops, with the exact body/code; 422
  Boom.badData for invalid `loopId`; 404 `Method <op> not found.` for an unknown op — runtime.
- Durability across a SIGKILL + new process: same etag/size, byte-identical blob (test + manual).
- Source semantics cited by file:line above (`ctrl.js`, `handler.js`, `errors/backup.js`,
  `account.client.js`, `parseCredentials.ts`, `validate.ts`, `boom.ts`, `server.ts`, the client
  protocol/builder/parser/shape files, and the API model).
- `Loop.List` → the robot's loop → `New`/`List` sequence still works (test 1).

**INFERRED**
- The source's behaviour for a **loop that does not exist**: `getLoop` goes through `wreck` with
  `json:true` (`wreck.ts:48-64`), so a JSON error body becomes `Boom.createWithCode({statusCode,…})`
  and would surface as the account service's status (likely 404) rather than the controller's own
  code. Not executed (services are dead). Phoenix chooses the fail-closed 403 for that case.
- The report of `INVALID_MAX_RESULTS_RANGE` is unreachable from the pinned client (see below).
- `x-amz-credentials` is trusted, as in the source; a real security gateway would have verified the
  signature first (AUDIT F14 / A-02 boundary).

**UNKNOWN**
- Whether the robot's `jibo-system-backup.js`/`restore.js` read `size`/`expires` at all (only the
  `etag` comparison is documented in `backup.js`'s client notes). Not re-derived here.
- Real S3 presigned-URL query shape and lifecycle (dead AWS); Phoenix's URL is a value-shape
  substitute.
- Firmware/client behaviour on the exact 422/403 codes (no firmware in the archive).
- Whether the original account service's `GET /loop` returned the full Loop document or a projection
  (only `loop.robot` is load-bearing for Backup).

## 7. Not defects (checked against the client's own code)

- **`max` is not declared in `ListRequest`** (`normal.json:46-54` — only `loopId`). The generated
  client's `JsonBuilder.translateStructure` iterates the params and drops any name absent from
  `shape.members` (`lib/json/builder.js:26-37`), so **no real client can ever send `max`**; the
  default `max=1` always applies. Phoenix's clamp (`backup.js:121`) and the source's
  `INVALID_MAX_RESULTS_RANGE` are therefore both unobservable on the wire and were left as-is rather
  than "fixed".
- **`size`/`expires` numbers vs the model's `string`.** `ctrl.js:67,69` emits numbers; Phoenix emits
  numbers. `JsonParser`'s `StringShape` only coerces for rest-xml/query/ec2 (`shape.js:285-291`), so a
  number stays a number in JSON — **identical on both sides**. Recorded, not diverged.
- **Undeclared response fields are invisible**: `JsonParser.translateStructure` iterates
  `shape.members` (`lib/json/parser.js:22-33`), so anything outside `BackupItem` could not be observed
  by any client. Nothing was added.

## 8. Source vs the old code comment

The pre-change `backup.js` header asserted the ownership check was deliberately dropped for LAN trust
and that storage was "process-lifetime… durable enough for backup→wipe→reboot→restore within one
server run". The pinned source says the opposite on both counts (the check exists; S3 outlived the
process), and A-09's acceptance requires recovery across restarts. **The source wins**; the comment
and the behaviour it described were wrong and are corrected.

## 9. Divergence candidates for root (do not edit tasks.json / DIVERGENCES.md)

1. **D2x — Backup error envelope moved to the source Boom form.** `packages/classic/src/backup.js`
   now emits 422 `{statusCode,error:"Unprocessable Entity",message}` and 404
   `{statusCode,error:"Not Found",message:"Method <op> not found."}` instead of the shared
   `sendAmzError` 400 `ValidationException`, and 403 with an explicit `code`. This closes the
   `backup.js` half of the recorded A12d "older 400 convention" (robot.js still 400 — A-07's file).
2. **D2y — Ownership restored (F14 adjacent).** `loop.robot === credentials.id` is enforced again for
   `New` and `List`; identity comes from the gateway-style `x-amz-credentials` header, and when it is
   absent the documented LAN-trust path still applies (Phoenix has no srv-security-gw process). The
   account lookup is a new internal `GET /loop?loopId=` peer route on the Account service
   (`backupPeerRoutes.js`) reproducing `srv-backup-ws`'s `AccountClient.getLoop`.
3. **D2z — Unknown-loop ownership is fail-closed 403** where the source would likely propagate the
   account service's 404 (INFERRED, unexecutable).
4. **H-backup extension — restore is unauthenticated.** The self-hosted `location.url` carries no
   signature, so restore authorization is possession of the URL, not a presigned credential. Extends
   the existing H-backup self-hosting entry.
5. **Behavioral note — the default backup dir accumulates.** Because the index is rebuilt from disk,
   `$TMPDIR/phx-backups` now surfaces objects written by *every* prior run. Tests must point
   `ETCO_classic_backupDir` at a per-run directory (done here); production should keep a stable dir.
6. **`loopId` traversal guard is Phoenix hardening.** The source's `Joi.string()` accepts `../..`,
   which it interpolates into an S3 key; Phoenix refuses non-`[A-Za-z0-9_-]` loopIds with a 422 Joi-
   style message. Unreachable from the generated client (which sends the id it read from `Loop.List`).

## 10. Full suite + parity gate

`npm test` (= `npm run test:unit && npm run parity:check && npm run parity:gate`), exit code **0**,
full log in `docs/parity/evidence/2026-09-10/a09-backups/npm-test.txt`:

```
# tests 1206
# pass 1199
# fail 0
# cancelled 0
# skipped 7
```

`parity:check`: "Tracker structure, dependencies, evidence links and generated checklist are valid."
(Checklist 16/79 verified.)

`parity:gate` (43-case strict production smoke):

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Baseline: A-09 added exactly 11 tests to `packages/classic/test/backup.test.js` (3 → 14) and touched
no other test file, so the branch-point suite was 1195 tests / 1188 pass / 0 fail / 7 skip
(INFERRED by arithmetic on the observed run; the 7 skips are the known
`scripts/nlu-compiled-graphs-install.test.mjs` path artifact).
