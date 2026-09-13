# N-08 — Restore exact NLU outputs and close corpus mismatches

Evidence date: 2026-09-11 · worktree `.parity/worktrees/w16-n08` (branch `w16/n08`,
base `3dd1cfa`) · Node `v22.22.0` (linux) · profile: default AST (`PHOENIX_NLU_*` unset).

Every claim is **VERIFIED** (personally observed in a command output in this
evidence set, or read from the pinned archive through
`https://pvindex.org/mcp`), **INFERRED** (reasoned from pinned source, not
observed) or **UNKNOWN**.

**Recommendation: N-08 is NOT closed — `recommend_verified=false`.** One real,
source-backed corpus mismatch class (2 rows) is repaired and verified with zero
regressions; the conditional-`{% if %}` divergence named in the task brief is
**already closed on the base revision** and is now pinned by tests; the
remaining 160 manifest-corpus mismatches and the 49 pinned-HTTP residuals are
classified by root cause below, with the ones that need their own task
identified.

---

## 1. The contract actually used

Re-derived from the `N-08` row of `docs/parity/tasks.json` (read, **not**
modified):

1. *Return original empty shapes and clean entity payloads, removing
   parser-only fields where the reference does.*
2. *Make original routing the compatibility behavior; move any desired
   GQA/weather rewrites to explicit separately tested configuration.*
3. *Reach zero unexplained mismatches across the full pinned corpus, including
   entities, rules, no-match and skill/memo; split remaining mismatch groups
   into tracked child tasks.*

The row's `finding` records that the compiled-graph profile already matches the
full pinned corpus exactly (20,528/20,528) and that the default AST profile
retains 49 residuals, accepted as divergence **N1**. Repairing those residuals
on the AST engine is explicitly closed. This task therefore targets criteria 1
and 2 plus a fresh, reproducible measurement for criterion 3.

## 2. What "the corpus" is here — two corpora, both run

| corpus | source | grader | size |
|---|---|---|---|
| **Pinned original HTTP parser corpus** | frozen original capture of every `/v1/parse` request/response pair, `referenceSha256 8bb0695d…`, pinned revision `5c0a739…` | `packages/nlu/tools/replayPinnedCorpusHttp.mjs` (new, this task) | 20,528 captured requests → 20,525 parser-reachable rows + 3 malformed boundary rows |
| **Vendored chitchat/hub regression manifest** | `packages/harness/resources/test-manifest.json` (`sha256 ea70a399…`) | `packages/harness/src/corpusRunner.js` (pre-existing) | 4,705 entries → 10,035 utterances |

Both are needed: the pinned corpus is the native-body differential (the only
artifact that can falsify NLU output against the real service); the manifest
corpus is the only artifact carrying the *expected skill/memo* (`mimId`) for
every utterance, which is what N-08's criterion 3 names.

The capture used for the pinned replay is
`/home/shell/work/phoenix/.parity/reviews/full-original-parser.json`,
sha256 `ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d` —
the same artifact the accepted residual-family classification pinned
(`docs/parity/candidates/N-08-residual-families-20260907.json.originalInput`),
re-confirmed by the replay itself (**VERIFIED**).

## 3. Pinned-corpus result (phase 1 `parseRequest` + phase 2 live `POST /v1/parse`)

`node packages/nlu/tools/replayPinnedCorpusHttp.mjs --original …/full-original-parser.json`
(**VERIFIED**, 20,528 captured requests; 3 malformed `boundary:*` rows are sent
as captured and must answer 4xx):

```
profile                : ast
reference revision     : 5c0a7390539663ba749d360de348a428c088505c
capture                : ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d
cases                  : 20525          (20,528 captured − 3 malformed boundary rows)
direct parseRequest    : 20476/20525
live HTTP /v1/parse    : 249 cases replayed through a live ephemeral-port service
                         200/249  (the 200-row head control passes; the 49 residual ids fail identically)
direct differences     : 49
```

**The 49 residuals reproduce exactly** the accepted N1 baseline
(20,528 − 20,479 = 49) on today's main-equivalent tree. Grouped by root
signature (**VERIFIED**):

