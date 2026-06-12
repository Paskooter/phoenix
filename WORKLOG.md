# Phoenix worklog

Newest first. One line per verified increment (autonomous loop appends here).

- 2026-06-12 — **G.1: config spine + account-service auth core (loop).** Zero-dep .env loader
  (common/dotenv.js, loaded by @phoenix/common side-effect; real env wins) + .env.example
  documenting every variable; packages/account: persistent JSON store (atomic tmp+rename;
  accounts/loops/tokens/sessions), srv-account-ws semantics (fillAccessKeys 20/40 alnum, bs58
  setup tokens 15-min one-time, loop-name dedupe, find-or-create robot account), scrypt
  passwords, cookie sessions (7d, HttpOnly); portal REST signup/login/logout/me + /api/robots;
  admin face gated by ADMIN_PASSWORD from .env (login, all-robots list, MANUAL ADOPT: mints
  keys + loop and returns the exact /var/jibo/credentials.json + repoint command, idempotent
  per friendlyId). 8 new tests; 174 total green. Next: G.2 robot AWS-JSON face.

- 2026-06-12 — **PHASE F + M9: THE REBUILD IS COMPLETE (loop, final).** F.1 runtime:
  docker-compose.yml on the exact reference contract (hub 9000/report 9003/chitchat 9004/parser
  9005/history 9006/lasso 9007/answer 9009, NET_*/ETCO_hub_skillsConfig), native equivalent
  (scripts/run-compose-stack.sh + skills-native.json; gateway honors ETCO_hub_skillsConfig and
  per-skill baseURLs when NET_skills is unset), scripts/verify-compose-contract.mjs ALL PASS
  (healthchecks ×7, /v1/skills, WS turn hub→report-skill:9003, direct skill POST). F.2:
  SkillConversation driver + Jetsons mockRuntimeData ported into @phoenix/harness with 5 wire
  behavior tests (example walk, report degradation/WhoIsThis/notInLoop, chitchat memo gate,
  template gate, speaker fixture). F.3 final corpus: **D3 98.2% (9851/10035), D4 96.8%
  (9714/10035), 329 misses** — matches the C-phase plateau. F.4: **M9-REPORT.md** (the parity
  report) + README rewritten (current state, run with/without docker). 150 tests + sim proxy
  harness green; live stack relaunched (auto-detects Parakeet+Gemma). Also: phoenix now mirrors
  to github.com/Paskooter/phoenix (public). M1–M9, phases A–F: done.

- 2026-06-12 — **Phase E.9 + PHASE E COMPLETE (loop, stopping).** example-skill (graph-traversal
  exerciser: ExampleNode SLIM/LISTEN walk across LISTEN_UPDATEs, memo-before-intent split,
  proactive arm) + template-skill (memo {entry:'SomeThing'} validation → vendored template-mim
  via ANFactory) registered on the skills service; **chitchat converted to its reference graph
  form** (IntentSplit throws without memo → ProcessQueryNode sets local.path/promptData +
  ErrorResponse arm → Do-MIM ANFactory final → Complete; rng injectable via createChitchatSkill;
  chitchat actions are now bare-SLIM JCPs like the reference, harness/tests made shape-agnostic).
  145 unit + sim proxy ALL PASS; live skills service restarted. Phase E (E.7/E.8/E.8b/E.9) is
  done — loop stops per contract; Phase F (compose/substitution/M9) awaits a go-ahead.

- 2026-06-12 — **Phase E.8b: Commute + Calendar full subskill tables (loop).** CommuteParse
  (arrival = workTime or today's early calendar event; traffic-aware duration; depart/minsLeft
  math) + CommuteMimLogic (Now >120m/<-30m, Poor ≥5/Terrible ≥15 extra mins + DepartTimeNotNormal,
  Normal + DepartTimeNormal, MinutesLeft <30, Hurry >-10/Late, Drive-/Transport- prefixing);
  CalendarData (google/outlook personal+work merge+sort) + CalendarParse (today/tomorrow windows
  vs real clock, all-day, isEarly vs work-arrival) + CalendarMimLogic (full-report summary table
  incl. FullDay/EarlyEvent + single-skill Count/SummaryAndTime/ParallelEvent/TomorrowOnly/Outro
  walk feeding eventSummaries/eventTimesOnAt shift templates); lean jibo-data-utils DateTime port
  (toString {timeOnly}/{prefixOnAt}). 8 new tests over mock lasso + prefsConfig. 140 unit + sim
  proxy ALL PASS.

