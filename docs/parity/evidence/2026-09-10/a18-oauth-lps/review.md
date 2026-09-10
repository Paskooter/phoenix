# A-18 verification — remaining admin, OAuth-client and LPS contracts

**Date:** 2026-09-10
**Task:** A-18 (implemented and merged on `main`; this is independent verification)
**Result:** pass with two candidate divergences (below); recommend marking verified

## Pins (all re-read from the archive in this pass, not trusted from the candidate)

| Layer | Pin |
|---|---|
| Gateway allow-lists | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c` `src/controllers/auth.ctrl.ts` |
| Gateway credential injection | same revision `src/routes/gw.route.ts` |
| OAuth-client service | `jiborobot/srv-oauth-clients-ws@3e546cb78eb160dcd3eaf25173420a35c56f68b5` |
| LPS service | `jiborobot/srv-lps-ws@e36e378a58cb66cfc577a554863de86360a82bb2` |
| Framework | `jiborobot/srv-server@master` (`parseCredentials.ts`, `validate.ts`, `errors.ts`; `joi ^10.5.2`) |
| SDK models | `jiborobot/srv-jibo-server-client@155d20a8` `apis/oauthclientsadmin-2017-11-08.normal.json`, `apis/lps-2017-12-01.normal.json` |

`pinned-source-extracts.json` holds the raw text of every file cited here so the
claims can be re-checked without the archive. `npm test` was run once, alone in this
worktree (no concurrent suite).

## Criterion 1 — five targets covered, source-derived permissions and side effects: **confirmed**

### Served at runtime (not just present in source)

`runtime-probe.mjs` boots a **real** `createAccountService` and a **real**
`createClassicEntrypoint`, points `NET_account` at the former, and drives every call
through the classic front door over HTTP (SigV4 sign → proxy → account dispatch). All
five targets are served; the classic router logs `matched: proxy` for each. Captured in
`runtime-probe.json`:

| call | result |
|---|---|
| `OauthClients_20171108.Create` (admin, signed) | 200, `{id, aco:{500,300,"1.0"}, clientId, redirectUri, updatedBy, refresh:true, created, updated}`, no `_id` |
| `OauthClients_20171108.ListClients` (admin) | 200 array of clients |
| `OauthClients_20171108.Update` (admin) | 200; `updated` bumped; missing id → **404 `CLIENT_NOT_FOUND`** |
| `OauthClients_20171108.Remove` (admin) | 200 removed row; **missing id → 200 empty body** |
| `Lps_20171201.NewCredentials` (robot) | 200 `{bucketName, bucketPath, credentials{AccessKeyId,Expiration,SecretAccessKey,SessionToken}, region}` |

### Two-layer auth — both layers checked against the pins

1. **Gateway (`auth.ctrl.ts`).** `unauthorizedMethods` has 20 entries; **none** is an
   `OauthClients_20171108.*` or `Lps_20171201.*` target. `unsignedMethods` is empty;
   `unactiveMethods` is `["Account_20151111.Remove"]`. `getCredentials()` returns `{}`
   only for a target in `unauthorizedMethods` with no `Authorization`; otherwise a
   missing header throws `MISSING_AUTH_HEADER` and the bare-access-key branch is dead
   because `unsignedMethods` is empty. **All five targets are therefore signed-only.**
   Runtime confirms: unsigned calls to all five → **401 `MISSING_AUTH_HEADER`**.
2. **Handler (`parseCredentials`).** The four OauthClients ops are
   `@parseCredentials({adminOnly:true})`; `NewCredentials` is `@parseCredentials({})`
   with a `friendlyId` check that throws `ROBOT_ONLY`. The decorator reads
   `request.headers["x-amz-credentials"]` — but that header is **not caller-controlled**:
   `gw.route.ts` overwrites it with `buildCredentials(request.auth.credentials)`, i.e. the
   *verified* account `{_id, id, email, accessKeyId, secretAccessKey, isAdmin, friendlyId}`.
   Phoenix resolves `caller` from the verified access key and gates on `caller.isAdmin` /
   `caller.friendlyId`, which is the faithful equivalent. Runtime confirms: non-admin
   signed → **401 `AUTHORIZED_UNDER_ADMIN`** (all four ops) and no row created; signed
   non-robot `NewCredentials` → **403 `ROBOT_ONLY`** exact message `Request forbidden. Only
   robotd are allowed.` (the source typo preserved).

Decorator order was re-derived: `@parseCredentials` is listed above `@validatePayload`,
so it is the outermost wrapper and runs **first** — the admin gate precedes payload
validation, as the candidate states.

### Claim-by-claim re-derivation (source wins over the report)

| Candidate claim | Pinned source | verdict |
|---|---|---|
| `CLIENT_ALREADY_EXISTS` 409, message `Specified client is already exists` | `errors/client.ts` | confirmed |
| `CLIENT_NOT_FOUND` 404, message `Specified client is not found` | `errors/client.ts` | confirmed |
| `AUTHORIZED_UNDER_ADMIN` 401, `Must be authorized under admin account` | `srv-server errors.ts` | confirmed |
| `ROBOT_ONLY` 403, `Request forbidden. Only robotd are allowed.` | `errors/lps.ts` | confirmed |
| `aco` defaults 500 / 300 / `"1.0"`, `refresh` true, `created` now, pre-save `updated` | `schemes/client.ts` | confirmed |
| `toJSON`: `id=_id`, `aco||{}`, drop `_id` | `schemes/client.ts` | confirmed |
| create dup → 409; `aco.sourceId` falls back to `clientId`; update `findById` → 404; defined-only assign; `sourceId` fallback; remove `findByIdAndRemove` (null, no throw); list `find()` | `controllers/client.ctrl.ts` | confirmed |
| `bucketPath` uses **0-based `getMonth()`** | `sts.ctrl.ts` line 26 | confirmed (Root's finding reproduced) |
| `assumeRole` `ExternalId`/`RoleSessionName` = `${friendlyId}_${accountId}`, `RoleArn` = `config.server.lps.robotRole`; response shape | `sts.ctrl.ts`, `lps-ws index.ts` | confirmed |
| No event side effect (EventSender constructed, `create()` sends nothing) | `oauth-clients index.ts` + `client.ctrl.ts` | confirmed (read-only) |

`lps-provider-probe.mjs` re-checks the template with a fixed clock
(`2025-03-15` → `month=2`) and the configured-provider wire shape; `lps-provider.json`.
Unconfigured provider → `LPS_STS_UNAVAILABLE` 503, never a silent fake credential.

### Candidate divergence #1 — empty-string 422 message (report wrong, source wins)

The candidate claims it "produced the exact Joi messages by executing the pinned-period
Joi". I executed `joi@10.5.2` (the `^10.5.2` srv-server pin) against both handler schemas
(`joi-replay.json`) and drove the real Phoenix face for the same inputs
(`joi-message-phoenix.json`). Every error Joi emits is wrapped as
`child "X" fails because [ ... ]`, **including** `is not allowed to be empty`:

| input | pinned Joi 10.5.2 | Phoenix |
|---|---|---|
| missing `updatedBy` | `child "updatedBy" fails because ["updatedBy" is required]` | same ✅ |
| `pkce:"yes"` | `child "pkce" fails because ["pkce" must be a boolean]` | same ✅ |
| `aco:[]` | `child "aco" fails because ["aco" must be an object]` | same ✅ |
| **`clientId:""`** | `child "clientId" fails because ["clientId" is not allowed to be empty]` | `child "clientId" is not allowed to be empty` ❌ |
| **`secret:""`** (optional) | `child "secret" fails because ["secret" is not allowed to be empty]` | `child "secret" is not allowed to be empty` ❌ |
| **`redirectUri:""` (Update, optional)** | `child "redirectUri" fails because ["redirectUri" is not allowed to be empty]` | `child "redirectUri" is not allowed to be empty` ❌ |

`packages/account/src/oauthClients.js` `requiredStringMessage`/`optionalStringMessage`
drop the `fails because [...]` wrapper on the empty branch only. Note the sibling helper
in `robotFace.js` (`requiredStringValidationMessage`, line ~670) emits the wrapper
correctly, so this is a local inconsistency, not a project convention. Non-empty-field
messages and the 422 status/envelope are correct. Reported, not repaired (root owns
divergence classification).

## Criterion 3 — operation-by-operation coverage, no unassigned required surface: **confirmed**

From `docs/parity/candidates/A-01-operation-map.json` (169 rows; validator re-run:
`169 rows; current=134 historical=35`):

- **Unassigned rows: 0.** Every row has a `task.id`; every task `state` is `existing`.
- The five A-18 rows are exactly the OAuth-client admin family and LPS (verified by
  `wireTarget`): `OauthClients_20171108.{Create,ListClients,Update,Remove}`,
  `Lps_20171201.NewCredentials` — all served per criterion 1.
- The A-01 map has **26 target prefixes**; the pinned SDK inventory
  (`classic-api-inventory.json`, sha256 re-checked against the map's recorded hash
  `43735051…`) has **134 wire targets across 26 files**. The two sets are a **bijection**:
  0 inventory wire targets absent from the map, 0 current map targets absent from the
  inventory. The candidate's "0 API prefixes not in map" holds.
- The only map prefixes with **no** API file are the three historical families already
  owned elsewhere: `Jot_*` → **A-19**, `VoiceTraining_*` → **A-20**,
  `Settings_20160801.GetSettings` → **A-06**. Not A-18 surface, and each has an owner.

Task distribution across the 169 rows (for the record): A-03 27, A-19 24, A-04 23,
A-15 11, A-20 10, A-17 9, A-11 9, A-07 9, A-08 8, A-12 7, **A-18 5**, A-14 5, A-05 5,
A-06 5, A-16 3, A-09 2, Q-01 2, A-10 2, A-13 2, A-02 1.

## Criterion 2 — newly discovered non-API-file services: **confirmed**

I searched the archive independently rather than repeating the candidate's finding.

- **`jiborobot/srv-app-toolkit-manager` exists.** It is a Koa web app (`web/` React SPA +
  `server/`), depends on `@jibo/jibo-server-client`, and has **no `apis/` entry**: it is a
  *consumer*, not a robot-facing service. Its `server/oauth.client.ts` calls **all four**
  `OauthClients_20171108.{ListClients,Create,Update,Remove}` against
  `http://${process.env.NET_oauthclients}` with `x-amz-credentials: {"isAdmin":true}`
  (`server/routes.ts` exposes `/api/clients`). So it is real, it exercises A-18's family,
  and it corroborates that `x-amz-credentials` is an internal trusted-caller convention.
