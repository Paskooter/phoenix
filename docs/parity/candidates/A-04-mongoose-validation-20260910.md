# A-04 — Mongoose harness validation of the membership writer

Status: **candidate; awaiting root review.** A-04 is not closed. This write-up
covers only whether the landed membership writer at `ee05d7e` matches the
source-observed Mongoose 4.9.8 save operators, and whether the two defects
named in the rejection of `c3b7789` are present.

Task id: `a04-mongoose-validation-20260910`  
Worktree branch: `grok/candidate-a04-mongoose-validation-20260910`  
Base revision: `ee05d7e0ff5ef405414237d0d5dbb3385bfbd80b`  
Candidate revision: `4cd267a9b59014c1d5636be2004e4ab81af90148`  
Landed writer: `packages/account/src/loopMembership.js` from `560a944`

## Verdicts

| Defect | At `ee05d7e` | After this candidate |
| --- | --- | --- |
| 1. Unchanged declined status gains a false version conflict after an overlapping append | **absent** | **absent** |
| 2. Array removal does not increment version, allowing a queued positional write to change another member | **present** | **absent** for the executed `saveLoop` / queued-accept interleaving |

Passing unit tests are not treated as parity. The operator claims below are
from executed Mongoose 4.9.8 `Model.save` recordings and executed Phoenix
direct-function replays.

## What was reused

The prior root instrument is
`.parity/reviews/a04-concurrency-mongoose-root-20260908/observe.cjs`
(SHA-256 `8be0c1270ba98d2ddfcdd1b6cf185826d3cf0daf629af0211c0ae51f69eb93de`).
It is a Node 8.9.4 `$__delta()` probe on the original Loop schema. It was
re-run unchanged. Its operators still match the 2026-09-08 recording:
`$pushAll.members` + `$inc.__v` for an append, positional `$set.members.2.status`
with `{_id,__v}` and no `$inc` for a status change.

That probe is not a `Model.save` and does not cover the two named defects.
Both original save recordings were kept and re-run:

- `mongoose-save-node8.cjs` — actual `Model.save` with a recording
  `collection.update` for dual-append and overlapping accept/decline.
- `source-save-v2.cjs` — actual `Model.save` for unchanged declined status
  and array assignment.

`source-save-cases.cjs` is an extension of those save recordings, not a
replacement. It adds `DocumentArray.pull` (for contrast) and an
`updateMember`-shaped reassignment (`members = filter(...)` plus remaining
member field writes).

Phoenix comparison is `phoenix-replay.mjs`: direct calls into the current
membership functions against the JSON Store. It does not emit Mongo
operators; store writes are classified against the source operator classes.

## Source operators (executed)

Runtime: Node `v8.9.4`, Mongoose `4.9.8`, schema SHA-256
`eb21ce3229748b4188de6a3fb37495c0e5d733544b4c7fb176cc75901acd888d`,
Account `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
`collection.update` was a recording callback, not a Mongo server.

| Case | `where` | `update` |
| --- | --- | --- |
| Dual overlapping append | `{_id}` only | `$pushAll.members` + `$inc.__v: 1` + `$set.updated` |
| Overlapping accept / decline | `{_id, __v: 0}` | `$set.members.2.status` + `$set.updated`, no `$inc` |
| Unchanged declined status | `{_id}` only | `$set.updated` only |
| Array assignment `members = filter(...)` | `{_id, __v: 0}` | `$set.members` (whole remaining array) + `$inc.__v: 1` + `$set.updated` |
| `DocumentArray.pull` (not used by the controller) | `{_id, __v: 0}` | `$pull.members` + `$inc.__v: 1` + `$set.updated` |
| `updateMember`-shaped filter + field writes | `{_id, __v: 0}` | `$set.members` + `$inc.__v: 1` + `$set.updated` |

Source `LoopController.updateMember` and `removeRobotFromLoops` assign
`loop.members = loop.members.filter(...)` then `loop.save()`. They do not
call `.pull()`. Array removal is a whole-array `$set` that increments `__v`,
not `$pull` / `$pullAll`.

## Phoenix at `ee05d7e` (executed, before repair)

| Case | Result |
| --- | --- |
| Dual overlapping `inviteMember` | both fulfilled, 4 members, `__v = 2` |
| Overlapping `acceptInvitation` / `declineInvitation` | both fulfilled, durable status `declined`, `__v = 1` |
| Append + decline of an already-declined member | both fulfilled, no `LOOP_VERSION_CONFLICT`, 4 members |
| `acceptInvitation` queued, then `updateMember` removes an earlier declined row | **queued accept fulfilled and set member `333…` to `accepted`**; guest `222…` stayed `invited`; `__v` stayed `0` |
| `updateMember` first, then accept | guest correctly `accepted`; other stayed `invited` |
| `removeRobotFromLoops` via `createLoopFromApi` | robot member removed; `__v` unchanged |

Defect 1 is absent because `saveLoopMutation` drops same-value member fields
and degrades to `touch`, which has no version predicate. That matches the
source timestamp-only update.

Defect 2 is present, and it is reachable without moving `updateMember` onto
the delta path. `acceptInvitation` captures `memberIndex` then yields at
`setImmediate`. Synchronous `updateMember` then reassigns `members` through
`saveLoop` without incrementing `__v`. The queued positional write applies
at the stale index and accepts a different member.

Root's reading that the defect was latent because array removal still used
`saveLoop` is therefore only half right: the delta writer does not implement
array removal, but the `saveLoop` / queued-positional interleaving is live
today. Source-compatibility at that seam was also incomplete: source
increments `__v` on array replacement; `saveLoop` at `ee05d7e` did not.

## Repair

`saveLoop` now increments `__v` when the members id list changes, matching
the source `$set.members` + `$inc.__v` recording. `updateMember` and
`removeRobotFromLoops` stay on the whole-document writer. The delta writer
was not redesigned.

After the repair, the same queued-accept interleaving rejects with
`LOOP_VERSION_CONFLICT` (`expected 0, found 1`). Member `333…` stays
`invited`. Dual-append, overlapping accept/decline, and unchanged-declined
outcomes are unchanged.

If a later slice moves array removal onto `saveLoopMutation`, that kind must
increment `__v` and keep a version predicate. The current delta path still
has no array-removal mutation.

`saveLoop` still does not reject a stale array replacement of its own via an
`__v` predicate. Overlapping whole-document array replacements were not the
named defect and were not repaired.

## Commands

```bash
NODE8=/home/shell/work/phoenix/.parity/reviews/n08-original-multirule-20260906/perf-diagnosis/node-v8.9.4-extracted
export NODE_PATH=/home/shell/work/phoenix/.parity/reviews/a06-original-runtime/node_modules:/home/shell/work/phoenix/.parity/reviews/a04-source-methods-20260907/node_modules
EV=.parity/reviews/a04-mongoose-validation-20260910

