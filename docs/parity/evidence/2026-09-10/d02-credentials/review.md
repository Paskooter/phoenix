# D-02 verification — credential CRUD, uniqueness and durable state

**Date:** 2026-09-10
**Task:** D-02 (P0, pegasus, `implementation: partial`) — independent re-derivation + gap closure
**Worktree:** `.parity/worktrees/w2-d02` (branch `w2/d02`)
**Result:** pass — recommend `verified`. One real parity gap was found and closed (durable state was
not wired into the running service); the assignment-bug divergence D-02a is preserved; two further
divergence candidates are reported below.

Pinned source for every reference citation below:
`packages/lasso/src/credential/Credentials.ts`, `packages/lasso/src/credential/CredentialRequestsHandler.ts`,
`packages/lasso/src/mongo/StoredCredential.ts`, `packages/lasso/tests/credential/{Credential,Credential.deletion}.test.ts`,
`packages/lasso/src/LassoService.ts`, `packages/utils/src/service/BaseService.ts`.
`Credentials.ts` is byte-identical at the two pins in play (5c0a739… and d682547a…):
sha256 `00ba610574744651118cad772d1328cc525f4d62a1fca880509a91818f106479`.

---

## 0. Correction to the candidate report (source vs candidate)

The candidate (`docs/parity/candidates/D-02-candidate-20260910.md`) claimed durability, but under a
qualifier the acceptance criterion does not allow:

> "With no file configured the store stays in-memory so existing tests remain hermetic; wiring a
> persisted store into the running service's default is a 1-line change in `packages/data/src/index.js`
> (root-owned per task file list)."

Re-derived and **the candidate is wrong to have shipped D-02 on that basis**:

- `createDataService()` defaults to `credentialStore = new CredentialStore()` (`packages/data/src/index.js:24`),
  and the deployed entrypoint is `node packages/data/src/index.js` (`docker-compose.yml:82`).
- Before this pass `CredentialStore` resolved `this.file` to `null` when no option/env was set, so the
  **running service was in-memory**. Restarting it lost every credential (**VERIFIED**, §4/§5).
- Acceptance criterion 2 ("Persist credentials with unique keys and atomic updates across restarts")
  therefore was **not** satisfied for the service the project actually runs.
