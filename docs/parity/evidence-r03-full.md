# R-03 concurrency / throughput / queue / memory evidence

Captured from Phoenix revision `5a94708e8fb26089706b70e388c511044b9936f7` with Node `v22.22.0`.

This is bounded evidence, not a production capacity or formal memory-proof claim. The lane used the real Phoenix gateway WebSocket, real local HTTP parser and skill sockets, synthetic identities, and synthetic peer delays. It did not touch hardware, Moth, port 29000, port 443, or a live service.

## Verified

### Real-socket load

Command:

```sh
node --expose-gc scripts/parity-r03-reliability/real-load.mjs docs/parity/evidence-r03-full.json
```

The harness used 64 turns per arm, a 20 ms delay in each local parser/skill peer, and actual WebSocket clients. Every arm produced 64 parser requests, 64 skill requests, 64 terminal `SKILL_ACTION` frames, zero drops/errors, and zero trace mismatches. `peakInFlight` reached the requested arm concurrency.

| requested concurrency | turns | throughput/s | p50 ms | p95 ms | max ms | parser peer max active | skill peer max active |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 64 | 22.375 | 44.133 | 45.106 | 46.670 | 1 | 1 |
| 8 | 64 | 154.857 | 44.968 | 67.168 | 89.777 | 8 | 8 |
| 32 | 64 | 299.115 | 78.489 | 117.247 | 118.580 | 17 | 18 |
| 64 | 64 | 375.624 | 105.378 | 159.567 | 163.246 | 22 | 19 |

The throughput number is the harness's completed-turn count divided by arm wall time. It is not a claim that Phoenix sustains those rates against real parser/skill implementations; the peers are local and synthetic.

### Held-request queue saturation

The harness held 64 real parser HTTP responses open while 64 real gateway WebSocket turns were in flight. It observed:

- `parserPendingAtHold=64`, `parserActiveAtHold=64`, `parserMaxActive=64`;
- after release, all 64 parser requests settled and all 64 skill requests ran;
- drops/errors: `0`.

This demonstrates no rejection/drop at the tested hold size. It does **not** establish an unbounded queue or a production limit.

### Queue bounds

The actual Phoenix `StreamingAudioDecoder` rejected `2,097,153` bytes when its measured maximum pending encoded-input bound was `2,097,152` bytes, with `ERR_AUDIO_DECODE`; after abort, `queuedBytes=0` and no child remained.

A separate real-`ListenTransaction` probe sent 33 pre-session buffers of 65,536 bytes each (2,162,688 bytes) before a `LISTEN`/ASR session existed. The transaction retained all 33 buffers and rejected none. This is a verified staging-path gap: the decoder queue is bounded, but pre-session `audioChunks` staging has no byte check in the measured path. No source file was changed. Proposed follow-up is to put the same explicit byte budget at the staging boundary, reject/close on overflow, and test the race where `LISTEN` creates the ASR session while staged audio is being flushed.

Relevant Phoenix code: `packages/gateway/src/asr/audioDecoder.js#L13-L16,L357-L382` and `packages/gateway/src/listenTransaction.js#L129-L165`.

### Memory observation

With `node --expose-gc`, the harness ran six waves of 128 turns at concurrency 32: 768 turns total. After each wave it forced GC and asserted zero gateway sockets, zero active parser requests, and zero active skill requests.

Observed maximum post-GC deltas from the recorded baseline:

- heap used: `749,856` bytes;
- RSS: `6,959,104` bytes;
- heap total: `1,310,720` bytes;
- external and ArrayBuffer deltas: `0` bytes;
- live-resource leaks: `false`.

These are finite-run observations, not a formal all-duration bound. The pre-session staging result above is why a broad memory-bound claim would be false.

### Real timeout budgets and late work

The same gateway was exercised over real sockets with hanging local peers/session:

