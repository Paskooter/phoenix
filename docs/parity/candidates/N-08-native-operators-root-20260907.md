# N-08 native operators: root acceptance

Root accepts the bounded default AST repair in integration `95942834fdd0ca87b620dae9163cfe56527f4dec`. Its NLU runtime/resources are identical to frozen `e26b0725`, which completed all 20,528 source HTTP cases: 20,460 matches, 68 differences, 81 repairs, zero newly failing IDs, and two changed residual outputs. The earlier 176-difference candidate remains rejected; its 60 new failures are all repaired by this version.

The changes restore persistent explicit per-character heuristics, mandatory base-word cardinality, native PLUS repetition and nested nullable operators, epsilon tag behavior, character-class alternation binding, and parser caching. The score remains an AST approximation; this is not a numeric native-score equivalence claim. Twenty-five valid original native semantic controls agree, while three native runtime failures stay qualified.

The integrated tree passes 588 unit tests with 3 skips and no failures, plus all 43 strict smoke cases with zero differences/invariants/gaps. Merge resolution kept the complete fully replayed matcher and the accepted historical main report; existing main wildcard regressions were retained.

[Public review](../evidence/2026-09-07/nlu-native-operators/review.json). Full N-08 and physical deployment acceptance remain open. The e396 factory/arbitration candidate is undergoing a separate full replay. The ef62 hand-written rule-pair exception is rejected despite its focused matches.
