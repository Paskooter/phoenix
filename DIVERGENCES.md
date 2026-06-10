# Divergences from the Pegasus reference

Phoenix aims for **behavioral** parity at the wire, not internal fidelity. Every intentional
deviation is recorded here with rationale, so the M9 parity report is just this file finalized.
Each entry: what changed, why, and the parity impact.

## Architectural (decided at bootstrap)

| # | Divergence | Rationale | Parity impact |
|---|---|---|---|
| A1 | Language: modern **JavaScript** (ESM, Node ≥20) instead of TypeScript-compiled-to-node-8 | Project decision; no build step; types via JSDoc + runtime schema validation | none (wire-compatible) |
| A2 | **Zero external deps** for contracts/common/harness (hand-rolled JSON-Schema validator, HTTP runner, diff) | Installable offline, tiny surface, no supply chain | none |
| A3 | **npm workspaces** replace lerna + yarn-1.7 | Reference tooling is dead-era | build-only |
| A4 | Default per-service ports 7010–7014 instead of all-8080-in-container | Allows local side-by-side runs without docker | none (harness collapses port in URLs) |
| A5 | Skill `session` blob compared **round-trip only**, not by contents | node-ID assignment is an internal concern; reference assigns global sequential IDs by registration order | must preserve round-trip opacity |

## Behavioral decisions still open (resolve in the noted milestone)

These are *flagged, not yet decided* — surfaced by the atlas open-questions/risk register.

| # | Question | Milestone | Default leaning |
|---|---|---|---|
| B1 | Weather day-index off-by-one (Open-Meteo `past_days=1` makes `data[0]`=yesterday while report-skill reads `data[0]`=today) — replicate bug-for-bug or fix? | M4 | replicate, then fix behind a flag |
| B2 | NLU intent catalog — match the reference's grammar coverage (198 Dialogflow intents) or the phoenix LLM subset (~14)? | M5 | start from the LLM subset, expand against the corpus |
| B3 | `Credentials.deleteOtherCredentials` uses `if (skillId = 'report-skill')` (assignment bug) — preserve or fix? | M4 | fix (and note the behavior change) |
| B4 | Speech history has no TTL in the reference — add retention or match (none)? | M3 | match (none) for parity; retention is ops-side |
| B5 | MIM prompt-variant randomization seedability for deterministic tests | M7 | add an optional seed (test-only), default unseeded |

## Decided behavioral divergences

| # | Decision | Why | Wire impact |
|---|---|---|---|
| B3✓ | `deleteOtherCredentials` assignment bug **fixed** (`===`) | Bug-for-bug would delete wrong creds | delete-other now correct |
| B6 | **GQA → answer-skill**: knowledge questions (whoIsPerson, requestTellAboutThing, general*Questions) remap to answer-skill instead of chitchat | Reference chitchat GQA deflected to Wolfram (dead service); phoenix answers via Wikipedia/LLM | better answers; chitchat personality questions unaffected |
| B7 | **requestWeather → requestWeatherPR**: weather questions route to report-skill's weather subskill | Chitchat's requestWeather memo was a "go ask the report" deflector; phoenix goes straight there | weather questions get real weather |

Add a row the moment a deviation is chosen; never let code diverge silently.