| count | original intent → Phoenix intent | family |
|---|---|---|
| 12 | `doesJiboHavePlansForEvent` → `whatDidJiboAction` | F2 (overlapping `what…doing` arms) |
| 9 | `whereShouldUserHolidayShop` → `whereShouldUserAction` | F2 (identical surface, `Action=HolidayShop` tag) |
| 5 | `whatGiftShouldUserGiveHoliday` → same intent, `GivenName:''` sentinel dropped | F2 (empty-string NL return) |
| 4 | `isJiboDescriptor` → same intent, wrong descriptor entity | F2 (desc/emotion overlap) |
| 4 | `isJiboDescriptor` → `isThingDescriptor` | F2 (`are you scary/threatening`) |
| 4 | `unknownIsDescriptor` → `userDislikesThing` | F2 (`that was appalling/disturbing`) |
| 2 | `doesJiboWantThing` → same, extra `Food=FoodGeneral` | F2 |
| 2 | `howCanUserAction` → `partialRecognition` (`shutdown please`) | F2 |
| 2 | `thankJiboForAction` → `jiboShouldBeDescriptor` | F2 |
| 2 | `userSupportsSomeoneForEvent` → `whoWillWinEvent` | F3 (AST cost vs native heuristic) |
| 1 | `whereIsThing` → same, extra `ObjectOwner=Speaker` | F2 |
| 1 | `userLikesThing` → same, `Color` vs `MusicType` | F2 |
| 1 | `doesJiboLikeThing` → same, `Sport` vs `Event` | F2 |

This is the same classification root already recorded in
`docs/parity/candidates/N-08-residual-families-20260907.md`, re-measured
independently rather than cited: **F2 = 47, F3 = 2, F1 = 0** (F1's two rows are
already repaired on this base).

### 3.1 The repair does not move the pinned corpus (by construction, re-verified)

The repair in §5 lives in `packages/nlu/src/fullGrammar.js`, which is **not** on
the `parseRequest` path. Re-running the tool over the 49 residual ids plus the
three malformed boundary rows (**VERIFIED**):

```
cases 52 · direct parseRequest 3/52 · live HTTP 3/52 · direct differences 49 · http differences 49
```

— i.e. the same 49 ids with the same signatures, plus the three boundary rows
now verified as HTTP 4xx. A 300-row head control through both phases is
`300/300` direct and `300/300` live HTTP (**VERIFIED**).

## 4. Manifest-corpus result (the `corpusRunner`, before → after)

### 4.1 Verification-integrity note (why the first "after" run was discarded)

`packages/harness/src/corpusRunner.js` imports the NLU stage **by package name**
(`import { parse } from '@phoenix/nlu'`). In a worktree, `node_modules` is a
symlink to the main checkout, so `@phoenix/nlu` resolves to
`/home/shell/work/phoenix/packages/nlu` — the **main** tree — while the runner's
other imports resolve inside the worktree. A first after-run therefore reported
"no change" while exercising the unpatched main file.

Workaround used for the measurement (not committed; `node_modules/` is
gitignored): a worktree-local `packages/node_modules/@phoenix/nlu -> ../../nlu`
symlink, which shadows the root resolution for anything under `packages/`. The
200-entry probe then flipped from 1 miss to 0 misses, proving the runner was
exercising the worktree's NLU (**VERIFIED**). This is the same hazard N-03
reported as D-N03a; it is recorded here again as a divergence candidate for the
parity effort, not as a product divergence.

### 4.2 Numbers

Baseline (unpatched, = main `3dd1cfa`; **VERIFIED**):

```
entries 4705 · utterances 10035 · D3 intent 9991/10035 · D4 mim 9873/10035 · misses 162
```

After the repair (§5; **VERIFIED**):

```
entries 4705 · utterances 10035 · D3 intent 9993/10035 · D4 mim 9875/10035 · misses 160
```

The two repaired rows are exactly the two rows whose winner was the spurious
clock/timer match, and no other row changed (id-set diff, not count diff).

### 4.3 Classification of the remaining manifest mismatches

Bucketed by root cause (**VERIFIED**, artifact `classification.json`):

