# Compatibility manifest

Frozen on **2026-09-05** for the parity work in [PLAN.md](PLAN.md). This fixes what we compare; it does not certify any Phoenix feature. The user's target is original Pegasus. The original Hashbrown source is therefore the default reference; a newer restoration is a separate profile. Later discoveries or user steering can revise this manifest with an explicit impact review and reopened evidence.

## Sources and consumers

| Layer | Frozen target | Verification boundary |
|---|---|---|
| Original Pegasus | `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`, original Hashbrown source, 2018-05-30 | Normative code, resources, tests and observable behavior. This is a source baseline, not a claim that a production deployment used precisely this commit. |
| MIT checkpoint | `00634db95f0764478f86bae8db69d55412c6a223` | Branch archaeology only; differences must not enter original expected results silently. |
| Restored Pegasus | `d682547a31511cd164db0913b6104eb1786455a2` | Modern providers, Parakeet and answer/NLU extensions are identified separately under X-01. |
| Original hub client | `@jibo/hub-client@1.0.23` source at the original Pegasus commit; original `@jibo/interfaces@1.0.30` | R-01 must exercise this client without changing its wire requests. The source pin takes precedence over an independently republished package with the same version. |
| Hashbrown robot consumers | SDK monorepo `23.4.0`, `jibo@14.2.7`, `jetstream-client@2.2.0`, `jibo-command-protocol@4.2.7`, `skills-service-manager@14.2.7`, `@be/be@10.0.16`, `be/nimbus@2.2.7` | Historical version matrix from internal release notes; hardware execution is pending under R-04. Archived package metadata for jibo/JCP is retained in the pins file. |
| Hashbrown consumer source | `sdk/sdk@793e5ae469ec48d280bf837564035696848629ab`, tag `v23.4.0` | Source manifests confirm Jetstream client `2.2.0`, BE `10.0.16` and Nimbus `2.2.7`; inspected file hashes are recorded in [CONSUMERS.md](CONSUMERS.md). |
| Additional BE 12 consumer | Original `jibo-be-12.0.0.tar.gz`, SHA-256 `e29f476c75e35e9bbd07c0211c75e2385772e4dfb3dd079a1d832e3832450657` | User-requested source-map profile. 300 embedded source files recovered; bundled versions and 13 exact cross-profile file comparisons are documented in [CONSUMERS.md](CONSUMERS.md). Full release/runtime equivalence is unverified. |
| Native Jetstream source | `jiboV2/jetstream@01ae81fc366ccd6e68ca66fa98f77f957dcdb1fb`, 2018-05-30 | Original pre-migration source for framing, authentication and audio. Mapping to installed robot binaries remains R-04. |
| Hashbrown firmware | Release notes list OS build `12.6.0` / preprod `12.7.0`, diagnostics `6.0.16`, OOBE config `9.0.0`, and release package `1.9.1`; their OTA table also contains `1.9.0-RC4` | Record these as historical candidates, not one tested device image. Resolve exact installed component versions when executing R-04. The same page's “3/29” shipping date conflicts with its May/June context and is not used to select a binary. |
| Existing Phoenix robot journey | Jibo Mark-I firmware `3.3.0` is reported in the pre-existing divergence log for backup/wipe | Preserve this regression target. Previous hardware claims have not been independently reproduced in this audit and do not prove Hashbrown parity. |
| Classic contracts | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, all 26 discovered API specs / 134 wire operations | Operation inventory, not a release-matched complete cloud specification. Original controllers/consumers and legacy versions remain A-01 work. Release notes spell JSC as `30.120`; that ambiguous string is not silently changed into a package pin. |

