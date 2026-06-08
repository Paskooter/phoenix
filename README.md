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
  gateway/     hub equivalent — WS listen/proactive, ASR+NLU orchestration, routing            [shell]
  nlu/         parser equivalent — grammar/FST match + LLM fallback                            [shell]
  data/        lasso equivalent — weather/news/calendar/commute relays + credentials           [shell]
  history/     skill-launch + speech history                                                   [shell]
  skills/      skill framework (GraphSkill/MIM) + concrete skills                              [shell]
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

Bootstrapped (this commit): the contract layer (M1) and the service-shell foundation (M2) are in
place and tested; the comparison harness core is usable. No conversational behavior is
implemented yet — the service shells return `NOT_IMPLEMENTED` for their primary endpoints.
