# Phoenix worklog

Newest first. One line per verified increment (autonomous loop appends here).

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
