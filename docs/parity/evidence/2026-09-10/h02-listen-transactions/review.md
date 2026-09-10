# H-02 — listen transaction ordering, cancellation and failure behaviour

- Task: `H-02` (`docs/parity/tasks.json`), P0, track `pegasus`, implementation `partial`.
- Worktree `/home/shell/work/phoenix/.parity/worktrees/w3-h02`, branch `w3/h02`, base revision `62f9c2697580f40c5c796554849fef2624f936d3`.
- Reference pin: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c` (also on disk at
  `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`).
- Captured-original fixture (V-01 executed reference run):
  `docs/parity/evidence/2026-09-05/reference/transactions.json`.

Claim labels used below:

- **VERIFIED** — observed in this environment (live process/socket output), or read from a captured
  original run whose artifact is checked in.
- **INFERRED** — reasoned from pinned source; the original binary was not executed here.
- **UNKNOWN** — not observable with the tools available; stated with what would be needed.

## 1. Acceptance criteria and verdict

| Acceptance bullet | Verdict | Where |
|---|---|---|
| Replay SERVER_ASR, CLIENT_ASR and CLIENT_NLU transactions with reordered/delayed/duplicate/malformed messages and both endpoint aliases | **VERIFIED** (runtime) | §4.1–§4.4, §4.9 |
| Verify exactly one terminal outcome, SOS/EOS ordering, close timing, all timeout/error codes, disconnect cleanup and no late writes | **VERIFIED** except the 3-minute max-duration timer (**INFERRED**), and late/duplicate behaviour of the *original* under real concurrency (**INFERRED**) | §4.5–§4.8, §8 |
| Exercise local/global turns, speaker/context updates and empty/garbage audio using the original client framing | **VERIFIED** for local turns, delayed/duplicate CONTEXT, empty (SOS-timeout) and GARBAGE audio; the global turn is a Phoenix extension whose original behaviour is **INFERRED** | §4.4, §4.10, §10.1 |

Three client-visible defects were reproduced at runtime, fixed, and pinned by tests (§3). One is a
confirmed mismatch against the captured original (`PARSER` code), one is a confirmed mismatch against
the pinned close guard, and one is an ordering/cancellation defect that the pre-fix code demonstrably
produced on the wire.

## 2. The pinned contract

### 2.1 What a listen transaction is

One WebSocket == one transaction (`listen/ListenHandler.ts:26-45`: a new `ListenTransactionHandler`
per socket; `TransactionHandler` wraps it in a 60 s deadline, `utils/TransactionHandler.ts:13,42-43`).
States and legal transitions are `ListenTransactionHandler.ts:25-34,175-219`. `handleMessage`
(`:111-123`) dispatches audio frames and `LISTEN`/`CONTEXT`/`CLIENT_ASR`/`CLIENT_NLU`, ignores the
deprecated `SPEAKER_ID`, and rejects anything else (`:156-161`).

Robot-facing shapes: `SOS`/`EOS` carry `data: null` (`:647-673`), `LISTEN` carries
`{asr, nlu, match}` plus `final` + `timings {total, asr, nlu}` (`:675-696`), a skill response is
forwarded verbatim with only `final`/`timings` overwritten (`TransactionHandler.ts:99-108`), and a
failing transaction ends with one `ERROR {data:{code, message}}` frame that ListenHandler writes with
`writeFinal` (`ListenHandler.ts:46-60`).

Timeouts (`ListenTransactionHandler.ts:36-42`): transaction 60 s, ASR 40 s, parser 10 s, context 5 s,
skill 10 s.

### 2.2 Ordering guarantees

- A client-driven turn emits `SOS(-1)` on `LISTEN{mode}` (`:239,:242`), `EOS(-1)` when the client
  transcript/NLU arrives (`:265,:287`), then one `LISTEN`, then `final` when the turn settles.
- A server-driven turn emits `SOS` at start-of-speech and `EOS` at end-of-speech (`:511-530`).
- A `GARBAGE` ASR annotation short-circuits straight to a final `LISTEN` (`:468-476`).
- "Exactly one terminal outcome" means exactly one frame with `final: true`. It does **not** mean one
  `SOS`/`EOS` pair: neither implementation guards a repeated `CLIENT_ASR` (`:252-267` has only the
  `state === ASR` cancel), so a repeat re-emits `EOS` and its `NLU` transition is rejected as invalid
  (§4.4). The captured originals show one non-final `LISTEN` followed by one final skill frame
  (`hub-listen-launch`) or one final `LISTEN` (`hub-listen-no-match`).
- After a `final` write the response is *ended* and further writes are dropped
  (`BaseWebsocketHandler.ts:95-99`).
- Close timing: the socket is **not** closed by the hub. `closed` is initialised to `true`
  (`BaseWebsocketHandler.ts:26`) and only `socket.onclose` ever sets it (`:39-43`), so the guarded
  `closeBecauseOfTimeout` (`:132-138`) can never fire — not for `TIMEOUT_CLOSE_AFTER_FINAL` (2 s) and
  not for `TIMEOUT_MAX_DURATION` (3 min). The client is responsible for closing and does so on the
  first `final` frame (`hub-client/src/session/ClientSession.ts:21-26,49-51`). The captured original
  records it: `hub-listen-launch` has `connectionOpenAfterFinal: true` at 50 ms and
  `clientCloseAfterFinal: true`.

### 2.3 Cancellation

Three mechanisms exist in the pinned handler:

1. `stop()` → `gotoState(STOP)` → `done()` → `resolve()` (`:167-170,191-193,368-370`); it is reached
   from `TransactionHandler.reject()` (`utils/TransactionHandler.ts:70-74`).
2. A client-supplied turn cancels an in-flight server ASR: `if (this.state === State.ASR)
   this.stopASR()` in `handleClientASRMessage` (`:253-256`) and `handleClientNLUMessage`
   (`:274-276`).
3. Leaving the `ASR` state cancels it: `_exitCurrentState()` → `stopASR()` (`:221-226`), called by
   `_gotoStateIfValid` (`:209`).

`stopASR()` (`:439-450`) stops the session, drops the audio stream, and clears the SOS / max-speech
timers. `_performASR` also stops the session in a `finally` (`:542-544`).

**UNKNOWN (real provider):** whether the original `ASRSession.stop()` detaches its own callbacks so a
late `onStartOfSpeech`/`onEndOfSpeech`/`start()` result is impossible. The reference's own timeout
test (`hub/tests/listen/ListenHandlerTimeouts.test.ts:78-92`) relies on a mocked session whose
`start()` returns `undefined` once stopped, which is why the `if (asrData)` guard at
`ListenTransactionHandler.ts:462` exists.

### 2.4 Failure modes

| Failure | Emitted code | Citation |
|---|---|---|
| malformed JSON text frame | none (`data.message` only) | `SocketMessageReader.ts:54-56` → `ListenHandler.ts:53` |
| unknown message type | none | `:156-157` |
| invalid `LISTEN.mode` | none | `:245` |
| parser HTTP failure | `PARSER` | `:319-321`, captured in `hub-listen-provider-failure` |
| parser timeout | `PARSER` (the `TIMEOUT_PARSER` throw is inside the same `try`, so the catch re-wraps it) | `:304-321` |
| missing CONTEXT (5 s) | `TIMEOUT_CONTEXT` | `:296-299,335-338` |
| ASR provider failure | `ASR` | `:479-481` |
| ASR timeout (40 s) | `ASR` (the `TIMEOUT_ASR` throw is inside the same `try`, so the outer catch re-wraps it) | `:456-481` |
| skill failure / timeout | skill `ERROR` frame / `TIMEOUT_SKILL` | `TransactionHandler.ts:88-98`, `:397-398` |
| whole-transaction deadline (60 s) | none (`Error`, not `HubError`) | `utils/TransactionHandler.ts:42-43` → `ListenHandler.ts:53` |

Codes are `interfaces/src/hub/HubErrorCode.ts:5-24`; `PARSER` is one of them (`:21`). Message text
comes from `utils-common/src/Utils.ts:30-38`; note the original's parser failure text is axios'
`Request failed with status code 503`, while Phoenix's own `ParserClient` says `parser 503`
(`packages/gateway/src/parserClient.js:24`) — wording only, see §10.3.

## 3. Defects reproduced at runtime, fixed, and pinned

Every "before" value below is a real capture from the same probe run against the pre-fix source
(`probe-before.json`), produced by stashing only `packages/gateway/src` + `packages/contracts/src`
and re-running `probe.mjs`. The fix was then restored (`sha256sum -c` verified).

### 3.1 A parser failure lost its code → fixed to `PARSER`

- Before (wire): `{"type":"ERROR","final":true,"data":{"message":"parser 503"},"timings":{"total":34}}`
  — **no `code` key at all**.
- Captured original: `{"type":"ERROR","data":{"code":"PARSER","message":"Request failed with status code 503"},"final":true}`
  (`hub-listen-provider-failure`).
- After (wire): `"data":{"code":"PARSER","message":"parser 503"}`.
- Parser **timeout** was also wrong: before `"code":"TIMEOUT_PARSER"`, after `"code":"PARSER"`,
  matching the pinned double-wrap at `ListenTransactionHandler.ts:304-321`.
- Root cause: `HubErrorCode` did not contain `PARSER` and `_performNLU` never wrapped parser errors.
- Fix: `packages/contracts/src/constants.js` (full pinned enum restored, `PARSER` included) and a
  try/catch in `packages/gateway/src/listenTransaction.js` `_performNLU`.

### 3.2 The hub closed the socket ~2 s after the terminal frame → fixed to stay open

- Before (probe, 3 s of observation after the terminal frame):
  `socketOpenAfterTerminal: false`, `serverClosedSocket: true` — the **hub** closed it.
- After: `socketOpenAfterTerminal: true`, `serverClosedSocket: false`, `clientCloseObserved: true`.
- Captured original: `connectionOpenAfterFinal: true`, `clientCloseAfterFinal: true`.
- Root cause: `packages/gateway/src/responseWrapper.js` initialised `closed = false`; the pinned
  class initialises it to `true` (`BaseWebsocketHandler.ts:26`), which makes both timeout closes
  no-ops.
- Fix: `this.closed = true` and a corrected header comment. This affects the proactive path too,
  which uses the same wrapper — the pinned proactive handler shares `BaseWebsocketHandler`, so the
  change is consistent there as well.

### 3.3 A superseded server ASR phase emitted SOS *after* the client's EOS and overwrote the transcript

This is the strongest finding; it is a state/order/timing defect, not wording.

- Before (in-process, provider answers after `CLIENT_ASR`):
  - frames: `["EOS","SOS","EOS","LISTEN"]` — a `SOS` arriving **after** the client's `EOS`, then a
    second `EOS`.
  - the terminal `LISTEN` reported `data.asr.text = "stale server words"` instead of the client's
    `client words`.
  - `session.stopped` at the moment `CLIENT_ASR` was handled: `false`.
- After: frames `["EOS","LISTEN"]`, `finalAsrText: "client words"`, `stoppedOnClientASR: true`.
- Pinned contract broken by the before-state: `ListenTransactionHandler.ts:253-256` (cancel the ASR
  phase), `:221-226` (cancel when leaving `ASR`), `:462` (`if (asrData)` — a stale/absent result must
  not be assigned).
- Fix in `listenTransaction.js`: `_stopASR()`, `_cancelASR()`, cancellation on `CLIENT_ASR`/
  `CLIENT_NLU` and on any transition out of `ASR`, an `asrCancelled` guard on the ASR callbacks and
  timers, an `asrCancelled || state !== ASR` guard on the late result, and the `if (out)` guard. SOS /
  max-speech timers moved from closure locals to instance fields so `_stopASR` can clear them, exactly
  as the original does (`:60-61,448-449,575-581`).

### 3.4 `TIMEOUT_ASR` was reachable on the wire; the original never emits it

- Before: an ASR provider failure emitted `"code":"ASR"` (already correct), but the ASR **timeout**
  path threw `TIMEOUT_ASR` and was preserved by an `err instanceof HubError` escape.
- Pinned: the ASR timeout throw at `:457-458` sits inside the `try` whose catch (`:479-481`) re-wraps
  **everything** as `HubErrorCode.ASR`, so `TIMEOUT_ASR` is unreachable in the original.
- Fix: the escape clause is gone; the ASR path now always wraps as `ASR`.
- Honesty note: the ASR **timeout** itself could not be waited out at runtime here (see §9.2); the
  fix restores a guard structure, and the *reachable* failure path (`ASR`) is runtime-verified.

## 4. Runtime demonstrations

Probe: `docs/parity/evidence/2026-09-10/h02-listen-transactions/probe.mjs`
Results: `probe-before.json`, `probe-after.json` (raw frames included per case).
`H02_REVISION` is recorded in each report; `probe-after.json` sha256
`cd5ab90c1ca62eeb4435d458c1c1ba639c2d870a4a6e88bff1eb1560574613ce`,
`probe-before.json` sha256 `2db1b0558bf5af4f06942d614d49a1959a4485174719fafc99cbc7a29aea9f11`.

### 4.1 Ordering, CLIENT_ASR, both aliases — VERIFIED

`/v1/listen` and `/listen`, frames sent 15 ms apart:

```
observedTypes: ["SOS","EOS","LISTEN"]   finalFlags: [false,false,true]
terminal (raw): {"type":"LISTEN",...,"data":{"asr":{"text":"blurf gnax","confidence":1},
  "nlu":{"intent":null,"rules":["launch"],"entities":{}},"match":null},"final":true,
  "timings":{"total":54,"asr":-1,"nlu":20}}
