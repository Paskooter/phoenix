# D-02 certification pass (wave 7) — credential CRUD, uniqueness and durable storage

**Date:** 2026-09-10
**Task:** D-02 (track pegasus, P0, `implementation: partial`)
**Worktree:** `.parity/worktrees/w7-d02` (branch `w7/d02`, base `e525894`)
**Result:** all three recorded divergences addressed; one **new, unrecorded** parity gap found and closed.
`recommend_verified: true` — root decides.

Pinned source for every `file:line` below
(`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`):

- `packages/lasso/src/credential/Credentials.ts`
- `packages/lasso/src/credential/CredentialRequestsHandler.ts`
- `packages/lasso/src/mongo/StoredCredential.ts`
- `packages/lasso/tests/credential/Credential.test.ts`, `Credential.deletion.test.ts`
- Archive (Jibo MCP): `jiborobot/srv-settings-ws:src/clients/lasso.ts` (real Settings→Lasso client)

---

## 1. The contract, re-derived

| Operation | Pinned source | Wire envelope | Phoenix |
|---|---|---|---|
| `POST /v1/credential` | `CredentialRequestsHandler.ts:23-45` | `200 {created:true}` | `credentials.js` `credentialHandlers.post` |
| — duplicate `authCode` | `:36-39` (`MongoErrorCodes.DUPLICATE_KEY` = `11000`) | `200 {credentialExists:true}` | same |
| — validation error | `sendError` `:66-68` (default 400) | `400` plain text = `err.message` | same |
| `GET /v1/credential` | `:46-54` → `Credentials.checkCredentialExists:232-235` | `200 {credentialExists:<bool>}` / `400` | same |
| `DELETE /v1/credential` | `:55-63` → `Credentials.deleteCredential:242-265` | `200 {deleted:true}` / `400` | same |

Required fields (`Credentials.ts:35-42`, `:190-196`, `:243-248`): save needs
`accountId skillId serviceName serviceAccountName scopes clientId` plus `authCode` or the
token triple (`:44-47`); find the same minus `clientId`; delete the four ids only. Messages are
`Missing <p> in request` in array order, with `validateScopes` (`:283-293`) run inline for
`scopes` — presence before shape. `isActive` defaults `{ $ne: false }` on lookup
(`:204-206`); save uses `allowInactive` and reactivates + clears `error` (`:70-74`).
Wildcard delete: `skillId/serviceName/serviceAccountName` may be `'*'`, and `scopes` is
skipped when `scopes[0] === '*'` (`:252-263`).

## 2. What this pass changed

1. **Query-param scope handling (D-02c — see §3.3, closed).** `credentialQueryFromParams`
   now reproduces the shapes the reference's Express 4.16.2 / qs 6.5.1 parser produces, for
   every wire form the real clients use.
2. **Scope-overlap uniqueness (D-02b — see §3.2, closed).** `save` now refuses a new
   same-slot record whose scope list intersects an existing record's, matching Mongo's
   MULTIKEY `credentials_index`.
3. **D-02a** preserved (comparison, not reproduction) and now pinned by two extra fixtures that
   execute the source's own guard (§3.1).
4. Durability was re-proven by restarting the **deployed entrypoint** (§4).

## 3. The three recorded divergences, addressed explicitly

### 3.1 D-02a — the single-`=` assignment (RECOMMEND: keep Phoenix's comparison)

`Credentials.ts:143` reads, verbatim:

```ts
        if (newCredential.skillId = 'report-skill') {
```

That is an **assignment**: always truthy, and it rewrites `skillId` on the arriving document
*before* the `remove()` at `:145-150` reads it, so the delete query always carries
`skillId: 'report-skill'`.

Why this should stand as a divergence rather than be reproduced:

