# H-04 — skill launches, updates, redirects and session handoff

Pinned reference: Pegasus `5c0a7390539663ba749d360de348a428c088505c`
(`packages/hub/src/skill/*`, `packages/hub/src/listen/ListenTransactionHandler.ts`,
`packages/hub/src/utils/TransactionHandler.ts`, `packages/hub/src/intent/DecisionMediator.ts`),
executed under the archived `node:8.9.4-slim`
(`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).

## Method

Two receipts are produced and diffed cell-by-cell:

* `source-skill-handoff.cjs` — runs the **pinned original** `ListenHandler` /
  `ListenTransactionHandler` on the archived Node 8 runtime with a controlled HTTP
  skill peer and an EventEmitter socket whose `write()` mirrors
  `ResponseWrapper.write` (`BaseWebsocketHandler.ts:96-118`, including the
  write-after-final refusal). It records every request the hub sent and every WS
  frame it emitted. → `source-skill-handoff.json`
* `phoenix-skill-handoff.mjs` — drives the **real Phoenix gateway** (`createGateway`)
  over a real `ws` socket with the same peer and the same inputs. →
  `phoenix-skill-handoff.json`

`python3 compare.py` normalizes the peer's random port and prints a structural diff.
Exit 0 with `DIFFS (0)` is the current state.

Commands:

```
docker run --rm --network none -v "$PWD:/review" \
  -v /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro \
  node:8.9.4-slim node /review/source-skill-handoff.cjs /runtime /review/source-skill-handoff.json
node phoenix-skill-handoff.mjs phoenix-skill-handoff.json
python3 compare.py
```

## Verified contract (all observed on both runtimes)

| Surface | Original | Phoenix |
| --- | --- | --- |
| Launch request | `LISTEN_LAUNCH`, `data.result={nlu,asr,memo}` (memo `null`), `general` gains `remoteAddress` from the socket | ✅ identical |
| Trace headers | `x-jibo-transid` passthrough, `x-jibo-robotid:'unknown'`, `x-jibo-logging-config:'{}'` when absent | ✅ identical |
| Continued session | `CONTEXT.skill={id,session}` + no rule match + `hotphrase:false` → `LISTEN_UPDATE` with the opaque `session` round-tripped and `result={nlu,asr}` (no `memo`) | ✅ identical |
| LISTEN match | cloud → `final:false`, `launch:true`, `onRobot:false`; on-robot → `final:true`, `onRobot:true`, no HTTP call | ✅ identical |
| Redirect notification | `SKILL_REDIRECT` with rewritten `match={skillID:target,launch:true,onRobot}`, `final===onRobot` | ✅ identical |
| Redirect launch | fresh `LISTEN_LAUNCH` with the **redirect's** `nlu`/`memo` and **no** `asr` | ✅ identical |
| Action forwarding | skill response forwarded verbatim; only `final` and `timings.{total,skill}` are overwritten | ✅ identical |
| Redirect limit | exactly one redirect; a second throws `Error('Too many redirects')` → `ERROR` frame with **no** `code` | ✅ identical |
| Redirect to an on-robot skill | final `SKILL_REDIRECT` ends the response; the failed launch's `ERROR` is refused (write-after-final) | ✅ identical |
| Launch timeout | `ERROR {code:'TIMEOUT_SKILL', message:"Timeout of 10000 while waiting for the skill response from '<src>'"}` (12/12) | ✅ identical (12/12) |
| Release mediation | `DecisionMediator` goldens executed on original Node 8 (`decision-mediator-original.json`) | ✅ existing suite |

## Divergences found and fixed

### 1. `timings.skill` after a redirect must be the redirect leg only

`ListenTransactionHandler.ts:395-400` times the initial launch and then
`ListenTransactionHandler.ts:404-410` **overwrites** `timings.skill` with the
redirect leg's own duration. Measured: original `total=128 skill=62`; Phoenix
before the fix `total=130 skill=129`.

Fix — `packages/gateway/src/listenTransaction.js`: assign `this.timings.skill`
after the initial leg, then re-measure around `_handleRedirect`.

### 2. Skill HTTP-failure message

`SkillRequestMaker.ts:119-123` builds
`Error from URL '<url>': <status> <axios message> :: <JSON body>`, where axios's
message for a non-2xx is `Request failed with status code <status>` and the body
is `JSON.stringify(response.data)`. Observed original:

```
Error from URL '<url>': 500 Request failed with status code 500 :: {"error":"boom"}
```

Phoenix omitted the middle segment. Fix — `packages/gateway/src/skillClient.js`
reproduces it (and re-serializes a JSON body / quotes a non-JSON one via
`serializeResponseBody`).

### 3. Redirect timeout message

`ListenTransactionHandler.ts:406-407` throws while `skillOutput` still refers to
the **first** response, so the message names the *original* skill. Observed
original: `Timeout of 10000 while waiting for the redirect skill response from
'source'` with `code:'TIMEOUT_SKILL'`. Phoenix said only `Timeout while waiting
for the redirect skill response`. Fix — same file, `_handleRedirect` now takes
the originating skill id.

## Known nondeterminism in the original (not a Phoenix defect)

The reference wraps the redirect in `timeout2(..., TIMEOUT_SKILL)` while
`SkillRequestMaker` applies its own 10 s budget. Under Node 8 the two 10 s timers
land in the same timer batch, and because Node 8 does not drain microtasks
between same-phase timer callbacks the *outer* `TIMEOUT_SKILL` normally wins.
12 samples of each timeout case: launch 12/12 outer; redirect 11/12 outer,
1/12 the inner `Timeout of 10000ms while waiting for "destination" response`.
Phoenix always produces the outer envelope, i.e. the 11/12 case.

## Not verified / open

* The skill-error `code` (`SkillRequestError`) never reaches the wire: both
  `TransactionHandler.emitSkillResult` and the proactive path write only
  `message`, so the reference's `TIMEOUT`-vs-`SKILL_NOT_FOUND` precedence quirk is
  **unobservable** here.
* `injectDialogContext` (`SkillRequestHelper.ts:93-102`) writes
  `input.context.runtime.dialog.referent` with no guard; Phoenix tolerates a
  missing `runtime`/`dialog`. Reachable only with a malformed CONTEXT; the live
  robot always supplies `runtime.dialog`. INFERRED, not exercised.
* Deployed-robot acceptance of the accepted combined runtime, native ASR, and
  active cancellation of an in-flight HTTP skill request remain out of scope.
