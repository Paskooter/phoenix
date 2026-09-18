# R-03 — repeated restarts, persistence, and cross-robot isolation

Date: 2026-09-18  
Status: **bounded measured lane passes; publisher drain-on-shutdown remains unknown.**

This lane measures the real Phoenix native stack across process boundaries. It is not
an in-process unit test and it does not use Moth, Aero, the live account store, or the
live ports.

## Harness and scope

The runner is `scripts/parity-r03-restart-isolation/`:

* `run.sh` is the reproducible entry point;
* `run.mjs` starts `scripts/run-compose-stack.sh --no-env`, drives real WebSocket
  listen transactions, signs real Account `SuspendLoop` requests, and reads only
  harness-owned JSON stores;
* `lib.mjs` owns the port map, child environment, readiness, orderly stop, rebind
  probes, and receipt helpers;
* `run.test.mjs` tests the harness helpers without starting the stack.

The child environment is constructed from scratch. It sets `PHOENIX_ENV_FILE=/dev/null`,
uses `ETCO_account_dataFile` and `ETCO_history_dataFile` below the run directory,
uses loopback LLM and batch-only Parakeet fixtures, and shifts every contract service
by `--offset 700`.
The measured run therefore used ports 9700–9714, with 13 service listeners. The two
identities are synthetic `r03-account-a/r03-robot-a` and
`r03-account-b/r03-robot-b`.

The generated receipt is intentionally ignored by git and is at
`.parity/runs/r03-restart-isolation/receipt.json`. It records `phoenixRevision` and
`dirtyAtStart`; only a receipt with `dirtyAtStart: false` is citeable as clean evidence.
The clean run below was performed after the harness/report commit. The receipt is the
machine-readable source for all counts.

## Commands

Run from this worktree:

```bash
node --check scripts/parity-r03-restart-isolation/lib.mjs
node --check scripts/parity-r03-restart-isolation/run.mjs
node --test scripts/parity-r03-restart-isolation/run.test.mjs
scripts/parity-r03-restart-isolation/run.sh falsify --offset 700
scripts/parity-r03-restart-isolation/run.sh run --offset 700 --cycles 5 --timeout 60000
```

The lane intentionally does not run `npm test` or the repository-wide `node --test`
sweep.

## Verified result

The clean five-cycle receipt reports `ok: true`, zero failures, and these measurements:

| Check | Measured result | What was observed |
| --- | ---: | --- |
| Full-stack restart cycles | **5 starts / 5 stops** | All 5 cycles reached readiness for all 13 services. Each orderly stop returned launcher code 0. |
| Immediate port release | **65 / 65** | 13 bind-and-close probes after each of 5 stops; 0 failures and no live-cycle `EADDRINUSE`. |
| Concurrent cross-robot turns | **2 / 2** | Two sockets ran concurrently in cycle 1. Each emitted `SOS, EOS, LISTEN, SKILL_ACTION`, matched `answer-skill`, and wrote history with its own account, robot, and transId. |
| Account persistence | **2 / 2 after cycle 2; 2 / 2 after cycle 5** | Both signed `/api/verify` identities remained valid with their original friendly IDs after restart cycles. |
| Outbox persistence/isolation | **2 rows / 2 accounts** | SuspendLoop A created one durable row; after restart SuspendLoop B created a second. Final rows were account-specific, `attempts: 0`, `lastError: null`. |
| Pending-context teardown | **1 / 1** | A cycle-3 socket was left after `SOS` and `CONTEXT`, then the process was stopped. The old socket closed, remained at zero final frames, and did not receive a stale result. |
| In-flight server ASR teardown | **1 / 1** | A second cycle-3 socket entered server-side ASR with 200 ms of fixed PCM and emitted `SOS` without finalizing. After process stop its socket closed with zero final frames and the local Parakeet fixture saw zero `/transcribe` requests. |
| Disconnect isolation | **B 1 / 1; A 0 final frames** | In cycle 4, A disconnected while its loopback provider request was in flight. B completed one final `SKILL_ACTION`; B history was not attributed to A. |
| Durable history | **5 launches / 5 speech rows** | Final history contained the expected rows from the two concurrent turns, post-restart turn, surviving B turn, and disconnected A turn, with their recorded identities/transIds. |
| Queue/worker visibility | **2 retained / 0 attempts** | No notification publisher was configured in this native stack. Work was not silently deleted; the rows remained visible and unattempted. |