```

`SOS`/`EOS` carry `data:null` and `timings.total = -1` for client-driven turns; exactly one frame is
terminal.

### 4.2 Server ASR, SOS/EOS ordering — VERIFIED (in-process, real `ListenTransaction`)

`packages/gateway/test/listenTransaction.cancelFailure.test.js` "server ASR: SOS then EOS then the
single terminal LISTEN frame": with an injected provider session, `onStartOfSpeech` → `SOS`,
`onEndOfSpeech` → `EOS`, result → `LISTEN`. `finalFlags == [undefined, undefined, true]`, real
timings (not `-1`), parser received the normalised transcript, and the session was `stopped` when the
phase settled.

### 4.3 Cancellation — VERIFIED

Same file, "CLIENT_ASR cancels the in-flight server ASR phase and keeps the client transcript" and
"CLIENT_NLU cancels the in-flight server ASR phase". Observed: `CLIENT_ASR` mid-ASR stops the running
session before the provider answers; late `onStartOfSpeech`/`onEndOfSpeech` from that provider emit
nothing; the late transcript never reaches the frame. Before/after differential in §3.3.

### 4.4 Reordered, delayed, duplicate — VERIFIED (wire)

| Case | Observed (after) |
|---|---|
| `CONTEXT` sent *after* `CLIENT_ASR` | `["SOS","EOS","LISTEN"]`, terminal carries `"context came late"` — the context promise makes arrival order irrelevant, and the turn still produces one outcome |
| duplicate `CLIENT_ASR`, same tick | `["SOS","EOS","EOS","LISTEN"]`, `finalFlags [false,false,false,true]`, terminal `"second words"`, exactly one terminal frame |
| duplicate `CLIENT_ASR`, 15 ms apart | `["SOS","EOS","LISTEN"]` then the second `EOS` is **dropped** (log: `can't write after response ended`, type `EOS`) — the turn had already ended |
| duplicate `CONTEXT` (2 frames, 15 ms apart) | the second resolve is a no-op (the context promise is already settled): `["SOS","EOS","LISTEN"]`, terminal `"duplicate context"`, one turn |
| malformed JSON | `["ERROR"]`, `data.message = "Invalid JSON arrived into socket: THIS IS NOT A JSON"`, no `code` key |

