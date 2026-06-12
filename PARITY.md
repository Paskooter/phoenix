# Phoenix ↔ Pegasus 1:1 Parity Status & Plan

Synthesized 2026-06-09 from the full atlas (`pegasus/docs/atlas/`), the pegasus source, and
the archive. This is the master tracker for the 1:1 recreation; ROADMAP.md holds the
per-feature checklist, DIVERGENCES.md the deliberate-deviation ledger.

Rebuild-plan milestones (atlas 01-rebuild-plan.md): M1 contracts ✅ · M2 service shell ✅ ·
M3 history ✅ · M4 lasso ✅ · M5 parser ✅(98% oracle parity) · M6 hub ✅(client modes) ·
M7 skills ✅(core + chitchat library) · **M8 audio/ASR ❌ ← the big one** · M0 golden capture
◐ (oracle harness exists; no full golden corpus) · M9 parity report ◐ (this doc + DIVERGENCES).

## Status matrix (compressed; ✅ done ◐ partial ❌ missing · [DEAD] = dead external dep, skip)

| Subsystem | ✅ Have | ◐/❌ Gaps |
|---|---|---|
| **gateway (hub)** | listen FSM, JWT, router (weights, skill-entity), redirect cap, global turn, proactive pipeline, launch-history | ❌ **server-side ASR** (ASRSession + Parakeet VAD + GARBAGE short-circuit + hint `$YESNO` expansion + StringNormalizer) · ❌ speech-history recording · ◐ GET /v1/skills trims config · ◐ settingsRules fail-open vs reference fail-closed · ❌ decision-tree fallback-to-parent · ❌ SkillConfigValidator · [DEAD] Google STT, S3 logs, settings client, FastEOS, agents passthrough |
| **nlu (parser)** | real grammars + `{% %}` actions + priority arbitration; HIGH/LOW/SKIP + LLM ordering; launch/question grammars; LLM fallback | ◐ factory entities (wildcard fallback → entity values diverge) · ❌ LoopMemberDetector · ❌ eq_words wiring · ◐ `<weight>`/`~` scoring + designated-loser demotion · ◐ global-command grammars · ❌ GET /state · ❌ 400 on non-string text · ◐ `rules` echo = winning rule name |
| **data (lasso)** | relay framework (HEAD prefetch, TTL, envelope), weather/news/maps/credential/calendar, B3 fix | ❌ news hourly poller (cache never cold) · ◐ calendar TZ edge cases · ◐ in-memory vs Mongo/Redis (durability) · [DEAD] real OAuth refresh |
| **history** | full IH rule matrix, latest/count, retention, speech store | ❌ **route prefix `/v1/...`** (wire-incompatible with reference clients!) · ❌ GET query variants · ◐ validation layer (ID regex, ts<=now, per-type method table) · ◐ sorted-array EXACT (personIDs) · ◐ in-memory (restart loses IH state) |
| **contracts** | envelope, registries, listen/NLU/skill schemas, errors, timeouts | ❌ proactive schemas · ❌ JCP/SLIM schema · ❌ MIM types · ❌ ListenResult precedence class · ❌ manifest schema |
| **common (utils)** | env discovery, service runner, JWT, trace, logger | ❌ WS sendJson client (tests need it) · ◐ log line shape |
| **skills framework (baseskill)** | GraphSkill/GraphManager (wire-compatible sessions), Slimmer core, PromptData (measured surface), skill host | ❌ node library (NoOp/TrueFalse/JCP/SetLooperID) · ❌ MIM factories (QN/AN/MAN/Router + NM/NI loops) · ❌ **OptInFactory** (proactive opt-in FSM) · ❌ generateSlimSequence (MAN) · ❌ generateDisplay (GUI) · ❌ unifyMims · ◐ Graph build-time validation · ◐ PromptData: loop.list pronounceable, location strings, `dt` TZ from location.iso |
| **answer-skill** | LLM path, trim, escaping, analytics | ❌ Wikipedia-first path (alive!) · ◐ canned no-source reply; 450-char cap · [DEAD] Bing/Wolfram |
| **chitchat-skill** | full 4,424-MIM library + faithful ProcessQueryNode dispatch + semi-specific resolution | ◐ flat handler vs graph form (trace fidelity) · ◐ analytics event names |
| **report-skill** | IntentSplit (subskill selection), weather/news data, 82 mims vendored | ❌ **MIM wiring** (mega-MAN assembly, WeatherMimLogic conditions, News intro/3-2-1/outro, mimPromptText prefixes) · ❌ commute subskill logic · ❌ calendar subskill logic · ❌ UserID subgraph + PrefetchWeather + GetUserPrefs/prefsConfig · ❌ GUI views |
| **example/template skills** | (color-skill demo instead) | ❌ example-skill (exit-redirect exerciser) · ❌ template-skill skeleton |
| **harness/verification** | normalize + D1/D2, oracle grader, sim proxy+browser harnesses, test-manifest vendored (4,705 entries) | ❌ **corpus runner** + D3 (routing) / D4 (mim_id) / D5 (fuzzy ESML) · ❌ SkillConversation driver · ❌ frozen-world fixtures (Jetsons loop) · ❌ golden capture vs reference (M0) · ❌ behavior-suite ports |
| **runtime** | npm workspaces, run-sim-stack.sh | ❌ docker-compose equivalent (ports 9000/9003-9007, ETCO_/NET_ contract) · ❌ substitution testing |
| **wire clients** | (robots/sim bring their own) | hub-client = protocol oracle: 6400 B/100 ms PCM chunks + trailing silence, final:true closes socket — M8 must match |

