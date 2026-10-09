# N-08 production NLU compiled-graph runtime and default contracts

Status: candidate unverified. The approved compiled profiles are source-backed
and unit-tested; unprovenanced directory discovery is intentionally rejected.
This candidate does **not** replay the 20,528-case
corpus and does **not** claim to move the `c125`/main 51-residual AST baseline.

Source revision: hashbrown/Pegasus `5c0a7390539663ba749d360de348a428c088505c`.
Native service: ConvTech/jibo-nlu-service `5d6755a5116694e2801438f358b862109cd16ba5`.
Native library: ConvTech/jibo-nlu `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`.
Phoenix worktree head before this implementation: `c04e705`.
Implementation commit: `e1f0fc5ab4c4896b6aae8c6ab3043167b8f521d5`.

Private receipts live under
`.parity/reviews/n08-runtime-default-20260907/` (gitignored).

## Current integration boundary

The earlier directory-acquisition implementation is retained only as an
offline/dev helper for inspecting native handle semantics. The runtime no longer
imports it. `PHOENIX_NLU_COMPILED_FST_DIRECTORIES` is rejected before any graph
bytes are loaded because that selector has no approved inventory, source hash,
artifact hash, or compiler/runtime provenance and therefore cannot be used for
parity evidence or a production profile. Re-enabling it requires a versioned
manifest and an explicit provenance review.

## 1. How the original parser acquires FSTs

Verified by reading the pinned Pegasus files (hashes match the earlier
source-manifest):

| File | sha256 |
|---|---|
| `packages/parser/resources/default.json` | `2283cd6db43d150c38bcd42a4b0ea746a0e414ae5a3fb0d2347423ea3358b581` |
| `packages/parser/src/utils/RulesRegistry.ts` | `7dbe093f3da33a05c6b8842f0f88ea102fbeb9bd210da56e3b2b3b1db8f1d664` |
| `packages/parser/src/robustparser/RobustParserClient.ts` | `2c4b7c1544d82c4e42863cdacf06226fb31f5ba6745827bf165124e3a22b0906` |
| `nluservice/nlu_request_executor.cc` | `48b685e43d39045509b15b5c3743d431518c3f340b66fa89c6cdb386de58359f` |
| `fst_cache/fst_cache.cpp` | `0d962bae76a4b0830a08acd7591162fb16feb4d2ef1e66e10c2ca21a06959590` |

Startup sequence:

1. `ParserConfigProvider.getConfig()` reads `resources/default.json`.
2. Production config has `robustParser.enabled: true`, `startProcess: true`,
   `fstDirectories: ["robust-parser/rules_fst"]`, `loadFSTs: true`.
3. `ParserService.init()` starts `jibo-nlu-service` (`-c` config JSON), then
   `RobustParserClient.init()` **before** the public HTTP listener opens.
4. `RulesRegistry.findRules` globs `**/*.fst` in each configured directory.
   The rule name is the lowercased relative path without `.fst`. The stored
   `fstPath` is `path.join(dir, name) + '.fst'` — the source reconstructs the
   path from the lowered name, not the original glob spelling.
5. When `loadFSTs` is true, `loadAllFSTs` COMPILEs every discovered graph
   with `MAX_PARALLEL_FST_LOAD = 5`. One COMPILE failure rejects init, so a
   missing or malformed FST prevents the public listener from starting.
6. A missing configured directory yields an empty glob, not a throw. An empty
   registry still starts; parse then has no known rules.
7. Factory FSTs are **not** in `fstDirectories`. Native init sets
   `factory_rules/` from `Service.nlu_data_dir` + locale and
   `pre_load_factories_in_memory()` from `factory_list.txt`.
8. Offline packaging is `cli/build-rules.ts`: `grm2fst` every
   `rules_src/**/*.rule`, UNION every `*/launch` handle, SAVE the result as
   `rules_fst/launch.fst`, delete the per-skill launch files.

`fstDirectories` later-name overwrite is the configured-array contract.
The original `Promise.all` across directories is a collision race; production
`default.json` has a single directory, so this candidate loads directories
sequentially in array order.

The public operation is unchanged: `POST /v1/parse` accepts `text` + `rules`
(+ optional `loop`/`external`). It does not accept a grammar or FST payload.

## 2. Native protocol Phoenix must reproduce

`RobustParserClient` talks to `POST /nlu_interface` (not a public ParserService
route). The production request path is:

```text
COMPILE
  REQ_CONTENT.BINARYFST_PATH = <discovered .fst path>
  REQ_CONTENT.URI            = "handle:" + ruleName

PARSE_FROM_URI
  REQ_CONTENT.TXT_STRING     = lowercased request text
  REQ_CONTENT.URI            = "handle:" + ruleName
```

Handle lifecycle, from `nlu_request_executor` + `fst_cache`:

* COMPILE BINARYFST_PATH opens the file (`Could not open binary_fst_path` if
  missing) and stores the graph at `URI`. A later COMPILE of the same URI
  overwrites the cache entry.
* PARSE_FROM_URI looks the URI up in `fst_cache`. A missing handle throws
  `Attempting to read handle, but it does not exist`. Native then builds a
  **fresh** sentence parser per request; factory bytes stay in the cache.
* RESET_MEMORY (`fst_cache.clear_cache`) drops every URI, then re-preloads
  factory graphs. Rule handles do not survive reset.
* REMOVE_FROM_MEM erases one URI.
* UNION (`fst_group_base::fst_union`) is used by `build-rules.ts` to produce
  `launch.fst`. It is not part of `POST /v1/parse`. This candidate does **not**
  reimplement OpenFST union.

