> Root accepted the bounded disconnect/timeout slice; [final review](H-04-disconnect-root-20260907.md) supersedes the candidate status below. Historical evidence and its limitations remain recorded.

# H-04 disconnect and transaction-timeout validation candidate

Status: unverified candidate for root review.

This follow-up starts from frozen candidate `48f1428ed2fc66cb2044a7d1e470fad1d15cf256` and keeps the prior close receipts unchanged. It adds a real Phoenix WebSocket/controlled-HTTP regression and repairs the remaining transaction deadline difference found when the source and candidate were run on the same close schedule.

The source `TransactionHandler` does not call `reject()` when its 60,000 ms wrapper timeout fires. Its outer `getHandlePromise()` rejects with a plain `Error` lacking a machine-readable code, while the internal transaction promise remains pending. If an in-flight skill later completes, the source transaction can still resolve and perform its normal history side effect; the already-ended response drops the later skill frame. Phoenix previously called `tx.reject(new HubError(...))` from its timer, which set `STOPPED`, produced `INTERNAL`, and prevented that later internal resolution. `ListenTransaction` now races its internal promise against a separate timeout promise, preserving the source settlement layers and unlabelled transaction-timeout error.

The source close hook repair from `48f1428` remains in place: listen socket close does not resolve the transaction, while proactive close behavior is unchanged.

Source identity is Pegasus `5c0a7390539663ba749d360de348a428c088505c`; the original runtime is Node 8 image `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (`v8.9.4`). The controls use the executable original `ListenHandler`/`ListenTransactionHandler` with an EventEmitter socket and controlled HTTP peer; this is the original handler/message-reader sequence rather than a full original WebSocket server. Candidate close controls use actual Phoenix WebSocket transport.

Fresh evidence is under `/home/shell/work/phoenix/.parity/reviews/h04-disconnect-validation-20260907`:

* `source.json` and `source.stdout`/`source.stderr` are the pinned Node 8 source run.
* `candidate-after-fix.json` is the actual Phoenix WebSocket run.
* `comparison.json` records the raw settlement, machine-code, write-attempt, provider-completion, and history comparisons.
* `pre-fix-regression.log` is the actual regression run against a separately linked `6ca9d31` worktree; it exits 1 on the assertion that the old close hook settles an unfinished listen.

Both runners use the same event schedule: `open → LISTEN → CONTEXT → CLIENT_NLU → provider-request-end → close`. The close is an immediate transport termination at the controlled provider request boundary (`WebSocket.terminate()` for Phoenix and `socket.emit('close')` for the original handler control). The production transaction constant remains exactly 60,000 ms in both runners. To keep the controls bounded, only that timer is mapped identically per case:

| Case | Mapped transaction timer | Provider response delay | Expected source boundary |
| --- | ---: | ---: | --- |
| close before any message | 25 ms | none | outer timeout rejection; internal transaction still pending during observation |
| delayed completion after close | 300 ms | 20 ms | provider completes first; normal internal/outer resolution |
| timeout after close | 25 ms | 60 ms | outer timeout rejection first; provider and internal transaction complete later |

The aligned results are:

* **Close before any message:** source and candidate both reject the outer handler promise with an unlabelled transaction-timeout error, emit no provider request, have no internal resolve/reject event during the bounded observation, and attempt a final `ERROR` only after the response wrapper has ended. The error wording differs only by runtime formatting.
* **Delayed completion after close:** source and candidate both resolve normally after the provider response, write one history launch, attempt the final `SKILL_ACTION` after the response wrapper ended, and deliver only `SOS`, `EOS`, and non-final `LISTEN` before close. The controlled peer reports `responseSent: true` in both. Node 8 and Node 22 expose different low-level request/response close-event flags (`false` versus `true`); this is retained as runtime transport evidence rather than normalized.
* **Timeout after close:** source and candidate both reject the outer timeout promise without an error code, then resolve the internal transaction after the delayed provider response, write one history launch, and attempt both the dropped `ERROR` and dropped `SKILL_ACTION`. Both peers report provider completion and no cancellation before the response. The old candidate instead called `reject()` with `INTERNAL` and entered `STOPPED`; the aligned receipt demonstrates that this is repaired.

The focused actual regression is [listenTransaction.disconnect.integration.test.js](/home/shell/work/phoenix/.parity/worktrees/h04-disconnect-validation/packages/gateway/test/listenTransaction.disconnect.integration.test.js:22): it opens a real Phoenix WebSocket, sends the source-shaped message sequence, closes the transport as soon as the controlled skill peer finishes reading the request, waits for the delayed response, and asserts that no transaction settles at close, the provider completes, exactly one history side effect is recorded, and no post-close frame is delivered. It passes on this candidate and fails on the separately linked pre-fix `6ca9d31` worktree with `close must not settle an unfinished listen`.

Validation commands:

* `node --test packages/gateway/test/listenTransaction.disconnect.integration.test.js` — exit 0, 1/1.
* `node --test packages/gateway/test/listenTransaction.disconnect.integration.test.js packages/gateway/test/listenTransaction.disconnect.test.js packages/gateway/test/listenTransaction.history.test.js packages/gateway/test/listenTransaction.lifecycle.test.js` — exit 0, 11/11.
* `node candidate-close-validation.mjs candidate-after-fix.json` — exit 0; all three actual Phoenix WebSocket cases completed.
* Pinned Node 8 `docker run --rm --network none ... node /review/source-close-validation.cjs /reference /review/source.json` — exit 0; all three original handler cases completed. The runner exits after writing receipts because the intentionally delayed source HTTP client can retain handles after its handler outcome is recorded.
* The same integration test on the separately linked pre-fix `6ca9d31` worktree — exit 1, preserved in `pre-fix-regression.log`.

Workspace links were checked before testing: `node_modules/@phoenix/gateway` and `node_modules/@phoenix/common` resolved to this worktree. Scope remains gateway listen lifecycle only; proactive lifecycle, native ASR, deployed robot behavior, and deliberate cancellation of the underlying skill HTTP request remain open.
