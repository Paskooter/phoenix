# A-04 candidate: Loop membership lifecycle (6 of 20 missing operations)

Task ID: `A-04-loop-operations-20260908`  
Worktree: `.parity/worktrees/a04-loop-operations-20260908`  
Branch: `grok/candidate-a04-loop-operations-20260908`  
Parent: `1b68bf1e14afdbfc0996a9761680305d2bbb040d`  
Candidate revision: `078cd8978435f757471d3ada78dc4a765f05d806`  
Status: **implementation candidate, unverified.** A-04 is not closed. No original Loop runtime, original Node 8 client, or gateway SigV4 replay was executed.

## Subset and why

The A-01 map records 23 Loop operations; Phoenix already has bounded `ListLoops`, `SuspendLoop`, and `SuspendRobotLoop`. This candidate implements the six missing operations that actually join, list, and leave a loop:

| Wire target | Handler | Controller |
| --- | --- | --- |
| `Loop_20160324.CreateLoop` | `LoopHandler.CreateLoop` | `LoopController.create` |
| `Loop_20160324.InviteLoopMember` | `LoopHandler.InviteMember` | `LoopController.inviteMember` / `addMember` |
| `Loop_20160324.AcceptLoopInvitation` | `LoopHandler.AcceptInvitation` | `LoopController.acceptInvitation` / `acceptMembership` |
| `Loop_20160324.DeclineLoopInvitation` | `LoopHandler.DeclineInvitation` | `LoopController.declineInvitation` |
| `Loop_20160324.ListLoopMembers` | `LoopHandler.ListMembers` | `LoopController.listMembers` via `list` |
| `Loop_20160324.RemoveLoopMember` | `LoopHandler.RemoveMember` | `LoopController.removeMember` |

That is the membership lifecycle: create the loop with owner+robot members, invite, accept or decline, list, remove (soft `removed` status). It is one coherent controller path and is what later enrollment, photos, names, legal-guardian, and loop-update operations assume already exists.

Deferred on purpose (not membership join/leave):

- Profile/enrollment: `UpdateLoopMember`, `SetEnrollment`, `UpdateNickname`, `UpdatePhoneticName`, `UpdateMemberPhoto`, `RemoveMemberPhoto`
- Loop record (not membership): `UpdateLoop`, `RemoveLoop`, `ClearRobot`
- Robot lookup: `GetRobot`, `FindOwner`, `ListOwnerRobots`
- COPPA/EchoSign: `SetLegalGuardian`, `UpdateAgreementStatus`

Aliases accepted (API model `key` vs `name`): `Create`/`CreateLoop`, `InviteMember`/`InviteLoopMember`, `AcceptInvitation`/`AcceptLoopInvitation`, `DeclineInvitation`/`DeclineLoopInvitation`, `ListMembers`/`ListLoopMembers`, `RemoveMember`/`RemoveLoopMember`. `Loop_20160324.Remove` remains `UnknownOperationException` so the existing robot-face test and `RemoveLoop` stay unimplemented.

## Source pins

- API model: `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344` `apis/loop-2016-03-24.normal.json` (empty `errors` arrays)
- Controllers: `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` `src/handlers/loop.handler.ts`, `src/controllers/loop.ctrl.ts`, `src/controllers/base.loop.ctrl.ts`, `src/errors/loop.ts`, `src/schemes/{loop,member.status,member.type}.ts`
- Framework: `jiborobot/srv-server@4.0.17` `parseCredentials.ts`, `validate.ts` (`Joi.validate(..., {allowUnknown:true})` → `Boom.badData`, HTTP 422)
- Hashbrown baseline (plan): `5c0a7390539663ba749d360de348a428c088505c` — not executed here

Error codes are controller-sourced. None were invented. API JSON declares no error shapes for this family.

## Public-face identity (same as bounded Suspend)

