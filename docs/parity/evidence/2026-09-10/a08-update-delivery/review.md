# A-08 verification — Update selection, reporting and package delivery

**Date:** 2026-09-10
**Task:** A-08 — *Complete Update selection, reporting and package delivery* (P0, classic, implementation: partial)
**Worktree / branch:** `.parity/worktrees/w3-a08` on `w3/a08`
**Result:** pass for the service surface; the third acceptance criterion (a controlled hardware update/rollback) is **not** attempted and is recorded as UNKNOWN.

## Pins

| Source | Pin | Used for |
|---|---|---|
| `jiborobot/srv-jibo-server-client` (API models + generated client) | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` (ledger `baseline.classicApi.commit`) | the operation inventory, request/response shapes, client error/data resolution |
| `jiborobot/srv-update-ws` (the Update *server*) | `master`, read 2026-09-10 | selection, reporting, publication and error semantics |
| `jiborobot/srv-server` (framework) | `master`, read 2026-09-10 | `parseCredentials`, Joi→Boom validation, method dispatch, binary route |
| `jiborobot/srv-security-gw` (gateway) | `43a692fe7670660aaed6ab5979c6c83039eb711c` | the three allow-lists (admissibility) |
| Confluence *Creating OTA Packages* | RM space, last modified 2018-08-15 | the documented delivery contract |

`srv-update-ws` was located through the archive (`gitea_list_repos query=update`) after the API models alone proved insufficient — the model pins the wire, the server pins the semantics. Its `master` had no commit hash exposed by the browse tool; the files are quoted with their paths and line numbers, not a revision. That is the honest limit of this pin (see UNKNOWN #5).

## What was already there, and the gap

The pre-existing `packages/ota` served **three** of the eight model operations (`ListUpdates`, `ListUpdatesFrom`, `GetUpdateFrom`) plus a self-hosted `GET /ota/package`. The A-08 finding — *"the API inventory has five normal and three admin operations"* — is exactly right: **the other five returned `400 UnknownOperationException`.**

| API model | Operation | Admin? | Before | After |
|---|---|---|---|---|
| update-2016-03-01 | `ListUpdates` | — | served | served |
| update-2016-03-01 | `ListUpdatesFrom` | — | served | served |
| update-2016-03-01 | `GetUpdateFrom` | — | served | served |
| update-2016-03-01 | `CreateUpdate` | admin | **400** | served |
| update-2016-03-01 | `RemoveUpdate` | creator | **400** | served |
| updateadmin-2016-03-01 | `ListUniqueFilters` | admin | **400** | served |
| updateadmin-2016-03-01 | `SetTarget` | admin | **400** | served |
| updateadmin-2016-03-01 | `ListTargets` | admin | **400** | served |

Both models declare the **same** `targetPrefix` (`Update_20160301`) even though their `endpointPrefix` differs (`update` vs `updateadmin`) — `update-2016-03-01.normal.json:metadata`, `updateadmin-2016-03-01.normal.json:metadata`. One entrypoint therefore answers all eight by operation name, exactly as Account/AccountAdmin share a prefix under A-03.

`ListUniqueFilters` lives in the **update** handler's mapping (`srv-update-ws src/handlers/update.handler.ts:13-20`) even though its model is in `updateadmin`. Modelled accordingly.

## Criterion 1 — every operation, selection, no-update behaviour, reporting, admin publication

### Version / release / subsystem selection

All rules trace to `UpdateController.getCondition` and its callers (`srv-update-ws src/controllers/update.ctrl.ts:29-43, 95-112`).

| Rule | Pinned source | Behaviour now | Label |
|---|---|---|---|
| Subsystem is always scoped; an omitted one defaults to `main` | `condition.subsystem = subsystem \|\| DEFAULT_SUBSYSTEM` (`update.ctrl.ts:30-32`, `DEFAULT_SUBSYSTEM='main'` `:11`) | `_matchSubsystem` returns `e.subsystem === (subsystem \|\| 'main')` — never a match-all | **VERIFIED** |
| With a filter: the entry's filter is **prefix**-matched | `condition.filter = { $regex: "^" + filter.replace(/[-[\]/{}()*+?.\^$\|]/g, "\\$&") }` (`update.ctrl.ts:37-41`) | `entryFilter.startsWith(requestFilter)` | **VERIFIED** |
| Without a filter: the entry's filter must be **exactly `""`** | `condition.filter = DEFAULT_FILTER` (`:37-38`, `DEFAULT_FILTER=''`) | `filterMatches` → `entryFilter === ''` | **VERIFIED** |
| A server-side target overrides the filter the robot asks with | `getFilter(friendlyId)` → `Target.findOne({serial}).target`; `if (targetedFilter) filter = targetedFilter` (`:33-36`, `targeted.ctrl.ts:19-26`) | `Catalog.effectiveFilter` | **VERIFIED** |
| `fromVersion` is matched **exactly** | `Update.find({ fromVersion, ...condition })` (`:102`) | exact match for non-`*` entries; `*` is a Phoenix extension (below) | **VERIFIED (source)** / **DIVERGENCE (Phoenix)** |
| Highest `toVersion` wins | `updates.sort((a,b) => versionCompare(b.toVersion, a.toVersion))` (`:103`) | `cmpVersion` desc | **VERIFIED** |
| Ties on the top `toVersion` are broken **at random** | `lastVersionUpdates[Math.floor(Math.random() * lastVersionUpdates.length)]` (`:110-111`) | same, with a 60-draw reachability test | **VERIFIED** |

The old implementation was wrong in **two** observable ways and both are fixed:

- `collection.filter(...)` returned `true` for every entry when the request carried no filter, so a filterless robot was offered `green`-filtered firmware it must not see. Falsified below.
- `if (!e.filter) return true` made an **unfiltered** entry a wildcard for a **filtered** request, where source `^filter` cannot match `""`.

The empty-filter exactness also removes the old workaround in `toUpdate` that echoed the *requested* filter onto a wildcard entry; the wire record now always carries the record's own filter, as source does (`src/schemes/update.ts:10`).

### No-update behaviour

`GetUpdateFrom` with no applicable record throws `UPDATE_NOT_FOUND` — `404`, message `Update not found` (`update.ctrl.ts:107-108`; `src/errors/update.ts:3-7`). The `url`'s client-side consequence is load-bearing and is preserved: the robot's system-manager aborts the whole multi-subsystem check on any error code other than `UPDATE_NOT_FOUND`, so a subsystem that is not stocked must return precisely this code. `ListUpdates`/`ListUpdatesFrom` return `200 []` — they do not throw (`:95-104`). **VERIFIED** (runtime probe + `ota.test.js`).

### Reporting

- Every query is logged with `op, subsystem, fromVersion, filter, returned, available` (`packages/ota/src/service.js`) so a robot's "no updates" is diagnosable from the server log alone. This is a Phoenix diagnostic addition; the source logged through NewRelic/Hapi debug only. **INFERRED** as equivalent-in-effect (no wire impact).
- The record's `changes` (free-text release notes) and `created` (epoch ms) ride the wire as declared. `created` is `Date.now()` at publication (`update.ctrl.ts:65`). **VERIFIED**.
- The customer-visible *progress* signal is `Content-Length` on the streamed package (see delivery). **VERIFIED**.

### Admin publication semantics

`SetTarget` / `ListTargets` (admin), `CreateUpdate` (admin), `RemoveUpdate` (creator), `ListUniqueFilters` (admin).

| Behaviour | Source | Implementation | Label |
|---|---|---|---|
| `SetTarget` maps `serial → target`; an empty/`null` target **removes** the mapping (ClearOTATarget) | `targeted.ctrl.ts:34-48` | `Catalog.setTarget` | **VERIFIED** |
| `ListTargets` returns `[{serial,target}]` | `targeted.ctrl.ts:27-32` | `Catalog.listTargets` | **VERIFIED** |
| `ListUniqueFilters` = `Update.distinct("filter")` | `update.ctrl.ts:129-131` | `Catalog.listUniqueFilters` | **VERIFIED** |
| `CreateUpdate` rejects a duplicate `(fromVersion,toVersion,subsystem,filter-condition)` | `update.ctrl.ts:57-62` | `Catalog.createUpdate` | **VERIFIED** |
| `CreateUpdate` digests the uploaded stream for `shaHash` + `length` | `digest-stream('sha1','hex')` → `record.shaHash/length` (`:74-81`) | SHA-1 over the received Buffer; length in bytes | **VERIFIED** |
| `RemoveUpdate` requires the caller to be the record's `accountId` | `update.handler.ts:64-69` | ownership check | **VERIFIED** |
| `RemoveUpdate` deletes the bytes as well as the record | `deleteObject` then `findByIdAndRemove` (`:113-119`) | file unlink + entry drop | **VERIFIED** |

Durability: the source kept records in Mongo and bytes in S3. Phoenix keeps bytes as files under `ETCO_ota_dataDir` (mounted `./packages/ota/data`) and the target map as `targets.json` in the same dir, loaded at startup — so `SetTarget`/`CreateUpdate` survive a process restart within the deployment. **VERIFIED** (load path exercised by `ota.test.js` `Catalog.load`).

## Criterion 2 — package format, integrity, streaming, retry/restart, against the original client

- **Format.** The outer entity is an uncompressed tar containing `./filesystem.tar.bz2`, whose contents are the partition tree — documented verbatim in Confluence *Creating OTA Packages* ("Anatomy of an OTA") and reproduced by `scripts/build-ota-packages.sh`. The service is format-agnostic: it stores and returns opaque bytes and never opens them. **VERIFIED** (script vs doc).
- **Integrity.** `shaHash` is the SHA-1 hex of the bytes and `length` the byte count, computed **from the real file** at load/serve time (`catalog.js` `sha1File`/`ingest`), so a manifest `sha1` that disagrees is warned about and the computed value wins. The probe confirms a created package's `shaHash`/`length` equal the uploaded bytes and that the downloaded bytes re-hash to the same value. **VERIFIED**.
- **Streaming.** `GET /ota/package?id=` sets `content-type: application/octet-stream` and an exact `content-length` **before** piping, then `pipeline(createReadStream(...), res)`. A mid-flight client disconnect is caught and logged, not crashed (`service.js`). **VERIFIED** (probe: 200 / 816 / 816 / `sha1Matches: true`).
- **Client-side contract.** The generated client parses the response with `JsonParser.parse(body, outputShape)` (`srv-jibo-server-client lib/protocol/json.js:79-88`), which is why the record is emitted with exactly the declared members and why the project rule holds: a field the model does not declare is **unobservable** and is not a defect.
- **Retry / restart.** Retries live in the robot's downloader and in the aws-sdk, not in the server; the server is stateless per request apart from the file. A restart re-derives every entry's length/SHA-1 from disk and reloads `targets.json`, so a retried request after restart is answered identically. This is **INFERRED** from the load path plus the probe — no robot retry loop was executed (no OTA install was performed, by instruction).

## Error envelopes — exact status codes

| Condition | Source | Emitted now | Body | Header |
|---|---|---|---|---|
| `GetUpdateFrom` / `RemoveUpdate` on a missing record | `UPDATE_NOT_FOUND` 404 | 404 | `{"__type":"UPDATE_NOT_FOUND","message":"Update not found"}` | `x-amzn-errortype: UPDATE_NOT_FOUND` |
| `CreateUpdate` duplicate | `UPDATE_ALREADY_EXISTS` 409 | 409 | `__type` + `Update with same version specifications already exists` | `x-amzn-errortype` |
| `CreateUpdate` non-admin | `UPDATE_ONLY_ADMIN_CAN_CREATE` 403 | 403 | `__type` + `Only admin account can create platform update` | `x-amzn-errortype` |
| `RemoveUpdate` other account | `UPDATE_BELONGS_OTHER_ACCOUNT` 403 | 403 | `__type` + `Update belongs to other account` | `x-amzn-errortype` |
| `RemoveUpdate` delete returned nothing | `UPDATE_CANNOT_DELETE` 409 | 409 | `__type` + `Update cannot be deleted` | `x-amzn-errortype` |
| Admin-only op, caller is not admin | `AUTHORIZED_UNDER_ADMIN` 401 | 401 | `__type` + `Must be authorized under admin account` | `x-amzn-errortype` |
| Joi shape failure (required/empty/type) | `Boom.badData` → 422, **no code** | 422 | `{"statusCode":422,"error":"Unprocessable Entity","message":"child \"x\" fails because [\"x\" is required]"}` | none |
| Internal throw | `Boom.badImplementation` 500 | 500 | `__type` + message | `x-amzn-errortype` |

The **coded** rows are emitted as `__type` instead of the source's `code`, and that is *not* observable: the pinned client's `extractError` resolves the code as `body.__type || body.code || body.error` with the body overriding the header (`lib/protocol/json.js:52-73`), the equivalence A-02/A11 already established. The **uncoded** rows must NOT carry `__type` — with no code in the body the client falls through to `body.error`, so sending `__type` there would change the client-visible code from `Unprocessable Entity` to a codified name. That is why the 422 path bypasses `sendAmzError` (`awsJson.js` `sendBoom`), the same split `log.js` makes for the Log surface. Joi message wording matches the pinned joi form the repo already pinned down in A18d.

The one deliberate non-match is the **unknown operation** status: Phoenix returns `400 UnknownOperationException` where `srv-update-ws` would answer `Boom.notFound` 404 (`srv-server src/server.ts:185`). That is the already-recorded **A8** divergence, retained for consistency with every other Classic face; no new divergence is introduced here.

## Two-layer auth — both layers checked

**Handler decorators.** `@parseCredentials({adminOnly:true})` → `AUTHORIZED_UNDER_ADMIN` 401 before any validation (`srv-server src/parseCredentials.ts:23-27`, `src/errors.ts:3-7`); `CreateUpdate`'s own `if (!isAdmin)` → 403 inside the method (`update.handler.ts:45-47`), so a non-admin with *malformed* headers sees 422 first — decorator stacking reproduced in that order. Credentials come from the gateway-injected `x-amz-credentials` header, never from the raw `Authorization` value; a malformed header degrades to `{}` exactly as the source's `try/catch` does.

**Gateway allow-lists.** Re-read the pinned gateway at `43a692fe`: `unauthorizedMethods` is 20 entries, `unsignedMethods` is empty, `unactiveMethods` is `Account_20151111.Remove` only (`srv-security-gw src/controllers/auth.ctrl.ts`). **None of the eight Update targets appears in any list**, so every Update operation requires a verified SigV4 caller and an active account at the gateway. Phoenix's OTA process does not re-verify SigV4 (LAN trust, the hub's `DISABLE_AUTH` posture, shared with every other Classic face) and enforces the decorator layer. **VERIFIED** (static, both repos) — the gateway-side rejection was not exercised live here; A-02 owns that live boundary.

## Runtime — every operation SERVED

`docs/parity/evidence/2026-09-10/a08-update-delivery/probe.mjs` starts the real service on a loopback port and drives all eight operations; `probe.json` is the raw result. It only serves fixture packages from a temp dir — **no robot was contacted and no OTA install was triggered**.

```
probe: 8 operations served, 11 requests, delivery sha1 ok=true
served: CreateUpdate, GetUpdateFrom, ListTargets, ListUniqueFilters, ListUpdates,
        ListUpdatesFrom, RemoveUpdate, SetTarget
