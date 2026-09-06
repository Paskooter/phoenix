# Original NLU source and verification

Phoenix's parser rewrite uses the original C++ lexer, grammar compiler, FST
operations and parser source, together with Pegasus's TypeScript service and
request-handling code. Original source and native results define expected
behavior. Existing Phoenix output and corpus guesses do not define it.

The native source is
[`ConvTech/jibo-nlu@91b1bb6`](https://pvindex.org/gitea/ConvTech/jibo-nlu/src/commit/91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e).
Its `build.bash:62` declares `VERSION=v2.8.3`. The frozen local copy is
`.parity/consumers/git/ConvTech/jibo-nlu/91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`.
The [manifest](evidence/2026-09-06/nlu-source/source-manifest.json) records all
121 source files and their hashes. The 104,098-byte source archive has SHA-256
`3bf858a742b9caeb157c1cf4010ff314e94e58b19bfc413d67141a0861b00f51`.

The archived native 2.8.3 compiler/parser binaries are also executed for
behavioral comparisons. Their distribution archive has SHA-256
`388646e950660d8ae00e1c96e6791c85e688cc2193ed0dcf744b33538b34113b`.
The source version and binary artifact are pinned separately; a reproducible
rebuild proving their exact build relationship remains unverified.

| Behavior | Original implementation | Parity task |
|---|---|---|
| Grammar tokens and syntax | `compiler/compiler.l`, `compiler/compiler.ypp` | N-02 |
| Character/group/reference construction | `compiler/list_manip.cpp`, `compiler/rule_cmp.cpp` | N-02 |
| FST optimization and traversal | `fst_operations/`, `parser/` | N-02 |
| Native score and parse outputs | `parser/parser.cpp`, `parser/result_fst.cpp`, `parser/result.cpp` | N-02/N-08 |
| Requested rules and native service interaction | Pegasus `packages/parser/src/robustparser/`, `utils/RulesRegistry.ts` | N-01 |
| Loop-member entity enrichment | Pegasus `packages/parser/src/utils/LoopMemberDetector.ts` | N-06 |
| HTTP requests, fallback and external agents | Pegasus `packages/parser/src/handlers/ParseRequestHandler.ts` | N-01/N-07 |

Pegasus's separate source pin is
`5c0a7390539663ba749d360de348a428c088505c`. Native CLI probes establish the
compiler/parser behavior they exercise. Full service comparisons additionally
exercise the original wrapper, grammar inventory, factories and HTTP behavior.
Neither kind of evidence substitutes for the other.

For example, the [optional-atom review](evidence/2026-09-06/nlu-optional-atoms/review.json)
traces `?` through the original compiler and confirms its behavior with the
native binaries. That review rejected a duplicate-character special case and
replaced it with the general code-point/group rule. The replacement remains a
candidate until its regression review is complete.

Source recovery does not close N-02 or N-08. Compiled-path ordering, complete
grammar/factory behavior and full corpus agreement remain open and are tracked
in the [checklist](TASKS.md).
