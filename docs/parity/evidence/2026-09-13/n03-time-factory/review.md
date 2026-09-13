# N-03 time factory native differential review

Review date: 2026-09-13. This follow-up starts from root revision `6e817e31985dfc578dc4dc8bbf745955eee657d7` (`6e817e3`) on fresh branch `w18/n03`. The bounded time implementation originated at `7403854`/`3f3dd77`, was reviewed at `6a354f4`/`9b86312`, and is present in the root base. The local-turn breadth and launch-component tests below are this branch’s local follow-up; they are not pushed or integrated.

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

The pinned native probe also settles the local-turn contract for the previously stale `am` assertion. With the archived parser and FSTs, `clock/alarm_set_value.fst` returns `intent=alarmValue,time=am,ampm=AM,domain=alarm,priority=HIGH`, and `clock/alarm_timer_ampm.fst` returns `intent=set,ampm=AM,domain=alarm,priority=HIGH`; both have `heuristic_score=3`. `p.m.` and `seven thirty am` likewise return source-shaped responses, while `set an alarm` is empty. This follows the pinned source: `alarm_set_value.rule:40-53` includes `$factory:time`, `alarm_timer_ampm.rule:10-13` includes `$factory:time|$AM_PM`, and `time.grm:237-252` maps the AM/PM forms. The gateway therefore must emit a final `LISTEN` for the matched values; a `PARSER`/500 expectation is stale.

## Named-rule and local-turn breadth

The N-03 inventory contains 20 named rules (12 `clock/`, 5 `settings/`, 3 `main-menu/`). The fixture covers all 20 with 134 rows: 45 positive, 62 boundary, and 27 negative (the 18 non-factory rules contribute 122 rows; the two time rules contribute 12). The `clockSettingsMenu.test.js` suite replays every row through both `parseRequest` and a live `POST /v1/parse`; the latest run passed all eight subtests. The pinned source citation is present on every row.

The local-turn WebSocket suite now exercises 149 assertions across 142 distinct rule/text pairs and all 20 public named rules. It covers every source-declared settings destination, every main-menu and personal-report destination, every fun destination, every volume operation plus numeric 0 through 10 levels, shutdown and timer confirmation yes/no boundaries, every alarm and timer cancellation spelling, stop controls, timer query/info cancellation, and no-match rows. The AM cases include both `clock/alarm_set_value "am"` and `clock/alarm_timer_ampm "am"`. An independent replay of these 142 distinct rows against the corresponding pinned native FSTs found 0 native/Phoenix semantic differences; the rows are anchored to the same pinned `.rule` sources used by the WS assertions.

The source directories contain 23 `.rule` files in these groups: 20 public named rules plus the three `launch.rule` components. `rule-inventory.json` places `clock/launch`, `settings/launch`, and `main-menu/launch` only under `publicRules.launch.sourceHandles`, and direct component requests return the intentional empty result. The tracked [89-row native/Phoenix receipt](./launch-native-receipt.json) records 89 native lines and 89 Phoenix matches, with 0 native/Phoenix, native/fixture, or Phoenix/fixture semantic differences. Its `oracleSourceSha256` is the raw SHA-256 of `packages/nlu/resources/legacy-oracle/golden.jsonl` (the upstream source named by the fixture provenance), while `fixtureSha256` records the raw SHA-256 of the vendored `packages/nlu/test/fixtures/launch-oracle-89.json`. Its native attributions are 7 `handle:clock/launch`, 2 `handle:settings/launch`, and 2 `handle:main-menu/launch`. This proves the components are union inputs rather than independently requestable N-03 named handles.

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

The named test `falsification: bypassing the recovered time action removes its published fields` executes the `TopRule` action and verifies `_time_*` publication plus `top_time` deletion. A deliberate temporary `apply_patch` replaced the production `executeSemanticAction(tag.program, ...)` call in `packages/nlu/src/grammar/matcher.js`; `node --test packages/nlu/test/timeFactory.test.js` then exited 1 with 1 pass and 2 action-dependent failures. Restoring the exact call made the same suite exit 0 with all 3 tests passing, and `git diff` showed no remaining matcher change. This falsifies a semantic-action execution omission independently of colon lexing.

## Verification

Focused and parity checks after restoration:

* `node --test packages/nlu/test/timeFactory.test.js`: 3 pass, 0 fail.
* `node --test packages/nlu/test/*.test.js`: 266 tests, 260 pass, 6 skipped, 0 fail.
* `npm run parity:check`: pass; tracker reports 62/79 verified and leaves N-03 `todo`.
* `npm run parity:gate`: pass; strict production smoke 43 cases, 0 differences, 0 invariants, 0 coverage gaps.
* `node --test packages/nlu/test/clockSettingsMenu.test.js`: 8 pass, 0 fail (134 named-rule rows exercised in each runtime phase plus the launch-component boundary test).
* `node --test packages/gateway/test/localTurnClockSettingsMenu.test.js`: 6 pass, 0 fail (149 local-turn assertions across 142 distinct rule/text pairs, including no-match and source-matched AM falsifications).

* `npm test`: 1,982 tests across 7 suites, 1,974 pass, 8 skipped, 0 fail; `parity:check` and `parity:gate` also pass.

Root also observed one physical hotword turn on Moth after loading the supported
BE 11.0.1 validation package. The native microphone path opened the authenticated
Phoenix Hub, returned `askForTime` with `handle:clock/launch`, opened
`@be/clock`, completed speech, and returned to idle; the user reported that it
“worked fantastically.” This is a single launch-path hardware observation, not
additional coverage for the named follow-up variants. Its private sanitized
receipt is `.parity/robots/moth/20260913/manual-clock-test-065144.json`.

The acceptance audit is: (1) every public clock/settings/main-menu named rule has positive, negative, and boundary fixture rows with pinned source citations and native/direct/HTTP replay — VERIFIED; (2) alarm/timer values, AM/PM, cancellation, confirmation, volume, and menu selections have source-declared local-turn WS rows, plus independent native FST comparisons — VERIFIED; (3) the three internal launch components are source-pinned union inputs with an actual 89-row native/Phoenix receipt and no public component handle — VERIFIED. The evidence supports closing N-03; `docs/parity/tasks.json` was intentionally left untouched for the parent to update.