The [Hashbrown release notes](https://pvindex.org/confluence/display/FSRN/Release+Notes+Hashbrown) identify the robot packages. The [Hashbrown QA plan](https://pvindex.org/confluence/display/SQA/Pegasus+Hashbrown+Test+Plan) explicitly includes Personal Report and proactivity, failure/latency work and the pre-existing regression suite. Its TestRail links are discovery leads, not evidence that those cases have been imported or run.

The BE 12 archive includes Jibo Server Client `3.0.79` and three nested `3.0.117` instances, with differing API models. Preserve those consumer distinctions. The user excludes the web simulator as an oracle and made Moth available for real-robot iteration on 2026-09-05; HARDWARE.md records this new validation track. The other robot remains outside this run. Adding source profiles does not replace the frozen Pegasus target or change any verified product count.

## Dependency and execution pins

[compatibility-pins.json](evidence/2026-09-05/compatibility-pins.json) records all 18 original workspace package versions/dependencies, SHA-256 hashes of the root manifest/lock/Dockerfile/NLU download script, selected exact lock entries and retrieved package metadata.

- Runtime: original Dockerfile selects **Node 8.9.4**, resolved image `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`. Its Dockerfile installs Yarn `1.5.1-1`. Any replacement provisioning/transpilation tool must be recorded separately from the runtime under test.
- Original compilation: TypeScript **2.5.3**; the lock also contains **2.7.1** for dependencies. Do not choose an unpinned current compiler without recording that change.
- Original HTTP/WS stack: Express **4.16.2**, body-parser **1.18.2**, ws **3.3.3**. `jibo-cai-utils@6.0.1`, `jibo-typed-events@6.0.1`, `jibo-log@5.0.7`, `jibo-data-utils@3.0.1` and the remainder resolve through the original lock. This includes a dependency written as `latest`; it must retain its locked value.
- Axios is **the Jibo fork** at `9ffcb402fec0fa6041658b8f99ffe6619c65b6a0`, reported as `0.17.1`, alongside a separately locked stock `0.18.0`. Replacing the fork with stock Axios can change requests; it is not a provisioning-only change.
- NLU: the original postinstall requests **2.8.3**. The repository bundles **2.8.2** (SHA-256 `a84aef41fe6ff79026b627c683260862f7971280c3bf21ab45fa8c10f35c4975`). Use the retrieved [2.8.3 archive](https://pvindex.org/repository/nlu/jibo-nlu/jibo-nlu-v2.8.3-linux-x64.zip), hash it and record execution before using it as an oracle. Results from 2.8.2 require their own label and cannot certify 2.8.3 parity.
- Registry addresses may be relocated to `https://pvindex.org/npm/` following the Jibo MCP `jibo://npmrc` resource. Exact versions and original tarball hashes remain pinned. A hash mismatch is an unresolved dependency difference, not permission to discard integrity checking.

V-01 records what actually executes, including interpreter, dependency closure, build adaptations, fake providers, fixed time/randomness and any unavailable modules. A partial runnable reference is useful; it must list its exclusions. Original credentials and historical production endpoints are not fixture configuration.

## Observable compatibility policy

The original profile preserves paths, methods, authentication semantics, required/optional fields, null versus missing versus empty, errors, request ordering, session continuation, side effects, retention, entities/rules and the complete speech/display/action output. Modern implementation choices are allowed when those properties agree. Replacement external providers must implement the original adapter contract and separately demonstrate a functioning success path.

Original session tokens must support their documented round trips. S-01/R-02 must explicitly verify continuity across cutover or implement a reviewed draining/migration procedure; deleting sessions from comparison is not a parity argument. Test-only clock/random controls may make observations repeatable but must not erase timing, identity or selection requirements.

The table below classifies every existing entry in [DIVERGENCES.md](../../DIVERGENCES.md). That older file retains its historical rationale; this manifest governs the new compatibility work. **Required repair** means a behavior cannot be counted as original parity in its present form. **Separate extension** means it may remain available under an explicitly tested configuration, while the original profile is still required. Open details remain in the named tasks.

| Existing ID | Classification | Required outcome / owning tasks |
|---|---|---|
| A1 modern JavaScript | Internal-only | Preserve wire and runtime behavior; C-01/C-02, full regression gates. |
| A2 zero dependencies | Internal-only | Handwritten validators/HTTP/WS code must pass the same contracts; minimal dependencies do not waive validation or protocol features; C-01/C-02/H-02. |
| A3 npm workspaces | Internal-only | Reproducible clean builds and deployment; R-02/R-03. |
| A4 local ports | Internal-only, subject to configuration parity | Support original deployment environment/service URLs and 8080 container entrypoints; normalization alone does not establish drop-in replacement; C-03/R-02. |
| A5 opaque sessions | Internal-only, verification open | Preserve complete continuation, ID relationships and cutover behavior; S-01/R-02. |
| B1 weather day index | Required repair | Compare original provider responses and local-day behavior. Any restored Open-Meteo indexing defect belongs to the restoration profile; D-05/S-09/X-01. |
| B2 reduced intent catalog | Required repair | All original grammar and external-agent contracts stay in scope; N-01–N-08. |
| B3 / B3✓ credential deletion assignment | Required repair; original defect unresolved | Record the original bug's observable boundary and the corrected behavior under D-02. A corrected path is not evidence of equality with the buggy original path. Keep that mismatch open until compatibility/profile handling is verified. |
| B4 speech retention | Required repair if retention changes | Match original no-TTL speech history; independently configured retention is an extension; I-03/H-08. |
| B5 seeded variants | Internal-only test control | Verify selection behavior/default randomness and timed invariants; S-04. |
| B6 GQA remap | Separate extension | Restore original routing and GQA integration in the original profile; H-03/Q-01. Test alternate answer routing independently in X-01. |
| B7 weather remap | Separate extension | Restore original intent/memo/skill decisions; H-03/N-08. Direct weather routing belongs to X-01. |
| E8-news-images | Required repair | Preserve original AP header/image rules and usable image/display output. Adapt replacement feeds at the provider boundary; D-06/S-10/S-13. |
| E8b-datetime | Required repair where behavior differs | A smaller internal API is acceptable only after all used timezone/DST/formatting behavior agrees; S-05/S-12. |
| G-sigv4 | Required repair | Verify signatures/identity for keys Phoenix issues and match the original trust boundary. Missing old keys do not justify accepting all new signatures; A-02. |
| G-store JSON persistence | Internal-only, acceptance open | Verify durability, transaction/concurrency behavior, ownership and restart/migration; A-03/A-04/R-02/R-03. |
| G-hubtoken HS256 | Internal-only where source agrees | Match the source JWT algorithm/claims/expiry/identity behavior, including missing-expiry semantics; H-10/A-03. Additional `/api/*` administration is an extension. |
| G-admin password portal | Separate extension | Retain the operator portal without replacing original Account/Admin operations; A-03/A-18. |
| G-qr encoder | Internal-only | Verify payload and decoding with the original OOBE consumer; A-05/R-04. |
| H-frontdoor multiplexing | Internal-only, acceptance open | Preserve original target/version/header/error behavior and notification socket addressing; A-02/A-10/R-01/R-02. |
| H-inmemory | Required repair | Required state survives appropriate service restarts and obeys original ownership/lifecycle; A-10/A-11/A-13/A-15. |
| H-stubs | Required repair | Implement real ROM/media/person/IFTTT/NLP/collision success and failure behavior; A-14–A-17. Empty output shapes do not complete operations. |
| H-backup | Required repair | Durable index/blobs, ownership and actual client restore; preserve existing backup work; A-09/R-04. |
| H-loop | Required repair | Complete all Loop operations and original errors/identity. Reconcile adopted IDs explicitly instead of unconditional suspend success; A-04/A-05. |
| H-notbuilt | Required repair; discovery open | Locate voice-training/JOT contracts beyond the current SDK normal.json list. Keep discovery and functional implementation open under A-01/A-18; no operation disappears because a schema was not found. |

## Companion-cloud scope and priority

Both original Pegasus and the companion-cloud backlog remain required work. Their counts stay separate because a full mobile/OOBE/OTA service is a larger surface than the Pegasus processes.

| Boundary | Required contracts | Execution priority |
|---|---|---|
| Direct Pegasus → Classic dependency | Hub and report call **`Settings_20160801.GetSettings`**, passing account identity in `x-amz-credentials`. Report requests `skills: 'report-skill'`; hub requests an array. The discovered SDK instead lists `Settings_20171219`. | A-01/A-06 must recover and test the legacy operation as well as the newer four-operation Settings API. H-05/S-08 depend on functioning preferences. |
| Identity and original robot journeys | Account identity/key/token lifecycle; OOBE prepare/setup/reconnect/status; Loop membership/robot records; Settings read/update; notification registration/socket; Update/Backup/Key flows. | A-02–A-11 and R-01/R-04. Which operations each journey actually calls must be evidenced by consumers, not inferred from names. |
| Expanded companion cloud | All remaining operations in the 134-operation SDK inventory, including admin, Media, Person, Collision, ROM, IFTTT, NLP, Push, Log, LPS and OAuth-client operations. | A-01 and their functional A-* tasks; discovery remains open for non-SDK protocols and older versions. This is scheduling, not removal from scope. |
| GQA | Original Pegasus GQA integration plus discovered `GQA_20160930.Question/ListAttribution` where required by original consumers. | Q-01 owns service behavior; A-01 maps Classic dispatch/consumers. Do not substitute an LLM and mark the original integration verified. |

The original hub/report Settings clients are the source of the legacy target above. No evidence so far shows that Pegasus directly calls the other 133 inventoried Classic operations; their absence from the Pegasus dependency set does not remove them from the companion-cloud target. A-01 owns an exhaustive call-site/controller map and reconciles any additional contracts. The API inventory remains a lower bound, not a closed denominator.

## PM-03 review

- [x] Original/restored code and original hub client pins are recorded; historical firmware candidates and ambiguous release metadata are explicitly labeled.
- [x] Dependency versions and artifacts are recorded without conflating NLU 2.8.2 with the requested 2.8.3.
- [x] Every historical divergence has a classification and an owning open task.
- [x] Direct Pegasus dependencies and the larger companion-cloud target are separated without deleting either backlog.

These checkmarks complete scope management only. No hardware, client, provider or product-parity gate is closed by this manifest.
