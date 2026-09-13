# S-07 chitchat MIM and identity candidate

Review date: 2026-09-13
Branch: w18/s07-mim-identity
Worktree: /home/shell/work/phoenix-s07
Base: 1d4ae0ec30d959f5532dcb672353e8a46a781c74
Candidate patch amended from: 988718e0fe3ff1948c46db3f91f6d3835811011e
Pinned source: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c

**Recommendation: UNKNOWN — keep S-07 open.** The candidate repairs three
source/native entity collisions and is regression-free across the full local
unit suite and the 10,035-utterance diagnostic corpus. The remaining rows are
separately explained, but the written S-07 acceptance also requires complete
MIM/ESML/JCP/analytics comparisons under identity, emotion, birthday, seasonal,
and multi-turn contexts. That complete runtime matrix is not proven here.

## Source evidence

Jibo MCP search was run first for the S-07 chitchat and loop-member queries;
repository discovery then selected Pegasus and the pinned source revision above.
The source files read were:

- packages/chitchat-skill/src/Chitchat.ts — semi-specific stem and CSV maps.
- packages/chitchat-skill/src/nodes/ProcessQueryNode.ts — entity-based
  semi-specific resolution and fallback behavior.
- packages/parser/src/handlers/ParseRequestHandler.ts — parser result
  selection followed by loop-member detection.
- packages/parser/src/utils/LoopMemberDetector.ts — recognized-member
  precedence, aliases, and loop context mutation.
- packages/chitchat-skill/tests/Chitchat.test.js — direct scripted and
  semi-specific controls.

The native capture is the stable shared artifact
/home/shell/work/phoenix/.parity/reviews/full-original-parser.json, SHA-256
ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d. The
tracked manifest is packages/harness/resources/test-manifest.json, SHA-256
ea70a399299e0d5cc3c654268b407a5bdc61cfa0602ce3f8d8db34dc8a177ccd.

The three source capture controls are exact at the NLU boundary:

| Capture ID | Text | Native entities | Source MIM after routing |
| --- | --- | --- | --- |
| chitchat:1757:0:base | do you want some hot dogs | FoodGeneral:SomeFoodGeneral | RI_JBO_Wants_SS_FoodGeneral |
| chitchat:2091:0:base | are you depressed | Emotion:Sad | RI_JBO_IsSad |
| chitchat:2244:0:base | are you bad or are you good | JiboDescriptor:GoodOrEvil | RI_JBO_IsGoodOrEvil |

Before the patch, Phoenix emitted Food:FoodGeneral in addition to
FoodGeneral:SomeFoodGeneral, or emitted GeneralDescriptor:Depressed and
GeneralDescriptor:GoodOrEvil. Those extra or less-specific fields selected a
different router branch. After the patch, the original-NLU comparison covered
120 intent-correct S-07 rows: 120 source rows found, 120 exact, 0 non-exact.
The receipt command was:

~~~text
node /tmp/s07-original-nlu-compare.mjs
# rows 120; sourceRows 120; missing 0; exact 120; nonExact 0
~~~

The script reads the native capture above and calls the checked-in
packages/nlu/src/requestParser.js with each capture's exact loop context.
The /tmp output is disposable; the source-capture path, revision, SHA, and
command are recorded here so the comparison can be regenerated from the
stable shared capture.

## Candidate implementation

The candidate adds packages/nlu/src/chitchatEntityNormalization.js and applies
it at both source-shaped parser boundaries:

- packages/nlu/src/fullGrammar.js for the broad parse() path used by the
  corpus runner.
- packages/nlu/src/requestParser.js for the HTTP/native-compatible path.

The focused regression is
packages/nlu/test/s07ChitchatEntityNormalization.test.js; the source-shaped
punctuation expectation is updated in
packages/nlu/test/punctuationBoundary.test.js.

## Corpus result

The complete command was run from the candidate tree:

~~~text
node packages/harness/src/corpusRunner.js --out /tmp/s07-after-corpus.json
~~~

Exit status 1 is expected because S-07 and accepted N-08 residuals remain.
The immutable before receipt was generated at base 1d4ae0e; the after receipt
was generated at the candidate commit.

| Measure | Before | After |
| --- | ---: | ---: |
| Entries | 4,705 | 4,705 |
| Utterances | 10,035 | 10,035 |
| D3 intent | 10,007 | 10,007 |
| D4 MIM | 9,887 | 9,890 |
| Miss rows | 148 | 145 |
| Result SHA-256 | 6a56162fce4fdf70a2cef72f592dd00eb9883c0d36ee987da91711d6239eedb3 | e7b1472e29ad8eaf0b670ddaef19e654a3250297f4ae8a2c9da1eff69cde6131 |