| bucket | before | after | root cause | repairable here? |
|---|---|---|---|---|
| F — MIM class-specific | 78 | 78 | intent correct, the routed MIM is the generic `KU_*`/`RI_JBO_*` instead of `*_SS_<Class>`. The manifest declares a class entity (`{name:'GeneralLikes',value:'*'}`) that the **pinned original parser capture for the same utterance does not emit at all**, so the manifest expectation and the native body disagree (D-N08e). Needs the chitchat MIM condition set (S-* scope). | no |
| G — MIM other | 40 | 40 | intent correct, MIM differs (loop-member/birthday and loop-member-vs-stranger MIMs). Same decision-tree area as F but keyed on the loop / `LoopMemberDetector` entities. | no |
| D — known launch-union overlap | 26 | 26 | the legacy stage's copies of the pinned F2 families: `doesJiboHavePlansForEvent→whatDidJiboAction` (12), `whereShouldUserHolidayShop→whereShouldUserAction` (6), `isJiboDescriptor→idle` (12 — the `are you a <class>` descriptor overlap), `unknownIsDescriptor→userDislikesThing` (2), … | no (F2 class) |
| A — GQA/weather rewrite | 14 | 14 | `whoIsPerson`→`generalWhoQuestions` (10) and `whatDoesThingMean`→`generalWhatQuestions` (4), produced by `applyGqaContinuity` in `packages/nlu/src/index.js`. This **is** criterion 2 ("move any desired GQA/weather rewrites to explicit separately tested configuration"). | yes, but it inverts an intentional divergence (B6) that the dead Wolfram deflector forced; see §7 |
| E — AST cost vs native heuristic | 2 | 2 | `userSupportsSomeoneForEvent`→`whoWillWinEvent`; the pinned F3 pair. | no (F3 class) |
| C — clock factory wildcard | 2 | 0 | **repaired by this task** (§5). | done |
| **total** | **162** | **160** | | |

The two repaired rows are exactly the two `C` rows; every other bucket is
byte-identical before and after (id-set diff, not count diff).

## 5. The repair: an unserved factory dependency must not become a wildcard

`packages/nlu/src/fullGrammar.js` stands in for the native **launch union** in
the legacy `parse()` stage. It called `matchRule()` without `strictFactories`,
so `packages/nlu/src/grammar/matcher.js`'s historical fallback filled an
unserved `$factory:` slot with **1..3 arbitrary words**:

```
"can you give me the password to my brother's computer"
   legacy parse()  : intent "start",      entities {domain:"timer", skill:"@be/clock", priority:"HIGH"}
   source contract : intent "canJiboAction", entities {Action:"GiveUserThing", union_original_fst_name:"handle:chitchat/launch"}
```

The source contract is the frozen original for case `chitchat:21:0:base`
(**VERIFIED** against the capture), and the HTTP path already reproduced it
(`parseRequest({text, rules:['launch']})` — **VERIFIED**); only the legacy stage
diverged. The clock grammar claims the utterance only through the wildcard:
with `strictFactories:true` the same clock top is a **no-match** while the
unstrict call still matches `start` (**VERIFIED**, pinned as a test).

Source basis (`https://pvindex.org/mcp`, `gitea_read_file`):

* `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c:packages/parser/src/robustparser/RobustParserClient.ts`
  — *"Prep: lowercase the input because the rules expect all lowercase."*
  (l. 68-69), *"Rules known by Robust Parser: %s"* (l. 75), the tie-break
  comment *"Rules that we want to lose in ties - the global launch rule and
  anything in the globals/ folder"* (l. 22-23), `getBestResult` comparing
  `result.heuristic_score` only (l. 262-288), and *"Defaults to 'LOW' priority /
  bestResult.NLParse.priority = …"* (l. 108-110) — i.e. priority is payload
  copied after selection, never a ranking term.
* `…:packages/parser/src/handlers/ParseRequestHandler.ts` — `EMPTY_NLU =
  {intent:null, entities:null, rules:[]}` (l. 13-17), the 400 on a non-string
  `data.text` (l. 30-32), and `LoopMemberDetector.detectLoopMembers(req.body.data,
  result)` after selection (l. 34).
* `…:packages/parser/src/robustparser/interfaces.ts` — `NLParse` is
  `{intent, priority?, [value:string]:string}` and `getNLParseEntities` strips
  exactly `intent` and `priority`.

Two rows are repaired (both are the same mechanism, both chitchat intents):

| case | utterance | before | after | original |
|---|---|---|---|---|
| manifest KU/DF | `can you give me the password to my brother's computer` | `start` / `@be/clock` | `canJiboAction` | `canJiboAction`, `Action=GiveUserThing` (`chitchat:21:0:base`) |
| manifest KU/DF | `give me an example of an np hard problem` | `start` / `@be/clock` | `requestJiboGiveThing` | `requestJiboGiveThing` |

