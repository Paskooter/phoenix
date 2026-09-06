# Production parser, routing and skill comparison

V-03's production v2 gate executes real HTTP parser requests, each implementation's intent router and local skill registry, its production skill request builders, and real chitchat/report skill services. Full responses, provider requests, JCP/ESML/display actions, analytics and continuation sessions are compared. This is a component profile; full HubService orchestration, proactive transactions, external cloud skills and physical clients retain separate tasks. V-03 remains open for final corpus-to-gate inventory reconciliation and review.

The bounded writer now exports the full corpus under Node 8. The independently
repeated [20,534-case original control](evidence/2026-09-05/production/stream-writer-full-control/review.json)
has zero differences and trace invariants. Eight cases select the external
`answer` service on both sides, so the complete gate still fails with 16 coverage
gap instances. These original controls establish reference repeatability, not
Phoenix feature parity.

Root then batched small writer fragments without changing JSON bytes. The
[review](evidence/2026-09-05/production/buffered-writer-review.json) covers Node 8
stream shutdown, output exceeding 256 MiB, and a byte-identical 41.6 MB benchmark
whose export time fell from 378 seconds to 14.8 seconds. Fresh 43/73 controls
pin the new writer. A complete new original capture also has zero differences
against the earlier completed capture in a
[strict cross-writer comparison](evidence/2026-09-05/production/buffered-writer-cross-control/review.json).
The second original execution within that new run failed grammar startup with
`No thread available` before any case. Its result remains `error`; that failed
run has not been relabeled as a passing control. The earlier whole-string
`RangeError` captures remain historical failure evidence.

The [42-case original control](evidence/2026-09-05/production/request-builder-control/run.json) agrees across two separate Node 8.9.4 containers, with zero differences, trace failures or coverage gaps. The [73-case report control](evidence/2026-09-05/production/request-builder-report-control/run.json) also has zero differences and trace failures. Its complete gate correctly fails: `report:5:0:base` (“check the weather tomorrow”) selects the external `answer` service, which this profile does not host. Both sides retain that same uncovered action. Golden review approves provenance and measured repeatability, not complete product parity.

The [smoke golden](../../packages/harness/resources/goldens/production-smoke/source.json) and [report golden](../../packages/harness/resources/goldens/production-report/source.json) pin the source revision, original adapter, shared driver, fixture generator, image digests and capture bytes. Unreviewed, changed or stale goldens are rejected.

## Complete baseline and reviewed integration

The [complete baseline](evidence/2026-09-06/production/main-057f67c-full-baseline/review.json)
ran all **20,534 fixtures** against main `057f67c`. Its strict result is
**49,155 field differences**, zero trace invariants and **97 coverage-gap
instances**: eight on the original side and 89 on Phoenix, spanning 91 unique
cases. The source and candidate captures, fingerprints and compressed full
comparison are retained. The gate fails.

| Dimension | Complete-baseline agreement |
|---|---:|
| Parser HTTP response | 20,216 / 20,528 |
| Selected skill or no-route result | 20,366 / 20,528 |
| Complete action object | 20,170 / 20,434 |
| Complete session state | 20,206 / 20,434 |
| Analytics | 20,167 / 20,434 |
| Provider request sequence | 0 / 83 |

These are separate dimensions in a declared component profile, not a product
completion percentage. Missing skill timing metadata accounts for 20,297
field differences, with another 20,297 differences in the resulting response
content lengths. The remaining differences retain their task ownership and
coverage limits in the baseline review.

Main now includes reviewed bounded A-02 native token/validation/framing and
S-01 response-wrapper/request-gate and graph preconditions, and H-10 JWT and
CONTEXT identity repairs alongside the prior HTTP, parser, JCP/MIM, audio,
prompt, report-view and provider-image changes. All **405 unit tests pass**, including the
README progress automation, in the [recorded integration run](evidence/2026-09-06/progress/unit.txt).
The [strict 43-case smoke](evidence/2026-09-06/production/main-s01-h10-smoke/run.json)
still fails with **659 field differences**, zero invariants and one unhosted
action gap. Full action agreement remains **25/26**. The complete baseline
above predates these A-02/S-01/H-10 repairs; its counts have not been projected
forward or relabeled as a passing result.

The next N-08 candidate reports **20,230/20,528** status/decoded-data matches,
14 fixes and no newly failing IDs in its [full replay](evidence/2026-09-06/nlu-n08-followup/full-replay-review.json).
Root checked its hashes, denominators and original expected values; final
integrated regression is running in fixed verification checkout `66e2abc`,
based on main `7945263` plus that candidate. It excludes the later graph and
H-10 repairs. That N-08 candidate is not yet in main.
The earlier accepted parser repair had fixed 89 failures without regressions,
and all 73 report parser cases match. The subsequent ranking candidate is
separate and unaccepted. Root's [GraphSkill review](reviews/s01-graph-root/review.json),
[JWT review](reviews/h10-root/review.json) and [CONTEXT review](reviews/h10-identity-root/review.json)
record their accepted bounded scope and remaining lifecycle gaps.

