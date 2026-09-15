# R-01 side-effect comparison — the whole message stream, not just the assertions

Date: 2026-09-15
Status: **substitution result — R-01 is not claimed or verified by this file.**

Acceptance criterion 2 asks for side-effect comparisons, not just pass counts.
The suite asserts a handful of named fields; two stacks can agree on every one
of them and still send the robot different bytes. This captures every message
the client receives and diffs the streams.

## Method

The three test drivers write the message array they return, keyed by what the
transaction *was* rather than by call order. `compare-traces.mjs` matches by
name and diffs.

Normalisation is deliberately minimal: `msgID`, `ts`, `transID`, `sessionId`,
`session`, `timings`, `id` — values minted per run or taken from the clock.
Even those are replaced with their **type**, not dropped, so a field that
disappears or changes type still fails. Everything else is compared verbatim.

## Result

```
control:   6 transactions
candidate: 8 transactions
identical: 2/8
```

| transaction | outcome |
| --- | --- |
| `simulatedASRTest-do_you_like_being_Jibo` | **identical** |
| `simulatedASRTest-live_long_and_prosper` | **identical** |
| `audioTest-test_audio.raw` | differs |
| `audioTest-test_audio_long.raw` | differs |
| `audioTest-livelongandprosper.raw` | differs |
| `audioTest-livelongandprosper.raw-earlyEOS_live` | differs |
| `simulatedASRTest-…-agents_someAgent` | control never produced one |
| `simulatedASRTest-…-agents_someAgent-2` | control never produced one |

**Every difference is in the ASR path.** Both CLIENT_ASR transactions — which
bypass ASR entirely — are byte-identical once per-run identifiers are typed
out. All four audio transactions differ. The two one-sided entries are the
external-agent cases, where the control's driver rejects with a 500 before it
can return (see `../r01-external-agents/`).

## What the suite's assertions miss

Two of the four differing transactions **pass every assertion on both sides**,
and still send the robot different content:

| | control (Google STT) | Phoenix (Parakeet) |
| --- | --- | --- |
| `test_audio.raw` text | `testing testing 1 2 3` | `testing testing one two three` |
| `test_audio.raw` confidence | `0.9339536428451538` | `1` |
| `test_audio_long.raw` text | `testing testing 1 2 3` | `testing testing one two three` |
| `test_audio_long.raw` confidence | `0.954422652721405` | `1` |

Both reach `partialRecognition` with `match: null`, so the suite is satisfied.
But two robot-visible properties differ:

1. **Number formatting.** The original returns digits, the replacement returns
   words. ASR text reaches the robot and is matched by grammars downstream; a
   rule expecting "1 2 3" does not see "one two three".
2. **Confidence is a constant.** The original reports a real per-utterance
   confidence; Parakeet reports `1` every time. Any logic keyed on confidence
   has lost its signal rather than received a different value.

Neither is visible in the pass counts. That is the point of this comparison,
and it is why criterion 2 asks for it separately.

The Early EOS transaction differs as already recorded in H07b: the control
truncates to `"live"` with `confidence: 0` and no intent; Phoenix transcribes
`"live long and prosper"`, resolves `referenceLiveLongProsper`, and routes to a
skill.

## Confidence in the comparison itself

The same run reports both outcomes — 2 identical, 6 differing — so the
comparison is neither always-pass nor always-fail, and it distinguishes on real
content rather than on normalised noise.

The capture took six attempts to get right, and every intermediate version
would have produced a confident wrong number. Recorded so the next person does
not repeat them:

| fault | what it produced |
| --- | --- |
| gateway exited on startup | a "detection" with nothing under test |
| `mkdirSync(recursive)` on Node 8.9.4 | instrumentation crash that read as 8 findings |
| traces keyed by call order | two runs write different counts, so index *n* is a different transaction |
| root-owned traces survived `rm -rf` | a fix appearing not to work |
| `set -o pipefail` + `grep -q` | the liveness guard failed *because* the service was healthy |
| same utterance in two tests | the second silently overwrote the first |

Two invariants came out of it, both now enforced: never run a suite against a
service that has not reported a listening line, and never compare captures whose
counts do not match the expected asymmetry. The Phoenix run must produce exactly
two more transactions than the control, because the control's two external-agent
drivers reject before returning. It does: 6 and 8.

## Still outstanding for R-01

The four test files that supply their own skill registry, closing H07b, and
history/data side-effect capture (the suite leaves history pointed at a dead
port, as the baseline does). **R-01 remains `todo`.**
