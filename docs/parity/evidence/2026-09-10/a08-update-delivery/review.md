# A-08 — Update selection, reporting and package delivery

Task: `docs/parity/tasks.json` → `A-08` (track `classic`, P0, `implementation: partial`).
Worktree: `.parity/worktrees/w3-a08` (branch `w3/a08`).

> **SAFETY:** nothing in this task contacted, or installed anything on, any physical robot.
> The service was *served* on a loopback port and probed with HTTP requests only.

## Specification

From the A-08 row:

- `reference`: `jibo:jiborobot/srv-jibo-server-client/apis/update-2016-03-01.normal.json`,
  `jibo:jiborobot/srv-jibo-server-client/apis/updateadmin-2016-03-01.normal.json`
- `phoenix`: `packages/ota/src`, `packages/ota/test/ota.test.js`, `scripts/build-ota-packages.sh`
- `finding`: *"OTA package catalog/download paths work under tests, but the API inventory has
  five normal and three admin operations."*
- `acceptance`:
  1. every update operation, version/release/subsystem selection, no-update behaviour,
     progress/reporting and admin publication semantics;
  2. package format, integrity, streaming, retry and restart behaviour against the original
     client with temporary fixture packages;
  3. a **controlled hardware** update/rollback test before claiming end-to-end firmware parity
     → **not attempted** (see UNKNOWN).

## Pinned inventory (VERIFIED — 8 operations, one shared targetPrefix)

Both models declare `targetPrefix: "Update_20160301"` (`update-2016-03-01.normal.json:9`,
`updateadmin-2016-03-01.normal.json:10`) but different `endpointPrefix` (`update` /
`updateadmin`). `apis/` contains exactly two update models and no other OTA-shaped model
(`gitea_browse jiborobot/srv-jibo-server-client:apis`, 28 files).

| # | Operation | Model | Input | Output | Auth |
|---|---|---|---|---|---|
| 1 | `ListUpdates` | update | `ListRequest{subsystem,filter}` | `UpdateList` | signed account |
| 2 | `ListUpdatesFrom` | update | `FromRequest{fromVersion*,subsystem,filter}` | `UpdateList` | signed account |
| 3 | `GetUpdateFrom` | update | `FromRequest` | `Update` | signed account |
| 4 | `CreateUpdate` | update | `UpdateRequest` headers `x-update-from-version*`,`x-update-to-version*`,`x-update-changes*`,`x-update-subsystem`,`x-update-filter`,`x-update-dependencies*` + `payload: body` (blob `Stream`) | `Update` | admin |
| 5 | `RemoveUpdate` | update | `Id{id*}` | `Update` | creator |
| 6 | `ListUniqueFilters` | updateadmin | — | `UniqueFilterList` | admin |
| 7 | `SetTarget` | updateadmin | `SerialTarget{serial*,target}` | — | admin |
| 8 | `ListTargets` | updateadmin | — | `SerialTargetList` | admin |

Server source: `jiborobot/srv-update-ws` — `src/handlers/update.handler.ts:13-20`
(`createUpdate,getUpdateFrom,listUniqueFilters,listUpdates,listUpdatesFrom,removeUpdate`) and
`src/handlers/targeted.handler.ts:12-15` (`listTargets,setTarget`).
`jiborobot/srv-server src/server.ts:141-145` `lowerMethodName()` takes
`target.split(".")[1]` and lowercases the first character, which is how
`Update_20160301.ListUpdates → listUpdates`.

## Contract derived from pinned source

### Selection (`srv-update-ws src/controllers/update.ctrl.ts`)

- `DEFAULT_SUBSYSTEM = "main"` (`:11`), `DEFAULT_FILTER = ""` (`:12`).
- `getCondition` (`:29-43`): subsystem is `subsystem || "main"` — **never a match-all**.
  A server-side target for the caller's `friendlyId` **overrides the requested filter**
  (`:33-36`). With no effective filter the condition is `filter: ""` **exactly**; with a filter
  it is `{$regex: "^" + escaped(filter)}` — a **prefix** match (`:37-41`).
- `listUpdates` (`:95-97`): no ordering imposed.
- `listUpdatesFrom` (`:99-104`): queries `{fromVersion, subsystem, filter}` and then
  **sorts descending by `toVersion`** (`:103`).
- `getUpdateFrom` (`:105-112`): highest `toVersion`; among entries tied on that version,
  **uniformly random** (`:110-111`). No candidates → `Boom.createWithCode(UPDATE_NOT_FOUND)`.

### Reporting / progress

