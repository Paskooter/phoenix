# N-08 follow-up: shared-boundary optional class variants

Status: **working candidate; unverified and awaiting lead review**
Owner: Luna Max
Base: `4b45dae17bdf186de108b903ec7ca50b15d0944d`
Previous N-08 repair: `774dba170b5294ec85185d3e3186e349c8038811`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`

This follow-up repairs one source grammar interpretation in
`packages/nlu/src/grammar/matcher.js`. A simple source character class such as
`[me?et]` uses `?` for an optional suffix whose first character is already the
last character of the stem. The source FST therefore accepts `met` and `meet`.
The candidate previously emitted `me` and `meet`, which prevented the
`RULE_HasJiboMetPerson` arms from reaching the person matcher for the source
`have you met ...` controls. The matcher now handles this shared-boundary form
for simple unescaped word bodies, while grouped, alternated, and escaped class
bodies retain the existing recursive expansion.

The focused request tests exercise `have you met alicia yet`, `have you met the
amazon echo`, and loop-member enrichment for `have you met george`. No rule
resource, factory inventory, normalizer, corpus, oracle, or harness file was
changed.

## Differential evidence

The stored N-08 lead replay at
`.parity/reviews/full-parser-n08.json` contains 20,528 source-backed HTTP
parser cases: 20,216 status-and-decoded-data matches and 312 differences. All
73 report cases already match in that baseline. The complete original controls
and their request payloads are retained in
`.parity/reviews/full-original-parser.json`.

I replayed each of the 312 baseline difference requests from the preserved
original rows through this worktree's `parseRequest`. Fourteen rows now equal
the original response, all in the shared-boundary `met` controls; 298 rows
remain different. The selected replay is only a prior-difference check and
does not establish that the 20,216 previously matching rows stayed unchanged.
The two remaining `darth vader`/`darth vadar` rows reach a separate
top-level arbitration/entity fallback gap after class expansion; this
follow-up leaves that broader ranking behavior unchanged.

## Validation

Under Node `v22.22.0`:

- `node --test packages/nlu/test/requestParser.test.js` — 8 passed;
- `node --test packages/nlu/test/*.test.js` — 24 passed;
- `node --check packages/nlu/src/grammar/matcher.js` — passed;
- selected replay of all 312 stored differences — 14 fixed, 298 remaining.

This remains an unverified N-08 candidate. Root should rerun the full
20,528-case replay after integration and review the remaining arbitration,
entity/factory, loop-member, and other grammar differences before acceptance.
