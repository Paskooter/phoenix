# N-08 AST punctuation preservation candidate

Status: **candidate unverified; pending root review**

This bounded candidate starts from the frozen `aeb57f956ee89f3b32619ae435c2a5cab4f3f842` AST candidate. It addresses public-input punctuation handling only. The AST matcher previously converted runs of `.`, `,`, `!`, `?`, `;`, and `:` to whitespace before matching. The source public path trims and lowercases text, while the native parser keeps every byte in each whitespace-delimited token. The candidate now lowercases and splits input only on whitespace, so punctuation remains visible to grammar matching. Rule-literal normalization for optional punctuation used inside character-class spellings is unchanged.

## Source basis

The pinned Pegasus source at `5c0a7390539663ba749d360de348a428c088505c` shows the public handler mutating `data.text` with `trim()` (`ParseRequestHandler.ts`, lines 41–47) and `RobustParserClient` lowercasing it (`RobustParserClient.ts`, lines 66–67). Neither removes punctuation. The pinned native parser source at `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e` splits input with `std::stringstream` and appends each token byte followed by a whitespace symbol (`parser/parser.cpp`, lines 151–167).

The exact source-file SHA-256 values used for the control are:

- `ParseRequestHandler.ts`: `dc577c81cf61ce0ecd19c74ada04f6a0fda2521a8834982aff0c2432730fe70e`;
- `RobustParserClient.ts`: `2c4b7c1544d82c4e42863cdacf06226fb31f5ba6745827bf165124e3a22b0906`;
- `parser.cpp`: `6b86849e390473c77979d48f47f830b3dde86f1e7c89ed37077319a149c19b1f`.

## Focused controls

Ten launch-rule controls were run against the archived native `parse` executable and the candidate `parseRequest` implementation. Four punctuation-bearing controls were semantically equal in intent/entities/no-result behavior, including:

- `what languages, do, you, speak` → native `generalWhatQuestions`;
- `what, are, you doing` → native no result;
- `are you depressed?` → native `idle`;
- `shutdown, please` → native `partialRecognition` with `RecognizedPhrase: Please`.

The six unpunctuated controls are guards against unrelated AST residuals. Two of those six are semantically equal; the other four retain known, unrelated candidate differences. The complete raw rows and comparison are retained in the private receipt directory under `.parity/reviews/n08-ast-residual-20260907/punctuation/`; the comparison records **4/4 punctuation rows** equal and does not turn the unrelated guard differences into a parity claim.

The native executable SHA-256 is `373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`, and the launch FST SHA-256 is `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`. The executable was run on the host with its archived `LD_LIBRARY_PATH`; it was not run inside the pinned Node 8 image. Candidate controls used the worktree's local Node dependencies.

## Regression checks

The focused candidate test passes:

```text
node --test packages/nlu/test/punctuationBoundary.test.js
2 passed, 0 failed
```

The complete NLU test glob also passes with 103 tests discovered, 98 passed, 5 configured skips, and 0 failures. The unchanged 209-row union regression input was run with the existing 15-second per-request timeout and no compiled profile variables. It completed 209/209 requests with no request errors:

- candidate: 158/209 expected status/data matches;
- frozen e396 candidate: 152/209;
- frozen e26 candidate: 141/209;
- versus e396, 6 residuals were repaired and 0 new failures or same-match output changes occurred;
- repaired IDs were `chitchat:1620:0:base`, `chitchat:3664:0:base`, `hub-client:1921:0:base`, `hub-client:42:0:base`, `hub-client:862:0:base`, and `hub-client:862:0:condition:0`.

The 209 input is the existing union of exact difference IDs from the accepted 031 and rejected 2a replays. Its own SHA-256 is `d5aba7e1e9d1f1339f75441d01910f8502dbae98ac65446c06690706307194ba`; its source corpus SHA-256 is `ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d`; the input contains 209 unique IDs in source-row order. The final-head candidate benchmark took 40,058.027 ms at 5.2174 rows/second and exited 0. The exact output, command context, hashes, and comparison are in the private candidate receipt directory.

This candidate has not had a new 20,528-row replay. The frozen aeb replay remains the reference at 20,476/20,528 with 52 residuals. Other AST scoring, arbitration, grammar, and entity differences remain open; no phrase/rule-pair exception or global tie reversal was added. Compiled-FST behavior, the default profile selection, main, robot, source, golden, and shared-cache files are unchanged.