- **`jiborobot/logparser` exists** (`jiborobot/logparser`, a Scala `sbt` project:
  `README` "retrieves logs from S3 cloud and populates the mongodb"). No API file, not
  robot-facing.

Both are listed in `CLASSIC-SERVICES.md` §"Not robot-facing (internal / web / admin /
integrations — low priority for revival)" with status ➖ — the candidate's citation is
accurate. Neither is a classic wire service, so neither is required surface for A-18, and
neither belongs in A-18's operation-by-operation coverage. **I agree with the judgement:**
they existed, they are out of A-18's scope, and they should be explicit child tasks rather
than silently assumed absent (the same pattern as A-19/A-20, which A-01 registered).

One honest gap: the candidate *proposed* them conditionally but did not register them
(only A-19/A-20 are in `registeredFunctionalTasks`). Registration is a root action
(`tasks.json` is root-owned), so I record the criterion as met in substance and propose
the two child tasks below.

## Falsification (highest-risk assertion)

The admin-only gate is the highest-risk claim: if it regressed, any signed account could
create/update/remove/list OAuth clients. I broke it directly in the merged source:

- **Broke:** `packages/account/src/oauthClients.js` — replaced the guard
  `if (!(caller && caller.isAdmin)) {` with `if (false) {`.
- **Failed:** `node --test packages/account/test/oauthClientsLps.test.js` →
  `not ok 6 - OauthClients_20171108 auth: non-admin rejected…`,
  `AssertionError: expected 401, actual 200` (`ERR_ASSERTION`), 11 pass / 1 fail.
  The non-admin Create was accepted and would have written a row.