- Fixed inside D-02's own file (`packages/data/src/credentials.js`), mirroring the account service's
  `Store` (`packages/account/src/store.js:16-18`): the store is durable by default at
  `packages/data/data/credentials.json`, overridable with `ETCO_data_credentialsFile`. `index.js`
  (D-01's file) was not touched.

Everything else the candidate asserted was re-checked against pinned source; the rest below is the
independent derivation.

---

## 1. Full credential surface (pinned source → Phoenix), **VERIFIED** unless marked

### Operations and their wire envelopes

| Op | Reference | Envelope | Phoenix | Status |
|---|---|---|---|---|
| `POST /v1/credential` | `CredentialRequestsHandler.ts:23-45` | `200 {created:true}` | `credentials.js:236-244` | VERIFIED (runtime) |
| — duplicate `authCode` | `:36-39` (`MongoErrorCodes.DUPLICATE_KEY` = `11000`, `mongo/interfaces.ts:2`) | `200 {credentialExists:true}` | `credentials.js:242-243` | VERIFIED (runtime) |
| — validation/other error | `sendError` `:66-68` (default 400) | `400` plain text = `err.message` | `credentials.js:243` | VERIFIED (runtime) |
| `GET /v1/credential` | `:46-54` → `Credentials.checkCredentialExists` `:232-235` | `200 {credentialExists:<bool>}` / `400` | `credentials.js:246-248` | VERIFIED (runtime) |
| `DELETE /v1/credential` | `:55-63` → `Credentials.deleteCredential` `:242-265` | `200 {deleted:true}` / `400` | `credentials.js:250-253` | VERIFIED (runtime) |

All three verbs are SERVED at runtime (observed over HTTP after restarting `node packages/data/src/index.js`,
and by `packages/data/test/credential-durable.test.js` / `credential.test.js`).

### Required fields (exact sets, order, messages)

- `save` (`Credentials.ts:35-42`): `accountId, skillId, serviceName, serviceAccountName, scopes, clientId`
  — in that order; then `:44-47` `Missing authCode or tokens (accessToken, refreshToken, expiresAt) in request`
  when neither `authCode` nor the full token triple is present.
- `find`/`checkExists` (`:190-196`): the same minus `clientId`; `delete` (`:243-248`): the four ids only.
- `requiredProperties` (`:272-281`) throws `Missing <p> in request` on the first falsy field and runs
  `validateScopes` inline for `scopes` (`:277-279`) — i.e. **presence before scope shape**.
- `validateScopes` (`:283-293`): non-array → `Scopes should be an array`; empty → `Scopes should be not empty array`;
  non-string element → `Scopes should be strings`.
- Phoenix reproduces the sets/order/messages (`credentials.js:26-27,46-55`) and the HTTP wire forms are
  asserted for **every** field on GET and DELETE (`credential-durable.test.js`, "exact 400 plain-text
  envelope…"). **VERIFIED.**

### Handler-level side behaviour

- `DEFAULT_GOOGLE_CLIENT_ID` (`'830717411721'`, `CredentialRequestsHandler.ts:10,26-28`): a POST with
  `skillId:'report-skill' && serviceName:'google' && !clientId` has `clientId` injected **before** validation,
  so it succeeds; any other skill with no `clientId` 400s. Phoenix: `credentials.js:237`. **VERIFIED**
  (runtime + test).
- `testAuthCode` (`Credentials.ts:14,160-165`) short-circuits the OAuth exchange with canonical tokens.
  **VERIFIED.**
- Unsupported `serviceName` on the authCode path → `Service is not supported by Lasso: <name>`
  (`:181-182`) → 400. **VERIFIED.**
- Real Google/Outlook token exchange is `501` in Phoenix (`credentials.js:167-170`), deliberately D-03's
  scope (documented in the file header). **INFERRED** as in-scope-elsewhere.
- `LassoService.ts:88-95` fans the `newCredential` event into the calendar handlers. Phoenix has no such
  event; the Phoenix calendar handler reads the credential store live (`index.js:51-52`). Whether any
  calendar-side invalidation is still needed is **UNKNOWN** and belongs to D-04.

---

## 2. Uniqueness semantics — what collides, what is allowed, the wire error

Reference index: `StoredCredential.ts:107-119`, `unique: true` on
`(accountId, skillId, serviceName, serviceAccountName, scopes)`. On an **array** field Mongo builds a
**multikey** index (one key per element), and the index is created eagerly (`:188-207`, `autoIndex:true`).

Runtime probe of the running service (`/tmp/probe-uniqueness.mjs`, agent-local), **VERIFIED** for Phoenix:

| Action (same `accountId/skillId/serviceName/serviceAccountName`) | Phoenix wire | Phoenix records |
|---|---|---|
| same scopes `['a']`, token save, again | `200 {created:true}` ×2 | 1 (updated) |
| `['a']` then `['a','b']` (shares `a`) | `200 {created:true}` ×2 | **2** |
| `['a','b']` then `['b','c']` (shares `b`) | `200 {created:true}` ×2 | **3** |
| `['x','y']` (disjoint) | `200 {created:true}` | 4 |
| same `authCode` again (`testAuthCode`) | `200 {credentialExists:true}` | — |

- **The collision the reference enforces** is "two same-slot credentials that share ≥1 scope value":
  the second `credential.save()` raises `E11000`, the handler maps it to `200 {credentialExists:true}`.
  Its `find()` can therefore never match >1 record.
- **Phoenix** keys the slot by the *sorted scope set* (`credentials.js:48`), so overlapping-but-unequal
  scope sets **coexist**. A `find()` for a shared scope then matches >1 record and hits the reference's
  own "critical bug" branch (`Credentials.ts:221-226` → implicit `undefined`), so
  `checkExists` returns `{credentialExists:false}`. Observed: the service logs
  `Credentials query … returned more than one result` and the GET answers `credentialExists:false`.
  Pinned by the new test `D2 DIVERGENCE (scope-overlap uniqueness) …`.
- `find` scope matching is `scopes: {$all: query.scopes}` (`Credentials.ts:202`; superset match, order-insensitive)
  — Phoenix `credentials.js:112-128`. **VERIFIED.**
- Duplicate `authCode` for the same slot → `DUPLICATE_KEY` → `200 {credentialExists:true}`; a **new**
  `authCode` replaces the oauth2 payload; different scopes coexist. Original fixtures; **VERIFIED.**
- Wildcard delete (`deleteCredential:249-264`): `skillId/serviceName/serviceAccountName` may be `'*'`;
  `scopes` are skipped when `scopes[0] === '*'`; scoping is per-`accountId`
  (`path set` on the always-present `accountId: query.accountId`). Phoenix `credentials.js:200-212`.
  **VERIFIED** (account1 unaffected by account2's wildcard delete).
- Cross-provider replacement: see §3.

**Scope-overlap uniqueness → divergence candidate D-02b** (reference side INFERRED from Mongo multikey
index semantics; Phoenix side VERIFIED at runtime). No original fixture saves overlapping scope sets, so
neither behaviour is pinned by the reference.

---

## 3. `deleteOtherCredentials` — divergence D-02a (preserved, not re-labelled)

Pinned `Credentials.ts:142-153`:

```ts
142    static async deleteOtherCredentials(newCredential: IStoredCredential){
143        if (newCredential.skillId = 'report-skill') {        // SINGLE '=' — assignment
144            if (['workCalendar', 'personalCalendar'].includes(newCredential.serviceAccountName)) {
145                await Credentials.StoredCredential.remove({
146                    accountId: newCredential.accountId,
147                    skillId: newCredential.skillId,           // 'report-skill' after the write
148                    serviceName: { $ne: newCredential.serviceName },
149                    serviceAccountName: newCredential.serviceAccountName
```

- The `=` makes the guard always-truthy **and** overwrites `skillId`, so the delete targets
  `skillId:'report-skill'` on **every** save with a calendar `serviceAccountName`.
- Phoenix keeps the deliberate **comparison** (`credentials.js:189`) and is **not** changed to reproduce
  the bug — divergence **D-02a**, recorded in `DIVERGENCES.md:124` and in the file comment
  (`credentials.js:179-187`). **Preserved.**
- Pinned by the regression fixture
  `D2 REGRESSION FIXTURE: a NON-report-skill save does NOT trigger cross-provider deletion …`.
- The original deletion suite (`Credential.deletion.test.ts`) still passes against the buggy reference
  only because its "non-report-skill" and "someOtherCalendar" cases save **both** credentials under the
  same non-report skill, so the reference's delete query (`skillId:'report-skill'`) matches nothing.
  All 8 cases are ported: 2 per calendar/calendar pair + 3 report-skill pairs + 2 negative.
  **VERIFIED** (tests).

---

## 4. Durability — demonstrated by ACTUALLY RESTARTING the service

The instruction (and a sibling task's failure) is explicit: a write call is not persistence. So the
deployed entrypoint was started, killed, and started again.

Probe (`/tmp/probe-d02.mjs`), spawns `node packages/data/src/index.js` with **no** store option and **no**
`ETCO_data_credentialsFile` (exactly as `docker-compose.yml:82` runs it), POSTs a `testAuthCode` credential,
`SIGKILL`s the process, respawns, and re-reads.

**Before the fix (in-memory default):**

```json
{"post":{"status":200,"body":{"created":true}},
 "getBeforeRestart":{"credentialExists":true},
 "getAfterRestart":{"credentialExists":false}}
```

**After the fix (durable-by-default):**

```json
{"post":{"status":200,"body":{"created":true}},
 "getBeforeRestart":{"credentialExists":true},
 "getAfterRestart":{"credentialExists":true}}
```

- Snapshot written to `packages/data/data/credentials.json`, mode `600`, dir `700`,
  `git check-ignore` → `packages/data/data/.gitignore:1:credentials.json*`. **VERIFIED.**
- Contents are the real record (`accountId/skillId/serviceName/serviceAccountName/scopes/isActive/createdAt/oauth2{…}`);
  retrieving it after restart exercises `_load()` (`credentials.js:71-84`), not a live Map. **VERIFIED.**
- DELETE also persists (test "…found by the next (restart)": delete → new store → `credentialExists:false`). **VERIFIED.**
- The in-suite e2e `D2 HTTP: the DEFAULT store (createDataService with no store arg) survives a service
  restart` proves the same path without the manual process dance. **VERIFIED.**
- "Atomic" = exclusive `wx` tmp + `rename` (`credentials.js:87-103`); a rename over a directory is made to
  fail and the previously committed bytes are asserted unchanged, with no tmp litter. **VERIFIED.**

Deployment caveat (**INFERRED**): the compose `lasso` service mounts `./packages:/phoenix/packages`, so the
snapshot lands on the host mount and survives container restarts; there is no dedicated named volume like
the account service has. If the host tree is rebuilt the file is lost. `/health`-level backup is out of scope.

---

## 5. Old test count vs new (source of the +5)

| File | Before | After |
|---|---|---|
| `packages/data/test/credential-durable.test.js` | 30 | **35** |
| `packages/data/test/credential.test.js` | 9 | 9 |
| all `packages/data/test/*.test.js` | 61 | **66** |

New tests: `D2 HTTP: exact 400 plain-text envelope for every required GET/DELETE field`;
`D2 HTTP: an unsupported serviceName …`; `D2 HTTP: report-skill + google with no clientId gets the default
clientId; a non-report skill 400s`; `D2 HTTP: the DEFAULT store … survives a service restart`;
`D2 DIVERGENCE (scope-overlap uniqueness) …`. Three pre-existing tests now share nothing through the
default path because the store is no longer a global in-memory singleton — `credential-durable.test.js`
scopes every bare store to its own file, and `credential.test.js` sets a per-suite temp `ETCO_data_credentialsFile`.

---

## 6. Falsification (required)

**Target:** durability across a restart — the exact class of claim a sibling got wrong.

**Corruption** (full code line, `packages/data/src/credentials.js:89`), making the flush still write a
file but persist nothing — the "looks durable" trap:

```diff
-    const serialized = JSON.stringify([...this.m.values()], null, 2);
+    const serialized = JSON.stringify([], null, 2);
```

**Result — the relevant tests failed (7 of 35):**

```
not ok 20 - D2 credentials survive store restart; delete survives restart too
not ok 21 - D2 unique 5-tuple keys are enforced across a reload; scopes are part of the key
not ok 22 - D2 atomic flush: 0600 file, 0700 dir, no tmp litter, failed rename keeps committed bytes
not ok 23 - D2 ETCO_data_credentialsFile env var gives default-resolved stores a durable file
not ok 24 - D2 with no env configured the default store is durable at the package data path; a path string is honored
not ok 32 - D2 HTTP: a credential persisted by one service instance is found by the next (restart)
not ok 35 - D2 HTTP: the DEFAULT store (createDataService with no store arg) survives a service restart
# tests 35  # pass 28  # fail 7
```

**Restore:** line reverted to `JSON.stringify([...this.m.values()], null, 2)`; re-ran the two credential
files → **44 tests, 44 pass, 0 fail**. The tests genuinely exercise persistence.

---

## 7. Divergence candidates (report-to-root; NOT edited into `DIVERGENCES.md`)

| id | Divergence | Reference side | Phoenix side | Impact |
|---|---|---|---|---|
| **D-02a** (already recorded `DIVERGENCES.md:124`) | cross-provider delete guard | `Credentials.ts:143` single `=` → fires for every skill | `credentials.js:189` `===` → fires only for `report-skill` | deliberate fix; pinned by regression fixture; **preserved** |
| **D-02b** | same-slot scope-overlap uniqueness | Mongo multikey unique index (`StoredCredential.ts:107-119`) rejects records sharing a scope value → `200 {credentialExists:true}` (INFERRED) | sorted-scope-set key lets them coexist, and a shared-scope GET multi-matches → `credentialExists:false` (VERIFIED runtime) | no original fixture; a client that saves overlapping scope sets for one slot sees `created:true` (ref: `credentialExists:true`) and later a false-negative GET |
| **D-02c** | single `scopes` query param | Express 4 default `'extended'` (qs) yields a **string** → `validateScopes` → `400 "Scopes should be an array"` (INFERRED: `BaseService.ts:51` + `express ^4.16.2`) | `getAll('scopes')` yields `['read']` → treated as a 1-element array → `200 {credentialExists:…}` (VERIFIED runtime) | only for a single param; repeated params (the form the original tests/clients send) agree; `a,b` stays one literal in both |

`DIVERGENCES.md` and `docs/parity/tasks.json` were **not** touched.

---

## 8. Test run and parity gate

One full `npm test` in this worktree, no cancellations (`# cancelled 0`):

```
1..1082
# tests 1144
# suites 7
# pass 1137
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 48239.315306
```

```
Checklist: 16/79 verified (20.3%)
Tracker structure, dependencies, evidence links and generated checklist are valid.

Strict production smoke gate (43 cases; full corpus remains separately tracked).
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

## 9. Labels

- **VERIFIED** (observed in this pass): the three served verbs + envelope bytes; every required-field
  400 message on POST/GET/DELETE; duplicate-authCode → `{credentialExists:true}`; default-clientId
  injection and its non-report-skill 400; unsupported-service 400; `$all` scope lookup (order/fewer/more/
  non-matching); same-slot scope coexistence; wildcard-delete scoping; all cross-provider delete cases;
  **credentials survive an actual process restart**; atomic 600/700 write, delete-persists, corrupt-file
  loud failure; the D-02a regression fixture; the D-02b false-negative GET; the single-param behaviour on
  the Phoenix side.
- **INFERRED** (source-reasoned, not executed): Mongo multikey-index rejection and its `{credentialExists:true}`
  wire result; Express 4 qs string parsing on the reference side; real Google/Outlook exchange belongs to D-03;
  compose host-mount durability of the snapshot.
- **UNKNOWN**: whether any consumer still needs the reference's `newCredential` event fan-out (D-04);
  whether a single-`scopes`-param GET is ever sent by a real client; live Mongo enforcement (no Mongo runs here).

## 10. Files changed

- `packages/data/src/credentials.js` — durable-by-default store path; uniqueness/persistence comment update.
- `packages/data/data/.gitignore` — new; ignores `credentials.json*` (mirrors `packages/account/data/.gitignore`).
- `packages/data/test/credential-durable.test.js` — isolated per-store files; 5 new tests; env/default assertions.
- `packages/data/test/credential.test.js` — hermetic temp store env.
