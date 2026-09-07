# N-08 default-AST character-class equivalence follow-up

Status: **candidate unverified; pending root review**

This bounded candidate is based on
`3108820f1c50b57d9d0b9734723d0d8e1caac2ba` in the isolated worktree
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907`.
The implementation commit is
`626e03617aa406ef588df38ff1ebe1a8e8fb4305`. It changes only
`packages/nlu/src/grammar/matcher.js` and its focused test.

## Source-backed behavior

The pinned native compiler distinguishes an ordinary word from a bare word
inside a character rule:

- `compiler/compiler.ypp:135-140` calls `new_word_and_equivalents` for an
  ordinary `wrd`;
- `compiler/compiler.ypp:209-215` calls `new_word_and_equivalents` only for
  parenthesized character words and calls `new_word` for a bare character-rule
  word.

The compiler source is
`/home/shell/work/phoenix/.parity/consumers/git/ConvTech/jibo-nlu/91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`,
with `compiler.ypp` SHA-256
`6732bf04ed15183663f7458180554aea82dfac5cc4ce2e4b64f8a031d5d95323`.
The pinned launch source contains the relevant bare class
`[georgia?(s|(es)|(\\'s))]` at line 5783; its SHA-256 is
`e6bab3053a0793c60da8ed19c47d0f53c4d30e3164020082c626d4c32c54049f`.

Before this change, the AST matcher applied the global
`use_equivalent_words` map to every character class. Thus the
`[georgia...]` country path treated input `george` as `georgia`, beating
the first-name path. The patch keeps `eqEquals` for ordinary literal nodes
and requires the expanded spelling of a bare character class to match exactly.
It contains no phrase, intent, rule-pair, or corpus-ID exception.

The archived native control compiles two synthetic grammars with
`!use_equivalent_words = true`. A bare `[georgia]` rejects `george` and
accepts `georgia`; ordinary `(georgia)` accepts both. The rerun receipt is
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907/.parity/reviews/n08-class-equivalence-20260907/native-rerun-final/receipt.json`.
It records `grm2fst` SHA
`ed5c9868c772b8fcb370e995cc0617906562fd192809b9590e0f313699e87ba3`,
`parse` SHA
`373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`, and
zero compile/parse failures. These are archived host binaries run with
`LD_LIBRARY_PATH`, not a Node 8 Docker execution.

The pinned launch FST is
`/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_fst/launch.fst`,
SHA-256
`2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`.
The direct native launch control for `do you like george` and
`i am frightened of george` emits `GivenName=george` for both; its
exit-0 receipt is
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907/.parity/reviews/n08-class-equivalence-20260907/native-launch-rerun-final/receipt.json`.
The candidate request-scoped control includes the source loop enrichment and
matches all five stored George rows:

`candidate-class-residuals.json`:
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907/.parity/reviews/n08-class-equivalence-20260907/candidate-class-residuals.json`.

## Bounded regression evidence

The selected input is the preserved 209-row union from the earlier N-08
regression review, SHA-256
`d5aba7e1e9d1f1339f75441d01910f8502dbae98ac65446c06690706307194ba`.
The prior e396 benchmark is unchanged, SHA-256
`ce04d155d5e66b03ac6b0ccda1c821a1c11130a5951760fefd5b857a7e695605`.
The candidate benchmark ran the unchanged subset runner under Node
`v22.22.0`, with a 15,000 ms request deadline, and exited 0:

- prior e396: 152/209 exact, 57 differences;
- candidate: 157/209 exact, 52 differences;
- repaired: 5 stored IDs;
- newly failing: 0 IDs;
- HTTP status changes: 0;
- response-data changes: the same five repaired IDs only.

The immutable reconciliation is
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907/.parity/reviews/n08-class-equivalence-20260907/benchmark-reconciliation.json`.
The candidate benchmark itself is
`benchmark-pure-exact.json` in that directory. This is a selected
regression, not a new full-corpus result.

## Validation

The worktree was provisioned with `npm ci --ignore-scripts --offline`
(exit 0). All 11 `@phoenix/*` workspace links resolve into this worktree;
the receipt is
`/home/shell/work/phoenix/.parity/worktrees/n08-ast-followup-20260907/.parity/reviews/n08-class-equivalence-20260907/workspace-resolution.json`.

The following commands passed:

```text
node --test packages/nlu/test/charClass.test.js packages/nlu/test/eqwords.test.js
# 12 tests, 12 passed, 0 failed

node --test packages/nlu/test/*.test.js
# 92 tests, 89 passed, 3 skipped, 0 failed

git diff --check
# passed
```

## Limits

This patch covers the pinned native **bare** character-rule word boundary.
The source also gives a parenthesized word inside `[]` the equivalent-word
constructor. The candidate's existing character-class expansion does not yet
model that separate production; the retained native parenthesized control
(`[(time)]` accepts `thyme`) is explicit evidence of that remaining gap.
No claim is made for that form.

The candidate does not change compiled-FST execution, portable snapshot data,
the harness, source/golden inputs, cross-skill arbitration, or other AST
scoring. The full default-AST replay remains unrun for this candidate. The
remaining e396 residual families, including plans/holiday arbitration and the
other 52 rows in this selected set, remain open. Root acceptance and any full
20,528-row replay are still required.
