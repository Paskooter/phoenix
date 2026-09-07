> Historical candidate report. The final bounded implementation is accepted in the [root native-operator review](N-08-native-operators-root-20260907.md); earlier failed runs and qualifications remain retained.

# N-08 explicit heuristic-per-character candidate

Status: candidate unverified; pending root review.

This follow-up repairs the default AST grammar's interpretation of `<N>`. The
Phoenix parser previously folded `<N>` into a one-time node cost. The pinned
native grammar parses `<N>` as `HEURISTIC_PER_CHAR_ELTYPE`, while `~N` is the
separate fixed `WEIGHT_ELTYPE` (`compiler/compiler.ypp:153-154,206-209`). The
matcher now keeps the marker as an epsilon AST item and carries its value over
literal/class bytes, groups, and inlined rule references until a later marker
changes it. Each matched word includes its native trailing `SPACE_WS` byte in
that explicit cost. `~N` remains a fixed cost.

The source implementation is pinned at
`/home/shell/work/phoenix/.parity/consumers/git/ConvTech/jibo-nlu/91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`:

- `compiler/rule_cmp.cpp:153-169` attaches the current heuristic to every
  word/character arc.
- `compiler/rule_cmp.cpp:197-209` emits a one-time epsilon weight for
  `WEIGHT_ELTYPE`.
- `compiler/rule_cmp.cpp:327-330` updates the persistent per-character value.
- `compiler/compiler.cpp:167-190` builds the base `$w` from one-or-more
  nonblank characters followed by one `SPACE_WS` arc; it has no generated
  reset marker. `compiler/compiler.cpp:193-218,227-292` builds `$*` and
  bounded wildcard factories; those generated wrappers put `<1.0>` and
  `<0.0>` around their repeated `$w`. Their reset occurs after the whole
  repeated body, including each appended separator.
- `compiler/fst_cmp.h:85-96` feeds the flattened rule/reference stream through
  one `rule_cmp`, which is why the state crosses an inlined reference and
  alternative boundary.

## Focused source controls

The private receipt is
`.parity/reviews/n08-explicit-weight-20260906/comparison.json`; the native
inputs, outputs, logs, AST results, and runners are beside it. The 24-case
matrix used the archived `grm2fst`/`parse` binaries from
`.parity/reviews/n08-native-scoring-execution-20260906/input/build`:

- 23 cases compiled and parsed successfully; the only rejected case was the
  intentionally invalid negative marker `<-1.0>`. One successful parse,
  `word-wildcard-only`, correctly emitted no result for two input words,
  proving the base `$w` cardinality separately from the legacy unresolved-ref
  fallback.
- The explicit one-word, two-word, grouped, referenced, carried-state, and
  reset cases all agree on the native accumulated arc heuristic: 12/12
  explicit/fixed controls match the candidate costs (`6`, `11`, `6`, and `2`
  in the selected cases).
- Native reset controls show `<1.0>alpha<0.0> beta` costs only the first word
  and separator, while `<1.0>alpha beta` costs both words.
- A generated wildcard overrides an enclosing marker and resets after its full
  body. For example, native `<2.0>$* alpha` still gives the wildcard's own
  `<1.0>` body and leaves `alpha` at zero; the matcher now returns heuristic
  state zero after every generated `$*`/`$wNN` factory.
- The base `$w` factory behaves differently: native `<2.0>$w beta` carries
  the enclosing state through `beta` (cost `18` for `one beta`), while
  `<2.0>$w<0.0> beta` resets before `beta` (cost `8`). The matcher now keeps
  `$w` to one word and applies the explicit per-character state, including
  its separator, without adding an invented reset. The fractional control
  is mathematically `1.6`; the archived FST/parse output reports
  approximately `1.60059`, an observed native floating-point quantization
  boundary that is retained as a limitation rather than copied into the AST
  arithmetic without a broader source control.
- A marker in an earlier alternative or referenced rule remains active for
  later source arms until reset. The native `alt-state-leak` and
  `ref-state-leak` controls both charge the later `beta` word 5; the candidate
  now pre-lowers each static reference occurrence in compiler traversal order
  and reproduces that state. This is why the implementation does not treat
  heuristic state as a runtime path-local property.
- The native winner agrees with the candidate in all 23 valid cases, counting
  the shared no-result cardinality control. The
  candidate's established wildcard adapter still counts wildcard word bytes
  without separators, so its numeric wildcard costs are three or four bytes
  lower than native in the four generated-wildcard rows. Those rows are
  recorded, rather than presented as byte-equal score parity; their selected
  intents agree. Seventeen emitted explicit/fixed rows have equal candidate
  cost and native accumulated arc heuristic; the remaining fractional row is
  the documented native quantization case.

