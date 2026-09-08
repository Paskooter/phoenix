# N-08: make the compiled graph runtime servable as the default

Status: **candidate unverified**. Source-backed provisioning is implemented
and the focused 51-residual set was measured. This candidate does **not**
replay the 20,528-case corpus and does **not** claim that the default-AST
51-residual baseline moved.

Task id: `N-08-compiled-default-20260908`.
Implementation and residual measurement: `6b8a5d8be54faa49327d2fdb357176af7c169c15`.
This write-up is the following docs commit on the same branch.
Source revision: hashbrown/Pegasus `5c0a7390539663ba749d360de348a428c088505c`.
Native library: ConvTech/jibo-nlu `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`.
Node: `v22.22.0`.

Private receipts live under
`.parity/reviews/n08-compiled-default-20260908/` (gitignored).

## What was actually missing

Nothing in the **public graph inventory** is missing for the production
corpus. The approved 98-rule set **is** the original production tree.

| Layer | Count | Notes |
|---|---:|---|
| Original `rules_src/**/*.rule` | 117 | `cli/build-rules.ts` input |
| Original `*/launch.rule` files | 20 | union members, then deleted from disk |
| Original `rules_fst/**/*.fst` after build | 98 | 117 − 20 + 1 unioned `launch.fst` |
| Phoenix `rule-inventory.json` public rules | 98 | hashes match the frozen `rules_fst` tree |
| Phoenix vendored AST sources | 117 | development / no-bundle path |

