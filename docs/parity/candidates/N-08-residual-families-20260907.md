# N-08: classify the 51 default-AST residuals

Status: **classification only**. No matcher, grammar, or runtime change.
The accepted default-AST baseline remains **20,477 / 20,528** with **51**
residuals. This document does not claim that number moved.

Task id: `N-08-residual-families-20260907`.
Worktree head: `21b957290e7989975a40c2ab97ff472eebebf739`.

## What was measured vs inferred vs unknown

**Measured against original HTTP status/data** (frozen full replay, not
re-run):

- Replay
  `.parity/worktrees/n08-punctuation-rule-literals-20260907/.parity/reviews/n08-punctuation-rule-literals-20260907/full-replay/replay.json`
  SHA-256 `3e1272da875c8084b9336ae82a4c9dc4ef2538c310b6bb7a76672322a738efb9`.
- 20,528 cases, 20,477 matches, 51 differences. Hash matches the accepted
  punctuation-literals receipt.
- Original request bodies for those 51 ids come from
  `/home/shell/work/phoenix/.parity/reviews/full-original-parser.json`
  SHA-256 `ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d`.
- A focused AST probe of the 27 unique residual texts reproduced the same
  51 HTTP payloads (`httpEqualsReplay: true`). Probe SHA-256
  `b297963d3b413458209f6e9f12ebbca3135d2cbaa553f2c41c59ffc16fc526b6`.

**Verified by reading pinned original source** (not executed in this task):

- Native score is `input_string.length() - heuristic`
  (`ConvTech/jibo-nlu@91b1bb6` `parser/result_fst.cpp` lines 75–80).
- Parser replaces a path only on a *strictly lower* heuristic
  (`parser/parser.cpp` lines 139–141). Equal-cost selection is then first
  remaining graph node (`result_fst.cpp` lines 86–88;
  `result_fst.h` `cmp` lines 29–35).
- Compiler optimization is RmEpsilon, Determinize, optional Minimize, then
  `Push(..., REWEIGHT_TO_INITIAL)`
  (`fst_operations/fst_operations.cpp` lines 42–58).
- Grammar `priority` is copied onto `NLParse` *after* native selection
  (`jiboV2/pegasus@5c0a739` `RobustParserClient.ts` lines 108–110).
  `getBestResult` compares `heuristic_score` only (lines 251–285).
- Production `launch.fst` is a UNION of every `*/launch` graph
  (`packages/parser/src/cli/build-rules.ts` lines 72–88).

**Prior root evidence, not re-measured here:** the portable compiled-FST
profile has zero field differences on the full corpus. These 51 are therefore
default-AST residuals, not missing grammar. Root rejected `700e40c` for
changing a native `w03`-versus-`*` control from `w03` to `*`. This
classification does not reopen wildcard/AST scoring heuristics.

**Unknown:** native numeric `heuristic_score` for these 51 utterances was
not re-executed on the archived `parse` binary in this task. Family 3’s
native/AST cost relationship is inferred from AST costs plus the compiled
profile’s zero-diff result.

## How Phoenix AST currently chooses a launch winner

HTTP `rules: ["launch"]` expands to the 20 union sources in
`packages/nlu/resources/rule-inventory.json`. Each source is matched
independently. `matchNamedRule` then scores with

```text
parseScore = priorityRank(priority) * 1e6 + specificity - cost
```

(`packages/nlu/src/grammar/matcher.js` `parseScore`,
`packages/nlu/src/requestParser.js` `chooseBest` → `selectBestNative`).

Native launch parsing does not do that. It walks one union FST and keeps
the lowest-heuristic path. `priority` is an output symbol / interpreter
variable, not a path score.

Intra-chitchat, `matchRule` already ignores `priority` and keeps the first
maximum of `specificity - cost`. On a tie that is AST walk order, not
optimized FST node order.

## Family 1 — launch-union grammar-priority vs native heuristic (2)

**Repairable in AST?** A general, source-backed repair exists: score launch
union members with native-like `input_length - cost` and do **not** mix
grammar `priority` into that score. It is **not** proven safe for the
20,477 currently matching rows. Do not land it without a full replay.

**Not repairable by:** phrase exceptions, factory-name denylists, or
wildcard heuristics.

### Records (2)

| id | input | original | Phoenix AST |
|---|---|---|---|
| `chitchat:3989:0:base` | `i am so sorry that everyone thinks you're dumb` | `userIsSorryAboutThing` from `handle:chitchat/launch` | `enrollment` from `handle:introductions/launch`, `GivenName=so`, `style=RequestToMeet` |
| `hub-client:183:0:base` | same text | same | same |