```

| # | request | status | envelope |
|---|---|---|---|
| 1 | `ListUpdates {subsystem:'os'}` | 200 | `[Update]` |
| 2 | `ListUpdatesFrom {fromVersion:'3.3.4',subsystem:'os'}` | 200 | `[Update]` |
| 3 | `GetUpdateFrom {fromVersion:'3.3.4',subsystem:'os'}` | 200 | `Update` |
| 4 | `GetUpdateFrom {fromVersion:'12.10.0',subsystem:'os'}` | 404 | `UPDATE_NOT_FOUND` |
| 5 | `CreateUpdate` (admin, 1 KiB entity) | 200 | `Update` (`shaHash`/`length` match) |
| 6 | `CreateUpdate` (non-admin) | 403 | `UPDATE_ONLY_ADMIN_CAN_CREATE` |
| 7 | `ListUniqueFilters` (admin) | 200 | `["", "green"]` |
| 8 | `SetTarget {serial,target}` (admin) | 200 | `{}` |
| 9 | `ListTargets` (admin) | 200 | `[{serial,target}]` |
| 10 | `RemoveUpdate` (creator) | 200 | `Update` |
| 11 | `RemoveUpdate` (unknown id) | 404 | `UPDATE_NOT_FOUND` |
| — | `GET /ota/package?id=os-12.10.0` | 200 | `816` bytes, sha1 matches |
| — | `GET /healthcheck` | 200 | `ok` |

The Classic front door was confirmed for the binary path too: `Update_20160301.CreateUpdate` is detected as a raw entity (`packages/classic/src/router.js` `isClassicStreamedUpload`), skips body-parser, and is piped upstream byte-for-byte — asserted by SHA-1 equality on a 1 KiB entity in `packages/classic/test/entrypoint.test.js`. A JSON `Update_*` operation is still proxied as JSON after that (same file).

## Falsification

Two independent corruptions, each anchored on a **full code line**, each restored and re-verified.

**F1 — the CreateUpdate admin gate** (`packages/ota/src/service.js:157`; highest severity: without it a non-admin publishes firmware).

```diff
-          if (!creds.isAdmin) return void sendAmzError(res, UPDATE_ONLY_ADMIN_CAN_CREATE.statusCode, UPDATE_ONLY_ADMIN_CAN_CREATE.code, UPDATE_ONLY_ADMIN_CAN_CREATE.message);
+          if (false && !creds.isAdmin) return void sendAmzError(res, UPDATE_ONLY_ADMIN_CAN_CREATE.statusCode, UPDATE_ONLY_ADMIN_CAN_CREATE.code, UPDATE_ONLY_ADMIN_CAN_CREATE.message);
```

Result — `node --test packages/ota/test/updateAdmin.test.js`:

```
not ok 5 - CreateUpdate is admin-gated: 403 UPDATE_ONLY_ADMIN_CAN_CREATE for a non-admin
    Expected values to be strictly equal:  expected: 403  actual: 200