Moth completed native TLS token issuance, authenticated listen/proactive and
a visible clock using the reviewed A-02 implementation. Weather, news images
and a smiling-eye action have earlier bounded hardware evidence. Physical
wake/ring confirmation, full voice quality, calendar/commute checks and
complete product acceptance remain open. The built Node 20 runtime image has
[retained audio test evidence](evidence/2026-09-06/runtime/review.json), including
one initial timeout followed by passing isolated and full repeats; it has not
been deployed.

## Earlier Phoenix baseline

The [smoke baseline](evidence/2026-09-05/production/request-builder-baseline/run.json) has **1,659 field differences across 42 cases**, zero trace failures and one unhosted candidate action (`answer-skill`, selected by Phoenix for the loop-name case). The [report baseline](evidence/2026-09-05/production/request-builder-report-baseline/run.json) has **6,751 differences across 73 cases**, zero trace failures and the original-side external `answer` gap. Every case has at least one difference.

| Dimension | Smoke agreement | Report agreement |
|---|---:|---:|
| Complete parser HTTP response | 0 / 36 | 0 / 73 |
| Intent, where original response is NLU | 23 / 32 | 67 / 73 |
| Complete entity object | 0 / 32 | 0 / 73 |
| Winning rules | 24 / 32 | 73 / 73 |
| Complete no-match result | 0 / 9 | No selected original no-match case |
| Selected skill or no-route result | 29 / 36 | 68 / 73 |
| Selected memo, including type/presence | 19 / 20 | 67 / 73 |
| Emitted production skill request | 6 / 27 | 0 / 72 |
| Complete rendered action | 0 / 26 | 0 / 72 |
| Complete session state | 14 / 26 | 0 / 72 |
| Analytics | 0 / 26 | 0 / 72 |
| Provider request sequence | 0 / 10 | 0 / 72 |

The [smoke assignments](evidence/2026-09-05/production/request-builder-baseline-summary.json) and [report assignments](evidence/2026-09-05/production/request-builder-report-baseline-summary.json) assign every difference to an owning comparison layer. Assignments overlap and are not completed root-cause analyses; parser differences can propagate through skill inputs and sessions. These selections do not replace the [20,507 corpus occurrence denominator](COVERAGE.md).

The [standard test run](evidence/2026-09-05/production/request-builder-npm-test.log) passes **280 unit tests** and tracker validation, then returns exit 1 for the production mismatch. Ten tests now cover production grading and VM random control, including independent original captures, deliberate field/state corruption, dialog-reference injection, uncovered actions and CLI failure exits. Tests validate the grader; a failing Phoenix baseline remains failing.

## Original execution and fixture scope

The runner verifies 6,144 original Git files and symbolic links plus two separately hashed bootstrap relocations (`package.json` and registry URLs in `yarn.lock`). It verifies 391 emitted modules against the original TypeScript 2.5.3 compilation record. Native NLU 2.8.3 must load all 98 original compiled grammars successfully before any case runs.

The original `RobustParserProcess` is managed independently through supported `ParserService.startProcess=false` configuration. Its original readiness marker is followed by a bounded port check. The original HTTP handler, robust-parser client, queue, result arbitration and loop-member processing execute unchanged. Native RPC uses supported `maxConcurrentRequests=1`; concurrency/performance parity is not claimed. The frozen native configuration enables a performance sink at localhost:10003/log. A fixture hosts that dependency, records notification counts and rejects unexpected requests. Native telemetry is setup evidence, outside the Phoenix telemetry comparison. Every failed grammar load or native transport error invalidates the run.

Node clocks and random selection reset per case. MIM VM contexts receive a separate seeded intrinsic `Math.random` stream, preserving their other Math functions and any explicitly supplied Math object. MIM conditions, weighted selection and prompt templates execute unchanged. Native and VM Date clocks remain host clocks; native time-sensitive semantics retain N-01/N-02 coverage obligations. Dialogflow is disabled.

The original `SkillRequestHelper` and Phoenix's existing `SkillClient` public methods construct launch/update requests. The shared driver supplies the final HTTP transport, preserving the complete builder input and emitted request. This includes dialog-reference injection and the previously issued continuation session. Proactive builder dispatch is available in the adapter but has no executed case in these selections; no proactive coverage is credited.