### Competing source constructs

Chitchat `RULE_KU_IAmSorryThat`
(`packages/nlu/resources/rules-src/chitchat/launch.rule` lines 904–906,
sha256 `e6bab3053a0793c60da8ed19c47d0f53c4d30e3164020082c626d4c32c54049f`):

```text
(?(i|we ?$V_ACTUALLY am|are ?$V_ACTUALLY) ?(so) sorry ?(that|for) <1.0>+$w<0.0>)
{% intent= 'userIsSorryAboutThing' %}
```

Introductions TopRule wraps enrollment in `$* ... $*` with
`{priority='HIGH'}`
(`rules-src/introductions/launch.rule` lines 2–10,
sha256 `a357775253c111d1b69f2f4312e66892863cfa3659e2824a79f5cec320b08cab`).
`D_INTRODUCTIONS_V_THISIS` includes `i am` (line 101). `GIVEN_NAME @=
$factory:first_name` captures `so` (line 93).

### Probe (measured)

| source | intent | priority | spec | cost | `parseScore` | native-like `len-cost` |
|---|---|---|---|---|---|---|
| introductions/launch | enrollment | HIGH | 3 | 33 | 1,999,970 | 13 |
| chitchat/launch | userIsSorryAboutThing | (unset) | 5 | 27 | 999,978 | **19** |

Native-like ranking already agrees with original (chitchat). AST
`priority * 1e6` is what flips the winner. That term has no counterpart in
`result_fst` scoring or `getBestResult`.

### What a repair would be

In `parseScore` / launch-union `chooseBest`, stop adding
`priorityRank * 1e6` when comparing members of the `launch` union. Keep
`priority` as payload metadata, matching
`RobustParserClient.ts` lines 108–110. Do **not** add a `so`/introductions
exception.

Risk: other HIGH-tagged skills among the 20,477 may currently win only
because of the `1e6` boost. That is why a full replay is mandatory and why
this task does not implement the change.

## Family 2 — optimized-graph equal-cost selection (47)

**Repairable in AST?** No. Root already established that AST lacks the
optimized graph ordering produced by RmEpsilon / Determinize / Minimize /
weight-push, and that a fixed `$w03` / `$*` preference is not native
(`docs/parity/candidates/N-08-fst-order-root-20260907.md`, rejected
`700e40c`). These 47 are that class on the remaining corpus.

The compiled-FST executor already matches native on this family. Closing
it on the default AST profile would mean becoming an FST, not a better
heuristic.

Two observable shapes, one root cause: overlapping alternatives with the
same AST `specificity - cost` (or the same native heuristic after push),
where native keeps the first optimized-graph path and AST keeps the first
AST-walk path.

### 2a. Overlapping rules, different intents (33)

#### `what were you doing` — 12 records

Ids: `chitchat:1096:3:base` plus `condition:0`–`4`; `hub-client:2345:4:base`
plus `condition:0`–`4`.

| | intent | Timeframe |
|---|---|---|
| original | `doesJiboHavePlansForEvent` | `Now` |
| Phoenix | `whatDidJiboAction` | `Day` |

Constructs (chitchat `launch.rule`):

- `RULE_RN_WhatAreYouDoing` lines 2325–2327:
  `(([what?(?(\')re)] ?(are|were) you)|...) doing|(trying to do)|(up to)`
  → plans / `Now`.
- `RULE_JBO_WhatHaveYouBeenDoing` lines 1703–1705:
  `([what?(?(\')ve)] have|were you ?$V_ACTUALLY ?been doing|(up to) ?today)`
  → `whatDidJiboAction` / `Day`. `?been` is optional, so `what were you doing`
  matches both.

Probe: both named rules match with **spec=4 cost=0**. AST TopRule HIGH
keeps `whatDidJiboAction`. Native/compiled keep plans.

#### Holiday shop — 9 records

Texts: `should i shop online for mothers day`, `what's your favorite place
to shop`, `where do you suggest for mothers day shopping`,
`where should i go shopping`, `where should i shop for christmas`,
`where should i shop for kwanzaa presents`.

Ids: `chitchat:4532:1,5,6,7,9,10:base`, `hub-client:2300:1,2,3:base`.

| | intent | extra entity |
|---|---|---|
| original | `whereShouldUserHolidayShop` | (none / Holiday only) |
| Phoenix | `whereShouldUserAction` | `Action=HolidayShop` |

