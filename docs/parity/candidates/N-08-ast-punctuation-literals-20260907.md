# N-08 AST punctuation in ordinary rule literals

Status: **bounded repair accepted by root and integrated**

The [root review](../evidence/2026-09-07/nlu-punctuation-literals/review.json)
records final integration tests and the remaining 51 differences.

This candidate is a follow-up to the frozen punctuation integration replay at
`607521f8c9df7d608af50e9af08ff6230547093b`. That replay preserved punctuation
in public input tokens but continued to remove punctuation from every rule
literal, producing seven new CES failures. This candidate keeps the public
input change and makes ordinary rule-literal comparison lowercase-only.

The change is general: punctuation in a normal grammar word remains part of
the word, while `expandCharClass` continues to interpret `?`, `|`, and groups
as character-class syntax and emits each resulting spelling for the same
literal comparison. No utterance, intent, or rule-pair exception is used.

## Source basis

The pinned Pegasus public path at `5c0a7390539663ba749d360de348a428c088505c`
trims request text in `ParseRequestHandler.ts` (lines 41–47) and lowercases it
in `RobustParserClient.ts` (lines 66–67). Neither operation removes
punctuation. The pinned native parser source at
`91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e` splits with `std::stringstream`
and emits every byte of each whitespace-delimited token followed by a space
arc (`parser/parser.cpp`, lines 151–167).

The source grammar defines `V_CES` as `ces|c.e.s.|(c e s)|...` at
`packages/nlu/resources/rules-src/chitchat/launch.rule`, line 6504. The
previous matcher converted the `c.e.s.` rule arc to `ces`; the candidate now
matches the native `c.e.s.` spelling while retaining the separate optional
character-class behavior used by forms such as `u?.s?.`.

Source control file hashes:

- `ParseRequestHandler.ts`: `dc577c81cf61ce0ecd19c74ada04f6a0fda2521a8834982aff0c2432730fe70e`;
- `RobustParserClient.ts`: `2c4b7c1544d82c4e42863cdacf06226fb31f5ba6745827bf165124e3a22b0906`;
- `parser.cpp`: `6b86849e390473c77979d48f47f830b3dde86f1e7c89ed37077319a149c19b1f`.

## Focused controls

The candidate's synthetic ordinary-literal grammar accepts `c.e.s.` and
rejects `ces` and `c.e.s`. Its optional class control accepts `us`, `u.s`,
and `u.s.` while rejecting the whitespace-separated `u s` form.

The archived native `parse` executable was also run against the pinned launch
FST for seven source-shaped CES inputs. Native and candidate semantic results
matched **7/7**, including the five CES entity-bearing intents and the
no-result `ces` guard. Native execution was a host invocation with its
archived `LD_LIBRARY_PATH`, not a Node 8 Docker execution. Native proof files
are retained at:

`.parity/reviews/n08-punctuation-rule-literals-20260907/native-controls/`

The exact shell/Node control commands are retained in `native-controls/commands.txt`
(SHA-256 `0d6fd10f710dcfaf60b74c6629a6f1447bf5b45d042229caee53345deb23ba47`).

The semantic comparison is `comparison.json` (SHA-256
`27f9e63d7162da30aa3c04c3d99a254b99e1265906803f62a78c37a1cc75964b`); the
archived launch FST is SHA-256
`2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`, and
the native `parse` binary is SHA-256
`373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`.

The previously accepted 21/21 parenthesized-class/apostrophe native controls
remain preserved in the root receipt at
`.parity/reviews/n08-apostrophe-root-20260907/candidate-native-differential.json`
(SHA-256 `6e6b03616fba393b2521527fb4026315a9ee9bacf5bd122ef3b258573b984c64`).
The four earlier punctuation controls remain recorded in the frozen
`n08-ast-residual-20260907/punctuation/comparison-final.json` evidence.

## Regression results

The focused command covering punctuation, class, apostrophe, and request
boundaries passed 26/26 tests. The complete NLU test glob passed **101/106**,
with five configured skips and zero failures. The added ordinary-literal,
public CES, and optional-class tests are included in that count.

The unchanged 209-row union regression input completed all 209 requests with
no request errors and **158/209** expected status/data matches. Against the
frozen apostrophe candidate's 157/209 result, the candidate fixes exactly
`hub-client:42:0:base`, introduces no new or changed semantic outcome, and
retains the other 208 outcomes. Input SHA-256 is
`d5aba7e1e9d1f1339f75441d01910f8502dbae98ac65446c06690706307194ba`.

The unchanged full HTTP replay completed with exit 0 after 2,131.715 seconds:

- 20,528 cases, 20,477 matches, 51 differences;
- boundary 21/21, chitchat 11,403/11,432, hub-client 8,980/9,002, report 73/73;
- compared with the accepted 2e9 replay (20,476/20,528, 52 differences),
  51 difference records are exactly equal, `hub-client:42:0:base` is fixed,
  and there are zero new or changed residual records;
- compared with the failed punctuation integration at 607, the seven CES
  records are fixed and there are zero new or changed residual records:
  `chitchat:1243:0:base`, `chitchat:2058:5:base`,
  `chitchat:2058:6:base`, `chitchat:2059:5:base`,
  `chitchat:220:0:base`, `chitchat:89:2:base`, and
  `hub-client:2520:0:base`.

The full output is retained at
`.parity/reviews/n08-punctuation-rule-literals-20260907/full-replay/replay.json`
(SHA-256 `3e1272da875c8084b9336ae82a4c9dc4ef2538c310b6bb7a76672322a738efb9`).
The execution receipt is `full-replay/execution.json`; the frozen preflight and
postflight receipts verify the candidate worktree, runner, full input, accepted
comparison, and workspace links remained stable. The machine-readable full
reconciliation is `reconciliation-full.json` (SHA-256
`15622f35db780b5ec550ade8902108d33b2ca8442fc9e408f62a56f4617c5fe3`).

The failed integration result is deliberately retained at
`/home/shell/work/phoenix/.parity/worktrees/n08-punctuation-integration-20260907/.parity/reviews/n08-punctuation-integration-20260907/full-replay/replay.json`
(SHA-256 `15c9a93a0a14dc2df1079b5c9763d4dd1771d7bbb0f4fe6d893c2ce12eefcdd3`):
20,470/20,528 matches and 58 differences. It was not modified.

## Limits

This candidate covers ordinary punctuation-bearing rule literals demonstrated
by the source `V_CES` family. It does not claim that every punctuation-bearing
grammar has equivalent AST arbitration, numeric heuristic scores, or entity
semantics; the remaining 51 full-replay records are retained as unresolved
source differences. It does not alter the compiled-FST profile, default
profile selection, source/golden inputs, main, robot, or shared caches.
