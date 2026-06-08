# Phoenix Roadmap

Condensed from `pegasus/docs/atlas/01-rebuild-plan.md`. The ordering is dependency-driven, and
every milestone is gated by **behavioral parity** against the reference, not by code review.

The unlock that makes this tractable: the reference finds peers via `NET_<svc>` env vars, so a
new service can be **substituted** into the original compose stack one at a time and validated by
the original test suites before the next service exists.

## Milestones

| # | Milestone | Done when | State |
|---|---|---|---|
| **M0** | Reference stack + goldens | Pegasus compose runs; the 2,573-utterance manifest captured at L-ASR; 52 `.raw` audio goldens; per-service goldens (parser/lasso/skills/proactive/multi-turn) committed | pending (needs the node-8 reference stack booted) |
| **M1** | Contracts | Every wire shape expressed as schema + builder; round-trips on every captured golden | **done (bootstrap)** — `@phoenix/contracts` |
| **M2** | Service shell | `/healthcheck`; unknown route → 404 ERROR; thrown handler → 500 ERROR; `NET_*`/`ETCO_*` discovery with required-throws; an unmodified reference client can connect | **foundation done** — `@phoenix/common` (+ gateway WS upgrade in M6) |
| **M3** | history | Black-box suite passes (rule matrix, EXACT-via-payload-size, latest-by-insertion-order, null≠404, non-erasing speech updates, 14-day TTL). **Sub:** reference hub + `NET_history`→new | next |
| **M4** | data (lasso) | 6 routes emit `{relayData, lassoDataFromRedis}` byte-compatible with fixtures; TTLs 15m/15m/65m/60s; credential CRUD. **Sub:** reference report-skill + `NET_lasso`→new | parallel after M2 |
| **M5** | nlu (parser) | `/v1/parse` diff over the corpus meets the intent-match threshold; lowercase/trim; loop-member resolution. Requires the grammar-strategy decision (risk R1). **Sub:** reference hub + `NET_parser`→new | parallel after M2 |
| **M6** | gateway (hub) | listen state machine + budgets; intent router (launch-rule gate, exact=1/wildcard=0.5); one-redirect-max; proactive pipeline; WS framing. Unmodified `hub-client` drives it; full manifest re-run diffs clean | after M3–M5 |
| **M7** | skills + framework | session blob round-trips opaquely; MIM→SLIM filter/condition/weight/NoMatch-NoInput semantics; report thresholds + MIM sequences; answer goldens. **Sub:** reference hub + skill baseURL→new | after M1 (parallelizable) |
| **M8** | end-to-end + audio | new stack alone: L-AUDIO over 52 `.raw`, SOS/EOS within ±150 ms; multi-turn sessions match; latency percentiles within budget | after M6, M7 |
| **M9** | parity report + cutover | `DIVERGENCES.md` complete; stale-oracle disposition done; reference archived but bootable | last |

M3/M4/M5 are independent after M2. M7 needs only M1.

## Key risks (carry into the relevant milestone)

- **R1 — grammar engine.** The reference NLU is a C++ FST engine + 117 `.rule` sources. Decide:
  re-host the binary, port the grammars to a JS matcher, or go LLM-first with grammars as a
  fast-path. (M5)
- **R2 — MIM randomization.** Prompt-variant selection has no seed; compare *distributionally*
  (variant-set equality over N runs), not byte-for-byte. (M7)
- **R3 — weather day-index.** The phoenix Open-Meteo shim has an off-by-one vs Dark Sky's
  semantics. Decide replicate-bug-for-bug vs fix, and record it. (M4)
- **R4 — dead oracles.** Some reference suites nock 2018 hosts / use dead TTS (VoiceRSS). Run the
  manifest at L-ASR; pre-populate or replace TTS for any audio path. (M0/M8)

## Not recreated

The dead 2018 cloud stack (AWS-isms, DarkSky, Dialogflow, Google STT, AP News, VoiceRSS) — the
phoenix-branch replacements (Parakeet ASR, LM Studio + Gemma, Open-Meteo, RSS, OpenRouteService,
Wikipedia) are the proven substitutes and what Phoenix targets. Node-8/lerna tooling is replaced
wholesale by Node 20 + npm workspaces.