- 2026-06-12 — **Phase E.8: report-skill IS the PersonalReport graph (loop).** Full port of
  report-skill/src: PersonalReport.ts assembly (IntentSplit→UserID(WhoIsThis QN/SetLooperID/
  PrefetchWeather)→GetUserPrefs(SettingsClient: defaults/prefsConfig/SettingsFailed)→GetData→
  ParseData→Toggles→subskill graphs→send-all mega-MAN with outro logic→Final; proactive memo →
  OptIn VERIFY_ID proposal), WeatherMimLogic complete condition tables (yesterday-vs-today
  change/temp-swing/wet-now-dry-later/day-night icon fix), NewsMimLogic (banned+adult keyword
  filters, headline dedupe, category trim, per-cat counts, `${skill.news.headlines.shift()}`),
  LassoClient against NET_data (incl. minimal xml2js-compatible parser), promptData dt.day/dt.date,
  Slimmer `skill.` nesting. Commute/Calendar = E.8b placeholders (ServiceDown; see DIVERGENCES).
  Tests rewritten to reference behavior: WhoIsThis on un-IDed full report, MustBeLooper via
  notInLoop turn 2, SettingsFailed+ServiceDown+OutroConfigured MAN, happy-path e2e with mock
  lasso (ChangeCloudyWet+TodayWarmer+headline template). 132 unit + sim proxy ALL PASS (harness
  check fixed: envelope final is always true for forwarded skill results; data.final signals
  session continuation). Live skills service restarted.

- 2026-06-12 — **Phase E.7: baseskill node library + MIM factories + OptIn FSM (loop).** Ports of
  Graph.ts (subgraph composition + finalize validation), nodes/{NoOp,Default,TrueFalse,JCP,
  SetLooperID}, mims/nodes/{MultiTurn,QN,AN,MAN,NM,NI,Router}, factories/{MIM,QN,AN,MAN},
  reference Slimmer API (generateSlim/generateSlimSequence/generateDisplay/resolveView; legacy
  low-level kept as generateSlimFromMim), unify/Unify.ts, OptInFactory + RouteNode/YesNoWrongID
  (+4 base MIMs vendored from baseskill/mims/en-us). 10 new tests (QN NoMatch escalation to
  FinalNoMatch, MAN sequence, router, unify, OptIn yes/no/wrongID + SetPresentPerson supplemental
  riding the next JCP). 127 unit + sim proxy harness green. Next: E.8 report-skill MIM wiring.

- 2026-06-12 — **Gemma LLM wired (user-provided endpoint).** LM Studio at 192.168.1.252:1234/v1
  (google/gemma-4-e4b) now drives answer-skill freeform answers AND the parser LLM fallback;
  run-sim-stack.sh probes it at launch (REAL_LLM override). Verified: parser /state llmClient
  READY; answer-skill speaks a real Gemma answer for "why is the sky blue". Also: gateway now
  uses the real Parakeet at 192.168.1.252:6972 (back up); launcher prefers it over the mock.

- 2026-06-11 — **Real-browser mic fully wired (user manual-test ready).** Sim 8b99a14: 16 kHz
  AudioContext capture (polyphase resample) with box-filter fallback, mic constraints (mono+EC/NS/AGC),
  voice-error/voice-done round-trip (chat shows insecure-context/denied/GARBAGE/SOS_TIMEOUT reasons;
  ⏺ holds for the whole turn), self-signed HTTPS listener :8443 (getUserMedia needs a secure context —
  http://<lan-ip>:8080 has no mic API). Phoenix: scripts/mock-parakeet.js (saves RX WAVs to
  /tmp/parakeet-rx + canned transcript; real STT via ETCO_server_parakeetUrl) + run-sim-stack.sh wires
  it to the gateway by default and enables sim HTTPS. Verified: phoenix-voice-browser.mjs ALL PASS;
  live stack relaunched (gateway 9000, sim 8080/8443, mock parakeet 6972, all 200).