Constructs:

- `RULE_WhereShouldUserHolidayShop` lines 3070–3076.
- `RULE_RI_USR_WhereShouldHolidayShop` lines 1558–1564, same surface
  strings plus `{% Action='HolidayShop' %}`.

Probe: both named rules match with identical spec/cost on every overlapping
text. AST keeps the RI / `whereShouldUserAction` arm.

#### `are you scary` / `are you threatening` — 4 records

Ids: `chitchat:2201:0,1:base`, `hub-client:1748:0,1:base`.

| | intent | entities |
|---|---|---|
| original | `isJiboDescriptor` | `GeneralDescriptor=Scary` |
| Phoenix | `isThingDescriptor` | `Person=Jibo`, `GeneralDescriptor=Scary` |

Constructs:

- `RULE_RI_JBO_IsDescriptor` lines 3374–3380, `$ENT_RI_JBO_IsDescriptor`
  includes `$ENT_GENERAL_DESCRIPTOR` (and `DESC_SCARY`).
- `RULE_RI_JBO_FeelsAfraidAboutThing` lines 3291–3294:
  `(is|are ?the $ENT_RI_JBO_FeelsEmotionAboutThing ... $DESC_SCARY)`.
  `?the` is optional; `$ENT_RI_JBO_FeelsEmotionAboutThing` includes
  `$ENT_OTHER_PERSON`, so `you` can bind as `Person=Jibo`.

Probe: both match spec=3 cost=0. AST keeps `isThingDescriptor`.

#### `that was appalling` / `that was disturbing` — 4 records

Ids: `chitchat:3435:0,1:base`, `hub-client:829:0,1:base`.

| | intent | entities |
|---|---|---|
| original | `unknownIsDescriptor` | `GeneralDescriptor=Terrible` |
| Phoenix | `userDislikesThing` | `GeneralLikes=That`, `GeneralDescriptor=Terrible` |

Constructs:

- `RULE_OI_OTHER_IsDescriptor` lines 3155–3157:
  `(that\'s|...|(that|this|... is|are|was|were) ... $ENT_GENERAL_DESCRIPTOR|$ENT_EMOTION)`.
- `RULE_UserDislikesThing` lines 2954–2958:
  `($SUPER_ENT_GENERAL_LIKES is|was ... $DESC_TERRIBLE|...)`.
  `that` is a `SUPER_ENT_GENERAL_LIKES` value.

#### `shutdown please` — 2 records

Ids: `chitchat:1926:4:base`, `hub-client:2419:4:base`.

| | intent | entities |
|---|---|---|
| original | `howCanUserAction` | `Action=TurnOffJibo` |
| Phoenix | `partialRecognition` | `RecognizedPhrase=Please` |

Constructs:

- `RULE_SUP_SET_HowTurnOff` lines 2818–2821: `(shutdown ~7)|...`
  under `D_SR_HIGH_PRIORITY` wrapped by TopRule
  `($w03 $D_SR_HIGH_PRIORITY $w03)` (line 11).
- `STRICT_RULE_PR` lines 764–768: `((please) ~5)` under
  `D_SR_HIGH_PRIORITY_STRICT` wrapped by
  `($w03 $D_SR_HIGH_PRIORITY_STRICT)` (line 10), so `shutdown` is the
  leading `$w03`.

`~N` is a native arc weight (`compiler.ypp` line 153,
`weight : '~' DECIMALNUMBER`). AST treats it as a lump `node.cost`. After
weight-push the two wraps are not the same object as AST’s spec/cost, and
AST walk order prefers the earlier STRICT arm.

#### `thank you for being quiet when i asked` — 2 records

Ids: `chitchat:3336:0:base`, `hub-client:202:0:base`.

| | intent | entities |
|---|---|---|
| original | `thankJiboForAction` | `Action=*` |
| Phoenix | `jiboShouldBeDescriptor` | `GeneralDescriptor=Calm` |

Constructs:

- `RULE_KU_ThankYouFor` lines 956–958:
  `(thank you for <1.0>+$w<0.0>) {% Action = '*' %}` inside
  `D_SR_MIXED_PRIORITY`, which carries a group `~2` (lines 121–221).
- `RULE_OI_JBO_ShouldBeDescriptor` lines 3141–3145 plus `DESC_CALM`
  (`quiet` → `Calm`, lines 5091–5095), wrapped by
  `$w03 ... $w03` so `thank you for` and `when i asked` are `$w03` spans.

