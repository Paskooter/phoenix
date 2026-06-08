# Phoenix

A **ground-up reimplementation** of *Pegasus* — the cloud backend that powered the Jibo social
robot's conversation (ASR → NLU → skills → multimodal response). Phoenix is a clean,
modern-JavaScript rewrite; the original is used only as a **behavioral reference**, never copied.

- **Reference & specs:** [`jiboV2/pegasus@phoenix`](https://pvindex.org/gitea/jiboV2/pegasus) and
  its `docs/atlas/` (full system documentation + the rebuild plan this repo follows).
- **Stack:** Node.js ≥ 20, ESM JavaScript, npm workspaces, zero runtime dependencies so far
  (validation, the service runner and the harness core are all hand-rolled). Tests use the
  built-in `node:test` runner.

## Layout

```
packages/
  contracts/   the frozen wire contracts — envelope, JSON-Schema defs, builders, validator   [implemented]
  common/      shared service scaffolding — env/service discovery, HTTP runner, logging        [implemented]
  harness/     old-vs-new comparison core — message normalize + stream diff                    [core implemented]
  gateway/     hub equivalent — WS listen, auth, state machine, routing, skill dispatch        [implemented (M6); server-ASR pending M8]
  nlu/         parser equivalent — grammar match + optional LLM fallback                       [implemented (M5)]
  data/        lasso equivalent — weather/news/calendar/commute relays + credentials           [shell (M4)]
  history/     skill-launch (IH query language) + speech history                               [implemented (M3)]
  skills/      skill host + answer-skill (wire-faithful JCP/SLIM)                              [implemented (M7); more skills + MIM pending]
```

Each service shell documents — inline — the exact contract it must fulfil (with `file:line`
references into the atlas) and the milestone that implements it. Every service exposes a free
`GET /healthcheck` today.

## Quick start

```bash
npm install           # links the workspaces; no network needed (zero external deps)
npm test              # runs contracts + common + harness suites via node:test
npm run start:history # boot a service shell; curl localhost:7013/healthcheck -> ok
```

Default local ports: gateway 7010, nlu 7011, data 7012, history 7013, skills 7014
(`packages/contracts/src/constants.js`). Override with `PORT`.

## How the rebuild proceeds

Contracts first, then a diff harness, then leaf services up to the gateway — each milestone has
hard "done-when" criteria and is validated by **substitution testing** (drop the new service
into the reference compose stack via `NET_<svc>` discovery and run the original suites against
it). See **[ROADMAP.md](ROADMAP.md)**. Intentional deviations from the reference are logged in
**[DIVERGENCES.md](DIVERGENCES.md)**.

## Status

The **robot-facing conversational path works end to end**: a robot (or the original
`@jibo/hub-client`) connects over WebSocket, authenticates, and one utterance flows
`gateway → nlu → answer-skill` back to a wire-faithful `SKILL_ACTION`. Implemented and tested
(51 tests, incl. an end-to-end WS test driving the gateway exactly as the robot does):

- **M1 contracts**, **M2 service runner**, **M3 history** (full IH query language),
  **M5 nlu** (grammar + optional LLM fallback), **M6 gateway** (listen state machine, JWT auth,
  routing, skill dispatch, passthrough, timeouts), **M7 skills** (answer-skill JCP/SLIM).
- Pending: **M4 data/lasso** (still a shell), **M6 server-side ASR** (audio streaming; M8),
  the MIM/GraphSkill dialog engine, and more skills.

Everything is referenced against the original source (`jiboV2/pegasus@phoenix`) to keep the wire
protocol compatible with unmodified robots.
