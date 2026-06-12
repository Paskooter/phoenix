# Phoenix

A **ground-up reimplementation** of *Pegasus* — the cloud backend that powered the Jibo social
robot's conversation (ASR → NLU → skills → multimodal response). Phoenix is a clean,
modern-JavaScript rewrite; the original is used only as a **behavioral reference**, never
copied, and **no Jibo binaries ship** — the NLU engine, MIM dialog engine and every service are
reimplemented, with only plain-text data vendored (grammars, MIMs, word lists, manifests).

- **Reference & specs:** [`jiboV2/pegasus@phoenix`](https://pvindex.org/gitea/jiboV2/pegasus) and
  its `docs/atlas/` (full system documentation + the rebuild plan this repo follows).
- **Stack:** Node.js ≥ 20, ESM JavaScript, npm workspaces, a single external dependency (`ws`).
  Tests use the built-in `node:test` runner.
- **Status: the rebuild is complete** (atlas milestones M1–M9, phases A–F). See
  **[M9-REPORT.md](M9-REPORT.md)** for the final parity report — headline numbers: **98.2 %**
  intent parity and **96.8 %** MIM-routing parity against the reference test corpus
  (10,035 utterances), 150 tests green, full wire-protocol conformance against the robot's own
  `hub-client` framing.

## What works

A robot (or the browser sim) connects over WebSocket, speaks — literally, over the microphone —
and the full pipeline runs: server-side ASR (energy VAD → Parakeet REST), the pure-JS
launch-rule grammar engine with FST weight semantics, intent routing, and the real skills:
the **personal report** (weather / news / commute / calendar with the original MIM condition
tables), **chitchat** (the full 4,424-MIM content library), **answer** (LLM-backed), plus the
proactive channel with the opt-in flow, multi-turn GraphSkill sessions, redirects and global
commands. Dead 2018 data vendors are shimmed live (Open-Meteo, RSS, OpenRouteService) behind
the original relay envelopes; every intentional deviation is logged in
[DIVERGENCES.md](DIVERGENCES.md).

## Layout

```
packages/
  contracts/   the frozen wire contracts — envelope, schemas, builders, validator
  common/      shared service scaffolding — env/service discovery, HTTP runner, JWT, logging
  harness/     verification — stream diff, corpus runner (D3/D4), SkillConversation + fixtures
  gateway/     hub — WS listen FSM, auth, server-side ASR (VAD+Parakeet), routing, proactive
  nlu/         parser — pure-JS grammar engine (FST semantics), eq_words, factory entities, LLM fallback
  data/        lasso — weather/news/maps/calendar relays (2026 shims) + credentials
  history/     skill-launch (IH query language) + speech history
  skills/      baseskill framework (GraphSkill, MIM factories, Slimmer, OptIn) + all skills
```

## Running it — without Docker

```bash
npm install        # links the workspaces (offline-friendly; only `ws` is external)
```

**Run the full server** — all seven services on the reference port layout, no containers:

```bash
bash scripts/run-compose-stack.sh
# hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005
# history 9006 · lasso 9007 · answer-skill 9009     (Ctrl-C stops everything)
```

Robots and clients connect to the hub at `ws://<host>:9000/listen` (HTTP API on the same
port: `GET /healthcheck`, `GET /v1/skills`). Logs land in `/tmp/phx-compose-*.log`.

Useful env, all optional:

| Variable | Effect |
|---|---|
| `PARAKEET_URL` | Parakeet ASR host for server-side speech recognition (`POST /transcribe`) |
| `LLM_URL`, `LLM_MODEL` | OpenAI-compatible endpoint (e.g. LM Studio) for the answer-skill + parser fallback |
| `HUB_TOKEN_SECRET` | JWT secret robots must sign with (default `dev-hub-token-secret`) |
| `DISABLE_AUTH` | defaults `true` for local use — set `false` to require robot JWTs |
| `PREFS_FROM_CONFIG` | `true` = personal-report prefs from `resources/report-prefsConfig.json` |

**Or run the sim stack** — the same services on dev ports **plus the browser simulator**
([jibo-web-sim](https://github.com/Paskooter/jibo-web-sim), expected as a sibling checkout),
the easiest way to actually talk to it:

```bash
bash scripts/run-sim-stack.sh
# then open http://localhost:8080  (or https://<host>:8443 for microphone access)
```

This launcher auto-detects the optional LAN services and degrades gracefully without them
(the ASR falls back to a mock that saves received audio to `/tmp/parakeet-rx`).

## Running it — with Docker

`docker-compose.yml` mirrors the reference deployment exactly — same service names, host
ports and `NET_*`/`ETCO_*` wiring, so each Phoenix service is a drop-in substitute for its
pegasus counterpart:

```bash
docker compose up
# hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005
# history 9006 · lasso 9007 · answer-skill 9009   (all 8080 inside the network)
node scripts/verify-compose-contract.mjs   # same contract check as the native runner
```

Optional env (LAN ASR/LLM, like the reference override file):

```bash
PARAKEET_URL=http://<host>:6972 LLM_URL=http://<host>:1234/v1 docker compose up
```

## Verification

The rebuild was driven by measurement, not vibes:

```bash
npm test                                      # unit + integration (all packages)
node packages/harness/src/corpusRunner.js     # D3/D4 parity over the 10,035-utterance corpus (~15 min)
node scripts/verify-compose-contract.mjs      # runtime/wire contract
../jibo-web-sim/test/phoenix-be-skill.mjs     # full WS protocol harness (turns, audio, proactive)
../jibo-web-sim/test/phoenix-voice-browser.mjs # real-browser mic -> server ASR e2e
```

Plus a dev-only oracle harness that grades the grammar engine against the surviving `jibo-nlu`
binary (the binary is never shipped). History: [WORKLOG.md](WORKLOG.md); plan + status:
[PARITY.md](PARITY.md) / [ROADMAP.md](ROADMAP.md); deviations: [DIVERGENCES.md](DIVERGENCES.md);
final report: [M9-REPORT.md](M9-REPORT.md).