- **Restored:** `git status --porcelain` on the file is empty (byte-identical restore);
  re-run is 12/12 pass.

So the admin-gate assertion is not vacuous. `falsification-failure.txt` holds the raw
failure.

## `npm test` (full, run alone)

```
# tests 1139
# pass 1132
# fail 0
# cancelled 0
# skipped 7
# todo 0
```

`parity:check`: tracker valid; checklist 15/79 verified (19.0%), classic 5/20.
`parity:gate`: `{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.

The candidate's stated "1019 tests / 1012 pass" is stale (other tasks merged after it);
the counts above are this run on current `main`. No `cancelledByParent` flakiness was seen.

## Candidate divergence #2 — A-01 map note text (documentation)

The `Lps_20171201.NewCredentials` row's `authenticationMode.gateway.note` reads
*"this target is absent from unauthorizedMethods (unsigned call allowed)"*. The pinned
gateway does the opposite: absence from `unauthorizedMethods` + no `Authorization` →
`MISSING_AUTH_HEADER`, i.e. unsigned is **rejected** (the `OauthClients` rows in the same
map say this correctly). The row's operative conclusion — "AWS4 signature is required" —
is right, so this is a misleading gloss in A-01's map, not an implementation defect.

## Unknowns retained

- `Remove` with a missing id: source `findByIdAndRemove` returns `null`; Phoenix returns
  empty 200. The original Hapi serialization of a `null` handler result was not executed.
- Real AWS STS `assumeRole` (no live AWS); the seam is implemented and tested with a fake.
- `EventSender` no-event side effect — read from source, never fired against SNS.
- Deployed gateway revision/route alias and the exact Hapi/Boom envelope were not
  replayed; all checks are against the pinned source revisions above.

## Reproduce

```bash
node docs/parity/evidence/2026-09-10/a18-oauth-lps/runtime-probe.mjs
node docs/parity/evidence/2026-09-10/a18-oauth-lps/lps-provider-probe.mjs
node docs/parity/evidence/2026-09-10/a18-oauth-lps/joi-message-probe.mjs
node --test packages/account/test/oauthClientsLps.test.js
npm test
# pinned Joi 10.5.2 replay: npm i joi@10.5.2 then run the schemas in joi-replay.json
```
