# KB household bootstrap — loop/household contract

Status: **candidate, unverified**. Task ID `KB-household-bootstrap-20260908`.
This is a source-backed contract write-up plus a bounded Phoenix
`ListLoops`/`Account.Get` repair. It does **not** claim hardware parity and
does not touch the robot.

Base: worktree branch `grok/candidate-kb-household-bootstrap-20260908` from
`1b68bf1e14afdbfc0996a9761680305d2bbb040d`. Hashbrown baseline remains
`5c0a7390539663ba749d360de348a428c088505c`.

## What failed on hardware (root observation, not re-run here)

Root injected `POST /listen/mimic_global_turn {"clientASR":"what time is it"}`
into Jetstream. The turn reached the Phoenix hub (`gateway.listen` logged the
same `transId`). The transaction then failed with:

```
Cannot read property 'loop' of undefined
```

That wording is Node 6/8/14. Phoenix runs Node 22, which says `Cannot read
properties of undefined (reading 'loop')`. Robot `/var/log/messages` showed
`ssm[1450]` raising the same message at the same millisecond. `ssm` is
skills-service-manager and hosts the local KB plus `kb.loop.*`.

Root already put an Account and a Loop in the Phoenix account store. That is
necessary and not sufficient: the robot's **local** `/jibo/loop` slice is
filled by SSM LoopManager from Classic `Loop.list()`, not by Phoenix merely
having a row.

This agent did **not** talk to the robot. The hardware sequence is recorded
here as the problem statement, not as evidence this candidate collected.

## Source-proven: how the robot KB acquires a loop

### 1. Runtime attaches `jibo.kb.loop`

Pinned `sdk/sdk` `master` (`packages/jibo` 14.0.6):

- `packages/jibo/src/Runtime.ts` constructs `this.kb = new KnowledgeBase()`.
- `packages/jibo/src/plugins/ServicesPlugin.ts` registry name `kb` calls
  `jibo.kb.init(service)` then `jibo.kb.initLoop()` and `jibo.kb.initMedia()`.

Pinned `packages/jibo-kb` 8.0.6 (task mentioned 9.0.1; see unknowns):

- `src/KnowledgeBase.ts` `initLoop()` does
  `this.loop = this.createModel('/jibo/loop')`.
- `src/LoopModel.ts` constructor immediately opens
  `new WSClient(this.httpUrl)` and listens for `'LoopUpdated'`.

So `jibo.kb.loop` is a **client model** of the local KB HTTP service. It is
not itself the household. Members live in the `/jibo/loop` NeDB slice that
LoopManager writes.

### 2. SSM LoopManager is the cloud sync

Pinned `sdk/sdk` `master`,
`packages/skills-service-manager/src/services/kb/`:

- `KBService.initSyncManagers` constructs `LoopManager` unless system mode is
  `'oobe'`.
- `LoopManager.init` loads the local `/jibo/loop` root, then
  `_syncWithCloud`.
- Cloud read: `new JSC.Loop().list({})` → wire target
  `Loop_20160324.ListLoops`.
- Fallback robot id: `new JSC.Account().get({})` → wire target
  `Account_20151111.Get` with empty `ids`, meaning the caller.
- Apply: `_applyLoopChanges` matches members by **`member.id`** (loop member
  subdocument id, not account id), copies loop fields
  `id, name, owner, robot, robotFriendlyId, created, updated` onto the KB
  root, maps owner/robot account ids to member ids, and merges member+account
  fields onto user nodes.
- `_isLoopGood` requires `data.length === 1`, `members.length > 0`, and warns
  if `owner`/`robot` are missing from `members[].accountId`.
- `_filterOutInvitedChildren` reads `member.account.isChild` and
  `member.status === 'invited'`. If `member.account` is missing this throws
  `Cannot read property 'isChild' of undefined`.

Older `sdk-archive/jibo-kb-service` `src/LoopManager.js` used
`members[].memberId` and a second `Account.get({ids})` for profiles. The SSM
copy on `master` expects the nested `member.account` that
`LoopController.populateLoop` attaches.

### 3. Exact ListLoops response shape

Pinned `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`:

- Handler: `src/handlers/loop.handler.ts` `ListLoops` →
  `LoopController.list({ friendlyId, loopId, ownerId })`.
- Schema: `src/schemes/loop.ts` member `toJSON` sets `id = _id`,
  `memberId = accountId` (2.x fallback), status enum lowercase
  `invited|accepted|declined|removed`.
- `LoopController.populateLoop`:
  - loads accepted members' Account rows
  - sets `member.loopId`, `member.type` (`incoming` if `accountId === owner`,
    else `outgoing`)
  - `member.account =` accepted Account copy **or** `memberProperties`
  - accepted account copy fields: `birthday, email, facebookAccessToken
    (robot callers only), firstName, gender, lastName, phoneNumber, photoUrl`
  - `member.enrolled ||= { face: false, voice: false }`
  - adds `robotFriendlyId` from the robot Account

`AccountHandler.Get`: empty/missing `ids` becomes `[request.auth.credentials.id]`.
Non-admins may only request accepted members of their loops.
Mongoose `toJSON` exposes `id` from `_id`. LoopManager uses `data[0].id`.

### 4. What SSM dereferences at turn time

Pinned `packages/jibo/src/plugins/context/ContextProvider.ts`:

```ts
const rootNode = await Runtime.instance.kb.loop.loadRoot();
this.ownerNode = await Runtime.instance.kb.loop.load(rootNode.getEdges('owner')[0]);
// later:
await Runtime.instance.kb.loop.loadLoop()
```

