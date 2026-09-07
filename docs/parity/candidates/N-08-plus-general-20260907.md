# N-08 general PLUS boundary follow-up

Status: candidate unverified; pending root review and the full 20,528-row gate.

This follow-up starts from the frozen predecessor `f13fd5c` in a separate
worktree. It implements the source-recursive unary forms that the predecessor
parser rejected and the native nullable-operand behavior that its matcher
discarded:

- `+?a`, `?(+a)`, `+(?a)`, and `++a` now parse as nested AST operators.
- A `PLUS_KLEENE` operand that can match epsilon contributes one empty
  repetition. The matcher never recurses through that same-position result,
  so `+?a` and `+$*` terminate while still matching source-valid empty input.
- Optional and repeated group tags run on their native epsilon/positive paths;
  operand tags remain scoped to the operand. Grouped multiword operands retain
  adjacent suffixes and postfix costs.

The pinned native grammar is recursive for `?`, `*`, and `+`
(`compiler/compiler.ypp:119-127` and `196-203`). The native compiler's
`PLUS_KLEENE` graph edge is implemented in `compiler/rule_cmp.cpp:253-273`.
The source controls show that a nullable operand is accepted once at epsilon,
then only advancing repetitions may continue.

## Source controls

The private source-control receipt is
`/home/shell/work/phoenix/.parity/reviews/n08-plus-general-20260907/native-controls/result.json`.
It uses archived `grm2fst` and `parse` binaries from source
`91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`, with Pegasus source pin
`5c0a7390539663ba749d360de348a428c088505c`. Binary hashes are recorded in
the receipt. Execution is direct host execution with `LD_LIBRARY_PATH`, not
the pinned Node 8 Docker image.

The 28 synthetic controls cover nullable operands, nested operators, `$*` and
`$w`, empty-input tags, nested tag scope, grouped multiword operands, postfix
costs, competing cost paths, and adjacent suffixes. Twenty-five compile-and-parse controls are
source-runtime-valid; candidate semantic outputs and all `NLParse` tag maps
match 25/25. The comparison receipt is
`/home/shell/work/phoenix/.parity/reviews/n08-plus-general-20260907/comparison.json`.
Three controls remain explicit source boundaries rather than claimed parity:
the native parser reports an epsilon-cycle error for a tagged `$*` operand, and
the two `this._parsed` action controls fail in the archived native action
runtime with its `_parsed` context error. The candidate does not turn those
source-invalid/runtime-failing forms into a production compatibility claim.

The focused regression cluster remains at 68 rows. The candidate has two
mismatches, both the previously known `this is my mom` cross-skill arbitration
rows; the 60 newly failing rows and the other six changed shared rows remain
repaired. Receipt:
`/home/shell/work/phoenix/.parity/reviews/n08-plus-general-20260907/subset-68-final.json`.
No arbitration change or phrase-specific exception was added.

## Validation and limits

The candidate worktree was provisioned with `npm ci --ignore-scripts --offline`;
all `@phoenix/*` links resolve inside this worktree. The focused test command
passes 26/26:

```text
node --test packages/nlu/test/grammarPlus.test.js \
  packages/nlu/test/grammarPlusGeneral.test.js \
  packages/nlu/test/grammarExplicitWeight.test.js \
  packages/nlu/test/charClass.test.js
```

The full NLU test glob passes 80/83 with three configured skips. Logs and
hashes are retained under the private follow-up review directory. The full
20,528-row HTTP replay was not run. Score numbers are not asserted as equal in
the native control comparison because the candidate matcher exposes its own
specificity/cost score while the native receipt reports byte heuristic scores.

The stale predecessor wording is preserved and corrected separately in
`/home/shell/work/phoenix/.parity/reviews/n08-plus-general-20260907/correction-receipt.json`:
the predecessor is committed at `f13fd5c`, and six of eight changed shared
rows were repaired while two remain open.
