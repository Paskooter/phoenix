# Executable reference status

V-01 is verified as **reference infrastructure**, using original Hashbrown source `5c0a7390539663ba749d360de348a428c088505c`. It does not certify Phoenix parity. The [runner and instructions](../../scripts/parity-reference/README.md) reproduce the captures; [run.json](evidence/2026-09-05/reference/run.json) records exact commands, image, hashes and scope.

The reviewed run captured **38 transactions** and passed **19 fixture checks**. It ran under original Node **8.9.4**, using original TypeScript **2.5.3** and lock-pinned production dependencies. All **376 compiled source inputs** and **15 service package manifests** were checked against the immutable original Git objects. The NLU **2.8.3** CLI executed the original launch FST with two positive utterances and one no-match case. The [review](evidence/2026-09-05/reference/review.json) also records 232 passing Phoenix tests and confirms that all 4,838 inventoried baseline package/script files remain unchanged.

## Executed and outstanding surfaces

| Surface | Executed now | Still unverified / fallback until executable |
|---|---|---|
| Shared HTTP/WS | Original BaseService/BaseHttpHandler, health, null/undefined, query/form/JSON, HEAD, authentication, errors and upgrade rejection | Full header/limits/disconnect/auth matrix belongs to C-01/H-02/H-10; original utils tests provide source-derived cases. |
| Hub | All four robot-specific skill-list routes; CLIENT_ASR cloud launch, global relaunch, local continuation, no-match/provider failure, launch-history requests and Settings client | Proactivity, full concurrent/socket lifecycle and real ASR remain H-02–H-10. Use original hub tests and fixture peers; a simulated skill response does not certify actual GraphSkill sessions. |
| Parser | Original ParseRequestHandler with robust/Dialogflow fixtures; exact NLU 2.8.3 CLI against original launch FST | Full RobustParserProcess/Client pipeline, named-rule/global compilation, external-agent and LoopMemberDetector matrices remain N-01–N-08/V-03. Use original parser tests and the now-available binary, keeping CLI output distinct from final parser envelopes. |
| Lasso | Original AbstractRelayRequestHandler with fake provider and Redis callbacks; miss/hit/skip-cache, empty calendar envelope, HEAD, validation/provider/empty-result errors | Concrete calendar/weather/news/maps adapters, OAuth, credential storage and actual Redis remain D-01–D-07. Original relay/provider tests supply fixtures; fake Redis does not establish persistence or concurrency. |
| History | Original history client is exercised through hub requests; history modules compile | Mongo-backed history server/query/TTL/restart behavior has not run. I-01–I-03 use original route/query tests and add a pinned database fixture. |
| Skills | Original baseskill/chitchat/report/example/template source modules emit | Actual skill services/conversations/views have not run in this fixture. S-01–S-14 use original graph tests, MIMs and manifests; synthetic fixture ESML is not a verified skill response. |
| GQA and Classic | None of their independent server processes is executed by this runner | Q-01/A-01 and related tasks retain archived controllers/tests/fake-external setup. The hub's Settings client test is one consumer contract, not verification of the Settings service. |
| Robot/client integration | Original WS requests and a source-derived context/session round trip | Original hub-client package, robot runtime, firmware, physical display and deployment journeys remain R-01–R-04. No hardware was changed. |

## Build boundary

The first complete development-dependency install failed with **ENOSPC** while copying `ffprobe-static`; its [failure log](evidence/2026-09-05/reference/full-development-install-failure.log) is retained. Only generated artifacts from that attempt were removed. A production dependency profile for 15 workspaces now installs successfully; the CLI and two integration-test workspaces remain excluded. `prepare.py` recreates this selection and keeps included service manifests unchanged.

The reference runs separately emitted CommonJS modules with package entry wrappers, using `ts.transpileModule`. It is **not** a verified original Gulp/browserify release build or type check. Every emitted file is hashed and the adaptation is recorded. This is sufficient to execute independent original modules as allowed by V-01; eventual original-client/release checks must not assume bundle/build equivalence.

Package scripts are disabled. Google speech/gRPC import shims prevent the original import-time client constructor from reading credentials or loading native gRPC; actual provider calls fail explicitly. The hub uses its existing CLIENT_ASR mode. Full Google/other provider execution remains a separate task, with exact artifacts and fixture/live configuration required when it is attempted. The execution container has no external network and publishes no ports.

## Consequences for the repair plan

The raw [transactions](evidence/2026-09-05/reference/transactions.json) establish several details that the strict runner must preserve:

- Health returns `text/html`, JSON null returns the bytes `null`, undefined produces an empty body, malformed JSON returns 400, and typed HTTP errors preserve their status. Error envelopes do not gain an invented error-code field.
- Skill-list replies include complete configuration and settings metadata. Both `/skills/...` and `/v1/skills/...` routes work.
- A matching global intent can relaunch a skill even when context carries its session. A local unmatched intent continues it. The final frame leaves the original socket open; the fixture confirms it remains open after 50 ms, then records its own close.
- Relay cache hits return stored JSON as `text/html`; misses return JSON content type. `skipCache=false` is a nonempty query string and skips the cache. These are observable original behaviors, even where a new design might choose differently.
- Empty calendar data is still wrapped in `relayData`. HEAD prefetch returns an empty 200 and performs the provider/cache work.
- The original Settings client sends `Settings_20160801.GetSettings` with the expected account header and request data through the Jibo Axios fork.

V-02 turns these captures into strict original-versus-Phoenix gates. Its work is still open; the existing normalizer that erases sessions/timings must not be used as evidence that these captures agree with Phoenix.