not ok 7 - CreateUpdate stores the package and returns the wire Update record
    Expected values to be strictly equal:  expected: 200  actual: 409
# tests 12  # pass 10  # fail 2
```

Test 5 fails because the non-admin upload is accepted; test 7 then cascades into `409` because that non-admin call already created the record the admin call expected to create. Restored → `# tests 12 # pass 12 # fail 0`.

**F2 — the filterless-exact-match selection rule** (`packages/ota/src/catalog.js`, `filterMatches`); the rule that decides *which firmware a robot is offered*.

```diff
-  return (entryFilter || '') === '';
+  return true;
```

Result:

```
ota.test.js:        not ok 9  - filter: prefix when asked for, empty-string-exact when not
                    not ok 10 - filterMatches is the source rule in both directions
                    # tests 22  # pass 20  # fail 2
updateAdmin.test.js: not ok 4 - a robot presenting a targeted serial sees the target-filtered update
                    # tests 12  # pass 11  # fail 1
```

A filterless robot with no server-side target is offered a `green` (A/B-only) update — the precise defect the fix removes. Restored → 44/44 green across `ota.test.js`, `updateAdmin.test.js`, `entrypoint.test.js`.

## Divergence candidates (NOT written to DIVERGENCES.md)

1. **`fromVersion: "*"` wildcard + loop-guard.** Source requires `fromVersion` to equal the robot's installed version exactly (`update.ctrl.ts:102`); the Confluence contract says the same ("the update's from version must match Jibo's currently-installed version"). Phoenix treats `"*"` as "any lower version" and refuses to re-offer a version the robot already runs. This is a deliberate Phoenix extension that lets one built package serve every installed version (see `packages/ota/manifest.json` notes); without it the shipped manifest matches no robot. It is a **superset** of the documented rule, not a defect, but it should be recorded.
2. **Package URLs are self-hosted, not S3/CloudFront.** Source returns `uploadResult.Location` or `${cloudFrontPrefix}/${bucketPath}/${recordId}` (`update.ctrl.ts:82-85`, `config/config.json`); Phoenix returns `${host}/ota/package?id=<id>`. Already implied by DIVERGENCES `H-backup` ("no S3 — same self-hosting as OTA packages") but not stated as its own OTA row.
3. **Target map key is the credential identity when no serial resolver is wired.** Source always resolves `friendlyId → serial` through `robotread` (`Robot_20160225.GetRobot`, `src/clients/robot.ts:13-25`) before `Target.findOne({serial})`, and returns `undefined` when the serial cannot be resolved. Phoenix's update process has no robotread hop, so `Catalog.getFilter` uses an injectable `serialOf` resolver and otherwise keys on the identity the robot presents. Deployment-visible: an admin must `SetTarget` the id the robot actually presents unless a resolver is supplied. Worth a row.
4. **Store is files, not Mongo.** Records are manifest entries + package files; the target map is `targets.json`; `_id` is a random 24-hex string shaped like an ObjectId. No wire impact (the model declares `_id` as a plain string).
5. **Unknown-operation status 400 vs 404/500** — already recorded as **A8**; re-confirmed, not a new divergence.