- It is **not pinned by any reference fixture.** The source's own suite
  (`Credential.deletion.test.ts:182-198`, "when skillId is not report-skill … Should NOT
  delete") passes *only by accident*: both credentials in that case are saved under the same
  non-report skill, so the remove query (`skillId:'report-skill'` after the assignment) matches
  nothing. The source test **asserts the comparison semantics**; the defect is blind to it.
- The observable consequence is data loss of a healthy credential. New fixture
  `D2 DIVERGENCE (D-02a): the source defect deletes an existing report-skill other-provider
  credential; Phoenix keeps it` executes the reference guard against a two-record map and
  shows the report-skill `google:workCalendar` row being deleted by a save from
  `some-other-skill`. Phoenix (`_deleteOther`, comparison) preserves it.
- Every *reference-pinned* deletion arm is unchanged and green: google↔outlook for
  `personalCalendar` and `workCalendar`, both directions, plus the three negative arms.

**Recommendation:** keep the comparison. Faithfulness would mean deliberately deleting a
valid credential whose only defect is belonging to the skill the whole feature exists for.
This is already recorded in `DIVERGENCES.md` (D-02a) and must stay labelled a fix, never parity.
The decision is root's; the fixtures fail loudly if anyone silently "restores" the source bug.

### 3.2 D-02b — scope-overlap uniqueness (GAP: closed)

`StoredCredential.ts:107-119` declares `unique: true` over
`(accountId, skillId, serviceName, serviceAccountName, scopes)`. `scopes` is an **array**, so
Mongoose/Mongo builds a **multikey** index — one index key per element. Two same-slot records
that share even one scope value therefore collide; `credential.save()` raises `E11000`, and
`CredentialRequestsHandler.ts:36-39` answers `200 {credentialExists:true}` with nothing stored.

Phoenix previously keyed the slot by the *sorted scope set*, so `['a']` and `['a','b']`
coexisted. Both observable consequences were wrong: an overlapping save answered
`{created:true}` (reference: `{credentialExists:true}`), and a later `find()` for the shared
scope matched two records and fell into the reference's own "critical bug" branch
(`Credentials.ts:221-226`) → `credentialExists:false` **for a scope that was stored**.

Closed by `_sharesScopeWithSlot`: on the insert path only (an update of a matched record reuses
its identity and cannot collide), if any record with the same four ids shares a scope value →
`DUPLICATE_KEY` → `200 {credentialExists:true}`. The original fixture that *does* exist
(`Credential.test.ts:128-161`, "other scopes": `calendar.readonly` then `calendar.readwrite`)
still passes — disjoint sets still coexist. The union of scope sets in a slot is unchanged for
every reference-reachable path, so this cannot reject anything the reference would accept; it
only removes states the reference cannot represent.

### 3.3 D-02c — scope query params (GAP: closed, and it was much larger than recorded)

The recorded note said "single (non-repeated) `scopes` query param … only the single-param form
differs; the repeated-param wire form agrees." That is **wrong**, and it matters.

Runtime probe of the running data service, **before** the fix
(`/tmp/d02-probe-forms.mjs`, seeded with one stored credential):

```
POST 200 {"created":true}
indexed        GET 400 Missing scopes in request      DELETE 200 {"deleted":true}
bracketed      GET 400 Missing scopes in request      DELETE 200 {"deleted":true}
bareOne        GET 200 {"credentialExists":false}     DELETE 200 {"deleted":true}
comma          GET 200 {"credentialExists":false}     DELETE 200 {"deleted":true}
```

- `scopes[0]=…&scopes[1]=…` is exactly what the real Settings→Lasso client sends:
  `jiborobot/srv-settings-ws:src/clients/lasso.ts` does
  `uri.searchParams.set(\`scopes[${i}]\`, scope)` on GET (`:38-40`) and DELETE (`:111-113`). **Verified from the archive
  via the Jibo MCP.** Phoenix's own Settings face is a port of it
  (`packages/account/src/settingsProviders.js:1307,1350`, pinned by
  `packages/account/test/settingsLassoNetwork.test.js:107`). So in the deployed stack, the
  Settings → Lasso GET answered **400 "Missing scopes in request"** and *no* credential could
  ever be reported as connected.
- `scopes[]=…` is what the pinned **axios 0.17.1** client serializes an array param to — the
  form the *original fixtures themselves* use (`Credential.test.ts:379,501`), so a
  file-faithful replay of the reference suite 400s on Phoenix.
- Express/qs parses both bracket forms into an array (verified by running the pinned
  `qs@6.5.1`), while a single plain `scopes=a` stays the **string** `'a'` →
  `validateScopes` → `400 "Scopes should be an array"` (the original D-02c note).

`credentialQueryFromParams` now returns the qs-shaped value:
indexed/bracketed/repeated → array (in index order); a lone plain value → the string itself, so
`validateScopes` produces the reference's exact 400; absent → `null` → `Missing scopes in
request`. `delete()` never calls `validateScopes` (scopes are optional there,
`Credentials.ts:243-248`), so a lone plain value is coerced to a one-element list and the
indexed form now *filters* deletions instead of being ignored.

## 4. Durability proved by actually restarting

`/tmp/d02-durability-probe.mjs` spawns the deployed entrypoint
(`node packages/data/src/index.js`, **no** store option, no `ETCO_data_credentialsFile` —
exactly `docker-compose.yml`'s command), `SIGKILL`s it, respawns, and reads back:

```json
{
 "create": { "status": 200, "body": { "created": true } },
 "duplicateAuthCode": { "credentialExists": true },
 "scopeOverlap": { "credentialExists": true },
 "disjointScope": { "created": true },
 "getBeforeRestart": { "status": 200, "body": "{\"credentialExists\":true}" },
 "getIndexedForm":   { "status": 200, "body": "{\"credentialExists\":true}" },
 "getSingleBareForm":{ "status": 400, "body": "Scopes should be an array" },
 "getMissingScopes": { "status": 400, "body": "Missing scopes in request" },
 "snapshotExists": true, "snapshotRecords": 2,
 "aliveAfterKill": false,
 "getAfterRestart":  { "status": 200, "body": "{\"credentialExists\":true}" },
 "deleteWrongScope": { "status": 200, "body": "{\"deleted\":true}" },
 "stillThere":       { "status": 200, "body": "{\"credentialExists\":true}" },
 "deleteWildcard":   { "status": 200, "body": "{\"deleted\":true}" },
 "getAfterDelete":   { "status": 200, "body": "{\"credentialExists\":false}" },
 "getAfterRestartPostDelete": { "status": 200, "body": "{\"credentialExists\":false}" },
 "getDisjointScopeAfterDelete": { "status": 200, "body": "{\"credentialExists\":false}" }
}
```

- A kill **and** a respawn are real (`aliveAfterKill:false`), and the record is still found by the
  new process — durability is observed, not asserted. Delete persists across a second restart.
- The DELETE with a non-matching `scopes[0]` removed nothing (`stillThere:true`), which only
  becomes true once the indexed form parses.
- The snapshot is the on-disk 2-record file at `packages/data/data/credentials.json`
  (git-ignored), written atomically (`wx` tmp + `rename`, 0600/0700).

## 5. Falsification (exact line, exact failures)

**Anchor (full code line), `packages/data/src/credentials.js:269`:**

```js
    if (indexed.length) {
```

**Broken to** `if (indexed.length > 1) {` — a single indexed scope (`scopes[0]=…`) stops parsing.
This is the exact line the new Settings-client hop depends on.

**Result — 7 of 49 failed**, three of them named for this gap:

```
not ok 29 - D2 uniqueness (D-02b CLOSED) over HTTP: an overlapping-scope save answers 200 {credentialExists:true}
not ok 35 - D2 HTTP: a credential persisted by one service instance is found by the next (restart)
not ok 36 - D2 credentialQueryFromParams reproduces the pinned qs shapes (D-02c CLOSED)
not ok 37 - D2 HTTP (D-02c CLOSED): a single bare scopes param is 400 "Scopes should be an array"; the indexed and bracketed client forms are 200
not ok 39 - D2 end-to-end (D-02c CLOSED): the Settings Lasso client resolves against the data service
not ok 40 - D2 HTTP: the DEFAULT store (createDataService with no store arg) survives a service restart
not ok 47 - POST/GET/DELETE /v1/credential
# tests 49  # pass 42  # fail 7
```

Failure detail for the three headline tests:

- `D2 credentialQueryFromParams reproduces the pinned qs shapes (D-02c CLOSED)` →
  `+ actual - expected`, `expected: ['a']`, `actual: null`
- `D2 HTTP (D-02c CLOSED) …` → `expected: 200`, `actual: 400`
- `D2 end-to-end (D-02c CLOSED): the Settings Lasso client resolves against the data service` →
  `error: 'Failed to get google personalCalendar credentials'` (the real client throws when the
  data service 400s)

**Restored** to `if (indexed.length) {` → the same two files: **49 tests, 49 pass, 0 fail**.

## 6. Test counts

| File | Before | After |
|---|---|---|
| `packages/data/test/credential-durable.test.js` | 35 | **40** |
| `packages/data/test/credential.test.js` | 9 | 9 |
| both files together | 44 | **49** |
| all `packages/data/test/*.test.js` | 66 | **89** |

Three pre-existing tests were **corrected, not deleted**: their GET/DELETE used a single bare
`scopes=…`, which the reference rejects — they now send the original fixtures' own wire form
(`scopes[]=`), so they assert reference-reachable behaviour.

## 7. Labels

**VERIFIED** (observed in this pass): the three served verbs and their envelopes at runtime; the
indexed/bracketed/repeated/single/absent scope-param matrix unit- and HTTP-level; the real
Settings client resolving against the real data service end to end; overlapping-scope saves
rejected at store and HTTP level with `{credentialExists:true}`; disjoint sets coexisting;
credentials and deletions surviving a real `SIGKILL` + respawn of the deployed entrypoint; the
D-02a source guard's truthiness and `skillId` mutation executed verbatim; the four
reference-pinned deletion arms plus negative arms; wildcard-delete scoping.

**INFERRED**: Mongo's multikey-index rejection itself (no Mongo runs here — the rule is derived
from `StoredCredential.ts:107-119` plus Mongoose multikey semantics, and reproduces the reference's
own `E11000` handling); Express 4's `'extended'` query parser wiring (read from the pinned
framework, not executed).

**UNKNOWN**: whether any consumer still needs the reference's `newCredential` event fan-out
(D-04); the reference's exact behaviour for `DELETE` with a lone plain `scopes` value (Mongo
`$all` with a scalar is an unobservable server-side error — Phoenix keeps its prior lenient
single-element behaviour); live Mongo enforcement.

## 8. Files changed

- `packages/data/src/credentials.js` — qs-shaped scope parsing (`scopesFromParams`,
  `INDEXED_SCOPES`), `_sharesScopeWithSlot` on the insert path, `delete` scope coercion, comments.
- `packages/data/test/credential-durable.test.js` — D-02b closed fixtures (store + HTTP), D-02c
  parser + HTTP + end-to-end Settings-client tests, two D-02a source-semantics fixtures, three
  pre-existing wire forms corrected to `scopes[]=`.
- `packages/data/test/credential.test.js` — wire form corrected to `scopes[]=`.

`docs/parity/tasks.json` and `DIVERGENCES.md` were **not** touched.