| phase | pinned budget | observed elapsed | final code | pending at timeout | late settlement | late wire frames |
|---|---:|---:|---|---:|---:|---:|
| parser | 10,000 ms | 10,003.397 ms | `PARSER` | 1 | 1 | 0 |
| skill | 10,000 ms | 10,006.084 ms | `TIMEOUT_SKILL` | 1 | 1 | 0 |
| context | 5,000 ms | 5,003.134 ms | `TIMEOUT_CONTEXT` | 0 | 0 | 0 |
| ASR | 40,000 ms | 40,002.866 ms | `ASR` | 0 | 0 | 0 |

The parser and skill HTTP requests were released after the timeout and settled without an additional robot-facing frame. This is source-faithful uncancelled work, not evidence that Phoenix should cancel those requests.

## Inferred from the pinned source

- The pinned `ConcurrentQueue` says: **“This queue guarantees that maxConcurrent handlers are running in parallel”** ([source, lines 11-13](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/ConcurrentQueue.ts#L11-L13)). When active work is full, lines 32-39 return `promiseToProcess(task)` and only warn when `pendingCount > 10 * maxConcurrent`; they do not reject or drop work ([lines 32-39](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/ConcurrentQueue.ts#L32-L39)). The source queue contract is therefore “bounded active concurrency plus warning,” not a hard pending queue cap.
- The pinned `timeout2` says it **“Returns either the value of the internal promise or the string 'TIMEOUT'”** ([lines 19-27](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/PromiseUtils.ts#L19-L27)); the same promise remains attached through `.then/.catch` at lines 28-31 ([source](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/PromiseUtils.ts#L28-L31)). The observed late parser/skill settlements match that contract.
- The pinned budgets are explicitly `40 s` ASR, `10 s` parser, `5 s` context and `10 s` skill ([lines 38-44](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L38-L44)). The parser timeout wraps `timeout2` at lines 307-322 ([source](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L305-L322)); the skill timeout wraps it at lines 397-414 ([source](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L395-L414)).

No pinned Pegasus runtime was executed. Those source statements are citations/inferences; the numbers above are Phoenix runtime measurements.

## Falsification

Command:

```sh
R03_SABOTAGE=wrong-skill-type R03_SKIP_ASR=1 \
  R03_TURNS_PER_ARM=4 R03_QUEUE_TURNS=4 \
  R03_MEMORY_WAVES=1 R03_MEMORY_TURNS=4 \
  node --expose-gc scripts/parity-r03-reliability/real-load.mjs scripts/parity-r03-reliability/sabotage.json
```

Expected result occurred: exit status `1`. The first corrupted terminal frame was reported as `SABOTAGED_NOT_SKILL_ACTION`, and the harness failed the `ok` assertion instead of counting it as a successful turn. This validates that the measurement control can say no.

## Unknowns

- No source-runtime differential, service restart sweep, or real ASR provider was used; ASR was a controlled hanging session to measure Phoenix's 40 s budget.
- The tested load is 256 measured turns across concurrency arms 1/8/32/64 plus a 64-turn held-request saturation. It does not establish production capacity, parser `maxConcurrent` configuration, or an unbounded queue limit.
- Six post-GC waves are not a long-running memory proof, and behavior under process/container memory pressure is unknown.
- The pre-session probe establishes retained staging at 2,162,688 bytes but does not characterize larger floods, staging after `LISTEN`, or the behavior when the ASR session starts concurrently with input arrival.

## Additional verification commands

```sh
node --check scripts/parity-r03-reliability/real-load.mjs
node --test scripts/parity-r03-reliability/peers.test.mjs
node --expose-gc scripts/parity-r03-reliability/real-load.mjs docs/parity/evidence-r03-full.json
```

The full machine-readable receipt is `docs/parity/evidence-r03-full.json`; the harness is `scripts/parity-r03-reliability/real-load.mjs`. The existing in-process peer tests remain in `scripts/parity-r03-reliability/peers.test.mjs`.
