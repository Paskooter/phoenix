# N-08 default-AST parenthesized character-class equivalence

Status: **candidate unverified; pending root review**

This follow-up starts from frozen candidate
`aac6d562d8ba3f263a5c14ae6c3fafaad5ddb7dc` in the new isolated worktree
`/home/shell/work/phoenix/.parity/worktrees/n08-parenthesized-class-20260907`.
The implementation commit is
`e22150f422a726ea6f5b1d22d11fd6cf6f3d5552`. It changes only the AST matcher
and the character-class test.

## Source and representation

The pinned native grammar has two relevant productions in
`compiler/compiler.ypp`:

- lines 209-212 use `new_word_and_equivalents` for `(wrd)` but
  `new_word` for bare `wrd` inside `[]`;
- lines 196-203 make those atoms compose through class concatenation,
  alternation, optionality, and grouping.

The source is
`/home/shell/work/phoenix/.parity/consumers/git/ConvTech/jibo-nlu/91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`;
`compiler.ypp` SHA-256 is
`6732bf04ed15183663f7458180554aea82dfac5cc4ce2e4b64f8a031d5d95323`.
The candidate parser already retains the raw character-class body in its
`class` AST node. The matcher now recognizes only an operator-free,
single-word parenthesized atom in that body, decodes escaped characters, and
expands that atom through the local equivalence map. Bare atoms and generic
groups remain exact. Concatenation and optional suffixes consume the resulting
concrete spellings. Equivalence is never applied to the whole class.

## Native controls

Eight synthetic grammars cover standalone, bare-versus-parenthesized,
postfixed and optional suffixes, escaped words, mixed surrounding characters,
generic grouped alternatives, and a mixed parenthesized/alternative form.
All 16 compile/parse invocations exited 0. The source control receipt is:

`/home/shell/work/phoenix/.parity/worktrees/n08-parenthesized-class-20260907/.parity/reviews/n08-parenthesized-class-20260907/native-controls/receipt.json`

The archived native binaries are `grm2fst` SHA
`ed5c9868c772b8fcb370e995cc0617906562fd192809b9590e0f313699e87ba3` and
`parse` SHA
`373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`.
They ran directly on the host with `LD_LIBRARY_PATH`, not in the pinned Node 8
Docker image. The equivalent-word data used by the candidate has SHA-256
`df1c0b74afa2cf72bd0f7afc3d4a88d7bbe7fa089c216e860a47b75c02fdd62a`.

The candidate agrees with native acceptance on 19/21 control rows. The two
remaining rows are the same apostrophe-normalization boundary: candidate
tokenization removes apostrophes, so source-rejected `were` can match a
parenthesized `weir`/`we're` expansion. This behavior predates this
follow-up and cannot be isolated to parenthesized classes without changing the
global tokenizer. The complete candidate/native acceptance receipt is:

`/home/shell/work/phoenix/.parity/worktrees/n08-parenthesized-class-20260907/.parity/reviews/n08-parenthesized-class-20260907/candidate-native-differential.json`

The focused candidate controls pass 7/7, including bare `time` rejecting
`thyme`, parenthesized `(time)` accepting `thyme`, `(time)s` accepting
`thymes`, `(time)?s`, `a(time)b`, and a generic `t(i|y)me` group
rejecting `thyme`.

## Regression evidence

The unchanged 209-row subset uses input SHA-256
`d5aba7e1e9d1f1339f75441d01910f8502dbae98ac65446c06690706307194ba` and the
unchanged e396 benchmark SHA-256
`ce04d155d5e66b03ac6b0ccda1c821a1c11130a5951760fefd5b857a7e695605`.
The candidate ran the unchanged subset runner under Node `v22.22.0`, with
15,000 ms per-request deadlines, and exited 0:

- e396: 152/209 exact, 57 differences;
- candidate: 157/209 exact, 52 differences;
- repaired: 5 stored rows from the prior bare-class candidate;
- new failures: 0;
- status changes: 0;
- response-data changes versus the prior bare-class candidate: 0.

The final reconciliation is
`/home/shell/work/phoenix/.parity/worktrees/n08-parenthesized-class-20260907/.parity/reviews/n08-parenthesized-class-20260907/benchmark-reconciliation-final.json`.
The candidate output is byte-identical to the prior `aac6d56` candidate on
all 209 selected rows; this follow-up's parenthesized forms are not exercised
by that stored subset.

## Validation and limits

The worktree was provisioned with `npm ci --ignore-scripts --offline` (exit
0). All 11 `@phoenix/*` links resolve inside this worktree; see
`workspace-resolution.json` in the private review directory.

Validation passed:

```text
node --test packages/nlu/test/charClass.test.js packages/nlu/test/eqwords.test.js
# 12 passed, 0 failed

node --test packages/nlu/test/*.test.js
# 92 tests, 89 passed, 3 skipped, 0 failed

git diff --check
# passed
```

This candidate does not change the compiled profile, portable snapshots,
harness, resources, corpus, tokenizer, arbitration, or other AST scoring. The
full 20,528-row replay remains unrun and N-08 remains open. The two known
apostrophe-normalization mismatches and the remaining 52 rows in the bounded
set are explicitly unresolved. Root acceptance is required.
