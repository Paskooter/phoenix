# A-04 — Complete Loop operations and membership lifecycle

**Verified 2026-09-10.** Reference `srv-account-ws@6cea434`, SDK
`srv-jibo-server-client@155d20a`, Phoenix at the commit carrying this file.

Suite at verification: **1074 tests, 1066 pass, 0 fail, 0 cancelled, 8 skipped**,
production gate `{"result":"match","cases":43,"differences":0,"invariants":0,"coverageGaps":0}`,
`EXIT=0`.

---

## Criterion 1 — all 23 Loop wire operations

`docs/parity/evidence/2026-09-10/a04-loop-operations/coverage.json`:
23 expected / 23 mapped / 23 implemented / 23 tested / 0 problems.

Two traps had to be cleared to get an honest count.

**The API file's `key` and `wireName` differ for ten operations.** `Create`
ships as `CreateLoop`, `List` as `ListLoops`, and so on. Coverage is asserted
against the 23 **wire names**, which are what a client actually sends.

**Static scanning under-reports dispatch.** Loop dispatch compares lowercased
operation names across four modules (`handleLoopMembership`,
`handleMemberPhotos`, `handleLoopAgreements`, `handleRobotLookup`), so the first
detector found 1 of 23. Replaced with a runtime probe
(`.parity/reviews/a04-loop-probe-20260910/probe.mjs`, published as
`loop-probe.json`): **23/23 served**. The 422s in that capture are Joi
validation of synthetic bodies, and `AUTHORIZED_UNDER_ADMIN` /
`AGREEMENT_NOT_FOUND` are genuine handler responses — all three prove the
operation is routed, not missing.

`RemoveMemberPhoto` was noted mid-review as untested. That was wrong:
`packages/account/test/loopPhotoHttp.test.js` covers the 200 path, asserts the
photo is actually removed, that the previously issued URL then 404s, and a 422
validation case.

## Criterion 2 — ownership, membership states, side effects, errors, persistence

Gate 1 replays real client sequences against source and Phoenix in the pinned
Node 8 runtime and compares them:
`docs/parity/evidence/2026-09-10/a04-loop-operations/gate1-comparison.json` —
**12/12 sequences matched, 0 mismatches, 0 missing steps**, and Classic→upstream
forwarding **byte-exact** across all 34 captured pairs.

Two comparator defects had to be fixed to reach a trustworthy result. Both were
in the harness, not in Phoenix:

1. `classicForwardingExact` was hardcoded to expect 18 captures while the
   harness now emits 34, so it short-circuited on the count and reported
   forwarding as inexact even though every pair matched byte-for-byte. Replaced
   with a pairwise comparison.

2. `isDeleted` was compared between measurements that are not comparable. The
   source harness records the **raw JSON body** — where the source server does
   emit `isDeleted`, because its Mongoose `toJSON` transform never deletes it —
   while the Phoenix harness records the **SDK-parsed** result, where the field
   has already been stripped. This produced four permanent mismatches on
   `create-clear-read` and `create-remove-loop-read`.

   I initially read #2 as a Phoenix defect and implemented a fix. The pinned SDK
   model settled it: `apis/loop-2016-03-24` shape **S5** — the declared output
   of `Create`, `Remove` and `ClearRobot` — lists exactly `id`, `name`, `owner`,
   `robot`, `robotFriendlyId`, `members`, `isSuspended`, `created`, `updated`.
   There is no `isDeleted`, and the aws-sdk drops undeclared members while
   parsing, so **no original client can observe the field on these operations**
   whatever the server writes. The fix was unobservable and was reverted; the
   comparator was corrected instead.

   Soft deletion remains verified where it *is* observable: the `list-after` and
   `get-after` steps require the loop to vanish from list output and change the
   `getRobot` status code.

Falsification of the corrected comparator: corrupting `robotPresent` or
`isSuspended` on either affected sequence still produces 2 mismatches each
(**3/3 caught**), so it is corrected rather than weakened.

## Criterion 3 — adoption/revival in an explicit mode

Satisfied without redefining any original error. Adoption is a **separate admin
surface**, `POST /api/admin/adopt` in `packages/account/src/portalApi.js`, for
robots that completed OOBE against the original cloud years ago. It mints fresh
keys and a loop and returns the exact `credentials.json` plus the repoint
command. It is admin-gated, and it does not accept obsolete loop IDs through the
Loop wire operations, so the source's Loop error contract is untouched.

---

## Divergences and open items

No new divergences were opened by this verification. Related previously recorded
rows remain as documented.

Honest limits of this evidence:

- Gate 1 exercises a defined set of client sequences, not the full cross product
  of membership states.
- The runtime probe proves each operation is **served** with a real handler
  response; per-operation semantic depth is carried by the focused suites.
- `runtimeStatus` for the A-01 attribute rows in this family remains `not-run`;
  that is A-01's scope, not A-04's.