Runtime context comes from original `mockRuntimeData`. Conditional dates use noon UTC; historical `uid0001` is assigned to the helper's default Jane persona. That person's historical attributes have not been recovered, so this is explicitly synthetic test context. Provider replies use original weather test data and synthetic settings, news, calendar and maps replies. Real production clients construct requests; headers, paths, query strings and bodies remain compared. Unexpected requests fail the fixture.

The smoke profile contains 20 parser boundaries, six direct skill scenarios and 16 corpus occurrences, including VM-random prompt conditions. Boundaries cover complete and malformed envelopes, rules/loop/external data, missing and unknown rules, local timer rules, duplicates, empty/whitespace/no-match text and loop-member names. Direct report scenarios cover an unknown speaker, provider failure and identification continuation. The complete selection runs every 17,137 base and 3,370 conditional occurrence, plus 27 boundary/direct scenarios: **20,534 cases**. Duplicate commands are retained. Historical manifest expectations remain preserved separately from original-runtime differential outputs; missing intent fields are never interpreted as no-match expectations.

## Comparison policy

All JSON fields, types, absent/null/empty distinctions and array order are significant. The comparison retains HTTP status and headers, NLU intent/entities/rules, routing weight/skill/memo, builder input and output, actions, analytics and full sessions. Continuations must use their own previously issued session unchanged.

Generated envelope/session UUIDs are rebound bijectively, retaining v4 format and relationships. JCP command IDs are rebound only at command-container paths and must retain 32-hex format. View, node, domain and prompt IDs stay literal. Raw JSON bytes, content lengths and ETags are validated independently before duplicate raw representations and ETag digest values are removed. Measured durations are bounded; application timestamps and timing fields remain compared. Only the fixture peer authority in outbound Host headers is rebound.

Unhosted cloud action targets are explicit coverage gaps and prevent complete-gate success, including in an otherwise agreeing original/original control. Missing, reordered or duplicated cases, changed fixture inputs, incomplete capture/cleanup and superseded trace schemas cannot pass.

## Superseded diagnostics and fixture corrections

The v1 [40-case control](evidence/2026-09-05/production/control/run.json), [1,521-difference smoke baseline](evidence/2026-09-05/production/baseline/run.json) and [6,484-difference report baseline](evidence/2026-09-05/production/report-baseline/run.json) remain historical diagnostics. The [first full control review](evidence/2026-09-05/production/manual-request-full-control/review.json) found two fixture defects: manual request construction omitted production dialog-reference injection in 71 launch cases, and one MIM used unseeded VM randomness. The latter caused six field differences across two corpus occurrences. Those captures are superseded for pipeline verification. The full v1 run also retained eight occurrences selecting the unhosted external `answer` service; these remain Q-01/N-08 obligations.

Early v2 captures failed native setup with “No thread available.” The native source shows performance notifications use a Poco task manager; hosting the missing performance dependency alone did not eliminate the failure. With supported serial RPC and the local sink, both independent smoke and report controls load all 98 grammars without errors. Failed runs remain in `.parity/runs/production-request-builder-{control,report-control,perf-control}`; no case from an incomplete capture receives credit. The precise native scheduling failure remains outside this serial component profile.

The initial unit run also exposed a pre-existing calendar fixture race: two supposedly simultaneous events used different `Date.now()` calls. Its clock is now frozen, with no production calendar change. Both legacy diagnostic graders return exit 1 on mismatches; the alternate-engine diagnostic moved outside automatic unit-test discovery and still reports its historical 74/89.

## Commands

Use a fresh output directory for every run.

```bash
# Standard unit/tracker/strict smoke CI entry point; currently fails on Phoenix differences.
npm test

# Reviewed smoke reference; no original installation needed.
python3 scripts/parity-production/run.py --golden packages/harness/resources/goldens/production-smoke --out .parity/runs/production-smoke-new

# Independent original control for all corpus occurrences and boundary/direct cases.
python3 scripts/parity-production/run.py --selection all --candidate original --out .parity/runs/production-full-control-new

# Original/Phoenix full comparison.
python3 scripts/parity-production/run.py --selection all --out .parity/runs/production-full-new

# Explicit corpus occurrence slice; denominators remain present.
python3 scripts/parity-production/run.py --selection corpus --corpus report --out .parity/runs/production-report-new

node --test packages/harness/test/productionCompare.test.js scripts/parity-production/driver.test.cjs
```

Both runtimes use temporary containers, `--network none` and no published ports. Package, script and manifest fingerprints must remain unchanged throughout capture. Docker lifecycle bounds are separate from measured request/case bounds. Exit 0 means complete agreement within the declared selection and profile; exit 1 reports differences or missing coverage; exit 2 reports setup, capture or provenance failure.
