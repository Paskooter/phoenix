# A-03 candidate: Account Search and Remove

Status: **candidate; unverified pending root review.** This implements
`Account_20151111.Search` and `Account_20151111.Remove` only. It does not
close A-03 and does not implement access tokens, photos, or Facebook.

Base revision: `8795d10`. Candidate revision:
`80f2e10c252110198105d129be9210abd81e7da1`. Task id:
`a03-search-remove-20260909`.

## Source contract

Pins actually read through the Jibo archive MCP (`gitea_read_file`,
`repo: "jiborobot/srv-account-ws"`, `ref: "6cea434"`), not original-runtime
execution:

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Account handler | `src/handlers/account.handler.ts` (read in order; decorator-above-method) |
| Account controller | `src/controllers/account.ctrl.ts` (`search`, `removeById`, `getAuthorizedMembership`) |
| Loop controller | `src/controllers/loop.ctrl.ts` (`clearAssociated`, `_remove`, `clearMember`, `listOwnerLoops`, `listAccepted`) |
| Account schema | `src/schemes/account.ts` (`toJSON` transform) |
| Loop schema | `src/schemes/loop.ts` (`pre("find")` excludes `isDeleted: true`) |
| Account errors | `src/errors/account.ts` (`OWNER_CAN_REMOVE`, `OWNER_CAN_MANIPULATE`) |
| Loop errors | `src/errors/loop.ts` (`LOOPS_MUST_BE_SUSPENDED`) |
| Regex escape | `escape-regexp@0.0.1` (regex escape, not HTML) |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c` `auth.ctrl.ts` |

Decorator order actually read:

- `Search`: only `@validatePayload({ query: Joi.string().required() })`. No
  `@parseCredentials`. The following method is `ResetKeys`.
- `Remove`: `@parseCredentials({})` then `@validatePayload({ id: Joi.string() })`
  (id optional). The following method is `ChangePassword`.

Gateway lists actually read:

- `unauthorizedMethods` does **not** include `Account_20151111.Search`.
  Search therefore requires a signature on the public face even though the
  Account-ws handler does not read credentials.
- `unactiveMethods` is only `Account_20151111.Remove`.

## Candidate behavior

`packages/account/src/accountIdentity.js` now handles `search` and `remove`.
`robotFace.js` passes the existing `loopUpdatedOutbox` into that dispatcher so
Remove can call the Loop seam. Unimplemented Account operations still return
`UnknownOperationException`.

The two tests that used `Account.Remove` as the "genuinely unimplemented"
control (`accountIdentity.test.js`, `accountActivationRecovery.test.js`) now
target `Account_20151111.CreateAccessToken`. That operation is still absent
from `OPS` in this worktree (owned by a different A-03 agent: access tokens).
`ResetKeys` / `UpdatePhoto` / `RemovePhoto` / `GetAccountByAccessToken` are
also still unimplemented; `CreateAccessToken` was chosen because it is a real
`Account_20151111` mapping entry and is not in this slice.

### Search

- Joi: `query` required non-empty string.
- Auth: not in `ACCOUNT_ANONYMOUS_TARGETS`. Unsigned → `MISSING_AUTH_HEADER`.
  A supplied signature is verified. Inactive signer → `ACCOUNT_NOT_ACTIVE`.
  The controller does not use the signed identity.
- Query: `new RegExp(escapeRegexp(query), "i")` with `escape-regexp@0.0.1`
  (`/([.*+?=^!:${}()|[\]\/\\])/g`).
- Match: `lastName` OR `firstName` OR `email`. Missing/null fields do not
  match. `friendlyId` is not searched.
- Filter: `isDeleted !== true` (matches source `$ne: true`, including a
  missing `isDeleted`).
- Projection: **safe**. Source handler returns `Account.find(...)` without
  `toJSON({ unsafe: true })`, so JSON serialization uses the schema transform
  that deletes `password`, `activationCode`, `passwordResetCode`, and (without
  `unsafe`) `accessKeyId` / `secretAccessKey`. Phoenix uses
  `accountToSourceJson(..., { unsafe: false })`. Focused tests assert those
  secrets are absent on the wire and still present on the stored row.

### Remove

Two modes, matching `removeById(ownerId, accountId)`:

1. **No `id`**: caller removes **itself**.
2. **With `id`**: `getAuthorizedMembership(caller, id)` then `findById(id)`.
   If the target has a truthy `email`, throw `OWNER_CAN_REMOVE` (401,
   "Owner can only remove accounts with no associated e-mail"). Then
   `ownerId = accountId`. Membership is accepted outgoing members of loops
   the caller can list, or the caller themselves, or `isAdmin`.

Order actually implemented, matching source:

1. Copy the target and set `isDeleted = true` on the copy (live store row
   unchanged).
2. `clearAssociated(ownerId)` — this is the **reassigned** id in mode 2.
3. `persistAccount` (the source `save()`).

If `clearAssociated` throws, the account row is not persisted. Source
saves each loop immediately inside `clearAssociated`, so a later throw
leaves those loop writes in place. Phoenix matches that: it does **not**
roll loops back.

`passwordResetCode` is not cleared (DIVERGENCES **A1**). No extra fields
are wiped.

### clearAssociated (Loop seam)

Source:

```
listOwnerLoops(accountId)           // Loop.find({ owner }) + find middleware
if any !isSuspended → LOOPS_MUST_BE_SUSPENDED 409
for each owned loop: _remove({ loopId, isAdmin: true })
Loop.find({ "members.accountId": accountId })
for each: clearMember({ loopId, accountId })
```

Phoenix calls, without modifying `loopMembership.js` / `loopUpdatedOutbox.js`:

- Owned loops: exported `removeLoop(store, { ownerId: accountId, loopId }, loopUpdatedOutbox)`.
  Source `_remove` uses `isAdmin: true`; for loops from `listOwnerLoops` the
  owner check is equivalent.
- Other loops still listing the account: local `clearMember` that
  **hard-filters** `members` by `accountId` (source `clearMember`), not
  `removeMember` (which would set `status: removed` and is a different
  operation).

Loop `pre("find")` excludes `isDeleted: true`, so just-removed owned loops
do not appear in the second query.

## Observed Remove side effects (Phoenix runtime here)

Synthetic fixtures only. Commands:
`node --test packages/account/test/accountSearchRemove.test.js`

### Mode 1 — self-remove, no `id`

- Unsuspended owned loop → `LOOPS_MUST_BE_SUSPENDED` 409. Account row
  unchanged. Owned loop unchanged. Host-loop membership unchanged.
- After `isSuspended = true`: caller `isDeleted: true`. `passwordResetCode`
  still `'pre-delete-code'`. Email/password/keys still on the stored row.
  Owned loop `isDeleted: true`, `robot` cleared. Host loop (caller was an
  accepted member of someone else's loop) **kept**; the caller's member
  subdocument was **removed from the array**, not marked `removed`. Host
  owner account and robot account rows were not deleted.
- Survives store reopen.

### Mode 2 — `id` of an emailless dependent on the caller's unsuspended loop

- Caller with email, passing own `id` → `OWNER_CAN_REMOVE`. Caller not deleted.
- Stranger / unauthorized `id` → `OWNER_CAN_MANIPULATE`.
- Emailed accepted member of the caller's loop → `OWNER_CAN_REMOVE`. Loop not
  deleted.
- Emailless dependent: target `isDeleted: true`. **Caller not deleted.**
  Caller's loop **not** deleted (reassignment used the dependent's id, so
  `clearAssociated` did not demand the caller's loop be suspended). Dependent
  member row hard-filtered off that loop. Stranger account untouched.
- Admin can remove an emailless account with no loop membership.
- Inactive account can self-remove (`unactiveMethods`).

No test observed writes to a third account that was not the target, a robot
row, or an unrelated loop beyond the membership filter above.

## Evidence

Focused:

```
node --test packages/account/test/accountSearchRemove.test.js
```

Result: 12 pass / 0 fail. Receipt:
`.parity/reviews/a03-search-remove-20260909/focused.stdout`.

`npm test` from the worktree root at candidate
`80f2e10c252110198105d129be9210abd81e7da1`:

```
# tests 991
# pass 984
# fail 0
# skipped 7
# todo 0
```

`parity:check` reported a valid tracker. `parity:gate` reported
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
Full transcript: `.parity/reviews/a03-search-remove-20260909/npm-test.stdout`.

Baseline at `8795d10` was 979 tests / 972 pass / 0 fail / 7 skip. This run
adds the 12 Search/Remove tests (991 total). Zero failures. Skip count 7 is
the known worktree path artifact in
`scripts/nlu-compiled-graphs-install.test.mjs`, not a product change.

## What was verified against pinned source or a Phoenix runtime here

- Handler/controller/error/schema/gateway text at the pins above (archive
  read).
- Phoenix HTTP: Search match/exclude/escape/projection/auth; Remove both
  modes; loop suspend gate; membership reassignment; A1 `passwordResetCode`
  retention; Classic proxy; Joi 422; inactive Remove allowed; inactive
  Search blocked.
- `npm test` 991/984/0/7 and the 43-case smoke gate at this revision.

## Inferred from source reading (not original runtime)

- Mongoose `JSON.stringify` of `Account.find()` documents uses `toJSON`
  without `unsafe`, so Search/Remove responses are the safe projection.
- `Loop.find` / `findById` honor `pre("find"|"findOne")` `isDeleted $ne true`.
- `escape-regexp@0.0.1` character class (package source, not a Node 8
  require of the original service).
- `clearMember` hard-filter vs `RemoveLoopMember` status write.
- Gateway `unauthorizedMethods` / `unactiveMethods` vs handler
  `@parseCredentials` split for Search.

## Still unknown / not claimed

- Original Node 8 / `@jibo/server` 4.0.12 handler execution and exact Joi 10
  messages for every primitive were not replayed.
- Mongo `$or` result order vs Phoenix `Map` insertion order.
- Mongoose `updated` Date ISO / `__v` on Account JSON vs Phoenix numeric
  `updated` and omitted `__v` (same remaining gate as identity-core).
- Whether any original client called Search, and whether any consumer
  depended on Search returning keys (source transform says no).
- `AccountUpdated` SNS on the account `save()` after Remove is not
  implemented (same as other identity writes).
- No original `@jibo/jibo-server-client` Node 8 run and no live robot/family.
- `verifySigV4` in `@phoenix/common` still always rejects inactive
  credentials; Remove's exception is local to `authenticatePublicAccount`.

## Candidate divergences for root (not classified here)

1. **Search is a signed, unscoped directory of every non-deleted account**
   matching name or email. The handler never checks loop membership. Source
   does this. Report, do not "fix".
2. **`clearMember` deletes the member subdocument** rather than setting
   `status: removed`. Source does this. Different from `RemoveLoopMember`.
3. **A robot account has no email**, so an authorized/admin caller can
   `Remove` it under the emailless rule. Source `if (account.email)` is
   the whole guard.
4. **Passing your own `id` when you have an email is `OWNER_CAN_REMOVE`.**
   Self-delete is the omitted-`id` path only.
5. **`passwordResetCode` survives Remove** — already classified as A1;
   this slice does not change it.
6. After `_remove`, source Loop `post("save")` still emits `LoopUpdated`
   with `robot: undefined`. Phoenix `removeLoop` → outbox `record` follows
   existing **L1** (no outbox row without a robot). Not newly invented here.

## Explicitly unchanged

- `CreateAccessToken` / `GetAccountByAccessToken` / `ResetKeys` remain
  unimplemented.
- `UpdatePhoto` / `RemovePhoto` remain unimplemented.
- `packages/account/src/loopMembership.js` and `loopUpdatedOutbox.js` were
  not modified.
- Portal `/api/signup` and `/api/login` remain the Phoenix cookie face.
- A-03 is not marked verified.
