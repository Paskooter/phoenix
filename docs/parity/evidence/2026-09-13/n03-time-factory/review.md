# N-03 time factory native differential review

Review date: 2026-09-13. The review starts from candidate revision `740385408870aa4c77a392d772f64682e721093a` (`7403854`) on branch `w17/n03`, based on `d7b766f`. The follow-up matcher/test changes and this artifact are intentionally local; they are not integrated or pushed.

## Native oracle and source basis

The oracle is the archived NLU 2.8.3 `parse` binary and the two FSTs from `jiboV2/pegasus` revision `5c0a7390539663ba749d360de348a428c088505c`. The input file is lowercased before the native call, matching the original `RobustParserClient` request path.

| artifact | SHA-256 |
| --- | --- |
| `build/bin/parse` | `373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b` |
| `build/bin/jibo-nlu-service` | `c89487321aeea14dba3e6408e61050f007a9a052b5e2c27283cf58f0e8a1fd54` |
| `rules_fst/clock/alarm_set_value.fst` | `aadf32b0361fb41fb364dfe7b8f5bdfa4773f0f4dfaa67e66c71d8cbb32b8d32` |
| `rules_fst/clock/alarm_timer_ampm.fst` | `da7e8cc7c7b3b941d639fefba60ddb939bafa123b1d15e8f306f6f47b532498b` |

The authoritative source references are `jiboV2/pegasus:packages/parser/robust-parser/rules_src/clock/{alarm_set_value.rule,alarm_timer_ampm.rule}` at the pinned revision, `ConvTech/jibo-nlu-data:en-us/factory_rules/time.grm@master`, and `ConvTech/jibo-nlu:compiler/{compiler.l,compiler.ypp,list_manip.cpp}` plus `parser/interpreter.cpp` and `v8_interpreter/v8_interpreter.cpp`. The compiler source treats `:` as an ordinary word byte, defines `{%...%}` as a JavaScript NLU action, and defines `*`/`+` repetition; the interpreter accumulates parsed character/word values and implements `+=`. The recovered candidate time source is `packages/nlu/resources/factory-sources/time.grm` (SHA-256 `bc64171c7ebc8e1fabddf78822a600dbdee3cc12cf946a48a213a9feaf71f00e`).

## Broad native matrix

The matrix contains 147 utterances, split as follows: 25 numeric hour/minute and punctuation forms, 17 spoken hour/minute forms, 26 AM/PM and day-part forms, 27 relative future/past forms, 24 half/quarter/minutes-past/to modifier forms, 15 day-of-week/filler forms, and 13 wrapper/malformed forms. It includes compact and spaced numbers, colon/no-colon forms, AM/PM spellings, noon/midnight, relative seconds and compound durations, malformed/boundary values, and alarm wrappers.

The raw per-case report is retained in the local review run at `.parity/n03-time-factory-native/differential.json`; its SHA-256 is `d0d11ed75ec9ce7487d75db98829fe2dc5d21ffef294cf295095efad5a5d04e1`.

| requested public FST | cases | semantic status exact | intent/entities exact | native matched | candidate matched | native result count |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `clock/alarm_set_value` | 147 | 147/147 | 147/147 | 132 | 132 | 0:15, 1:132 |
| `clock/alarm_timer_ampm` | 147 | 147/147 | 147/147 | 130 | 130 | 0:17, 1:130 |

“Semantic status” compares the native empty/matched outcome with the candidate `intent === null`/intent outcome. The native result records `priority=HIGH` and `heuristic_score` for every matched row (132 and 130 rows respectively), and those raw values are retained in the report. The candidate public `parseRequest` result intentionally exposes neither native `priority` nor a score, so score equality and raw wire result cardinality are unavailable on the candidate side; no score-equivalence claim is made.

## Action coverage and execution falsification

The active inventory contains 117 rule files plus 3 active factory files, 120 unique source files. Scanning after applying the lexer’s `#`-to-end-of-line comment rule found 2,780 active `{%...%}` bodies: 2,755 simple assignment bodies and 25 rich executable bodies. The two apparent extras are commented lines 3554 and 3556 in `rules-src/chitchat/launch.rule` (`PlayMusicType` and `SeeUserBodyPart`) and are excluded as comments.

All 120 files parsed successfully. For each file, the AST tag count of the source minus the AST tag count after removing action blocks equaled the active action-body count; the aggregate was 2,780 with zero mismatches. All 25 rich bodies became `kind: "action"` programs with zero parse errors or silently skipped bodies:

| source | rich programs |
| --- | ---: |
| `factory-sources/time.grm` | 19 |
| `factory/yes_no.grm` | 1 |
| `rules-src/clock/alarm_timer_change.rule` | 1 |
| `rules-src/clock/alarm_timer_other_set.rule` | 1 |
| `rules-src/greetings/proactive_general_question.rule` | 1 |
| `rules-src/greetings/proactive_playful_question.rule` | 1 |
| `rules-src/word-of-the-day/right_word.rule` | 1 |

The named test `falsification: bypassing the recovered time action removes its published fields` executes the `TopRule` action and verifies `_time_*` publication plus `top_time` deletion. A temporary `apply_patch` bypass of `executeSemanticAction` made the focused suite exit 1 with the two action-dependent tests failing; restoring the call made the same suite exit 0 with all 3 tests passing. This falsifies a semantic-action execution omission independently of colon lexing.

## Verification

Focused and parity checks after restoration:

* `node --test packages/nlu/test/timeFactory.test.js`: 3 pass, 0 fail.
* `node --test packages/nlu/test/*.test.js`: 260 tests, 254 pass, 6 skipped, 0 fail.
* `npm run parity:check`: pass; tracker reports 61/79 verified and leaves N-03 `todo`.
* `npm run parity:gate`: pass; strict production smoke 43 cases, 0 differences, 0 invariants, 0 coverage gaps.

The required full `npm test` was run and exited 1: its unit phase reported 1,969 tests across 7 suites, 1,960 pass, 8 skipped, and one failure. The failure is the pre-existing local-turn test `packages/gateway/test/localTurnClockSettingsMenu.test.js:102`, which still demands an `ERROR/PARSER` response for `clock/alarm_set_value "am"`; the repaired source path returns `LISTEN`. Local-turn WebSocket acceptance remains a separate N-03 slice and is deliberately left open here.

N-03 remains open. This review proves the native two-FST time-factory matrix and source/action coverage, while the tracker’s full named-rule positive/negative/boundary replay and local-turn WS acceptance still require their dedicated verification.