The before and after miss sets have exactly three removals and zero additions:

- do you want some hot dogs → RI_JBO_Wants_SS_FoodGeneral
- are you depressed → RI_JBO_IsSad
- are you bad or are you good → RI_JBO_IsGoodOrEvil

## Remaining 117 MIM rows

The after corpus has 117 MIM-only rows (want equals got) and 28 intent rows.
The 117 are separated by source-backed behavior:

| Count | Class | Evidence and limit |
| ---: | --- | --- |
| 77 | Semi-specific category rows | Native source NLU emits no category entity for these bare utterances. The local direct resolver agrees with source category CSV semantics for 78/78 controls before the hot-dog collision was repaired; the remaining 77 cannot be selected from bare text without inventing an entity or parser rule absent from source. The only category ambiguity is pinned Kiwi → Bird or Fruit. |
| 39 | Loop-context rows | With source-shaped loop users, the parser/router selects the expected loop-member MIM for all 39 remaining rows. The corpus runner calls broad parse(text) without loop context, so it cannot observe these decisions. One row uses synthetic Alice context because the source capture's standard loop has no Alice. |
| 1 | Duplicate manifest expectation | you're doing great has a native capture with GeneralDescriptor:DoingGreat; source and Phoenix select OI_JBO_IsDoingGreat. A duplicate manifest entry expects GeneralDescriptor:Excellent / OI_JBO_IsExcellent for the same text, which cannot be satisfied by a deterministic source-shaped parser without breaking the other entry. |

The context receipt was:

~~~text
node /tmp/s07-context-matrix.mjs
# baseline 120 rows: noLoopExact 3; loopExact 42; loopRouteExact 120
# after removing the three repaired rows: 39 loop-context rows remain exact
~~~

The semi-specific receipt was:

~~~text
node /tmp/s07-semi-matrix2.mjs
# rows 78; exact 78; categoryAllowed 78
# ambiguous: do you love kiwi -> Bird, Fruit
~~~

No further parser or dispatcher repair is justified by these rows: adding
category inference would diverge from the native NLU capture, and adding loop
context to the context-free corpus would change the test boundary rather than
the implementation.

The 28 unchanged intent residuals are the accepted N-08 families:

~~~text
isJiboDescriptor -> idle                         12
whereShouldUserHolidayShop -> whereShouldUserAction 6
isJiboDescriptor -> isThingDescriptor            2
unknownIsDescriptor -> userDislikesThing         2
userSupportsSomeoneForEvent -> whoWillWinEvent   2
doesJiboHavePlansForEvent -> whatDidJiboAction   1
howCanUserAction -> partialRecognition            1
thankJiboForAction -> jiboShouldBeDescriptor     1
userIsSorryAboutThing -> enrollment               1
~~~

## Verification and falsification

Focused command:

~~~text
node --test packages/nlu/test/s07ChitchatEntityNormalization.test.js \
  packages/nlu/test/punctuationBoundary.test.js \
  packages/nlu/test/requestParser.test.js \
  packages/nlu/test/loopMemberDetector.test.js \
  packages/gateway/test/intentRouter.test.js \
  packages/skills/test/intentResponses.test.js
# tests 75; pass 75; fail 0; skipped 0
~~~

Full command:

~~~text
npm run test:unit
# tests 1976; pass 1967; fail 0; skipped 9; exit 0
~~~

For falsification, Emotion:Sad was temporarily changed to Emotion:Broken with
apply_patch, then the focused S-07 test was run:

~~~text
node --test packages/nlu/test/s07ChitchatEntityNormalization.test.js
# exit 1; tests 2; pass 1; fail 1
# failure: are you depressed: parseRequest expected Emotion:Sad, got Emotion:Broken
~~~

The implementation was restored with apply_patch before the full suite and
corpus replay. The tracked worktree is clean after the amended commit, apart
from pre-existing ignored dependency symlinks and fixtures.

## Acceptance boundary

S-07 remains open. This receipt verifies the source NLU/entity boundary, the
three repaired router outcomes, semi-specific resolver behavior, recognized
loop-member routing, and local regression safety. It does not prove the full
written acceptance requirement to compare every semi-specific, fun-and-games,
fallback/deflection, ESML/JCP, analytics, seasonal, and multi-turn path against
the pinned original runtime. No deployment, live provider, or hardware claim
is made.
