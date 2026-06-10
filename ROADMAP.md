# Phoenix Roadmap (atlas-derived feature checklist)

Derived from the Pegasus atlas (`pegasus/docs/atlas/`). Every feature the reference implements,
grouped by subsystem, checked off as Phoenix gains it. The loop works top-to-bottom by priority,
always referencing the original source in `/home/shell/work/pegasus` and verifying on the
jibo-web-sim. `[x]` done · `[~]` partial · `[ ]` todo.

Legend of verification: **U**=unit (`npm test`), **P**=proxy harness
(`jibo-web-sim/test/phoenix-be-skill.mjs`), **B**=browser e2e (`phoenix-browser.mjs`).

## Contracts (`@phoenix/contracts`) — interfaces.md
- [x] BaseMessage / BaseResponse envelope (type/msgID/ts/data, final/timings) — U
- [x] Message-type registries (request / response / skill request+response) — U
- [x] Request schemas: LISTEN, CONTEXT, CLIENT_ASR, CLIENT_NLU — U
- [x] NLU request + NLUResult schemas — U
- [x] SkillRequest (LISTEN_LAUNCH/UPDATE/PROACTIVE_LAUNCH) + SkillResponse (SKILL_ACTION/REDIRECT/ERROR) — U
- [x] LISTEN response, SOS/EOS, ERROR, trace headers, timeouts, HubErrorCode — U
- [ ] Proactive message schemas (TRIGGER, PROACTIVE, ProactiveResponse.match)
- [ ] JCP/SLIM behavior schema (validate the action tree, not just build it)
- [ ] MIM types (MimConfig / Prompt) for the dialog engine

## Shared libs (`@phoenix/common`) — utils.md
- [x] NET_/ETCO_ discovery (null-default = required-throws) — U
- [x] Zero-dep HTTP service runner + free /healthcheck + ERROR envelope — U
- [x] HS256 JWT sign/verify (robot-compatible) — U
- [x] Trace-header propagation (x-jibo-transid/robotid/logging-config) — U
- [x] Structured logger honoring per-request logging-config — U

## Gateway (`@phoenix/gateway` = hub) — hub.md, message-protocol.md
- [x] WS /listen + /v1/listen upgrade; JWT auth; ETCO_hub_disableAuth + anonymous identity — U/P/B
- [x] SocketMessageReader (text=JSON, binary=audio) — U/P/B
- [x] ResponseWrapper (auto timings, close-after-final 2s, max-duration 3min) — U
- [x] Listen state machine WAIT_LISTEN→(ASR|CLIENT_ASR|CLIENT_NLU)→NLU→ROUTE→DONE + timeouts — U/P
- [x] CONTEXT preprocess (identity defaults, loop-name trim, validateGeneralData) — U/P
- [x] Intent router: decision tree, launch-rule gate, entity EXACT/NOT/wildcard weights — U/P
- [x] Launch-by-skill-entity routing (be-skills with no manifest intent) — U/P
- [x] Skill dispatch (LISTEN_LAUNCH/UPDATE), SKILL_ACTION passthrough verbatim — U/P/B
- [x] SKILL_REDIRECT notify + one-redirect-max — U
- [x] Global turn (bare CLIENT_NLU, mimic_global_turn) — P
- [x] GET /v1/skills skill list — (smoke)
- [x] LISTEN_UPDATE in-progress-skill fallback (routes to the in-progress skill; multi-turn proven) — P
- [ ] Server-side ASR drive: Parakeet REST + hub energy-VAD (SOS/EOS, GARBAGE short-circuit) — M8
- [~] Skill-launch history recording (recordLaunchHistory → history svc) done; speech-history recording todo
- [ ] DecisionMediator (release-version decision overrides) — reference has it; mostly dead
- [x] **Proactive channel** /v1/proactive + /proactive: TRIGGER+CONTEXT → filter pipeline → PROACTIVE / PROACTIVE_LAUNCH — P
  - [x] eligible PR collection from manifest `proactives`
  - [x] contextRules filter (PART_OF_DAY, DAY_OF_WEEK, TRIGGER_SOURCE, FOCUSED_PERSON, person counts)
  - [x] IHRules filter (history IHQuery: Count + time offsets, evaluated against the history svc)
  - [x] settingsRules filter (settings service is dead → permissive stub)
  - [x] random selection + skipSurprises + PROACTIVE_LAUNCH dispatch

## Parser (`@phoenix/nlu`) — parser.md
- [x] POST /v1/parse → NLUResult; lowercase/trim; no-match shape — U/P
- [x] Launch-rule grammar engine (vendored sim engine) for be-skills + factory grammars — U/P
- [x] Question-intent grammar (answer-skill general* intents) — U/P
- [x] LLM fallback client (LM Studio/Gemma tool-calling), off unless ETCO_parser_llmUrl — U
- [x] Cloud-skill launch grammars (report-skill: personal report / weather / news / commute / calendar) — U/P/B
- [x] **Full real-grammar stage** (`fullGrammar.js`): every vendored Jibo launch grammar (chitchat 1045 rules, hue-control, report, all be-skills + globals/shared) parsed by the pure-JS engine — U/P
- [x] **`{% ... %}` semantic-action blocks** parsed into entity tags (intent/priority/Action/`this._parsed`) — was the reason chitchat captured zero intents — U
- [x] **Priority arbitration** (HIGH > unset > LOW, then heuristic score) — LOW catch-alls (idle/generic GQA) lose to specific intents — U
- [x] **Oracle grading harness** (`test/oracle/`): real `jibo-nlu` binary captures golden NLParse; grader scores parity (98% intent on the broad corpus). NO binary ships — oracle is dev-only.
- [ ] Factory entity lists ($first_name/$city/$music_genre/… from public datasets) — currently 1–3-word wildcard fallback
- [ ] `<weight>` / `~weight` scoring for HIGH-vs-HIGH ties (e.g. report-calendar vs chitchat-tell-about)
- [ ] Global-command TopRules (stop/volume/sleep/GUI-nav) — strict-arm tuning so they don't over-trigger
- [ ] eq_words homophone expansion wired into the matcher (vendored, not yet applied)
- [ ] LoopMemberDetector (resolve looper names → IDs, inject loopMemberReferent)
- [ ] Broader intent coverage toward the 354-intent manifest