## Honest unknowns

1. **UNKNOWN — the third acceptance criterion.** No controlled hardware update/rollback was run. Per instruction, no OTA installation was triggered against the robot at `192.168.1.217`; a real `jibo-download-update` / `apply_os.js` / `activeroot` flip on a physical unit is unexercised. End-to-end firmware parity is **not** claimed.
2. **UNKNOWN — the robot's own update loop.** The `UpdateManager::checkForUpdates` error-code sensitivity and the downloader's retry/restart behaviour are quoted from prior Phoenix comments and Confluence, not re-derived from robot firmware, which is not in the read set.
3. **UNKNOWN — `srv-update-ws` revision.** No commit hash was exposed by the archive browse tool for that repo; files are cited by path and line. The ledger pins the *API models* precisely; the server semantics carry one pin less.
4. **UNKNOWN — live gateway rejection.** The claim that all eight operations require a signed, active account is static (the three allow-lists contain no `Update_*` entry). No signed request was driven through a pinned gateway to observe the rejection.
5. **UNKNOWN — targeting precedence on a real robot.** Confluence states server-side targets take precedence over on-robot targets; the server-side override is verified here, but the on-robot target's own filter value and its interaction were not observed on hardware.
6. **INFERRED — reporting equivalence.** Phoenix's structured query log is an addition; there is no evidence the original emitted an equivalent record on a channel any consumer reads.

