# R-03 — reliability, limits and observability

Date: 2026-09-18
Implementation revision: `ce1d6df` (integration `550fb83`)
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`

Four independent lanes were dispatched as Hermes subagents in isolated worktrees,
each owning one clause, then **root re-ran every lane rather than trusting the
reports**. The numbers below are root's own runs unless a line says otherwise.
Every lane was forbidden from editing `packages/*/src`; the one defect they found
was fixed by root, reviewed against pinned source, and falsified.

| Lane | Harness | Clause |
| --- | --- | --- |
| concurrency | `scripts/parity-r03-reliability/real-load.mjs` | 1, 2 |
| timeouts | `scripts/parity-r03-reliability/real-run.mjs` | 1, 2 |
| observability | `scripts/parity-r03-observability/run.mjs` | 3 |
| restarts | `scripts/parity-r03-restart-isolation/run.sh` | 1, 2 |
| budgets | `scripts/parity-r03-reliability/budgets.mjs` | 1 |

## Clause 1 — latency and throughput against the pinned budgets

Budgets are pinned in `packages/contracts/src/constants.js` (source:
`ListenTransactionHandler.ts:37-43`).

| Budget | Advertised | Measured | Outcome |
| --- | ---: | ---: | --- |
| parser | 10 s | 10 007 ms | code `PARSER`, peer still open, 0 late frames |
| skill | 10 s | 10 006 ms | code `TIMEOUT_SKILL`, peer still open, 0 late frames |
| context | 5 s | 5 001 ms | code `TIMEOUT_CONTEXT`, 0 peer requests |
| asr | 40 s | 40 004 ms | code `ASR` |
| transaction | 60 s | 60 001 ms | `Maximum transaction time of 60000 exceeded` |
| wsMax 180 s / closeAfterFinal 2 s | — | not driven, by design | see below |

Throughput, real gateway WebSockets against real loopback HTTP parser and skill
peers, 64 turns per arm:

| Concurrency | turns/s | p50 | p95 | max |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 22.4 | 44.1 ms | 45.1 ms | 46.7 ms |
| 8 | 154.9 | 45.0 ms | 67.2 ms | 89.8 ms |
| 32 | 299.1 | 78.5 ms | 117.2 ms | 118.6 ms |
| 64 | 375.6 | 105.4 ms | 159.6 ms | 163.2 ms |

Every arm produced 64 parser requests, 64 skill requests and 64 terminal
`SKILL_ACTION` frames, with zero drops, zero errors and zero trace mismatches.
Held-request saturation (64 pending parser requests) released all of them: 64
settled parser calls and 64 skill calls ran after release.

**The two long budgets nobody had driven.** `scripts/parity-r03-reliability/budgets.mjs`
measures them directly. Note what the transaction timeout does *not* do: it rejects
the outer handle with **no HubError code**, which is the reference's behaviour — its
timeout promise does not stop the state machine or add a code.

**Why 180 s and 2 s are not driven.** `Timeouts.wsMax` maps to
`TIMEOUT_MAX_DURATION` and `closeAfterFinal` to `TIMEOUT_CLOSE_AFTER_FINAL`, and
`responseWrapper.js:7-15` documents that neither can close a socket in the reference
either, because `closed` starts `true` while only `socket.onclose` sets it. The
captured original shows `connectionOpenAfterFinal: true` then
`clientCloseAfterFinal: true`: **the client closes on the final frame**. Waiting
180 s would measure a timer that is dead code on both sides, so the premise is pinned
by a test instead (`listen.audioStaging.test.js`).

## Clause 2 — bounded memory and queues, cancellation, isolation, error/retry

**Memory.** Six waves of 128 turns at concurrency 32 (768 turns), post-GC maximum
deltas: heap used 749,856 B, RSS 6,959,104 B, heap total 1,310,720 B, external 0,
ArrayBuffer 0, no live-resource leaks. Honest scope: six waves is not a formal
long-run bound, and behaviour under process memory pressure is unknown.

**Queues.** The decoder enforces a 2,097,152-byte pending-input limit: 2,097,153
attempted bytes are rejected with `ERR_AUDIO_DECODE`, `queuedBytes` returns to 0 and
no child process remains.

**Audio staging — the one real defect this clause surfaced, and what it actually is.**
The concurrency lane measured pre-session staging retaining 2,162,688 bytes without
rejection. Checking it against pinned source gave a narrower answer than the report
implied:

* the reference keeps `audioStream` (a plain Duplex) live from construction and writes
  into it unconditionally, so pre-session audio is retained there too — **there is no
  byte cap in the source at all**, and adding one would be an invention;
* what the reference *does* do is end **and null** the stream in `stopASR()`, after
  which `handleAudio` drops every packet ("audio stream is closed"). Phoenix kept
  buffering whenever no session existed, so audio arriving during the NLU and skill
  legs sat in a buffer nothing would read. **That is the divergence, and it is fixed**
  (`ce1d6df`): the path closes at `_stopASR()` and `abandon()`, and `_performASR`
  reopens it so a later turn still stages.
* the outer bound is therefore the client's close, not a server timer — which the test
  pins so an accidental server-side close would be a deliberate change.

**Cancellation.** Parser and skill timeouts do **not** cancel the in-flight peer
request, and the late settlement emits zero additional frames. This is
**source-faithful, not a defect**: `PromiseUtils.timeout2` resolves the string
`'TIMEOUT'` and leaves the underlying promise running. Client-ASR cancellation is
cooperative (session stopped, `aborted: false`, 3,200 accepted bytes retained, zero
transcribe requests); websocket abandonment is destructive (stopped *and* aborted,
buffered bytes to zero, zero transcribe requests).

**Isolation.** 24 concurrent turns across 3 rounds each resolved on their own
`SKILL_ACTION` with their own `transId`/`robotID`; two accounts and robots ran
concurrent isolated turns; a robot disconnecting mid-turn produced 0 final frames
while the other produced 1. Across five restart cycles, identities, loop state,
outbox rows, launch history and speech history persisted with no cross-account
attribution.

**Restarts.** Five full-stack start/readiness/stop cycles, all 13 services ready each
cycle, 65/65 bind-and-close probes passing with rebind samples of 0–1 ms. A pending
transaction and an in-flight ASR session both closed on stop with zero stale final
frames.

**Error codes.** Parser failure reaches the client as `PARSER` (the source rethrows
`PARSER` over its own `TIMEOUT_PARSER`), skill as `TIMEOUT_SKILL`, context as
`TIMEOUT_CONTEXT`, ASR as `ASR`.

## Clause 3 — trace, logging, health and configuration

**Trace.** `x-jibo-transid`, `x-jibo-robotid` and `x-jibo-logging-config` propagate
verbatim across three real HTTP calls (parser, speech, skill).

**Logging.** `packages/common/src/log.js` always emits `t`, `level`, `ns`, `msg`;
`transId` is conditional; `robotId`/`loggingConfig` are not automatic fields. A
malformed logging config is ignored and the global threshold stays active.

**Health — the defect this clause found, now repaired.** The lane measured the
History store operation returning 500 while `/healthcheck` still answered `200 ok`.
Pinned `HistoryService.getHealthcheckResponse` overrides the shared response with
`{status, skillLaunchDB, speechHistoryDB}` and a 200/500 status, and `createService`
could not express a status code at all. Both are now fixed: History answers **500**
with `status: 'error'` and `DISCONNECTED` when its store is unusable, verified by
corrupting the committed snapshot, and it **recovers without a restart** once a write
heals it. The body keeps exactly the source's three members — the failure reason goes
to the log rather than being added as a fourth member. The other seven services stay
on the shared literal `ok`, asserted directly (`overrides == ['history']`).
`DIVERGENCES` I-01b is now marked repaired. Falsification: forcing the probe to report
`CONNECTED` unconditionally fails two named tests.

**Configuration.** Measured precedence and failure modes: source default port 8080,
`ETCO_server_port` 8123, argv wins with 8124, `PORT` alias 8125, scoped `ETCO` LLM
URL/model override `PHOENIX` values. Malformed values are **not** uniform, and this is
recorded rather than fixed: a malformed `ETCO_server_port` yields `NaN`, a malformed
scoped LLM timeout silently falls back to the shared default 10000 rather than the
scoped 6000, a malformed news interval falls back to 3,600,000 ms, and a malformed
account timeout **throws**. Silent fallback on a malformed value is a
falsely-healthy configuration state and is called out here as a known weakness.

**Metrics.** There is no metrics surface to measure, and that is a finding rather than
a gap: the pinned source contains **zero** occurrences of `prometheus` across the
Gitea mirror, and the Prometheus metrics mentioned in the archive's *Pegasus load
testing plan* belong to the ASR/NLU **mock services** used for load testing, not to
any shipped service. The observability surface Phoenix must be faithful to is the
trace headers, the JSON logs and the healthcheck.

## Falsifications

Each harness was shown able to report a failure it should catch:

* **concurrency** — sabotage control exits 1 and reports `SABOTAGED_NOT_SKILL_ACTION`
  for the corrupted terminal frame instead of counting the turn as successful.
* **timeouts** — the validator rejects a fabricated `TIMEOUT_PARSER` code.
* **observability** — the false-health check fails if the probe is made to always
  report `CONNECTED`; and the inventory fails if a service other than History grows a
  healthcheck override.
* **restarts** — falsify mode holds a listener and reports `EADDRINUSE` rather than
  masking every rebind failure.
* **staging** — removing the drop fails three named tests.

## What this does not establish

* No pinned-reference **runtime** differential: the source was read and cited, not
  executed, because the original services are dead.
* No real ASR provider beyond the Parakeet deployment, and no hardware in any lane.
* Six memory waves are not a long-run bound; behaviour under memory pressure is
  unknown.
* The load sweep does not establish production capacity or a queue limit for the
  parser service, whose `ConcurrentQueue` (source) guarantees `maxConcurrent` active
  handlers and merely warns above 10x pending — it never rejects or drops.
* Malformed-configuration behaviour is recorded, not repaired.
* Drain-on-shutdown for an enabled notification publisher was not exercised: no
  publisher was configured in the native stack, and both outbox rows remained visible
  and unattempted.
