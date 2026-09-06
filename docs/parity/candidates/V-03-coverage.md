# V-03 coverage inventory candidate

Status: bounded candidate awaiting root review. This candidate only updates the coverage inventory, corpus gate metadata and their focused checks. It does not close V-03, edit the main tracker, change `docs/parity/COVERAGE.md` or `docs/parity/PLAN.md`, rewrite a source/golden, or claim Phoenix parity.

The candidate is based on `794526320d73c451152eb8d187c322137480ff55` in branch `codex/candidate-v03-coverage-20260906`.

## Inventory correction

The three preserved corpora no longer carry the stale `missing-strict-production-grade` label. Each is `partial` and links the source-pinned `production-v2-full` gate. The gate records per-corpus expanded production cases and retains the manifest denominator:

| Corpus | Base | Conditional | Production cases | Coverage |
|---|---:|---:|---:|---|
| chitchat | 10,035 | 1,397 | 11,432 | PARTIAL |
| hub-client | 7,029 | 1,973 | 9,002 | PARTIAL |
| report | 73 | 0 | 73 | PARTIAL |
| **corpus total** | **17,137** | **3,370** | **20,507** | **PARTIAL** |

The full suite adds 21 parser-boundary and 6 direct-skill cases, so its complete denominator is **20,507 corpus + 27 boundary/direct = 20,534 cases**. The validator checks that the suite IDs, case variants, corpus manifest SHA-256 values and all these sums agree before it emits a partial label.

The gate metadata is [corpus-gates.json](../../../scripts/parity-coverage/corpus-gates.json). It pins the production suite, golden source, reference gzip, baseline review/run, Phoenix source fingerprint, archived comparison and candidate output. The archived baseline is [review.json](../evidence/2026-09-06/production/main-057f67c-full-baseline/review.json): reference revision `5c0a7390539663ba749d360de348a428c088505c`, Phoenix revision `057f67c136358b0d0f2f7f3bf201b23f5664c734`, Phoenix source tree SHA-256 `903e0463d49f22fa718c945d36736afdd22aecd042c55dd9be2a2fec0775e47b`, 49,155 field differences, zero invariants, and 97 side-specific external-action gap instances (8 reference, 89 candidate; 91 unique cases). The candidate comparison is intentionally a mismatch: it proves the named pipeline ran and retained differential output, not that Phoenix passed.

The explicit remaining limits are provider behavior (weather/news/calendar/maps are frozen fixtures), full HubService orchestration/proactive transactions and unhosted external cloud actions, and the original 950 test declarations/960 expanded source cases that remain a separate inventory denominator. The production suite does not imply that every original test file or historical integration was executed.

## Grammar identity correction

The inventory now reports `byteIdenticalPhoenixGrammarCopies: 117` for the 117 named runtime grammar sources that each have at least one exact Phoenix `rules-src` resource copy. It also records 146 copied resource paths because 29 sources have both a `rules-src` copy and a mapped `grammar/` copy. The narrower `identicalMappedRuntimeGrammarSources: 29` count remains visible. Every grammar item remains `coverage: missing`: byte identity is preservation evidence and does not establish that Phoenix loads, compiles or interprets the rule equivalently.

## Files and validation

- `scripts/parity-coverage/inventory.py` validates gate provenance, hashes, source/suite pins, the passing golden-source review, the complete four-tool original-capture set, candidate runtime/profile identity, `captureComplete`/failure state and exact unique candidate ID order, denominators and distinct grammar-copy metrics.
- `scripts/parity-coverage/corpus-gates.json` is the reviewed gate metadata.
- `scripts/parity-coverage/inventory.test.py` checks a valid gate plus artifact-hash drift, metadata-only promotion to `covered`, source-review/tool-set rejection, and temporary candidate fixtures whose updated hashes still reject incomplete/failing, duplicate-ID and reordered captures on semantic grounds.
- `docs/parity/evidence/2026-09-06/coverage/corpora.json` and `source-inventory.json` are regenerated outputs from this candidate. `syntax-facts.json` remains unchanged.

Validation in this worktree:

- `python3 scripts/parity-coverage/inventory.test.py` — 6 passed.
- Full inventory regeneration with the pinned Pegasus checkout at `5c0a7390539663ba749d360de348a428c088505c` and TypeScript dependency — passed; emitted 6,146 source files, 950 declarations, 960 expanded source cases, 117 runtime grammar sources, 20,507 partial corpus cases and 20,534 production cases.
- `node --test scripts/parity-coverage/scan.test.cjs` — 4 passed using the existing root `node_modules/typescript` directory through a temporary worktree-only link; the link was removed after the run.
- `node --test packages/harness/test/corpusManifest.test.js packages/harness/test/productionCompare.test.js` — 13 passed.
- `python3 -m py_compile scripts/parity-coverage/inventory.py scripts/parity-coverage/inventory.test.py` and `git diff --check` — passed.

Root should review the retained artifact hashes and decide whether to reconcile this candidate into the main coverage documentation/tracker. The candidate does not make that acceptance decision.
