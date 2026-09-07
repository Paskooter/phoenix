# N-08 apostrophe semantics — root accepted

Phoenix now preserves apostrophes in input tokens and grammar literals, so an
explicit apostrophe in a source grammar can distinguish `we're` from `were`.
The fix removes the previous apostrophe erasure; it does not change other
punctuation handling or select a new parser profile.

Root reproduced the original Node 8 handler/client preparation for six inputs
with recording transport seams and reran eight grammars through the archived
native compiler/parser. All 21 focused acceptance controls now agree, up from
19. The 209-request HTTP regression subset retains 157 matches and unchanged
status/data/error outcomes.

Luna completed the full 20,528-request HTTP replay: 20,476 matches and the same
52 differences as the accepted class-word repair. Root independently verified
its terminal receipt, pinned inputs, driver and output hashes, all residual
records and exact application package identity with integration `c720c46`.
Root then ran the complete npm test command: 677 unit passes, seven skips and
strict43 with zero differences, invariants or gaps. No new full-corpus matches
are attributed to this apostrophe fix.

The [sanitized review](../evidence/2026-09-07/nlu-apostrophes/review.json)
records execution ownership and scope. The [original candidate report](N-08-apostrophe-public-boundary-20260907.md)
retains its earlier baseline measurements. Complete N-08, the remaining 52
AST differences, persistent deployment and robot microphone/ring acceptance
stay open. This accepted slice adds no checklist completion credit.
