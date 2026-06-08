# @phoenix/harness — old-vs-new comparison harness

The reimplementation is verified by **behavioral parity** against the Pegasus reference, not by
reading the original. This package is how you measure that. Full design lives in
[`../../../pegasus/docs/atlas/verification-strategy.md`](the atlas) and the rebuild plan's
section (c); summary below.

## Idea

Run the **reference** (the Pegasus compose stack) and **Phoenix** side by side. Feed both the
same input, capture both message streams, normalize away the non-deterministic bits, and diff.

```
input ──┬─▶ reference stack ──▶ stream_ref ──┐
        └─▶ phoenix stack    ──▶ stream_new ──┴─▶ normalize ─▶ diff ─▶ report
```

## Injection levels (cheap → full)

| Level | Entry | Skips | Use |
|---|---|---|---|
| L-NLU | `CLIENT_NLU` message | ASR + parser | route/skill logic only |
| L-ASR | `CLIENT_ASR` message | ASR | **>95% of comparisons** (text in, no audio/TTS) |
| L-AUDIO | binary PCM frames | nothing | the 52 recorded `.raw` audio goldens |

## Diff levels

| Level | Compares |
|---|---|
| D1 | message-type sequence |
| D2 | `nlu.{intent,entities,rules}` (three-way vs the manifest) |
| D3 | routing `match.{skillID,launch}` + SKILL_ACTION skill id |
| D4 | `prompt_id` / `meta.mim_id` sets |
| D5 | fuzzy ESML text (Levenshtein) |

`diffStreams()` here implements D1 and a positional D2 over normalized payloads; D3–D5 are
field-scoped variants to add as the milestones need them.

## What `normalizeStream` strips

`msgID`, `ts`, `timings`, port numbers in URLs, and the **contents** of `skill.session`
(round-trip presence is asserted; node-ID assignment is Phoenix's own business). Pin context to
the frozen mock clock (`2017-12-11T16:05:52.585-05:00`) so greetings/"tonight" logic is stable;
flush Redis between data cases; reset the store between history cases.

## Status

Shipping now: `normalizeStream`, `normalizeMessage`, `diffStreams` (+ tests). The corpus runner
that drives the 2,573-utterance manifest into both stacks lands with **M6** (needs a runnable
gateway). Captured reference goldens go under `goldens/` (committed) and `captures/` (gitignored,
regenerated).