- 2026-06-10 — **M8 browser voice e2e verified (loop tick).** phoenix-voice-browser.mjs:
  real Chrome + real sim UI, getUserMedia shimmed to a WebAudio-synthesized stream (headless
  Chrome here has no audio devices — Chrome's fake-device flags yield NotFoundError), all
  downstream real. 🎤 click → hub-bridge streams mic → gateway VAD SOS/EOS → Parakeet (mock)
  → "🎤 what time is it" chat echo → @be/clock → Jibo SPEAKS the time. ALL CHECKS PASSED.

- 2026-06-10 — **M8 SERVER-SIDE ASR — the robot audio path is live (Phase D).** Gateway:
  faithful port of hub/src/asr — ParakeetASRSession (energy VAD: RMS>400, SOS at 150 ms
  cumulative speech, EOS at 700 ms trailing silence, 30 s buffer cap, WAITING→SPEAKING→
  TRAILING_SILENCE→FINALIZING→DONE; 44-byte RIFF/WAV wrap; multipart POST /transcribe with
  NeMo Hypothesis unwrap; stop-before-SOS → undefined), ASR factory (en-US/en-CA gate,
  ETCO_server_parakeetUrl, injectable provider for tests), hint cleaning ($YESNO expansion +
  global "jibo" + dedupe), StringNormalizer + vendored stringNormalizationMap.json,
  listenTransaction._performASR per the reference (sosTimeout/maxSpeechTimeout annotations,
  40 s budget, GARBAGE short-circuit, transcript normalization, push-style audio into the
  live session with pre-session buffering), TIMEOUT_ASR/ASR HubErrorCodes. Sim: the
  /__cloud-ws proxy already relays binary; harness streams robot-style PCM (LISTEN no mode +
  100 ms binary chunks + trailing silence) against a mock Parakeet — SOS with REAL timing,
  EOS from VAD, transcript routed to @be/clock. Browser: 🎤 mic button in the chat panel →
  voice-turn → hub-bridge streams getUserMedia audio (downsampled 16 kHz Int16, ~100 ms
  frames) on the turn WS; transcript echoes into the chat. 117 unit (+6) + 41 proxy checks
  (+4 audio) green. Live transcription needs a Parakeet /transcribe host
  (ETCO_server_parakeetUrl; the reference LAN host 192.168.1.252:6972 is currently down).

- 2026-06-10 — **Phase C closure: full corpus D3 98.2% / D4 96.8% — plateau reached.** The
  factory-entity run confirms stability (+3 vs prior; factories mainly fix entity VALUES,
  which D3/D4 don't grade). All substantive Phase C items are done; remaining 329 misses are
  3-12-utterance micro-classes. Next per PARITY.md: Phase D (server-side ASR, M8) — awaiting
  go-ahead, since the phase order was user-directed.

- 2026-06-10 — **Parser wire items (Phase A leftovers): GET /state + 400 on malformed parse
  requests.** /state returns the reference ServiceStateData shape (RUNNING/CONNECTED/CLOSED/
  llm READY|DISABLED); POST /v1/parse now 400s when data.text isn't a string (reference
  ParseRequestHandler) instead of coercing to ''. 111 unit + 37 proxy green.

- 2026-06-10 — **Factory entities: real reference vocabularies extracted from the FST
  binaries (Phase C).** Wrote a pure-python OpenFST vector-format decoder (header + embedded
  SymbolTables + state/arc records) and enumerated the finite factory languages straight from
  the jibo-nlu build data: first_name 6,008 · last_name 20,027 · music_genre 96 · country 269
  · state 84 · canada_province 16 — shipped as plain text in resources/factory-words/ (the
  combinatorial factories — date/time/timer/digits/year/city_state — keep the wildcard
  fallback). Matcher: `$factory:NAME` slots with a word list now match ONLY listed phrases
  (longest-first, spec = phrase length, `_<name>` sub-field + this._parsed capture); membership
  is a constraint, not a hint. "im sarah" → enrollment{GivenName:sarah} while "im hungry" →
  userIsDescriptor{GeneralDescriptor:Hungry}; "what time is it in france" → country=france;
  "play some jazz" → radio{station:Jazz}. Corpus sample holds at peak D3 99.3 / D4 99.1;
  111 unit + 37 proxy + oracle green.

- 2026-06-10 — **eq_words homophone matching wired (Phase C).** The vendored 1,913-set
  eq_words.txt (jibo-nlu build data) now backs literal compares in the matcher when a
  grammar declares `!use_equivalent_words = true` (they all do): canonical-representative
  map, lit + char-class sites, threaded per-skill via fullGrammar. "set a timer for TOO
  minutes" now parses like "two". Corpus sample ticked up to D3 99.3 / D4 99.1.
  111 unit (+2) + 37 proxy + oracle green.

- 2026-06-10 — **Wildcard arc costs crack the KU_CanYou family — sample D3 98.5→99.1, D4
  97.6→98.9; FULL corpus confirmed D3 98.1 / D4 96.8 (misses 397→331, largest class 12), with architecturally-correct pure-FST intra-grammar selection.**
  The queued wrapper-arm trace showed SeeThing losing to the GQA `$*` catch-all by 0.3:
  wildcards consumed tokens for free. The FST compiler charges per wildcard arc — added
  WILDCARD_TOKEN_COST (swept 0.4–1.0 on the corpus sample; plateau 0.6–0.8, locked 0.7).
  With wildcard arcs priced, intra-grammar selection is now pure spec−cost (no priority —
  matching the FST; the earlier regression from removing priority was THIS missing cost).
  Whole KU_CanYou<Action>Thing family now oracle-exact (SeeThing/MoveThing/AccessThing).
  Harness date assertion corrected to the reference behavior (today-suffixed date questions
  are GQA in the oracle too). 109 unit + 37 proxy + oracle green.

- 2026-06-09 — **Phase C session 1: `<W>` weights now attach FORWARD (entry weights).** In
  `can you ?(do|...) <1.0>+$w<0.0>` the `<1.0>` weights the `+$w` that follows, not the
  optional before it — trailing-attach let zero-matched optionals skip their cost. Fixed in
  parseItem (a WEIGHT followed by an item-starter is left as the next item's leading weight).
  Also EXPERIMENTED with removing priority from intra-grammar arm selection (pure FST
  spec−cost): NET REGRESSION (sample D3 98.5→95.5) — the TopRule wrapper arms encode more
  structure than single-rule traces suggest; reverted to priority-aware selection. Sample
  holds at D3 98.5 / D4 97.6. NEXT (queued): per-arm score dumps of the chitchat TopRule
  wrappers ($w03 $D_SR_HIGH_PRIORITY_STRICT vs $* $D_SR_MIXED_PRIORITY $*) to crack the
  KU_CanYou<Action>Thing family (the largest remaining D4 bucket, ~180 misses). 109 unit +
  37 proxy green.

- 2026-06-09 — **NLU stage unification — FULL corpus D3 97.9% / D4 96.1% (10,035 utterances; was 81.6/79.8).** The
  full-corpus run (10,035 utterances: D3 81.6%) revealed the dominant miss class was NOT the
  grammars — fullParse got "im hungry"→userIsDescriptor etc. RIGHT — but the legacy stages
  (sim-vendored who-am-i/clock grammars, no weights) short-circuiting in front of it with
  selfID/askForDay. Pipeline now mirrors the reference single-union: fullParse (real grammars,
  weights, priorities) FIRST; legacy launch/regex stages demoted to fallbacks. Divergences
  decided + ledgered: B6 GQA→answer-skill (chitchat's Wolfram deflector is dead; whoIsPerson/
  requestTellAboutThing/general* remap with person/thing entities), B7 requestWeather→
  requestWeatherPR (chitchat's weather deflector → straight to the report weather subskill).
  109 unit + 37 proxy green.

- 2026-06-09 — **PARITY.md master plan + corpus runner + FST weight scoring (sample D3
  83.8%→89.3%).** Full atlas/source/archive survey (3 subagent sweeps) synthesized into
  PARITY.md: subsystem matrix vs the reference, M0-M9 milestone status (M8 ASR = the big
  hole), and a phased plan (A wire fixes → B corpus → C NLU fidelity → D ASR → E skills
  framework → F compose/substitution). Built the corpus runner
  (packages/harness/src/corpusRunner.js): drives the vendored 4,705-entry test-manifest
  through in-process NLU + IntentRouter, grades D3 (intent) + D4 (memo.mim), writes a
  mismatch report. Its top miss class (41/45 = "can you dance"→requestDance instead of
  canJiboAction) was the dropped FST weights — lexer now emits `<N>`/`~N` as
  WEIGHT/TILDE, parser attaches item costs, matcher accumulates, arbitration =
  priority → (specificity − cost), which reproduces the binary's heuristic_score.
  "can you dance"→canJiboAction{Action:Dance} ✓ (oracle-exact), entity capture fixed
  most wrong-mim cases. 109 unit + 37 proxy checks green. Remaining long-tail in the
  corpus report: finer arm costs, factory entities, seasonal describeEvent intents.

- 2026-06-09 — **The real chitchat content library is live: 4,424 vendored MIMs + faithful
  dispatch.** Vendored the complete reference content (mims/chitchat: 4,369 scripted + 54
  emotion + CC_Fallback, semi_specific_categories CSVs ×66, report mims ×82, the 2,573-utterance
  test-manifest.json into harness/resources). chitchatSkill rewritten as a ProcessQueryNode
  port: gateway memo {mim,type} (already propagated by the IntentRouter from the matched
  manifest entry) → SemiSpecific stem resolution (entity value ∈ category CSV → sampled
  category) → scripted/emotion set validation → CC_Fallback on miss → Slimmer renders the
  real .mim (conditions + weighted pick + template → ESML with real <anim> tags).
  PromptData extended to the surface the library actually uses (measured): dt.now.isInRange
  (2,845 seasonal conditions), JiboData (emotion loose-string compare ×644, isBirthday, NLAge,
  zodiac, color), LooperData (referent.gender ×310, speaker.id, ages), loop.owner/list,
  skill.dice/coin. Bulk smoke: 4,364/4,369 MIMs (100%) render. GQA-deflector heuristic in the
  legacy regex stage (participant questions → chitchat, knowledge questions → answer-skill).
  Live: real jokes, coin flips with jiboji anims + template math, "how old are you" computes
  age from jibo.birthdate, "do you like pizza" → "I love the shape of pizza. It's so
  geometric." 109 unit, 37 proxy checks green.

- 2026-06-09 — **Skill responses now follow the launch intent (user browser-test feedback).**
  report-skill mirrors the reference IntentSplitNode: requestNews → news only, requestWeatherPR
  → weather only, requestCommute/requestCalendar → their subskills, full report ONLY on
  launchPersonalReport/proactive. chitchat-skill maps the common launch intents to their REAL
  reference MIM prompt text (RA_JBO_SpecificDance/Twerk/Beatbox/Sing, OI_JBO_IsHappy, …)
  including the embedded `<anim cat='dance' …/>` ESML (new esmlRaw flag in the JCP builder —
  skill-authored markup passes through; user text still escaped). Fixed "tell me a joke"
  shadowing (bare `tell me X` regex removed; jokes/stories now reach chitchat per the source).
  answer-skill's Gemma hook (ETCO_answer_llmUrl) plumbed through run-sim-stack.sh; no LLM
  endpoint found listening locally/pvindex, so the placeholder stays until one is pointed at it.
  107 unit (+9), 37 proxy checks (+5, incl. news≠report and dance/twerk in-character) green.

- 2026-06-09 — **NLU engine overhaul: full real grammars, `{% %}` actions, priority
  arbitration (76%→98% on a broad corpus).** Decided (with the user) to keep the NLU
  pure-JS and ship NO Jibo binaries: the real `jibo-nlu` `parse` binary is used only as an
  offline grading oracle (`packages/nlu/test/oracle/golden.jsonl`, captured from the 2018
  linux-x64 build over a 99-utterance corpus). Vendored the real grammar SOURCES (text) from
  the reference `rules_src` — chitchat (1045 rules), clock, hue-control, report, every
  be-skill, + globals/shared — and `eq_words.txt`, all under `packages/nlu/resources/`. Engine
  fixes: (a) lexer normalizes nbsp/curly quotes so all 20 grammars parse; (b) **`{% ... %}`
  semantic-action blocks are now parsed into entity tags** (`intent='gqa'`, `priority='HIGH'`,
  `Action='Dance'`, `key=this._parsed`) — previously discarded, which is why chitchat captured
  ZERO intents; (c) **priority-aware arbitration** (`HIGH > unset > LOW`, then heuristic score)
  so LOW catch-alls (`idle`, generic GQA) lose to specific intents. Added `fullGrammar.js` as a
  fallback NLU stage (additive — only matches what the legacy stages miss), so "sing me a
  song"/"i love you"/"turn on the lights"/"twerk"/"can you dance" now route. 98 unit tests
  (+6), sim proxy harness all green, no regression. Remaining: factory entity lists, `<weight>`
  scoring for HIGH-vs-HIGH ties, global-command strict-arm tuning, eq_words wiring.

- 2026-06-08 — **MIM→SLIM Slimmer — GraphSkill/MIM section complete; loop stopping.** Built the
  Slimmer (port of baseskill Slimmer): filter prompts by category/sub-category/index, node:vm
  condition eval against PromptData, weighted-random pick (injectable rng), ES6-template→ESML,
  listen from rule_name for question MIMs, NoMatch/NoInput max tracking; + PromptData builder +
  .mim loader + buildJcpFromSlim. Converted color-skill to drive its dialog from MIMs
  (color/qn.mim, color/an.mim). 91/91 unit (incl. Slimmer suite), proxy green. Remaining roadmap:
  server-side ASR (M8), corpus runner + D3/D4 diff levels — left for a future /loop.

- 2026-06-08 — **GraphSkill FSM + multi-turn sessions.** Built the skill graph framework
  (Node/FnNode, per-instance GraphManager with sequential nodeIDs = session.nodeID wire format,
  createGraphSkill handling LISTEN_LAUNCH→start / LISTEN_UPDATE→exit, transitions). Added a
  two-turn demo (color-skill: asks → final:false → resumes on LISTEN_UPDATE → final, using the
  spoken answer; session.data round-trips). Verified via the sim: launch asks (non-final), a
  follow-up answer "blue" resumes the session and replies mentioning blue. MIM→SLIM Slimmer is
  next. 86/86 unit, proxy green.

- 2026-06-08 — **Proactive channel + history wiring.** Gateway WS /proactive + /v1/proactive:
  TRIGGER+CONTEXT → collect manifest `proactives` → filter by contextRules (ported ContextTools:
  PART_OF_DAY/DAY_OF_WEEK/TRIGGER_SOURCE/FOCUSED_PERSON/person-counts) + IHRules (history IHQuery
  Count + time offsets via a new gateway HistoryClient) + settingsRules (permissive) → random pick
  → PROACTIVE match (final for on-robot) or PROACTIVE_LAUNCH → SKILL_ACTION. Also wired
  skill-launch history recording (recordLaunchHistory). Proxy asserts SURPRISE→report-skill (cloud,
  SKILL_ACTION) and NEW_ARRIVAL→@be/greetings (onRobot, final). 83/83 unit, proxy green.

- 2026-06-08 — **Atlas roadmap + report-skill raw-ASR launch.** Added ROADMAP.md: a complete
  atlas-derived feature checklist (per subsystem, [x]/[~]/[ ], checked off as built). First chunk:
  report-skill launch grammars (launchPersonalReport/requestWeatherPR/requestNews/requestCommute/
  requestCalendar) so report-skill launches from raw CLIENT_ASR; "tell me my personal report" →
  report-skill → Jibo speaks the briefing (browser). 83/83 unit, proxy green.

- 2026-06-08 — **LOOP GOAL MET — stopping.** Over this autonomous run: all 10 be-skills route,
  global-turn path, full M4 lasso (weather/news/maps/credential/calendar), and report+chitchat
  cloud skills. 83 unit + ~25 proxy checks + browser spot-checks all green. Next big items
  (server-side ASR M8, MIM/GraphSkill dialog engine) remain for a future loop.
- 2026-06-08 — **report-skill + chitchat-skill respond as cloud skills.** Skills service now
  multi-hosts by id (POST /v1/<id>/main); gateway registry gives each cloud skill a per-skill URL.
  report-skill speaks a weather+news briefing (via the data relays over NET_data, graceful
  fallback); chitchat-skill returns scripted SKILL_ACTIONs. Proxy asserts each returns its own
  SKILL_ACTION; browser spot-check (answer via new URL) green. 83/83 unit, proxy green.

- 2026-06-08 — **M4 lasso complete: credential CRUD + calendar.** Credential store
  (POST/GET/DELETE /v1/credential, testAuthCode bypass, dup-key, delete-other; fixed the
  `skillId =` assignment bug, DIVERGENCE B3) + calendar (/v1/{google,outlook}_calendar with
  CalendarEvent normalization + pluggable provider). All 5 lasso relays/services done
  (weather, news, maps, credential, calendar). 83/83 unit, proxy green.

- 2026-06-08 — **M4 maps/commute relay (OpenRouteService).** Ported GoogleMapsHandler: origin/dest
  JSON + mode → ORS profile → POST → re-shape to Google Maps `Maps` (routes[0].legs[0].duration
  {,_in_traffic}). GET/HEAD /v1/google_maps live (15m TTL, ETCO_data_orsKey). 3/5 lasso relays
  done (weather, news, maps). 74/74 unit, proxy green.

- 2026-06-08 — **M4 news relay (RSS→AP).** Ported APNewsHandler: sourceID→category→RSS feed
  (BBC/NPR), minimal RSS/Atom parse, re-emit AP-feed XML (apcm:ExtendedHeadLine + summary) as
  relayData via the relay framework (65m TTL). GET/HEAD /v1/ap_news live. 69/69 unit, proxy green.

- 2026-06-08 — **M4 data/lasso: weather relay (Open-Meteo).** Built the relay framework
  (validate→cache→HEAD prefetch→fetch→{relayData,lassoDataFromRedis} envelope, TTL cache) + the
  Open-Meteo→DarkSky weather handler (ported from DarkSkyHandler.ts, past_days=1, WMO→icon).
  GET/HEAD /v1/dark_sky live; news/maps/calendar/credential still stubs. 64/64 unit, proxy green.

- 2026-06-08 — **Global-turn path** (mimic_global_turn): a bare CLIENT_NLU/CLIENT_ASR with no
  LISTEN/CONTEXT now synthesizes a minimal listen+context and routes immediately instead of
  hanging until the 60s timeout. Proxy harness asserts a bare CLIENT_NLU routes to @be/clock.
  57/57 unit, proxy green.

- 2026-06-08 — **All 10 be-skills route against the server.** Fixed routing: launch grammars for
  main-menu/who-am-i/circuit-saver/ifttt emit only a `skill` entity (no manifest intent), so the
  IntentRouter now routes by the `skill` entity (matching the sim's own `match.skillID=ent.skill`),
  and the nlu keeps skill-entity-only matches. Proxy harness now verifies all 10 be-skills via raw
  CLIENT_ASR; browser spot-check confirms clock launches + Jibo speaks. 57/57 unit, proxy green.

- 2026-06-08 — Verified **gallery** be-skill launches via the browser ("show me the gallery" →
  skill-switch to @be/gallery). Enhanced the browser harness with skill-switch detection +
  an EXPECT_SKILL arg so screen-only be-skills (no speech) can be verified. 55/55 unit, proxy green.

- 2026-06-08 — Verified **greetings** be-skill launches via the browser ("hello jibo" → Jibo says
  "Hey ."). Locked in deterministic be-skill NLU+routing coverage from raw CLIENT_ASR (clock,
  greetings, gallery, create) in the proxy harness — 13 proxy checks green, 55/55 unit.

- 2026-06-08 — **be-skills launch through jibo-web-sim end to end.** Vendored the sim's
  launch-rule NLU engine + be-skill grammars into the gateway parser; gateway now routes raw
  CLIENT_ASR. Verified in the real browser sim: "what time is it" → @be/clock launches → Jibo
  speaks the time. Added two integration harnesses in jibo-web-sim/test/. 55/55 unit tests;
  both harnesses green. (phoenix 87daf9e, sim 75f9791)
- 2026-06-08 — Loaded the full skill registry (17 be-skills onRobot + 3 cloud) so the
  IntentRouter routes the real skill set. (phoenix cb95f69)
- 2026-06-08 — Implemented gateway (M6), nlu (M5), skills (M7), history (M3); robot-compatible
  WS listen path with a passing end-to-end test. (phoenix f5ae8c9, 624af44)

## How to test against the simulator

Gateway MUST listen on **9000** (the sim hard-codes the hub at `<server-field>:9000`); the sim's
Server field is the **host only** (e.g. `localhost`). Auth: the sim signs an HS256 Bearer JWT
with `HUB_AUTH_SECRET`; set the gateway's `ETCO_server_hubTokenSecret` to the same value.

```sh
# fast, deterministic (sim cloud-proxy level):
node /home/shell/jibo-web-sim/test/phoenix-be-skill.mjs
# full headless browser (loads jibo-be, asserts Jibo responds):
node /home/shell/jibo-web-sim/test/phoenix-browser.mjs '/skills/jibo-be' 'what time is it'
```

Both boot the Phoenix stack (gateway+nlu+skills) + the sim server themselves.

## Open / next

- Verify each of the 10 be-skill launch grammars launches via the browser harness (clock done).
- Cloud skills beyond answer-skill (report, chitchat) are routed to the skills service but only
  answer-skill is implemented (others fall through to the answer handler).
- M4 data/lasso still a shell; server-side ASR (M8); MIM/GraphSkill dialog engine.
- `mimic_global_turn` path (bare CLIENT_NLU, no LISTEN) not yet handled by the gateway.