## Data / lasso (`@phoenix/data`) — lasso.md
- [x] Relay framework (validate→cache→HEAD-prefetch→{relayData,lassoDataFromRedis}→TTL) — U
- [x] Weather (Open-Meteo→DarkSky) /v1/dark_sky — U
- [x] News (RSS→AP XML) /v1/ap_news — U
- [x] Maps/commute (ORS→GoogleMaps) /v1/google_maps — U
- [x] Credential CRUD /v1/credential (testAuthCode, dup-key, delete-other [B3 fix], wildcards) — U
- [x] Calendar /v1/{google,outlook}_calendar (validate + CalendarEvent normalize + pluggable provider) — U
- [ ] News hourly poller pre-warming 11 categories
- [ ] Real Google/Outlook OAuth token exchange (currently 501)

## History (`@phoenix/history`) — history.md
- [x] skill-launch write / latest / count; speech write+partial-update — U
- [x] IH query language (field rules + payload rules, EXACT-via-payload-key-count) — U
- [x] 14-day TTL, latest-by-insertion-order, null-not-404 — U
- [x] IHQuery Count type + start/end time offsets (gateway-side query build; needed by proactive IHRules) — P
- [x] Wire into the gateway (launch recording; proactive IH queries) — P

## Skills + framework (`@phoenix/skills` = baseskill + skills) — baseskill.md, skills.md
- [x] Skill service host (multi-skill by id, /v1/<id>/main) + SkillRequest validation + error envelope — U/P
- [x] JCP/SLIM SKILL_ACTION builder (wire-faithful) — U
- [x] answer-skill (Wikipedia+Gemma optional, always-final) — U/P/B
- [x] report-skill (weather+news briefing via lasso relays) — U/P
- [x] chitchat-skill (scripted SKILL_ACTION) — U/P
- [x] **GraphSkill FSM** (Node enter/exit, per-instance GraphManager sequential nodeIDs = wire format, transitions) — U/P
- [x] **MIM→SLIM Slimmer** (prompt filter by category/sub-category/index, vm-eval condition, weighted pick, template→ESML, listen from rule_name, NoMatch/NoInput max) — U/P
- [x] Multi-turn sessions (LISTEN_UPDATE, resume at session.nodeID, session.data round-trip; color-skill demo) — U/P
- [x] **chitchat real MIM dispatch** — full vendored library (4,369 scripted + 54 emotion +
  CC_Fallback + 66 semi-specific CSVs); ProcessQueryNode port (memo→mim, semi-specific stem
  resolution, set validation, fallback); PromptData extended to the measured library surface
  (dt.now.isInRange, JiboData emotion/age/zodiac, LooperData, loop.owner, skill.dice/coin);
  4,364/4,369 render in bulk smoke — U/P (live-verified on the sim)
- [x] report-skill intent split (IntentSplitNode port: news/weather/commute/calendar single-subskill) — U/P
- [ ] report-skill subskills speak from the vendored report mims (82 files vendored; wiring todo:
  weather comments, news intros, commute/calendar dialog per MimLogic)
- [ ] SKILL_REDIRECT emitted by a skill
- [ ] OptIn factory
- [ ] example/template reference skills

## Proactive (cross-cutting) — covered under Gateway above

## Verification (`@phoenix/harness`) — verification-strategy.md
- [x] Message normalize + stream diff (D1 sequence, D2 payload) — U
- [x] Proxy integration harness (sim /__cloud-ws, real JWT) — P
- [x] Browser e2e harness (jibo-be, skill-switch + speak detection) — B
- [ ] Corpus runner: test-manifest.json (2,573 utterances) at CLIENT_ASR
- [ ] Diff levels D3 (routing) / D4 (mim_id) / D5 (fuzzy ESML)
- [ ] Golden capture from the reference stack (M0)

## Runtime / build
- [x] npm workspaces, Node 20+, offline-installable (only `ws` external)
- [ ] docker-compose for the Phoenix stack (NET_* wiring) — optional
- [ ] Substitution testing against the reference compose — optional

---

### Current focus order (loop)
1. ~~Cloud-skill launch grammars (report-skill)~~ ✓ done.
2. ~~Proactive channel + history wiring (launch recording, IH queries)~~ ✓ done.
3. ~~GraphSkill FSM + MIM→SLIM + multi-turn sessions~~ ✓ done (GraphSkill/MIM section complete).
4. Server-side ASR (M8). ← next
5. Corpus runner + deeper diff levels.

See `WORKLOG.md` for the running log.
