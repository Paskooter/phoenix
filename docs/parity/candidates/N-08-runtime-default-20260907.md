# N-08 parser runtime boundary and default assessment

Status: candidate unverified; source and implementation review only. This
candidate does not change parser code, the AST profile, the compiled profile,
graph payloads, goldens, the main worktree, or the robot.

The question for this slice was whether the original production NLU accepts
text grammars or compiled `VectorFST` data as part of a public operation, and
whether Phoenix should make its portable compiled-FST executor the global
default. The pinned source answers the first question precisely: the public
parser operation accepts an NLU request containing text and rule names. It does
not accept a grammar or FST payload. Text compilation and binary-FST loading
exist behind the native `nlu_interface`, which the public parser service does
not expose.

## Source contract

The original reference is revision
`5c0a7390539663ba749d360de348a428c088505c`. The source files used here were
hashed before the review; the private manifest is
`.parity/reviews/n08-runtime-default-20260907/source-manifest.json`.

`packages/interfaces/src/nlu.ts:32-44` defines the public request data as
`text`, `rules`, and optional `loop`/`external` fields. The public route is
registered by `packages/parser/src/ParserService.ts:52-58` as `POST
/v1/parse` and `GET /state`. `ParseRequestHandler.ts:25-47` validates the
request and trims text before asking the clients for a result; it has no
grammar or FST input field. The original Hub `ParserClient.ts:12-24` sends
exactly that NLU envelope to `/v1/parse`.

Startup is artifact based. `ParserService.ts:65-70,122-133` starts the native
process and initializes `RobustParserClient` before opening the public HTTP
listener. `RobustParserClient.ts:40-49` discovers configured FSTs and, when
`loadFSTs` is enabled, loads them. Its `loadFSTIntoMemory` and
`parseFromHandle` calls at `:188-210` send internal `COMPILE` with
`BINARYFST_PATH`, followed by `PARSE_FROM_URI` with a handle. The registry at
`packages/parser/src/utils/RulesRegistry.ts:33-51` globs configured
directories for existing `.fst` files; it does not compile source during a
public request.

The source build step is offline/deployment work. `packages/parser/src/cli/build-rules.ts:19-55`
invokes the native `grm2fst` compiler for every `rules_src/**/*.rule`, and
`:57-88` unionizes launch graphs and writes the final `launch.fst`. The parser
README describes the same source-to-FST packaging at `:89-93`.

The native service has a broader internal protocol. At
`nluservice/nlu_request_executor.h:34-58` the pinned service declares
`PARSE_FROM_TEXT`, `PARSE_FROM_FILE`, `PARSE_FROM_URI`, `COMPILE`, `UNION`,
`RESET_MEMORY`, and related operations. Its dispatcher at
`nlu_request_executor.cc:114-143` routes those operations. In particular:

* `execute_parse_from_uri` at `:246-276` accepts an FST/file URI and text,
  opens the requested graph(s), creates a sentence parser, and parses the
  text. The source service creates fresh graph/parser objects for this request
  path; the native library's factory bytes are separately cached. This is
  recorded in the corrected cache-lifecycle evidence, rather than the earlier
  retained-parser interpretation.
* `execute_parse_from_text` at `:278-315` accepts `RULE_STRING` and
  `TXT_STRING`, compiles the grammar, parses it, and removes its temporary
  handle. This proves an internal compile-on-request operation, not a public
  parser contract.
* `execute_compile` at `:436-463` accepts one of `RULE_STRING`,
  `RULE_STRING_PATH`, `RULE_BINARYFST`, or `BINARYFST_PATH`, associates the
  result with a URI/handle, and returns no parse result. The helpers at
  `:465-512` show the text and binary loading paths.

The native library confirms the representation boundary. At
`jibonluapi/jibonluapi.cpp:35-52`, text compilation creates an FST group while
`read_open_fst_from_uri` opens an existing graph. The parser then consumes the
graph at `:54-72`. The pinned compiler creates the reserved wildcard rules at
`compiler/compiler.cpp:99-135,167-225`; this is why replacing the native
compiled path with a text matcher is a semantic change even when the public
request JSON is the same.

Therefore no original public operation requires a new grammar compilation at
request time. `POST /v1/parse` parses against rule graphs selected from the
startup registry, and `GET /state` reports service state. Runtime text
compilation is reachable only through the internal native protocol used by
build/startup tooling or a caller that directly exposes `nlu_interface`.

## Current Phoenix paths

Phoenix has the same public route shape in `packages/nlu/src/index.js:112-143`:
`POST /v1/parse` validates `body.data.text`, calls `parseRequest`, and returns a
message; `GET /state` is the only other parser route. There is no
`/nlu_interface`, `/compile`, FST upload, union, or grammar source route.

The default request path is a fixed, source-inventory-backed AST path.
`packages/nlu/src/requestParser.js:56-135` loads and hashes the 117 source
rules, two local grammar factories, and 98 public rule entries from
`resources/rule-inventory.json`; `:142-159` accepts only names in that public
map. `:187-223,290-332` selects the AST matcher when no compiled profile is
selected. Its `grammar/index.js:28-65` can load an inline or URL source, but
that is an in-process programmatic registry and is not called by the HTTP
listener. `launchRules.js:24-42` and `fullGrammar.js:32-65` read local sources
at initialization.