Source `@parseCredentials({})` reads internal `x-amz-credentials`. This public Classic face resolves the caller from the Authorization access key, as `SuspendLoop` already does. `x-amz-credentials` is not a caller switch. Missing CreateLoop identity is `CREDENTIALS_REQUIRED 401` on this face (PrepareRobot already uses that code); source parseCredentials does not throw it, and the controller would then hit mongoose `owner` required. Other ops with a missing caller follow the controller: `CAN_BE_ACCESSED_BY_OWNER`, `INVITE_NOT_FOUND`, `CAN_BE_ACCESSED_BY_OWNER_OR_SELF`.

## Behavior implemented against the controller

**CreateLoop.** `name`+`robotId` required strings (422 first-field Joi envelope). Creates owner+robot members as `accepted`, persists `name` as given (not the OOBE generated name). `findOrCreateRobotAccount` then `removeRobotFromLoops` (source one-element `$or` is an AND: prior loop with that robot *and* robot member is suspended, robot cleared, robot member stripped). `ROBOT_REQUIRED 422` remains in the controller path; the handler Joi gate makes it unreachable through HTTP. `RobotClient.getRobot` is not called; the source path when getRobot throws is “log and continue”. `ROBOT_DISABLED 409` is therefore not reachable here.

**InviteLoopMember.** Owner only (`CAN_BE_ACCESSED_BY_OWNER 403`). `LOOP_NOT_FOUND 404` including soft-deleted. `LOOP_SUSPENDED 403`. Existing accepted member → `MEMBER_EXISTS 409`. Re-invite of invited/declined updates status to `invited` and a new invitation code. Adult with no email → immediately `accepted`. `isChild: true` without email → `invited` (COPPA default on). Invitation code is stored and stripped from JSON (`memberSchema.toJSON`). Email lowercased; names trimmed. `ACTIVE_LIMIT_REACHED` is preserved as the source comparison of the filtered **array** with `MAX_SIZE` (16), which does not fire; a 20-invite control documents that.

**AcceptLoopInvitation.** Invited member whose `accountId` matches the caller → `accepted`. Returns the **unpopulated** Loop JSON (`acceptInvitation` returns `loop.save()`, not `populateLoop`). Already-accepted or non-member → `INVITE_NOT_FOUND 404`. Suspended → `LOOP_SUSPENDED 403` before mutation. Unknown-email invites have no `accountId`; Accept cannot bind them (Account `updateInvitationsByEmail` / invitation-code signup is A-03, not this subset).

**DeclineLoopInvitation.** Member looked up by `accountId` **without** requiring `invited` (source does not check status). Returns `populateLoop`. Missing membership → `INVITE_NOT_FOUND`. Suspended → `LOOP_SUSPENDED`.

**ListLoopMembers.** Optional `statusList` / `typeList` (Joi enums; empty lists mean all). Visibility is source `list()`: owner **or** accepted/invited member. Robot callers (`friendlyId`) skip suspended / non-robot loops. Owner still sees a suspended loop’s members. This is **not** a change to existing `ListLoops`, which still uses owner/robot fields only.

**RemoveLoopMember.** `id` is the member subdocument id, not account id. Owner or self (`CAN_BE_ACCESSED_BY_OWNER_OR_SELF 403`). Soft `removed`; the row stays. `MEMBER_NOT_FOUND 404`. Suspended → `LOOP_SUSPENDED` after the ownership check.

Member wire status values are source lowercase (`invited`/`accepted`/`declined`/`removed`). OOBE `model.createLoop` still writes uppercase `ACCEPTED` so existing ListLoops/Settings fixtures stay stable. Membership comparisons treat both. Settings `isLoopMember` now uses `isAcceptedStatus` so a Loop-API accepted member is a Settings member.

Saves set `updated` (Loop pre-save hook) and record `LoopUpdated` through the existing outbox. Invitation mail, `InvitedToJoinLoop` / `InvitationToLoopAccepted` / `InvitationToLoopDeclined` / `MemberRemovedFromLoop` / `LoopCreated` EventSender payloads, and RobotClient are not sent (no live providers).

## Existing three handlers

