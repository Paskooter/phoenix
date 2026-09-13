# S-07 weighted and conditional prompt review

This isolated lane exercises the weighted and conditional branches of every
Chitchat MIM in the pinned original package against Phoenix. It is a harness
and evidence change only; the candidate production tree at
`dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec` has no production diff for this
lane.

## Provenance and source contract

- Original source revision: `5c0a7390539663ba749d360de348a428c088505c` in
  `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`.
- Original runtime: Node `v8.9.4`, image
  `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
- Candidate production revision: `dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec`.
  The harness worktree is `w21/s07-weighted` at
  `/home/shell/work/phoenix-s07-weighted`; its branch identity is kept
  separate from the candidate revision recorded in every plan and candidate
  receipt.
- Jibo MCP search was used before reading the pinned archive. No web, Moth,
  deployment, hardware, ledger, or remote operation was used.

The source contract is visible in `packages/chitchat-skill/src/Chitchat.ts`:
`init()` discovers the three MIM directories and builds the semi-specific
mappings (44-54), `createGraph()` routes all response transitions through the
AN MIM graph (56-90), and the stem/category mappings preserve source list
membership and order (98-149). `ProcessQueryNode.ts` selects the scripted,
emotion, or fallback path and supplies `Dice` and `Coin` prompt data (41-110,
121-155). `FunAndGamesUtils.ts` consumes two `Math.random()` calls for Dice
and one for Coin (13-44).

The pinned compiled Slimmer evaluates conditions in a VM, defaults absent
weights with `prompt.weight || 1`, and calls the weighted sampler
(`node_modules/@jibo/baseskill/lib/graph/mims/utils/slimmer/Slimmer.js`,
104-121). The pinned `jibo-cai-utils` sampler computes the raw total, uses
`Math.random() * total`, and selects with strict `<`; an exact total returns
the empty object (1175-1201). The plan and comparator encode those details,
including exact-total controls and source VM randomness.

## Matrix and differential result

The compact result is [differential-summary.json](./differential-summary.json)
and hashes/sizes for all raw receipts are in
[raw-receipt-manifest.json](./raw-receipt-manifest.json). The complete run
used 24 bounded batches, retaining every context rather than deduplicating
profiles:

- 4,424 MIMs: 4,369 scripted, 54 emotion, and one fallback.
- 23,387 distinct contexts, including all 112 no-eligible contexts.
- 132,967 branch rows on each side: 54,790 interior selections, 54,790
  strict exact-lower selections (one lower row per eligible prompt, with no
  redundant duplicate), and 23,387 exact-total controls.
- Expected outer RNG calls: 23 rows with one call, 112 with three, and
  132,832 with four. Expected VM RNG calls: 132,943 rows with zero and 24
  rows with one.
- Source rows: 132,967; candidate rows: 132,967; source errors: zero;
  candidate errors: zero; observable row differences: zero.
- The source-derived wire envelope has 132,855 action rows and 112 no-action
  rows. It contains 4,516 emotion-event rows, 132,944 successful query events,
  and 23 fallback failures. Query analytics types are 124,289
  `scripted_response`, 1,478 `known_unknown`, 2,684 `loop_member_question`,
  and 4,516 `emotion_query`; the comparator derives the referent from the
  executable `weightedRuntimeFor(profile)` state and applies the pinned
  Analytics.ts precedence before comparing either receipt.
- The context and every plan carry source MIM tree digest
  `dfc7e6db41c072ef01f431736df5b00abd2f8cff469593fc51b0d1fb977f28ca`;
  aggregation requires each plan inventory to equal the context inventory.
- `vmRandomControlled` is true in all 24 source receipts and all 24 candidate
  receipts. Candidate revision is the pinned 40-hex production revision in
  all candidate receipts; no `working-tree` receipt is included in the final
  result.
- The full normalized result compares action, JCP, prompts, ESML, MIM,
  analytics, metadata, and observable RNG/call counts. Only the two
  source-generated action ID paths are normalized: `config.jcp.id` and
  `config.jcp.config.play.id`.

The condition audit contains 4,558 entries; every entry was observed and
4,549 had both true and false outcomes. The nine never-true entries are
exactly the source-defined cases: four literal-false cases, one blank
condition, two malformed date labels that throw in the original VM, the
distinct-wrapper identity case, and the object-vs-boolean comparison. The
eligibility receipt has zero top-level errors and zero
unclassified errors. The prompt inventory contains 11,883 source prompt IDs,
11,874 selected IDs, and exactly those nine classified never-true IDs are
unselected.

The profile self-test has eight passing checks. It proves that generated
`referent=male-age10`, `loop=one-referent`, `loop=one-referent-speaker`, and
`loop=present` values change or preserve the intended runtime state; checks
both Jibo colors; and rejects unknown profile keys and values. Repeated Jibo
axes are merged deliberately before the Cartesian product. The nonbirthday
profiles use a date that is not May 30, avoiding an accidental birthday at the
fixed VM date.

The weighted profile uses `emotion=undefined` for a present empty emotion
object. A null emotion is a distinct source state and is covered by the
accepted S-07 library/context receipt: its source-derived context generator
adds `emotion=missing` wherever the pinned MIM references `jibo.emotion` or
`emotion.valence` (`scripts/parity-s07/library-plan.mjs:116-139`, with the
runtime state at `library-context.cjs:99`), and its 24,148-row
source/candidate comparison passed with zero differences. The weighted lane
therefore does not equate `{}` with `null`; it adds the empty-object boundary
needed by the weighted condition matrix while reusing the prior exact
null-state proof.

Concrete `_SS_` MIM prompt weights are included when their source-resolved
memo reaches the weighted sampler. Semispecific memo/entity resolution,
category membership, and memo routing are owned by the S-07 routing and
library-context lanes; this weighted lane does not claim to close those
resolver behaviors.

## Falsification

[falsification-summary.json](./falsification-summary.json) records 25 named
mutations. All 25 passed: forged expected prompt, weight, outer RNG input, VM
call count, VM control flag, source/candidate runtimes and revision,
no-eligible oracle, eligibility revision, oracle context metadata, profile
value, paired row/context omissions, paired response-envelope omission,
paired final and fire-and-forget corruption, paired analytics omission and
value corruption, paired action/JCP type corruption, paired normalized-envelope
omission, paired RNG-vector corruption, forged MIM tree digest, and forged wire
action. All 25 mutated receipts caused the
fail-closed comparator to exit nonzero with a relevant failure code. The
paired context mutation is checked against the exact eligibility slice, so
range continuity alone cannot hide an omitted context.

[aggregate-falsification-summary.json](./aggregate-falsification-summary.json)
records two named checks: a forged source receipt was used with the old
passing differential and aggregation rejected it at `diff-input-bytes`; then
both source and candidate response envelopes were corrupted while all input
hashes were refreshed, and aggregation rejected the fresh comparator rerun.
The original raw receipts were verified unchanged.

The deterministic aggregator is
`scripts/parity-s07/aggregate-weighted.mjs`. It reads all 24 plan/source/
candidate/differential files, checks exact contiguous ranges and context
inventories, validates the pinned source/candidate revisions, Node runtimes,
VM-control flags, row counts, pass results, and audit stability, then emits
the compact summary and byte/SHA-256 manifest. It also reruns
`compare-weighted.mjs` for every batch and requires the recomputed differential
to equal the supplied receipt, so a stale or paired-forged passing diff cannot
be aggregated. Source and candidate receipts must carry the exact pinned MIM
inventory and tree digest.

The final aggregation command was:

```text
node scripts/parity-s07/aggregate-weighted.mjs --contexts /tmp/s07-weighted-contexts-v10.json --eligibility /tmp/s07-weighted-eligibility-v9.json --plan-template /tmp/s07-weighted-plan-v10-{offset}.json --source-template /tmp/s07-weighted-source-v12-{sourceOffset}.json --candidate-template /tmp/s07-weighted-candidate-v12-{offset}.json --diff-template /tmp/s07-weighted-diff-v12-{offset}.json --batch-count 24 --batch-size 1000 --source-root /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c --out-summary /tmp/s07-weighted-differential-v13.json --out-manifest /tmp/s07-weighted-manifest-v13.json --falsification /tmp/s07-weighted-falsify-v14.json --aggregate-falsification /tmp/s07-weighted-aggregate-falsify-v13.json
```

It returned `pass`, 24 batches, 23,387 contexts, and 132,967 rows on each
side. The comparator was rerun for every offset (`0, 1000, ... 23000`) after
the runtime checks were added; all 24 returned `pass`.

## Validation

The weighted source/candidate batches and comparator all passed with the
receipt result above. The focused skill suite passed 29/29:

```text
node --test packages/skills/test/mimGraph.test.js packages/skills/test/slimmer.test.js packages/skills/test/intentResponses.test.js packages/skills/test/s04MimFactories.test.js
pass 29, fail 0, skipped 0
```

`npm run parity:check` passed (64/79 checklist items verified, 3/3
management, 4/4 verification, 39/46 Pegasus, 18/20 Classic). `npm run
parity:gate` passed the strict 43-case production smoke with zero differences,
invariant failures, or coverage gaps.

The final full `npm test` run passed 1,981 tests with zero failures and 9
skips out of 1,990, including the focused and parity checks invoked by the
package script. Full-suite log: `/tmp/s07-weighted-npm-test-v13.log`.

## Criterion recommendation and open scope

This lane closes the weighted/conditional prompt branch portion of S-07 for
the direct original GraphSkill and Phoenix skill runners, with source-defined
RNG, VM condition outcomes, exact totals, malformed-condition diagnostics,
full wire normalization, and fail-closed receipts. It does not by itself
verify the complete written S-07 acceptance. Root should keep S-07 open for
the full routing fixture, the seven malformed-precedence decisions, and the
Chitchat follow-up/multi-turn controls unless those are closed by the other
accepted S-07 lanes. This lane also does not make a live HTTP, deployment, or
hardware claim.

No production repair is justified by this result: the source and candidate
were identical for all 132,967 observable rows.