Genuine clock utterances are unaffected (positive controls, **VERIFIED**):
`what time is it` → `askForTime`, `whats the date` → `askForDate`,
`set a timer for 5 minutes` → `domain:timer`, `stop the timer` → `stop`;
and the long-tail launch intents are unchanged (`sing me a song`,
`i love you`, `turn on the lights`, `tell me a joke`, `how are you`).

## 6. The `{% if %}` conditional-action divergence is ALREADY CLOSED on this base

The task brief asked specifically whether the conditional `{% if %}` action drop
(10 occurrences across 5 rule files) is in scope. It is in scope, and it is
**already implemented** on the base revision — the drop is a stale N-03
observation that the wave-11 N-05 work repaired. **VERIFIED**:

* `packages/nlu/src/grammar/parser.js:238-276` (`parseActionBlock`) emits a
  `{kind:'cond'}` tag per `if (this.X == 'a') {this.X = 'b'}` arm;
  `packages/nlu/src/grammar/matcher.js:189-196` (`applyTags`) evaluates them
  after the block's plain assignments.
* An exhaustive scan of every `{% … %}` body in all 19 vendored rule trees finds
  **2,745 `lit` + 11 `parsed` + 5 `cond` + 1 `subfield` statements and ZERO
  unhandled forms** (**VERIFIED**).
* All five source sites execute correctly through the HTTP entry
  (**VERIFIED**): `clock/alarm_timer_change` yes→`delete`, no→`keep`,
  `trash it`→`delete`, `sure`→`delete`; `clock/alarm_timer_other_set`
  yes→`replace`, no→`keep`; `greetings/proactive_general_question` and
  `greetings/proactive_playful_question` yes→`good`, no→`bad`;
  `word-of-the-day/right_word` yes→`agreement`, no→`disagreement`.

So "the single biggest win available" was already banked; the work here is
pinning it against regression (`packages/nlu/test/n08ConditionalActions.test.js`,
4 tests, every site) rather than re-implementing it.

## 7. What was deliberately NOT changed

* **The two `$factory:time` rules stay behind the whole-rule refusal**
  (`packages/nlu/src/requestParser.js:329`). N-03 proved narrowing converts a
  loud refusal into a silent no-match; left untouched.
* **AST launch-union ranking.** The pinned 49 residuals are F2/F3 and root has
  closed further AST ranking work (divergence N1). Nothing here reopens it.
* **`applyGqaContinuity` (criterion 2).** 14 manifest rows would be repaired by
  making the original routing the default and moving the GQA/weather rewrite
  behind explicit configuration. It was not landed because it inverts an
  intentional, documented divergence (B6) that exists precisely because the
  original's GQA target (Wolfram) is dead, it changes which skill answers 14
  user-visible questions, and it needs its own replay of the answer-skill path —
  i.e. its own task. Recorded as **D-N08b**.
* **The legacy-stage parser-only fields.** `fullParse()` returns entities that
  still carry `intent` and `priority`; the reference's `getNLParseEntities`
  strips both. The HTTP contract is already clean (it deletes them in
  `matchNamedRule`, requestParser.js:242-243), so this is a legacy-stage shape
  deviation only. Not fixed because the same objects feed `parse()`'s SKIP
  decision (`index.js:63`) and the intent router's entity tree, so a blind strip
  is not risk-free. Recorded as **D-N08c**.

## 8. Falsification (required, concrete)

One full production line, `packages/nlu/src/fullGrammar.js:91`:

```diff
-… factoryWords: loadFactoryWords(), strictFactories: true }); } catch { /* skip */ }
+… factoryWords: loadFactoryWords(), strictFactories: false }); } catch { /* skip */ }
```

`node --test packages/nlu/test/n08FullGrammarFactoryStrictness.test.js`
(**VERIFIED**):

```
not ok 1 - N-08 the legacy launch stage returns the original contract for the clock-wildcard text
  error: |-
  expected: 'canJiboAction'
  actual: 'start'
# tests 4   # pass 3   # fail 1
```

Restored (`strictFactories: true`), re-run (**VERIFIED**):

