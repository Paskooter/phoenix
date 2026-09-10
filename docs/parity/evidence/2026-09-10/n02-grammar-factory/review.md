# N-02 — Match grammar execution, factory entities and scoring

Evidence date: 2026-09-10 · worktree `.parity/worktrees/w5-n02` (branch `w5/n02`)
Base revision: `194b81a` (head at start of work) · Node `v22.22.0` (linux)

Every claim below is labelled **VERIFIED** (observed in a command output in this
evidence set), **INFERRED** (reasoned from pinned source, not observed) or
**UNKNOWN**.

---

## 1. Specification re-derived (not trusted from an earlier report)

From `docs/parity/tasks.json` (N-02 row, read from the repository; the file was
**not** modified) and the pinned sources it names:

| Pinned file | What it decides |
|---|---|
| `ConvTech/jibo-nlu@91b1bb6:compiler/compiler.ypp` | rule grammar: `?`/`*`/`+` prefix operators, `[ ]` bracket group, `{% %}` / `{k=v}` tags, `~N` weights, `<N>` heuristics |
| `ConvTech/jibo-nlu@91b1bb6:compiler/compiler.l` | `specialchars` / `nospecialchars` word classes |
| `ConvTech/jibo-nlu@91b1bb6:compiler/list_manip.cpp` | `add_optional` / `add_kleene` / `add_plus_kleene`, `new_word`, `new_word_and_equivalents` |
| `ConvTech/jibo-nlu@91b1bb6:parser/interpreter.cpp` | the reserved `_parsed` variable (:33, :90-95, :138-147), `=` vs `+=` NL operators (:171-…), undefined-variable evaluation |
| `jiboV2/pegasus@5c0a739:packages/parser/src/robustparser/RobustParserClient.ts` | score/tie and designated-loser selection (:19, :281-283), `priority` stripped from the wire result (:251-258) |
| `ConvTech/jibo-nlu-data:master:en-us/factory_rules/*.grm` | the version-matched factory grammar sources (README: "Repository for factory source grammars and source fsts") |

Acceptance criteria (verbatim from the row):

1. *Differentially test semantic actions, recursion, optional/repeated rules,
   wildcards, equivalents, locale/token normalization, weights and
   designated-loser ties.*
2. *Recover all factory entity semantics, including names, places, dates, times,
   durations and numeric entities, from version-matched source/artifacts.*
3. *Use the production parser in the oracle harness and preserve exact entity
   values/types; report mismatches per feature.*

## 2. What was already correct

The compiled-FST production profile already executes the pinned compiled graphs
(the accepted 20,528-request replay), and the AST matcher already handled
semantic-action blocks, optional/plus rules, wildcards, equivalence and `<N>`/`~N`
weights — those are covered by the existing suites and re-verified here, not
reimplemented.

## 3. Gaps found and closed

### G1 — `{key=_parsed}` was the literal string `"_parsed"` (grammar execution)

`interpreter.cpp:33` seeds the reserved variable `_parsed`; `compiler.ypp`
`nl_right` accepts a bare `VARIABLE_OR_RULENAME`, so `{k=_parsed}` assigns the
text the node matched. `packages/nlu/src/grammar/parser.js` classified a bare
identifier as a `lit` tag, so `PARSED @= (+$w){_slotAction=_parsed}` (used by
`rules-src/ifttt/launch.rule:7`) produced `_slotAction = "_parsed"`.

**VERIFIED** before: `{"out":"_parsed"}`; after: `{"out":"the thing"}`.

### G2 — standalone `*` and non-ASCII/`&` word characters did not lex

`compiler.l` `specialchars` is `[\*=;'+}![\]<>\(@\)|?~$\\#\^]`; everything else
(including `&`, `-`, `/`, `:` and every non-ASCII byte) is a word. Index
`nospecialchars` — one alternation — plus `compiler.ypp`'s
`'*' rulecontent {lm::add_kleene($2);}` gives the two cases Phoenix rejected:

