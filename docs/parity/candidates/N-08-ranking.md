# N-08 follow-up: bounded launch ranking arbitration

Status: **working candidate; unverified and awaiting lead review**
Owner: Luna Max
Base: `4e565025a6cae941a9590bec65e947d1c378b4a8`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`

This candidate addresses one source-backed arbitration family in the 298
remaining N-08 rows: launch requests where the chitchat meet-person arms and
the introductions enrollment fallback both match. It also corrects the
source-observed loop full-name result used by the focused N-08 regression.

`packages/nlu/src/grammar/matcher.js` now gives a bounded score adjustment to
the source `HIGH` and `LOW` priority tags: HIGH gains 1.5 points, LOW loses
1.5, and the weighted path score still decides when a concrete neutral path is
materially stronger. This is informed by the pinned source `TopRule` metadata;
it is an intentionally bounded candidate approximation, not a claim that the
whole native heuristic scorer has been reproduced.

`packages/nlu/src/requestParser.js` adds the source-observed meet boundary to
launch arbitration. A generic introductions enrollment result without a
concrete `GivenName` yields to a chitchat meet result, while a concrete named
introduction remains enrollment. The comparison is based on parsed rule,
intent, and entity shape; it does not recognize fixture strings. The focused
tests also retain the specific neutral `doesJiboRememberEvent` and HIGH
`userIsDescriptor` controls so the bounded adjustment does not make broad
catch-alls win indiscriminately.

The pinned source evidence is `RobustParserClient.getBestResult`, which scans
rule responses by heuristic score and only applies its low-rule filtering on an
exact top-score tie, together with the source chitchat and introductions
`TopRule` priority tags. Stored original controls show the resulting boundary:
`have you met darth vader` and `did you meet darth vadar` are
`hasJiboMetPerson`, `meet our friend` is `requestMeetPerson`, and a named
request such as `meet my friend bob` is introductions `enrollment`. The loop
full-name control `who is jane jetson` is `whoIsPerson` with `GivenName: jane`
before loop-member enrichment.

No rule resources, oracle/golden data, corpus fixtures, report views, or native
controls were changed.

## Differential evidence

The preserved N-08 follow-up replay at
`/tmp/n08-followup-full-replay.json` contains 20,230 status-and-decoded-data
matches and 298 differences out of 20,528 original rows. The complete source
controls are in `.parity/reviews/full-original-parser.json`.

I replayed all 298 stored difference rows directly through this worktree's
`parseRequest` implementation. The candidate matches 63 of those rows and
leaves 235 differences: 138 chitchat rows and 97 hub-client
rows. The 63 repaired rows are 1 boundary, 31 chitchat, and 31 hub-client
rows. The critical repaired IDs include `boundary:loop-full-name`,
`chitchat:1886:0:base`, and `hub-client:174:0:base`; the latter two are the
Darth Vader/Vadar controls.

As a regression check, I selected 309 rows that matched before this candidate
from the source intent family and meet-related/boundary controls. All 309
remain exact matches, with zero newly failing rows. The selected-run evidence
is written by the local replay scripts to `/tmp/n08-ranking-selected-before.json`
and `/tmp/n08-ranking-regression.json`; these are derived checks over the
preserved source captures, not retagged captures.

## Validation and remaining scope

Under Node `v22.22.0`:

- `node --test packages/nlu/test/requestParser.test.js` — 9 passed;
- `node --test packages/nlu/test/*.test.js` — 25 passed;
- `node --check packages/nlu/src/grammar/matcher.js` and
  `node --check packages/nlu/src/requestParser.js` — passed.

The selected replay leaves the broader action/opinion/entity arbitration
unresolved, including generic `are you able ...` descriptors, several
like/opinion families, factory/name coverage, and some meet-pet versus
meet-person cases. It also leaves unrelated enrollment false positives such
as `i am an aquarius`, `i am so sorry`, and `i'm missing the game`. These
remaining rows require separate source-backed families rather than a broader
priority bias. This candidate does not claim N-08 completion or full parser
parity. Root should run the full 20,528-case HTTP replay after integration and
review the remaining 235 selected differences before acceptance.

## Root intake — 2026-09-06

The stored result has 235 remaining rows, with no boundary row remaining;
the group count above is corrected from the submitted report. This candidate
is not integrated. The 1.5 priority adjustment and the meet-name arbitration
are inferred compatibility heuristics; their comments do not establish that
the original native scorer uses those rules. Root review must reconcile that
claim with the source and run complete regression coverage before acceptance.
