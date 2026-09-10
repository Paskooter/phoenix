# Phoenix parity task checklist

Generated from [tasks.json](tasks.json). Edit the ledger, then run `npm run parity:status -- --write`; `npm run parity:check` checks evidence/dependencies and detects stale output.

A checked box means the acceptance criteria and linked evidence were reviewed. Existing code and green unit tests are recorded independently of verified product parity. Counts below measure this task plan, not a percentage of server functionality.

Parallel candidates have their own implementation checkbox. A checked candidate means a proposed implementation was submitted; only the main task checkbox means the lead verified every acceptance criterion. Candidate submissions do not increase the verified counts.

| Track | Verified | Total | In progress | Blocked |
|---|---:|---:|---:|---:|
| management | 3 | 3 | 0 | 0 |
| verification | 4 | 4 | 0 | 0 |
| pegasus | 3 | 46 | 0 | 0 |
| classic | 6 | 20 | 0 | 0 |
| restoration | 0 | 1 | 0 | 0 |
| release | 0 | 5 | 0 | 0 |

Current task: none.

Next ready task: **C-03 — Restore configuration, registry and service-discovery compatibility**.

See [PLAN.md](PLAN.md) for execution rules, [COMPATIBILITY.md](COMPATIBILITY.md) for the frozen target and [AUDIT.md](AUDIT.md) for initial findings. Pegasus source links use the original commit; restored-only code and atlas links are labeled separately. API definitions are pinned; other Jibo links are discovery references to be pinned before verification.

## 0. Establish the verification baseline

### PM-01 — Establish the source-backed audit baseline

- [x] **verified** · P0 · management · implementation: complete

Owner: Codex. Dependencies: none.

Completed this audit pass; this verifies the audit work, not product parity.

Done when:

- Pin the compared revisions and record existing working-tree changes.
- Retain fresh test results, source/asset inventories and reproducible discrepancy probes.

Source: [Restored Pegasus docs/atlas/branch-archaeology.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/branch-archaeology.md); [jiborobot/srv-jibo-server-client/apis](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis).

Phoenix: [docs/parity/AUDIT.md](../../docs/parity/AUDIT.md); [docs/parity/evidence/2026-09-05](../../docs/parity/evidence/2026-09-05).

Evidence: [docs/parity/evidence/2026-09-05/baseline.json](../../docs/parity/evidence/2026-09-05/baseline.json) (2026-09-05; management deliverable).

### PM-02 — Publish the dependency-ordered parity tracker

- [x] **verified** · P0 · management · implementation: complete

Owner: Codex. Dependencies: PM-01.

Completed initial planning; historical milestone checkmarks do not certify the new scope.

Done when:

- Every task has source references, an implementation finding, dependencies and verifiable acceptance criteria.
- The tracker validates IDs, dependency order, evidence for verified work and generated documentation.

Source: [Restored Pegasus docs/atlas/verification-strategy.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/verification-strategy.md).

Phoenix: [docs/parity/tasks.json](../../docs/parity/tasks.json); [docs/parity/PLAN.md](../../docs/parity/PLAN.md); [scripts/parity-status.mjs](../../scripts/parity-status.mjs).

Evidence: [docs/parity/evidence/2026-09-05/tracker-check.log](../../docs/parity/evidence/2026-09-05/tracker-check.log) (2026-09-05; management deliverable).

### PM-03 — Freeze the original compatibility target and divergence policy

- [x] **verified** · P0 · management · implementation: complete

Owner: Codex. Dependencies: PM-02.

Original Hashbrown source/client and dependency artifacts are frozen. All historical divergences are classified; firmware ambiguity, original credential-deletion behavior and legacy Settings version verification remain in their product tasks.

Done when:

- Record the original release, restored reference, client/firmware versions and dependency artifact versions in a compatibility manifest.
- Classify every existing divergence as internal-only, required repair, or a separately selectable extension; keep unresolved differences open.
- Determine which external Classic operations are required for Pegasus and which belong to the additional full-cloud target without deleting either backlog.

Source: [Restored Pegasus docs/atlas/branch-archaeology.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/branch-archaeology.md); [Restored Pegasus docs/atlas/external-services.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/external-services.md).

Phoenix: [DIVERGENCES.md](../../DIVERGENCES.md); [docs/parity/PLAN.md](../../docs/parity/PLAN.md); [docs/parity/COMPATIBILITY.md](../../docs/parity/COMPATIBILITY.md); [docs/parity/evidence/2026-09-05/compatibility-pins.json](../../docs/parity/evidence/2026-09-05/compatibility-pins.json).

Evidence: [docs/parity/evidence/2026-09-05/compatibility-review.json](../../docs/parity/evidence/2026-09-05/compatibility-review.json) (2026-09-05; management deliverable).

### V-01 — Make the reference executable with deterministic dependency fixtures

- [x] **verified** · P0 · verification · implementation: complete

Owner: Codex. Dependencies: PM-03.

Verified executable reference infrastructure: 38 original transactions and 19 fixture checks under Node 8.9.4, 376 source inputs/15 manifests checked against original Git, exact NLU 2.8.3 CLI. TypeScript module emission and fixture providers are explicit; original Gulp build, complete services/providers/persistence/clients remain unverified under their own tasks.

Done when:

- Start an isolated pinned reference runtime or independently executable service modules, with fixed time/randomness and fake ASR/NLU/data/settings responses.
- Capture successful and failing reference HTTP/WS transactions with source commit, artifact hashes, fixture inputs and launch commands.
- Keep any service that still cannot run explicitly unverified; document reproducible build blockers and a source-derived test fallback.

Source: [Original Pegasus Dockerfile](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/Dockerfile); [Original Pegasus packages/test-utils](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/test-utils); [Original Pegasus packages/parser/robust-parser](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser); [jiborobot/srv-gqa-ws/README.md](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/README.md).

Phoenix: [packages/harness](../../packages/harness); [docs/parity/evidence](../../docs/parity/evidence); [scripts/parity-reference](../../scripts/parity-reference); [docs/parity/REFERENCE.md](../../docs/parity/REFERENCE.md).

Evidence: [docs/parity/evidence/2026-09-05/reference/review.json](../../docs/parity/evidence/2026-09-05/reference/review.json) (2026-09-05; original source module execution with recorded emission/provider adapters).

### V-02 — Finish the two-server comparison runner and strict comparison rules

- [x] **verified** · P0 · verification · implementation: complete

Owner: Codex. Dependencies: V-01.

Verified strict comparison infrastructure: identical 28-case HTTP/hub fixtures, passing independent original control, 36 focused tests including corruption/CLI rejection. Phoenix baseline fails with 267 JSON-pointer differences across 26 cases, zero invariant failures. Full parser/skill/provider/consumer coverage remains in V-03 and product tasks; no Phoenix feature parity certified.

Done when:

- One command runs identical fixtures against reference and Phoenix and saves requests, ordered responses, side effects and diffs; a mismatch exits nonzero.
- Check status, headers, field presence, null versus empty, entities, rules, memo, JCP/ESML and analytics; normalize only explicitly allowed volatile paths.
- Verify session continuation, ID relationships and timing bounds independently, and prove intentionally corrupted frames/sessions fail the gate.

Source: [Original Pegasus packages/hub-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client); [Original Pegasus packages/hub-client-cli](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client-cli); [Restored Pegasus docs/atlas/verification-strategy.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/verification-strategy.md).

Phoenix: [packages/harness](../../packages/harness); [scripts/parity-compare](../../scripts/parity-compare); [docs/parity/COMPARISON.md](../../docs/parity/COMPARISON.md); [docs/parity/evidence/2026-09-05/comparison](../../docs/parity/evidence/2026-09-05/comparison).

Evidence: [docs/parity/evidence/2026-09-05/comparison/review.json](../../docs/parity/evidence/2026-09-05/comparison/review.json) (2026-09-05; Executable original/Phoenix HTTP and hub differential; independent invariant/mutation tests).

### V-03 — Map all original tests and resources into a coverage denominator

- [x] **verified** · P0 · verification · implementation: complete

Owner: Codex. Dependencies: PM-03.

Root verified the complete source/resource coverage inventory, stable corpus-to-production-gate links and hosted CI rejection. The 20,534-case full baseline remains a mismatch. GitHub run 34008215915 at 1926d64 passed 405 unit tests, six inventory tests and checklist validation; its valid 43-case capture failed strictly on 659 differences, zero invariants and one coverage gap. Root reproduced the comparison byte-for-byte. This closes verification infrastructure only; missing product coverage remains explicit.

Done when:

- Inventory each original test scenario, named grammar, protocol operation and asset set, assigning a parity task and a covered/missing status.
- Add the 7,029-utterance hub-client and 73-utterance report corpora without hiding overlap or changing denominators.
- Grade the production parser with complete requests, intents, entities, winning rules, no-match behavior, skill/memo and action outputs; pin golden provenance and reject mismatches in CI.

Source: [Original Pegasus packages/integration-tests-int](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/integration-tests-int); [Original Pegasus packages/integration-tests-ext](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/integration-tests-ext); [Original Pegasus packages/hub/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/tests); [Original Pegasus packages/parser/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/tests); [Original Pegasus packages/test-utils](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/test-utils).

Phoenix: [docs/parity/COVERAGE.md](../../docs/parity/COVERAGE.md); [docs/parity/evidence/2026-09-06/coverage/source-inventory.json](../../docs/parity/evidence/2026-09-06/coverage/source-inventory.json); [scripts/parity-coverage](../../scripts/parity-coverage); [scripts/parity-production](../../scripts/parity-production); [packages/harness/resources/corpora/sources.json](../../packages/harness/resources/corpora/sources.json); [packages/harness/src/corpusManifest.js](../../packages/harness/src/corpusManifest.js); [packages/harness/src/productionCompare.js](../../packages/harness/src/productionCompare.js); [packages/nlu/tools/legacyOracleDiagnostic.mjs](../../packages/nlu/tools/legacyOracleDiagnostic.mjs); [packages/harness/resources/goldens/production-smoke/source.json](../../packages/harness/resources/goldens/production-smoke/source.json); [scripts/parity-production/gate.mjs](../../scripts/parity-production/gate.mjs); [docs/parity/evidence/2026-09-06/production/main-057f67c-full-baseline/review.json](../../docs/parity/evidence/2026-09-06/production/main-057f67c-full-baseline/review.json); [scripts/parity-coverage/corpus-gates.json](../../scripts/parity-coverage/corpus-gates.json); [.github/workflows/parity.yml](../../.github/workflows/parity.yml); [docs/parity/evidence/2026-09-06/coverage-review/review.json](../../docs/parity/evidence/2026-09-06/coverage-review/review.json); [docs/parity/evidence/2026-09-06/ci/accepted-run/review.json](../../docs/parity/evidence/2026-09-06/ci/accepted-run/review.json).

Evidence: [docs/parity/evidence/2026-09-06/ci/accepted-run/review.json](../../docs/parity/evidence/2026-09-06/ci/accepted-run/review.json) (2026-09-06; Root source/resource denominator review, complete original controls and full failing baseline, inventory mutation tests, and actual hosted mismatch rejection with independent offline replay).

- [x] Candidate implementation — **accepted**; Luna Max / audio_encoding_repair.

Candidate scope: Complete corpus gate provenance/denominators and separate grammar preservation counts; root reviewed portable end-to-end mutation checks and hosted CI mismatch rejection.

Candidate report: [docs/parity/candidates/V-03-coverage.md](../../docs/parity/candidates/V-03-coverage.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/coverage-review/review.json](../../docs/parity/evidence/2026-09-06/coverage-review/review.json). Complete task acceptance is still governed by the main checkbox above.

### V-04 — Establish the Moth real-robot verification loop

- [x] **verified** · P0 · verification · implementation: complete

Owner: Codex. Dependencies: PM-03, V-02.

Lead verified the bounded Moth test infrastructure, preserved rollback configuration, correlated native/Hub actions, and completed source-pinned BE release and timer-local failure iterations. V-04 certifies this verification loop only; authentication, encoded audio, physical wake-word/ring confirmation and full skill/release acceptance remain open.

Done when:

- Pin robot/native/client/server inputs and preserve recoverable starting configuration without altering the other robot or unrelated services.
- Run the original BE consumer in an isolated slot against this Phoenix checkout; retain correlated native events, cloud wire traces and observed Nimbus execution.
- Provide repeatable global/local text and real-audio probes with bounded capture and precise rollback; distinguish injected text, recorded audio and physical observations.
- Record failing-before/passing-after hardware iterations and map every unresolved result to product tasks; no bypass or fixture result closes its production acceptance.

