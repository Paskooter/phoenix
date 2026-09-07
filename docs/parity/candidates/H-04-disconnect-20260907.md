> Root accepted the bounded disconnect/timeout slice; [final review](H-04-disconnect-root-20260907.md) supersedes the candidate status below. Historical evidence and its limitations remain recorded.

# H-04 disconnect, timeout, and session reset candidate

Status: unverified candidate for root review.

This slice starts at `6ca9d31` (`codex/candidate-h04-session-lifecycle-20260907`) in a new worktree. It fixes one gateway lifecycle boundary: a listen WebSocket close no longer resolves the listen transaction. The original `SocketMessageReader` resolves its read promise on close, while `ListenHandler` continues awaiting `TransactionHandler.getHandlePromise()`. That transaction completes normally or rejects at the source 60-second transaction timeout. Phoenix previously called `tx.resolve()` for every WebSocket close, which made an unfinished listen appear successful and settled it while a skill request was still active.

`bindTransactionClose` now retains the existing close resolution only for proactive transactions. The listen path continues through its normal skill completion or timeout, and `ResponseWrapper` still suppresses writes after the client has closed. The focused regression tests cover both branches. No timeout constants, skill request cancellation policy, ASR, Person/common code, or proactive transaction behavior changed.

The pinned source is Pegasus `5c0a7390539663ba749d360de348a428c088505c`; the Node 8 image is `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (`v8.9.4`). Relevant source hashes are:

| Source file | SHA-256 |
| --- | --- |
| `packages/hub/lib/listen/ListenHandler.js` | `ec2da268877f1bac04e412a744b4a3660857fc8bfafd12e2bfcb3be4e6e814fd` |
| `packages/hub/lib/utils/TransactionHandler.js` | `b8af80fab015578d97b04281e0cfe8ffba1535563349f471f2f18bb345fb2cca` |
| `packages/hub/lib/utils/SocketMessageReader.js` | `4d06d6b66e6e8ddaa0ac2db2b2d12de22c82ce9e0d69b668e4f33fab39d29863` |
| `packages/hub/lib/skill/SkillRequestMaker.js` | `0271eacf5997c807f822fedc92baec68fbff357e555e2df516cef77b5b6bf1af` |

The fresh evidence is in `/home/shell/work/phoenix/.parity/reviews/h04-disconnect-20260907`. `source-close-control-node8-v3.json` uses the executable original handler and message reader with an EventEmitter socket plus a controlled HTTP skill peer; it is not a full original WebSocket server. The candidate close and timeout controls use actual Phoenix WebSocket transport. `comparison.json` retains the normalized machine-readable comparison, while each raw JSON/stdout/stderr receipt remains alongside it.

The close-before-final control maps only the source's 60,000 ms transaction timer to 25 ms in both the original runner and a direct candidate model. The original rejects at the mapped timeout with no post-close frame. The pre-repair candidate close hook resolved immediately. After the repair, the direct candidate model remains pending on close and settles after the delayed skill promise, matching the source lifecycle. The actual Phoenix WebSocket control closed the client before the delayed skill response, recorded `SOS`, `EOS`, and non-final `LISTEN`, saw the peer finish its delayed response, and emitted no post-close frame.

The skill-timeout control maps the source and candidate 10,000 ms skill budget to 25 ms against a nonresponding controlled peer. Both produce `SOS`, `EOS`, non-final `LISTEN`, and final `ERROR` with machine-readable `code: TIMEOUT_SKILL`. Their diagnostic message wording differs; this remains a qualified wording difference. Both leave the underlying HTTP request uncancelled by the timeout, which matches the source `PromiseUtils.timeout2`/`SkillRequestMaker` structure and remains open as a broader cancellation concern.

The session-reset control runs two independent turns after the first final response. Original Node 8 and Phoenix each send `LISTEN_LAUNCH` twice, with four frames per turn (`SOS`, `EOS`, `LISTEN`, `SKILL_ACTION`). No prior skill session leaks into the second turn. Existing accepted continued-session/update and redirect evidence remains unchanged.

Commands and exits:

* `node --test packages/gateway/test/listenTransaction.disconnect.test.js packages/gateway/test/listenTransaction.lifecycle.test.js` — exit 0, 4/4.
* `node candidate-real-disconnect.mjs candidate-real-disconnect-after-fix.json` — exit 0; actual Phoenix WebSocket close-before-final control, one peer request, delayed peer response completed, no post-close frame.
* `node candidate-real-timeout.mjs candidate-real-timeout.json` — exit 0; actual Phoenix WebSocket timeout control, one nonresponding peer request, final `TIMEOUT_SKILL` error.
* `node candidate-session-reset.mjs candidate-session-reset.json` — exit 0; two actual Phoenix WebSocket turns, both `LISTEN_LAUNCH`.
* `docker run --rm --network none ... node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c node /review/source-close-control.cjs ...` — exit 0; original Node 8 close and timeout controls. The runner explicitly exits after writing its receipt because the intentionally nonresponding timeout peer leaves source client handles alive after the source transaction has settled.
* The same pinned Node 8 command with `source-session-reset.cjs` — exit 0; original two-turn session reset control.

Workspace verification before testing resolved `node_modules/@phoenix/gateway` and `node_modules/@phoenix/common` to this worktree's `packages/gateway` and `packages/common`. Remaining scope includes source/client acceptance on deployed robots, proactive close behavior, native ASR, and whether the underlying HTTP skill request should be actively cancelled after a client disconnect or timeout.