## Reproduce

```bash
cd .parity/worktrees/w3-a08
node --test packages/ota/test/ota.test.js packages/ota/test/updateAdmin.test.js packages/classic/test/entrypoint.test.js
node docs/parity/evidence/2026-09-10/a08-update-delivery/probe.mjs
npm test
```

## Full `npm test`

Run once, at the end, from the worktree root (`npm test` = `test:unit && parity:check && parity:gate`), 2026-09-10:

```
> phoenix@0.0.0 test:unit
> node --test

# tests 1273
# suites 7
# pass 1266
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 25706.098714

> phoenix@0.0.0 parity:check
> node scripts/parity-status.mjs --check

Checklist: 16/79 verified (20.3%)
classic: 6/20 verified; 0 in progress; 0 blocked
Tracker structure, dependencies, evidence links and generated checklist are valid.

> phoenix@0.0.0 parity:gate
> node scripts/parity-production/gate.mjs

Strict production smoke gate (43 cases; full corpus remains separately tracked).
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

**Counts:** `1273 tests, 1266 pass, 0 fail, 7 skipped, 0 cancelled`; process exit `0`.
**Parity gate JSON:** `{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
**Tests added/changed:** `packages/ota/test/ota.test.js` (16 → 23), `packages/ota/test/updateAdmin.test.js` (new, 12), `packages/classic/test/entrypoint.test.js` (8 → 10).

## Files changed

| File | Change |
|---|---|
| `packages/ota/src/catalog.js` | source-exact selection (subsystem default, filter rule, targeted override), random tie-break, target map, `createUpdate`/`removeUpdate`/`listUniqueFilters` |
| `packages/ota/src/service.js` | all eight operations, decorator-order auth, Joi-equivalent validation, raw CreateUpdate entity |
| `packages/ota/src/awsJson.js` | `credentialsFrom`, `sendBoom` (uncoded 422), `readBody` |
| `packages/ota/src/errors.js` | new — the five codified Update errors + `AUTHORIZED_UNDER_ADMIN`, verbatim messages |
| `packages/ota/src/index.js` | optional `serialOf` resolver, export errors |
| `packages/classic/src/router.js` | `CreateUpdate` treated as a raw entity and piped byte-for-byte |
| `packages/ota/test/ota.test.js`, `packages/ota/test/updateAdmin.test.js`, `packages/classic/test/entrypoint.test.js` | selection, envelopes, admin/publication, delivery, binary forwarding |
| `docs/parity/evidence/2026-09-10/a08-update-delivery/{probe.mjs,probe.json,review.md}` | this evidence |

