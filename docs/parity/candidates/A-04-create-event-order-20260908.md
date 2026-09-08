# A-04 CreateLoop event-order follow-up

Status: **candidate; pending root review**.

Base: `1565dbdfbae422a542a021d8d013d8a1f2ad9cd3`.
Implementation commit: `fda30575d92653aac54a352ee050aa56f3950070`.

The pinned `jiborobot/srv-account-ws` source is revision
`6cea43470825657d6a5722162f28c8f233153ee2`. The exact source files and
hashes are recorded in
`.parity/reviews/a04-create-event-order-20260908/source-evidence.json`.
`loop.ctrl.ts` lines 145-153 await `saveAndPopulate`, then construct and
invoke the `LoopCreated` sender. The Loop save hook in `loop.ts` lines 76-82
delegates to `index.ts` lines 75-116, where the `LoopUpdated` event sender is
inside `setImmediate`. The source therefore establishes sender
invocation/enqueue order: `LoopCreated` first, then `LoopUpdated` in the
later check phase. It does not establish network arrival order after either
sender returns.

`LoopUpdatedOutbox.record()` still commits the event row synchronously with
the successful loop snapshot. Automatic publication now hands off through a
single `setImmediate`; the scheduled promise remains exposed through
`outbox.draining` for existing callers. Explicit `drain()`/`recover()` remain
available for immediate startup recovery. If another loop event is recorded
while a drain is awaiting its publisher, the existing follow-up pass is
preserved. A rejected outbox snapshot still rolls back the row and does not
schedule a publisher, so `saveLoop` can restore the detached loop draft as
before.

The focused source-shaped control in
`packages/account/test/loopCreationEventOrder.test.js` observes
`LoopCreated` before the deferred `LoopUpdated` publisher and verifies a
failed snapshot leaves the file, in-memory row set, and publisher state
unchanged. The fresh receipt is
`.parity/reviews/a04-create-event-order-20260908/event-order-followup.json`;
it records `beforeTurn=["LoopCreated"]`, one durable pending row,
`afterDrain=["LoopCreated","LoopUpdated"]`, and zero pending rows. The
receipt uses synthetic accounts/robots only.

Validation from this worktree:

- `node --test packages/account/test/loopCreationEventOrder.test.js packages/account/test/loopUpdatedNotification.test.js packages/account/test/loopUpdatedOutboxConcurrency.test.js` — 10 passed, 0 failed.
- `node --test packages/account/test/loopCreation.test.js packages/account/test/loopCreationTransport.test.js` — 5 passed, 0 failed.
- `git diff --check` — clean.

This candidate changes sender invocation scheduling for the durable Phoenix
outbox only. It does not assert or control the ordering of messages after
the LoopCreated and LoopUpdated transports accept them. Public gateway
authentication, notification service deployment, and complete A-04
acceptance remain outside this bounded repair.