Probe: AST winner is should-be, spec=2 cost=21. The mixed-group `~2` plus
wildcard cost of the KU arm makes AST rank the 2-literal HIGH wrap first.
Native keeps the KU thank-you-for path.

### 2b. Overlapping entity-class / tag arms, same intent (14)

Same equal-cost / graph-order mechanism; the selected intent matches and
the entity map does not.

#### Empty `GivenName=""` sentinel — 5 records

Texts: `which gift should i give my daughter for christmas`,
`what should i get dad for father's day`,
`what should i get my daughter for kwanzaa`,
`what should i get mom for mother's day`,
`which present should i buy my son this christmas`.

Ids: `chitchat:4356:4`, `4357:0`, `4359:0`, `4360:0`, `hub-client:2298:4`.

| | intent | entities |
|---|---|---|
| original | `whatGiftShouldUserGiveHoliday` | `FamilyMember`, `Holiday`, **`GivenName=""`** |
| Phoenix | same | `FamilyMember`, `Holiday` (key omitted) |

Construct: `RULE_WhatGiftShouldUserGiveHoliday` lines 3043–3046 uses
`$SUPER_ENT_PERSON` (lines 5569–5578):
`(?$V_POSESSIVES $SS_FAMILY_MEMBER ?$PERSON_NAME)`.
`PERSON_NAME` (lines 6765–6768) is

```text
($GIVEN_NAME ?$LAST_NAME) | (<1.0>+$w<0.0>){% GivenName='' %}
```

The empty-string assignment is a grammar NL return, not an interpreter
default. Compiled-FST tests already expect `GivenName:''` on
`what should i get dad for father's day`. AST takes the optional-person
epsilon and drops the sentinel. Native/compiled take the tagged
`PERSON_NAME` arm on an equal-heuristic path.

`LoopMemberDetector.ts` lines 52–54 treats `hasOwnProperty('GivenName')`
as “name expected” even when the value is empty. These five rows have no
loop-member enrichment because `dad`/`mom`/`daughter`/`son` are not loop
first names; the empty key is still original HTTP data.

#### Extra `Food=FoodGeneral` — 2 records

Ids: `chitchat:1757:0:base`, `hub-client:2123:0:base`.
Input: `do you want some hot dogs`. Intent `doesJiboWantThing` both sides.

`ENT_RI_JBO_WantsThing` lines 4199–4230:

```text
(?(?to [eat?(ing)]|[hav(e|(ing))]) ?$V_QUANTITY|(?a bite ?of) $SS_FOOD_GENERAL)
  {% Food='FoodGeneral' %} |
(?(?to [eat?(ing)]|[hav(e|(ing))]) ?$V_QUANTITY|(?a bite ?of) $SUPER_ENT_FOOD)
```

`$SS_FOOD_GENERAL` already tags `FoodGeneral=SomeFoodGeneral` (hot dog,
lines 5963–5985). `$SUPER_ENT_FOOD` includes `$SS_FOOD_GENERAL` without
the extra `Food` tag. Native keeps the second arm; AST keeps the first.

#### `are you depressed` — 2 records

Ids: `chitchat:2091:0:base`, `hub-client:1652:0:base`.
Intent `isJiboDescriptor` both sides.

`ENT_RI_JBO_IsDescriptor` has an explicit `(depressed)
{% GeneralDescriptor='Depressed' %}` (line 4013) **and** `$ENT_EMOTION`
(line 4037) whose `EMOTION_SAD` includes `depressed` with `{% Emotion='Sad' %}`
(lines 4902–4908). Native keeps `Emotion=Sad`; AST keeps the earlier
explicit `GeneralDescriptor`.

#### `are you bad or are you good` — 2 records

Ids: `chitchat:2244:0:base`, `hub-client:1679:0:base`.
Intent `isJiboDescriptor` both sides.

Same entity rule, two tagged alternatives (lines 4017 and 4035):

```text
(($V_GOOD or ?($V_ISPERSON) $V_EVIL)|...) {% GeneralDescriptor='GoodOrEvil' %}
(($V_MORAL or ?($V_ISPERSON) $V_EVIL)|...) {% JiboDescriptor='GoodOrEvil' %}
```

Native: `JiboDescriptor`. AST: `GeneralDescriptor`.

#### `where did we put elroy's wallet` — 1 record

Id: `chitchat:4529:0:base`. Intent `whereIsThing` both sides. Both emit
`GivenName=""` and LoopMemberDetector fills `loopMemberReferent=test-looper-id-5`
from the empty-name sentinel (`LoopMemberDetector.ts` lines 75–82).

