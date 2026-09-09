# A-04 gate 4 — source query and projection edges

Status: **candidate; awaiting root review.** A-04 is not closed. This write-up
covers only gate 4 from
[A-04-acceptance-index-20260908.md](A-04-acceptance-index-20260908.md).
Gates 2 and 3 were not redone.

Task id: `a04-projection-edges-20260910`  
Worktree branch: `grok/candidate-a04-projection-edges-20260910`  
Base revision: `ee05d7e`  
Candidate revision: `4fd2acf16dc12154ded96d32d7723672a22a0742`

No production Account/Classic behavior was changed. The gate is proved by new
signed-boundary controls against the existing Store, populate/list helpers, and
Classic proxy.

## Gate

> Exercise source-reachable dangling account/robot references, soft-deleted
> accounts or loops, and repeated friendly IDs or invitation emails where the
> source permits them through the same signed boundary. Compare the source
> projection and the following valid read after reopen. Primary `_id`
> duplicates are excluded because the schema/database uniqueness boundary
> makes them malformed fixtures. The source `FindOwner` null projection and
> deployed Moth owner/list reads are already covered; retryable 500 label
> wording is not a gap without a client interpretation difference.

Read paths: `ListLoops`, `ListLoopMembers`, `FindOwner`, `GetRobot`,
`ListOwnerRobots`.

## Source pins read

