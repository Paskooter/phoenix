# Strict comparison milestone — V-02

V-02 is verified as comparison infrastructure. Two independent original Pegasus runs agree
on all **28 fixtures**. The same fixtures against Phoenix produce **267 JSON-pointer differences
across 26 cases**, with complete captures and no invariant failures. The comparison exits **1**,
as required. No Phoenix product-parity task is certified by this result.

The [review](evidence/2026-09-05/comparison/review.json) records every acceptance criterion,
commands, source/tool hashes, preserved application files and limitations. The
[baseline summary](evidence/2026-09-05/comparison/baseline-summary.json) assigns every difference
to product tasks. Full [control](evidence/2026-09-05/comparison/control/comparison.json) and
[Phoenix comparison](evidence/2026-09-05/comparison/baseline/comparison.json) reports retain the details.

## Reproduce

```bash
npm run harness -- --candidate original --out .parity/runs/control
npm run harness -- --out .parity/runs/compare
node --test packages/harness/test/diff.test.js packages/harness/test/parityCompare.test.js
```

The [runner instructions](../../scripts/parity-compare/README.md) describe reference setup,
immutable Node 8.9.4/22.22.0 images, isolated containers, shared fixtures, clock controls and
artifacts. Exit 0 means fixture agreement, 1 means a behavioral/invariant mismatch, and 2 means
an operational failure. Keep those outcomes separate.

## Observed differences

| Family | JSON-pointer differences | Evidence and task |
|---|---:|---|
| Shared HTTP | 91 | Null/undefined bodies, malformed JSON/form parsing, error status/envelopes, routing, methods, authentication and response headers — C-01 |
| Skill-list HTTP | 44 | All four robot/settings URLs return Phoenix 404s; original returns full configurations — C-01/C-03/H-01 |
| Outbound HTTP headers | 116 | Axios and fetch defaults differ on parser, skill and history calls; no blanket header exception was granted — H-02/H-04/H-08/R-01 |
| Unknown-speaker history | 8 | Original writes `personIDs: ["UNKNOWN"]`, Phoenix writes `[]` — H-08 |
| Parser failure envelope | 2 | Phoenix loses the `PARSER` code and changes the 503 failure message — C-02/H-02 |
| WebSocket authentication | 2 | Invalid-signature rejection text and its content length differ — H-10 |
| Terminal socket lifetime | 4 | Original stays open through 2.1 seconds; Phoenix closes near 2 seconds — H-02 |

These are differences in a small foundational suite, not 267 independent defects or a
whole-project completion percentage. Fixture launch/relaunch/update action payloads and full
sessions agree in these paths; their transactions still differ in headers/history effects.
The two completely agreeing cases are missing WebSocket authorization and a malformed JSON frame.

The original unknown-speaker behavior is explicit in frozen
`packages/hub/src/utils/TransactionHelper.ts`. The socket result is also source-confirmed:
`ResponseWrapper.closed` starts as `true` in original
`packages/utils/src/service/handlers/BaseWebsocketHandler.ts`, so its guarded two-second close
does not execute. Phoenix initializes it as `false`. The observed 2.1-second window does not
certify the longer timeout, cancellation or cleanup matrix in H-02.

## Gate validation and scope

All **36 focused harness tests** and **263 regression tests** pass. Mutation tests reject changes
to HTTP status/headers/clock, null/empty/presence, entities/rules/memo, JCP/ESML/analytics, sessions,
identity relationships, timing, frame order, terminal counts, side effects and fixture identity.
The CLI test proves a corrupted session produces a retained diff and nonzero exit.

The comparator independently validates full issued/supplied/forwarded/advanced sessions, ordered
bounded observations, envelope clocks/timing sentinels, raw-body decoding, content lengths and
ETag derivation. Generated UUIDs and fixture endpoints have explicit bounded-path rules.
Normalization no longer erases session contents, timestamps, timing fields or arbitrary URL ports.

The shared clock hook also controls Node's automatic HTTP `Date` header, whose modern internal
clock bypasses `global.Date`. Explicit application dates and suppression remain observable and
are covered by tests. A preliminary run hit the old 90-second Docker lifecycle limit after its
capture completed; it is retained as an operational failure. The outer limit is now 180 seconds,
while per-case bounds remain five seconds. No worker is forced to exit successfully.

These fixtures execute actual shared HTTP and hub implementations with synthetic NLU, skill and
history peers. They test hub payload forwarding and continuation, not actual parser decisions,
MIM rendering, providers, audio, durability, original clients, deployment or hardware. A 50 ms
side-effect drain cannot prove the absence of arbitrarily delayed effects. Complete source
coverage and production corpus grading remain **V-03**; the historical static grader still
prints 74/89 and exits zero. The [task checklist](TASKS.md) retains every product/release gate.
