# N-08 compiled graph ordering — reviewed investigation

The original compiler changes graph structure through epsilon removal, determinization, optional minimization and weight pushing. Native parsing retains the first path when accumulated costs tie. The AST matcher lacks that optimized graph ordering, so a fixed preference for `$w03`, `$*` or a source arm cannot restore general parity.

Root independently checked eight original source-file hashes and executed the archived native parser on 27 retained compiler graphs. Phoenix's existing compiled-graph executor and output interpreter matched every complete parse object and exposed score. These include wildcard order reversals and two/three-arm permutations beyond the approved deployment bundle. The agent's corresponding 19-case AST investigation retained nine intent differences.

No heuristic matcher change is accepted. The next work is to verify production graph acquisition and runtime compilation requirements, then make the source-compatible compiled path usable across those contracts. The 98-graph fixture bundle must not become a substitute for arbitrary supported grammars. Main's existing AST residual count and the separate compiled-profile corpus result remain qualified as before.

The accepted diagnostic utility `packages/nlu/tools/inspectVectorFstStructure.mjs` exports states and arcs in their stored order. Root exercised it on a native three-arm graph and verified the reader matches main. It does not participate in server execution.

This is an investigation checkpoint, not full N-08 acceptance. [Root controls, hashes and limitations](../evidence/2026-09-07/nlu-fst-order/review.json) include the first comparison's setup failure and the subsequent successful execution.
