# H-09 — each skill process at the reference `/v1/main` URL

Pinned reference: Pegasus `5c0a7390539663ba749d360de348a428c088505c`
(`packages/baseskill/src/SkillService.ts`, `packages/utils/src/service/BaseService.ts`,
`packages/report-skill/scripts/run-service.js`, `packages/chitchat-skill/scripts/run-service.js`,
`packages/example-skill/scripts/run-service.js`, `packages/template-skill/scripts/run-service.js`),
executed under the archived `node:8.9.4-slim`
(`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).

## The reference contract

A cloud skill is an independently deployed process. `SkillService`
(`SkillService.ts:8-20`) hosts **exactly one** `BaseSkill` and registers it at
`POST /v1/main` with `authenticationRequired: false`:

```
this.addHttpHandler('/v1/main', { handler: skillV1, authenticationRequired: false });
```

`BaseService` adds only `GET /healthcheck` before it (`BaseService.ts:123-126`) and a
terminal `404 URL not found: <path>` + error-envelope handler (`BaseService.ts:313-323`).
The hub reaches each process at `http://<baseURL><basePath>/v1/main`
(`packages/gateway/src/registry.js:38-40`; the bundled manifests declare no `basePath`,
so the reference URL is literally `http://report-skill:8080/v1/main`).

## Method

Two receipts are produced and diffed cell-by-cell:

* `source-skill-main-url.cjs` — runs the **pinned original** `SkillService` /
  `BaseSkill` under Node 8.9.4 with a controlled `EchoSkill` that echoes the decorated
  request (jibo headers + parsed body), and drives eight probes. →
  `source-skill-main-url.json`
* `phoenix-skill-main-url.mjs` — drives the **real Phoenix** skill host
  (`packages/skills/src/skillService.js` `createSkillService`) with the same
  controlled handler and the same probes, then starts every real per-skill process and
  records its `/v1/main` identity. → `phoenix-skill-main-url.json`
* `native-entrypoints.mjs` — starts every skill process through the **real executable
  entrypoint** (`node packages/skills/src/index.js` + `PHOENIX_SKILL_ID`) exactly as
  `docker-compose.yml` / `scripts/run-compose-stack.sh` do, and records the `/v1/main`
  and `/v1/<id>/main` identity. → `native-entrypoints.json`
* `compose-services.json` — `docker compose config --format json` view of the
  per-skill services (command + `PHOENIX_SKILL_ID` + published port).

```sh
docker run --rm --network none -v "$PWD:/review" \
  -v /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro \
  node:8.9.4-slim node /review/source-skill-main-url.cjs /runtime /review/source-skill-main-url.json
node phoenix-skill-main-url.mjs phoenix-skill-main-url.json
node native-entrypoints.mjs native-entrypoints.json
python3 compare.py
```

`python3 compare.py` prints `DIFFS (0)` with 0 runtime-identity mismatches.

## Verified contract (all observed on both runtimes)

| Probe | Original | Phoenix |
| --- | --- | --- |
| `POST /v1/main` | 200 `SKILL_ACTION`, `data.skill.id` = the hosted skill | ✅ identical |
| Request decoration | `req.jibo.transID/robotID` from `x-jibo-*`; `loggingConfig` defaults `'{}'` | ✅ identical |
| `POST /v1/main` (handler throws) | 200 `ERROR` `{message, skill:{id}}`, **no** `timings` | ✅ identical |
| `GET /v1/main` | 404 `ERROR {final:true,data:{message:'URL not found: /v1/main'}}` | ✅ identical |
| `POST /v1/unknown` | 404 `ERROR {…'URL not found: /v1/unknown'}` | ✅ identical |
| `GET /healthcheck` | 200 `ok` (text) | ✅ identical |
| `POST /v1/main` `text/plain` | 200, `req.body === {}` (json parser skipped) | ✅ identical |
| `POST /v1/main` malformed JSON | 400 `ERROR {…'Unexpected token n in JSON at position 1'}` | ✅ identical (Node-8 wording localized) |
| `POST /v1/<id>/main` | **404** — the reference has no alias | **200** — intentional Phoenix alias superset |

## Independently deployed skill processes (runtime)

`node packages/skills/src/index.js` with `PHOENIX_SKILL_ID=<id>` serves that skill at
`/v1/main` and at `/v1/<id>/main`; a selected host returns 404 for another skill's
alias. Observed for all six processes: `answer-skill`, `report-skill`, `chitchat-skill`,
`color-skill`, `example-skill`, `template-skill`.

## Divergences found and fixed

### 1. Declared skill processes had no launcher (the P13 residue)

`color-skill` is declared by **both** bundled registries —
`skills-phoenix.json` (`http://color-skill:8080`) and `skills-native.json`
(`http://localhost:9008`) — but neither `docker-compose.yml` nor
`scripts/run-compose-stack.sh` started it, so the hub's `/v1/main` URL for color-skill
had no listener. `example-skill` and `template-skill` (the reference's skeleton /
exerciser packages, each with its own `scripts/run-service.js`) were not startable
either.

Fix — `docker-compose.yml` gains `color-skill` (9008), `example-skill` (9013) and
`template-skill` (9014) services, and `scripts/run-compose-stack.sh` starts the same
three native processes with the identical command/`PHOENIX_SKILL_ID` contract. Ports
9008/9013/9014 are the next free reference-shaped host ports after `classic:9012`.
`scripts/verify-compose-contract.mjs` now checks all six per-skill hosts at
`/v1/main`.

### 2. Selected-host coverage was limited to answer/report/chitchat

`packages/skills/test/start.test.js` proved `/v1/main` identity for only three of the
six deployable skills. Extended to answer/report/chitchat/color/example/template, plus
the namespaced alias on both a selected host and the shared host, plus cross-skill
alias isolation.

## Intentional differences from the reference

* `POST /v1/<id>/main` exists only in Phoenix. It is the URL form the Phoenix gateway
  registry addresses when a single shared host is used (`registry.js:41`); keeping it
  means callers need no change. The reference registers only `/v1/main`.
* `example-skill` / `template-skill` have no registry index entry (the reference
  `skills-local.json` / `skills-pegasus1,2.json` never routed to them either); they are
  deployable processes only.

## Falsification

Broken full line — `packages/skills/src/index.js:190`:

```js
  return SKILLS.find((skill) => skill.id === skillId);
```

mutated to `return SKILLS.find((skill) => skill.id === 'answer-skill');` (the
`createSelectedSkill` fallback, which selects every skill without an explicit branch).
Caught by `packages/skills/test/start.test.js`:

* `PHOENIX_SKILL_ID selects the real skill at /v1/main` — `AssertionError`, detail
  `color-skill/response identity`, `expected: 'color-skill'`, `actual: 'answer-skill'`.
* `each selected host retains its namespaced /v1/<id>/main alias` — `AssertionError`,
  `expected: 200`, `actual: 404`.

Restored; `git diff` for the file is empty and the suite is green (5/5).

## Not verified / open

* `docker compose up` was validated with `docker compose config` only; this host ran
  another stack, so the native launcher was exercised with isolated ephemeral ports
  rather than the reference ports (see `native-entrypoints.json` `portBase`/`probePort`).
* The reference `SkillService` sets the log namespace from `skillV1.name`
  (`BaseService.ts:113-119`); Phoenix's executable passes `PersonalReportSkill` only for
  report-skill (`packages/skills/src/index.js:266-268`). Log-only, not wire-observable.
* Not exercised: a deployed robot reaching a per-skill container through a real load
  balancer.