Request filtering: unknown names are dropped; if none remain, the client
throws `No rules known by Robust Parser`; `ParseRequestHandler` catches that
and returns EMPTY_NLU. One rule's PARSE failure is caught per-rule and does
not cancel the others.

## 3. Phoenix default profile and migration

Original production default is compiled graphs from `fstDirectories` with
`loadFSTs: true`. Phoenix cannot silently copy that default: the repo does
not ship the binary graphs, and switching the Node default would fail startup
or over-claim the closed 98-rule bundle.

Source-backed Phoenix defaults:

| Situation | Profile |
|---|---|
| No `PHOENIX_NLU_RUNTIME` | `ast` (development / no-bundle path) |
| `compiled-fst` + approved binary pins | closed 98-rule binary profile |
| `compiled-fst` + snapshot manifest | closed 98-rule portable profile |
| `compiled-fst` + `PHOENIX_NLU_COMPILED_FST_DIRECTORIES` | rejected: unprovenanced directory selector |

A selected compiled profile still has **no AST fallback**. The rejected
directory selector fails before any graph is loaded or `listen()` can start.

Migration sequence:

1. Keep AST as the no-bundle compatibility path. Do not change the repo default.
2. Provision the reviewed snapshot/binary bundle. A raw FST directory is not an
   approved migration input.
3. Set `PHOENIX_NLU_RUNTIME=compiled-fst` and exactly one approved acquisition
   contract.
4. Confirm startup validation and the emitted provenance metadata.
5. Revisit making compiled-fst the process default only after that deployment
   class actually has graphs on disk. A full corpus replay is required before
   claiming the 20,528-case baseline moved.

## 4. Bounded implementation

The historical helper wiring is justified by `RulesRegistry` +
`RobustParserClient.loadFSTIntoMemory` / `parseFromHandle`, but it is not a
runtime profile until its graph set has a reviewed provenance manifest.

* `packages/nlu/src/compiledFstAcquisition.js` — offline/dev-only glob and
  handle-protocol helper; it is not imported by the runtime.
* `packages/nlu/src/compiledFstRuntime.js` — approved binary and portable
  snapshot profiles; raw `PHOENIX_NLU_COMPILED_FST_DIRECTORIES` selection is
  rejected before acquisition.
* `packages/nlu/src/requestParser.js` — profile-independent selected-winner
  validation; AST and compiled paths both reject missing intent/SKIP winners.

UNION, text COMPILE, PARSE_FROM_TEXT, and exposing `/nlu_interface` are
intentionally not added.

## Evidence

Commands (Node `v22.22.0`), from this worktree at dirty `c04e705` plus the
files listed above:

```text
node --test packages/nlu/test/compiledFstAcquisition.test.js \
  packages/nlu/test/compiledFstDirectoryRuntime.test.js \
  packages/nlu/test/compiledFstRuntimeGuards.test.js
# 21 tests / 20 pass / 1 expected skip / 0 fail
# skip: approved artifact pins (private binary graphs not in this tree)
# log sha256 734e6a76a4408de6e845a206b871cd1d8792a1ccbf8219bb2611f034fd1b0545

node --test packages/nlu/test/*.js
# 121 tests / 116 pass / 5 expected skips / 0 fail
# log sha256 245762aee751e9612be9c1642709b280b4c5ac598d487a2ad54d0cc360606933

node --test
# 776 tests / 769 pass / 7 expected skips / 0 fail
# predecessor at c04e705 was 761 / 754 pass / 7 skip; this slice adds 15 tests
# log sha256 607ee0e6b6e493855d8b1fe5afb3ab590a26cd4994d6469bf125782463c7d03e
```

Focused controls (synthetic VectorFST files, not the approved 98-rule
bundle): the offline helper preserves handle format, colon-separated directory
parsing, missing-directory behavior, nested-name reconstruction, later-directory
overwrite, COMPILE/PARSE_FROM_URI, failed COMPILE registration, RESET_MEMORY,
REMOVE_FROM_MEM, and in-memory bytes after a disk replace. Runtime controls now
reject `PHOENIX_NLU_COMPILED_FST_DIRECTORIES` before discovery or graph loading,
reject its mix with approved/snapshot settings, and prevent the HTTP listener
from starting. The AST request-parser regression rejects a selected SKIP
candidate without a compiled runtime.

The `c125`/main baseline of 20,528 cases / 20,477 matches / **51 residuals is
untouched**. No full HTTP replay was run. No new coverage is claimed for the
approved 98-rule bundle. No robot, native-host COMPILE, or OpenFST union
measurement was taken.

## What remains unknown / next step

Unknown from this slice:

* Exact native glob sort vs this directory walk on mixed-case names.
* Native `Promise.all` last-writer race across multiple `fstDirectories`.
* OpenFST UNION semantics for a newly built `launch.fst`.
* Directory-mode factory preload via `factory_list.txt` versus loading every
  top-level factory `.fst` (the historical helper does the latter when a
  factory dir is supplied).
* Whether a provisioned original `rules_fst` tree plus this directory runtime
  reproduces the 20,528-case compiled profile. The directory runtime is now
  intentionally rejected, so this is not a Phoenix deployment claim.

Concrete next step: if directory execution is needed in a future deployment,
first produce a versioned manifest that binds the complete graph set to the
approved inventory, source/artifact hashes, and compiler/runtime provenance;
then add an explicit reviewed acquisition contract and bounded native
comparison. Until that work is complete, use the approved binary or snapshot
profile. A full 20k replay is only justified after that reviewed profile is the
one a deployment would actually serve.