### 4.5 Close timing — VERIFIED

3 s of observation past the terminal frame: socket still `OPEN`, no server close, then the client's
own close is observed (`clientCloseObserved: true`). Matches the pinned dead guard and the captured
original. The 2.500 s assertion is pinned by the test; the pre-fix source fails it at ~2 s (§7 F3).

### 4.6 No late writes — VERIFIED

After the terminal frame, a second `LISTEN` + `CLIENT_ASR` produced **no** frames within 400 ms. Run in
isolation, the same case logs exactly:
`can't write after response ended` (type `SOS`), `can't write after response ended` (type `EOS`),
`bad transition to 'WAIT_CLIENT_ASR' from 'DONE'`, `bad transition to 'NLU' from 'DONE'` — the writes
are dropped by the `ended` guard (`BaseWebsocketHandler.ts:96-99`) and the state machine does not
restart. The 15 ms-apart duplicate-`CLIENT_ASR` probe case shows the same drop on the wire.

### 4.7 Disconnect cleanup — VERIFIED (existing coverage, re-run here)

`packages/gateway/test/listenTransaction.disconnect.integration.test.js` covers the three disconnect
scenarios over a real socket: a client close never settles the outer or internal transaction, a
provider that finishes after the close still resolves the internal transaction, and the 60 s
deadline rejects the outer promise only (`error.code === undefined`). It passes unchanged after these
edits.