* `packages/nlu/src/grammar/lexer.js` threw on `&` and on `é`, so
  `factory_rules/timer.grm` (`?(and|&)`) and `factory_rules/canada_province.grm`
  (`québec`) could not be read at all;
* there was no token for the prefix `*` operator, so `factory_rules/digits.grm`,
  `date.grm`, `year.grm`, `world_city_country.grm` and
  `canada_city_province.grm` failed with `lexer: unexpected character "*"`.

Fixed in the lexer (`isWordStart`/`isWordChar` + a `KLEENE` token) and in the
parser/matcher (a `kleene` AST node with a progress-guarded zero-or-more walk).
The `[ ]` bracket group also gained the native general form
(`compiler.ypp brackets_and_charrulecontent`): a body made only of
character-class atoms still collapses to the existing `class` node, any body
carrying refs/tags/operators is re-parsed as an expression. The predicate was
checked against **all 5,183** bracket bodies in the bundled rules: none contains
`$ * + { }`, so no existing grammar changes shape — **VERIFIED**.

### G3 — word-list factories published the wrong private field and value

The `$factory:` word lists were extracted as plain text, keeping each spelling
but dropping the private field and value the reference grammar declares. The
version-matched sources are recovered under `resources/factory-sources/`
(`manifest.json` records the origin, the upstream byte size and the recovered
SHA-256), and `packages/nlu/tools/extractFactoryWordSemantics.mjs` re-derives
`word-list-semantics.json` from them. Applying it fixes two silent drops:

| factory | was | recovered source declares | effect |
|---|---|---|---|
| `state` | `_state` = `"california"` (never read) | `_nl` = `"ca"` | `clock/launch` `D_TIME_USSTATE` `{_state=state._nl}` now resolves |
| `canada_province` | `_canada_province` = `"ontario"` (never read) | `_nl` = `"ontario"` | `D_TIME_CANADA_PROVINCE` `{_state=canada_province._nl}` now resolves |
| `country`, `first_name`, `music_genre` | already the declared field | `_country` / `_first_name` / `_genre` | unchanged |

**VERIFIED at runtime through `parseRequest`** (the NLU HTTP path):

```
"what time is it in california" -> intent askForTime  state "ca"
"what time is it in texas usa"  -> intent askForTime  state "tx"  country "usa"
"what time is it in ontario"    -> intent askForTime  state "ontario"
"what time is it in france"     -> intent askForTime  country "france"
"what time is it"               -> intent askForTime  state "null"
```

Raw outputs: `runtime-factory-entities.json`. On the base revision the same
`california` utterance returned `state:"null"` — the factory field never
resolved.

The inventory (`rule-inventory.json`), its compiled-profile approval digest and
the Pegasus-provenance fixture were deliberately **not** touched: the approved
portable-snapshot profile pins the inventory SHA-256, and the word-list
directory is fenced by the S-06 fixture. The recovered semantics therefore ride
in a new, separate, regeneration-anchored resource.

## 4. What is still open (reported, not papered over)

| factory | state |
|---|---|
| `state`, `canada_province`, `country`, `first_name`, `music_genre` | **VERIFIED** exact values (table above) |
| `digits`, `year` | parse and run, but **diverge**: the AST matcher applies a repeated rule's tag once at the group tail, and merges the repetition's sub-fields last-wins, so `digits.grm` `$num_spoken_digits … *$num_spoken_digits{_nl+=…}` yields `33` for "one two three" (native `123`) and `year.grm` yields `4444` for "nineteen eighty four" (native `1984`). Root cause: `parseSeq` hoists the last item's tags to the group and `mergeObj` overwrites the accumulated private field. Not wired. |
| `time`, `timer` | do not parse: the source uses `?:` / `1/2` literal-colon and fraction forms, and the AST lexer models `:` as a token (`compiler.l` has no `:` in `specialchars`). Affects `clock/alarm_set_value`, `clock/alarm_timer_ampm` (still unsupported in the AST profile). |
| `date`, `world_city_country`, `canada_city_province` | parse after the prefix-`*`/bracket repair; not executed (their consumers additionally need `time`, `city_state`). |
| `city_state`, `last_name` | the archive portal returned byte-truncated bodies (98,305 / 69,103 bytes vs 265,630 / 229,473 upstream), so no source is vendored and their hash cannot be claimed. |
| `canada_province` accented arm | the bundled word list stores `quÃ©bec` (UTF-8 read as Latin-1), so the accented spelling does not reach the factory; the recovered source declares it. The word list is provenance-fenced, so this is reported for a fixture re-review. |
| grammar *compilation* (source → FST) | untouched. |