The Update API has **no progress or status-report operation** — there is no such member in
either model. Progress is reported by the robot's own system manager (local
`GET/PUT/POST /update/<filter>`), documented in the pinned confluence page *System Manager*
(§OTA Updates, `DownloadProgress{id,length,received,status,reason}`). On the cloud side the only
thing a client can use to report progress is the delivered byte stream: the package route sends
an exact `Content-Length`. The package `url` the service publishes is what the robot downloads.

### Admin publication

- `create` (`:57-87`): duplicate `{fromVersion,toVersion,subsystem,filter}` →
  `UPDATE_ALREADY_EXISTS`; `created = Date.now()`; the upload is piped through
  `digest-stream("sha1")` so `shaHash` + `length` describe the **stored bytes**; `record.filter =
  filter || DEFAULT_FILTER` (`:71`) — so the record **always** carries `filter`.
- `remove` (`:113-120`): delete the stored object, then drop the record;
  `findByIdAndRemove` returns the removed document.
- `listUniqueFilters` (`:129-131`): `Update.distinct("filter")` over **all** records.
- `targeted.ctrl.ts`: `getFilter` → `serial → target` (or `null`); `setTarget` creates/replaces,
  and an **empty target removes the mapping**; `listTargets` → `[{serial,target}]`.

### Error envelopes (exact status codes)

`src/errors/update.ts` + `jiborobot/srv-server src/errors.ts`:

| code | status | message |
|---|---|---|
| `UPDATE_NOT_FOUND` | 404 | Update not found |
| `UPDATE_ALREADY_EXISTS` | 409 | Update with same version specifications already exists |
| `UPDATE_ONLY_ADMIN_CAN_CREATE` | 403 | Only admin account can create platform update |
| `UPDATE_BELONGS_OTHER_ACCOUNT` | 403 | Update belongs to other account |
| `UPDATE_CANNOT_DELETE` | 409 | Update cannot be deleted |
| `AUTHORIZED_UNDER_ADMIN` | 401 | Must be authorized under admin account |

`AUTHORIZED_UNDER_ADMIN` is thrown by `@parseCredentials({adminOnly:true})`
(`srv-server src/parseCredentials.ts`), which is the **outermost** decorator on
`ListUniqueFilters`, `SetTarget` and `ListTargets` — so it fires before Joi validation.
`CreateUpdate` and `RemoveUpdate` carry `@parseCredentials({})`, i.e. no decorator-level gate;
`CreateUpdate`'s admin check is in the method body (`update.handler.ts:45-47`), so required-header
validation (422) runs first. Joi failures become `Boom.badData` → **HTTP 422 with no error code**
(`srv-server src/validate.ts:28`; `boom.ts` sets `output.payload.code` only for
`createWithCode`), so the generated client falls back to `body.error`.

### Gateway allow-list (second auth layer) — VERIFIED

`srv-security-gw src/controllers/auth.ctrl.ts:9-35`: `unauthorizedMethods` lists 20 targets, none
of them `Update_20160301.*`; `unsignedMethods` is **empty**; `unactiveMethods` contains only
`Account_20151111.Remove`. Every one of the eight Update operations therefore requires a signed,
active account at the gateway, which then injects `x-amz-credentials` for the handler decorators.

## Runtime evidence — every operation SERVED

`probe.mjs` (in this directory) spawns the **real entrypoint** `packages/ota/src/index.js` as a
child process with a temporary data dir + manifest and sends real HTTP requests. Raw output:
`probe.json`.

| Operation | Observed |
|---|---|
| `ListUpdates` (no subsystem) | 200, served the `main` entry (subsystem defaults to `"main"`) |
| `ListUpdatesFrom` | 200, `toVersion` order `["12.10.0","12.6.0"]`; manifest insertion order was `["os-12.6.0","os-12.10.0"]` |
| `GetUpdateFrom` | 200, `os-12.10.0` (highest), `shaHash`+`length` of the real file |
| `GetUpdateFrom` (not applicable) | **404 `UPDATE_NOT_FOUND`** |
| `GetUpdateFrom` (missing `fromVersion`) | **422** `{"statusCode":422,"error":"Unprocessable Entity",...}`, no `x-amzn-errortype` |
| `CreateUpdate` (non-admin) | **403 `UPDATE_ONLY_ADMIN_CAN_CREATE`** |
| `CreateUpdate` (admin) | 200, `_id` 24-hex, `length`/`shaHash` of the uploaded bytes, keys include `filter` |
| `CreateUpdate` (duplicate) | **409 `UPDATE_ALREADY_EXISTS`** |
| `RemoveUpdate` (other account) | **403 `UPDATE_BELONGS_OTHER_ACCOUNT`** |
| `RemoveUpdate` (unknown id) | **404 `UPDATE_NOT_FOUND`** |
| `RemoveUpdate` (creator) | 200, returns the removed record |
| `ListUniqueFilters` (anon) | **401 `AUTHORIZED_UNDER_ADMIN`** |
| `ListUniqueFilters` (admin) | 200 `["","green"]` |
| `SetTarget` (anon) | **401 `AUTHORIZED_UNDER_ADMIN`** |
| `SetTarget` (admin) | 200 |
| `ListTargets` (admin) | 200 `[{serial,target}]` |
| targeted robot `GetUpdateFrom` | 200 `be-green` (`filter:"green"` via its server-side target) |
| untargeted robot `GetUpdateFrom` | **404 `UPDATE_NOT_FOUND`** (a filterless request cannot see a `green` record) |
| `GET /ota/package?id=os-12.10.0` | 200 `application/octet-stream`, `Content-Length: 1088`, SHA-1 of the body == `shaHash` in the metadata |