Source: [Jibo documentation](https://pvindex.org/confluence/display/SER/Jetstream+Service+Details); docs/parity/CONSUMERS.md.

Phoenix: [docs/parity/HARDWARE.md](../../docs/parity/HARDWARE.md); [packages/gateway/src](../../packages/gateway/src).

Evidence: [docs/parity/evidence/2026-09-05/hardware/review.json](../../docs/parity/evidence/2026-09-05/hardware/review.json) (2026-09-05; Lead review of all four infrastructure acceptance criteria and real Moth evidence).

### A-01 — Map every Classic operation to controllers, consumers and tests

- [x] **verified** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: PM-03.

The audit recovered 26 API files and 134 unique wire targets; controller semantics and per-operation implementation coverage still need mapping. Original hub/report consumers additionally require legacy Settings_20160801.GetSettings; the inventoried SDK lists Settings_20171219. BE 12 release inspection found root Jibo Server Client 3.0.79 plus three nested 3.0.117 instances. Their 102 API model instances have 32 distinct byte sequences; merge version-specific expectations without counting duplicated models as new functionality (CONSUMERS.md). Root-reviewed historical discovery adds 24 Jot pairs, 10 VoiceTraining pairs and the legacy Settings pair: 169 literal pairs, or 173 with four directly observed alternate Jot pairs. Denominator closure and controller/runtime parity remain open. Functional ownership is now explicit in A-19/A-20. The integrated provisional operation map assigns all 169 canonical pairs plus four observed aliases to registered tasks. Root independently verified all 51 Account/Admin and Loop handler/controller dispatch symbols; every runtime scenario remains not-run, and wider contract assertions still require operation-level review.

Done when:

- Assign all current 134 targets and every additional required historical/client-observed pair to a handler, source controller, consumer, parity task and verification scenario.
- Record auth/ownership, schema, errors, persistence and observable side effects per operation; dispatch/shape support alone is not verification.
- Investigate services with no client API file, including voice training, Jot and other archive services, and register any additional required contracts.
- Recover legacy contract versions used by the original clients, including Settings_20160801.GetSettings; keep the 20171219 SDK surface independently mapped.

Source: [jiborobot/srv-jibo-server-client/apis/account-2015-11-11.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/account-2015-11-11.normal.json); [jiborobot/srv-jibo-server-client/apis/loop-2016-03-24.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/loop-2016-03-24.normal.json); [jiborobot/srv-jibo-server-client/apis/oobe-2016-10-26.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/oobe-2016-10-26.normal.json).

Phoenix: [docs/parity/evidence/2026-09-05/classic-api-inventory.json](../../docs/parity/evidence/2026-09-05/classic-api-inventory.json); [CLASSIC-SERVICES.md](../../CLASSIC-SERVICES.md); [packages/classic](../../packages/classic); [docs/parity/evidence/2026-09-06/classic-contract-discovery/review.json](../../docs/parity/evidence/2026-09-06/classic-contract-discovery/review.json); [docs/parity/candidates/A-01-operation-map.json](../../docs/parity/candidates/A-01-operation-map.json); [scripts/parity-coverage/a01_operation_map.py](../../scripts/parity-coverage/a01_operation_map.py).

Evidence: [docs/parity/evidence/2026-09-10/a01-operation-attributes/review.md](../../docs/parity/evidence/2026-09-10/a01-operation-attributes/review.md) (2026-09-10; Per-operation attributes (auth incl. both auth layers, ownership, schema, errors, persistence, side effects) recorded for every wire operation and independently re-derived by root from the merged map).

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Provisional operation map and 51 original Account/Admin/Loop dispatch symbol mappings accepted after independent root source checks. All operation scenarios remain not-run; no A-01 acceptance criterion is closed. Root uses reviewed historical model input and registered A-19/A-20 ownership. Root also recovered startup-installed AccountUpdated/LoopUpdated save hooks, correcting the earlier isolated-controller side-effect assumptions.

Candidate report: [docs/parity/candidates/A-01-operation-map.md](../../docs/parity/candidates/A-01-operation-map.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/classic-operation-map/review.json](../../docs/parity/evidence/2026-09-06/classic-operation-map/review.json). Complete task acceptance is still governed by the main checkbox above.

## 1. Repair public contract blockers

### C-01 — Match the shared HTTP response and error contract

- [x] **verified** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: V-02.

Shared HTTP boundary candidate now matches the expanded malformed JSON and serialization/routing fixtures, including the root317-case mutation review. Accepted for integration; authentication and broader service boundaries remain unverified. Root verified 2026-09-09: the accepted candidate review covered JSON body parsing only (317 cases, one synthetic route). Root added 47 executable cases for handler errors, unknown routes, trailing slashes, HTTP methods, content types and response headers against the pinned Node 8.9.4 runtime - 0 differences. One harness error was found and corrected in root's favour of Phoenix (healthcheck body is lowercase "ok" per BaseService.getHealthcheckResponse).

Done when:

- Compare null, undefined, arrays, empty bodies, malformed JSON, handler errors, unknown routes, trailing slashes and supported HTTP methods.
- Preserve reference status codes, response bodies, content types and headers on all service boundaries.

Source: [Original Pegasus packages/utils/src/service/BaseService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/BaseService.ts); [Original Pegasus packages/utils/src/service/handlers/BaseHttpHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/handlers/BaseHttpHandler.ts).

Phoenix: [packages/common/src/service.js](../../packages/common/src/service.js).

Evidence: [docs/parity/evidence/2026-09-09/c01-http-boundary/review.json](../../docs/parity/evidence/2026-09-09/c01-http-boundary/review.json) (2026-09-09; Executable original/Phoenix shared HTTP boundary differential on the dimensions the bounded 317-case review did not cover).

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair.

Candidate scope: Repair source-confirmed common HTTP response/error serialization; lead reviews differential evidence and remaining C-01 acceptance.

Candidate report: [docs/parity/candidates/C-01.md](../../docs/parity/candidates/C-01.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/comparison/http-review.json](../../docs/parity/evidence/2026-09-05/comparison/http-review.json). Complete task acceptance is still governed by the main checkbox above.

### C-02 — Complete the wire schemas and message builders

- [x] **verified** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01, V-03.

P11 rejects the original empty NLU response. Proactive, manifest, JCP/SLIM and MIM coverage is incomplete.

Done when:

- Build a field/enum/nullability/requiredness matrix from the pinned interfaces and consumer code, including ListenResult precedence.
- All captured valid reference requests/responses are accepted and the reference's invalid-input behavior is reproduced.
- Cover proactive requests/results, skill redirects/actions, JCP/display, MIMs, manifests and analytics without rejecting valid optional fields.

Source: [Original Pegasus packages/interfaces/src](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/interfaces/src); [jiboV2/jibo-command-protocol/index.d.ts](https://pvindex.org/gitea/jiboV2/jibo-command-protocol/src/branch/master/index.d.ts).

Phoenix: [packages/contracts/src/messages.js](../../packages/contracts/src/messages.js); [packages/contracts/src/constants.js](../../packages/contracts/src/constants.js); [packages/contracts/src/validate.js](../../packages/contracts/src/validate.js).

Evidence: [docs/parity/evidence/2026-09-10/c02-wire-schemas/review.md](../../docs/parity/evidence/2026-09-10/c02-wire-schemas/review.md) (2026-09-10; ListenResult precedence compared line-for-line with hub/response.ts:89-100 and falsified 3/3; 58 acceptance and 17 rejection assertions over fixtures carrying 13 pinned-source citations; every criterion-3 surface covered, with MIM resolved as skill-internal memo state rather than a wire schema and pinned by a new falsified test).

- [x] Candidate implementation — **accepted**; DeepSeek workers (two passes) via Hermes delegate_task.

Candidate scope: Wire schema matrix, ListenResult precedence, valid/invalid reference behaviour, and the proactive/redirect/JCP/MIM/manifest/analytics surfaces. Root independently falsified the precedence chain (3/3) and MIM memo pass-through (1/1), and corrected its own initial reading that MIM coverage was missing. The HubErrorCode mismatch (C02a) is recorded as an open divergence, not silently accepted as parity.

Candidate report: [docs/parity/evidence/2026-09-10/c02-wire-schemas/review.md](../../docs/parity/evidence/2026-09-10/c02-wire-schemas/review.md).

Lead review: Hermes root (pasketti); [docs/parity/evidence/2026-09-10/c02-wire-schemas/falsification.json](../../docs/parity/evidence/2026-09-10/c02-wire-schemas/falsification.json). Complete task acceptance is still governed by the main checkbox above.

### C-03 — Restore configuration, registry and service-discovery compatibility

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: V-02.

Registry/configuration, CLI, SettingsClient and Report Lasso transport slices are integrated after root review. Latest51 original Lasso controls and512 unit tests pass; configured strict43 now has zero differences/invariants/gaps. Runtime/setup logging, remaining service CLI boundaries and deployed provider/DNS/TLS compatibility remain open.

Done when:

- Load unmodified reference registries including settings metadata, paths, versions and URL composition; reject invalid configurations as the reference does.
- Exercise reference NET_/ETCO_ names, prefsFromConfig, required variables, precedence, CLI port and defaults without relying on Phoenix-only aliases.
- Document optional alias behavior and prove an individual Phoenix service works under the reference environment.

Source: [Original Pegasus packages/hub/src/config](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/config); [Original Pegasus packages/hub/src/skill/SkillUtils.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/skill/SkillUtils.ts); [Original Pegasus packages/report-skill/src/EnvVars.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/EnvVars.ts); [Original Pegasus packages/utils/src/config](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/config).

Phoenix: [packages/gateway/src/config.js](../../packages/gateway/src/config.js); [packages/gateway/src/registry.js](../../packages/gateway/src/registry.js); [packages/skills/src/report/lassoClient.js](../../packages/skills/src/report/lassoClient.js); [packages/common/src/env.js](../../packages/common/src/env.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Codex root with Luna Max candidate.

Candidate scope: Bounded Report Lasso transport. Root51 source controls match without error-message qualifications;512 units pass. Configured strict43 resolves all218 remaining differences, with zero new differences/invariants/gaps. Detached prefetch rejection remains an explicit divergence; full C-03 remains open.

Candidate report: [docs/parity/candidates/S-08-lasso-snapshot-followup.md](../../docs/parity/candidates/S-08-lasso-snapshot-followup.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/service-integration/report-lasso-review.json](../../docs/parity/evidence/2026-09-06/service-integration/report-lasso-review.json). Complete task acceptance is still governed by the main checkbox above.

### H-01 — Restore the robot-specific skill-list endpoints

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01, C-03.

P03 and the V-02 original/Phoenix comparison reproduce 404s on all four original robot/settings skill-list URLs. Original execution returns full configurations; current Phoenix routes and registry omit paths and metadata. Raw baseline retains 44 differences including shared HTTP headers.

Done when:

- GET /skills/:robotId and /v1/skills/:robotId return full reference-shaped skill configurations.
- Both settings-filtered URL variants return exactly the configurations with settings, including empty registries and unknown robot IDs.

Source: [Original Pegasus packages/hub/src/HubService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/HubService.ts); [Original Pegasus packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts).

Phoenix: [packages/gateway/src/index.js](../../packages/gateway/src/index.js); [packages/gateway/src/registry.js](../../packages/gateway/src/registry.js).

Evidence: pending.

### H-02 — Verify listen transaction ordering, cancellation and failure behavior

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-02.

V-02 captures launch/relaunch/update/no-match/provider/malformed paths, but full race/error/timeout conformance remains unproved. At 2.1 seconds after final, original stays open and Phoenix closes near 2 seconds: original ResponseWrapper.closed starts true, making its guarded close ineffective. Parser failures also lose the PARSER code and change message text. Full cancellation/audio/long-timeout matrix remains open. Consumer inspection also identifies _beginGlobalTurn as a simulator-specific bare CLIENT_ASR/NLU shortcut absent from frozen Pegasus and normal native Jetstream framing; differential reproduction and scope review remain required (CONSUMERS.md).

Done when:

- Replay SERVER_ASR, CLIENT_ASR and CLIENT_NLU transactions with reordered/delayed/duplicate/malformed messages and both endpoint aliases.
- Verify exactly one terminal outcome, SOS/EOS ordering, close timing, all timeout/error codes, disconnect cleanup and no late writes.
- Exercise local/global turns, speaker/context updates and empty/garbage audio using the original client framing.

Source: [Original Pegasus packages/hub/src/listen/ListenTransactionHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts); [Original Pegasus packages/hub/src/utils/TransactionHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/TransactionHandler.ts); [Original Pegasus packages/hub-client/src/session](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client/src/session); [Original Pegasus packages/utils/src/service/handlers/BaseWebsocketHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/handlers/BaseWebsocketHandler.ts).

Phoenix: [packages/gateway/src/listenTransaction.js](../../packages/gateway/src/listenTransaction.js); [packages/gateway/src/responseWrapper.js](../../packages/gateway/src/responseWrapper.js); [packages/gateway/test/listen.e2e.test.js](../../packages/gateway/test/listen.e2e.test.js).

Evidence: pending.

### H-03 — Match the original intent decision tree

- [x] **verified** · P0 · pegasus · implementation: complete

Owner: Codex. Dependencies: V-02.

Verified original intent decision tree: independent35 routing controls,48 applicable original tests and7 large/repeated sort controls agree. Full20534 compiled regression has zero differences/invariants and all20528 routing decisions match; same8 unrelated external-action gaps remain. Integrated main539 units/default43 pass. Older-release launch mediation is tracked in H-04.

Done when:

- Match exact/NOT/wildcard/nested-entity matching, parent fallback, weights, registration ties and case behavior against original fixtures.
- An intentless or unregistered decision never launches merely because an entities.skill value names a skill; local-turn rule gating is preserved.

Source: [Original Pegasus packages/hub/src/intent](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/intent); [Original Pegasus packages/hub/tests/intent](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/tests/intent).

Phoenix: [packages/gateway/src/intentRouter.js](../../packages/gateway/src/intentRouter.js).

Evidence: [docs/parity/evidence/2026-09-07/intent-router/review.json](../../docs/parity/evidence/2026-09-07/intent-router/review.json) (2026-09-07; Pinned original Node8 differential, unchanged source test vectors, root full production regression and integrated main tests).

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair; Codex root review and acceptance.

Candidate scope: Complete H-03 intent decision-tree acceptance; runtime diagnostic wording is nonblocking per user policy.

Candidate report: [docs/parity/candidates/H-03-intent-router-20260906.md](../../docs/parity/candidates/H-03-intent-router-20260906.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/intent-router/review.json](../../docs/parity/evidence/2026-09-07/intent-router/review.json). Complete task acceptance is still governed by the main checkbox above.

### H-04 — Match skill launches, updates, redirects and session handoff

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: H-02, H-03.

Root accepted bounded release mediation/history, trace defaults, launch/continuation, and listen disconnect/timeout layering. Three fresh source comparisons match full functional responses, requests, settlement and history with140 guards; old runtime fails all three new regressions. Original full transport/authentication, proactive/other reset paths and deployed BE/native-ASR acceptance remain open.

Done when:

- Compare general/runtime/skill/result/memo and trace propagation on launch, update, action completion and redirect.
- Verify redirect limit, rewritten match, fireAndForget/final semantics, failures, continued sessions and launch-history attribution.
- Preserve release-dependent launch mediation for older robot versions, including report-to-chitchat/answer/news decisions, without relying on a fabricated robot release.

Source: [Original Pegasus packages/hub/src/skill](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/skill); [Original Pegasus packages/hub/src/listen/ListenTransactionHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts); [Original Pegasus packages/hub/src/intent/DecisionMediator.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/intent/DecisionMediator.ts).

Phoenix: [packages/gateway/src/skillClient.js](../../packages/gateway/src/skillClient.js); [packages/gateway/src/listenTransaction.js](../../packages/gateway/src/listenTransaction.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair; Codex root.

Candidate scope: Bounded listen disconnect and outer/internal transaction timeout layering. Three original-handler/actual-Phoenix-WebSocket comparisons, complete responses/HTTP requests/history,140 guards; three new regressions fail on old code;591 units and strict43 pass. Prior mediation/history/trace/continuation acceptance retained. Full H-04 remains open.

Candidate report: [docs/parity/candidates/H-04-disconnect-root-20260907.md](../../docs/parity/candidates/H-04-disconnect-root-20260907.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/listen-disconnect/review.json](../../docs/parity/evidence/2026-09-07/listen-disconnect/review.json). Complete task acceptance is still governed by the main checkbox above.

### H-05 — Enforce proactive user settings

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: H-02, C-03.

Settings rules are unconditionally accepted despite a Phoenix settings service now existing.

Done when:

- Use the reference settings request, account/loop identity and rule operators to filter candidates.
- No-settings, missing-key, disabled preference, unknown person and settings-service failure produce the reference result; opt-in/out affects real proactive routing.

Source: [Original Pegasus packages/hub/src/proactive/tools/SettingsRulesChecker.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/proactive/tools/SettingsRulesChecker.ts); [Original Pegasus packages/hub/src/utils/SettingsClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/SettingsClient.ts).

Phoenix: [packages/gateway/src/proactive/proactiveTransaction.js](../../packages/gateway/src/proactive/proactiveTransaction.js); [packages/account/src/settingsFace.js](../../packages/account/src/settingsFace.js).

Evidence: pending.

### H-09 — Match each skill process at the reference /v1/main URL

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01, C-03.

P13 shows the shared service entrypoint selects answer-skill at /v1/main even when used as the report-skill process.

Done when:

- Give each independently deployed skill the reference /v1/main behavior and retain any namespaced aliases without requiring caller changes.
- Start report/chitchat/example/template replacements independently and verify original requests reach the intended skill; run the native and compose entrypoint configurations.

Source: [Original Pegasus packages/baseskill/src/SkillService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/SkillService.ts); [Original Pegasus packages/report-skill/src/index.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/index.ts); [Original Pegasus packages/chitchat-skill/src/index.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/chitchat-skill/src/index.ts).

Phoenix: [packages/skills/src/index.js](../../packages/skills/src/index.js); [packages/skills/src/skillService.js](../../packages/skills/src/skillService.js); [docker-compose.yml](../../docker-compose.yml).

Evidence: pending.

### H-10 — Match hub authentication and context identity checks

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-02, A-02.

Root accepted bounded original JWT/CONTEXT controls, native cached-token rotation and temporary authenticated Moth trials. The latest 135cd7d trial uses the integrated authenticated launcher and real TLS 1.2 signed CreateHubToken, the same issued token on listen/proactive upgrades, clock rendering and synthetic proactive exchange. Root independently verified rollback of credentials/configuration/trust, temporary mounts/files and child processes; 3150063 remains the diagnostic backend. Persistent authenticated rollout, full expiry/retry/account extension, microphone, wake and physical-ring acceptance remain open. Root accepted a bounded timeout for the optional account extension: stalled headers/body reject, both Hub paths recover, and six actual Account service cases pass. The integrated suite passes 718 units and strict43. This does not complete native expiry/refetch, broader identity or persistent rollout. Root accepted private Account snapshot replacement and imported-launcher restart recovery after a real Account mutation: old JWT works on both Hub paths after restart. Final720 units and strict43 pass; CLI already sets a private umask. The Linux user-service template passes real owned process-failure/restart controls, retaining the Hub token and pending notification; persistent Moth switch and reboot acceptance remain open.

Done when:

- Use original client tokens to compare missing/malformed bearer headers, signatures, expiry/claims, unknown WS paths and CONTEXT identity mismatch.
- Verify preprocessing defaults, authenticated robot/account identity, disabled-auth compatibility and no cross-robot identity substitution.
- Verify the optional account-backed extension with revocation, unavailable account service and bounded upgrade latency separately from original shared-secret behavior.
- Run the original signed CreateHubToken-to-Bearer-upgrade sequence, including expiry and the native single 401 refetch/retry; do not substitute portal token creation.

Source: [Original Pegasus packages/utils/src/service/BaseService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/BaseService.ts); [Original Pegasus packages/hub/src/utils/MessagePreProcessor.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/MessagePreProcessor.ts); [Original Pegasus packages/hub/src/utils/MessageValidator.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/MessageValidator.ts); [Original Pegasus packages/hub-client/src/Client.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client/src/Client.ts).

Phoenix: [packages/gateway/src/index.js](../../packages/gateway/src/index.js); [packages/gateway/src/preprocessor.js](../../packages/gateway/src/preprocessor.js); [packages/common/src/jwt.js](../../packages/common/src/jwt.js); [packages/gateway/test/hubAuth.test.js](../../packages/gateway/test/hubAuth.test.js); [docs/parity/evidence/2026-09-06/hardware/h10-cache-rotation/review.json](../../docs/parity/evidence/2026-09-06/hardware/h10-cache-rotation/review.json).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Bounded HMAC JWT and upgrade rejection behavior: 1,965 exact outcomes on Node 22 and Node 20 against original Node 8, with main integration replay. Native lifecycle and account extension remain open.

Candidate report: [docs/parity/candidates/H-10.md](../../docs/parity/candidates/H-10.md).

Lead review: Codex root; [docs/parity/reviews/h10-root/review.json](../../docs/parity/reviews/h10-root/review.json). Complete task acceptance is still governed by the main checkbox above.

### N-01 — Honor complete parser requests and load every named rule

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-02, V-03.

The accepted compiled profile loads and verifies all 98 public graphs and 16 factory files, honors requested rules and matches 42 original multi-rule HTTP/routing cases. The 20,528-row compiled HTTP replay is exact; default AST still has 295 accepted-baseline differences and unsupported dependency boundaries. Moth clock/timer local turns are verified through client text injection. Complete cross-profile rule/dependency acceptance remains open.

Done when:

- Accept text/rules/loop/external as one request; select only requested known rules and return the winning rule name.
- Inventory and import every required named rule and dependency with hashes; do not silently skip parse/load failures.
- Cover empty/unknown/multiple rules and local turns that must never activate launch rules.

Source: [Original Pegasus packages/parser/src/robustparser/RobustParserClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/robustparser/RobustParserClient.ts); [Original Pegasus packages/parser/src/utils/RulesRegistry.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/RulesRegistry.ts); [Original Pegasus packages/parser/robust-parser/rules_src](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src).

Phoenix: [packages/nlu/src/index.js](../../packages/nlu/src/index.js); [packages/nlu/src/fullGrammar.js](../../packages/nlu/src/fullGrammar.js); [packages/nlu/resources](../../packages/nlu/resources).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Full parser request and named-rule selection/dependency loading; generalized local-turn repair, pending lead original/hardware verification.

Candidate report: [docs/parity/candidates/N-01.md](../../docs/parity/candidates/N-01.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/production/integration-smoke/comparison.json](../../docs/parity/evidence/2026-09-05/production/integration-smoke/comparison.json). Complete task acceptance is still governed by the main checkbox above.

### I-01 — Match all history HTTP routes and payloads

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01.

P04-P07 reproduce empty-result, GET-route, input-validation and saved-record response differences.

Done when:

- Implement GET and POST query variants, complete saved launch/payload records, no-match null and speech create/update behavior.
- Compare URL/query/body parsing, errors and unknown IDs using the unmodified history client.

Source: [Original Pegasus packages/history/src/HistoryService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/HistoryService.ts); [Original Pegasus packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts); [Original Pegasus packages/history/src/speech/SpeechHistoryRequestsHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/speech/SpeechHistoryRequestsHandler.ts).

Phoenix: [packages/history/src/index.js](../../packages/history/src/index.js).

Evidence: pending.

### D-01 — Match the common relay and cache contract

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01.

Weather/news/maps share a useful relay implementation; cache/error/prefetch equivalence is not fully verified. Original execution confirms cache-hit JSON bytes use text/html, skipCache=false still skips cache, and empty calendars retain the relayData envelope.

Done when:

- Compare GET/HEAD validation, cache hit/miss, skipCache, TTLs, metadata, warming and upstream status/error envelopes.
- Use deterministic cache/time/upstream fixtures to prove prefetch responds immediately and handles upstream/cache failures as the reference does.

Source: [Original Pegasus packages/lasso/src/relay/AbstractRelayRequestHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/AbstractRelayRequestHandler.ts); [Original Pegasus packages/lasso/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/tests).

Phoenix: [packages/data/src/relay.js](../../packages/data/src/relay.js); [packages/data/src/cache.js](../../packages/data/src/cache.js); [packages/data/src/index.js](../../packages/data/src/index.js).

Evidence: pending.

## 2. Complete parsing, data and state behavior

### H-06 — Verify proactive context/history selection and payloads

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: H-05, I-02.

Context/IH implementations and random selection exist; the complete filter pipeline and history side effects need differential verification.

Done when:

- Replay NEW_ARRIVAL and SURPRISE with focused person, multiple/no candidates, every context/IH operator and date boundary.
- Verify memo, speaker/referent, skipSurprises, no-action/final frames and seeded selection through actual history/settings services.

Source: [Original Pegasus packages/hub/src/proactive](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/proactive); [Original Pegasus packages/interfaces/src/proactive](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/interfaces/src/proactive).

Phoenix: [packages/gateway/src/proactive](../../packages/gateway/src/proactive).

Evidence: pending.

### H-07 — Complete original ASR behavior through a replaceable provider

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: H-02.

Reviewed streaming OGG/FLAC and chunk-independent VAD remain integrated. Native quiet OGG/FLAC/LINEAR16 have no false SOS. The built Node 20 runtime image passes 34 audio checks on repeat; the retained first run had a 3-second OGG/VAD test timeout, with exact startup cause unresolved. Full acoustic speech, provider behavior, latency and physical wake/ring acceptance remain open.

Done when:

- Use recorded/fake recognizer streams to verify original config languages/encodings/rates, hints, earlyEOS, interim/final transcripts, annotations and timeout behavior.
- Verify chunk boundaries, silence/noise/partial speech, upstream failures and cancellation without live vendor dependence.
- Measure real audio quality/latency separately; a provider replacement cannot silently remove client-visible features.

Source: [Original Pegasus packages/hub/src/asr/google](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/asr/google); [Original Pegasus packages/hub/src/asr/ASRUtils.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/asr/ASRUtils.ts); [Original Pegasus packages/hub/src/utils/FastEOS.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/FastEOS.ts); [Restored Pegasus packages/hub/src/asr/parakeet](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/hub/src/asr/parakeet).

Phoenix: [packages/gateway/src/asr](../../packages/gateway/src/asr); [packages/gateway/src/listenTransaction.js](../../packages/gateway/src/listenTransaction.js); [packages/gateway/test/asr.test.js](../../packages/gateway/test/asr.test.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / audio_encoding_repair.

Candidate scope: Bounded streaming OGG/FLAC decoding and chunk-independent PCM VAD; unit and native quiet-microphone review. Complete H-07 remains open.

Candidate report: [docs/parity/candidates/H-07.md](../../docs/parity/candidates/H-07.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/hardware/native-audio-fixed.json](../../docs/parity/evidence/2026-09-05/hardware/native-audio-fixed.json). Complete task acceptance is still governed by the main checkbox above.

### H-08 — Restore speech and launch-history side effects

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: H-04, I-01, I-03.

Only launch writes exist; speech-history recording/configuration and optional speech logging are absent. V-02 also proves the unknown-speaker launch record differs: original TransactionHelper writes personIDs:["UNKNOWN"], Phoenix filters it to []. Outbound history HTTP headers differ as well; both remain required repairs.

Done when:

- Record and update reference speech fields across ASR, NLU, matches, skill output, redirects and failure paths.
- Verify launch versus update behavior, session/person IDs, redirected skill IDs, flags, fire-and-forget failures and optional log-sink contract.

Source: [Original Pegasus packages/hub/src/listen/ListenTransactionHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts); [Original Pegasus packages/hub/src/utils/TransactionHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/TransactionHandler.ts); [Original Pegasus packages/history-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history-client); [Original Pegasus packages/hub/src/utils/TransactionHelper.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/TransactionHelper.ts).

Phoenix: [packages/gateway/src/historyClient.js](../../packages/gateway/src/historyClient.js); [packages/gateway/src/listenTransaction.js](../../packages/gateway/src/listenTransaction.js); [packages/gateway/src/config.js](../../packages/gateway/src/config.js).

Evidence: pending.

### N-02 — Match grammar execution, factory entities and scoring

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: N-01, V-01.

Original C++ compiler/parser/service source and archived distribution artifacts are recovered and pinned. Root verified all 60 active reference build files match the requested 2.8.3 distribution, separately from the bundled 2.8.2 ZIP and v2.7.5 service config. Exact historical source rebuild remains unverified; a disposable modern build fails on missing legacy V8 headers and OpenFST API incompatibility. The accepted explicit compiled98 profile now avoids the historical mixed-score cancellation failure; default AST gaps, grammar compilation and broader factory semantics remain open.

Done when:

- Differentially test semantic actions, recursion, optional/repeated rules, wildcards, equivalents, locale/token normalization, weights and designated-loser ties.
- Recover all factory entity semantics, including names, places, dates, times, durations and numeric entities, from version-matched source/artifacts.
- Use the production parser in the oracle harness and preserve exact entity values/types; report mismatches per feature.

Source: [Original Pegasus packages/parser/src/robustparser/RobustParserClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/robustparser/RobustParserClient.ts); [Original Pegasus packages/parser/robust-parser](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser); [ConvTech/jibo-nlu/parser/parser.cpp](https://pvindex.org/gitea/ConvTech/jibo-nlu/src/branch/master/parser/parser.cpp); [ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:compiler](https://pvindex.org/gitea/ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:compiler/src/branch/master/); [ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:parser](https://pvindex.org/gitea/ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:parser/src/branch/master/).

Phoenix: [packages/nlu/src/grammar](../../packages/nlu/src/grammar); [packages/nlu/resources/factory-words](../../packages/nlu/resources/factory-words); [packages/nlu/tools/legacyOracleDiagnostic.mjs](../../packages/nlu/tools/legacyOracleDiagnostic.mjs); [scripts/parity-production](../../scripts/parity-production); [docs/parity/NLU-SOURCE.md](../../docs/parity/NLU-SOURCE.md); [docs/parity/evidence/2026-09-06/nlu-source/native-build-provenance-review.json](../../docs/parity/evidence/2026-09-06/nlu-source/native-build-provenance-review.json).

Evidence: pending.

### N-03 — Verify clock, alarm, timer and settings/menu follow-up rules

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: N-02.

The clock/settings/menu graphs are now present in the 98-graph compiled inventory. Root verified Moth clock display/TTS, a five-minute timer create/cancel sequence and short timer expiry through the real client with injected text. Every named rule, value/confirmation/volume/menu boundary and acoustic local-turn path still needs task-specific acceptance.

Done when:

- Replay every clock/settings/main-menu named rule with positive, negative and boundary utterances.
- Verify alarm/timer values, AM/PM, cancellation, confirmation, volume and menu selections through local-turn WS sessions.

Source: [Original Pegasus packages/parser/robust-parser/rules_src/clock](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/clock); [Original Pegasus packages/parser/robust-parser/rules_src/settings](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/settings); [Original Pegasus packages/parser/robust-parser/rules_src/main-menu](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/main-menu).

Phoenix: [packages/nlu/resources/grammar](../../packages/nlu/resources/grammar); [packages/harness](../../packages/harness).

Evidence: pending.

### N-04 — Verify identity, introduction and greeting follow-up rules

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: N-02, N-06.

Identity, introduction and greeting graphs are available in the 98-graph compiled profile. That implementation removes the audit-era missing-file blocker; complete known/unknown-member, ambiguous-name, no-input and multi-turn source comparisons remain unverified for this task.

Done when:

- Cover each named introduction/who-am-i/greeting rule, including no-input/no-match and ambiguous name responses.
- Compare entities/referents and rule names in multi-turn robot transcripts using known and unknown loop members.

Source: [Original Pegasus packages/parser/robust-parser/rules_src/introductions](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/introductions); [Original Pegasus packages/parser/robust-parser/rules_src/who-am-i](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/who-am-i); [Original Pegasus packages/parser/robust-parser/rules_src/greetings](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/greetings).

Phoenix: [packages/nlu/resources/grammar](../../packages/nlu/resources/grammar); [packages/harness](../../packages/harness).

Evidence: pending.

### N-05 — Verify remaining device/content rules and global commands

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: N-02.

The 98-graph compiled profile now includes the inventoried device/content and global-command graphs, with 42 original multi-rule HTTP/routing controls accepted. Full positive/negative fixtures for every named rule and global interruption/local precedence journeys remain open.

Done when:

- Use the rule inventory to cover all remaining named rules and explicit global stop/repeat/thanks/navigation behavior.
- Exercise global interruption and local-rule precedence without false launches or over-triggering; no named rule is left without a fixture.

Source: [Original Pegasus packages/parser/robust-parser/rules_src](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src); [Original Pegasus packages/parser/robust-parser/rules_src/globals](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_src/globals).

Phoenix: [packages/nlu/src/fullGrammar.js](../../packages/nlu/src/fullGrammar.js); [packages/nlu/resources/grammar](../../packages/nlu/resources/grammar).

Evidence: pending.

### N-06 — Implement LoopMemberDetector and contextual entity resolution

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: N-01.

The request parser now accepts loop context and performs ordered member enrichment, emitting loopMemberReferent, given-name and last-name fields. Source-backed loop-name cases are part of earlier bounded NLU reviews. The complete aliases, punctuation, duplicates, missing members, ambiguity and speaker/referent matrix remains unverified.

Done when:

- Port the source's ordered name/referent resolution and given-name/last-name/loopMemberReferent output semantics.
- Match source fixtures for aliases, punctuation, duplicates, missing members, ambiguous references and speaker/referent interactions.

Source: [Original Pegasus packages/parser/src/utils/LoopMemberDetector.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/LoopMemberDetector.ts); [Original Pegasus packages/parser/tests/utils/LoopMemberDetector.test.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/tests/utils/LoopMemberDetector.test.ts).

Phoenix: [packages/nlu/src/index.js](../../packages/nlu/src/index.js).

Evidence: pending.

### N-07 — Match fallback arbitration and external-agent behavior

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: N-01, V-01.

The fallback has eight generic tools, ignores external agents/enabled flags, and defaults to a 12-second timeout while the gateway parser budget is 10 seconds.

Done when:

- Exercise original HIGH/LOW/SKIP, absent/invalid/decoy fallback, per-rule failure and external-agent matrices against recorded provider outputs.
- Preserve fallback entities, rules and external result structure through a replaceable provider; cover the archived intent/entity catalog.
- Verify enabled/disabled configuration, timeout budgets, cancellation and unavailable-provider behavior for each supported profile.

Source: [Original Pegasus packages/parser/src/handlers/ParseRequestHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/handlers/ParseRequestHandler.ts); [Original Pegasus packages/parser/src/dialogflow](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/dialogflow); [Restored Pegasus packages/parser/src/llm](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/parser/src/llm); [Original Pegasus packages/parser/tests/ParserService.test.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/tests/ParserService.test.ts).

Phoenix: [packages/nlu/src/index.js](../../packages/nlu/src/index.js); [packages/nlu/src/llmFallback.js](../../packages/nlu/src/llmFallback.js).

Evidence: pending.

### N-08 — Restore exact NLU outputs and close corpus mismatches

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: N-02, N-07, H-03, V-03.

The default AST parser matches 20,479/20,528 original HTTP requests with 49 residual differences, after the F1 launch-union repair (f3ed0c8) removed the grammar-priority boost from union scoring and fixed two rows with zero regressions. Those 51 are now classified into three source-backed families: F1 launch-union priority (2 rows), F2 optimized graph order (47 rows) and F3 AST cost versus native heuristic (2 rows). F2 is NOT repairable in the AST parser: it is the first-path-after-optimization behavior of the native graphs, and the same class as the rejected 700e40c. Root verified on 2026-09-08 that the compiled graph runtime, provisioned with the 98 approved graphs, matches the original on the COMPLETE pinned corpus: 20,528/20,528 with zero differences (docs/parity/evidence/2026-09-08/nlu-compiled-full-replay/review.json). The AST baseline is unchanged and the repo default is still AST, so this closes the corpus-mismatch criterion for the compiled profile only. Remaining: the other acceptance criteria, the served-default decision, external coverage, persistent deployment, and microphone/physical-ring acceptance. DECIDED 2026-09-08 (user): the default parser stays the AST engine and the 49 residuals are accepted as a minor, explained gap, recorded as divergence N1 in DIVERGENCES.md. The compiled runtime remains available opt-in and is exact, but its graph data is not vendored and making it the default would change what a plain checkout runs. No further AST ranking work is warranted: the remaining families are not repairable in that engine.

Done when:

- Return original empty shapes and clean entity payloads, removing parser-only fields where the reference does.
- Make original routing the compatibility behavior; move any desired GQA/weather rewrites to explicit separately tested configuration.
- Reach zero unexplained mismatches across the full pinned corpus, including entities, rules, no-match and skill/memo; split remaining mismatch groups into tracked child tasks.

Source: [Original Pegasus packages/parser/src/handlers/ParseRequestHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/handlers/ParseRequestHandler.ts); [Original Pegasus packages/parser/src/robustparser/RobustParserClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/robustparser/RobustParserClient.ts); [Original Pegasus packages/chitchat-skill/resources/test-manifest.json](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/chitchat-skill/resources/test-manifest.json); [ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:compiler](https://pvindex.org/gitea/ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:compiler/src/branch/master/); [ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:parser](https://pvindex.org/gitea/ConvTech/jibo-nlu@91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e:parser/src/branch/master/).

Phoenix: [packages/nlu/src/index.js](../../packages/nlu/src/index.js); [packages/nlu/src/fullGrammar.js](../../packages/nlu/src/fullGrammar.js); [packages/harness/src/corpusRunner.js](../../packages/harness/src/corpusRunner.js); [docs/parity/NLU-SOURCE.md](../../docs/parity/NLU-SOURCE.md).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / audio_encoding_repair; Codex root.

Candidate scope: Bounded ordinary input/rule punctuation semantics. Full 20,528 status/data replay reviewed: 20,477 matches, 51 unchanged residuals, one repair, zero regressions. Root 7 native CES, 21 class/apostrophe comparisons, 209 HTTP regressions, 716 units and strict43 pass. Full N-08 remains open.

Candidate report: [docs/parity/candidates/N-08-ast-punctuation-literals-20260907.md](../../docs/parity/candidates/N-08-ast-punctuation-literals-20260907.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/nlu-punctuation-literals/review.json](../../docs/parity/evidence/2026-09-07/nlu-punctuation-literals/review.json). Complete task acceptance is still governed by the main checkbox above.

### I-02 — Match history validation and query semantics

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: I-01.

Only partial validation exists; array equality, allowed operator/field combinations and conflicting query conditions need parity.

Done when:

- Port the original event/query/rule validation matrix, timestamps, identifier constraints and failure payloads.
- Verify sorted array EXACT/NOT, all payload operators, nested keys, empty arrays, missing fields, session exclusions and time boundaries against a database oracle.

Source: [Original Pegasus packages/history/src/skilllaunch/validators](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/skilllaunch/validators); [Original Pegasus packages/history/src/skilllaunch/db/SkillLaunchQueryBuilder.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/skilllaunch/db/SkillLaunchQueryBuilder.ts); [Original Pegasus packages/history/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/tests).

Phoenix: [packages/history/src/query.js](../../packages/history/src/query.js); [packages/history/src/store.js](../../packages/history/src/store.js); [packages/history/test/history.test.js](../../packages/history/test/history.test.js).

Evidence: pending.

### I-03 — Preserve history across restart and verify retention

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: I-01.

All history is process-local. P12 demonstrates expired out-of-order insertions survive the current pruning path.

Done when:

- Persist skill-launch and speech records with restart/recovery, stable identifiers, ordering and payload-update semantics.
- Verify eventual 14-day launch expiry independent of insertion order and reference speech retention, including concurrent access and crash recovery.

Source: [Original Pegasus packages/history/src/skilllaunch/schema/SkillLaunchSchema.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/skilllaunch/schema/SkillLaunchSchema.ts); [Original Pegasus packages/history/src/common/db](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/common/db); [Original Pegasus packages/history/src/speech](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/speech).

Phoenix: [packages/history/src/store.js](../../packages/history/src/store.js).

Evidence: pending.

### D-02 — Complete credential CRUD, uniqueness and durable state

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-01.

Credentials are in memory; scope parsing and mutation/duplicate semantics differ, and the legacy assignment-bug fix is an explicit unresolved compatibility decision.

Done when:

- Match required fields, scope handling, active/inactive lookup, duplicate auth codes, wildcard deletion and cross-provider replacement using original fixtures.
- Persist credentials with unique keys and atomic updates across restarts.
- Record the assignment-bug decision with a regression fixture; do not silently label changed deletion behavior as parity.

Source: [Original Pegasus packages/lasso/src/credential](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/credential); [Original Pegasus packages/lasso/src/mongo](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/mongo).

Phoenix: [packages/data/src/credentials.js](../../packages/data/src/credentials.js).

Evidence: pending.

### D-03 — Implement OAuth exchange, refresh and invalidation

- [ ] **todo** · P0 · pegasus · implementation: missing

Owner: Codex. Dependencies: D-02.

Non-test Google/Outlook auth codes return 501; testAuthCode coverage does not exercise OAuth.

Done when:

- Implement exchange/refresh through configurable providers, preserving scopes, expiry, error codes and inactive/revoked state.
- Test success, refresh failure, revoked access, duplicate/replayed codes and credential cache invalidation with recorded provider fixtures.
- Verify a supported current provider using test-owned credentials when available; lack of live access remains a separately visible gate.

Source: [Original Pegasus packages/lasso/src/oauth2](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/oauth2); [Original Pegasus packages/lasso/src/calendar-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/calendar-client); [Original Pegasus packages/lasso/src/credential/Credentials.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/credential/Credentials.ts).

Phoenix: [packages/data/src/credentials.js](../../packages/data/src/credentials.js).

Evidence: pending.

### D-04 — Implement Google/Outlook calendar relay compatibility

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: D-01, D-03.

P08-P09 reproduce a missing relay envelope and HEAD handler. Default providers return 501.

Done when:

- Use the common relay envelope, HEAD, 60-second cache and credential-triggered invalidation; integrate each provider.
- Match endDate defaults/validation, pagination, timezone/all-day normalization, ordering and filtered/invalid events.
- Run report-skill -> Phoenix data -> provider-fixture integration; a provider returning events must reach the report rather than fail envelope parsing.

Source: [Original Pegasus packages/lasso/src/relay/GoogleCalendarHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/GoogleCalendarHandler.ts); [Original Pegasus packages/lasso/src/relay/OutlookCalendarHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/OutlookCalendarHandler.ts); [Original Pegasus packages/lasso/src/utils](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/utils).

Phoenix: [packages/data/src/calendar.js](../../packages/data/src/calendar.js); [packages/data/src/index.js](../../packages/data/src/index.js); [packages/skills/src/report/lassoClient.js](../../packages/skills/src/report/lassoClient.js).

Evidence: pending.

### D-05 — Match weather data and forecast/date semantics

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: D-01.

Open-Meteo substitution exists; historical dates, today/yesterday indexing and complete DarkSky-shaped fields require checks for both baselines.

Done when:

- Replay reference current/historical requests and success/error payloads, preserving units, timezone, icons and optional fields.
- Verify the restored weather shim separately, including past_days indexing and error behavior; any deliberate bug fix has an explicit compatibility test.

Source: [Original Pegasus packages/lasso/src/relay/DarkSkyHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/DarkSkyHandler.ts); [Original Pegasus packages/interfaces/src/personalreport/darksky.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/interfaces/src/personalreport/darksky.ts); [Original Pegasus packages/test-utils/src/lasso-test/DarkSkyTestData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/test-utils/src/lasso-test/DarkSkyTestData.ts).

Phoenix: [packages/data/src/weather.js](../../packages/data/src/weather.js).

Evidence: pending.

### D-06 — Match news payloads, categories and prefetch scheduling

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: D-01.

Bounded RSS→AP image adapter integrated: provider URLs/dimensions reach original NewsParse/NewsViews and real Moth news screens. NPR image gaps, original AP attribution, full AP metadata and poll/cache lifecycle remain open.

Done when:

- Match all category IDs, XML structure, image/attribution/header handling and upstream/cache errors with original AP fixtures.
- Reproduce configurable polling/prefetch behavior, category-specific cache updates and shutdown cleanup.
- Verify RSS translation as an adapter without treating omitted reference fields as parity.

Source: [Original Pegasus packages/lasso/src/relay/APNewsHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/APNewsHandler.ts); [Original Pegasus packages/test-utils/src/lasso-test/APNewsTestData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/test-utils/src/lasso-test/APNewsTestData.ts).

Phoenix: [packages/data/src/news.js](../../packages/data/src/news.js); [packages/data/src/index.js](../../packages/data/src/index.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Preserve provider image metadata in the existing RSS replacement and emit source-compatible AP preview XML. CompleteD-06 remains open.

Candidate report: [docs/parity/candidates/D-06.md](../../docs/parity/candidates/D-06.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/hardware/s13-news-reviewed.json](../../docs/parity/evidence/2026-09-05/hardware/s13-news-reviewed.json). Complete task acceptance is still governed by the main checkbox above.

### D-07 — Match maps routes, modes and commute payloads

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: D-01.

ORS produces Google-shaped responses but does not establish original route-mode/traffic/transit behavior.

Done when:

- Compare coordinate validation, nested query parsing, modes, geometry, units, duration/traffic fields, empty routes and upstream errors.
- Supply equivalent provider behavior or explicitly retain an unresolved feature gap for unsupported modes; do not count shape-only mocks as functional verification.

Source: [Original Pegasus packages/lasso/src/relay/GoogleMapsHandler.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/GoogleMapsHandler.ts); [Original Pegasus packages/test-utils/src/lasso-test/GoogleMapsTestData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/test-utils/src/lasso-test/GoogleMapsTestData.ts).

Phoenix: [packages/data/src/maps.js](../../packages/data/src/maps.js).

Evidence: pending.

### A-02 — Match Classic dispatch, authentication and error handling

- [x] **verified** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-01, C-01.

Bounded signed Account_20151111.CreateHubToken is integrated after root source/native review: authenticated claims, SigV4 native/JS variants, Joi validation and Node 8 HTTP framing. Real Moth completed TLS issuance, authenticated listen/proactive and clock display, then byte-verified rollback. Other Classic operations, permission/LAN-trust paths and token expiry/refetch remain open. Root accepted shared public Loop signature verification before handler execution. Original Node8 client made 36 signed calls plus 8 anonymous-policy controls; 68 root outcome/state checks, 839 combined unit tests and strict 43 pass. Non-Loop auth, unimplemented handlers and live robot acceptance remain open.

Done when:

- Match target version/name aliases, body validation, status, x-amzn-errortype and signed-request parsing with original SDK requests.
- Verify signatures, caller identity, ownership/permissions, expiry/replay behavior and trusted internal credentials using issued test keys.
- Forward required signed/request context headers and exact payloads; keep any LAN bypass explicit and separately tested.
- Implement the original signed Account_20151111.CreateHubToken operation with its token/expires contract and verify it using source-pinned native and JS client requests.

Source: [jiborobot/srv-jibo-server-client/apis/account-2015-11-11.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/account-2015-11-11.normal.json); [jiborobot/srv-jibo-server-client/apis/oobe-2016-10-26.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/oobe-2016-10-26.normal.json); [jiborobot/srv-security-gw/src/controllers/auth.ctrl.ts](https://pvindex.org/gitea/jiborobot/srv-security-gw/src/branch/master/src/controllers/auth.ctrl.ts).

Phoenix: [packages/classic/src/router.js](../../packages/classic/src/router.js); [packages/classic/src/awsJson.js](../../packages/classic/src/awsJson.js); [packages/account/src/robotFace.js](../../packages/account/src/robotFace.js).

Evidence: [docs/parity/evidence/2026-09-10/a02-auth-boundary/review.md](../../docs/parity/evidence/2026-09-10/a02-auth-boundary/review.md) (2026-09-10; Gateway allow-lists, target parsing, expiry/replay, ownership with issued test keys, header forwarding, LAN-bypass absence and error-envelope equivalence, each checked against the pinned gateway/framework/client).

- [x] Candidate implementation — **accepted**; Root review of Luna Max candidate.

Candidate scope: Bounded signed CreateHubToken validation, claims and Node 8 framing integrated into main after root review; unrelated OTA edits excluded. Native TLS issuance/listen/proactive/clock verified at 5e626b8. Complete A-02 remains open.

Candidate report: [docs/parity/evidence/2026-09-06/hardware/a02-native-auth-reviewed.json](../../docs/parity/evidence/2026-09-06/hardware/a02-native-auth-reviewed.json).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/hardware/a02-native-auth-reviewed.json](../../docs/parity/evidence/2026-09-06/hardware/a02-native-auth-reviewed.json). Complete task acceptance is still governed by the main checkbox above.

### A-06 — Complete Settings data/view/ownership compatibility

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, H-01.

Root has accepted bounded Settings getter/view/internal dispatch and mutation behavior (78 getter TCP, 52 mutation cases), local state and disk reopen (29 controls), Lasso transport (48 controls), and Person transport (26 service-boundary, 37 wire and seven original robot error-extractor controls). Account-to-Hub transport is now also accepted: 40 payload/wire, 11 redirect/deadline and eight complete service-response cases agree with the original captures. Every failed-request case allows a following valid response. A further root-reviewed 22-case control preserves provider codes on reads/updates/deletes and omits internal diagnostic codes; an initial candidate regression was repaired before integration. The integrated tree passes 636 units and strict 43-case smoke. Full deployment authentication, OAuth, real Mongo/live providers, migration and whole A-06 remain open.

Done when:

- Compare all four operations, skill selection, default/view schema, partial updates/deletes and per-account/loop access.
- Integrate report and proactive consumers with the reference header/version variants and persisted settings.
- Cover non-report skills and malformed/unknown settings using controller-derived fixtures.

Source: [jiborobot/srv-jibo-server-client/apis/settings-2017-12-19.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/settings-2017-12-19.normal.json); [Original Pegasus packages/hub/src/utils/SettingsClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/SettingsClient.ts); [Original Pegasus packages/report-skill/src/SettingsClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/SettingsClient.ts).

Phoenix: [packages/account/src/settingsFace.js](../../packages/account/src/settingsFace.js); [packages/account/src/settingsData.js](../../packages/account/src/settingsData.js); [packages/account/src/settingsProviders.js](../../packages/account/src/settingsProviders.js); [docs/parity/evidence/2026-09-06/service-integration/settings-mutation-review.json](../../docs/parity/evidence/2026-09-06/service-integration/settings-mutation-review.json).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair; Codex root.

Candidate scope: Bounded Settings error-code projection for read/update/delete operations. Root repaired an ordinary-error code regression and remaining mutation code loss; 22 complete response/Hub request controls and following valid requests agree. All 636 units and strict43 pass. Source Node8 host reproduces 17 preserved container response controls. Full A-06 remains open.

Candidate report: [docs/parity/candidates/A-06-hub-projection-root-20260907.md](../../docs/parity/candidates/A-06-hub-projection-root-20260907.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/settings-hub-projection/review.json](../../docs/parity/evidence/2026-09-07/settings-hub-projection/review.json). Complete task acceptance is still governed by the main checkbox above.

## 3. Verify complete skill output and interactions

### S-01 — Verify GraphSkill sessions and graph execution

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: H-04, V-02.

Root accepted prior request/session preconditions and now source graph allocation across explicit/env standalone and cohosted deployments. All 45 node identities and bounded follow-up traces match; 492 unit tests pass on confirmation after one retained ASR fixture timeout. Strict smoke has 218 differences, 157 removed and none added. Full lifecycle, interruption and session migration acceptance remain open.

Done when:

- Compare graph finalization, subgraph composition, transitions, trace/data updates, terminal states and invalid graph/session errors.
- Continue captured sessions through all follow-up actions, including retries and global interruptions; detect corrupted/replayed sessions.
- Specify whether in-flight reference sessions must survive a cutover and verify the migration/reset policy before release.

Source: [Original Pegasus packages/baseskill/src/GraphSkill.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/GraphSkill.ts); [Original Pegasus packages/baseskill/src/graph/Graph.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/Graph.ts); [Original Pegasus packages/baseskill/src/graph/GraphManager.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/GraphManager.ts); [Original Pegasus packages/baseskill/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/tests).

Phoenix: [packages/skills/src/graph/graphSkill.js](../../packages/skills/src/graph/graphSkill.js); [packages/skills/src/graph/graph.js](../../packages/skills/src/graph/graph.js); [packages/skills/src/graph/graphManager.js](../../packages/skills/src/graph/graphManager.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Codex root with Luna Max candidates.

Candidate scope: Bounded graph allocation per standalone/cohosted host, deterministic exported registry and source node name. 45 source node identities and follow-up trace controls match; 492 unit confirmation passes; strict 218 differences with 157 removed and none added. Full S-01 remains open.

Candidate report: [docs/parity/candidates/S-01-graph-nodeid-public-skills.md](../../docs/parity/candidates/S-01-graph-nodeid-public-skills.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/service-integration/graph-allocation-review.json](../../docs/parity/evidence/2026-09-06/service-integration/graph-allocation-review.json). Complete task acceptance is still governed by the main checkbox above.

### S-02 — Verify global results, speaker overrides and supplemental behaviors

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-01, C-02.

Framework result precedence, analytics and supplemental JCP behavior coverage have not been fully mapped.

Done when:

- Match ListenResult precedence and global cancel/repeat/thanks handling across skill updates.
- Compare speaker overrides, sequence/parallel supplemental behaviors, analytics names/fields and failure handling using original framework tests.

Source: [Original Pegasus packages/baseskill/src/GraphSkill.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/GraphSkill.ts); [Original Pegasus packages/interfaces/src/skill/behaviors.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/interfaces/src/skill/behaviors.ts); [Original Pegasus packages/baseskill/src](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src).

Phoenix: [packages/skills/src/graph/graphSkill.js](../../packages/skills/src/graph/graphSkill.js); [packages/skills/src/graph/nodes.js](../../packages/skills/src/graph/nodes.js).

Evidence: pending.

### S-03 — Verify MIM factories, no-input/no-match escalation and opt-in

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-01, N-06.

QN/AN/MAN/MIM and opt-in implementations exist. Root accepted fallback RNG consumption repair: Dice/Coin are only constructed after valid MIM resolution, matching the original Jedi fallback prompt/ESML/metadata. Full compiled20534 now has zero differences, with external coverage gaps retained. Complete factory and session branch coverage remains open.

Done when:

- Replay each factory's success, failure, no-input, no-match, escalation and terminal branches with frozen inputs.
- Verify repeat, thanks, cancel, wrong identity, unknown speaker, accept/decline and dialog referent changes through complete sessions.

Source: [Original Pegasus packages/baseskill/src/graph/mims/factories](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/factories); [Original Pegasus packages/baseskill/src/graph/mims/nodes](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/nodes).

Phoenix: [packages/skills/src/graph/mims/factories.js](../../packages/skills/src/graph/mims/factories.js); [packages/skills/src/graph/mims/optIn.js](../../packages/skills/src/graph/mims/optIn.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Codex root and Luna Max / http_contract_repair.

Candidate scope: Bounded original Any empty-value routing and chitchat fallback RNG consumption. All 11 previous full compiled differences are removed: 20,534 fixtures, zero differences/invariants, same16 gap instances across8 unhosted answer cases. Integrated532 units/default43 pass on confirmation after retained ASR fixture timeouts. Parent task remains open.

Candidate report: [docs/parity/candidates/H-03-S-03-residual-repair-20260906.md](../../docs/parity/candidates/H-03-S-03-residual-repair-20260906.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/production/residual-repair-full-compiled/review.json](../../docs/parity/evidence/2026-09-06/production/residual-repair-full-compiled/review.json). Complete task acceptance is still governed by the main checkbox above.

### S-04 — Match MIM rendering, conditions, selection and JCP output

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: C-02, S-01.

Bounded command serialization and analytics integrated. Strict smoke has21/26 exact complete actions; source SDK timer cancel and actual smile eye animation work on Moth. Complete MIM/selection/timing parity remains open.

Done when:

- Compare loaded MIM merging, conditions, weighted variants, dice/coin, template expansion, ESML escaping, prompt IDs and meta fields under fixed inputs.
- Verify full JCP action/listen/display trees, timing/GUI thresholds and cancellation behavior against reference output.
- Test variation distributions separately where the reference is intentionally random; do not loosen exact structural comparisons.

Source: [Original Pegasus packages/baseskill/src/graph/mims/utils](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/utils); [jiboV2/jibo-command-protocol/index.d.ts](https://pvindex.org/gitea/jiboV2/jibo-command-protocol/src/branch/master/index.d.ts).

Phoenix: [packages/skills/src/graph/mims/slimmer.js](../../packages/skills/src/graph/mims/slimmer.js); [packages/skills/src/graph/mims/unify.js](../../packages/skills/src/graph/mims/unify.js); [packages/skills/src/jcp.js](../../packages/skills/src/jcp.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Source-backed general MIM/JCP command structure and serialization from existing S-04 findings; root original and hardware review required.

Candidate report: [docs/parity/candidates/S-04.md](../../docs/parity/candidates/S-04.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/production/integration-s04-smoke/comparison.json](../../docs/parity/evidence/2026-09-05/production/integration-s04-smoke/comparison.json). Complete task acceptance is still governed by the main checkbox above.

### S-05 — Match runtime prompt data and date/time behavior

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-04.

Source-backed runtime prompt helpers integrated after independent root correction.433 additional contexts plus a direct DateTime case match the original checked surface, and UTC/Tokyo host results agree. Broader DateTime NLU parsing/mutation APIs and complete task acceptance remain open.

Done when:

- Match pronounceable names/lists, owner/speaker/referent, age/birthdays, emotion and location values for reference contexts.
- Verify date phrasing, timezone offsets, DST, midnight, leap days and seasonal windows independently of the server timezone.

Source: [Original Pegasus packages/baseskill/src/graph/mims/utils/slimmer/PromptData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/utils/slimmer/PromptData.ts); [Original Pegasus packages/baseskill/src/graph/mims/utils/slimmer/LooperData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/utils/slimmer/LooperData.ts); [Original Pegasus packages/baseskill/src/graph/mims/utils/slimmer/NLData.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/graph/mims/utils/slimmer/NLData.ts).

Phoenix: [packages/skills/src/graph/mims/promptData.js](../../packages/skills/src/graph/mims/promptData.js); [packages/skills/src/report/dateTime.js](../../packages/skills/src/report/dateTime.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair.

Candidate scope: Fixture-dependent fallbacks removed; independent review is repairing source guarded partial failures, duplicate speaker selection and DateTime edge methods.

Candidate report: [docs/parity/candidates/S-05.md](../../docs/parity/candidates/S-05.md).

Lead review: Codex root; [docs/parity/reviews/s05-root/review.json](../../docs/parity/reviews/s05-root/review.json). Complete task acceptance is still governed by the main checkbox above.

### S-06 — Verify all MIM, manifest and grammar asset provenance

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: V-03.

The initial inventory hashes vendored assets; imported files alone do not prove reachability or rendering parity.

Done when:

- Map every source MIM, category CSV, view/config, manifest entry and required helper to a Phoenix asset and consuming behavior.
- Check hashes or documented transformations, parse/load every asset and validate that referenced assets resolve.
- Preserve legacy robot asset names/paths; uncovered files become explicit tasks rather than being omitted from progress.

Source: [Original Pegasus packages/chitchat-skill/mims](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/chitchat-skill/mims); [Original Pegasus packages/report-skill/mims](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/mims); [Original Pegasus packages/hub/resources/skills](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/resources/skills).

Phoenix: [packages/skills/resources](../../packages/skills/resources); [packages/gateway/resources](../../packages/gateway/resources); [packages/nlu/resources](../../packages/nlu/resources).

Evidence: pending.

### S-07 — Verify the complete chitchat behavior

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-03, S-04, S-05, S-06, N-08.

The large library and dispatcher exist, but the current corpus grades intent/memo only.

Done when:

- Replay source intent/entity/memo branches, semi-specific categories, fun-and-games transformations and fallback/deflection behavior.
- Compare resulting MIM/ESML/JCP/analytics under identity, emotion, birthday and seasonal contexts, including multi-turn paths.

Source: [Original Pegasus packages/chitchat-skill/src](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/chitchat-skill/src); [Original Pegasus packages/chitchat-skill/resources/test-manifest.json](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/chitchat-skill/resources/test-manifest.json).

Phoenix: [packages/skills/src/chitchatSkill.js](../../packages/skills/src/chitchatSkill.js); [packages/skills/src/chitchat](../../packages/skills/src/chitchat).

Evidence: pending.

### S-08 — Verify personal-report orchestration, preferences and identity

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-03, S-05, H-05, C-03.

Root accepted Report Results analytics and bounded Lasso transport. Fresh51 original Node8 controls match,512 unit tests pass, and configured strict43 now has zero differences/invariants/gaps (218 resolved). Detached prefetch rejection remains different. Complete Report orchestration, preferences/identity, live provider behavior and deployment remain open.

Done when:

- Compare launch intents, UserID/opt-in, ordering/toggles, prefsFromConfig and Settings requests/defaults using the original report tests.
- Verify recognized/unknown speaker, no prefs, all-disabled prefs, partial failures, multi-turn continuation and matching analytics.

Source: [Original Pegasus packages/report-skill/src/PersonalReport.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/PersonalReport.ts); [Original Pegasus packages/report-skill/src/nodes](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/nodes); [Original Pegasus packages/report-skill/src/subgraphs](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subgraphs).

Phoenix: [packages/skills/src/report/personalReport.js](../../packages/skills/src/report/personalReport.js); [packages/skills/src/report/nodes.js](../../packages/skills/src/report/nodes.js); [packages/skills/src/report/userId.js](../../packages/skills/src/report/userId.js); [packages/skills/src/report/settingsClient.js](../../packages/skills/src/report/settingsClient.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Codex root with Luna Max candidate.

Candidate scope: Bounded Report Lasso transport. Root51 source controls match without error-message qualifications;512 units pass. Configured strict43 resolves all218 remaining differences, with zero new differences/invariants/gaps. Detached prefetch rejection remains an explicit divergence; full S-08 remains open.

Candidate report: [docs/parity/candidates/S-08-lasso-snapshot-followup.md](../../docs/parity/candidates/S-08-lasso-snapshot-followup.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-06/service-integration/report-lasso-review.json](../../docs/parity/evidence/2026-09-06/service-integration/report-lasso-review.json). Complete task acceptance is still governed by the main checkbox above.

### S-09 — Verify report weather language and condition tables

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-08, D-05.

Weather condition tables are implemented but need source-driven coverage beyond a few fixtures.

Done when:

- Cover each WeatherParse/MimLogic branch with frozen current/yesterday data, units, precipitation, temperature change and missing values.
- Compare selected MIMs, dynamic values, speech and fallback behavior through the report graph.

Source: [Original Pegasus packages/report-skill/src/subskills/weather](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/weather); [Original Pegasus packages/report-skill/tests](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/tests).

Phoenix: [packages/skills/src/report/weather.js](../../packages/skills/src/report/weather.js).

Evidence: pending.

### S-10 — Verify report news selection and presentation

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-08, D-06.

Image-required and feed-header behavior changed; RSS compatibility is not original AP parity.

Done when:

- Cover configured categories, available/unavailable stories, image/URL requirements, parsing, limits and story order.
- Compare original AP fixture MIMs, titles/attributions, ESML and error paths; verify RSS adapter behavior separately.

Source: [Original Pegasus packages/report-skill/src/subskills/news](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/news).

Phoenix: [packages/skills/src/report/news.js](../../packages/skills/src/report/news.js); [packages/skills/src/report/xml.js](../../packages/skills/src/report/xml.js).

Evidence: pending.

### S-11 — Verify report commute calculations and condition tables

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-08, D-07.

Commute tables exist but maps mode/traffic fidelity and time boundaries remain open.

Done when:

- Cover all travel modes, missing traffic data, severity thresholds, departure times, units and invalid preferences.
- Compare calculations, MIMs, spoken values and failure paths with the reference under frozen time.

Source: [Original Pegasus packages/report-skill/src/subskills/commute](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/commute).

Phoenix: [packages/skills/src/report/commute.js](../../packages/skills/src/report/commute.js).

Evidence: pending.

### S-12 — Verify report calendar classification and phrasing

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-08, D-04.

The report's calendar logic is tested with mocks while the actual data-service envelope is incompatible.

Done when:

- Run personal/work Google/Outlook fixtures through the real Phoenix data and report services.
- Cover no events, merged ordering, all-day/overnight events, today/tomorrow, work hours, timezone/DST and expired credentials.
- Compare classifications, MIM selection, names/times and complete action output.

Source: [Original Pegasus packages/report-skill/src/subskills/calendar](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/calendar).

Phoenix: [packages/skills/src/report/calendar.js](../../packages/skills/src/report/calendar.js).

Evidence: pending.

### S-13 — Implement the report's robot display views

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-09, S-10, S-11, S-12.

Six source-backed report view configs and builders are integrated.61/61 full view JSON comparisons match; weather and three live news images visibly render through original Nimbus on Moth. Calendar/commute hardware and full view matrix acceptance remain open.

Done when:

- Generate every original view config, dynamic field, image path, geometry, unit label and display threshold.
- Compare payloads with source fixtures and render them on a compatible robot/client; lack of simulator rendering is not a completion exemption.

Source: [Original Pegasus packages/report-skill/src/subskills/weather/WeatherViews.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/weather/WeatherViews.ts); [Original Pegasus packages/report-skill/src/subskills/news/NewsViews.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/news/NewsViews.ts); [Original Pegasus packages/report-skill/src/subskills/commute/CommuteViews.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/commute/CommuteViews.ts); [Original Pegasus packages/report-skill/src/subskills/calendar/CalendarViews.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/calendar/CalendarViews.ts); [Original Pegasus packages/report-skill/resources/views](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/resources/views).

Phoenix: [packages/skills/src/report/weather.js](../../packages/skills/src/report/weather.js); [packages/skills/src/report/news.js](../../packages/skills/src/report/news.js); [packages/skills/src/report/commute.js](../../packages/skills/src/report/commute.js); [packages/skills/src/report/calendar.js](../../packages/skills/src/report/calendar.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Six original report view resources and four dynamic builders; root source/runtime/hardware review.

Candidate report: [docs/parity/candidates/S-13.md](../../docs/parity/candidates/S-13.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-05/production/report-view-builders/source.json](../../docs/parity/evidence/2026-09-05/production/report-view-builders/source.json). Complete task acceptance is still governed by the main checkbox above.

### S-14 — Verify example/template skills and skill-host compatibility

- [ ] **todo** · P1 · pegasus · implementation: partial

Owner: Codex. Dependencies: S-01, S-02.

Implementations and tests exist; default /v1/main selection and independently deployed skill equivalence need verification.

Done when:

- Replay the original example/template launch/action graphs and skill-host malformed/error behavior.
- Run each replacement on its own reference URL/port with the original requests and verify all default/explicit route forms.

Source: [Original Pegasus packages/example-skill](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/example-skill); [Original Pegasus packages/template-skill](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/template-skill); [Original Pegasus packages/baseskill/src/SkillService.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/SkillService.ts); [Original Pegasus packages/baseskill/src/BaseSkill.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/baseskill/src/BaseSkill.ts).

Phoenix: [packages/skills/src/exampleSkill.js](../../packages/skills/src/exampleSkill.js); [packages/skills/src/templateSkill.js](../../packages/skills/src/templateSkill.js); [packages/skills/src/skillService.js](../../packages/skills/src/skillService.js); [packages/skills/src/index.js](../../packages/skills/src/index.js).

Evidence: pending.

### Q-01 — Restore original GQA service contracts and behaviors

- [ ] **todo** · P0 · pegasus · implementation: partial

Owner: Codex. Dependencies: V-01, C-02, N-08.

Root accepted bounded GQA core, explicit providers, Account/attribution adapters and attribution HTTP boundaries. Root corrected vendor-JSON parsing and a mock-induced timestamp error;10 fresh original-runtime media cases,36 qualified HTTP-double cases,9 real-Mongo observations,754 units and strict43 pass. Default routing, live providers and whole Q-01 remain open.

Done when:

- Inventory Pegasus GQA/news entrypoints and question routing, Wikipedia/Wolfram/Bing fallbacks, attributions and no-answer behavior from original source.
- Replay archived fake-provider/unit/integration fixtures and match MIMs, JCP/display, metadata and error envelopes.
- Use replaceable live providers while preserving client-visible functionality and mark unresolved provider-specific features explicitly.

Source: [jiborobot/srv-gqa-ws/README.md](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/README.md); [jiborobot/srv-gqa-ws/gqa](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/gqa); [jiborobot/srv-gqa-ws/tests](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/tests); [jiborobot/srv-gqa-ws/pegasus_mims](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/pegasus_mims).

Phoenix: [packages/skills/src/answerSkill.js](../../packages/skills/src/answerSkill.js); [packages/skills/src/jcp.js](../../packages/skills/src/jcp.js); [packages/gateway/resources/skills](../../packages/gateway/resources/skills).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair; Codex root.

Candidate scope: Explicit GQA attribution HTTP parsing, Account-before-body-validation order, and numeric timestamp filtering in the optional memory store. Shared route parsing is opt-in. 10 fresh source HTTP media cases,36 qualified boundary cases,9 Mongo comparisons;754 units and strict43 pass. Full Q-01 remains open.

Candidate report: [docs/parity/candidates/Q-01-http-boundaries-root-20260907.md](../../docs/parity/candidates/Q-01-http-boundaries-root-20260907.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/gqa-http-boundaries/review.json](../../docs/parity/evidence/2026-09-07/gqa-http-boundaries/review.json). Complete task acceptance is still governed by the main checkbox above.

## 4. Complete companion-cloud and restored features

### A-19 — Implement and verify versioned Jot messaging contracts

- [ ] **todo** · P1 · classic · implementation: missing

Owner: Codex. Dependencies: A-01, A-02, A-04, A-14.

Functional child registered from A-18 discovery. Historical models contain 24 versioned Jot pairs; four additional alternate-prefix pairs are observed in archived tests. Phoenix has no Jot service registration. Version and deployed-prefix ambiguity remains open.

Done when:

- Map every required versioned Jot pair and the direct bulk unread-count route to source controllers and clients; resolve model/test prefix conflicts explicitly.
- Compare authentication, loop membership, robot impersonation, content/parts validation and error precedence against original source/runtime.
- Implement and compare create/list/update/read or delivery/seen behavior, pagination, media population and observable event side effects for each required version.
- Verify durable state after restart, retry behavior, cross-loop isolation and original-client messaging journeys; retain external dependency failures.

Source: [server/jot-ws@9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/handlers/message.handler.js](https://pvindex.org/gitea/server/jot-ws@9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/src/branch/master/handlers/message.handler.js); [jiborobot/srv-jot-ws-archived@4432ac5d017ae1971a447f42e7a4b29da7eb2e58:archive/message.spec.js](https://pvindex.org/gitea/jiborobot/srv-jot-ws-archived@4432ac5d017ae1971a447f42e7a4b29da7eb2e58:archive/src/branch/master/message.spec.js).

Phoenix: [packages/classic/src/router.js](../../packages/classic/src/router.js); [packages/classic](../../packages/classic).

Evidence: pending.

### A-20 — Implement and verify versioned VoiceTraining and file contracts

- [ ] **todo** · P1 · classic · implementation: missing

Owner: Codex. Dependencies: A-01, A-02, A-03, A-09.

Functional child registered from A-18 discovery. Three historical model versions define 10 versioned pairs. Current source exports UploadVoiceTraining and ListVoiceTrainings; older UploadFile/RemoveFile/ListFiles/GetFile aliases and their version-specific controllers remain unresolved. Phoenix has no VoiceTraining service registration.

Done when:

- Resolve historical upload/list/file-operation versions and target aliases against original controllers and clients, including unsupported-method errors.
- Compare credentials, ownership, upload key/body validation, size limits, paths and downstream Backup request/response bytes without placeholder success.
- Verify upload/list/remove/get persistence and errors for each required version, including interrupted requests, restart and cross-account isolation.
- Complete original-client or real-robot enrollment/training and retrieval journeys with stored artifacts and provider failures retained.

Source: [server/voice-ws@a0ec047a86d6811176d0f05a6cce5a660a2cadd8:lib/handlers/index.js](https://pvindex.org/gitea/server/voice-ws@a0ec047a86d6811176d0f05a6cce5a660a2cadd8:lib/src/branch/master/handlers/index.js); [jiborobot/srv-voice-ws-archived@0e8dc870beaad8caf1dc9ae415a5d250a580b570:server.js](https://pvindex.org/gitea/jiborobot/srv-voice-ws-archived@0e8dc870beaad8caf1dc9ae415a5d250a580b570:server.js/src/branch/master/).

Phoenix: [packages/classic/src/router.js](../../packages/classic/src/router.js); [packages/classic](../../packages/classic).

Evidence: pending.

### X-01 — Verify restored-branch answer and NLU extensions separately

- [ ] **todo** · P1 · restoration · implementation: partial

Owner: Codex. Dependencies: Q-01, N-07, PM-03.

The 2026 answer path includes Wikipedia-first and different fallback/text behavior; Phoenix currently uses only an LLM or placeholder.

Done when:

- If the restored profile is retained, match Wikipedia-first, LLM tool catalog, fallback text, response normalization, timing and output limits against that specific branch.
- Keep its corpus, configuration and verified counts separate from original Pegasus and prevent implicit intent remaps in the original profile.

Source: [Restored Pegasus packages/answer-skill/server.js](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/answer-skill/server.js); [Restored Pegasus packages/parser/src/llm/LLMClient.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/parser/src/llm/LLMClient.ts).

Phoenix: [packages/skills/src/answerSkill.js](../../packages/skills/src/answerSkill.js); [packages/nlu/src/llmFallback.js](../../packages/nlu/src/llmFallback.js).

Evidence: pending.

### A-03 — Complete Account operations and account lifecycle

- [x] **verified** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02.

Original d69f586 candidate remains withheld. Follow-ups repair event validation and source target/payload behavior; independent review found and repaired leakage into portal/Settings requests. Latest isolated 8ec760 reports 37/37 and 25/25 TCP matrices plus 98/98 AccountUpdated events. Root acceptance, public/internal boundary coverage and full operation/SNS/Mongo/bootstrap lifecycle remain open.

Done when:

- Implement/verify every Account and AccountAdmin operation from the inventory, including signup/authentication, profile, credentials, deactivation and recovery flows.
- Match original validation, roles, errors, ownership, durable state and downstream effects using SDK fixtures.
- Verify the Phoenix portal against the completed backend and preserve existing paired robots during migration.

Source: [jiborobot/srv-jibo-server-client/apis/account-2015-11-11.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/account-2015-11-11.normal.json); [jiborobot/srv-jibo-server-client/apis/accountadmin-2015-11-11.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/accountadmin-2015-11-11.normal.json).

Phoenix: [packages/account/src](../../packages/account/src); [packages/account/portal](../../packages/account/portal).

Evidence: [docs/parity/evidence/2026-09-10/a03-account-lifecycle/review.md](../../docs/parity/evidence/2026-09-10/a03-account-lifecycle/review.md) (2026-09-10; Both Account and AccountAdmin API files checked for operation coverage, a 15-step lifecycle driven end-to-end against a running service, and criterion 3's portal/migration coverage).

- [x] Candidate implementation — **accepted**; Luna Max / capture_writer_repair.

Candidate scope: Repair original internal credentials/target parsing, event validation and raw HTTP framing. Preserve public SigV4 as an explicit deployment adapter. Full Account lifecycle and SNS/bootstrap remain unverified.

Candidate report: [docs/parity/candidates/A-03-review-20260906.md](../../docs/parity/candidates/A-03-review-20260906.md).

Lead review: Hermes root (pasketti); [docs/parity/evidence/2026-09-10/a03-account-lifecycle/review.md](../../docs/parity/evidence/2026-09-10/a03-account-lifecycle/review.md). Complete task acceptance is still governed by the main checkbox above.

### A-04 — Complete Loop operations and membership lifecycle

- [x] **verified** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-03.

Root accepted bounded implementations for Loop records and robot association; membership, invitations and lifecycle events; lists/lookups and shared public signature verification; profiles/enrollment/photos; suspension; and guardian/agreement behavior. The combined invitation integration passed 896 unit tests with seven skips, the strict 43-case gate, and 20 original Node8 client lifecycle calls; root reproduced the verifier and checked 52 artifact/source hashes. Exact source timing controls establish deferred LoopUpdated publication without a universal order relative to LoopCreated. Moth runs reviewed revision9672467: all six services healthy, eight installed Node6 client read-only checks passed before and after deployment, and the complete household store and environment are preserved. Earlier profile/KB and photo ingress checks remain separately scoped historical evidence. Live invitation mail is unconfigured. A-04 remains in progress: source-backed duplicate/reinvite sequences, the conditional adoption/revival criterion, and specific uncovered state/failure/persistence cases are under review. No microphone, screen, ring, destructive household mutation or whole-task acceptance is claimed by this deployment. Review history below preserves the individual acceptance boundaries and receipts; diagnostic wording alone is not a parity gap. Root-reviewed operation evidence and the active follow-up list are in docs/parity/candidates/A-04-acceptance-index-20260908.md. Root accepted existing robot Account reactivation and save boundary after three exact source controller controls, eight originalNode8client checks across Account/Classic and restart, independent review,901unit passes/seven skips andstrict43. Existing identity/keys persist; failed Account save restores committed map state; a successful Account save survives later Loop save failure. Deployment and complete A-04 remain open. Root deployede77a2c0 with six healthy services, eight installedNode6read-only checks before/after, whole household store and environment preserved. Seven synthetic Account-to-Classic recovery checks passed: signed mutation, failed Classic storage, retained Account event, service restarts, realWebSocket payload and durable acknowledgement. No live inactive-account mutation or arbitrary process-kill/exactly-once claim.

Done when:

- Cover all 23 wire operations: creation/update/removal, invitations/membership, robot association, enrollment, names/photos, legal guardian/agreement and suspension.
- Match ownership, membership states, side effects, errors and persistence with real client sequences.
- Preserve adoption/revival behavior in an explicit mode if it requires accepting obsolete loop IDs; do not redefine original errors silently.

Source: [jiborobot/srv-jibo-server-client/apis/loop-2016-03-24.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/loop-2016-03-24.normal.json).

Phoenix: [packages/account/src/robotFace.js](../../packages/account/src/robotFace.js); [packages/account/src/model.js](../../packages/account/src/model.js); [packages/account/src/store.js](../../packages/account/src/store.js); [packages/account/src/loopMembership.js](../../packages/account/src/loopMembership.js); [packages/account/src/loopUpdatedOutbox.js](../../packages/account/src/loopUpdatedOutbox.js).

Evidence: [docs/parity/evidence/2026-09-10/a04-loop-operations/review.md](../../docs/parity/evidence/2026-09-10/a04-loop-operations/review.md) (2026-09-10; All 23 Loop wire operations proven served by a runtime probe (static scanning found 1 of 23 because dispatch uses lowercased comparisons across four modules); gate 1 client-sequence replay against source in the pinned Node 8 runtime at 12/12 with byte-exact Classic forwarding across 34 pairs; adoption confirmed to live on a separate admin endpoint rather than redefining Loop errors).

- [x] Candidate implementation — **accepted**; Luna Max / audio_encoding_repair; Codex root.

Candidate scope: Full A-04 review by root: all 23 Loop wire operations proven served by a runtime probe, gate-1 client-sequence replay against source in the pinned Node 8 runtime at 12/12 with byte-exact Classic forwarding, and adoption confirmed to live on a separate admin endpoint rather than redefining Loop errors. Two comparator defects were repaired during the review (a hardcoded capture count masking byte-exact forwarding, and an isDeleted comparison between raw-wire and SDK-parsed measurements); an initial Phoenix-side isDeleted fix was reverted as unobservable to real clients. Earlier membership-concurrency and invitation-code repairs are folded in.

Candidate report: [docs/parity/evidence/2026-09-10/a04-loop-operations/review.md](../../docs/parity/evidence/2026-09-10/a04-loop-operations/review.md).

Lead review: Hermes root (pasketti); [docs/parity/evidence/2026-09-10/a04-loop-operations/gate1-comparison.json](../../docs/parity/evidence/2026-09-10/a04-loop-operations/gate1-comparison.json). Complete task acceptance is still governed by the main checkbox above.

### A-05 — Complete OOBE reconnect, service tokens and administrative behavior

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-03, A-04.

Published isolated candidate6b600f9 includes setup/reconnect, suspended replacement, unbound relocation, token persistence/expiry, verified OOBE authentication, administrator service-token issuance and UTF-8 QR framing. Root accepted leading-zero Base58 repair after1,030 original encoder matches; combined producta5d04b5 passes924 tests with7 skips and43 strict smoke cases. Installed robot SDK passed28 synthetic checks, including orderly server restart. Public parser candidate7cf0cba awaits root review; combined acceptance, safe deployment, native consumer coverage and A-03/A-04 dependencies remain open.

Done when:

- Verify every normal/admin OOBE target and the complete setup, expired/used-token, reconnect, robot replacement and suspended-loop flows.
- Compare SDK request/response and QR payload framing with original consumers; preserve issued credentials across service/robot restart.
- Retain hardware evidence by robot/firmware/date; prior notes are not a fresh parity run.

Source: [jiborobot/srv-jibo-server-client/apis/oobe-2016-10-26.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/oobe-2016-10-26.normal.json); [jiborobot/srv-jibo-server-client/apis/oobeadmin-2016-10-26.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/oobeadmin-2016-10-26.normal.json).

Phoenix: [packages/account/src/robotFace.js](../../packages/account/src/robotFace.js); [packages/account/src/qrPayload.js](../../packages/account/src/qrPayload.js); [packages/account/portal/qr.js](../../packages/account/portal/qr.js).

Evidence: pending.

- [x] Candidate implementation — **awaiting_review**; Luna Max / capture_writer_repair; Codex root.

Candidate scope: Published combined candidate6b600f9 passes924/7skip andstrict43;28 installed-client synthetic checks passed. Token encoding accepted within bounded scope. Public parser candidate7cf0cba requires root review before combined acceptance/deployment.

Candidate report: [packages/account/src/robotFace.js](../../packages/account/src/robotFace.js).

Lead verification: pending. This candidate does not certify task parity.

### A-07 — Complete Robot records, provisioning and calibration/history behavior

- [ ] **todo** · P1 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, A-04.

Robot operations mostly return defaults/empty data; original persistence and admin/provisioning semantics are unverified.

Done when:

- Map all normal/admin targets and implement durable records, updates, friendly IDs and history/calibration responses from source.
- Verify manufacturing/owner/robot permissions and correct missing-record/error behavior with fixture data.

Source: [jiborobot/srv-jibo-server-client/apis/robot-2016-02-25.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/robot-2016-02-25.normal.json); [jiborobot/srv-jibo-server-client/apis/robotadmin-2016-02-25.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/robotadmin-2016-02-25.normal.json).

Phoenix: [packages/classic/src/robot.js](../../packages/classic/src/robot.js).

Evidence: pending.

### A-08 — Complete Update selection, reporting and package delivery

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02.

OTA package catalog/download paths work under tests, but the API inventory has five normal and three admin operations.

Done when:

- Verify every update operation, version/release/subsystem selection, no-update behavior, progress/reporting and admin publication semantics.
- Check package format, integrity, streaming, retry and restart behavior against the original client with temporary fixture packages.
- Require a controlled hardware update/rollback test before claiming end-to-end firmware parity.

Source: [jiborobot/srv-jibo-server-client/apis/update-2016-03-01.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/update-2016-03-01.normal.json); [jiborobot/srv-jibo-server-client/apis/updateadmin-2016-03-01.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/updateadmin-2016-03-01.normal.json).

Phoenix: [packages/ota/src](../../packages/ota/src); [packages/ota/test/ota.test.js](../../packages/ota/test/ota.test.js); [scripts/build-ota-packages.sh](../../scripts/build-ota-packages.sh).

Evidence: pending.

### A-09 — Make backups durable and match ownership/restore semantics

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, A-04.

The uncommitted backup implementation stores blobs on disk but its index is in memory and ownership enforcement is dropped.

Done when:

- Preserve New/List shapes, signed upload/download semantics, content integrity, limits, ordering and source ownership checks.
- Recover index and blobs across process crashes/restarts; verify backup -> restart -> list -> restore with the original client sequence.
- Perform destructive wipe/restore only in a separately authorized controlled hardware run after backup validation.

Source: [jiborobot/srv-jibo-server-client/apis/backup-2017-02-22.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/backup-2017-02-22.normal.json).

Phoenix: [packages/classic/src/backup.js](../../packages/classic/src/backup.js); [packages/classic/test/backup.test.js](../../packages/classic/test/backup.test.js).

Evidence: pending.

### A-10 — Verify notification token and socket delivery lifecycle

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, A-03.

Root accepted durable local notification lifecycle, verified Account document identity, source validation and the authenticated launcher suspension bridge/startup recovery. Original23 Hapi controls, root23 signed HTTP comparisons, verifiedTLS isolation/restart and751 units/strict43 pass. Other Loop-save producers, distributed persistence/transport and real-robot notification delivery remain open. Root verified the LoopUpdated path on the real robot: saved profile request, native notification frame, original dispatcher event, original LoopManager save callback and canonical KB readback. These are background sync messages without a visible popup. Full notification failure/durability and A-10 remain open.

Done when:

- Compare token issuance/reuse, socket authentication, status, framing, delivery/reconnect/expiry and queue behavior with the original consumer.
- Verify ordering, replay/ack behavior where present in source, persistence and multiple-device/account isolation.
- Exercise the real robot socket endpoint and DNS/TLS configuration separately from HTTP service discovery.

Source: [jiborobot/srv-jibo-server-client/apis/notification-2015-05-05.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/notification-2015-05-05.normal.json).

Phoenix: [packages/classic/src/notification.js](../../packages/classic/src/notification.js).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Luna Max / http_contract_repair; Codex root.

Candidate scope: Bounded verified Notification account identity, source body validation, default colocated suspension publisher and startup recovery. Original23 Hapi cases, root23 signed HTTP cases, verifiedTLS bridge,751 units and strict43 pass. Full A-10 remains open.

Candidate report: [docs/parity/candidates/A-10-authenticated-bridge-root-20260907.md](../../docs/parity/candidates/A-10-authenticated-bridge-root-20260907.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/notification-authenticated-bridge/review.json](../../docs/parity/evidence/2026-09-07/notification-authenticated-bridge/review.json). Complete task acceptance is still governed by the main checkbox above.

### A-11 — Complete key exchange, backup and binary-key operations

- [ ] **todo** · P0 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, A-04.

The nine operation names are present but state is ephemeral; binary and ownership semantics need controller comparison.

Done when:

- Verify all nine operations, request state transitions, encrypted key sharing, backup/restore and binary exchange with original SDK fixtures.
- Preserve ownership, key material, expiry/errors and restart behavior using test-owned keys; prove consumer encryption/decryption round trips.

Source: [jiborobot/srv-jibo-server-client/apis/key-2016-02-01.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/key-2016-02-01.normal.json).

Phoenix: [packages/classic/src/key.js](../../packages/classic/src/key.js).

Evidence: pending.

### A-12 — Implement log ingestion and binary-upload behavior

- [ ] **todo** · P1 · classic · implementation: partial

Owner: Codex. Dependencies: A-02.

Events are a no-op sink; binary uploads return empty destinations.

Done when:

- Match the six normal and one admin operations, validation/errors and synchronous/asynchronous acknowledgments.
- Provide usable binary/ASR upload destinations and a retrievable durable sink where source semantics require them.
- Verify producer retries, trace metadata and retention behavior with the original log client.

Source: [jiborobot/srv-jibo-server-client/apis/log-2015-03-09.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/log-2015-03-09.normal.json); [jiborobot/srv-jibo-server-client/apis/logadmin-2015-03-09.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/logadmin-2015-03-09.normal.json).

Phoenix: [packages/classic/src/log.js](../../packages/classic/src/log.js).

Evidence: pending.

### A-13 — Implement push delivery behind a replaceable provider

- [x] **verified** · P1 · classic · implementation: partial

Owner: Codex. Dependencies: A-02, A-03.

Device registration exists; delivery is a no-op and registrations are in memory.

Done when:

- Match device creation/removal, durable registration, ownership and errors.
- Exercise notification delivery, provider failure/token invalidation and downstream effects through a fixture provider and then an available real client.

Source: [jiborobot/srv-jibo-server-client/apis/push-2016-07-29.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/push-2016-07-29.normal.json).

Phoenix: [packages/classic/src/push.js](../../packages/classic/src/push.js).

Evidence: [docs/parity/evidence/2026-09-10/a13-push-real-client/review.md](../../docs/parity/evidence/2026-09-10/a13-push-real-client/review.md) (2026-09-10; 13 focused tests cover device CRUD, ownership, durability and the fixture-provider delivery/failure/token-invalidation paths. The "available real client" leg was then verified directly: an aws-sdk Service built from the pinned apis/push-2016-07-29.min.json drove CreateDevice/RemoveDevice against the live Phoenix face over SigV4, and the SDK parsed both the S4 Devices list and the typed 404 DEVICE_NOT_FOUND error envelope.).

- [x] Candidate implementation — **accepted**; DeepSeek worker via Hermes delegate_task (second attempt).

Candidate scope: Device CRUD, durable registration, ownership and errors, plus delivery, provider failure and token invalidation through a fixture provider. Root verified the S4 list-output contract against the pinned SDK model before accepting the worker rewriting two pre-existing keyPush assertions, then closed criterion 2 by driving the REAL generated client against the live server.

Candidate report: [docs/parity/evidence/2026-09-10/a13-push-real-client/review.md](../../docs/parity/evidence/2026-09-10/a13-push-real-client/review.md).

Lead review: Hermes root (pasketti); [docs/parity/evidence/2026-09-10/a13-push-real-client/live-probe.json](../../docs/parity/evidence/2026-09-10/a13-push-real-client/live-probe.json). Complete task acceptance is still governed by the main checkbox above.

### A-14 — Implement functional Media and MediaAdmin storage

- [ ] **todo** · P1 · classic · implementation: stub

Owner: Codex. Dependencies: A-02, A-11.

Media create returns empty URLs and list/get return empty arrays.

Done when:

- Implement create/upload/list/get/remove and admin semantics with usable URLs, metadata, encryption flags, access checks and persistence.
- Verify pagination/filtering if required by source, deletion and original photo/media client round trips.

Source: [jiborobot/srv-jibo-server-client/apis/media-2016-07-25.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/media-2016-07-25.normal.json); [jiborobot/srv-jibo-server-client/apis/mediaadmin-2016-07-25.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/mediaadmin-2016-07-25.normal.json).

Phoenix: [packages/classic/src/stubs.js](../../packages/classic/src/stubs.js).

Evidence: pending.

### A-15 — Complete Person data and Collision behavior

- [ ] **todo** · P1 · classic · implementation: stub

Owner: Codex. Dependencies: A-02, A-04.

Person properties have limited in-memory round trips; holidays/answers are placeholders and Collision always reports no collision.

Done when:

- Verify every Person operation, personalized answers, properties and holiday behavior with original fixtures and durable state.
- Implement collision/name matching, thresholds and error responses from archived source, including real collisions and boundary examples.

Source: [jiborobot/srv-jibo-server-client/apis/person-2016-08-01.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/person-2016-08-01.normal.json); [jiborobot/srv-jibo-server-client/apis/collision-2016-11-26.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/collision-2016-11-26.normal.json).

Phoenix: [packages/classic/src/stubs.js](../../packages/classic/src/stubs.js).

Evidence: pending.

### A-16 — Implement ROM certificate exchange and remote operation

- [ ] **todo** · P1 · classic · implementation: stub

Owner: Codex. Dependencies: A-02, A-04.

ROM returns empty certificate/key material.

Done when:

- Implement Create/SetupClient/SetupServer with the original validation, ownership and certificate/credential lifecycle.
- Verify usable remote-operation sessions with the original client, including expiration, failure and reconnect.

Source: [jiborobot/srv-jibo-server-client/apis/rom-2017-10-11.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/rom-2017-10-11.normal.json).

Phoenix: [packages/classic/src/stubs.js](../../packages/classic/src/stubs.js).

Evidence: pending.

### A-17 — Implement IFTTT and Classic NLP behavior

- [ ] **todo** · P1 · classic · implementation: stub

Owner: Codex. Dependencies: A-02, A-04.

IFTTT lists/actions and NLP responses are placeholders.

Done when:

- Match all seven IFTTT operations with identities, triggers/actions/media, delivery side effects and failure behavior through fixture adapters.
- Implement part-of-speech and named-entity output contracts using original examples; empty placeholder arrays are not completion.

Source: [jiborobot/srv-jibo-server-client/apis/ifttt-2017-02-07.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/ifttt-2017-02-07.normal.json); [jiborobot/srv-jibo-server-client/apis/nlp-2016-10-31.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/nlp-2016-10-31.normal.json).

Phoenix: [packages/classic/src/stubs.js](../../packages/classic/src/stubs.js).

Evidence: pending.

### A-18 — Close remaining admin, OAuth-client and LPS contracts

- [x] **verified** · P1 · classic · implementation: unassessed

Owner: Codex. Dependencies: A-01, A-02, A-03.

The API inventory includes services/admin operations beyond the current prefix router; full controller coverage is unassessed. Newly recovered Jot and VoiceTraining functional contracts are assigned to explicit child tasks A-19 and A-20; this registration does not verify their behavior.

Done when:

- Cover remaining targets from A-01, including OAuth-client administration and LPS, with source-derived permissions and side effects.
- Resolve newly discovered non-API-file services into explicit child tasks; do not assume absence of one SDK definition means a feature never existed.
- Finish an operation-by-operation coverage review with no unassigned required surface.

Source: [jiborobot/srv-jibo-server-client/apis/oauthclientsadmin-2017-11-08.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/oauthclientsadmin-2017-11-08.normal.json); [jiborobot/srv-jibo-server-client/apis/lps-2017-12-01.normal.json](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/lps-2017-12-01.normal.json).

Phoenix: [packages/classic/src/router.js](../../packages/classic/src/router.js); [packages/account/src](../../packages/account/src).

Evidence: [docs/parity/evidence/2026-09-10/a18-oauth-lps/review.md](../../docs/parity/evidence/2026-09-10/a18-oauth-lps/review.md) (2026-09-10; Independent verification by a second agent, re-derived from pinned source rather than from the candidate report. All five operations (OauthClients_20171108 Create/ListClients/Update/Remove, Lps_20171201.NewCredentials) confirmed SERVED at runtime, not merely present in source. The two-layer auth model was checked in both repos: all five are absent from the gateway's unauthorizedMethods (20 entries) and unsignedMethods is empty, so every one requires verified AWS4 SigV4; x-amz-credentials is gateway-injected from the verified account in gw.route.ts buildCredentials(), not caller-controlled. Source-derived claims confirmed: CLIENT_ALREADY_EXISTS 409, CLIENT_NOT_FOUND 404, aco scheme defaults (keepAliveTimeout 500 / recoveryTimeout 300 / version 1.0, refresh true), ROBOT_ONLY 403 on LPS, and the LPS bucketPath template including the 0-based getMonth() quirk root had already confirmed at sts.ctrl.ts:26.).

## 5. Verify integration, deployment and hardware

### R-01 — Pass full reference-client and service-substitution tests

- [ ] **todo** · P0 · release · implementation: unverified

Owner: Codex. Dependencies: C-01, C-02, C-03, H-01, H-02, H-03, H-04, H-05, H-06, H-07, H-08, N-01, N-02, N-03, N-04, N-05, N-06, N-07, N-08, I-01, I-02, I-03, D-01, D-02, D-03, D-04, D-05, D-06, D-07, S-01, S-02, S-03, S-04, S-05, S-06, S-07, S-08, S-09, S-10, S-11, S-12, S-13, S-14, Q-01, H-09, H-10.

Existing compose smoke checks use Phoenix-specific skill paths and cannot prove individual service substitution.

Done when:

- Replace one reference service at a time with Phoenix and run original client/fixture scenarios without changing callers, URLs or request shapes.
- Pass complete HTTP/WS/JCP/speech/history/data side-effect comparisons, then run an all-Phoenix stack on the same scenarios.
- Publish exact case counts, failures, missing cases and evidence revisions; require zero unexplained behavioral differences.

Source: [Original Pegasus packages/hub-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client); [Original Pegasus packages/history-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history-client); [Original Pegasus packages/integration-tests-int](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/integration-tests-int); [Original Pegasus packages/integration-tests-ext](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/integration-tests-ext).

Phoenix: [packages/harness](../../packages/harness); [scripts/verify-compose-contract.mjs](../../scripts/verify-compose-contract.mjs).

Evidence: pending.

### R-02 — Verify installation, native/compose startup and data migration

- [ ] **todo** · P0 · release · implementation: unverified

Owner: Codex. Dependencies: R-01, A-02, A-06, A-09.

The portable parser bundle installer and native/Compose startup have bounded reviewed evidence. Root has also integrated an authenticated development launcher at a8ee4bf, with 30 local TLS/token/upgrade/restart checks, 678 units, strict43 and a real Moth trial with verified rollback. Full installation/migration, history and notification durability, host/robot reboot supervision and persistent authenticated rollout remain open. Root patched all 27 installed Moth Node client copies from the pinned source fork; strict TLS and signed ListLoops pass on real Node 6, with historical household preservation and guarded persistent file deployment. Full installation/migration and new patch reboot acceptance remain open. Root accepted a reusable private household snapshot staging utility after source review, preservation/conflict guards, injected write races, private wire/backup/reload comparison and 814 passing unit tests. It stages files without live deployment; full migration and R-02 remain open. Root deployed frozen d7934a6 with isolated workspace dependencies while retaining the private persistent store. Six service health checks, real profile/notification controls, household preservation and clock view/TTS/idle pass. Full installation, migration, crash and reboot acceptance remain open.

Done when:

- Test a clean install and isolated native/compose deployments with correct service names, ports, configuration, startup/shutdown and readiness.
- Verify migration from the current Phoenix stores and, where available, original database fixtures with backup/restore and rollback.
- Make verification commands use temporary stores/test accounts and avoid depending on this machine's .env, siblings or live robot.

Source: [Original Pegasus docker-compose.yml](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/docker-compose.yml); [Original Pegasus cli](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/cli); [Restored Pegasus docs/atlas/runtime-topology.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/runtime-topology.md).

Phoenix: [docker-compose.yml](../../docker-compose.yml); [scripts/run-compose-stack.sh](../../scripts/run-compose-stack.sh); [scripts/run-sim-stack.sh](../../scripts/run-sim-stack.sh); [README.md](../../README.md).

Evidence: pending.

- [x] Candidate implementation — **accepted**; Codex root.

Candidate scope: Bounded authenticated development process launcher and shared Classic HTTPS/notification server. 30 local checks, 678 units, strict43, real native TLS/clock/proactive trial and independent rollback pass. Full R-02 and persistent deployment remain open.

Candidate report: [scripts/parity-robot/AUTHENTICATED.md](../../scripts/parity-robot/AUTHENTICATED.md).

Lead review: Codex root; [docs/parity/evidence/2026-09-07/hardware/authenticated-launcher/review.json](../../docs/parity/evidence/2026-09-07/hardware/authenticated-launcher/review.json). Complete task acceptance is still governed by the main checkbox above.

### R-03 — Verify reliability, limits and observability

- [ ] **todo** · P0 · release · implementation: unverified

Owner: Codex. Dependencies: R-01, H-07, H-08, I-03.

Default timeouts, uncancelled fetches, restart behavior and concurrent load need measured acceptance rather than green unit tests.

Done when:

- Measure latency/throughput against pinned reference budgets with concurrency, slow/unavailable peers, disconnects and repeated restarts.
- Verify bounded memory/queues, timeout cancellation, no cross-robot state leakage and expected error/retry behavior.
- Check trace/log/metrics/configuration behavior and make failures observable without falsely healthy service state.

Source: [Original Pegasus packages/utils/src/service](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service); [Original Pegasus packages/hub/src/listen](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen); [Original Pegasus packages/parser/src/utils/ConcurrentQueue.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/ConcurrentQueue.ts).

Phoenix: [packages/common](../../packages/common); [packages/gateway](../../packages/gateway); [packages/nlu](../../packages/nlu); [packages/history](../../packages/history); [packages/data](../../packages/data).

Evidence: pending.

### R-04 — Verify supported robot/firmware and original-client journeys

- [ ] **todo** · P0 · release · implementation: unverified

Owner: Codex. Dependencies: R-02, R-03, A-05, A-08, A-10, S-13, V-04.

Consumer provenance is recorded in CONSUMERS.md. The user released Moth for SSH testing on 2026-09-05; V-04 now establishes the actual robot loop against this checkout. The simulator remains excluded as an oracle, and the other robot is not touched. Full firmware/client journeys, real microphone behavior, persistence and every skill-family acceptance remain open.

Done when:

- Use pinned original client/source contracts as expectations and Moth for runtime evidence; simulator output cannot close parity. Keep source inspection, native text injection and physical microphone observations distinct.
- Pin supported firmware/client versions and record setup/adoption, auth, real microphone turns, local/global follow-ups, displays, proactive preferences and reconnect.
- Exercise each user-visible skill family and data provider, plus account/loop/settings persistence across server/robot restart.
- Record robot/firmware/configuration, scenario results and logs; arrange explicit authorization for destructive reset/OTA trials when needed.

Source: [Original Pegasus packages/hub-client](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub-client); [Jibo documentation](https://pvindex.org/confluence/display/SER/Jetstream+Service+Details).

Phoenix: [HW-OOBE-TEST.md](../../HW-OOBE-TEST.md); [packages/harness](../../packages/harness); [scripts/point-robot-at-phoenix.sh](../../scripts/point-robot-at-phoenix.sh); [docs/parity/CONSUMERS.md](../../docs/parity/CONSUMERS.md); [docs/parity/HARDWARE.md](../../docs/parity/HARDWARE.md).

Evidence: pending.

## 6. Close the release checklist

### R-05 — Close the source checklist and publish a release parity report

- [ ] **todo** · P0 · release · implementation: unverified

Owner: Codex. Dependencies: R-01, R-02, R-03, R-04, A-01, A-02, A-03, A-04, A-05, A-06, A-07, A-08, A-09, A-10, A-11, A-12, A-13, A-14, A-15, A-16, A-17, A-18.

Completion must cover the scoped product and every required behavior, not just the previous M1-M9 milestone labels.

Done when:

- Reconcile every source operation/rule/asset/test scenario with evidence and require zero missing, stubbed or unexplained-divergent required behaviors.
- Publish separate Pegasus, companion-cloud, hardware and optional restoration results, including evidence revisions and approved exceptions.
- Verify migration/rollback/runbooks, update user-facing status claims and retain regression gates for future changes.

Source: [Restored Pegasus docs/atlas/verification-strategy.md](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/verification-strategy.md); [jiborobot/srv-jibo-server-client/apis](https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/commit/155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis).

Phoenix: [docs/parity/tasks.json](../../docs/parity/tasks.json); [README.md](../../README.md); [PARITY.md](../../PARITY.md); [ROADMAP.md](../../ROADMAP.md); [DIVERGENCES.md](../../DIVERGENCES.md).

Evidence: pending.
