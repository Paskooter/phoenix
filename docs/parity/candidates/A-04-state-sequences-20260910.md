# A-04 gate 1 — Account→Classic state sequences

Status: **candidate; awaiting root review.** A-04 is not closed. This write-up
covers only gate 1 from
[A-04-acceptance-index-20260908.md](A-04-acceptance-index-20260908.md).
Gates 2 (races) and 3 (interruption/recovery) were not redone.

Task id: `a04-state-sequences-20260910`  
Worktree branch: `grok/candidate-a04-state-sequences-20260910`  
Base revision: `ee05d7e`  
Sequence-capture revision: `4727ffad289419be489a18c702881fcc43493c89`

## Gate

> Compare the pinned Account controller state sequence with the original
> client sequence through Phoenix Account/Classic:
> `Invite`→`Accept`/`Decline`→`ListLoopMembers`, `RemoveLoopMember`→list/read,
> and `CreateLoop`→`ClearRobot`/`RemoveLoop`→read. Compare member status,
> owner/robot relation, event recipient/account ID, skill `-1`, and pending
> rows. Source-controller comparisons, generated-client controls and exact
> Classic forwarding can establish the combined boundary; running the original
> server behind Classic is not an additional requirement.

## What changed

No production Account/Classic behavior was changed. The gate is proved by:

1. `scripts/parity-a04/state-sequences-source.cjs` — pinned 6cea
   LoopHandler/LoopController under Node 8.9.4 with controlled model seams.
2. `scripts/parity-a04/state-sequences-client.cjs` plus
   `state-sequences-server.mjs` — original `@jibo/jibo-server-client` 3.0.110
   on Node 8.9.4 against Phoenix Account and Classic.
3. `packages/account/test/loopStateSequences.test.js` — three Node 22
   Account→Classic controls locking the same five dimensions and exact
   Classic forwarding.

Command:

```bash
bash scripts/parity-a04/run-state-sequences.sh
python3 scripts/parity-a04/compare-state-sequences.py
node --test packages/account/test/loopStateSequences.test.js
npm test
```

Evidence: `.parity/reviews/a04-state-sequences-20260910/` (gitignored).

## Source pins actually read

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Loop handler | `src/handlers/loop.handler.ts` SHA-256 `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| Loop controller | `src/controllers/loop.ctrl.ts` SHA-256 `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| Loop schemas | `src/schemes/loop.ts` SHA-256 `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| Save-event hook | `src/index.ts` SHA-256 `75adaa214617ea1d017831cc1dde1001490f155538ab06c3c75c618431c1dda1` |
| Member status | `src/schemes/member.status.ts` (`INVITED/ACCEPTED/DECLINED/REMOVED` lowercase) |
| LoopUpdated routing | `jiborobot/srv-notification-ws@e42bfe01506a8febf3005ac536fda735bba49d0d` `src/event.handlers/loop.updated.handler.ts`: `accountId = evt.payload.robot`, `skillId = "-1"`, name `LoopUpdated`; skip when robot is unset |
| Generated API | `@jibo/jibo-server-client@3.0.110`, `apis/loop-2016-03-24.min.json` (no `isDeleted` member) |
| Executed compiled controller | SHA-256 `c7025c7ca9596ab24adb1f81b8a7ac3fd47c2b33b79428565f7e399dbd9f574f` from the existing exact-source harness |
| Node image | `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (v8.9.4) |

Schema `pre("find")` / `pre("findOne")` middleware excludes `isDeleted`.
`findById` is `findOne`, so deleted loops are absent from ListLoops and
GetRobot. That is source schema, not a harness invention.

## Sequences and five dimensions

Original-client calls: **36** (18 Account + 18 Classic). Source controller:
**22** handler steps across the five named sequences. Classic forwarding:
**18/18** hops, request body SHA, response status, and response body SHA
identical to the upstream Account hop.

### 1. `Invite` → `Accept` / `Decline` → `ListLoopMembers`

| Step | Member status | Owner/robot | Event recipient | Skill `-1` | Pending |
| --- | --- | --- | --- | --- | --- |
| CreateLoop | owner+robot `accepted` | both set | `LoopCreated` (no accountId) | LoopUpdated → robot, `-1` | source none; Phoenix outbox drains |
| Invite existing | guest `invited` | unchanged | `InvitedToJoinLoop` accountId=guest | LoopUpdated → robot, `-1` | drained |
| Accept | guest `accepted` | unchanged | `InvitationToLoopAccepted` accountId=guest | LoopUpdated → robot, `-1` | drained |
| ListLoopMembers | guest `accepted` | unchanged | none | none | empty |
| Invite+Decline | guest `declined` | unchanged | `InvitationToLoopDeclined` accountId=guest | LoopUpdated → robot, `-1` | drained |
| ListLoopMembers | guest `declined` | unchanged | none | none | empty |

