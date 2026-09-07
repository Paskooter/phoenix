# N-08 default-AST public apostrophe boundary

Status: **candidate unverified; pending root review**

This bounded follow-up starts at frozen deployment candidate
`f68f88a614c069d6f32ee225c59146037408adbf` in
`/home/shell/work/phoenix/.parity/worktrees/n08-apostrophe-boundary-20260907`.
It changes only the default-AST matcher and adds one focused regression test.
The candidate preserves apostrophe bytes in input tokens and rule literals;
the existing punctuation normalization remains unchanged.

## Source question and answer

The two apostrophe rows are reachable through the original public parser
input path. They are not only a raw CLI-versus-HTTP oracle distinction.

The pinned Pegasus `ParseRequestHandler.ts` trims `data.text` at lines 41–47
and rejects only non-string/missing bodies at lines 28–30. The pinned
`RobustParserClient.ts` lowercases the request at lines 66–67 and sends that
text unchanged as `REQ_CONTENT.TXT_STRING` at lines 202–210. The original
native service accepts that string at `nlu_request_executor.cc` lines 241–266
and passes it directly to `parse_sentence`. Its `parser.cpp` input loop at
lines 154–167 splits on whitespace and appends a separator while preserving
each byte inside the token, including ASCII and UTF-8 apostrophes.

The exact source-preparation control therefore observed these transformations
under Node 8:

| input | public handler forwards | direct client forwards |
| --- | --- | --- |
| `  We're  ` | `we're` | `  we're  ` |
| `were` | `were` | `were` |
| `we're` | `we're` | `we're` |
| `weir` | `weir` | `weir` |
| `  WERE  ` | `were` | `  were  ` |
| `  we’re  ` | `we’re` | `  we’re  ` |

This executes the unchanged original handler and client source. The Axios
and framework seams are small recording stubs, so it is source-boundary
evidence rather than a full original Hapi/TCP parser run. The native service
source independently confirms that no apostrophe removal occurs after the
request reaches the parser.

The source grammar also treats apostrophe as a special character in
`compiler.l` lines 15–16 and 37–40. The escaped native control grammar is:

```text
!use_equivalent_words = true;
TopRule = ([(we?(\'re))]) {% intent='escaped' %};
```

Its archived native parser rejects `were` and accepts `we're` with heuristic
score 6. The former matcher removed apostrophes from both sides, turning the
native-rejected `were` into a false positive. The candidate removes those two
apostrophe-removal operations, so it now rejects `were` and accepts `we're`.

## Focused evidence

The exact native control was rerun with the archived `grm2fst`/`parse`
binaries. Both commands exited 0; the native output is byte-identical to the
stored control (`6ea022578b1e71b166fa039cb42cafcda144c9927995a50119fd56a8198b2942`).
The candidate/native selected-result control changed from 1/2 before the
matcher change to 2/2 after it:

```text
native:    were rejected, we're accepted
candidate before: were accepted, we're accepted       1/2
candidate after:  were rejected, we're accepted       2/2
```

The source-shaped grammar is exercised by
`packages/nlu/test/apostropheBoundary.test.js`, which also checks ASCII,
Unicode, and unpunctuated tokenization. The separate parenthesized-equivalent
control (`escaped-simple`) remains outside this change: its equivalence
behavior is preserved in the frozen parenthesized-class candidate.

## Regression checks

The bounded 209-row union of the previously known N-08 difference IDs was run
before and after the change with the unchanged HTTP subset driver and source
input. Both runs exited 0, returned HTTP 200 for all 209 rows, and matched
152/209 complete expected response data. The before/after response status,
data hash, and error records are identical for all 209 rows; no new failure or
changed residual was introduced. The run receipts are:

- `candidate-before-209.json` — 44,705.242 ms;
- `candidate-after-209.json` — 39,662.207 ms.

The full NLU test suite passes 95 tests with 5 configured skips and 0
failures. The existing character-class/equivalent-word focused suite passes
11/11, and the new apostrophe test passes 2/2. `git diff --check` passes.

## Reproduction and provenance

Private, ignored receipts are in
`/home/shell/work/phoenix/.parity/reviews/n08-apostrophe-public-boundary-20260907/`.
The aggregate receipt is `receipt.json`; source-preparation output is
`source-prep.json`; focused before/after outputs are
`candidate-before-controls.json` and `candidate-after-controls.json`.

The relevant pins are:

- Pegasus source revision `5c0a7390539663ba749d360de348a428c088505c`;
  `ParseRequestHandler.ts` SHA-256
  `dc577c81cf61ce0ecd19c74ada04f6a0fda2521a8834982aff0c2432730fe70e` and
  `RobustParserClient.ts` SHA-256
  `2c4b7c1544d82c4e42863cdacf06226fb31f5ba6745827bf165124e3a22b0906`.
- Native parser source revision
  `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`; `compiler.ypp` SHA-256
  `6732bf04ed15183663f7458180554aea82dfac5cc4ce2e4b64f8a031d5d95323` and
  `parser.cpp` SHA-256
  `6b86849e390473c77979d48f47f830b3dde86f1e7c89ed37077319a149c19b1f`.
- Native service revision
  `5d6755a5116694e2801438f358b862109cd16ba5`; request executor SHA-256
  `48b685e43d39045509b15b5c3743d431518c3f340b66fa89c6cdb386de58359f`.
- The source-preparation runtime is the extracted host Node `v8.9.4`, SHA-256
  `03841801a7957b0eb5e2dbb1257eeda9d3edd18291d18d03bd57515c83107c5d`.
  The candidate matcher controls and NLU tests ran under Node `v22.22.0`.
- The archived native binaries have `grm2fst` SHA-256
  `ed5c9868c772b8fcb370e995cc0617906562fd192809b9590e0f313699e87ba3` and
  `parse` SHA-256
  `373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`.
  They ran directly on the host with `LD_LIBRARY_PATH`, not inside the Node 8
  Docker image. This qualification also applies to the native output rerun.
- The 209-row input SHA-256 is
  `d5aba7e1e9d1f1339f75441d01910f8502dbae98ac65446c06690706307194ba`.
  The candidate-local workspace was provisioned with
  `npm ci --ignore-scripts --offline`; all `@phoenix/*` links resolve inside
  this worktree. See `workspace-resolution.json`.

The exact source-preparation command is:

```sh
/home/shell/work/phoenix/.parity/reviews/n08-original-multirule-20260906/perf-diagnosis/node-v8.9.4-extracted \
  .parity/reviews/n08-apostrophe-public-boundary-20260907/run-source-prep.cjs \
  > .parity/reviews/n08-apostrophe-public-boundary-20260907/source-prep.json
```

The native rerun and candidate-control commands, hashes, exits, and local
workspace paths are recorded in `receipt.json`. No source, golden, compiled
snapshot, default-profile, robot, or shared-cache files were changed. The full
20,528/20,534 corpus acceptance replay remains unrun here; root acceptance is
required. Other tokenizer differences and the separate parenthesized-class
equivalence gap remain outside this bounded candidate.
