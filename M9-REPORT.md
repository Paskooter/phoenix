# M9 — Phoenix ↔ Pegasus Parity Report

*Finalized 2026-06-12. This is the closing milestone of the atlas rebuild plan
(M0–M9): what was rebuilt, how parity was measured, what diverges and why.*

Phoenix is a ground-up JavaScript recreation of **pegasus**, the Jibo robot's cloud
backend, built from the archived reference source, the atlas documentation, and the
robot wire protocol — with **zero vendored Jibo binaries** (the NLU engine, MIM dialog
engine, and all services are reimplemented; only plain-text data ships: grammars,
MIMs, word lists, manifests).

## Verdict

Phoenix reproduces the reference backend's observable behavior at the wire:

| Measure | Result |
|---|---|
| NLU intent parity (D3) vs the reference test-manifest | **98.2 %** over 10,035 utterances |
| MIM routing parity (D4, memo.mim) | **96.8 %** over 10,035 utterances |
| NLU parity vs the live `jibo-nlu` oracle binary | ~98 % (dev-only oracle harness) |
| Unit + integration tests | 150 across 9 packages, green |
| Sim proxy harness (full WS protocol: turns, audio, proactive, multi-turn) | all checks pass |
| Browser e2e (real Chrome + jibo-web-sim, incl. live mic → server ASR) | all checks pass |
| Reference compose port/wire contract | verified (scripts/verify-compose-contract.mjs, all pass) |

## What was rebuilt (milestones)

- **M1 contracts** — message envelope, registries, listen/NLU/skill schemas, errors, timeouts.
- **M2 service shell** — zero-dep HTTP runner, NET_/ETCO_ discovery, JWT, trace headers, logging.
- **M3 history** — interaction-history rule matrix, latest/count, retention, speech store, `/v1` routes.
- **M4 lasso (data)** — relay framework (validate→cache→prefetch→TTL) with 2026 shims: Open-Meteo→DarkSky,
  RSS→AP News XML, ORS→Google Maps; credentials, calendar.
- **M5 parser (nlu)** — pure-JS launch-rule grammar engine with FST semantics: `{% %}` semantic
  actions, `<N>`/`~N` weight scoring, wildcard arc costs, eq_words homophones, factory entities
  decoded from the reference FST binaries (pure-Python OpenFST reader → plain text), priority
  arbitration, LLM fallback.
- **M6 hub (gateway)** — WS listen FSM, JWT auth, intent router (decision tree, entity weights,
  skill-entity launches), redirects, global turns, proactive pipeline (context/IH/settings rules),
  launch history.
- **M7 skills** — the full baseskill framework: GraphSkill/GraphManager, Graph/subgraph
  composition with finalize validation, node library, MIM factories (QN/AN/MAN/MIM with
  NoMatch/NoInput escalation), OptIn FSM, Slimmer (conditions, weighted picks, templates,
  GUI thresholds), unifyMims, PromptData; skills: report (full PersonalReport graph with
  Weather/News/Commute/Calendar MimLogic tables), chitchat (4,424-MIM library, graph form),
  answer (LLM), example/template/color.
- **M8 audio/ASR** — server-side ASR to the robot wire contract: Parakeet REST session with
  energy VAD (RMS ≥ 400, SOS 150 ms, EOS 700 ms), GARBAGE short-circuit, `$YESNO` hint
  expansion, StringNormalizer; verified unit → proxy (robot PCM framing) → real browser mic.
- **M0/M9 verification** — oracle grading harness (real `jibo-nlu` as dev-only golden source),
  corpus runner over the vendored 4,705-entry test-manifest (D3/D4), stream normalize + diff
  (D1/D2), SkillConversation driver + frozen Jetsons-loop fixtures, sim proxy + browser e2e
  harnesses, compose-contract verifier.

## Runtime / substitution contract

`docker-compose.yml` mirrors the reference compose exactly — same service names, host ports,
and env contract (hub 9000, report-skill 9003, chitchat-skill 9004, parser 9005, history 9006,
lasso 9007, answer-skill 9009; internal 8080; `NET_parser=parser:8080` etc;
`ETCO_hub_skillsConfig` selects the skill registry). Each Phoenix service is therefore a
drop-in substitute for its reference counterpart in a compose deployment.

For docker-less hosts, `scripts/run-compose-stack.sh` runs the identical contract natively
(per-skill ports via `skills-native.json`), and `scripts/verify-compose-contract.mjs` proves it:
healthchecks on all seven reference ports, the hub skill list, a full WS turn through hub:9000
routed to report-skill:9003, and a direct skill POST — all passing.

Full substitution against a *running* reference stack is not possible: the 25-service AWS
account, its data vendors (DarkSky, AP, Google), and the Docker images are gone. The
substitution evidence is therefore: (1) the wire contract above, (2) the oracle NLU harness
against the surviving `jibo-nlu` binary, (3) the reference test-manifest corpus (D3/D4), and
(4) protocol conformance against `hub-client` (the robot's own client) framing.

## Deliberate divergences

The complete ledger is `DIVERGENCES.md`. Categories:

- **Dead externals, skipped** — Google STT, Dialogflow, AWS settings wire client, S3 speech
  logs, Bing/Wolfram, VoiceRSS, real OAuth refresh. Phoenix degrades exactly as the reference
  did when these failed (SettingsFailed/ServiceDown MIMs, canned answer fallbacks).
- **2026 data shims** — Open-Meteo, RSS feeds, and OpenRouteService stand in for DarkSky, AP
  News, and Google Maps behind the same lasso relay envelopes (one knock-on: news items carry
  no images, so the image requirement in NewsParse is relaxed).
- **In-memory stores** — Mongo/Redis replaced by in-memory maps with the same TTL/eviction
  semantics; durability across restarts is not preserved (single-process deployment target).
- **Lean ports** — moment-timezone-backed DateTime reduced to the call-sites the skills use;
  GUI view configs (weatherHiLo, newsImages, calendar/commute views) are stubbed because no
  surviving client renders them.
- **Live replacements** — answer-skill's dead Bing/Wolfram path replaced by an OpenAI-compatible
  LLM endpoint (LM Studio/Gemma), the parser gains an optional LLM fallback, and ASR targets a
  modern Parakeet host on the original REST contract.

## Known gaps (recorded, low yield)

- NLU long tail: 329/10,035 corpus misses (max class 12 — factory-entity sub-arms,
  semi-specific membership, seasonal/CES-era intents); LoopMemberDetector; global-command
  strict-arm tuning; `rules` echo naming.
- Gateway: speech-history recording; `GET /v1/skills` returns full configs (reference trims);
  settingsRules fail-open default; decision-tree fallback-to-parent; SkillConfigValidator.
- Contracts: proactive/JCP/MIM schema validation (shapes are produced correctly; not
  schema-enforced).
- PromptData edges: pronounceable loop.list, location strings, `dt` timezone from location.iso.

## Reproducing the numbers

```
npm test                                     # 150 tests across all packages
node packages/harness/src/corpusRunner.js    # D3/D4 over the full test-manifest (~15 min)
bash scripts/run-compose-stack.sh &          # reference-contract stack (no docker needed)
node scripts/verify-compose-contract.mjs     # wire/port contract
cd ../jibo-web-sim && node test/phoenix-be-skill.mjs       # full WS protocol harness
cd ../jibo-web-sim && node test/phoenix-voice-browser.mjs  # browser mic → ASR e2e
```