timeout 120s "$NODE8" "$EV/observe.cjs"
timeout 120s env OUTPUT="$EV/mongoose-save.json" "$NODE8" "$EV/mongoose-save-node8.cjs"
timeout 120s "$NODE8" "$EV/source-save-v2.cjs"
timeout 120s env OUTPUT="$EV/source-save-cases.json" "$NODE8" "$EV/source-save-cases.cjs"
node "$EV/phoenix-replay.mjs"
node --test packages/account/test/loopMembershipRaces.test.js packages/account/test/loopMemberUpdate.test.js
npm test
```

Focused membership files after the repair: 16/16 pass (8 prior race tests, 6
`UpdateLoopMember` tests, plus the two defect controls).

Full `npm test` from this worktree at `4cd267a`:

```
# tests 943
# pass 936
# fail 0
# cancelled 0
# skipped 7
```

`parity:check` accepted the tracker. `parity:gate` matched 43/43 strict smoke
cases with zero differences. Baseline at `ee05d7e` from the main checkout was
941 tests / 933 pass / 0 fail / 8 skip. This candidate adds two defect
controls (+2 tests, +2 pass). The skip count moved 8→7 because this worktree
links the main `node_modules`, so one previously skipped coverage file ran
and passed. That is an environment difference, not a product change.

Receipt: `.parity/reviews/a04-mongoose-validation-20260910/review.json`.

## Split

**Verified by execution**

- Mongoose 4.9.8 `Model.save` operators for dual-append, overlapping
  accept/decline, unchanged declined status, array assignment, and
  `DocumentArray.pull`.
- Phoenix dual-append member count 4 and `__v` 2.
- Phoenix overlapping accept/decline both succeed with one durable status
  and no `__v` increment on the status writes.
- Phoenix unchanged declined + overlapping append both succeed (defect 1
  absent at `ee05d7e`).
- Phoenix queued accept after array-removing `updateMember` accepted the
  wrong member at `ee05d7e` (defect 2 present) and is rejected after the
  `saveLoop` version increment.

**Inferred from source reading**

- `LoopController.updateMember` / `removeRobotFromLoops` assign
  `loop.members = filter(...)` rather than `.pull()`. Confirmed by the
  compiled controller and by the assignment-vs-pull save recordings.
- HTTP handlers await the async invite/accept/decline saves, so the
  `setImmediate` yield is the same overlap a concurrent `UpdateLoopMember`
  can enter. The operator replay itself used direct function calls.

**Still unknown**

- A real Mongo server was not run. Whether the second overlapping
  `$pushAll` or the second overlapping positional `$set` would report
  `nModified: 0` is not established.
- Original Account HTTP was not executed in this task.
- `saveLoop` still last-writes a stale array replacement instead of
  applying an `__v` predicate of its own.

## Next step

Root should inspect the before/after Phoenix replay JSON and the Node 8
`source-save-cases.json` operators. If accepted, the remaining A-04 gate 2
question is still live Mongo, not a new Phoenix HTTP shape for invite /
accept / decline.
