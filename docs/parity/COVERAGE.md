# Source coverage and corpus denominators

The frozen target is Pegasus `5c0a7390539663ba749d360de348a428c088505c`. This inventory makes the remaining work enumerable. It does **not** certify Phoenix parity, and its overlapping counts must not be added into a feature percentage. V-03 remains in progress for the complete Phoenix baseline and final review. The strict grader now exports all 20,534 cases; complete original controls agree but retain eight unhosted external-action cases. See [the current evidence](PRODUCTION.md).

The machine-readable [source inventory](evidence/2026-09-05/coverage/source-inventory.json) assigns owning task IDs to every source file, test case, public operation, contract, grammar and asset set. [Syntax facts](evidence/2026-09-05/coverage/syntax-facts.json) retain source locations and declarations. [Corpus counts](evidence/2026-09-05/coverage/corpora.json) retain every duplicate occurrence and overlap.

| Denominator | Count | Meaning |
|---|---:|---|
| Frozen Git files | 6,146 | Paths, modes, sizes and original Git blob IDs |
| Original test declarations | 950 | TypeScript 2.5.3 syntax-tree discovery in test trees; comments and strings excluded |
| Concrete source test cases | 960 | Reviewed expansion of four dynamic declarations; includes one originally skipped test |
| Public service operation instances | 89 | 43 explicit/inherited operations, 16 implicit HEAD operations and 30 implicit OPTIONS operations across eight services |
| Wire type declarations | 223 | Interface, type alias and enum declarations; not a count of messages or fields |
| Runtime grammar source files | 117 | Distinct named sources, including local-turn rules and shared/global rules |
| Other grammar source fixtures | 2 | Parser test resources, kept separate from runtime grammars |
| Compiled runtime grammar names | 98 | Original `.fst` registry names; a separate denominator from source grammars |
| Ad hoc parser requests | 7 | Inputs in an originally malformed script, with no assertions or execution credit |
| Asset sets | 45 | Every non-JS/TS source asset grouped by package and role; individual paths retained |

Nine public operations have **partial** gate links: six to the 28-case [foundation comparison](COMPARISON.md), plus parser, chitchat and report HTTP operations to the [production comparison](PRODUCTION.md). Eight shared HTTP boundaries have partial foundation links. The recorded Phoenix baselines have differences. No operation has a complete gate yet. `missing` means **no reviewed strict parity gate has been mapped**, not that the application feature or a unit test is necessarily absent. Existing unit tests must be reviewed and mapped as their product tasks are handled.

## Original test cases

| Package | Cases |
|---|---:|
| hub | 287 |
| report-skill | 261 |
| lasso | 112 |
| history | 80 |
| baseskill | 61 |
| parser | 46 |
| utils | 27 |
| integration-tests-ext | 26 |
| integration-tests-int | 25 |
| history-client | 10 |
| test-utils | 9 |
| chitchat-skill | 6 |
| utils-common | 4 |
| template-skill | 3 |
| example-skill | 2 |
| hub-client | 1 |

These are source cases, not evidence that a historical runner imported every file or that a live external service was exercised. [Test expansions](../../scripts/parity-coverage/test-expansions.json) pin the original loop/title inputs by Git blob. The external chitchat loop expands to eleven cases. [Source exceptions](../../scripts/parity-coverage/source-exceptions.json) identify the one pre-existing syntax error; any changed or additional parser diagnostic fails inventory generation.

## Preserved corpora

| Corpus | Entries | Command occurrences | Exact unique commands | Conditional branches | Command/condition pairs |
|---|---:|---:|---:|---:|---:|
| Chitchat | 4,705 | 10,035 | 10,027 | 490 | 1,397 |
| Hub client | 2,573 | 7,029 | 7,027 | 594 | 1,973 |
| Report | 6 | 73 | 72 | 0 | 0 |
| Totals before cross-corpus deduplication | 7,284 | 17,137 | — | 1,084 | 3,370 |

There are **10,360 exact unique commands** across the three corpora. Chitchat and hub client share 6,766 unique commands; report shares none. Base commands plus conditional variants define **20,507 fixture occurrences**. No occurrence is removed from its corpus denominator.

The [vendored source manifest](../../packages/harness/resources/corpora/sources.json) pins unmodified bytes and original Git blobs. In the hub-client corpus, 138 entries have no `intent` or `entities` field. Their MIM expectation remains present: these are **not** no-match expectations. The report corpus's `memo` values are strings and remain strings. Empty conditional arrays, explicit false values, field absence and repeated commands are preserved.

Conditional dates and `loopMemberId: uid0001` are historical fixture requirements, not sufficient descriptions of a complete runtime context. The original harness does not execute those branches. A production grader must record its chosen clock, loop/person data and provider fixtures, and report any unresolved historical expectation separately from an original-runtime differential.

## Assets and verification limits

All 4,424 chitchat MIMs, 82 report MIMs, four base MIMs and the template MIM have byte-identical copies in Phoenix resources. Of 117 runtime grammar sources, 29 have byte-identical copies at the mapped grammar locations. The remaining 88 need their task-specific implementation and rule tests. The inventory records exact resource copies using Git blob identity; copying a file does not prove that Phoenix loads or interprets it correctly.

The public operation inventory includes aliases, conditional speech-history routes, inherited health checks and implicit HTTP methods. Authentication, malformed inputs, method/path variations, response shapes, side effects and configuration branches remain separate coverage obligations. Native parser RPC and external/Classic services retain their owning tasks; the 89 operations describe the original eight Pegasus service instances only.

The archived [Pegasus Testing Plan](https://pvindex.org/confluence/display/SER/Pegasus+Testing+Plan) calls for unit, integration, mock-provider, performance and consumer testing. The [Hashbrown QA plan](https://pvindex.org/confluence/display/SQA/Pegasus+Hashbrown+Test+Plan) names 743 regression and 120 smoke cases while excluding new report/proactivity suites from those figures. These historical sets overlap and have not been recovered as case-level exports. They are **unknown external coverage**, owned by R-03/R-04; they are not added to the 960 source cases. A targeted Jibo MCP search found no TestRail export, which does not establish that none can be recovered.

## Reproduce and update

```bash
npm ci --ignore-scripts
python3 scripts/parity-coverage/inventory.py \
  --source ../pegasus --out docs/parity/evidence/2026-09-05/coverage
node --test scripts/parity-coverage/scan.test.cjs \
  packages/harness/test/corpusManifest.test.js
```

The scanner does not execute original tests, hooks or application modules. It reads the frozen Git objects, validates source pins and reviewed expansions, and rejects unassigned packages/tasks or stale route/gate mappings. Regenerate and review the inventory when a task changes its fixtures or resources. Mark an item covered only when its full behavior has an executable gate; task verification additionally requires that gate to pass.