### 4.8 Failure modes — VERIFIED (after)

| Induced failure | Raw terminal frame (probe) |
|---|---|
| malformed JSON | `{"type":"ERROR",...,"data":{"message":"Invalid JSON arrived into socket: THIS IS NOT A JSON"},"timings":{"total":1}}` |
| unknown type | `"data":{"message":"Unknown message type: LISTEN_ME"}` |
| invalid mode | `"data":{"message":"Invalid value for mode 'WHATEVER'"}` |
| parser 503 | `"data":{"code":"PARSER","message":"parser 503"}` after `SOS,EOS` (elapsed 34 ms) |
| parser timeout | `"data":{"code":"PARSER","message":"Timeout of 10000 while waiting for parser"}` (elapsed 10 032 ms, i.e. the real 10 s budget) |
| missing CONTEXT | `"data":{"code":"TIMEOUT_CONTEXT","message":"Timeout of 5000 while waiting for the context message"}` (elapsed 5 017 ms) |
| ASR provider rejects | `"data":{"code":"ASR","message":"asr backend exploded"}` (no `SOS`/`EOS`) |
| query string on the path | HTTP `404` at the upgrade (raw socket probe) |

### 4.9 Endpoint aliases — VERIFIED

`/listen` and `/v1/listen` both complete a turn; `/listen?robot=1` is rejected `404` at the upgrade
(the pinned `socketHandlers.has(info.req.url)` lookup keeps the query string in the key,
`BaseService.ts:185-189`).

