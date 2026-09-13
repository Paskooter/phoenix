# S-08 source/runtime differential

This receipt is the source-executable follow-up to the bounded S-08 review.
It was produced on branch `w18/s08` from Phoenix base `16c829075358d86a67bbfa0f5488193321c81614`.
The candidate receipt was regenerated at implementation commit
`5a443f1`; the evidence-only refresh commit follows it.
The authoritative Pegasus source is `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`,
run in `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
(`v8.9.4`). Phoenix ran in host Node `v22.22.0`.

The Jibo MCP search was performed before source inspection. Repository discovery
selected `jiboV2/pegasus`; the source files below were read at the pinned SHA:

- `packages/report-skill/src/PersonalReport.ts`
- `packages/report-skill/src/nodes/{IntentSplitNode,GetUserPrefsNode,GetDataNode,ParseDataNode,ToggleNode}.ts`
- `packages/report-skill/src/SettingsClient.ts`
- `packages/report-skill/src/subgraphs/userid/{UserIDFactory,PrefetchWeatherNode}.ts`
- `packages/report-skill/src/Analytics.ts`
- `packages/baseskill/src/graph/mims/factories/OptInFactory.ts`
- `packages/baseskill/src/graph/mims/nodes/optIn/{RouteNode,YesNoWrongIDNode}.ts`
- `packages/report-skill/tests/{PersonalReport,SettingsClient,SingleSkills,TestUtils}.js`
- `packages/baseskill/tests/OptInSkill.test.ts`

## Receipt

The reproducible runner is `scripts/parity-s08/run-source.cjs` for the original,
`scripts/parity-s08/run-candidate.mjs` for Phoenix, and
`scripts/parity-s08/compare.mjs` for the normalized comparison. The case list is
in `scripts/parity-s08/matrix-spec.json`.

```text
docker run --rm --network none \
  --mount type=bind,source=/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c,target=/ref,readonly \
  --mount type=bind,source=$PWD,target=/work \
  node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /work/scripts/parity-s08/run-source.cjs /ref \
  /work/docs/parity/evidence/2026-09-13/s08-personal-report/source-runtime.json
node scripts/parity-s08/run-candidate.mjs \
  docs/parity/evidence/2026-09-13/s08-personal-report/candidate-runtime.json
node scripts/parity-s08/compare.mjs \
  docs/parity/evidence/2026-09-13/s08-personal-report \
  scripts/parity-s08/matrix-spec.json