The classic front door (`packages/classic`, matcher `/^update/i`) routes all eight — including
the three that exist only in the *admin* model — to the ota upstream, pinned by a new test.

## Gaps found and closed

Two real, observable divergences from the pinned source. Both were **observed at runtime before
the fix** (see the "before" run recorded in this file's history / `probe.json`).

1. **`ListUpdatesFrom` was not ordered.** Source `update.ctrl.ts:103` sorts the result
   *descending by* `toVersion`; the `UpdateList` output is a JSON array, so its order is part of
   the wire contract. Phoenix returned insertion (manifest) order. Fixed in
   `packages/ota/src/catalog.js`:
   `      .sort((a, b) => cmpVersion(b.toVersion, a.toVersion));`
2. **The wire `Update` omitted `filter` when empty.** Source `update.ctrl.ts:71`
   (`record.filter = filter || DEFAULT_FILTER`) plus the `filter: String` schema path
   (`schemes/update.ts`) mean an unfiltered record serialises `"filter": ""`. `Update.filter` is
   a declared member of the output shape, so a client saw `undefined` instead of `""`. Fixed in
   `packages/ota/src/catalog.js`: `      filter: e.filter || DEFAULT_FILTER,`

A doc-comment in `catalog.js` that cited "DIVERGENCES candidate A8" for the `fromVersion: "*"`
extension was corrected — DIVERGENCES `A8` is the *unknown-target* entry; the wildcard is not
recorded there and is listed below as a divergence candidate instead.

Tests added (all committed):

- `packages/ota/test/ota.test.js`
  - `listUpdatesFrom is ordered by toVersion descending, not by insertion order`
  - `an unfiltered wire Update still carries the filter member`
  - `ListUpdatesFrom serves the pinned descending toVersion order over HTTP`
  - the shared `ENTRIES` fixture was re-ordered so it is inserted *ascending*, which is what
    makes the two ordering tests genuine discriminators rather than passing by luck
- `packages/classic/test/entrypoint.test.js`
  - `all eight Update_20160301 operations reach the ota upstream, admin model included`

## Falsification (performed, concrete)

**1. Ordering.** Reverted the fix to a full code line in `packages/ota/src/catalog.js`, changing

```
      .sort((a, b) => cmpVersion(b.toVersion, a.toVersion));
```
to
```
      .sort((a, b) => cmpVersion(a.toVersion, b.toVersion));
```

Result — `node --test packages/ota/test/ota.test.js`: `# tests 26 # pass 24 # fail 2`, with

```
not ok 8 - listUpdatesFrom is ordered by toVersion descending, not by insertion order
not ok 19 - ListUpdatesFrom serves the pinned descending toVersion order over HTTP
```

Restored the line → `# tests 38 # pass 38 # fail 0` for both ota files.

**2. The `filter` member.** Deleted the full code line
`      filter: e.filter || DEFAULT_FILTER,` from `toUpdate()` in
`packages/ota/src/catalog.js`.

Result — `node --test packages/ota/test/ota.test.js`: `# tests 26 # pass 24 # fail 2`, with

```
not ok 9 - an unfiltered wire Update still carries the filter member
not ok 19 - ListUpdatesFrom serves the pinned descending toVersion order over HTTP
```

Restored the line → green (38/38 for the ota files).

## Verification levels

**VERIFIED (observed at runtime or read in pinned source)**

- All eight operations are served by the real entrypoint, with the exact pinned status codes
  and codes listed above (`probe.json`).
- The selection rules: subsystem default `"main"` and never match-all; filter prefix when asked
  for / exactly `""` when not; server-side target overrides the request filter; random tie-break
  on the top `toVersion`; no-candidate → 404 `UPDATE_NOT_FOUND`.
- Package delivery: exact bytes, `Content-Length` = `length`, body SHA-1 = `shaHash`.
- `CreateUpdate` identity/duplicate/ownership semantics and `RemoveUpdate` ownership.
- The gateway allow-lists exclude all eight targets from `unauthorized`/`unsigned` (2nd auth
  layer), so each requires a signed active account.
- `srv-server` routes the blob `payload` to a separate stream handler
  (`src/server.ts:187-208`, payload `output: "stream"`, `maxBytes: 1000000000`); Phoenix's
  `dispatch.rawBody` mirrors that, and `packages/common/src/service.js:175` honours it.

**INFERRED**

- Joi failure *message text* is reproduced by hand (`child "x" fails because [...]`); only the
  422 status and the absence of a code are load-bearing for the client, which reads `body.error`.
- `cmpVersion` stands in for the source's `versionCompare` for the numeric dotted versions the
  catalog contains; they agree on every version here, and differ only for non-numeric suffixes
  (e.g. `1.2b`) where `versionCompare` returns `NaN`.
- Reporting/progress is client-side (robot system manager); the cloud surface only feeds it
  through `url` + `Content-Length`/`length`/`shaHash`.

**UNKNOWN**

- No real robot, and therefore no end-to-end firmware install/rollback was exercised — A-08's
  third acceptance item is explicitly **out of scope for a software task** and is not claimed.
- The client module named in the pinned confluence page (`jibo-ota-updater`) is **not** in the
  archive (npm lookup returns an unrelated package), so its retry/restart behaviour could not be
  read; only the API models and the aws-sdk fork's `extractData`/`extractError` were.
- Whether any robot-side downloader issues HTTP `Range` requests is unknown; S3/CloudFront (the
  source's `url` target) supports byte ranges, Phoenix's `/ota/package` does not. Unproven, so
  not implemented.

## Divergence candidates (dead / divergent surface)

- **`fromVersion: "*"` wildcard** — `packages/ota/src/catalog.js _applicable()` treats `*` as
  "any installed version, guarded by `cmpVersion(fromVersion, toVersion) < 0`". The pinned model
  has **no such wildcard**: source `listUpdatesFrom` queries `fromVersion` for an exact match, so
  a `*` record would be *unreachable* upstream. Phoenix-only behaviour, relied on by
  `packages/ota/manifest.json`.
- **`GET /ota/package?id=<id>`** — the source's `url` is an S3 object / CloudFront path
  (`record.url`, `update.ctrl.ts:82-85`); Phoenix self-hosts the bytes on its own route. Also,
  the source's `url` is absolute (`cloudFrontPrefix`), Phoenix's is derived from the request Host
  unless `ETCO_ota_publicUrl` is set.
- **Unknown / malformed `x-amz-target` → 400 `UnknownOperationException`** in Phoenix vs the
  source's 404 `Boom.notFound("Method X not found.")` (`srv-server src/server.ts:183-186`). This
  is the already-recorded DIVERGENCES `A8`; repeated deliberately by the ota face for
  consistency with the other Classic faces.
- **No SigV4 re-verification** — the ota face trusts `x-amz-credentials` (LAN posture, like the
  hub's `DISABLE_AUTH`); the source's gateway verifies the signature and the 15-minute skew
  window. Documented posture, not a new divergence.
- **Malformed (non-ObjectId) `RemoveUpdate.id`** — source `findById` throws a mongoose
  `CastError` → `Boom.badImplementation` → 500; Phoenix returns 404 `UPDATE_NOT_FOUND`. Not
  reproduced (a 500 on purpose would be worse than the divergence); a well-formed id behaves
  identically.
- **`SetTarget` success body** — source `reply()` with no result → 200 with an **empty** body;
  Phoenix answers `{}`. Unobservable: the operation declares no output shape, so the generated
  client never parses the body.
- **`prepare`/`lockfile` extras** — `ListUpdates` has no `sort` in the source (Mongo natural
  order, unspecified); Phoenix returns manifest order. Equivalent up to an unspecified order.

## Full test run (this worktree, final)

```
$ npm test
# tests 1277
# suites 7
# pass 1270
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 27473.8978
```

(previous commit: 1273 tests / 1266 pass → +4 tests, +4 pass.)

`parity:check`:

```
Checklist: 16/79 verified (20.3%)
classic: 6/20 verified; 0 in progress; 0 blocked
Tracker structure, dependencies, evidence links and generated checklist are valid.
```

`parity:gate`:

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```