### 4.10 Empty and garbage audio, speaker/context — VERIFIED

- `sosTimeout` with no speech: `["LISTEN"]` only (no `SOS`/`EOS` pair), `data.asr = {text:'', annotation:'SOS_TIMEOUT'}`,
  parser called with `''`. Matches the reference's own expectation
  (`hub/tests/listen/ListenHandlerTimeouts.test.ts:140-157`).
- `GARBAGE` annotation: `["SOS","EOS","LISTEN"]`, terminal `match:null`, parser **not** called
  (matches `:468-476`).
- Speaker/context: `runtime.perception.speaker` and `runtime.loop.users` flow into the parser request
  and the launch-history record — already pinned by `listenTransaction.history.test.js` and
  `listenTransaction.lifecycle.test.js`, which still pass.

## 5. Code changes

| File | Change |
|---|---|
| `packages/contracts/src/constants.js` | `HubErrorCode` restored to the full pinned enum (`SKILL_NOT_FOUND`, `TIMEOUT_SKILL`, `TIMEOUT_PARSER`, `TIMEOUT_ASR`, `TIMEOUT_CONTEXT`, `TIMEOUT_TRANSACTION`, `ASR`, `PARSER`, `GENERAL`); Phoenix-only codes kept and labelled |
| `packages/gateway/src/listenTransaction.js` | `_stopASR()`/`_cancelASR()`/`_clearASRTimers()`; cancellation from `CLIENT_ASR`/`CLIENT_NLU` and from any transition out of `ASR`; stale-phase guards; `if (out)` guard on the ASR result; `PARSER` wrap for parser failures; `ASR` re-wrap for the ASR path |
| `packages/gateway/src/responseWrapper.js` | `closed = true` initial value (pinned) + corrected header comment |

## 6. Tests added

- `packages/gateway/test/listenTransaction.cancelFailure.test.js` (8 tests) — in-process: SOS/EOS
  ordering, single terminal frame, ASR cancellation on `CLIENT_ASR`/`CLIENT_NLU`, stale-result
  immunity, GARBAGE, SOS-timeout/empty audio, ASR failure code, duplicate `CLIENT_ASR`, global turn.
- `packages/gateway/test/listen.e2e.failure.test.js` (12 tests) — real `ws`: both aliases, close
  timing, no late writes, malformed/unknown/bad-mode errors, `PARSER` on parser failure **and**
  parser timeout, `TIMEOUT_CONTEXT` at 5 s, `ASR` on provider failure, query-string 404.

Both files fail against the pre-fix source (§7) and pass against the fixed source.

## 7. Falsification

Script: `falsify.py`, transcript `falsification.log` (`python3 falsify.py`). Anchors are **complete
source lines/blocks**, never bare substrings; the script refuses to run if the anchor does not occur
exactly once, and restores in a `finally`.