The receipt also records the measured rebind elapsed samples. They were 0–1 ms on
this host; this is a bind probe latency, not a claim about service shutdown latency.

## Falsification

The same harness has a deliberate held-listener control:

```bash
scripts/parity-r03-restart-isolation/run.sh falsify --offset 700
```

It binds a real listener on port 9700, runs the same rebind probe, and requires the
probe to report `EADDRINUSE`. The recorded control result was:

```text
holderReady=true
error=EADDRINUSE
restored=true
passed=true
```

This demonstrates that the port-release check can fail on a real leaked listener
rather than reporting a false pass. The measured stack run then released and rebound
all 65 ports successfully.

## Verified / inferred / unknown

### Verified by the receipt

* Five complete start/readiness/stop/rebind cycles of the native Phoenix stack.
* No listener leak across the 65 immediate rebind attempts.
* Two-account WebSocket routing and history attribution across concurrent sockets.
* Persistence of account identities, loop state, outbox rows, skill-launch history,
  and speech history across process restarts.
* A pending transaction/socket is closed by process stop without a final stale frame.
* An in-flight server-side ASR session enters `SOS` but does not produce a final
  frame or a `/transcribe` call after its process is stopped.
* One robot can disconnect mid-turn while the other robot completes normally.
* The held-listener falsification reports the expected `EADDRINUSE` and recovers.

### Inferred, not a separate proof

The absence of a final frame on the stopped socket is evidence that the old process
cannot deliver its pending result after stop; it is not proof that every possible
in-memory object is reclaimed. The account `/api/verify` and durable-store checks are
observable proxies for per-account cache isolation, not an exhaustive heap inspection.

### Unknown / not measured

* No notification publisher/worker was configured, so drain-on-shutdown behavior for
  an enabled publisher is unknown. This lane measured durable outbox retention and
  absence of silent deletion only.
* The original Pegasus runtime was not restarted in this lane; the source is used as
  the behavioral reference, not as a second live stack.

## Pinned-source context

The source revision is Pegasus `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`,
read through the archive MCP at <https://pvindex.org/mcp> with `gitea_read_file`.
Relevant source excerpts explain the state the probe deliberately exercises:

* [`ListenTransactionHandler.ts` lines 57–60](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L57-L60):
  > `private contextMessagePr = new utils.common.ExtPromise<ContextMessage>();`  
  > `private asrSession: ASRSession;`
* [`ListenTransactionHandler.ts` lines 386–389](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L386-L389):
  > `if (this.components.hubSettings.recordLaunchHistory) {`  
  > `this.contextMessagePr.promise.then(context => {`  
  > `this.recordSkillLaunch(skillID, this.nluData.intent, context);`
* [`SocketMessageReader.ts` lines 14–16 and 41–43](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/SocketMessageReader.ts#L14-L16):
  > `resolve promise when socket is closed`  
  > `this.socket.on('close', () => { resolve(); });`
* [`TransactionHandler.ts` lines 64–73](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/TransactionHandler.ts#L64-L73):
  > `public resolve() { ... }`  
  > `public reject(error: Error) { ... this.stop(); }`

These excerpts are source context, not a claim that Phoenix's JSON-store and process
supervision mechanisms are present in the original implementation.

No files under `packages/*/src` were modified. No production patch is proposed by
this lane; the result is an evidence boundary and identifies the publisher follow-up
and the loopback-ASR fixture limitation explicitly.
