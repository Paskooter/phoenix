# Owner decisions — 2026-09-15

Recorded verbatim in effect, so later agents do not re-litigate them. These
change what may be *recorded* as parity evidence; they do not retroactively
verify anything.

## D1 — dead third-party services: replace, do not exclude

**Decision: find live replacements.** Dark Sky, Google Maps traffic and AP News
are not to be written off as permanent exclusions. Investigate live services and
slot them in. **Free tiers strongly preferred — the owner does not want to pay.**

Consequence: R-01's "achievable baseline" framing is superseded for these three.
The goal is a stack where the 4 dead tests can pass again against live
replacements, not a smaller denominator.

## D2 — Dialogflow: replace with a tool-calling LLM

**Decision: replace it.** Use a small, cheap, fast tool-calling model on
OpenRouter to take over Dialogflow's language understanding. Build a candidate
harness that produces the same outputs for the same inputs as Dialogflow would —
or, failing that, a *working* replacement.

The owner explicitly accepts that exactness cannot be measured, because the
original service is down and cannot be sampled. **A working replacement is the
bar; byte-exact parity is not, and must not be claimed.**

Important: Jibo's own 2026 restoration already did this
(`pegasus@715e0dd0`, "Add LLM fallback NLU client (LM Studio + Gemma) replacing
dead Dialogflow"), and `packages/nlu/src/llmFallback.js` is a source-exact port
of it. This is a wiring and hosting job, not a design job.

## D3 — unrecovered Jot code: search the archive before rebuilding

**Decision: check the Jibo MCP archive first.** The party-era controllers and the
Kafka consumers were assumed unrecoverable without anyone searching the archive
for them. If the source is there, use it. If only specifications, request shapes
or docs survive, **rebuild from those**. Writing them off is the last resort, not
the first.

## D4 — general question answering: two toggleable options

**Decision: build both, ship the original first.**

1. **Now:** implement the original **Wolfram Alpha** integration the way it
   worked before, so the feature feels as it did.
2. **Later:** LLM-based general question answering.
3. **Architecture requirement:** a toggle between the two. Leave room for it now.

Phoenix already has `packages/skills/src/gqaWolframProvider.js`, a source-backed
port of `srv-gqa-ws@ebe1a7d3` `gqa/wolfram.py` (Python truthiness preserved,
source timeouts, answer pod index). The profile-selection machinery in
`packages/skills/src/index.js` already supports opt-in provider profiles. So this
is largely wiring plus a verification lane, not a new build.

**Outstanding input needed:** a Wolfram Alpha AppID. The provider treats the
endpoint and app id as deployment configuration supplied by the caller, and none
is configured. The non-commercial tier is free.

## D5 — Moth hardware: authorized

**Decision: both the reboot and full out-of-box setup are authorized**, to be run
when root judges it ready. The owner can refresh the robot to stock or restore
from the NAND backup if anything goes wrong.

Order: the credential-persistence reboot test first (cheap, before-half already
captured), then full OOBE.