**F1 — highest-risk assertion: "a parser failure keeps the `PARSER` code".**
Corrupted `packages/gateway/src/listenTransaction.js:383`:
`      throw new HubError(HubErrorCode.PARSER, errMsg(err));` → `      throw err; // CORRUPTED: parser code lost`.
Result: `node --test packages/gateway/test/listen.e2e.failure.test.js` → exit 1, **# tests 12 / # pass 10 / # fail 2**:
`not ok 8 - a parser failure keeps the reference PARSER code`,
`not ok 9 - a parser timeout also reaches the robot as PARSER (reference re-wrap)`.
Restored → exit 0, **12/12 pass**.

**F2 — cancellation.**
Corrupted the whole `_cancelASR()` body (`listenTransaction.js:355`) to a no-op:
`_cancelASR() { // CORRUPTED: cancellation becomes a no-op }`.
Result: exit 1, **# tests 8 / # pass 6 / # fail 2**:
`not ok 2 - CLIENT_ASR cancels the in-flight server ASR phase...`,
`not ok 3 - CLIENT_NLU cancels the in-flight server ASR phase`.
Restored → exit 0, **8/8 pass**.

**F3 — close timing.**
Restored the pre-fix `this.closed = false` by stashing `packages/gateway/src` + `packages/contracts/src`
and re-running only the close test (`--test-name-pattern="leaves the socket open"`):
exit 1, **1 test / 0 pass / 1 fail**, assertion
`the hub must not close the socket 2 s after the terminal frame` with an actual close timestamp.
Restored → **1/1 pass**. Source hashes verified with `sha256sum -c` after every restore.

## 8. Full suite and parity gate

Three full `npm test` runs were made on the frozen tree; no file was edited during any of them.
Run 1 (`33132 ms`) and run 3 (`29748 ms`, the recorded run) are clean; **run 2 is reported here
because it is not clean**:

```
run 2:  # tests 1272 / # pass 1264 / # fail 1 / # cancelled 0 / # skipped 7   exit 1
not ok 68 - RobotReadClient keeps one header deadline across redirects
  (packages/account/test/loopCreationTransport.test.js:138) expected ['POST','POST'], got []
```