Wire statuses are lowercase. Phoenix stores lowercase here too; the
deliberate ListLoops lowercase projection is unchanged.

### 2. `RemoveLoopMember` → list/read

| Step | Member status | Owner/robot | Event recipient | Skill `-1` | Pending |
| --- | --- | --- | --- | --- | --- |
| RemoveLoopMember | guest `removed` | robot still set | `MemberRemovedFromLoop` accountId=guest; memberIds includes the removed recipient | LoopUpdated → robot, `-1` | drained |
| ListLoopMembers `statusList=[removed]` | that guest `removed` | unchanged | none | none | empty |
| ListLoops | same removed row on the live loop | owner+robot present, not deleted | none | none | empty |

### 3. `CreateLoop` → `ClearRobot` / `RemoveLoop` → read

| Step | Member status | Owner/robot | Event recipient | Skill `-1` | Pending |
| --- | --- | --- | --- | --- | --- |
| CreateLoop | owner+robot `accepted` | both set | `LoopCreated` | LoopUpdated → robot, `-1` | drained |
| ClearRobot / RemoveLoop | members retained | **robot cleared**, store `isDeleted=true` | no membership event | source emits LoopUpdated with robot unset (notification-ws would skip); Phoenix writes **no** outbox row | Account outbox empty; Classic gains no new LoopUpdated for that robot |
| ListLoops | — | deleted loop omitted | none | none | empty |
| GetRobot | — | `404 LOOP_NOT_FOUND` | none | none | empty |

Generated `loop-2016-03-24` has no `isDeleted` field. Phoenix mutation JSON
omits it; source `toJSON` includes `isDeleted: true`. The following
ListLoops/GetRobot reads agree with schema find middleware.

## Classic forwarding and pending rows

For the 18 Classic original-client calls, Classic request body SHA, response
status, and response body SHA matched the proxied Account hop. LoopUpdated
publisher calls (8 per face, 16 total) all used `accountId = loop.robot`,
`skillId = "-1"`, name `LoopUpdated`. After drain, both Account outboxes were
empty. Classic NotificationStore still held those LoopUpdated rows (no robot
socket), each with skill `-1`.

## `npm test`

At capture revision `4727ffa`, plus this write-up commit:

```text
# tests 944
# pass 937
# fail 0
# skipped 7
parity:check valid
parity:gate {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Baseline at `ee05d7e` was 941 / 933 / 0 fail / 8 skip. This candidate adds
three sequence tests. 937 pass / 7 skip versus 933 pass / 8 skip is those
three plus one previously skipped environmental coverage file executing in
this worktree (same skip movement gates 2/3 recorded). Log SHA-256
`d97f7e1d2e1b3a2729475d21cc366f354958188d907b1f940b1b54429749ec3a`.

## Evidence artifacts

| File | SHA-256 |
| --- | --- |
| `source-sequences.json` | `72170ea2366f1926738014c2c0202c701a8ed2da36ad3db3131b9df972ffc67a` |
| `sdk-results.json` | `5bd6db9b9b13b591faaf6d820fcfb528d48e21f09fe141de8f94f453c2bb08b9` |
| `server-captures.json` | `d1adc04e60f2f088fa1a604d6c1f99d2c0a604aa2f0419aa25068ab7ab193fbf` |
| `comparison.json` | `f8b2a6261cf6f965e190644b2b34873f8d935c5995696ccece2e7e392143f7bb` |
| `review.json` | see `.parity/reviews/a04-state-sequences-20260910/review.json` |

`compare-state-sequences.py` reported **16/16** dimension comparisons match,
including exact Classic forwarding.

## What this does not claim

- Original Account-server HTTP was not executed, and Classic was not pointed
  at the original Account process.
- Source controller used controlled Loop/Account/Token/mail/robot seams, not
  Mongo or Hapi.
- LoopUpdated skill `-1` on the source side is the notification-ws handler
  applied to Account `postSave` `payload.robot`, not a live SNS delivery.
- Profile/household KB readback and standalone outbox recovery were not
  re-counted.
- Gates 2–6 are untouched. Root owns the “bounded accepted” label.