## Execution plan (priority order)

**Phase A — wire-correctness quick fixes** (cheap, real divergences)
1. history routes under `/v1/...` (keep legacy alias) + gateway client to match
2. parser: GET /state, 400 on non-string text; gateway: GET /v1/skills full config
3. settingsRules fail-closed default + `ETCO_hub_settingsRulesPermissive` escape hatch (DIVERGENCES)

**Phase B — measure: corpus runner (M0/M9 backbone)** ✅ done 2026-06-09
4. Runner over the 4,705-entry test-manifest at the NLU+router level: grade intent (D3) and
   memo.mim (D4); mismatch report drives Phase C/D ordering. Wire into harness as a CLI.
   **Result: 10,035 utterances — D3 98.1%, D4 96.8%** (2026-06-10, after wildcard arc costs; was 97.9/96.1, and 81.6/79.8 at first measurement), after
   weight scoring + single-union unification (was 81.6/79.8 at first measurement). Remaining
   397 misses are a long tail (max class 12): factory-entity sub-arm capture
   (KU_CanYou<Action>Thing), semi-specific membership, seasonal/CES-era intents.

**Phase C — NLU fidelity** ✅ substantially complete 2026-06-10
5. Done: FST weight scoring + forward entry-weights; single-union unification; wildcard arc
   costs (WILDCARD_TOKEN_COST=0.7); eq_words homophone matching; **factory entities extracted
   from the reference FST binaries** (pure-python OpenFST decoder → plain-text vocab:
   first_name 6,008 / last_name 20,027 / music_genre / country / state / canada_province;
   membership is a constraint); parser GET /state + 400 on malformed text.
   **Final plateau: D3 98.2% / D4 96.8% (10,035 utterances; 329 long-tail misses, max class 12).**
   Remaining (lower yield, future iterations): LoopMemberDetector, global-command strict-arm
   tuning, `rules` echo (needs reference-router re-read), per-class miss forensics.

**Phase D — server-side ASR (M8)** ✅ done 2026-06-10 (mock-verified end-to-end; needs a live /transcribe host for real speech)
6. ASRSession interface + Parakeet session (RMS≥400, SOS 150 ms, EOS 700 ms, 30 s cap,
   WAV POST `/transcribe`), provider factory (`ETCO_server_asrProvider`), hint expansion,
   GARBAGE short-circuit, StringNormalizer, speech-history recording; verify with
   hub-client-style PCM streaming (6400 B/100 ms + trailing zeros)

**Phase E — skills framework completion** ◐ in progress
7. ✅ node library + MIM factories + OptInFactory + generateSlimSequence/Display (2026-06-12:
   Graph/subgraph composition, full node set, QN/AN/MAN/MIM factories with NM/NI escalation,
   reference Slimmer API, unifyMims, OptIn FSM + vendored base MIMs; 10 new tests)
8. report-skill real MIM wiring (mega-MAN, Weather/News MimLogic, commute/calendar parse) ← next
9. example/template skills; chitchat graph form

**Phase F — runtime + parity closure**
10. docker-compose equivalent; SkillConversation + frozen fixtures; substitution run; M9 report

Out of scope ([DEAD], recorded in DIVERGENCES.md): Google STT, Dialogflow agents, AWS
settings service wire client, S3 speech logs, real OAuth refresh against 2018 apps,
Bing/Wolfram, VoiceRSS, the 25-service account cloud.