That is the documented pre-existing load-sensitive flake — a 35 ms header deadline that is lost
under full-suite load (the redirect's second request never leaves). It passes 3/3 in isolation here
(`node --test packages/account/test/loopCreationTransport.test.js` → `# pass 4 / # fail 0`) and the
file is untouched by this change (`git diff --stat` lists only `packages/contracts/src/constants.js`,
`packages/gateway/src/listenTransaction.js`, `packages/gateway/src/responseWrapper.js`). Run 3:

```
> phoenix@0.0.0 test
# tests 1272
# suites 7
# pass 1265
# fail 0
# cancelled 0
# skipped 7
# duration_ms 29748.973706

> npm run parity:check
Checklist: 16/79 verified (20.3%)
pegasus: 3/46 verified; 0 in progress; 0 blocked
Tracker structure, dependencies, evidence links and generated checklist are valid.

> npm run parity:gate
Strict production smoke gate (43 cases; full corpus remains separately tracked).
image-phoenix
candidate
compare
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Exit code 0 (gate evidence `.parity/runs/ci-production-b591fbea-ea91-4e7e-9d26-84e62d374e33`).
Baseline with the same source but without the two new test files: **# tests 1252 /
# pass 1245 / # fail 0 / # skipped 7** — the delta is exactly the 20 added tests, so no existing
test was skipped, weakened or removed. `# skipped 7` is the known
`scripts/nlu-compiled-graphs-install.test.mjs` reference-path artifact (worktree copy sees the
reference tree at a different relative depth), not caused by this change.

`docs/parity/tasks.json` and `docs/parity/DIVERGENCES.md` were **not** modified; the H-02 row stays
`status: todo` and this work is delivered as a candidate with candidates listed in §10.

## 9. UNKNOWN / not observable here

1. **Real ASR provider** (Parakeet / Google). Every ASR claim above uses an injected provider session
   through the documented `setASRProvider` / `components.asrProvider` seam. No provider endpoint was
   reachable (`ETCO_server_parakeetUrl` defaults to `http://192.168.1.252:6972` and was never
   contacted). Needed: a live Parakeet deployment plus recorded PCM, to observe real chunking, VAD,
   `stop()` semantics, and whether a stopped session can still call back.
2. **The 40 s ASR timeout on the wire.** Not waited out; the trap under test is the
   `TIMEOUT_ASR → ASR` re-wrap, which is source-derived. Needed: a provider that accepts audio and
   never answers, held for 40 s (the same shape as the 10 s parser case, which *was* run).
3. **The 3-minute max-duration close.** Same dead guard as the 2 s timer that was observed, but the
   3 min path itself was not waited out. Needed: a 3 min idle socket.
4. **Genuine concurrency / real robot timing.** Ordering was produced by sending frames 15 ms apart
   and in the same tick; real Jetstream/Nimbus scheduling jitter, simultaneous transactions on
   different sockets, and mic-mode audio timing were not reproduced. Needed: robot/emulator traffic
   against a deployed revision.
5. **The original's late-callback behaviour under a real ASR session** (§2.3). Needed: the original
   `ASRSession` executed, or the frozen provider's source plus its tests.
6. **`SocketMessageReader`'s "Unprocessable message type (object)" branch** (`:63-65`) — unreachable
   over a real WebSocket, where frames are always `Buffer`/`string`; Phoenix's router always parses
   `data.toString('utf8')`. Not observable, and not a wire difference.
7. **Skill launch/redirect/update semantics** are H-04's scope and were only touched incidentally
   (existing tests, unchanged).
8. **SDK-side effect of the frames.** Whether a real client reacts differently to a duplicated `EOS`
   or to the socket staying open is client-firmware behaviour. Needed: SDK/Nimbus source execution.

## 10. Divergence candidates (for root, not written to `DIVERGENCES.md`)

1. **`_beginGlobalTurn` is still a Phoenix extension.** A bare `CLIENT_ASR`/`CLIENT_NLU` with no
   `LISTEN` produces `["EOS","LISTEN"]` in Phoenix (VERIFIED, §4, and pinned by the new test); the
   frozen handler would take the invalid `WAIT_LISTEN → NLU` transition (`:183`) and answer nothing
   until the 60 s deadline (INFERRED). Already recorded as item 3 of `docs/parity/CONSUMERS.md`.
   **Retained deliberately** — removing it would break the simulator framing — and it needs the scope
   review the consumer note asks for. Note the extension also bypasses `stateTrace` (it assigns
   `this.state` directly), so any trace-based comparison must not treat the missing
   `WAIT_CLIENT_ASR` entry as an error.
2. **Duplicate `CLIENT_ASR` yields a duplicated `EOS`** in both implementations (VERIFIED for
   Phoenix; INFERRED for the original from `:252-267`). Exactly one frame is terminal, so it is not a
   parity divergence, but it is a wire-shape surprise worth a documented decision.
3. **Error-message wording.** Phoenix `parser 503` vs the original `Request failed with status code
   503`. Per standing policy wording is not a parity gap; recorded so it is not "fixed" by emulating
   axios.
4. **`ERROR` frame key order.** Phoenix writes `{type,msgID,ts,final,data,timings}` while the original
   mutates `final` onto the object last (`{type,...,data,timings,final}`). JSON object order is not
   semantic; any normalizer comparing serialized bytes must sort keys.
5. **`TIMEOUT_ASR` is now unreachable on the wire** (it re-wraps to `ASR`, per the pinned double
   wrap). Any other artifact expecting `TIMEOUT_ASR` from the listen path — docs, candidates, or
   fixture checks — would be wrong per the pin, and should be corrected rather than "restored".
6. **`audioChunks` is discarded on cancel.** `_stopASR()` clears the buffer when the phase was
   cancelled, mirroring the reference's nulled `audioStream` (`:444-447`). A subsequent uncancelled
   ASR phase cannot reuse those bytes — same as the original, but worth knowing if audio replay is
   ever attempted.

## 11. Reproduce

```bash
cd /home/shell/work/phoenix/.parity/worktrees/w3-h02
node --test packages/gateway/test/listenTransaction.cancelFailure.test.js
node --test packages/gateway/test/listen.e2e.failure.test.js
H02_OUT=/tmp/probe.json node docs/parity/evidence/2026-09-10/h02-listen-transactions/probe.mjs
python3 docs/parity/evidence/2026-09-10/h02-listen-transactions/falsify.py
npm test
```

Pre-fix captures were produced with
`git stash push -- packages/gateway/src packages/contracts/src`, re-running the probe, then
`git stash pop`; `sha256sum -c` on the three edited files confirms the restore.