Native execution was direct host execution of the archived binaries with
`LD_LIBRARY_PATH`, not execution inside the pinned Node 8 Docker image. The
source pin, Pegasus source pin, binary hashes, host identity, commands, and
exit results are recorded in `native-host-results.json`. No raw corpus or
robot data was used.

## Validation

The worktree was provisioned with `npm ci --ignore-scripts --offline`. Its
workspace links resolve to the candidate worktree, not the shared main
checkout. The focused test file is
`packages/nlu/test/grammarExplicitWeight.test.js`.

- `node --test packages/nlu/test/grammarExplicitWeight.test.js`: 10 passed.
- `node --test packages/nlu/test/*.test.js`: 72 passed, 3 skipped, 0 failed
  (the total includes the ten focused tests).
- `npm run test:unit`: 511 passed, 1 pre-existing failure in
  `packages/gateway/test/listen.e2e.test.js` (the frozen predecessor has the
  same missing `SKILL_ACTION` result), and 3 skipped. This follow-up does not
  change gateway code.
- No successful 20,528-row follow-up replay exists; the predecessor timeout is
  recorded above. Compiled-FST code, fixtures, goldens, main, robots, and the
  compiled profile were not changed.

Remaining limits are the established AST matcher’s token-level wildcard score
adapter and its independent arbitration approximation; this candidate does
not alter tie policy or claim full N-08 parity.

## Follow-up: base `$w` cardinality and replay diagnosis

This follow-up adds the source-required cardinality boundary for the reserved
base `$w` reference. The native compiler builds `$w` from a nonblank body and a
mandatory trailing `SPACE_WS` arc (`compiler/compiler.cpp:167-190`); it cannot
take the zero-word fallback used by unresolved application-specific refs. The
matcher therefore preserves the old zero fallback for unknown names while
omitting it only for `node.name === 'w'`. The focused test also puts an empty
`$w` arm before a competing literal arm, proving that the false first-arm
result no longer shadows the literal.

The fresh private 32-case source control is recorded at
`.parity/reviews/n08-explicit-weight-followup-20260906/comparison.json`.
Archived `grm2fst`/`parse` executed 31 valid cases (one intentionally invalid
negative marker was rejected). The previous 1aeec012 implementation matched
27/31 native selected intents; this follow-up matches 31/31. The three
weighted/reset/default empty `$w` cases now emit no result, and the added
competing case selects the native `plain` arm. Native execution was direct
host execution with `LD_LIBRARY_PATH`, not a Node 8 Docker execution; source,
Pegasus, binary, case, and command hashes are in `native-results.json`.

The 1aeec012 full replay is retained as a terminal failed run, not parity
evidence, at
`.parity/reviews/n08-explicit-weight-20260906/full-replay-1aeec012/`. Its
unchanged runner reached `Reviewed 12000/20528`, was terminated by the
3600.172-second outer bound with return `-15`, and produced no `replay.json`.
The exact receipt is `execution.json`; the candidate, runner, corpus, and
frozen-report hashes are in `preflight.json`.

That timeout exposed sustained default-AST throughput rather than a hang. A
bounded 81-row HTTP benchmark uses the immutable corpus hash
`ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d` and a
fixed selection of the first 20, evenly spaced middle rows, last 20, and 20
longest-text rows. Before the cache repair, 1aeec012 took 21,662.605 ms
(3.7392 rows/s; 33,082.394 ms user CPU). With the per-rule merged map cached
in `requestParser.js:163-169`, the follow-up took 11,949.590 ms (6.7785
rows/s; 12,748.991 ms user CPU); a repeat took 11,847.316 ms (6.8370
rows/s). All 81 requests completed, and each prior/follow-up pair had the
same status and decoded response data; each run independently matched 75/81
selected source rows, preserving the existing six residuals. The private
benchmark JSON files and runner are under the same review directory.

The cache removes per-request compiled-tree cloning and reduced sampled
garbage-collector CPU from 27.61% to 9.62% in the paired bounded profiles
(`cpu-profile-followup` and `cpu-profile-cached`). This is a measured bounded
improvement, not a claim that the full replay now completes. No follow-up
20,528-row replay was started after this diagnosis; the full-corpus behavior,
remaining 149 baseline differences, and generated-wildcard score limits stay
unverified.