Verified on this host against the frozen reference checkout
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser`:

- 98/98 public `compiledPath` files exist.
- 98/98 SHA-256 values match `rule-inventory.json`.
- `launch.fst` is `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`.
- All 16 `COMPILED_FST_PROFILE.factoryFiles` exist under
  `build/data/en-us/factory_rules`.
- Disk extra graphs: none. Inventory names absent from disk: none.

The 20 per-skill `*/launch.fst` files are **intentionally absent** from the
public tree. Original `build-rules.ts` unions them and deletes the members.

What *was* missing for Phoenix to **serve** that tree:

1. The binaries are not in git (42 MB `launch.fst`, 46,438,634 payload bytes
   total). The repo default therefore cannot be compiled-fst without a
   provisioned home.
2. Selecting compiled-fst required four explicit binary pins, or a portable
   snapshot, or an open directory glob. There was no installer that copies
   the original `rules_fst` + factory tree, checks inventory hashes, and
   leaves a home the runtime can load with one flag.
3. Phoenix cannot rebuild `launch.fst` from vendored `.rule` files. That
   needs native `grm2fst` plus OpenFST `UNION`. This candidate does not add
   either.

## Original build and acquisition (source)

Verified by reading pinned Pegasus `5c0a739`:

- `packages/parser/src/cli/build-rules.ts`: `grm2fst --grm <rule> --parsing_fst <fst>`
  for every `rules_src/**/*.rule`; then `makeUnionFST` of every `*/launch`
  handle; `SAVE_FST_IN_DISK` to `rules_fst/launch.fst`; delete member launch
  files.
- `packages/parser/resources/default.json`: `fstDirectories: ["robust-parser/rules_fst"]`,
  `loadFSTs: true`.
- `packages/parser/src/utils/RulesRegistry.ts`: glob `**/*.fst`; name is the
  lowercased relative path without `.fst`.
- `RobustParserClient.init` COMPILEs every discovered graph
  (`MAX_PARALLEL_FST_LOAD = 5`) before the public listener is useful.
  `POST /v1/parse` is still `text` + `rules`; it does not accept a grammar
  payload.

Phoenix already had in-process COMPILE / PARSE_FROM_URI for discovered
graphs. This slice adds a **closed** provisioner for the approved 98-rule
profile, which is the tree the 20,528-case compiled replays used.

## What this candidate built

* `scripts/install-nlu-compiled-graphs.mjs` — copy original `rules_fst` +
  factory files after checking every inventory/profile hash; write
  `receipt.json`; load the staging tree through `compiledFstRuntime.js`
  before an atomic rename.
* `packages/nlu/src/compiledFstHome.js` — receipt schema
  `phoenix.nlu.compiled-fst-install` / version 1 / `approved-binary`.
* `compiledFstRuntime.js` — `PHOENIX_NLU_RUNTIME=compiled-fst` plus
  `PHOENIX_NLU_COMPILED_HOME` (or `runtime/nlu-compiled` when a receipt is
  already present) selects the closed binary profile. Snapshot, directory
  glob, and four-pin binary settings remain mutually exclusive.
* `docker-compose.nlu-compiled.yml` — opt-in overlay, same shape as the
  portable snapshot overlay.
* Focused residual probe: `packages/nlu/tools/probeCompiledResiduals.mjs`.

The **no-env default remains AST**. Unit tests and a git clone without
graphs still use the AST parser. Compiled is now *servable* as the
deployment default after one install command and `PHOENIX_NLU_RUNTIME=compiled-fst`.

```sh
node scripts/install-nlu-compiled-graphs.mjs \
  --rules-dir /path/to/robust-parser \
  --factory-dir /path/to/en-us/factory_rules \
  --output runtime/nlu-compiled

PHOENIX_NLU_RUNTIME=compiled-fst \
PHOENIX_NLU_COMPILED_HOME=runtime/nlu-compiled \
  node packages/nlu/src/index.js
```

For Compose: `PHOENIX_NLU_COMPILED_HOME=./runtime/nlu-compiled docker compose -f docker-compose.yml -f docker-compose.nlu-compiled.yml up`.

## Measurement — the 51 residuals

Not a full replay. The 51 default-AST residual ids from
[N-08-residual-families-20260907.json](N-08-residual-families-20260907.json)
were parsed with `parseRequest` and compared to original HTTP `data`
(`intent`, `entities`, `rules`) from
`/home/shell/work/phoenix/.parity/reviews/full-original-parser.json`
SHA-256 `ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d`.

Commands, from this worktree at `6b8a5d8`:

```text
node scripts/install-nlu-compiled-graphs.mjs \
  --rules-dir $REF/packages/parser/robust-parser \
  --factory-dir $REF/packages/parser/robust-parser/build/data/en-us/factory_rules \
  --output .parity/reviews/n08-compiled-default-20260908/nlu-compiled
# exit 0; 98 graphs; 16 factory files; 46,438,634 payload bytes
# launch sha256 2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a
# install.json sha256 be2258d87fed1822d11217c6604a3bbaa62b47af66bbf860678bc9e7bae038c0

PHOENIX_NLU_RUNTIME=compiled-fst \
PHOENIX_NLU_COMPILED_HOME=$PWD/.parity/reviews/n08-compiled-default-20260908/nlu-compiled \
node packages/nlu/tools/probeCompiledResiduals.mjs \
  --original /home/shell/work/phoenix/.parity/reviews/full-original-parser.json \
  --families docs/parity/candidates/N-08-residual-families-20260907.json \
  --out .parity/reviews/n08-compiled-default-20260908/compiled-residuals.json
# compiled-fst-approved: 51/51 matches, 0 differences
# F1 2/2, F2 47/47, F3 2/2
# compiled-residuals.json sha256 0fa9641051df83ca23ccca9ad7f801ecce64a47ff3b39a49bf57a152dbf371f4

PHOENIX_ENV_FILE=/dev/null node packages/nlu/tools/probeCompiledResiduals.mjs \
  --original /home/shell/work/phoenix/.parity/reviews/full-original-parser.json \
  --families docs/parity/candidates/N-08-residual-families-20260907.json \
  --out .parity/reviews/n08-compiled-default-20260908/ast-residuals.json
# ast: 0/51 matches, 51 differences (the residual set is still all AST misses)
# ast-residuals.json sha256 e0a44918994fc930821ffbdb8a6fcce2611704531e2eeeb5cedd5324821a66a3
```

`$REF` is the frozen hashbrown checkout
`5c0a7390539663ba749d360de348a428c088505c`.

| Family | Residual rows | Compiled matches | AST matches |
|---|---:|---:|---:|
| F1 launch-union priority | 2 | 2 | 0 |
| F2 optimized graph order | 47 | 47 | 0 |
| F3 AST cost vs native heuristic | 2 | 2 | 0 |
| **total** | **51** | **51** | **0** |

So the compiled runtime, served from a provisioned copy of the original
98-rule tree, resolves **all 47 F2 rows** on this focused set, and also
resolves F1 and F3. That is parseRequest vs original HTTP `data`, including
loop-member enrichment. It is not a full 20,528 replay.

Prior root evidence (not re-run here): the portable/compiled profile has
zero field differences across 20,534 production cases. This slice is
consistent with that, but does not replace it.

## Unit tests and strict gate

Commands from `6b8a5d8` after linking this worktree to the existing
`node_modules` (the worktree had none; coverage scanner requires pinned
TypeScript 2.5.3):

```text
node --test
# 795 tests / 788 pass / 7 expected skips / 0 fail
# log sha256 8fa9619835a05c3eb6f94dd3a21efcb2b56a4f8c5231bea68261f1ccdaa88af9

npm run parity:check
# Checklist: 8/79 verified; tracker valid
# log sha256 b617b77e940362ae51215e2787596e1f649719e6a06a3430fb38c6c39e50ceed

npm run parity:gate -- --out .parity/reviews/n08-compiled-default-20260908/parity-gate
# {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
# log sha256 9ad62ea066ba772660d88bc748ff9da2d48b1f1e178ac1dae141fcc13b99dcb3
# comparison.json sha256 770b732908fc2a65d94c42f06197a14ef4c1054898d0f1ad04744e9fc30291c3
```

The strict 43-case production gate is the default AST profile (no
`PHOENIX_NLU_RUNTIME`). `defaultParserProfile()` without env is still
`ast`. This gate does not measure the 51 residuals.

## Default recommendation

Do **not** flip the repo no-env default to compiled-fst. The binaries are
still not in git. `npm test` and a clean clone must keep working on AST.

Do serve compiled-fst as the **deployment** default once a home is
installed: that is the original `default.json` contract, and the 51
residuals all match on this revision. A full HTTP replay on a process
that actually starts with `PHOENIX_NLU_RUNTIME=compiled-fst` is still
required before calling the 20,528-case baseline moved.

## What remains unknown / next step

Unknown from this slice:

* Full 20,528 (or 20,534) replay on this revision with the provisioned home.
* Native `grm2fst` rebuild of `launch.fst` from vendored `.rule` files
  (not attempted; UNION is still not implemented).
* Whether auto-selecting compiled when `runtime/nlu-compiled/receipt.json`
  exists *without* `PHOENIX_NLU_RUNTIME` would break AST unit tests that
  call `parseRequest` with no env. This candidate does not do that.
* Robot / microphone / ring acceptance.

Concrete next step for root: run the full frozen HTTP replay against this
revision with `PHOENIX_NLU_RUNTIME=compiled-fst` and
`PHOENIX_NLU_COMPILED_HOME` pointing at an installer output. If that is
zero differences, keep AST as the no-bundle default and document compiled
as the provisioned production default. Do not reopen AST ranking for F2.
