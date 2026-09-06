# C-03 — Gateway registry and configuration

Status: candidate awaiting final root integration checks. C-03 remains open.

This slice restores complete skill manifests, original URL composition and
validation, concurrent manifest loading, and the original robot-specific skill
list routes. Broken indexes/manifests now fail startup. Missing `baseURL` no
longer silently makes a cloud skill an on-robot skill. The manager freezes each
entry before validation, replaces duplicate IDs without changing insertion
order, and supplies the resulting registry to routing and proactivity.

The bundled `skills-local.json` and its 21 manifests now match Pegasus
`5c0a7390539663ba749d360de348a428c088505c` byte for byte, including the original
`answer` and `news` registrations. The prior Phoenix deployment index remains
available as `skills-phoenix.json`; `NET_skills` explicitly selects that shared
host profile unless `ETCO_hub_skillsConfig` names another index. This adapter
routes cloud skills to `/v1/<id>/main`. Omitting it retains the source
`baseURL/basePath/v1/main` behavior. NET parser/history/settings authorities,
default hosts, exact `true` flags and launch-history default now follow the
source. The existing ETCO URL aliases remain deployment extensions.

Gateway registry/configuration loading and `createGateway` are now asynchronous;
all repository callers await them. A `rootPath` loader option accepts an
unchanged original hub package layout. Bare `/skills` and `/v1/skills` remain
Phoenix discovery extensions. The four original robot-specific routes return
full manifests; the two Settings variants filter by truthy `settings` metadata.

## Evidence

The root differential executes the actual original `HubService` constructor,
`BaseService`, `HubConfigProvider`, validators and HTTP handler on Node 8.9.4,
with original TypeScript 2.5.3 CommonJS emission and the pinned original
dependencies. It does not substitute handlers, validators or HTTP middleware.
This is source-module execution, not a claim that the historical Gulp release
build has been reproduced. The original gRPC 1.7.3 ABI-57 addon was restored
from its package's declared publisher URL; its observed digest is retained.
Both servers run on ephemeral loopback ports, with the original container's
external network disabled. No robot is used by these probes.

`scripts/parity-reference/gateway-registry-{original.cjs,candidate.mjs,compare.mjs}`
produce and compare 102 manager/validation cases, 28 registry cases, seven
environment cases, the unchanged original index, and 19 real HTTP cases.
The comparison has **161/161 checks matching**, including case/encoded-path
handling, HEAD/OPTIONS, 404, malformed JSON, ignored Authorization on public
skill lists, and conditional ETag behavior. It preserves body key order and
all headers except Date. Error UUID/timestamp values are normalized; their
ETags are independently checked against the complete raw response bytes.
Only temporary fixture directories are normalized in file errors.

`packages/gateway/test/fixtures/registry-original.json.gz` retains the complete
original observation and drives the permanent regression test. Separate tests
cover the explicit shared-host adapter and actual startup rejection.

Earlier captures are retained privately: missing native dependency caused two
incomplete original runs, and a five-second observation deadline expired on a
third run during heavy VM disk I/O. The subsequent 30-second observation
budget is a probe bound, not a claim about service latency. A pre-correction
comparison recorded the null-manifest TypeError wording difference.

Root owns final acceptance and public review evidence. Full C-03 still needs
the report `NET_lasso`/`prefsFromConfig` contract, other services' required
variables and CLI behavior, and deployments under original environment names.
The restored external skill registrations do not establish implementation or
availability of those services. Settings consumption, speech-history behavior,
and complete proactive filtering remain their own open parity work.
