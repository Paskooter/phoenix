# X-01 gap analysis — restored-branch answer and NLU extensions

Date: 2026-09-14
Status: **gap analysis only — X-01 is not claimed or verified by this file.**

X-01 asks for the restored-branch (2026 restoration) answer and NLU extensions
to be verified **separately** from original Pegasus:

1. "If the restored profile is retained, match Wikipedia-first, LLM tool
   catalog, fallback text, response normalization, timing and output limits
   against that specific branch."
2. "Keep its corpus, configuration and verified counts separate from original
   Pegasus and prevent implicit intent remaps in the original profile."

## The recorded finding is half stale

It reads: *"The 2026 answer path includes Wikipedia-first and different
fallback/text behavior; Phoenix currently uses only an LLM or placeholder."*

That is accurate for the file X-01 names, and incomplete about the repo.

`packages/skills/src/answerSkill.js:1-14` is explicitly *"Phoenix port of
packages/answer-skill"* — the **original** Pegasus skill. It is LLM-or-honest-
placeholder by design (`MAX_ANSWER_CHARS = 600`, `ETCO_answer_llmUrl`,
`gemma-3`, 12 s timeout) and contains no Wikipedia path. So "only an LLM or
placeholder" describes the original-profile port correctly.

But a Wikipedia-first lane does exist alongside it —
`gqaWikipediaService.js`, `gqaWikipediaProvider.js`,
`gqaMultiProviderService.js`, `gqaDefaultService.js`, `gqaStructQaService.js` —
so the finding's implication that Phoenix has no Wikipedia-first answer path is
no longer true.

## Criterion 2 looks structurally satisfied

Separation is enforced by construction rather than by convention:

- `packages/skills/src/index.js:246-263` — `createBuiltinSkills({ answerHandler
  = answerSkill })`. The **default** answer handler is the original-Pegasus
  port; the GQA lane is reachable only by explicitly injecting a different
  handler. Same for `createSelectedSkill` at `:265-275`.
- `packages/nlu/src/llmFallback.js:182-186` — the NLU extension is
  env-gated: `enabled: process.env.ETCO_parser_llmEnabled === 'true' ||
  Boolean(process.env.ETCO_parser_llmUrl)`. It is off unless deliberately
  configured.

Nothing in the original profile is implicitly remapped, which is what criterion
2 asks for. This is a structural observation, not a verification run.

## The NLU extension is already pinned to the restored branch

`packages/nlu/src/llmFallback.js:4` cites
`jiboV2/pegasus@715e0dd0719ecca5164959d713862a1402430623` ("Add LLM fallback")
as its source. So the restored branch is identified and implemented, not
guessed at. The same revision is the one `externalAgents.js` weighs against
`5c0a739` for the external-agent block.

## What criterion 1 is missing

There is **no X-01 verification lane**. `packages/skills/test/` holds 17
`q01*` test files and zero X-01 files, and the GQA/Wikipedia work was verified
under **Q-01**'s criteria, which are not X-01's.

Criterion 1 names six properties to compare against the restored branch
specifically — Wikipedia-first ordering, the LLM tool catalog, fallback text,
response normalization, timing, and output limits. None of those has a
differential against `715e0dd0`, and criterion 2's "verified counts kept
separate" has no separate count to point at because no separate lane exists.

## Recommendation

X-01's remaining work is a bounded differential, not new implementation: pin
the `715e0dd0` answer path, compare those six properties against the retained
GQA profile, and publish its counts separately from Q-01's and from original
Pegasus. The separation criterion should be converted from a structural
observation into an asserted control — a test that fails if the original
profile's default answer handler is ever swapped or if the LLM fallback becomes
enabled by default.

X-01 stays `todo`. Nothing here was run against a robot and no file outside this
document was changed.
