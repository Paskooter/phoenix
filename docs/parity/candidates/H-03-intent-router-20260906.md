# H-03 intent routing — verified

Phoenix now uses the original grouped decision tree for exact, NOT and wildcard
entity matching, nested paths, parent fallback, weights, memo and launch-rule
checks. It preserves the pinned Node 8 tie order, including repeated calls
that reorder stored decisions. An intentless or unregistered `entities.skill`
value does not cause a launch.

Codex root verified H-03 on 2026-09-07. Candidate `9c28ed4` is integrated at
`6380425`; its runtime file matches the reviewed frozen candidate byte for byte.
The [root review](../evidence/2026-09-07/intent-router/review.json) records:

- 35 fresh original Node 8/candidate controls with matching functional outcomes.
- 48 applicable unchanged original tests passing, with one original skip.
- Seven large and repeated sort controls matching, including 1,024 entries.
- All 20,528 routing decisions matching in the complete 20,534-case compiled
  production replay, with zero field differences or invariant failures.
- 539 integrated unit tests and the 43-case smoke check passing.

The source controls are retained in the regular regression suite. One invalid
configuration produces different Node 8/22 TypeError wording; its failure
class and routing outcome agree, so it is nonblocking under the user's
consumer-focused compatibility policy.

The full production comparator still reports the same eight unhosted external
answer-service cases (16 gap instances). They do not omit routing evidence and
remain Q-01/release work. The nine source-only older-firmware mediation tests
belong to H-04's launch-stage behavior. Complete listen transactions, skill
sessions and hardware acceptance remain in their own tasks.
