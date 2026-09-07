# A-10 LoopUpdated producer and notification-boundary candidate

Status: candidate, pending root review. This follow-up is based on frozen `2d3563f7091f322aa8a56bb07557f3809f061da8` in `/home/shell/work/phoenix/.parity/worktrees/a10-loop-producer`, branch `codex/candidate-a10-loop-producer-20260907`. The persistence repair is `3b62522`; the producer changes are `f6c92c5`. Main, the frozen notification worktree, robots, live services, source caches, goldens, and comparators were not changed.

## Source contract

The pinned `jiborobot/srv-account-ws` source is revision `b525601390108b8635a31794dfa5cc3fda8a37d0`. The relevant recovered files and hashes are:

| File | SHA-256 |
| --- | --- |
| `src/index.ts` | `2f8eb78a46fa7f304262d436c718dcd8642164319d029a9d335ce8f54b6d064c` |
| `src/controllers/loop.ctrl.ts` | `5426ee3dc369d3f59db3e46d6dec650a87444184999ae03962d596f5a1dfc9bf` |
| `src/handlers/loop.handler.ts` | `dcef10c095f0b781387663118e13f5d47f1f0a8b258340e4168a09ab6bf5b12d` |
| `src/schemes/loop.ts` | `1b560150d85e314b2936fa00e5a235b71e7ca1e00723d2fa8294aa51dc9d4d40` |

The source `loopSchema.postSave` calls `next()` immediately, schedules event construction with `setImmediate`, projects the saved loop into `events.LoopUpdated`, and sends it through `EventSender`. Its event payload uses the saved loop's `robot` relation as an opaque ID, not the caller's access key. The source `LoopController.suspendLoop` saves only after the lookup and robot/admin authorization checks succeed. `SuspendRobotLoop` resolves a robot by `friendlyId`, then delegates with an administrator identity.

The pinned `jiborobot/srv-notification-ws` source is revision `e42bfe01506a8febf3005ac536fda735bba49d0d`; its `src/event.handlers/loop.updated.handler.ts` hash is `088d20c67db3bf4ecdec7861d1429c785915593895f4b482320fcedcedcfbf62`. That handler takes `evt.payload.robot` as `accountId`, uses `skillId = "-1"`, and sends `{ name: "LoopUpdated", payload: evt.payload }`. No access-key-to-account-ID conversion is source-supported.

## Candidate boundary

`packages/account/src/loopUpdatedOutbox.js` builds that source-shaped event and persists it in the Account store's `notificationOutbox` collection. `createAccountService({ notificationPublisher })` exposes the explicit Account-to-notification seam; the publisher receives:

```js
{
  accountId: loop.robot,
  skillId: '-1',
  notification: { name: 'LoopUpdated', payload }
}
```

The suspension path records the event only after all source authorization and lookup checks pass. Loop state and the outbox row are written by one Account snapshot call; an injected snapshot failure restores the loop's `isSuspended`/`updated` fields and removes the uncommitted row. A failed publisher retains the row with an attempt count and error, and a later `recover()` republishes it. A failed acknowledgement flush restores the row rather than treating a published event as durably delivered.

The source member projection is retained, including `memberId`, status, guardian/agreement/name fields, enrollment, account `id`, and the `memberProperties` fallback. A loop without `robot` is still persisted but produces no notification target, matching the source notification handler's truthy guard. The producer never uses the request's `Authorization` access key or `x-amz-credentials` as an event account identity.

`packages/classic/src/notificationStore.js` now uses a transaction snapshot around every public token/notification mutation. Failed writes, chmods, or renames remove the temporary file and restore both maps; new token-bearing files are mode `0600`, and newly created store parents are mode `0700`. `NotificationHub` contains a failed durable deletion inside the WebSocket send callback and leaves the row retryable.

## Original controls

The source post-save control compiles the exact `src/index.ts` with TypeScript `2.5.3`, stubs only `@jibo/server`, Mongo connection, handlers/routes, schemas, and `AccountPopulator`, then executes the recovered module under the pinned Node `v8.9.4` image:

```text
node /home/shell/work/phoenix/.parity/reviews/a10-loop-producer-20260907/source-control/compile-source.cjs
docker run --rm --network none \
  -e SOURCE_CONTROL_OUTPUT=source-loop-postsave-node8.json \
  -v /home/shell/work/phoenix/.parity/reviews/a10-loop-producer-20260907/source-control:/control:rw \
  node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /control/run-source-loop-postsave.cjs
```

The source output is `/home/shell/work/phoenix/.parity/reviews/a10-loop-producer-20260907/source-control/source-loop-postsave-node8.json` (SHA-256 `c1878cfc8f554a934d3f9d43e3c54674ee585766a403c8d3752dd2f57565c4aa`). It records one `LoopUpdated`, one immediate `next` call, the exact member/property projection, and the saved `robot` value. The compiled source hash and compiler receipt are in `source-control/compile-receipt.json`.

The candidate control at `/home/shell/work/phoenix/.parity/reviews/a10-loop-producer-20260907/candidate-control/candidate-loop-producer.json` (SHA-256 `5f1e7323f31095e69deeb767d5ac9a45f6aadb26e9897567993fe7e543b4446f`) uses the same source-shaped document against the candidate helper. `candidate-control/../comparison.json` records exact equality of event name and complete JSON payload, account routing to `robot-001`, and skill `-1`. The candidate HTTP tests additionally exercise the real Account listener and signed caller keys.

## Tests

The candidate worktree has local `@phoenix/*` links resolving to this worktree. These focused tests passed:

```text
node --test packages/account/test/loopUpdatedNotification.test.js
```

Result: exit `0`, 5 tests passed. It covers denied versus successful `SuspendLoop`, admin `SuspendRobotLoop`, robot-ID routing despite different caller keys, exact event payload/default enrollment, no-robot behavior, failed publication/restart recovery, failed Account snapshot rollback, failed outbox acknowledgement recovery, and member-properties fallback.

```text
node --test packages/classic/test/notificationPersistenceFailure.test.js
```

Result: exit `0`, 2 tests passed. It covers write/rename failure injection for rotation, enqueue, remove, connection status, file/parent modes, and a successful socket callback whose durable delete fails without an unhandled rejection.

```text
node --test packages/account/test/*.test.js
node --test packages/classic/test/*.test.js
```

Results: exit `0`, 122 Account tests and 32 Classic tests passed in the candidate worktree.

## Remaining scope

This is an explicit local producer/outbox seam, not a complete source SNS/event-bus deployment. Account and Classic remain separate processes unless a caller supplies an authenticated publisher bridge; no default network/SNS consumer is claimed. Only the Phoenix suspension path currently emits this event; other loop saves and all Mongo post-save behavior remain outside the candidate. The Account JSON store is process-local and does not provide cross-process locking or a shared Mongo event transaction. Loops missing a `robot` cannot be routed and are intentionally retained without a guessed identity. Root must review the candidate and independently verify integration with the accepted notification service and robot path; this candidate is not parity-verified.
