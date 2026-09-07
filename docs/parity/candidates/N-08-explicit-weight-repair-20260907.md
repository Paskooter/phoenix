> Historical candidate report. The final bounded implementation is accepted in the [root native-operator review](N-08-native-operators-root-20260907.md); earlier failed runs and qualifications remain retained.

# N-08 explicit-weight plus-kleene repair

Status: candidate unverified; pending root review.

This candidate repairs two source grammar boundaries in the default AST
matcher. The lexer previously discarded a bare `+`, which collapsed source
`+$w` into plain `$w`. The pinned native compiler parses `+ rulecontent` as
`PLUS_KLEENE` (`compiler/compiler.ypp:119-125`), and builds `$w` as one
mandatory nonblank word followed by a separator
(`compiler/compiler.cpp:167-190`). Therefore `+$w` accepts one or more words,
whereas plain `$w` accepts exactly one nonempty word at this boundary.

The candidate preserves `+` as a `PLUS` AST node and matches progress-making
operand repetitions with a bounded recursive walk. Operand tags and fixed
postfix costs are applied to the repeated node. A zero-progress operand is
skipped, preventing optional or star operands from creating an unbounded loop.
Plain `$w` keeps the source-required nonempty one-word behavior from the
predecessor candidate.

The character-class expander also now follows the native tight alternation
binding. In the source form `[bug(g(ed)|(ing))]`, the `|` is part of the
immediately preceding grouped item, so the variants are `bugged` and
`bugging`; it is not `bugged` and `buging`. This follows the native
`charrulecontent` productions (`compiler/compiler.ypp:196-203`) and keeps the
existing next-character/group optionality behavior.

## Failure classification

The frozen `2a814ab` replay had 60 candidate-only newly failing records and
eight shared residual records whose actual output changed relative to the
`031844d` baseline. The 60 new records have one common cause: the discarded
`+`/wrong `$w` cardinality. They cover 44 chitchat and 16 hub-client records;
the expected intent groups are 34 `userSupportsSomeoneForEvent`, eight
`userGivesJiboGiftHoliday`, four `doesJiboHavePlansForEvent`, four
`seriousTopicDrugsAlcoholismFamilyFriends`, two each of
`holidayGreeting`, `requestMovieListings`, `requestTVListings`,
`userFeelsEmotionAboutThing`, and `whyIsJiboDescriptor`.

The causal records are retained in the private classification receipt at
`/home/shell/work/phoenix/.parity/reviews/n08-explicit-weight-repair-20260907/classification.json`:
the 60-row controls have 0 mismatches on `031844d` and `b339c37`, 60 on
`1aeec012`, and 0 after this repair. A source-compiled native `launch.rule`
control selected the expected intent/entity for all 68 affected or
reclassified rows. The four-case native plus control is at
`/home/shell/work/phoenix/.parity/reviews/n08-explicit-weight-repair-20260907/native-plus-control/result.json`.
The direct native chitchat control for the four shared texts, including
`requestMeetPerson`, `requestPhoneVideoCall`, and `Emotion=Afraid`, is at
`/home/shell/work/phoenix/.parity/reviews/n08-explicit-weight-repair-20260907/native-mom-control/result.json`.

The eight changed shared residuals were then checked as a separate focused
cluster. The character-class repair restores the native `jiboIsDescriptor`
plus `Emotion=Afraid` result for four `bugging out` rows, and its general
source behavior also restores two `requestPhoneVideoCall` rows. Two `this is
my mom` rows remain unresolved: Phoenix's cross-skill arbitration chooses the
HIGH introductions enrollment result while the native union returns the
chitchat requestMeetPerson result. That requires a separate union/result-score
control and is intentionally not changed here. No corpus-specific product
exception was added.

The bounded native control shows both individual source FSTs produce
`heuristic_score: 8` for `this is my mom`; the pinned source
`RobustParserClient.getBestResult` keeps the earlier chitchat response on that
tie. Phoenix's full-grammar stage currently adds priority/specificity ranking,
so changing it would be a broader arbitration repair rather than a character
grammar fix.

## Validation and limits

The candidate worktree was provisioned with `npm ci --ignore-scripts --offline`
and local workspace links. The focused suite is:

```text
node --test packages/nlu/test/grammarPlus.test.js \
  packages/nlu/test/grammarExplicitWeight.test.js \
  packages/nlu/test/grammar.test.js \
  packages/nlu/test/requestParser.test.js \
  packages/nlu/test/fullgrammar.test.js
```

It passes the focused parser/matcher suite including the native nested
character-class control. The focused 68-row result has 60/60 newly failing
records repaired; six of the eight changed shared residuals now match the
native expected result, and two cross-skill arbitration rows remain. The
earlier 20,528-row replay and its 176 records remain frozen; no full replay was
run after these repairs. Native plus controls used archived `grm2fst` and `parse`
directly on the host with `LD_LIBRARY_PATH`, not the pinned Node 8 Docker
image. Full default-AST parity, score quantization, cross-grammar arbitration,
and the eight shared residuals remain open.
