# C-03 — Gateway registry and configuration

Status: root accepted this bounded slice. C-03 remains open.

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
host profile unless `ETCO_hub_skillsConfig` names an index. An explicit index
always preserves its per-entry URLs, even when `NET_skills` is also set. The
shared-host adapter routes cloud skills to `/v1/<id>/main`; source loading uses
`baseURL/basePath/v1/main`. Compose selects `skills-phoenix.json`, while the
native launcher uses `skills-native.json`. Both select answer/report/chitchat
with `PHOENIX_SKILL_ID` so each process serves its own skill at `/v1/main`.
An unknown selection fails startup; the unselected shared host remains available.
NET parser/history/settings authorities,
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
with original TypeScript 2.5.3 CommonJS emission and recorded dependency
versions. It does not substitute handlers, validators or HTTP middleware.
This is source-module execution, not a claim that the historical Gulp release
build has been reproduced. The original gRPC 1.7.3 ABI-57 addon was restored
from its package's declared publisher URL; its observed digest is retained.
Both servers run on ephemeral loopback ports, with the original container's
external network disabled. No robot is used by these probes.
The proof asserts contract source, compiled output, registry resources, the
addon and selected dependency metadata. It does not independently authenticate
every transitive dependency body or reproduce the historical release bundle.

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
original observation and drives the permanent regression test. Its adjacent
provenance file binds its checksum to the source proof and capture scripts.
The test checks those checksums and ordered, unique case IDs. Separate tests
cover the explicit shared-host adapter and actual startup rejection.

The [root review](../evidence/2026-09-06/gateway-registry/review.json) links the
fresh 161/161 integrated comparison, 47 direct source/resource byte checks,
11 rejected comparator mutations and five rejected source/runtime pin
mutations. All 420 integrated unit tests pass, including real HTTP per-skill
dispatch checks. Compose configuration and native shell syntax also pass.
The unchanged-scope strict production smoke still fails with 659 differences;
there are no new failing paths, and two values within one existing failure
change from the Phoenix `answer-skill` registration to the original `answer`.

Earlier captures are retained privately: missing native dependency caused two
incomplete original runs, and a five-second observation deadline expired on a
third run during heavy VM disk I/O. The subsequent 30-second observation
budget is a probe bound, not a claim about service latency. A pre-correction
comparison recorded the null-manifest TypeError wording difference.

An earlier whole-unit run also failed when the restored launch-history default
exposed a test using an existing History port. The test now hosts a real,
isolated History service; the failed and subsequent passing results are retained.

Full C-03 still needs
the report `NET_lasso`/`prefsFromConfig` contract, other services' required
variables and CLI behavior, and deployments under original environment names.
The restored external skill registrations do not establish implementation or
availability of those services. Settings consumption, speech-history behavior,
and complete proactive filtering remain their own open parity work.