Pinned artifacts were read through the Jibo MCP (`gitea_read_file`) at
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`. **No
original Node 8 Account process or Mongo server was started.**

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Loop controller | `src/controllers/loop.ctrl.ts` SHA-256 `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| Base lookup controller | `src/controllers/base.loop.ctrl.ts` SHA-256 `b85870f98589aa5c932d5b14942cae803cba355b7f8c15aacea2925192b1f3d9` |
| Loop schemas | `src/schemes/loop.ts` SHA-256 `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| Account schema | `src/schemes/account.ts` (email and friendlyId unique sparse; **no** `isDeleted` find middleware) |
| Generated API | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, `apis/loop-2016-03-24.normal.json` |

Evidence (gitignored): `.parity/reviews/a04-projection-edges-20260910/`
(`review.json`, `cases.json`).

## Source predicates (as read)

These are the query facts the three edge classes hang on. Phoenix already
preserved them; this gate measures them through the signed boundary.

- Loop `find` / `findOne` / `findOneAndUpdate` / `count` / `update` /
  `updateMany` middleware: `this.where("isDeleted").ne(true)`.
  `findById` is Mongoose `findOne`, so a soft-deleted loop is
  `LOOP_NOT_FOUND`.
- Account has **no** equivalent middleware. `Account.findById`,
  `Account.find({ _id: { $in } })`, and `Account.findOne({ email })` return
  deleted documents. `inviteMember` is the exception:
  `Account.findOne({ email, isDeleted: { $ne: true } })`. Phoenix
  `UpdateLoopMember` already keeps the unfiltered `findOne({ email })`.
- `populateLoop` / `loadMembers` only hydrates **accepted** members. A miss
  (dangling `_id`) assigns `member.account = member.memberProperties`. A
  present Account, including `isDeleted: true`, is copied. Robot
  `Account.findById(loop.robot)` miss omits `robotFriendlyId` and leaves
  `loop.robot`.
- `GetRobot` / `ListOwnerRobots` dereference `robotAccount.toJSON` /
  `robotAccount.friendlyId` with no null guard. That is HTTP 500
  `InternalFailure` on Phoenix, not `ROBOT_NOT_FOUND`. The source/Phoenix
  500 **label** difference is the existing qualified observation; it is not
  counted as a gap.
- `findOwnerId` is `Loop.findOne({ $or: [{ "members.accountId" }, { owner }] })`
  and `{ id: loop && loop.owner }`. It does not join Account, so a missing or
  deleted account id still resolves. A member that exists only on a
  soft-deleted loop is the already-covered `{ id: null }` projection and is
  not re-counted.
- `Account.email` and `Account.friendlyId` are unique sparse.
  `Loop.robot` is unique sparse. `memberProperties.email` is indexed and
  **not** unique. Primary `_id` duplicates are excluded by the gate.

## What changed

`packages/account/test/loopProjectionEdges.test.js` — three cases, each
through signed Account **and** Classic (`NET_account` proxy), then a new
Store + Account + Classic from the same JSON file. Membership writers are
awaited. `RobotReadClient` is a stub that throws “not configured”;
`CreateLoop` catches that lookup failure as the source does. No Moth, no
port 9000, no live mail.

## The three edge classes

### 1. Dangling account/robot references

Fixture: an active loop whose `robot` and one accepted `members.accountId`
point at Account ids that are not in the store. That is the Mongo
`findById`/`$in` miss shape. Source-reachable leftovers of the same shape:
`Account.create` hard-removes an `isDeleted` email collision after
`Loop.update` `members.$` rebinds only the first matching email member
(case 3); `removeById` of an email-less robot `clearMember`s the robot
member row but does **not** unset `loop.robot`.

| Read | Source projection (Phoenix matched) | After reopen |
| --- | --- | --- |
| `ListLoops` | 200; loop remains; `robot` is the missing id; `robotFriendlyId` omitted; dangling accepted member uses `memberProperties` | same |
| `ListLoopMembers` | 200; dangling member `status=accepted`, `account.email` from `memberProperties` | same |
| `FindOwner` of the missing member id | 200 `{ id: <owner> }` — no Account join | same |
| `GetRobot` | 500 `InternalFailure`, not `ROBOT_NOT_FOUND` | same |
| `ListOwnerRobots` | 500 `InternalFailure` (unguarded `friendlyId`) | same |
| Following valid `GetRobot` / `ListOwnerRobots` on a healthy sibling household | 200, that robot's `friendlyId` | 200 |

Account and Classic bodies matched. Human `ListLoops` did not copy
`facebookAccessToken`.

### 2. Soft-deleted accounts or loops

Writer path: signed `RemoveLoop` on one of two owner loops (`isDeleted=true`,
`robot` cleared). Then `InviteLoopMember` without email (source accepts a
non-child, no-email row) and `UpdateLoopMember` with the email of an
`isDeleted` guest — the unfiltered `Account.findOne({ email })` bind.
A leftover accepted member pointing at the same deleted account is a
document-state control for `loadMembers` (removeById would have
`clearMember`d an active-loop membership first).

| Read | Source projection (Phoenix matched) | After reopen |
| --- | --- | --- |
| `ListLoops` | deleted loop absent; active loop present | same |
| `ListLoopMembers` | deleted loop contributes no members; invited filter shows the bound row with `memberProperties` (`firstName: Bound`); accepted leftover projects the **deleted Account** (`firstName: DeletedGuest`), not stale `memberProperties` | same |
| `FindOwner` of the deleted loop's robot | 200 `{ id: null }` (already-covered null projection; recorded only as exclusion) | same |
| `FindOwner` of the deleted guest id | 200 `{ id: <owner> }` | same |
| `GetRobot` of the deleted loop | 404 `LOOP_NOT_FOUND` | same |
| `GetRobot` / `ListOwnerRobots` of the remaining active loop | 200, one `friendlyId` | same |

### 3. Repeated friendly IDs or invitation emails

**Invitation emails (source-permitted).** Concurrent `inviteMember` of the
same live email appends two invited subdocuments (gate 2 race; this gate
reads them). `memberProperties.email` is not unique. After marking that
account `isDeleted` and calling unsigned `Account_20151111.Create` with the
same email:

- the previous Account document is hard-removed (`account.remove()`);
- `Loop.update` `members.$` rebinds **the first** matching email member to
  the new Account `_id`;
- the second same-email member keeps a stale `accountId`.

`ListLoops` / `ListLoopMembers` return both invited rows. Status filters:
`invited` = 2, `accepted`/`declined`/`removed` = 0. `FindOwner` of the old
id still returns the owner. After reopen, both rows and that FindOwner
result remain.

**Friendly IDs (uniqueness-bound).** `Account.friendlyId` unique sparse makes
two live accounts with the same friendlyId a uniqueness error, in the same
class as primary `_id` duplicates. The source-permitted behavior is reuse:

- `RemoveLoop` clears `loop.robot` so the unique sparse `Loop.robot` slot is
  free;
- `findOrCreateRobotAccount` is `Account.findOne({ friendlyId })` with **no**
  `isDeleted` predicate, then `isActive = true` on the same `_id`;
- signed `CreateLoop` with that `robotId` attaches the same Account;
- `ListOwnerRobots` emits that friendlyId **once** (active loop + new loop;
  the deleted loop is hidden). Account count with that friendlyId stays 1.

## Commands

```bash
node --test packages/account/test/loopProjectionEdges.test.js
npm test
```

Focused result at `4fd2acf`: **3 passed, 0 failed**.

Full `npm test` from this worktree at `4fd2acf` (stated main-checkout baseline
at `ee05d7e` was 941 / 933 / 0 fail / 8 skip). Verbatim unit summary:

```
# tests 944
# suites 1
# pass 937
# fail 0
# cancelled 0
# skipped 7
# todo 0
```

`parity:check` valid (8/79 verified). `parity:gate` strict43:
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
The three new tests account for the +3 test-count delta. The skip 8→7 versus
the quoted main baseline was not investigated as a gate-4 change; no skip
directive was edited.

## Reporting split

**Verified against pinned source text or a Phoenix runtime in this
worktree:** the Loop/Account query predicates listed above, as read from the
pinned TypeScript; the three signed Account/Classic cases and their reopen
readbacks; Account vs Classic body equality for the recorded summaries;
CreateLoop robot-read lookup failure swallowed as in source.

**Inferred from source reading, not measured on original processes:** that
Mongoose `findById` miss / `Account.find({ _id: { $in } })` omission / unique
sparse index rejection on a Mongo 3.x server match the Store stand-ins used
here; that `Loop.update` without `multi` updates one document and one
positional member.

**Still unknown / not claimed:** original-server execution of these fixtures;
deployed Moth owner/list reads (already covered, not repeated); Mongo index
enforcement on the Phoenix JSON Store (the Store does not implement unique
sparse indexes; `findOrCreateRobotAccount` reuse is what prevents a second
friendlyId); gate 1 Account→Classic state sequences; Mongoose concurrency
(another agent this wave). Passing these unit tests is not A-04 parity.

## Is gate 4 satisfied?

The three edge classes were exercised through the signed Account→Classic
boundary, compared with the pinned source projection, and read back after
reopen. Unreachable repeated friendlyId *documents* were proved from the
unique sparse index rather than invented as fixtures. Root owns the
“bounded accepted” label.

## Concrete next step

Root should replay
`node --test packages/account/test/loopProjectionEdges.test.js` from a clean
worktree at `4fd2acf` and decide whether gate 4 is accepted as a bounded
query/projection slice. Do not mark A-04 verified from this candidate alone.
The remaining A-04 cross-operation work is gate 1 (Account→Classic state
sequences) and the Mongoose concurrency validation.
