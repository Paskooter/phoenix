# A-04 gate 3 — cross-boundary interruption and recovery

Status: **implemented candidate; pending independent root review**. A-04 is
not closed. This work owns **gate 3 only**. Gates 1, 2, 4, 5 and 6 were not
attempted.

Candidate branch
`grok/candidate-a04-interruption-recovery-20260909` at
`ad3bb588503e2888f362f700f0cfd7e5dca95f79`, based on `5912ea4`. Evidence:
`.parity/reviews/a04-interruption-recovery-20260909/` (gitignored). Synthetic
households and local peers only. No Moth, no port 9000, no SNS, no live mail.

## Gate

> Inject a connection loss or process interruption while an Account mutation
> is being flushed or while Classic reconnects to the publisher. Compare
> durable state, duplicate or lost `LoopCreated`/`LoopUpdated` messages,
> pending-row recovery and the following valid request.

Operations exercised: `UpdateLoop`, `CreateLoop`, `RemoveLoopMember`, and
the following `ListLoops` / `UpdateLoop` readbacks.

## Source, as read

Pinned artifacts were read through the Jibo MCP (`gitea_read_file`). **No
original Node 8 Account, notification-ws, or entrypoint-socket process was
started in this candidate.**

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Loop controller | `src/controllers/loop.ctrl.ts` SHA-256 `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| Save-event hook | `src/index.ts` SHA-256 `75adaa214617ea1d017831cc1dde1001490f155538ab06c3c75c618431c1dda1` |
| Loop schemas | `src/schemes/loop.ts` SHA-256 `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| Notification service | `jiborobot/srv-notification-ws@e42bfe01506a8febf3005ac536fda735bba49d0d` |
| Socket server | `jiborobot/srv-entrypoint-socket-ws` `src/socket-server.ts` (default branch) |

Established source facts used, not re-litigated:

- `loopSchema.postSave` calls `next()` immediately and defers `LoopUpdated`
  construction/send with `setImmediate`. `EventSender.send` is then
  fire-and-forget (`.then`/`.catch` log only).
- `LoopController.create` awaits `saveAndPopulate` (population I/O) before
  `LoopCreated`. No universal cross-event arrival order is claimed.
- `findOrCreateRobotAccount` saves the robot Account **before** the Loop
  save. That Account write can commit independently of the Loop write.
- The `LoopUpdated` notification handler uses `evt.payload.robot` as
  `accountId`, skill ID `-1`, and notification name `LoopUpdated`.
- notification-ws registers 16 event handlers and does **not** register
  `LoopCreated`. The robot socket path is LoopUpdated-only.
- `Notification.create` inserts a new document per event. Socket
  `ws.send` deletes that document only from a successful callback; an
  error leaves it for the next poll or `deliverAllPending` on reconnect.
  Source SNS/SQS plus that insert is at-least-once.

## What this candidate added

No production Account/Classic behavior was changed. The gate is proved by
new controls against the existing outbox, Store rename, Classic
NotificationStore, and socket reconnect path.

1. `packages/account/test/loopFlushInterruption.test.js` plus
   `scripts/parity-a04/interruptFlushChild.mjs` — a child SIGKILLs itself
   inside `Store.flush` (before or after rename) or inside the
   `LoopCreated` publisher. The parent reopens the store file and measures
   durable state. In-process rollback is not used as a stand-in for a
   kill.
2. `packages/classic/test/accountClassicReconnectInterruption.test.js` —
   signed Account HTTP + Classic notification socket. Injects socket
   loss, a throwing Account→Classic publisher, and a Classic persist
   whose Account outbox acknowledgement flush fails.
3. `scripts/parity-a04/run-interruption-recovery.mjs` — repeats those
   tests and records the pass/fail distribution.

CreateLoop flush injection skips the independent robot Account.save
(`skipFlushes: 1`) so the kill lands on the Loop+outbox snapshot, matching
source save order.

## Measured Phoenix results (3-of-3 each)

Command, three repeats, candidate `ad3bb58`:

```text
node scripts/parity-a04/run-interruption-recovery.mjs \
  --out .parity/reviews/a04-interruption-recovery-20260909/interruption-repeats.json
```

Result: **10/10 tests, 3/3 runs, 0 failures**. Every named case is 3-of-3.
Artifact SHA-256
`2acb06d801acb2e5ec76301fb6b92e15326b751dc19ba274c7c21868c4395ce4`.