```

The matrix has **54 rows**: 43 graph sessions and 11 Settings seams. The graph
rows cover all five launch intents, reactive and proactive launch, recognized
adult/child/unknown speaker, identity success/not-in-loop/cancel/no-input,
WhoIsThis no-match exhaustion, and the source Opt-In no-match, wrong-ID-to-cancel,
and wrong-ID-to-loopmember continuations,
configured and default/all-disabled preferences, all four individual provider
failures, every non-empty partial-failure subset of the four providers, all
providers down, all single skills, incomplete calendar/commute setup, empty
news categories, opt-in yes/no/wrong-ID/no-input, and the Settings-failure and
unknown-intent negatives. The Settings rows cover no speaker, child defaults,
transID present/absent request arguments, all four source commute enum values,
missing commute boundary fields, calendar credentials, and `prefsFromConfig`.

The four added conversation shapes are direct source-test translations. The
WhoIsThis max-NM row sends the two repeated no-match results used by
`PersonalReport.test.js`'s `repeatMIM(..., 'FinalNoMatch')` control. The Opt-In
rows send the two no-match results, `wrongID` then `cancel`, and `wrongID` then
`loopmember` with the pinned test utility's `LOOP_OWNER_ID` value
`test-looper-id-2`, matching `OptInSkill.test.ts`.

The generated artifacts are:

- `source-runtime.json` — 43 original graph rows and 11 original Settings rows;
- `candidate-runtime.json` — the same rows from Phoenix at `5a443f1`;
- `differential-receipt.json` — normalized semantic and prompt comparison;
- `prefetch-process-difference.json` — the retained detached-prefetch process control.

The normal receipt is exact:

```text
result=pass rows=54 semanticMatches=54 promptMatches=54
expectedDifferences=0 coverageErrors=0 promptDifferences=0 unexpectedDifferences=0
```

Responses are compared by response type/finality, ordered MIM identity and
listen contexts, analytics, transition sequence, session state, and provider/
Settings call records. Prompt IDs are also compared after resetting the same
deterministic RNG before each case. Dynamic message IDs and graph node IDs are
excluded. The two negative rows intentionally fail in both runtimes with the
same source-shaped errors: unknown intent, and an omitted action-result
boundary (`Cannot read property 'nlu' of undefined`). They are therefore
negative controls, not uncounted mismatches.

## Bounded repair and falsification

The first differential exposed one real semantic difference in the omitted
`data.result` continuation. Pegasus `MultiTurnNode.ts` accesses
`data.result.nlu` and `data.result.asr` directly. Phoenix had a null-safe
access that silently converted an omitted result into no-input. The repair in
`packages/skills/src/graph/mims/factories.js` restores the source field-access
boundary, including the Node 8 error text, while retaining valid no-input
results whose `nlu` and `asr` fields are present and null-valued.

`packages/skills/test/s08SourceRuntimeMatrix.test.js` names both controls:
valid no-input reaches the source MaxNI terminal, and an omitted result rejects
with the source-shaped TypeError. As an implementation falsification, the
guard was temporarily changed to `data.result || {}`. The named test then
reported `Missing expected rejection` (1 pass, 1 fail), and the differential
reported `rows=50 semanticMatches=49 promptMatches=49 unexpectedDifferences=1`.
The exact guard was restored with `apply_patch`; the focused test and the
54-row differential are green again.

The comparator also has a coverage falsification. Temporary copies of both
receipts with the same final graph descriptor removed exit nonzero and report
the source and candidate cardinality 42 versus spec cardinality 43, plus the
missing descriptor ID on both sides. The focused self-check
`s08Comparator.test.js` repeats this exact control, which falsifies the old
`undefined === undefined` blind spot when both receipts omit a row.

The same self-check forges one candidate `prompt_id` while leaving every other
field unchanged. The comparator exits nonzero with `semanticMatches=54`,
`promptMatches=53`, and one `promptDifferences` entry, proving that prompt-only
drift is also a failure.

Validation completed on the final worktree:

```text
node --test packages/skills/test/s08SourceRuntimeMatrix.test.js packages/skills/test/s08Comparator.test.js
tests=4 pass=4 fail=0
npm test
tests=1986 pass=1978 fail=0 skipped=8
parity:check exit=0
parity:gate cases=43 differences=0 invariants=0 coverageGaps=0 exit=0
```

## Detached prefetch classification

`PrefetchWeatherNode.ts` launches two background HEAD requests without awaiting
or attaching a rejection handler. The authoritative rejection control records
one source `unhandledRejection` for a 503 and zero in Phoenix. Both methods
return a Promise immediately (`returnedUndefined: false` in both receipts), so
their immediate return shape agrees; the detached source Promise rejects and
Phoenix consumes that rejection. The rejection control does not observe a
resolved value or compare a complete Report response. The details are in
`prefetch-process-difference.json` and the retained accepted Lasso receipts.
This is a process-observable divergence that can affect logging or a runtime
configured to terminate on unhandled rejections. Reintroducing the process
hazard is not a source-correct client repair, so this remains an explicit S-08
gap.

## Criterion audit

| S-08 criterion | Status | Evidence and limit |
| --- | --- | --- |
| Compare launch intents, UserID/opt-in, ordering/toggles, `prefsFromConfig`, Settings requests/defaults with original tests | **VERIFIED for source-executable behavior** | All 43 graph rows and 11 Settings rows deep-compare source and Phoenix at the pinned source/runtime boundary; source test modules and source graph files above are pinned. Live Settings deployment is outside this receipt. |
| Verify recognized/unknown speaker, no prefs, all-disabled prefs, partial failures, multi-turn continuation, matching analytics | **VERIFIED for source-executable behavior** | The same 54-row receipt covers the speaker, preferences, every provider failure subset, WhoIsThis max-no-match, Opt-In no-match and wrong-ID continuations, transition state, and Results/Skill Offer analytics. |
| Detached prefetch process behavior | **KNOWN DIVERGENCE** | Source emits one unhandled rejection; Phoenix emits zero. This rejection control compares immediate Promise shape and process handling only; it does not establish an enclosing Report response result. See the separate prefetch artifact. |
| Live provider, deployed Settings/Lasso, Hub, hardware | **UNKNOWN** | No network credentials, deployment, physical robot, or hardware evidence is claimed. These are not literal strings in the two acceptance criteria, but the current task finding still lists them open. |

The two literal acceptance criteria are therefore source-runtime **VERIFIED**;
the whole S-08 task should remain **OPEN** until the lead explicitly accepts
the process-level prefetch divergence and the live/deployment limits. No task
ledger or status file was changed here.