```
ok 1 - N-08 the legacy launch stage returns the original contract for the clock-wildcard text
ok 2 - N-08 an unserved factory dependency is a no-match, not a wildcard
ok 3 - N-08 factory strictness keeps genuine clock utterances matching
ok 4 - N-08 factory strictness does not regress the long-tail launch intents
ok 5 - N-08 the same clock-wildcard mechanism is closed for every affected utterance
# tests 5   # pass 5   # fail 0
```

Test 2 is the mechanism pin: it asserts the unstrict clock top *does* match
(this is the bug), and that the strict one is `null`.

## 9. Full test run and parity gate

See `npm-test.log` in this directory (one full `npm test`, real inline counts,
exit code).

## 10. Limits and unknowns

* **UNKNOWN** — whether the three malformed `boundary:*` rows are graded
  anywhere else; here they are asserted as 4xx only.
* **UNKNOWN** — for the 78 F-bucket rows, which entity/class the original
  chitchat skill actually used, because the pinned parser capture emits no such
  entity. This is an internal contradiction between two vendored artifacts and
  needs the chitchat MIM conditions (S-* scope).
* **UNKNOWN** — the native `heuristic_score` for the 49 residuals was not
  re-executed here (no native binary in this worktree); the F2/F3 attribution
  follows the accepted classification rather than a fresh native run.
* **INFERRED** — the legacy `parse()` stage is exercised only by the harness
  corpus runner and tests (no production importer). The repair is therefore
  measured on the manifest corpus, not on a served path.
* **INFERRED** — `includePriority` is still applied in the cross-skill legacy
  selection (`fullGrammar.js`); the F1 root cause says priority must not be a
  ranking term. Removing it changed nothing for the two repaired rows (the AST
  `specificity − cost` order still preferred clock there), so it was left as-is
  rather than landed unproven. Recorded as **D-N08d**.

## 11. Divergence candidates (reported, not written to DIVERGENCES.md)

* **D-N08a (verification integrity, restated).** Worktree `@phoenix/*` imports
  resolve to the main checkout through the shared `node_modules` symlink; any
  worktree measurement of a package-name importer is invalid unless an in-tree
  shadow is created. Same hazard as N-03's D-N03a, re-confirmed here with a
  concrete discarded run.
* **D-N08b.** `applyGqaContinuity` (`packages/nlu/src/index.js:93-121`) rewrites
  `whoIsPerson`→`generalWhoQuestions` and `whatDoesThingMean`/
  `requestTellAboutThing`→`general*Questions` and `requestWeather`→
  `requestWeatherPR` unconditionally in the legacy stage; 14 manifest rows
  diverge from the manifest's declared intent because of it. Criterion 2 asks
  for exactly this to become explicit, separately tested configuration.
* **D-N08c.** `fullParse()` leaks `intent` and `priority` inside `entities`
  (reference `getNLParseEntities` strips both).
* **D-N08d.** `fullParse()` scores cross-skill candidates with
  `priorityRank*1e6 + (specificity − cost)`, while the source scores one union
  graph by `input_length − heuristic` and copies priority afterwards. The same
  root cause the F1 repair removed from the launch-union request path.
* **D-N08e.** The vendored chitchat manifest declares class entities
  (`{name:'GeneralLikes', value:'*'}`) for utterances whose pinned **original
  HTTP parser response contains no entities at all**; the manifest's `mimId`
  (`RI_JBO_Likes_SS_Amphibian`) therefore cannot be derived from the pinned
  parser body. 78 rows.
* **D-N08f.** `attachExternalResult` throws `Cannot read property 'external' of
  null` on one captured external request; the case still matched its recorded
  status, so the behaviour is consistent with the original, but the message
  indicates a null-provider dereference worth its own look.

## 12. Artifacts in this directory

* `review.md` — this file.
* `manifest-corpus-before-after.json` — the chitchat/hub manifest corpus
  (4,705 entries / 10,035 utterances) through `corpusRunner.js`, before and
  after, with the exact repaired row set and a zero-new-failure proof.
* `classification.json` — the manifest mismatches bucketed by root cause
  (before and after bucket counts).
* `pinned-corpus-before.json` — summary of the full pinned-corpus replay
  (20,525 parser-reachable rows; 20,476 matches; 49 differences; grouped
  signatures; the 49 ids).
* `pinned-corpus-after-recheck.json` — the 49 residual ids + the 3 malformed
  boundary rows replayed on the patched tree.
* `falsification.log` — break → named test failure → restore → green.
* `npm-test.log` — one full `npm test` on the patched tree.