Phoenix extra: `ObjectOwner=Speaker`.

`RULE_KU_WhereIsMy` lines 1028–1039: first alternative tags
`{% ObjectOwner='Speaker' %}` on `my|our|$PERSON_NAME`; second alternative
is `$PERSON_NAME` without that tag. `elroy's` is not `my`/`our`; it hits
`PERSON_NAME`’s wildcard arm. Native keeps the untagged alternative.

#### `i like blues` — 1 record

Id: `hub-client:1169:0:base`. Intent `userLikesThing`.
Original `MusicType=SomeMusicType`; Phoenix `Color=SomeColor`.
`RULE_UserLikesThing` line 3016–3018 takes `$SUPER_ENT_GENERAL_LIKES`,
which includes both color and music-style vocab. `blues` is in both.

#### `do you like nfl football` — 1 record

Id: `hub-client:1896:2:base`. Intent `doesJiboLikeThing`.
Original `Event=NFLPlayoffs`; Phoenix `Sport=Football`.
`RULE_DoesJiboLikeThing` lines 2880–2882 vs KU `RULE_KU_DoYouLike`
lines 837–839 (`do you like|love <1.0>+$w<0.0>`), plus overlapping
event/sport entity classes.

## Family 3 — AST spec-cost disagrees with native heuristic (2)

**Repairable in AST?** No. These are the remaining cases where the AST
named-rule costs are *unequal* and still pick the wrong arm. Changing
wildcard cost to chase them is the closed `700e40c` approach.

| id | input | original | Phoenix |
|---|---|---|---|
| `chitchat:4268:0:base` | `i am hoping that the movie coco will win in the oscars` | `userSupportsSomeoneForEvent` / `Event=AcademyAwards` | `whoWillWinEvent` / same Event |
| `chitchat:4292:1:base` | `i hope that the philadelphia eagles will win the national football league` | `userSupportsSomeoneForEvent` / `Event=NFLPlayoffs` | `whoWillWinEvent` / same Event |

Constructs (lines 3034–3038 vs 3089–3095):

```text
RULE_UserSupportsSomeoneForEvent =
  ([i?(\'m)]|[we?(\'re)] $w03 [hop(e|(ing))] ... <1.0>+$w<0.0> [win?(s|(ning))] $w03 $ENT_EVENT)

RULE_WhoWillWinEvent =
  (will|should $w03 $w03 win $w03 $w03 $ENT_EVENT) | ...
```

Probe for coco: userSupports spec=5 cost=29 native-like=25;
whoWillWin spec=4 cost=27 native-like=27. AST spec-cost and native-like
both prefer whoWillWin. Original/compiled prefer userSupports. So even
the AST “native-like” proxy is not the native pushed heuristic on
`<1.0>+$w<0.0>` spans.

Unknown without a fresh native `parse` run: whether native heuristics are
unequal (true cost-model gap) or equal after Push (then this collapses
into Family 2). Either way, AST cannot repair it generally.

## Count check

| family | unique texts | residual rows | AST-repairable without FST order? |
|---|---|---|---|
| F1 launch-union priority | 1 | 2 | maybe, full replay required |
| F2 optimized graph order | 24 | 47 | no |
| F3 AST cost vs native heuristic | 2 | 2 | no |
| **total** | **27** | **51** | |

All 51 ids are listed in the committed sidecar
[N-08-residual-families-20260907.json](N-08-residual-families-20260907.json)
and the private receipt
`.parity/reviews/n08-residual-families-20260907/families.json`.

## What this task did not do

- No matcher/runtime patch.
- No full 20,528 replay (none was justified).
- No archived native `parse` execution on these 51 texts.
- No robot, compiled-profile switch, or claim that compiled-FST acceptance
  closes default-AST N-08.

## Concrete next step

Implement **only Family 1**, as a bounded launch-union scoring change:
compare launch sources with native-like `input_length - cost` (or the
existing `specificity - cost` without `priorityRank * 1e6`), leave
`priority` as payload, add the sorry utterance as a focused control plus
the rejected `700e40c` `w03`-versus-star guard so it cannot regress.
Commit, then run the full HTTP replay. Success is: those 2 records match,
the other 49 are byte-identical, zero new ids.

Do **not** attempt Family 2/3 with AST ranking. The next repair for those
47+2 is to serve the already-verified compiled/portable graph path as the
default runtime, which is a provisioning/default-profile problem, not an
AST heuristic problem.
