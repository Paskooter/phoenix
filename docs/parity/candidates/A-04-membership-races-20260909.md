# A-04 gate 2 — membership transition races

Status: **candidate; awaiting root review.** A-04 is not closed. This write-up
covers only gate 2 from
[A-04-acceptance-index-20260908.md](A-04-acceptance-index-20260908.md).

Task id: `a04-membership-races-20260909`  
Worktree branch: `grok/candidate-a04-membership-races-20260909`  
Base revision: `5912ea4`

## What changed

Phoenix membership writes for `InviteLoopMember`, `AcceptLoopInvitation`,
`DeclineLoopInvitation`, and `RemoveLoopMember` no longer replace the whole
in-memory Loop document on save. They now apply source-shaped deltas:

- a new member is an append (`$pushAll.members` + `__v` increment, no version
  predicate);
- a dirty member path is a positional `$set` guarded by the loaded `__v`,
  without incrementing it;
- assigning a member path its current value is a touch (timestamp only).

HTTP handlers await those saves, so two in-flight Account/Classic requests can
interleave at the same yield as source `loop.save()`. Profile/photo/record
writers still use the existing whole-document `saveLoop`.

Tests live in `packages/account/test/loopMembershipRaces.test.js`. Direct
callers of the now-async invite/accept/decline/remove helpers were updated to
await.

## Source pins used

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Loop controller | `src/controllers/loop.ctrl.ts` SHA-256 `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| Loop schemas | `src/schemes/loop.ts` SHA-256 `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| Member status | `src/schemes/member.status.ts` (`ACCEPTED = "accepted"`, lowercase wire) |
| Prior operator recording | [invitation-concurrency-review](../evidence/2026-09-08/invitation-concurrency-review/review.json) (Node 8.9.4, Mongoose 4.9.8, recording collection callback, not a Mongo server) |

This candidate did **not** execute the original Account process or a Mongo
server. Controller behavior is from the pinned TypeScript. Save-operator
shape is from root's 2026-09-08 Mongoose recording plus that controller.

## The three races

### 1. Same email invited twice

Source `addMember` looks up by `accountId` or `memberProperties.email`. If a
row exists and is `accepted`, it throws `MEMBER_EXISTS` 409. Otherwise it
updates that row to `invited` with a new `invitationCode` and saves. If no row
exists, it `$push`es a new member.

| Interleaving | Status | Durable projection | Mail / event |
| --- | --- | --- | --- |
| Sequential, pending/declined/removed row | both 200 | one member, same `_id`, `invited`, new code | each invite sends mail + `InvitedToJoinLoop` to that email |
| Sequential, already accepted | 409 `MEMBER_EXISTS` | unchanged accepted row | none from the rejected call |
| Concurrent, both find before either save | both 200 | **two** members, same email, distinct `_id`s, both `invited` | two mails and two `InvitedToJoinLoop` events to that email |

Primary `_id` duplicates were not used. The two-member outcome is two
subdocuments, each with its own generated id.

Public HTTP can take either the update path or the dual-append path depending
on whether the second find observes the first save. Both are source-reachable.
The dual-append path is forced by overlapping direct `inviteMember` calls.

### 2. Declined or removed membership raced with a reinvite

Source decline/remove is a positional status write (`declined` / `removed`)
and does not check `invited`. Source reinvite of a non-accepted row is a
positional write of `status=invited` plus a new `invitationCode`.

| Interleaving | Status | Durable projection | Mail / event |
| --- | --- | --- | --- |
| Sequential decline then reinvite | 200 then 200 | same `_id`, `invited`, new code | decline: `InvitationToLoopDeclined` to the guest account; reinvite: existing-user mail + `InvitedToJoinLoop` |
| Concurrent decline + reinvite | both 200 | one row, same `_id`; status `invited` **or** `declined` (last `$set.status` wins); new invitation code from the reinvite | both events fire; one reinvite mail to that email |
| Concurrent remove + reinvite | both 200 | one row, same `_id`; status `removed` **or** `invited` | remove: `MemberRemovedFromLoop`; reinvite: mail + `InvitedToJoinLoop` |

The request-local decline/remove body can disagree with the durable status.
That matches source `save()` returning the request document while Mongo keeps
the last positional write.

### 3. `Accept` raced against `Decline`

Source accept requires `status === invited` at find time, then `$set`s
`accepted`. Source decline finds by `accountId` with no status predicate, then
`$set`s `declined`. Root's Mongoose recording: both overlapping writes return
200; operator is `$set.members.N.status` with a version predicate and no
`__v` increment.

| Interleaving | Status | Durable projection | Mail / event |
| --- | --- | --- | --- |
| Both find while `invited` | both 200 | one row; `accepted` **or** `declined` | no mail; both `InvitationToLoopAccepted` and `InvitationToLoopDeclined` to the guest `accountId` |
| Decline fully commits before accept finds | 200 then 404 `INVITE_NOT_FOUND` | `declined` | only the decline event |

The overlapping case is the gate. Phoenix now keeps both 200 when both finds
run against `invited`. Each HTTP body is request-local (accept body stays
`accepted`, decline body stays `declined`); the Store and the post-restart
Classic read show one winner.

## Restart readback

After each race the Account process is closed and a new Store is opened from
the same JSON file. A new Account service and Classic entrypoint are started
(`NET_account` points at Account). `Loop_20160324.ListLoopMembers` and
`Loop_20160324.ListLoops` through Classic return the same member id/status as
the persisted Store.

## Commands

```bash
node --test packages/account/test/loopMembershipRaces.test.js
npm test
```

Focused membership/invitation/persistence/event files passed 26/26 before the
full suite. The full `npm test` result is recorded in
`.parity/reviews/a04-membership-races-20260909/review.json` after that run.

## What this does not claim

- Original Account-server HTTP was not executed here.
- A live Mongo server was not executed here. Dual-append without a version
  predicate matches root's Mongoose 4.9.8 **recording callback**. Whether a
  real `collection.update` would reject the second `$pushAll` on `__v` is
  still unknown.
- Mixed membership + profile/photo persistence (array replacement vs
  positional index) is out of this gate. `updateMember` still uses
  whole-document `saveLoop`.
- Gates 1, 3, 4, 5, and 6 are untouched.

## Next step

Root should rerun the three overlapping cases against the pinned controller
with the existing Mongoose 4.9.8 save-operator harness, then the Classic
ListLoopMembers read after reopen. If a live Mongo version predicate rejects
the second concurrent invite, that is the remaining source-runtime question
for this gate — not a new Phoenix HTTP shape.
