> Historical candidate report. The bounded change is now accepted after the [root full replay and integration review](N-08-arbitration-root-20260907.md). The original submission and its limitations below are retained.

# N-08 cross-skill arbitration and factory correction

Status: candidate unverified; pending root review.

This candidate is based on `e26b0725af94d2e3d40d39f3c06925abe79b29b1` in
`/home/shell/work/phoenix/.parity/worktrees/n08-arbitration-20260907`. It addresses
the two known `this is my mom` residuals without adding a phrase or corpus case
exception.

## Source finding

The archived native controls show both relevant skill graphs accepting the text
with `heuristic_score: 8`. The chitchat graph emits `requestMeetPerson`,
`FamilyMember=SomeFamilyMember`, and `GivenName=*`; the introductions graph emits
`enrollment`. The source union keeps the earlier response on an exact score tie.
The raw per-skill receipt is:

`/home/shell/work/phoenix/.parity/reviews/n08-explicit-weight-repair-20260907/native-mom-control/result.json`

The Phoenix AST path had an additional language mismatch before arbitration: its
finite `first_name` list accepted `my`, so the introductions grammar consumed the
word as `GivenName=my` and gained one bounded matcher point. The pinned native
`first_name.fst` rejects `my`. I removed that unsupported list member and updated
the checked inventory hash. Every remaining 6,007 candidate entry was then parsed
against the pinned native factory and accepted (6,007/6,007, zero rejected):

`/home/shell/work/phoenix/.parity/reviews/n08-arbitration-20260907/first-name-corrected-validation.json`

The preceding 6,008-entry validation, which records the rejected `my` member,
remains preserved at:

`/home/shell/work/phoenix/.parity/reviews/n08-arbitration-20260907/first-name-validation.json`

The direct candidate control now selects the native chitchat result for the
residual and retains introductions results for valid names such as Sally, Bob,
Henry, and Jane. The complete bounded output is in:

`/home/shell/work/phoenix/.parity/reviews/n08-arbitration-20260907/candidate-mom-control.json`

## Arbitration implementation

The pinned Pegasus implementation is `RobustParserClient.getBestResult` in
source revision `5c0a7390539663ba749d360de348a428c088505c`, lines 260–285 of
`packages/parser/src/robustparser/RobustParserClient.ts`:

* compare numeric `heuristic_score` values from `-Infinity`, so zero and negative
  scores are valid;
* clear the top set only on a strictly larger score;
* retain response/result order for exact ties; and
* remove `launch` and `globals/*` only from a tie that also contains a non-loser.

The source does not inspect the `priority` field in this function. The candidate
extracts this behavior into `packages/nlu/src/arbitration.js` and uses it for
both AST and compiled request arbitration. It does not rescale AST scores or
apply priority labels inside this helper. The source rule registry and launch
union order remain the ordering inputs; no graph or compiled-profile files were
changed.

The exact Node 8 source matrix contains 13 cases covering unequal scores,
priority-label decoys, forward and reversed ties, designated losers, multiple
results, zero, negative, empty, and no-result inputs. Candidate and original
outputs have zero normalized differences:

`/home/shell/work/phoenix/.parity/reviews/n08-arbitration-20260907/arbitration-comparison-current.json`

The source runner used the extracted Node `v8.9.4` binary
(`03841801a7957b0eb5e2dbb1257eeda9d3edd18291d18d03bd57515c83107c5d`) against the
compiled source module SHA
`fa07847affa4c688509e21b674d9b3965f81d72b96d218bef78e454a2d48fec0`. The native
factory controls used the archived host `parse` binary SHA
`373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b` with
`LD_LIBRARY_PATH`; that is direct host execution, not a Node 8 Docker execution.
The native factory FST SHA is
`3fb01bdf8c39aa4bbf1d7eaa2e74da880faeb30b714db506fd62b4eb624b2056`.

## Validation

The isolated worktree ran `npm ci --ignore-scripts --offline`. Its
`@phoenix/nlu`, `@phoenix/common`, `@phoenix/contracts`, and `@phoenix/gateway`
resolutions all resolve into this worktree; the receipt is:

`/home/shell/work/phoenix/.parity/reviews/n08-arbitration-20260907/workspace-resolution.json`

The complete NLU test glob passed 86 tests with three configured skips and no
failures:

```text
node --test packages/nlu/test/*.test.js
1..89
# tests 89
# pass 86
# fail 0
# skipped 3
```

The focused arbitration test covers source score/order/loser behavior, factory
membership, the known residual, and valid introductions. `git diff --check`
passes.

## Limits

This is a bounded AST/factory correction. The AST `parseScore` remains Phoenix's
source-informed proxy; it does not claim to reproduce every native byte
heuristic or every cross-grammar score. The native per-skill tie and the direct
candidate regression are source-backed, but no new 20,528-request replay was
run in this worktree. Root's replay of the frozen predecessor and any integrated
acceptance remain required. The prior broader default-AST residuals and any
provider or compiled-profile differences remain open.
