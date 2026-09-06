# Production parser, routing and skill comparison

V-03's production v2 gate executes real HTTP parser requests, each implementation's intent router and local skill registry, its production skill request builders, and real chitchat/report skill services. Full responses, provider requests, JCP/ESML/display actions, analytics and continuation sessions are compared. This is a component profile; full HubService orchestration, proactive transactions, external cloud skills and physical clients retain separate tasks. The corpus-to-gate inventory and hosted CI rejection are reviewed; V-03 infrastructure is verified. Product comparison failures remain open.

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

The [latest complete comparison](evidence/2026-09-06/production/main-ec02766-full-compiled/review.json)
executes all **20,534 fixtures** on frozen main `ec02766` with the explicit
compiled-FST parser. It has **11 field differences across four cases**, zero
trace invariants and **16 coverage-gap instances**: the same eight external
answer cases on each side. Capture and cleanup completed successfully; the
unchanged strict comparator returns exit 1.

| Dimension | Latest compiled-profile agreement |
|---|---:|
| Parser HTTP response | 20,528 / 20,528 |
| Selected skill or no-route result | 20,527 / 20,528 |
| Complete action object | 20,433 / 20,434 |
| Complete session state | 20,434 / 20,434 |
| Analytics | 20,434 / 20,434 |
| Provider request sequence | 83 / 83 |

Three failing cases concern empty-name wildcard routing (H-03); one concerns
fallback prompt selection for “are you a jedi” (S-03). The external answer
cases remain Q-01 coverage obligations. Equal missing coverage does not count
as verified behavior. The earlier default-profile baseline below remains
historical evidence; this compiled run does not replace the separate default
AST result.

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

The [latest root-reviewed Report Lasso integration](evidence/2026-09-06/service-integration/report-lasso-review.json)
passes **512 unit tests** with three existing skips and matches **51 original
Node 8 transport controls**. The strict **43-case compiled-FST smoke** now has
**zero differences, zero invariants and zero coverage gaps**: all 218 differences
from the preceding graph/Settings checkpoint are resolved. Original goldens,
the shared driver and comparator are unchanged. A failed detached prefetch
still emits an unhandled rejection in the original and is consumed by Phoenix;
that case is explicitly excluded from the 51 exact controls.

The explicit compiled profile separately [matches all 20,528 archived parser
HTTP responses and 42 native multi-rule controls](evidence/2026-09-06/nlu-compiled-fst/integration-review.json).
The [subsequent default AST repair](evidence/2026-09-06/nlu-ast-ranking/root-review.json)
reduces its full HTTP replay to **149 differences**, with no newly failing
previously passing cases. The accepted combined tree passes **516 active unit
tests** and both separately measured **43-case default and compiled smoke
profiles**, each with zero differences, invariants or gaps. The default gate's
runtime and source fingerprint are recorded in the latest complete review.
Full Report orchestration, Hub lifecycle and live providers remain separate
acceptance tasks.

The integration evidence preserves an initial five-test OGG timeout run and a
two-test isolated failure during VM disk I/O stalls, then an unchanged 34-test
ASR pass and complete 512-test pass after I/O recovered. Request/test deadlines
were not increased. The first original edge probe's outer process timed out;
a fresh run completed, and only that completed capture was used for acceptance.

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

## Hosted CI

The [GitHub workflow](../../.github/workflows/parity.yml) runs unit tests,
coverage-gate mutation tests and checklist validation on main pushes and pull
requests. An independent job compares the 43-case production smoke against
the reviewed original capture. A manual `full` selection runs all 20,534 cases.
Every comparison mismatch remains a failed job; no accepted-difference count
or success override hides the current failures.

Both comparison success and failure retain the run metadata, source
fingerprint, candidate capture, full comparison and logs for seven days.
Accepted root evidence is separately committed under this document's evidence
links. The [first hosted run](evidence/2026-09-06/ci/first-run/review.json)
confirmed the 659-difference smoke rejection, with no capture failures. All
405 unit tests and six inventory tests passed. Checklist validation exposed an
untracked N-02 directory reference; its replacement now names the existing
diagnostic and production tools. The [second hosted run](evidence/2026-09-06/ci/accepted-run/review.json)
validated the fix at `1926d64`: all 405 unit tests, six inventory tests and
checklist checks passed. The 43-case capture completed without failures and
returned the same 659 differences, zero invariants and one coverage gap. Root
reproduced its comparison byte-for-byte and accepted V-03 infrastructure.
Those historical hosted runs remain failed evidence. The latest local default
smoke gate passes; a new hosted run must be inspected before claiming hosted
acceptance for the current revision.
Local workflow and coverage integration checks are recorded in the
[root review](evidence/2026-09-06/coverage-review/review.json).

## Commands

Use a fresh output directory for every run.

```bash
# Standard unit/tracker/strict default smoke CI entry point.
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
