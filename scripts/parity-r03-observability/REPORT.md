# R-03 observability evidence lane

**Result: measured gap, not an R-03 pass.** The lane is bounded to trace propagation,
structured logging, healthcheck semantics, and the selected ETCO/PHOENIX configuration
surfaces. It does not edit `packages/*/src`, contact the live service, use hardware, or
run the repository-wide test sweep.

Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`.
Machine-readable measurements: [`evidence.json`](./evidence.json).

## Verified

### Trace propagation

`run.mjs` drives the real `ParserClient`, `HistoryClient`, and `SkillClient` against one
real local HTTP sink. The sink observed three requests:

```text
POST /v1/parse
POST /v1/speech
POST /
```

All three carried these exact values, byte-for-byte:

```text
x-jibo-transid: r03-trace-001
x-jibo-robotid: r03-robot-001
x-jibo-logging-config: {"gateway":"debug","history":"info"}
```

The source contract names the same three headers and describes them as data that adds
value to logging: [`interfaces/src/service.ts#L63-L71`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/interfaces/src/service.ts#L63-L71).
Phoenix's shared constants additionally state: `These MUST be propagated verbatim on
every internal HTTP call` (`packages/contracts/src/constants.js:125-131`). The measured
client boundary satisfies that claim for parser, history, and skill calls. This does
not claim that every outbound call in every package has been exercised.

### Logging

The Phoenix logger is `packages/common/src/log.js`. A real logger invocation produced
JSON records with these fields on every record:

```text
t, level, ns, msg
```

`transId` is added when a trace has one. `robotId` and `loggingConfig` are not emitted
automatically by the Phoenix JSON helper. A valid per-request config enabled the debug
record; a malformed config was ignored and did not crash the caller.

The pinned logger wrapper configures `ETCO_server_name`, `ETCO_server_structuredLogs`,
and `ETCO_server_logLevel`, then loads console/Pegasus output levels:
[`logging/Log.ts#L7-L25`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/logging/Log.ts#L7-L25).
Its structured logging config is loaded at
[`logging/Log.ts#L28-L51`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/logging/Log.ts#L28-L51).
The source request middleware explicitly puts both `transID` and `robotID` on the
request logger and parses `x-jibo-logging-config`:
[`BaseService.ts#L147-L155`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/BaseService.ts#L147-L155).

Therefore trace headers propagate in the tested HTTP clients, but Phoenix log output
is not a full source-log parity claim: its always-present JSON shape is smaller and its
process-level names are `LOG_LEVEL`/the namespace argument rather than the source's
`ETCO_server_*` logger configuration.

### Healthcheck liveness versus readiness

The real History service probe measured:

```text
GET /healthcheck before fault: 200, body "ok"
POST /v1/skill/launch before fault: 200
[injected store addSkillLaunch failure]
POST /v1/skill/launch after fault: 500
GET /healthcheck after fault: 200, body "ok"
falselyHealthy: true
```

The fault is injected at the store boundary, not by touching Mongo or a live service.
It proves the instrument can distinguish a failed store operation from a still-listening
HTTP process, and that Phoenix currently reports the latter as healthy.

A source inventory covered all eight `DefaultPort` service entrypoints (`gateway`,
`nlu`, `data`, `history`, `skills`, `account`, `classic`, `ota`). None supplies a
healthcheck override; `skills` and `ota` inherit `createService` through their wrapper
factories. The shared Phoenix route returns status 200 and sends `ok`.

The source route is installed at
[`BaseService.ts#L121-L126`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/BaseService.ts#L121-L126),
and the base implementation is explicitly `{ statusCode: 200, body: 'ok' }` at
[`BaseService.ts#L232-L237`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/service/BaseService.ts#L232-L237).
That is a liveness check: the process and HTTP loop are alive. It must not be described
as dependency readiness.

The pinned History subclass intentionally overrides that same path. It builds
`{status, skillLaunchDB, speechHistoryDB}`, changes `status` to `error` when a required
store is not `CONNECTED`, and returns 500 for error:
[`HistoryService.ts#L60-L76`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/history/src/HistoryService.ts#L60-L76).
That source endpoint is therefore a combined liveness/readiness signal, despite the
otherwise liveness-oriented path name. I-01b is a real observability divergence, not a
cosmetic response-shape difference.

### Configuration

Measured precedence and malformed-value behavior:

| Probe | Observed result |
|---|---|
| `readEnvVars` explicit ETCO value over default | `explicit` |
| empty ETCO value | default is used |
| source port default | `8080` |
| `ETCO_server_port=8123` | `8123` |
| `--port 8124` with `ETCO_server_port=8123` | `8124` |
| malformed `ETCO_server_port=not-a-port` | `NaN` (not a validated fallback) |
| Phoenix `PORT=8125` alias | `8125` |
| scoped `ETCO_parser_llmUrl` over `PHOENIX_LLM_URL` | scoped URL |
| malformed scoped LLM timeout with shared `PHOENIX_LLM_TIMEOUT_MS=6000` | silently becomes caller default `10000`; shared value is not consulted |
| malformed account verification timeout | throws `TypeError` |
| malformed AP news polling interval | falls back to `3600000` ms while polling remains enabled |
| empty gateway ETCO flags | source defaults (`disableAuth=false`, history/launch defaults) |

The pinned `readEnvVars` behavior is `process.env[key] || defaults[key]`, with null
defaults required and the result retained as a string:
[`EnvVars.ts#L7-L18`](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/utils/src/config/EnvVars.ts#L7-L18).
Phoenix's LLM resolver documents the ETCO-to-PHOENIX precedence at
`packages/contracts/src/llmProvider.js:23-35` and implements numeric parsing at
`:53-57` and timeout fallback at `:95-103`. The measured invalid scoped timeout is a
silent fallback, which is unsafe for an observability/reliability gate: it can run with
a timeout other than the operator intended without a startup failure or warning.

The gateway config measurement resolved `NET_parser=parser:9005` to
`http://parser:9005`, likewise for history/settings, and retained source ETCO defaults
for empty values. `DefaultPort` is Phoenix's local side-by-side fallback; the source
service CLI default is still 8080.

## Minimal healthcheck patch decision (not applied)

The task forbids edits under `packages/*/src`, so the following is the minimal patch
plan recorded rather than applied. It keeps liveness and readiness explicit:

| Service | Minimal source patch for `/healthcheck` | Semantics |
|---|---|---|
| gateway | None for source parity; keep inherited `200 ok`. Add a separate `/ready` only if deployment policy requires parser/history/settings peer readiness. | `/healthcheck` liveness; `/ready` dependency readiness. |
| nlu | None for source parity; keep inherited `200 ok`. Keep compiled-runtime failure from advertising startup, and use `/state`/a separate `/ready` for runtime readiness. | `/healthcheck` liveness. |
| data | None for source parity; keep inherited `200 ok`. Add `/ready` only for a required local store/upstream policy. | `/healthcheck` liveness. |
| **history** | **Required parity patch:** extend `createService` with an async health response hook that can return `{statusCode, body}`; pass a History callback that reports `skillLaunchDB`, `speechHistoryDB`, `status`, and 500 when a required state is not connected. Phoenix's current JSON store needs a small explicit state adapter; do not infer readiness from a successful past write. | Source `/healthcheck` is combined liveness/readiness; a separate `/ready` would be cleaner but is not the pinned wire behavior. |
| skills | None for source parity; keep inherited `200 ok`; add `/ready` only for a configured external provider/profile. | `/healthcheck` liveness. |
| account | None for source parity; keep inherited `200 ok`; add `/ready` if the deployment requires durable-store readiness. | `/healthcheck` liveness. |
| classic | None for source parity; keep inherited `200 ok`; add `/ready` for required account/OTA peers if policy demands it. | `/healthcheck` liveness. |
| ota | None for source parity; keep inherited `200 ok`; add `/ready` if catalog availability is a deployment prerequisite. | `/healthcheck` liveness. |

The common-hook shape is the smallest safe implementation: preserve the current
base default for seven services and let History supply the one source override. An
unapplied diff sketch is:

```diff
--- packages/common/src/service.js
+++ packages/common/src/service.js
@@
- *   healthcheckBody?: string | ((req: IncomingMessage) => string),
+ *   healthcheck?: (req: IncomingMessage) => Promise<{statusCode:number, body:any}> | {statusCode:number, body:any},
@@
-  healthcheckBody = 'ok',
+  healthcheck = async () => ({ statusCode: 200, body: 'ok' }),
@@
-  app.get('/healthcheck', (req, res) => {
-    const body = typeof healthcheckBody === 'function' ? healthcheckBody(req) : healthcheckBody;
-    return res.status(200).send(body);
+  app.get('/healthcheck', async (req, res, next) => {
+    try {
+      const response = await healthcheck(req);
+      return res.status(response.statusCode).send(response.body);
+    } catch (error) {
+      return next(error);
+    }
   });
--- packages/history/src/index.js
+++ packages/history/src/index.js
@@
-  return createService({ name: 'history', routes });
+  const healthcheck = () => {
+    const skillLaunchDB = store.getState('skillLaunch');
+    const speechHistoryDB = store.getState('speechHistory');
+    const status = skillLaunchDB === 'CONNECTED'
+      && speechHistoryDB === 'CONNECTED' ? 'ok' : 'error';
+    return { statusCode: status === 'ok' ? 200 : 500,
+      body: { status, skillLaunchDB, speechHistoryDB } };
+  };
+  return createService({ name: 'history', routes, healthcheck });
```

The actual state method/name must be supplied by Phoenix's store adapter; this is a
patch shape, not a claim that `getState` already exists. For gateway, nlu, data, skills,
account, classic, and ota the minimal patch is explicitly **no change** to their
source `createService` call: keep inherited liveness and add a separate `/ready` only
when deployment policy requires dependency readiness. Do not turn every liveness check into a peer check: a dead dependency should fail readiness,
while a process that is alive but waiting for a dependency should remain observable as
alive. The pinned History behavior is the deliberate exception that must be reproduced
for compatibility.

## Falsification

The lane's control is intentionally fail-capable. I temporarily changed the regression
assertion from `afterFault.status === 200` to `=== 503` and ran:

```text
node --test scripts/parity-r03-observability/run.test.mjs; rc=$?; printf 'falsification_exit=%s\n' "$rc"; test "$rc" -ne 0
```

It failed with `200 !== 503` and `falsification_exit=1`; restoring the assertion made
the named test pass. The runtime fault itself is the stronger falsification: the store
operation returned 500 while `/healthcheck` remained 200, so the probe can report the
unhealthy case instead of only demonstrating a healthy path.

## Unknown / not credited

- No live Mongo process was taken down; the health falsification is a controlled store
  fault at the real History HTTP route.
- No live Phoenix service on ports 29000/443, robot, Moth, or hardware was contacted.
- The eight-service inventory is source/static plus the real shared route; this lane did
  not boot all eight production entrypoints together.
- No HTTP disconnect, ASR, restart, queue saturation, sustained-memory, metrics, or
  pinned-reference runtime differential was measured here.
- The exact `jibo-log` renderer/output handler was not installed/run; the reference
  claims above are from the pinned wrapper/config source, while Phoenix fields are
  direct runtime observations.

## Exact commands and observed outputs

```text
node --test scripts/parity-r03-observability/run.test.mjs
# pass 1, fail 0, cancelled 0

node scripts/parity-r03-observability/run.mjs scripts/parity-r03-observability/evidence.json
# {"acceptance":"measured-gap","traceCalls":3,"loggerFields":["t","level","ns","msg"],"historyHealth":{"before":200,"afterFault":200,"writeAfterFault":500},"malformedLlmTimeout":10000}
```

The probe was captured at Phoenix revision `7ea406206b29c711a0c90123846db78f3d79d6e1`;
its generated receipt is the adjacent `evidence.json`.
