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

Those failures are about running the services **bare**. They do not carry over
to the original test suite, which is the correction that matters: the suite
intercepts every cloud call. `listen-with-agents.test.ts:47-56` nocks
DialogFlow at `https://api.api.ai:443`, and `lasso.test.ts:130-180` nocks the
Google and Microsoft calendar APIs. The parser failed for me only because I
booted it standalone with no interceptor in front of it.

So a **live all-original compose stack** is not reachable for the cloud-backed
services, but the original in-process suite runs fully offline, which is what
R-01 actually needs.

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

## The prepared tree cannot run the original suites as it stands

`parity-prepared.json` is explicit:

```json
"excludedWorkspaces": ["hub-client-cli", "integration-tests-ext", "integration-tests-int"],
"installProfile": "Production dependencies for 15 server/client/library workspaces; no lifecycle scripts or development dependencies"
```

Root confirmed the consequence directly: `mocha`, `ts-node` and `mockgoose` are
all absent from the vendored root `node_modules`. The prepared tree can run the
services — which is why the hub booted and why the S-13 source differential
works — but it cannot run the original test suites.

Extending the prepare pass looks feasible. `scripts/parity-reference/prepare.py`
routes Jibo-scoped packages to `https://pvindex.org/npm` and everything else to
`https://registry.npmjs.org`, and both are reachable from here
(`registry.npmjs.org/mocha` → 200, `pvindex.org/npm/` → 200). The suite's Jibo
dependencies are not a registry problem either: `@jibo/test-utils` and
`@jibo/hub` 404 on the archive because they are **workspace** packages present
in the tree (`packages/test-utils/` ships built `lib/`), so yarn links them
locally.

So the path is to add the three excluded workspaces and their development
dependencies to the prepare profile, keeping the existing relocation and
fixture-only registry adaptations, and to re-record the prepared manifest. That
is a change to a pinned, hashed reference artifact and must be done
deliberately, with the new install profile recorded alongside the old one.

## The substitution seam, exactly

`src/utils/integration.ts:65-79` constructs the original `hub.HubService` with
four configurable peers:

```ts
parser:   { baseURL: `http://localhost:${parserPort}` }   // in-process original ParserService
history:  { baseURL: `http://localhost:${historyPort}` }  // port allocated, no service started
skills:   hubSkills                                       // example skill URL rewritten to its port
settings: { baseURL: `http://settings.jibo.aws` }         // dead hostname, never reachable
```

That yields a practical substitution matrix of **parser, hub, and the skill
service**. `history` and `settings` are not genuinely exercised by these cases —
no history service is started and the settings host does not resolve — so any
R-01 claim must say so rather than implying five substitutable services.

## One relocation gap in the prepare profile

The first dev-dependency install attempt failed:

```
error ... "https://registry.npmjs.org/jsdoc-jibo/-/jsdoc-jibo-1.12.8.tgz: Request failed \"404 Not Found\""
```

`prepare.py:32` relocates names starting with `jibo-`, `@jibo/`, `@jibo-tools/`,
`@jiborobot/`, `@converseai/`, `@milashenko/`, `@perez/` and `@types/jibo-`.
`jsdoc-jibo` matches none of them, so it routed to npmjs.org, where it does not
exist. It is present on the archive (`pvindex.org/npm/jsdoc-jibo` → 200), and it
is the **only** lock entry containing "jibo" that resolves to npmjs.org, so the
gap is exactly one package. The production profile never hit it because it is a
development dependency.

Any real extension of the prepare profile must widen that predicate (or pin
this entry explicitly) and re-record the relocation count, which is currently
1,443.

With that one entry relocated, `yarn install --frozen-lockfile` completes
against the original lock in a `node:8.9.4-slim` container: 1,068 packages,
`mocha`, `ts-node`, `mockgoose`, `nock`, `sinon`, `chai` and `fakeredis` all
present, and `@jibo/hub`, `@jibo/parser`, `@jibo/test-utils` and
`@jibo/example-skill` linked as workspaces.

## Lifecycle scripts are load-bearing for this suite

The production profile records "no lifecycle scripts", and installing the test
workspaces the same way (`--ignore-scripts`) produces a suite that cannot load:

```
Cannot find module '/pegasus/node_modules/grpc/src/node/extension_binary/node-v57-linux-x64-glibc/grpc_node.node'
  at .../packages/hub/lib/asr/google/GoogleASRProvider.js:7:14
```

`grpc@1.7.3` needs its native extension, which `node-pre-gyp` fetches from
`storage.googleapis.com/grpc-precompiled-binaries`. That host is reachable and
the prebuilt `node-v57-linux-x64-glibc` binary installs cleanly, so this is
surmountable — but it means the extended profile is **not** simply the
production profile plus dev dependencies. It needs at least this one native
build step, and that step must be recorded as an adaptation rather than left
implicit.

## Proposed shape (not yet built)

1. Extend the reference prepare to install dev dependencies for
   `integration-tests-int` (and `-ext`, `hub-client-cli`), re-recording
   `parity-prepared.json`.
2. Establish an all-original baseline: run the 25 `integration-tests-int` cases
   unmodified against the in-process original stack with its own
   mockgoose/nock/fakeredis stubs, and record per-case results plus the
   HTTP/WS/JCP/history/data side effects.
3. Substitute one service at a time by pointing the corresponding `baseURL`
   (`parser`, `history`, and the skill URL) at a Phoenix service, leaving the
   original hub and the original cases untouched, and re-run the same 25 cases.
4. Run the all-Phoenix stack over the same scenarios.
5. Compare per case and publish exact counts, failures, missing cases and
   evidence revisions, with adversarial controls over the comparison itself.

Steps 2-5 are the real work and none of it has been done.

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
