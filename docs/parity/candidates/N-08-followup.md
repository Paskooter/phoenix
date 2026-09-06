# N-08 follow-up: optional character-class atoms

Status: **general optional-atom fix accepted and integrated; full N-08 remains open**
Owner: Codex root, with Luna Max source review
Base: `4b45dae17bdf186de108b903ec7ca50b15d0944d`
Previous N-08 repair: `774dba170b5294ec85185d3e3186e349c8038811`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`

Root's [native compiler and source review](../evidence/2026-09-06/nlu-optional-atoms/review.json)
found that `?` makes the next Unicode code point or parenthesized group
optional inside `[]`. Thus `[me?et]` accepts `met` and `meet`, while `[ab?cd]`
accepts `abd` and `abcd`. The initial candidate used a duplicate-character
special case that did not implement that general rule.

Replacement candidate `63bbddd63bcf72cefa601a4f8929efc1cc196df5` uses one
code point per bare atom and retains group and escape handling. All 32 NLU
tests pass. Root's complete 20,528-request HTTP replay found 20,233 exact
status/data matches and 295 differences: 17 earlier failures fixed and no
newly failing IDs. All four non-200 cases and all 73 report cases match in
that scope. The three reviewed files are integrated into main, where the
standard 414-test unit suite passed. The earlier concurrent unit run's four
audio deadline failures and isolated 34-test repeat remain separate evidence.

Strict smoke remains a mismatch: 659 field differences, zero invariants and
one uncovered action. Full outer HTTP/routing/action parity and complete
N-08 remain open. [Root comparison](../evidence/2026-09-06/nlu-optional-atoms/full-http-review.json)
records fixed and remaining IDs, input/reference hashes and error coverage.

The focused request tests exercise `have you met alicia yet`, `have you met the
amazon echo`, and loop-member enrichment for `have you met george`. No rule
resource, factory inventory, normalizer, corpus, oracle, or harness file was
changed.

## Historical special-case differential evidence

The stored N-08 lead replay at
`.parity/reviews/full-parser-n08.json` contains 20,528 source-backed HTTP
parser cases: 20,216 status-and-decoded-data matches and 312 differences. All
73 report cases already match in that baseline. The complete original controls
and their request payloads are retained in
`.parity/reviews/full-original-parser.json`.

I then ran the preserved full replay tool against this candidate's HTTP
module, using all 20,528 original parser rows. The candidate produced 20,230
status-and-decoded-data matches and 298 differences. The group results were
boundary 20/21, chitchat 11,263/11,432, hub-client 8,874/9,002, and report
73/73. Every difference had status `200` on both sides; the comparison scope
was the HTTP status and decoded `response.data` only.

Comparing the candidate difference IDs with the N-08 baseline proves that all
20,216 previously matching rows remained matching, 14 baseline differences
were fixed, and no previously matching row became a new failure. The exact
fixed, newly failing, and remaining IDs are recorded in
[`full-replay-review.json`](../evidence/2026-09-06/nlu-n08-followup/full-replay-review.json).
The two remaining `darth vader`/`darth vadar` rows reach a separate top-level
arbitration/entity fallback gap after class expansion; this follow-up leaves
that broader ranking behavior unchanged.

## Validation

Under Node `v22.22.0`:

- `node --test packages/nlu/test/requestParser.test.js` — 8 passed;
- `node --test packages/nlu/test/*.test.js` — 24 passed;
- `node --check packages/nlu/src/grammar/matcher.js` — passed;
- full replay of all 20,528 stored original rows — 20,230 matches, 298
  differences, zero newly failing IDs.

Those counts describe the historical special-case replay. Its separate full
production capture had 20,229 exact parser matches, 298 semantic mismatches
and one observation timeout; it remains a failed full run. Neither historical
run supplies the replacement candidate's score. N-08 stays open for complete
arbitration, entities/factories, loop handling, grammar and production parity.
