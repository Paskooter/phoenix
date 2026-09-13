# S-07 chitchat boundary differential

This artifact records a bounded source/runtime check. It does not close S-07.
The implementation/evidence branch is `w20/s07-boundaries` at
`b88b1d2306684291322b04550088e38f7f62de9a`, based on `4993508ca610a11faeb491d8ebbbce1b07700e58`.
The production diff from that base is empty. The commit adds the source runner,
candidate runner, 46-row matrix, strict comparator, and falsification harness.

The source is Pegasus `5c0a7390539663ba749d360de348a428c088505c`, executed with
Node `v8.9.4` from
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The candidate ran with Node `v22.22.0`. The source runner executes the archived
source graph and obtains the table inputs from the source `FileUtils` inventory
and `csv-parse` implementation in one initialized process. The receipt records
4369 scripted MIMs, 54 emotion MIMs, one fallback MIM, and 66 category files;
the source inventory hashes equal the injected table hashes. The synchronous
directory hashes are retained only as a diagnostic because the source file
walker has a different asynchronous completion order.

The matrix has 46 rows: 13 malformed launch shapes, four valid intent cases,
11 fallback and wrong-family cases, and 18 dice/coin cases. It covers omitted,
null, empty, numeric, and string memo/result/NLU/entity shapes; unresolved and
resolved semispecific entities; unknown MIMs and known MIMs under wrong intent
types; weighted fallback seeds; `RA_JBO_FlipCoin`, `RA_JBO_RollOneDie`, and
`RA_JBO_RollTwoDice` branches; and the three `RI_JBO` dice MIMs. Every dice
row consumes four deterministic random values, while fallback rows consume one
value. The exact row inputs and outputs are in `matrix-spec.json`,
`source-runtime.json`, and `candidate-runtime.json`.

The final receipt is a pass with 39/46 semantic matches and 39/46 exact prompt
matches. The seven differences are explicitly classified as
`source-malformed-precedence`: omitted/null/empty `result`, omitted/null `nlu`,
and omitted/null semispecific `entities`. On those rows the source directly
reads fields and throws a Node 8 property/type error, while the unchanged
Phoenix boundary keeps its existing defensive behavior. The other six
malformed rows and all 33 valid/fallback/dice rows match exactly. The comparator
fails on every unexpected semantic or prompt mismatch and rejects missing,
duplicate, extra, or cardinality-mismatched rows.

The source justification is in the pinned archive:

- `packages/chitchat-skill/src/nodes/IntentSplitNode.ts:21-28` reads
  `data.result.nlu.intent` before checking `memo`.
- `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts:33-43` reads memo and
  entities and resolves semispecific MIMs; `:121-143` returns no MIM when no
  category matches.
- `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts:149-155` adds only
  `Dice` and `Coin` to prompt data.
- `packages/chitchat-skill/src/utils/FunAndGamesUtils.ts:18-44` establishes
  two die calls and one coin call; `BaseSkill.ts:12-22,36-47` establishes the
  public error envelope.

The source and candidate MIM trees each contain 4424 files with the same tree
hash. `promptdata-observability.json` records no `skill.entities` or
`skill.intent` references in either tree; only the expected dice and coin
references occur. Phoenix prompt-data extras are therefore not client-visible
in this matrix and were not changed.

The falsification harness rejects all three controls:

```text
prompt-id mutation       rejected, status 1
paired row omission      rejected, status 1
semantic value mutation  rejected, status 1
```

`baseline-verification.json` records the same result after running the complete
matrix against the unmodified `4993508` production behavior. This demonstrates
that the lane supplies evidence and comparator coverage without asserting a
production repair. The malformed precedence differences remain open S-07
scope, as do the rest of the chitchat service categories and any live-provider
or hardware behavior.

Validation of the repository suite was repeated twice. Both `npm test` runs
reached 1,990 tests with 1,980 passing, one failing, and nine skipped; the same
parallel loop-member case failed with `TypeError: fetch failed` at
`packages/account/test/loopMemberProfile.test.js:279`. Running that test file
alone then passed all 7/7 cases. The focused source/candidate comparator and all
three falsification controls passed; the full suite remains environment-red for
that unrelated listener/fetch case.
