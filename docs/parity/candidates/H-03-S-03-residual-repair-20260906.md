# Root review: final four compiled-corpus differences

Root accepted the bounded routing and fallback-prompt repairs in `452722c`.
The [complete replay and retained validation history](../evidence/2026-09-06/production/residual-repair-full-compiled/review.json)
identify frozen comparison revision `ef0457f` and the separately tested
integration with Settings Lasso.

The intent router now follows the original `Any.isNotEmpty` behavior. Empty
names no longer add wildcard weight or create an unrelated route; `false`
and zero remain valid values. Root ran 22 original Node 8 controls: the
baseline matched 12 and the repaired candidate matched all 22. The controls
include the three failing production routes and nested empty-value cases.
They use the existing production route/no-route projection, and do not claim
that internal `undefined` and `null` return values are identical.

The original chitchat node creates Dice/Coin only after valid MIM resolution.
Phoenix also created them on fallback, consuming three extra random values.
The repair restores the original prompt, ESML and auto-rule metadata for
“are you a jedi.” Root independently reproduced the focused original emitted
code comparison on Node 22; the full replay uses the separately approved
Node 8 golden. The fixture seed and both harness random streams are unchanged.

The unchanged full compiled-FST comparison now records zero field differences
and zero invariants across 20,534 fixtures. It removed all 11 previous
differences, with none added. The strict gate still fails on eight external
answer cases unhosted on both sides, recorded as 16 gap instances. Missing
coverage remains part of Q-01.

The frozen comparison branch passed 519 unit tests and nine configured
gateway tests. After integration with the accepted Settings Lasso slice,
`npm test` passed 532 tests, skipped three, and passed default strict43. The
initial integrated run had two 3-second ASR fixture timeouts during heavy IO
stalls. Both fixtures then passed unchanged on predecessor and current main,
and one unchanged full confirmation passed. All attempts remain recorded.

Neither H-03 nor S-03 is fully verified. Exact/NOT coercion, nested entity
paths, tree ordering, intentless skill-entity fallback and complete MIM/session
branches still require their own acceptance evidence. Default AST parsing and
real-robot release acceptance also remain separate.
