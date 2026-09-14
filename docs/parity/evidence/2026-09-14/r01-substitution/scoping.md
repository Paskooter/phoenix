# R-01 scoping — reference-client and service-substitution testing

Date: 2026-09-14
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Status: **scoping only — R-01 is not claimed or verified by this file.**

R-01 requires replacing one reference service at a time with Phoenix and
running the original client/fixture scenarios without changing callers, URLs or
request shapes. This file records what root established about feasibility
before designing that harness, so a later agent does not have to rediscover it.

## Can the original services run here?

Partly, and the boundary matters.

The prepared reference tree carries its own vendored root `node_modules` (328
entries) and compiled `lib/` output (`parity-prepared.json` records a relocated
lockfile with 1,443 relocated URLs; `parity-compiled.json` records the
`v8.9.4` / TypeScript 2.5.3 transpile). Original modules therefore load under
`node:8.9.4-slim` against that tree.

Root booted each service directly from `packages/<svc>/scripts/run-service.js`
in `node:8.9.4-slim` with the reference compose environment:

| original service | result |
| --- | --- |
| `hub` | **boots, `/healthcheck` 200** |
| `history` | boots; `/healthcheck` 500 — `MongoDB - DISCONNECTED`, needs the `docker-compose-history-db.yml` mongo |
| `lasso` | exits 1 — `Required env variable 'ETCO_lasso_darkSkyKey' does not exist` |
| `parser` | exits 1 — its `robust-parser` subprocess reports "NLU service is ready", then `RobustParserClient` fails its DialogFlow `axios.post` |

The parser's failure is not configuration. It depends on DialogFlow, and
lasso's providers (DarkSky, Google, AP) are likewise dead third-party
endpoints. **A live all-original stack is not reachable for the cloud-backed
services**, and no amount of environment fixes will change that.

## The original suite already solved this

`packages/integration-tests-int` does not run against compose at all. It starts
services **in process on OS-allocated ports** and stubs every cloud dependency:

- `src/utils/integration.ts` `startParser` constructs one `ParserService`;
  `startHub(config)` allocates `[exampleSkillPort, hubPort, historyPort]`,
  starts an in-process example skill, and builds `HubService` with
  `parser.baseURL = http://localhost:${parserPort}` and
  `history.baseURL = http://localhost:${historyPort}`.
- Cloud and store dependencies are stubbed: `mockgoose` (in-memory mongo on
  27018), `nock`, `fakeredis`, and recorded provider fixtures from
  `@jibo/test-utils` (`darkSkyTodayData`, `googleMapsMontrealData`,
  `apNewsXMLResponse`).

That `baseURL` wiring is the substitution seam R-01 asks for: pointing
`parser.baseURL` or `history.baseURL` at a Phoenix service, while the original
hub and the original test cases stay untouched, is exactly "replace one
reference service at a time without changing callers, URLs or request shapes".

## Case inventory

`integration-tests-int` — 8 files, 14 `describe` blocks, **25 `it()` cases**:

| file | cases |
| --- | --- |
| `listen.test.ts` | 4 |
| `personal-report.test.ts` | 4 |
| `listen-with-client-nlu.test.ts` | 2 |
| `listen-with-agents.test.ts` | 2 |
| `proactive.test.ts` | 2 |
| `hub-client-cli.test.ts` | 3 |
| `lasso.test.ts` | 6 |
| `listen-with-simulated-asr.test.ts` | 2 |

Run path: `mocha -r ts-node/register ./tests/index.js` → `src/index.ts`, which
owns the global `before`/`after` and requires all eight files. Note the root
`package.json` workspaces list excludes `integration-tests-int`,
`integration-tests-ext` and `hub-client-cli`, so root `yarn test` never runs
them via lerna.

`integration-tests-ext` contains no `*.test.*` files; its cases live in
`tests/{chitchat,personal-report,answer,proactive}.ts`. Inventory pending.

## Compose contract

Phoenix's `docker-compose.yml` was already written against the reference
contract — same service names, same host ports, same `NET_*`/`ETCO_*` wiring —
explicitly for substitution. The reference wires peers by container DNS
(`NET_parser=parser:8080`, `NET_history=history:8080`) with each service on
container port 8080, so a single container can be swapped without touching any
caller.

One known divergence to carry into any side-effect comparison: Phoenix has no
redis/mongo and keeps its stores in memory by design (see `DIVERGENCES.md`),
while the original `history` requires mongo and `lasso` uses redis.

## Open questions for the harness design

1. Which services can be substituted with a *live* original counterpart on the
   other side (hub yes; history with mongo; parser and lasso only against
   stubbed providers).
2. Whether the 25 in-process cases, run unchanged with one Phoenix service
   swapped in, are the right primary evidence, with the compose contract check
   as a secondary lane.
3. How to capture the HTTP/WS/JCP/speech/history/data side effects per case so
   original-vs-Phoenix comparison is exact rather than pass/fail.

No harness has been built and no case has been run against a substituted
service yet. R-01 remains `todo`.
