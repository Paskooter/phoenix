# Phoenix parity audit — 2026-09-05

Phoenix is a substantial working reimplementation, but it is **not yet a 1:1 compatible Pegasus server**. The existing completion claims overstate what the tests establish. This audit preserves the implemented work, reproduces the existing scores, and records the remaining work in [the execution plan](PLAN.md) and [task checklist](TASKS.md).

This is the initial audit snapshot. Follow-up work has frozen [the compatibility target](COMPATIBILITY.md), established [a partial executable original reference](REFERENCE.md), and replaced the placeholder harness with [strict HTTP/hub comparisons](../../packages/harness/README.md). Statements below about unavailable runtime evidence and broad normalization describe the audit baseline. The original corpus-grading gaps remain open under V-03.

## What was compared

| Baseline | Revision / scope |
|---|---|
| Phoenix | `5e240a7047d43dc5cadd3b14debf0102c3bfab7e`, plus the pre-existing uncommitted changes recorded in [the source inventory](evidence/2026-09-05/source-inventory.json) |
| Inspected Pegasus checkout | `d682547a31511cd164db0913b6104eb1786455a2`, clean working tree, branch `phoenix` |
| Original Pegasus candidate | `5c0a7390539663ba749d360de348a428c088505c`, hashbrown, 2018-05-30 |
| MIT lineage checkpoint | `00634db95f0764478f86bae8db69d55412c6a223`, 2019-07-01 |
| Classic client API archive | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344` |
| Test environment | Node `v22.22.0`, npm `10.9.4`; local services and fixture providers |

“Original” and “restored” must remain distinct. The inspected Pegasus branch includes 2026 Parakeet, LLM, weather/news/maps and answer-skill changes. The original hashbrown revision is available in local Git history. The [branch archaeology](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/branch-archaeology.md) identifies its lineage; a source diff is retained in the inventory. The working assumption is that original behavior defines compatibility and later changes are separate extensions. **PM-03** finalizes release/client versions and this policy; no previous divergence is automatically an accepted exception.

This was a source/asset/API inventory, targeted implementation review, full current test/corpus run and 14 source-backed discrepancy probes. It was **not** an execution of the original server or a line-by-line proof of every function. Original service tests, hardware, live vendors and complete deployment substitution remain open verification tasks. The archive's atlas is useful secondary documentation; executable source and version-matched consumers take precedence where it disagrees.

The [source register](SOURCES.md) records which internal documentation, code and tooling were read through Jibo MCP and which were only located for follow-up.

## Fresh measurements

| Check | Observed result | What it establishes |
|---|---|---|
| `npm test` | **232 passed**, 0 failed, 0 skipped; 36.2 s | Existing regression tests pass on the dirty baseline |
| Chitchat manifest, intent comparison | **9,851 / 10,035 = 98.2%** | Intent-name agreement for that corpus |
| Chitchat manifest, MIM routing comparison | **9,714 / 10,035 = 96.8%** | Agreement with `memo.mim`, or intent agreement where no expected MIM exists |
| Utterances failing either corpus check | **329** | An explicit remaining mismatch list; these are not 329 independent features |
| No-match cases in that run | **0** | Negative routing was not measured by this corpus |
| Existing static oracle grader | **74 / 89**, displayed as 83% | Agreement of its alternate grammar pipeline with the stored golden file |
| Source-backed probes | **14 observations** | Reproduced concrete contract/configuration defects and a retention defect |
| Imported full grammar tree | **29 / 117** reference files, all 29 byte-identical | **88** original named rule files absent from this import |
| Chitchat MIM data | **4,424 / 4,424**, byte-identical | Content preservation, not execution/selection verification |
| Report MIM data | **82 / 82**, byte-identical | Content preservation, not view/graph verification |
| Classic API inventory | **26** files; **134** unique wire operation targets | Contract inventory, not implementation coverage |

Evidence: [run metadata](evidence/2026-09-05/baseline.json), [test log](evidence/2026-09-05/npm-test.log), [corpus report](evidence/2026-09-05/corpus.json), [corpus output](evidence/2026-09-05/corpus.log), [static grader](evidence/2026-09-05/oracle-grade.log), [probes](evidence/2026-09-05/probes.json), [assets/source](evidence/2026-09-05/source-inventory.json), [Classic operations](evidence/2026-09-05/classic-api-inventory.json).

The corpus took 1,108 seconds with external LLM fallback disabled. Its vendored manifest is byte-identical to **Pegasus chitchat's** manifest, not a combined server-wide test suite. The original hub-client manifest has 2,573 entries / 7,029 utterances; the report manifest has 6 entries / 73 utterances. These are different corpora and can overlap.

The static grader is also discovered by `node --test`: the log reports **74/89 and then marks that file as passing**, because the grader exits zero despite mismatches. The corpus runner likewise exits zero with mismatches. The grader does not run the original binary and does not use the complete production parser pipeline. Its 83% must not be substituted for a production NLU accuracy estimate.

## Reproduced and source-confirmed gaps

**Pxx** references below identify observations in [probes.json](evidence/2026-09-05/probes.json). They compare executed Phoenix behavior with inspected source, not a concurrently running Pegasus instance. Priority P0 means a compatibility/release blocker, not that every defect has equal impact.

| Finding | Evidence and consequence | Tasks |
|---|---|---|
| **F01 — Verification cannot support “complete”** | [Harness CLI](../../packages/harness/src/index.js) still prints a placeholder. [Normalization](../../packages/harness/src/normalize.js) removes whole sessions and timings; those invariants are not verified by the diff. Current corpus ignores entity equality, winning rule names, full skill actions and negative cases. Graders do not fail on mismatches. | V-01–V-03 |
| **F02 — Requested NLU rules are ignored** | **P02**: `audit/nonexistent` and `launch` produce the same launch result for “tell me a joke.” [HTTP handler](../../packages/nlu/src/index.js) passes only text; [full grammar loader](../../packages/nlu/src/fullGrammar.js) evaluates launch grammars and omits top-level globals. Missing rules include clock/menu, enrollment, Hue, media and conversational follow-ups. Compare [RobustParserClient](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/parser/src/robustparser/RobustParserClient.ts). | N-01–N-05 |
| **F03 — NLU shapes, contextual entities and routing differ** | **P01/P11**: original empty `entities:null` becomes `{}` and is rejected by Phoenix's schema. Parser-only `intent`/`priority` values appear in entities; [the reference](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/parser/src/handlers/ParseRequestHandler.ts) post-processes loop members, while Phoenix discards loop input. Explicit GQA/weather remaps change observable behavior. **P10**: skill-entity fallback launches with no intent, unlike [the original router](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/hub/src/intent/IntentRouter.ts). | C-02, H-03, N-06–N-08 |
| **F04 — Reference skill-list URLs are missing** | **P03**: `/skills/:robotId`, `/v1/skills/:robotId` and both `/settings/:robotId` variants return 404. Current routes return only id/intents and the registry drops settings metadata. The [reference handler](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts) returns full configurations, optionally settings-filtered. | C-03, H-01 |
| **F05 — History HTTP contract is incomplete** | **P04–P07**: no-match returns `{}`, GET count is 404, a launch with no required identity is accepted, and a valid launch returns only `{id}` rather than its full record. [History routes](../../packages/history/src/index.js) differ from [the source](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts); shared HTTP serialization causes the null defect. Query validation/operator coverage is incomplete. | C-01, I-01, I-02 |
| **F06 — Calendar is not functional through the real service chain** | **P08/P09**: a provider returning events produces bare `{events}` and HEAD is 404. The [report client](../../packages/skills/src/report/lassoClient.js) requires `relayData`. [Calendar](../../packages/data/src/calendar.js) has default 501 providers, no common relay cache, and lean date normalization; [credentials](../../packages/data/src/credentials.js) reject real OAuth exchange with 501. Compare [GoogleCalendarHandler](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/lasso/src/relay/GoogleCalendarHandler.ts). | D-02–D-04, S-12 |
| **F07 — Proactive preferences are bypassed** | [Candidate selection](../../packages/gateway/src/proactive/proactiveTransaction.js) accepts all settingsRules. [Pegasus SettingsRulesChecker](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/hub/src/proactive/tools/SettingsRulesChecker.ts) excludes candidates when settings are absent or do not match. An implemented report settings service does not repair this missing integration. | H-05, H-06, A-06 |
| **F08 — State and speech side effects are incomplete** | [History](../../packages/history/src/store.js) and [credentials](../../packages/data/src/credentials.js) lose state on restart; several Classic stores do too. **P12** shows out-of-order expired history surviving the local prune operation; Mongo's reference TTL cleanup is eventual, so this is a logical retention defect, not a claim about identical immediate timing. The gateway lacks the reference's incremental speech-history writes. | I-03, D-02, H-08, A-09–A-11 |
| **F09 — Robot displays and prompt context are incomplete** | Weather, news, commute and calendar explicitly assign empty view objects in [report code](../../packages/skills/src/report). [Original view builders](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/packages/report-skill/src/subskills/weather/WeatherViews.ts) populate robot assets and labels. [PromptData](../../packages/skills/src/graph/mims/promptData.js) uses host-local date accessors and simplified names/location; DateTime uses fixed offsets. A simulator that does not render these fields cannot establish parity. | S-04, S-05, S-13 |
| **F10 — Per-service substitution fails** | **P13**: the entrypoint used by all skill containers answers a report request at `/v1/main` as **answer-skill**. **P14**: a report client configured with reference `NET_lasso` rejects it as “NET_data not configured.” [Current compose smoke checks](../../scripts/verify-compose-contract.mjs) use Phoenix-specific skill URLs and do not catch this. | C-03, H-09, R-01, R-02 |
| **F11 — Original audio/fallback behavior is not preserved yet** | [ASR factory](../../packages/gateway/src/asr/factory.js) implements Parakeet only; original streaming/interim/FastEOS contracts remain unverified. [NLU fallback](../../packages/nlu/src/llmFallback.js) ignores external-agent requests, has a small tool catalog and a 12 s default timeout versus a 10 s hub parser budget. Provider replacement must preserve the consumer contract. | H-07, N-07, R-03 |
| **F12 — GQA is a partial replacement** | [Answer skill](../../packages/skills/src/answerSkill.js) uses a generic LLM or placeholder and lacks the restored branch's Wikipedia-first path. Original [GQA source and fake-service tooling](https://pvindex.org/gitea/jiborobot/srv-gqa-ws/src/branch/master/README.md) survive, including behavior absent from the monorepo. | Q-01, X-01 |
| **F13 — Classic success shapes conceal missing functionality** | [Stubs](../../packages/classic/src/stubs.js) return empty media URLs, empty ROM certificates, empty NLP/IFTTT results and “no collision.” [Loop dispatch](../../packages/account/src/robotFace.js) implements three wire operations out of 23 and bypasses some original failure conditions. Custom portal APIs do not implement the 26 Account SDK operations. | A-01, A-03–A-18 |
| **F14 — Authentication/ownership is not equivalent** | [Classic routing](../../packages/classic/src/router.js) and [account robot face](../../packages/account/src/robotFace.js) do not verify SigV4. Broad prefix matching/selected proxy headers and dropped backup/loop ownership checks change the original API. Existing issued keys mean lost historical keys are not a blanket reason to omit verification for new accounts. Hub JWT compatibility also needs its own oracle matrix. | A-02, H-10 |

All findings above are open product work. The audit did not alter production handlers to repair them.

## Implementation progress by area

| Area | Existing foundation | Remaining verification/work |
|---|---|---|
| Contracts/common | Shared HTTP, messages, JWT, trace/env helpers | Exact response/error/schema/configuration behavior |
| Hub | Listen modes, ASR VAD, routing, redirects, proactive, launch writes | Original endpoints, identity/race/error matrices, settings and speech integration |
| NLU | JS grammar engine, 29 original grammars, factory word lists, optional LLM | Full named-rule set, scoring/entities/context/fallback and exact outputs |
| Data/history | Working relay framework and in-process stores | Calendars/OAuth, durable state, query/HTTP parity, provider feature coverage |
| Skill framework | Graphs, sessions, MIM factories, opt-in and rendering | Original branch coverage, complete JCP/ESML, prompt context and continuation |
| Content/skills | All 4,506 chitchat/report MIM files preserved; report/chitchat/demo implementations | Reachability, full actions, views, original GQA and complete data integration |
| Account/Classic/OTA | Portal/pairing/settings, backup work, socket/key/robot/update scaffolding | Full operation semantics, auth, persistence and functional replacements for stubs |
| Delivery/verification | Unit tests, corpus tooling, smoke scripts, historical robot notes | Runnable original oracle, strict gates, unmodified clients, deployment/hardware evidence |

There is **no defensible single whole-project completion percentage yet**. Asset preservation and limited corpus accuracy are useful measurements, but they are not feature-completion percentages. The new tracker records existing implementation as present/partial/missing/stub/unassessed separately from acceptance-based verification. Only the initial audit and planning tasks are checked off in this pass; this does not mean the existing implementation has no value.

## Audit boundaries and follow-up

- Original service/test execution is pending. The reference checkout lacks installed dependencies and compiled hub output; the bundled NLU ZIP is present. Archive discovery found NLU source, GQA fake services and registry/API material. We have not proven that restoring the oracle is impossible.
- All Classic API definitions were read through Jibo MCP; full controller/consumer semantics were not audited operation by operation. A-01 owns that expansion, including services without a normal.json definition.
- No live provider quality, hardware reset/update, browser simulator or full native/compose substitution was tested in this pass. Historical WORKLOG/HW notes remain historical evidence.
- Existing uncommitted application changes were preserved. The recorded source fingerprint covers 4,838 tracked/non-ignored package/script files; it excludes new audit tools and ignored runtime configuration/data.
- [PLAN.md](PLAN.md) describes the one-task-at-a-time lifecycle. [TASKS.md](TASKS.md) is generated from [tasks.json](tasks.json), which owns statuses and dependencies.
