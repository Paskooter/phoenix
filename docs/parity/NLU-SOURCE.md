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
replaced it with the general code-point/group rule. The replacement is
integrated after root review: it fixes 17 previous differences with no newly
failing IDs across the 20,528-request HTTP status/data replay. The default AST profile retains 295 differences.

The [compiled-profile integration](evidence/2026-09-06/nlu-compiled-fst/integration-review.json) now executes all 98 pinned public graphs with source scoring and tie rules. It matches all 20,528 archived HTTP parser responses and all 42 [original native multi-rule HTTP/routing cases](evidence/2026-09-06/nlu-compiled-fst/multirule-http-review.json). The latter original capture uses the exact extracted Node 8 executable on the host in an isolated network namespace; it is not a replacement for pinned Docker goldens.

This profile is selected with `PHOENIX_NLU_RUNTIME=compiled-fst` and requires the verified launch graph, public-rule directory, factory directory and approved launch hash. The parser validates and snapshots those artifacts before execution. The default AST runtime remains available.

An earlier launch-only candidate failed on Moth because it compared native scores with AST priority scores. That failure and rollback remain recorded in the [candidate history](candidates/N-08-compiled-fst.md). The repaired all-rule profile uses one scoring scale and is now running on Moth. The [real-client trial](evidence/2026-09-06/nlu-compiled-fst/moth-multirule-review.json) verifies clock display/TTS, joke TTS and a persistent timer's creation and cancellation. Microphone wake-up and physical ring illumination remain unverified.

Source recovery and these bounded checks do not close N-02 or N-08. After the accepted SettingsClient transport and Report analytics fixes, the complete server smoke comparison retains 375 differences, and grammar compilation, broader factory behavior and native build reproduction remain tracked in the [checklist](TASKS.md).

The service callsite is additionally recovered at
[`ConvTech/jibo-nlu-service@5d6755a`](https://pvindex.org/gitea/ConvTech/jibo-nlu-service/src/commit/5d6755a5116694e2801438f358b862109cd16ba5).
Its `execute_parse_from_uri` creates new graph groups and a new sentence parser
for each request. The [file hashes and cache-lifetime correction](evidence/2026-09-06/nlu-compiled-fst/service-cache-lifecycle.json)
distinguish that service behavior from a retained native library parser.