The portable executor is already source-backed for an explicitly selected
profile. `compiledFstRuntime.js:474-501` returns no compiled runtime unless
`PHOENIX_NLU_RUNTIME=compiled-fst` is set; binary mode requires all artifact
paths and the approved launch hash, while snapshot mode requires an explicit
manifest. `:504-539` loads the verified JSON/gzip profile and
`:542-609` verifies binary graphs, factory files, rule inventory, and source
anchors before constructing executors. A missing or invalid selected profile
throws before `start()` returns a listener (`index.js:112-116`); there is no
silent AST fallback for a selected compiled profile.

The approved portable bundle is a deployment input, not an implicit repository
dependency. `scripts/install-nlu-snapshot.mjs:240-340` validates and installs a
complete versioned bundle. The root deployment review records 98 graph
snapshots, 15 executable factory snapshots, 16 factory provenance files, the
approved inventory hash
`7dddc9854981f388480fed90f4714b51f22fe69d5174964e18bb4584b441c4f4`, and a
9,978,000-byte gzip bundle. It also records about 1.1 GB peak RSS while loading
the complete profile on the Node 22 host. The target needs an explicit
provisioned bundle and manifest; it does not need the archived Jibo executable
in snapshot mode.

## Bounded controls

All controls used the candidate-local workspace links and Node `v22.22.0`.
The dependency receipt records `npm ci --ignore-scripts --offline`, lock hash,
and these resolutions:

```text
@phoenix/common    -> packages/common/src/index.js
@phoenix/contracts -> packages/contracts/src/index.js
@phoenix/nlu       -> packages/nlu/src/index.js
```

Private receipts are under
`.parity/reviews/n08-runtime-default-20260907/`:

* `operation-matrix.json` is the machine-readable map of eight public,
  internal, and offline operations. It records zero public operations that
  require new grammar compilation and the two internal text-compilation
  operations separately.
* `public-route-controls.json` is a normalized process-level Phoenix default
  listener control. The normal `/v1/parse` request returns the named timer
  result; an unknown rule returns the empty NLU shape; an extra grammar-shaped
  field is ignored; `/state` returns 200; `/nlu_interface` and `/compile`
  return 404. Volatile message IDs/timestamps are removed from this receipt.
* `dynamic-registry-control.json` loads two synthetic grammars through the
  programmatic `createRegistry` API, once inline and once from an owned local
  HTTP peer. Both parse successfully. This demonstrates the separate dynamic
  AST API and does not claim public endpoint or native-FST behavior.
* `explicit-missing.status` and `snapshot-missing.status` are both `1`.
  Selecting the compiled mode without its required artifacts or with an
  unavailable snapshot fails before listener startup.
* `focused-unit.log` contains 19 discovered NLU tests, 18 passes, one expected
  configuration skip, and zero failures. It includes the request-parser,
  public launch, and compiled-runtime guard controls.

The direct compiled executor also has separate root evidence on 27 expanded
and permuted native graphs: `n08-fst-order-root-20260907/comparison.json`
records 27/27 complete result and exposed-score matches. That evidence supports
the portable executor's graph semantics beyond the 98 archived public graphs;
it does not establish graph acquisition, source compilation, public endpoint
coverage, or a default switch. Its source side ran archived native binaries on
the host with their pinned libraries, so it is not a Node 8 Docker execution
claim.

## Assessment and implementation sequence

Making the portable executor the default for a *specific, provisioned compiled
profile* is technically supported by the current runtime and is closer to the
original parser's graph execution than the default AST matcher. Making it the
global Phoenix default now would overstate the source contract and create
unbounded deployment behavior. The current profile is a closed set of 98 public
graphs and 15 factory FSTs, while the original registry discovers whatever
prebuilt graphs are present under configured directories. Neither the public
source API nor the current snapshot manifest defines acquisition, registration,
or compilation of a newly deployed grammar.

The source-supported sequence is:

1. Keep the explicit compiled profile as the production deployment option and
   keep AST as the no-bundle/development compatibility path. Select the
   compiled profile in deployment configuration only after the complete bundle
   is provisioned and startup validation succeeds.
2. Define a deployment-owned profile acquisition contract: versioned manifest,
   ordered public graph inventory, factory dependencies, source/compiler/runtime
   provenance, trusted decoded hashes, and an atomic install/update boundary.
   Reject missing or unknown requested graphs; never silently substitute AST for
   a selected compiled graph.
3. If production needs skill grammars outside the approved profile, add a
   controlled graph-provisioning/registration path and verify its complete
   source-to-graph chain. The current programmatic `createRegistry` URL loader
   is an AST convenience and cannot serve as that native-compatible contract.
4. Treat text compilation as a separate internal/admin capability. If it must
   be exposed, specify authentication, include resolution, filesystem
   sandboxing, resource limits, handle lifetime, locale/factory loading, and
   reset semantics before adding a route. Do not expose the native
   `nlu_interface` directly as a public HTTP endpoint.
5. Validate the selected profile against fixed and novel source/native graph
   controls, the actual public rule/skill inventory, and deployment resource
   limits. Revisit a compiled-default deployment class only after those
   controls cover the graphs that class actually serves.

The current blockers are dynamic graph acquisition and registration, exact
source-to-binary rebuild provenance, coverage beyond the approved profile,
portable startup memory on the target, and the still-open broader N-08
provider/skill/robot acceptance. The existing full 20,534 snapshot comparison
has zero parser status/data differences but retains eight external-answer gap
cases; it is evidence for the selected profile, not evidence that all production
grammars or public providers are covered. No full corpus replay, robot trial, or
task completion is claimed by this candidate.