`ListLoops`, `SuspendLoop`, and `SuspendRobotLoop` are unchanged in dispatch semantics, envelopes, robot list filtering, and 422 validation. OOBE `createLoop` still returns an existing loop for a robot (revival path). The only OOBE member-record addition is `_id` and `created` on newly created members, which ListLoops dumps through as extra fields; existing tests do not require their absence.

## Tests

`packages/account/test/loopMembership.test.js` covers, per operation: happy path, ownership/identity, missing/malformed input (422), declared controller errors, suspended/deleted loops, persistence across `Store` reopen, and a regression that List/Suspend/`Remove` still behave as before.

## Acceptance criteria coverage

A-04 done-when items:

| Criterion | This candidate |
| --- | --- |
| Cover all 23 wire operations | **No.** 9/23 now have Phoenix handlers (3 previous + 6 new). 14 remain absent. |
| Match ownership, membership states, side effects, errors and persistence with real client sequences | **Partial, source-inspection only.** HTTP/state tests cover auth/ownership, schema, errors, persistence and LoopUpdated-outbox saves. No original client sequence, no Node 8 gateway, no mail/event-bus/RobotClient side effects. |
| Preserve adoption/revival; do not silently redefine original errors | **Yes for this subset.** OOBE createLoop still short-circuits on an existing robot loop. Controller codes are cited. `RemoveLoop` is still unimplemented. |

Dispatch/shape support is not the claim. The tests exercise the controller rules above. That is still not verified parity.

## What was verified against original source

- Handler mapping, Joi fields, decorator order, and controller control flow at `6cea4347`
- Error `{code, message, statusCode}` from `src/errors/loop.ts`
- Member status/type enums and Loop/member `toJSON` transforms
- API request/response member names from `loop-2016-03-24.normal.json`
- `parseCredentials` does not require credentials; `validatePayload` uses Boom.badData 422 (`@jibo/server` 4.0.17)
- Focused tests + `npm test` at `078cd8978435f757471d3ada78dc4a765f05d806`: **798 pass**, 7 skipped, 0 fail; `parity:check` valid (8/79); strict smoke gate **43 cases, 0 differences**. Passing unit tests is not A-04 parity.

## What was inferred from source reading

- Hapi JSON of a mongoose document for Accept vs `populateLoop` for Invite/Decline/Remove/Create
- Public-face access-key identity as the substitute for gateway `x-amz-credentials`
- `ACTIVE_LIMIT_REACHED` unreachability from `array >= 16`
- `removeRobotFromLoops` query as AND because `$or` has one object
- Joi 10.5.2 messages reimplemented without `convert:true` (booleans/numbers are strict types here)

## What remains unknown / not-run

- Original Account process, Mongo, `@jibo/server` Hapi route, Node 8 client
- Deployed target alias and full Classic SigV4
- `RobotClient.getRobot` / `ROBOT_DISABLED`
- Invitation email and EventSender events other than the local LoopUpdated outbox
- Account-side invitation-code bind on signup (`updateAccountByInvitation` / `updateInvitationsByEmail`)
- Exact mongoose extra fields (`_id`, `isDeleted`, `__v`) on Accept’s unpopulated JSON
- Joi convert coercions (`"true"` → boolean, numeric strings)
- The other 14 Loop operations

## Commands

```sh
node --test packages/account/test/loopMembership.test.js packages/account/test/loopSuspend.test.js packages/account/test/robotFace.test.js
npm test
```

`npm test` result at `078cd89`: 798 pass / 7 skipped / 0 fail; parity tracker valid; strict gate `{"result":"match","cases":43,"differences":0,"invariants":0,"coverageGaps":0}`.

## Next step

Root review of this membership increment. Do not mark A-04 verified. A useful follow-up is either (1) original Node 8 Loop client controls for these six operations, or (2) the next coherent slice: `UpdateLoop` + `RemoveLoop`, or member profile (`UpdateLoopMember` / nickname / phonetic / enrollment) now that member ids and statuses exist.