`loadLoop` walks root `user` edges. `UserNode.isJibo` is `!this.data.firstName`
(robot accounts have empty `firstName`). Context `runtime.loop` then has
`loopId`, `users`, `jibo`, `owner`.

The observed string `Cannot read property 'loop' of undefined` is
`undefined.loop`. Source-proven matches:

| Access | When it throws that exact property name |
| --- | --- |
| `jibo.kb.loop` / `Runtime.instance.kb.loop` | `jibo.kb` is undefined |
| original Pegasus hub identity (`data.runtime.loop`) | `data.runtime` is undefined (Node 8 wording; Phoenix H-10 already guards this) |

If `jibo.kb` exists but `initLoop()` never ran, the throw is
`'loadRoot' of undefined`, not `'loop'`. If the slice is empty,
`rootNode.getEdges` throws `'getEdges' of undefined`. Those are **related
empty-household failures**, not the exact `'loop'` token.

**Inferred (not hardware-proven):** SSM's renderer (BE/jibo) is the process
that both serves `kb.loop.*` and builds Jetstream CONTEXT via
`ContextProvider`. An empty local `/jibo/loop` after a failed ListLoops sync
is the tracked household-bootstrap gap. The exact `'loop'` token on this
Moth turn was not reproduced here.

## What Phoenix returned before this candidate

`packages/account/src/robotFace.js` `loopToWire` emitted stored members as
`{ accountId, status: 'ACCEPTED' }`:

- no member `id` (LoopManager matches `member.id === node._id`)
- uppercase `ACCEPTED` (source enum is `accepted`)
- no nested `account` (`_filterOutInvitedChildren` would throw `isChild`)
- no `type` / `loopId` / `memberId` / `enrolled`

`Account_20151111.Get` was `UnknownOperationException`. LoopManager's empty-KB
fallback could not learn `data[0].id`.

Stored Phoenix members used `ACCEPTED` because Settings membership still
compares `status === 'ACCEPTED'`. That internal spelling is left in the store;
only the ListLoops wire lowercases it.

## Bounded implementation

Source-justified, no invented household people (owner + robot already on the
loop):

1. `createLoop` writes mongoose-like member subdocs: `_id`, `accountId`,
   `status: 'ACCEPTED'`, `enrolled: {face:false,voice:false}`.
2. `ListLoops` runs `LoopController.populateLoop`: `id`, `memberId=accountId`,
   nested `account`, lowercase `status`, `type`, `loopId`, `enrolled`.
3. Legacy loops that only had `{accountId,status}` get a **persisted** `_id`
   on first List so LoopManager sees a stable member id.
4. `Account_20151111.Get` implements the empty-`ids` caller fallback and the
   `MEMBER_CAN_REQUEST` membership gate. Secrets are not returned.

Not implemented (still gaps): InviteLoopMember, UpdateLoopMember, GetRobot,
ListLoopMembers, SetEnrollment, UpdatePhoneticName, and the other 17 Loop ops
A-01 already marked missing. RobotManager's `Robot.getRobot` is a separate
Classic family.

## Tests and gates

```
node --test packages/account/test/loopHouseholdBootstrap.test.js
node --test packages/account/test/*.test.js
npm test
```

Results in this worktree:

| Command | Result |
| --- | --- |
| focused household tests | 5 pass |
| `packages/account/test/*.test.js` | 132 pass |
| `npm test` unit | **802 tests, 795 pass, 7 skip, 0 fail** |
| `parity:check` | valid (checklist 8/79) |
| `parity:gate` | **43 cases, 0 differences, 0 invariants, 0 coverageGaps** |

`packages/account/test/loopHouseholdBootstrap.test.js` covers populateLoop
fields, stable legacy member ids, LoopManager `_isLoopGood` / invited-child
readability, Account.Get self/empty-ids/membership denial, and "do not invent
members". Passing unit tests is not household parity.

## What this candidate could NOT establish

- Hardware: no robot, no SSM log, no live ListLoops capture from Moth.
- Exact on-robot throw site for the `'loop'` token (kb missing vs runtime
  missing vs another `.loop`).
- jibo 15.0.1 / jibo-kb 9.0.1: `sdk/sdk` `master` is jibo 14.0.6 / kb 8.0.6;
  tag `v23.4.2` is jibo 14.2.9 / kb 8.0.18. Those files still have
  ServicesPlugin `initLoop` and LoopModel `WSClient`. 15.0.1/9.0.1 were not
  found as published pins in this archive.
- Whether Moth's SSM completed `initSyncManagers` (OOBE mode skips it).
- Whether Classic on the robot is pointed at Phoenix Account for Loop_*.
- Photo sync (`axios.get(photoUrl)`), HolidayManager, MediaListManager.
- Original Node 8 ListLoops bytes against this populateLoop JSON.

## Concrete next step for root

1. Review and, if accepted, deploy this Account revision so Moth's Classic
   `Loop_20160324.ListLoops` returns populateLoop members.
2. On the robot (root-owned): restart SSM or wait for LoopManager's sync, then
   confirm local `/jibo/loop` has owner+user edges. Do not invent extra
   members.
3. Re-inject `what time is it`. If `'loop' of undefined` remains, capture the
   SSM stack: distinguish `jibo.kb` missing vs empty slice vs CONTEXT without
   `runtime`.
4. Remaining Loop ops stay on A-04; Robot.getRobot is a separate Robot family.

Passing these unit tests is **not** verified household parity.