## 5. N-01 coupling (explicit)

N-02's AST scoring/selection is the same code path N-01 flagged: the default AST
profile picks a different winner from the launch union on 8 of the 42 original
multi-rule cases because its score scale is (literal-specificity − arc cost),
not the native `input_length − heuristic`. That discrepancy is **unchanged by
this work** and is visible here: this evidence replays the single-rule `launch`
oracle only, where AST and compiled profiles agree. Any N-02 certification of
*scoring* that depends on the default AST profile inherits N-01's unresolved
8/42 winner difference. `selectBestNative`'s tie rule itself is unchanged and
separately covered.

## 6. Falsification (required)

Two independent breaks, each on a **full code line**, restored afterwards.

**Break 1 — semantic action** (`packages/nlu/src/grammar/parser.js:299`):

```js
-          tags.push({ key, op, kind: 'parsed' });
+          tags.push({ key, op, kind: 'lit', value: '_parsed' });
```

`node --test packages/nlu/test/grammarExecutionDifferential.test.js`
→ `not ok 3 - semantic action: {key=_parsed} assigns the text this node matched`,
`expected: 'the thing' / actual: '_parsed'`. Restored → green.

**Break 2 — factory value** (`packages/nlu/src/grammar/matcher.js:484`):

```js
-          const declared = semantics && semantics.values ? semantics.values[phrase.join(' ')] : undefined;
+          const declared = undefined;
```

`node --test packages/nlu/test/factoryEntitySemantics.test.js`
→ `not ok 4 - the state factory publishes the reference two-letter code at runtime`,
`expected: 'ca' / actual: 'california'`. Restored → 26/26 green, and the
word-list/`class` suites stay green (36/36 with `charClass.test.js`).

## 7. Oracle harness (acceptance 3)

`packages/nlu/tools/legacyOracleDiagnostic.mjs` gained `--production`, which
replays the archived golden capture through the production `parseRequest` (the
same entry the HTTP handler calls) and compares **exact entity values and
types** per feature. `priority` is excluded because the wire result omits it
(`RobustParserClient.ts:251-258`) and the capture records it.

```
$ node packages/nlu/tools/legacyOracleDiagnostic.mjs --production
runtime: ast (PHOENIX_NLU_RUNTIME=unset)
INTENT PARITY: 89/89 (100%)
ENTITY FEATURE TOTALS: Action=2 Color=1 Concept=1 Emotion=2 FavoriteCategory=1
  GeneralDescriptor=4 GeneralLikes=1 GivenName=4 JiboContent=1 LastName=1
  Location=1 Person=3 city=6 country=6 day_of_week=6 domain=26 hours=1
  itemType=1 minutes=1 seconds=1 skill=30 state=6 union_original_fst_name=89
ENTITY FEATURE MISMATCHES: none
ENTITY VALUE/TYPE MISMATCHES: 0
```

The historical AST diagnostic itself scores 83/89 intents on the same capture;
the production path is exact on all 89. Output preserved as
`oracle-production.txt`.

## 8. Limits and unknowns

* **UNKNOWN** — the compiled-FST runtime was not run here (its 42 MB launch
  artifact is not present in this worktree); the production-parser oracle used
  the AST runtime, as printed by the tool.
* **INFERRED** — recovered factory sources are byte-identical to the upstream
  blobs: the portal exposes no raw digest, so equality rests on the recovered
  byte count matching the size `gitea_browse` reports for every complete file,
  plus verbatim content review.
* **UNKNOWN** — whether the `digits`/`year` tag-composition fix would change any
  currently-passing replay; it was not attempted.
