# A-10 LoopUpdated outbox concurrent-drain follow-up

Status: candidate, pending root review. This follow-up starts at frozen `7f56d06fe84ed160e02252b6a7b76a0e750b8152` in `/home/shell/work/phoenix/.parity/worktrees/a10-loop-producer-concurrency`, branch `codex/candidate-a10-loop-producer-concurrency-20260907`. It changes only the Account LoopUpdated outbox drain and its focused tests, plus the existing A-10 report's description of fixture request authentication. Main, frozen candidates, source caches, robots, services, goldens, and comparators were not changed.

## Repaired race

`LoopUpdatedOutbox.drain()` iterates a snapshot of pending rows. On the frozen candidate, a second `record()` made while the first publisher was awaiting its bridge joined the existing promise but did not request another pass; the second row stayed pending until an explicit `recover()`. Root's reproduced control is retained at `/home/shell/work/phoenix/.parity/reviews/a10-loop-producer-root-20260907/concurrent-drain.json` and identifies the frozen candidate and the before/after recovery state.

The candidate adds a `drainRequested` flag. A call to `drain()` made while a pass is active requests exactly one microtask follow-up after that pass settles. This includes an enqueue committed during an awaited publisher and an explicit concurrent recovery call. A publisher rejection or acknowledgement-flush failure alone does not request another pass, so a permanently failed bridge cannot create a tight retry loop. Rows remain durable for a later explicit recovery. Drain startup itself is contained so a rejected background promise does not become an unhandled rejection.

## Controls

The focused candidate command was:

```text
node --test packages/account/test/loopUpdatedNotification.test.js packages/account/test/loopUpdatedOutboxConcurrency.test.js
```

It exited `0` with 7 tests passing. The two new controls use a real `Store` and `LoopUpdatedOutbox`, an awaited publisher gate, and durable outbox rows. The success control records `first-loop`, enqueues `second-loop` while the first publisher is suspended, releases the gate, and verifies both rows publish without explicit recovery. The failure control rejects `first-loop`, enqueues `second-loop` during the await, verifies one follow-up pass retries the retained first row and publishes the second, and verifies no further attempts occur after the pass settles.

The complete Account test command was:

```text
node --test packages/account/test/*.test.js
```

It exited `0` with 124 tests passing. Raw outputs are retained at:

- `/home/shell/work/phoenix/.parity/reviews/a10-loop-producer-concurrency-20260907/candidate-account-tests.tap` (7 focused producer/regression tests)
- `/home/shell/work/phoenix/.parity/reviews/a10-loop-producer-concurrency-20260907/account-tests.tap` (124 Account tests)

The candidate worktree has private `node_modules` and `@phoenix/*` links resolving to this worktree. The implementation revision is `6e84c4ec02051b6bf4a879f9ce570012d7d604c1`.

## Authentication wording correction

The prior A-10 producer report described fixture HTTP requests as using “signed caller keys.” That wording was corrected in `A-10-loop-updated-producer-20260907.md`: those tests supply `Signature=fixture` AWS headers and exercise Phoenix's access-key parsing/LAN-trust compatibility seam; they do not cryptographically verify the signature. Real SigV4 verification and the Account-to-notification event bridge remain outside this bounded producer candidate.

## Remaining scope

The publisher remains an explicit Account-to-notification seam. This repair does not add SNS/SQS, cross-process locking, Mongo transactions, or automatic retries after an isolated bridge failure. Account suspension is still the only Phoenix producer path covered by the prior candidate; other Loop saves and the complete source event bus remain open. Root must review and integrate the candidate before assigning A-10 acceptance.
