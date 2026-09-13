# N-08 routing and corpus closure review

Date: 2026-09-13  
Owner/reviewer: Codex root  
Integrated implementation: `ac6c8f9` (`nlu: gate GQA continuity behind explicit profile`)  
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`

## Decision

**VERIFIED closure candidate.** The implementation satisfies all three written
N-08 acceptance criteria. The remaining differential rows are explained and
already assigned to the accepted N1 parser divergence or the S-07 identity/MIM
decision tree. This review does not reopen AST ranking, change the default AST
engine, deploy a service, or claim hardware acceptance.

## Source contracts

The pinned sources were read through the Jibo MCP before reviewing the patch:

- `packages/parser/src/handlers/ParseRequestHandler.ts` defines the empty result
  as `{ intent: null, entities: null, rules: [] }` and applies loop-member
  detection after parsing.
- `packages/parser/src/robustparser/RobustParserClient.ts` preserves source
  chitchat routing and removes `intent` and `priority` from the entity payload
  returned across the public boundary.

Phoenix retains `priority` internally long enough to enforce the source `SKIP`
rule, then removes both parser-only fields from the legacy public result.
`parse(text)` now uses source routing by default. The chosen B6 GQA/weather
continuity behavior is available only through
`parse(text, { gqaContinuity: true })`.

## Acceptance criteria

| criterion | evidence | result |
|---|---|---|
| Original empty shapes and clean entities | Existing empty/no-match request tests plus `n08GqaContinuity.test.js`; the pinned HTTP replay includes entities, rules, no-match and malformed boundary rows. `intent` and `priority` are stripped only after the internal priority decision. | **VERIFIED** |
| Source routing is the compatibility behavior; GQA/weather is explicit | The exact manifest class contains 10 `whoIsPerson` and 4 `whatDoesThingMean` rows. All 14 retain their source intents by default and use Phoenix continuity only when `gqaContinuity === true`. Weather has an independent default/opt-in control. | **VERIFIED** |
| Zero unexplained full-corpus mismatches, including skill/memo | The complete pinned HTTP set retains exactly the accepted 49 N1 residuals. The complete 10,035-utterance manifest has 28 N1 routing rows and 120 MIM/identity rows assigned to S-07. No unclassified group remains. | **VERIFIED** |

## Complete replay results

### Pinned original HTTP corpus

Command:

```text
node packages/nlu/tools/replayPinnedCorpusHttp.mjs --original /home/shell/work/phoenix/.parity/reviews/full-original-parser.json
```

- Capture revision: `5c0a7390539663ba749d360de348a428c088505c`
- Reference SHA-256: `8bb0695da62dd5685149b0ffdfca440e023a5ec3c7cebe076f92b0bbf170c292`
- Capture SHA-256: `ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d`
- Result SHA-256: `3a2727be421a5e527ed68dcb4ebc479077c8b45fcf2438a26128d16a6be6a291`
- Cases: 20,528
- Direct `parseRequest`: 20,479 matches, 49 differences
- Live HTTP replay: 249 selected controls, 200 matches, the same 49 differences
- Direct and HTTP difference ID sets are identical.
- Difference IDs and grouped signatures are byte-for-byte unchanged from
  `docs/parity/evidence/2026-09-11/n08-pinned-corpus/pinned-corpus-before.json`.

The 49 differences are the accepted N1 families: 47 native optimized-graph
first-path ordering rows and two native heuristic versus AST cost rows. The
approved compiled profile remains 20,528/20,528 exact. The user decision from
2026-09-08 keeps AST as the default and accepts these explained residuals.

### Manifest skill/memo corpus

Command:

```text
node packages/harness/src/corpusRunner.js
```

- Manifest SHA-256: `ea70a399299e0d5cc3c654268b407a5bdc61cfa0602ce3f8d8db34dc8a177ccd`
- Result SHA-256: `6a56162fce4fdf70a2cef72f592dd00eb9883c0d36ee987da91711d6239eedb3`
- Entries: 4,705
- Utterances: 10,035
- D3 intent: 10,007/10,035
- D4 MIM: 9,887/10,035
- Rows with any miss: 148

The previous result had 160 missed rows, D3 9,993 and D4 9,875. The new profile
repairs all 14 routing differences. Twelve rows disappear from the missed set.
`who is elroy` and `who's elroy` now have the correct `whoIsPerson` intent but
remain MIM misses because this context-free corpus cannot synthesize the
loop-member entities needed for `USR_WhoIsLoopMember`; they move into S-07.
That is why the missed-row count falls by 12 rather than 14.

All 148 remaining rows are classified:

- 28 routing rows are the manifest copies of accepted N1 F2/F3 behavior.
- 120 rows have the correct intent and differ only in MIM/identity selection;
  these are S-07 scope, including class-specific and loop-member decisions.

## Focused and integrated verification

`node --test packages/nlu/test/n08GqaContinuity.test.js` passes all five named
tests. Root temporarily changed the opt-in guard from `=== true` to `!== false`;
the two default-profile controls failed, proving the test detects an accidental
default rewrite. Restoring the exact guard returned the suite to green.

The integrated root run at `06dbfc5` completed:

```text
npm test
1,965 passed · 0 failed · 9 skipped
parity:check: 61/79 before this closure decision
parity:gate: 43 cases · 0 differences · 0 invariants · 0 coverage gaps
```

## Scope boundaries

- N1 continues to record the deliberately accepted 49-row default-AST gap.
- S-07 owns loop-member/class-specific MIM choice and the 120 remaining
  manifest MIM rows; N-08 no longer blocks that work.
- B6 remains an explicit selectable Phoenix continuity profile.
- No deployment or robot behavior changed in this review.