| Injection | Durable state after reopen | LoopUpdated | LoopCreated | Following valid request |
| --- | --- | --- | --- | --- |
| `UpdateLoop` SIGKILL before rename | prior name; outbox 0 | 0 (not committed) | 0 | `UpdateLoop` publishes 1 |
| `UpdateLoop` SIGKILL after rename | new name; outbox 1, skill `-1`, `accountId=loop.robot` | 1 via `recover()`, 0 duplicate | 0 | `UpdateLoop` publishes 1 more |
| `CreateLoop` SIGKILL before Loop rename | robot Account durable; no new loop | 0 | 0 | `CreateLoop` emits both events |
| `CreateLoop` SIGKILL after Loop rename | new loop durable; outbox 1; no event file | 1 via `recover()` | **lost** (never queued) | `UpdateLoop` on recovered loop |
| `CreateLoop` SIGKILL in LoopCreated publisher | loop durable; outbox 1; event row 1 | 1 recovered | 1 recovered, 0 duplicate | pending rows empty |
| `RemoveLoopMember` SIGKILL before rename | member still `accepted`; outbox 0 | 0 | 0 | n/a (state unchanged) |
| socket down, `UpdateLoop`, reconnect | Classic holds 1 Notification until send | 1, 0 duplicate | 0 | `UpdateLoop` delivers 1 more |
| publisher throw + Classic/Account restart | mutation durable; Classic empty until recover | 1 recovered, 0 duplicate | 0 | `UpdateLoop` delivers 1 more |
| Classic persist then failed outbox ack | mutation durable; Classic 1, outbox 1 | **2 delivered (1 duplicate)** | 0 | socket then empty |
| `CreateLoop` while Classic publisher down | loop durable; LoopUpdated pending | 1 recovered, 0 duplicate | 1 via event outbox | `ListLoops` returns the loop |

Idempotency, stated rather than implied:

- Phoenix LoopUpdated is **at-least-once** across the Account outbox.
  A completed Classic persist whose Account ack flush fails is
  republished as a second Classic Notification document with a new `_id`
  and the same payload. Source `Notification.create` plus SNS/SQS is the
  same class of duplicate.
- A flush that never reaches rename commits **neither** the mutation nor
  the event. That is not a lost message; the save did not complete.
- LoopCreated after a completed Loop save is **lost** if the process dies
  before `dispatchLoopCreated` / `InvitationEventOutbox.send` commits.
  That matches source fire-and-forget after `saveAndPopulate`. Once the
  event outbox row exists, `recover()` delivers it once.

## `npm test`

Passing run at `ad3bb58`:

```text
npm test
# tests 918
# pass 911
# fail 0
# skipped 7
parity:check valid
parity:gate {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Log SHA-256
`db9fc74298c814c499a60857159ebc8be9c982383e7287e3e16c44461a22552c`.

Baseline at `5912ea4` was 908 / 900 / 0 / 8. This candidate adds 10 tests
(918 total). 911 pass / 7 skip versus 900 pass / 8 skip is the 10 new
passes plus one previously skipped environmental test executing in this
worktree (ffmpeg / compiled-FST skip set). No skip was removed here.

An earlier full-suite unit run failed once on the pre-existing
`RobotReadClient keeps one header deadline across redirects` control
(35 ms header deadline; `requests` stayed `[]`). Isolated rerun passed;
the full `npm test` rerun passed. Retained as
`npm-test.fail-robotread-flake.log`. That is not an interruption-gate
failure and this candidate did not change `RobotReadClient`.

## Evidence split

**Verified against pinned source text (not a live original runtime):**
post-save `setImmediate`, `saveAndPopulate` before `LoopCreated`, robot
Account.save before Loop.save, LoopUpdated handler routing (`robot`,
`-1`, name `LoopUpdated`), absence of a LoopCreated notification
handler, socket delete-on-successful-send, `Notification.create` per
event.

**Measured on Phoenix in this worktree:** both injection points, durable
snapshots, pending-row recovery, duplicate versus lost counts above, and
the next valid request after recovery. Repeats 3-of-3.

**Inferred from source reading, not measured on original processes:**
that a Mongo `save()` plus a later SNS send has the same crash windows
Phoenix models with rename and the outbox; that SQS at-least-once would
duplicate a LoopUpdated the way a failed outbox ack does.

**Unknown / not claimed:** original-server execution of these injections;
SNS/SQS reconnect; Mongo crash recovery; robot-socket reconnect on Moth;
membership races (gate 2); Account→Classic state sequences (gate 1);
query/projection edges (gate 4). Passing these unit tests is not A-04
parity.

## Concrete next step

Root should replay the two focused files and the 3-repeat runner from a
clean worktree at `ad3bb58`, then decide whether gate 3 is accepted as a
bounded Account→Classic interruption slice. Do not mark A-04 verified
from this candidate alone.
