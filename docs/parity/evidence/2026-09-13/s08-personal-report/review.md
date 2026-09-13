# S-08 Personal Report closure candidate

Review date: 2026-09-13<br>
Phoenix branch: `w17/s08-report-orchestration`<br>
Phoenix revision reviewed: `09587f2870d88add5e74cbcf80d465be8216b782`<br>
Worktree: `/home/shell/work/phoenix-s08`<br>
Pinned source: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`

**Recommendation: UNKNOWN — keep S-08 open.** The requested local Report
orchestration, preferences, identity, and analytics paths have direct Phoenix
test evidence and agree with the pinned source structure and source tests. A
complete source-runtime differential for every S-08 acceptance path is not
recorded here, the detached prefetch rejection remains a deliberate process
behavior difference, and live provider/deployment behavior is unverified.
Therefore this artifact is a closure candidate for review, not a verified-task
claim.

## Evidence labels and provenance

Each finding is labeled as follows:

- **VERIFIED** — directly observed in the pinned source, a checked-in Phoenix
  test, an accepted prior evidence receipt, or a reproducible local command.
- **INFERRED** — the source and Phoenix implementation have the same visible
  structure or the behavior follows from the checked-in code, but there is no
  direct source-runtime comparison for that exact case.
- **UNKNOWN** — the available evidence does not establish equivalence.

The Jibo MCP search was run first for this review (`PersonalReport SettingsClient
UserID opt-in orchestration`, no direct search hit). Repository discovery then
selected `jiboV2/pegasus`; the source files below were read with
`gitea_read_file` at the exact pinned SHA. This preserves the source revision
even though the archive repository's default branch is named `phoenix`.

## Pinned source and Phoenix paths

All Pegasus paths in this table are at
`jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`.

| Contract | Pinned Pegasus path | Phoenix path at `09587f2` |
| --- | --- | --- |
| Report graph and transitions | `packages/report-skill/src/PersonalReport.ts` | `packages/skills/src/report/personalReport.js` |
| Launch intent split | `packages/report-skill/src/nodes/IntentSplitNode.ts` | `packages/skills/src/report/nodes.js` |
| Preferences and settings failure paths | `packages/report-skill/src/nodes/GetUserPrefsNode.ts` | `packages/skills/src/report/nodes.js` |
| Provider fan-out and partial failures | `packages/report-skill/src/nodes/GetDataNode.ts` | `packages/skills/src/report/nodes.js` |
| Category toggles | `packages/report-skill/src/nodes/ToggleNode.ts` | `packages/skills/src/report/nodes.js` |
| Response parsing | `packages/report-skill/src/nodes/ParseDataNode.ts` | `packages/skills/src/report/nodes.js` |
| Settings request/conversion/defaults | `packages/report-skill/src/SettingsClient.ts` | `packages/skills/src/report/settingsClient.js` |
| Identity graph | `packages/report-skill/src/subgraphs/userid/UserIDFactory.ts` | `packages/skills/src/report/userId.js` |
| Identity weather prefetch | `packages/report-skill/src/subgraphs/userid/PrefetchWeatherNode.ts` | `packages/skills/src/report/userId.js` |
| Opt-in transition graph | `packages/baseskill/src/graph/mims/factories/OptInFactory.ts` | `packages/skills/src/graph/mims/optIn.js` |
| Opt-in route and answer handling | `packages/baseskill/src/graph/mims/nodes/optIn/RouteNode.ts`; `packages/baseskill/src/graph/mims/nodes/optIn/YesNoWrongIDNode.ts` | `packages/skills/src/graph/mims/optIn.js` |
| Results analytics | `packages/report-skill/src/Analytics.ts` | `packages/skills/src/report/analytics.js` |
| Report orchestration tests | `packages/report-skill/tests/PersonalReport.test.js`; `packages/report-skill/tests/SettingsClient.test.js`; `packages/report-skill/tests/TestUtils.js` | `packages/skills/test/intentResponses.test.js`; `packages/skills/test/report.e2e.test.js`; `packages/skills/test/reportConfig.test.js`; `packages/skills/test/reportSubskills.test.js`; `packages/skills/test/reportAnalytics.test.js` |
| Generic opt-in tests | `packages/baseskill/tests/OptInSkill.test.ts` | `packages/skills/test/s03MimFactories.test.js` |

Prior accepted S-08 evidence retained in this review:

- `docs/parity/evidence/2026-09-06/service-integration/report-analytics-review.json`
  — source analytics builder controls 5/5; accepted bounded analytics change;
  full S-08 and live providers explicitly remain open.
- `docs/parity/evidence/2026-09-06/service-integration/report-lasso-review.json`
  — 51/51 bounded Lasso controls exact and strict43 at 0 differences;
  detached prefetch rejection explicitly excluded and retained as a divergence.
- `docs/parity/candidates/S-08-lasso-followup.md` and
  `docs/parity/candidates/S-08-lasso-snapshot-followup.md` — transport scope
  and its limits.

## Acceptance mapping

The task text in `docs/parity/tasks.json` has two acceptance criteria. The
tracker is intentionally unchanged by this artifact.

### Criterion 1 — launch, identity, opt-in, preferences, ordering, and requests

| Acceptance slice | Result | Direct evidence and limits |
| --- | --- | --- |
| Launch intents `launchPersonalReport`, `requestWeatherPR`, `requestNews`, `requestCalendar`, `requestCommute` | **VERIFIED** for the local request/response contract | The pinned `IntentSplitNode.ts` lists the same five intents and reactive/proactive transitions. Phoenix `intentResponses.test.js` covers weather, news, calendar, commute, and full-report launch; unknown intent retains `Unknown intent: '...'`. A complete source-runtime replay of all five through the original service is not recorded here. |
| Reactive UserID graph and recognized speaker | **VERIFIED** for checked paths | Pinned `PersonalReport.ts` routes Reactive through `UserIDFactory`; Phoenix `personalReport.js` has the same graph. `intentResponses.test.js` and fresh serialized-session probes show a recognized adult enters preferences/report without `WhoIsThis`. Weather/news single-skill identity bypass and calendar/commute identity requirement are covered locally. |
| Unknown speaker / identity continuation | **VERIFIED** for NI/NM/identity paths | Pinned `UserIDFactory.ts` uses `WhoIsThis`, sends NoInput to `MaxNI`, NoMatch to `SetLooper`, and routes `NotInLoop` to `Done`. Phoenix probes reproduce `WhoIsThis` QN, `MaxNI` terminal no action, and `MaxNM` → `NotInLoop` → default report. |
| Opt-in `Accepted` | **VERIFIED** for the checked serialized continuation | Pinned `PersonalReport.ts` maps `Accepted` back to `GetUserPrefs`; `OptInFactory.ts` maps `yes` to `Accepted`. Phoenix configured proactive `yes` continues through GetPrefs/GetData and emits report MIMs, Skill Offer `yes`, and Results analytics. |
| Opt-in `NotInLoop` | **VERIFIED** for the checked default path | Pinned `SettingsClient.ts` returns defaults for missing or `notInLoop` looper IDs. Phoenix `wrongID` → `notInLoop` continuation returns weather/news defaults (calendar/commute disabled) and continues the report. |
| Opt-in `Declined` | **VERIFIED** | Pinned graph maps Declined to the final node. Phoenix `no` and exhausted opt-in NI/NM paths emit final `OptInDecline`, with the matching Skill Offer response modality and no Results event. |
| All-disabled adult preferences | **VERIFIED** for proposal and local fallback | Pinned `GetUserPrefsNode.ts` computes `configured=false`, selects `OptInNotConfigured` for proactive launch, and restores defaults for a reactive report. Phoenix emits the same not-configured proposal and default category behavior. |
| Child speaker and no speaker | **VERIFIED** for checked local paths | Pinned `SettingsClient.ts` returns default preferences for a child or absent speaker; pinned tests name both cases. Phoenix covers child calendar → `MustBeAdult`, full-report missing speaker → `WhoIsThis`, and default weather/news continuation. |
| `prefsFromConfig` | **VERIFIED** for the local configuration seam | Pinned `SettingsClient.ts` returns the report preference config when `prefsFromConfig === 'true'`. Phoenix `reportConfig.test.js` verifies source precedence/default strings and `reportSubskills.test.js` runs with the config fixture. The Phoenix `ETCO_report_prefsFromConfig` alias is an implementation compatibility seam; it is not evidence of a live deployment setting. |
| Settings request body, headers, and missing transID | **VERIFIED** at the local HTTP boundary | Pinned `SettingsClient.ts` uses only `data.req.jibo.transID`, warns when absent, and posts `{loopId, transId, getView:false, skills:'report-skill'}`. `reportConfig.test.js` observes the exact body, source Axios headers, redirects, compression, rejection data, and no fallback to `data.trace.transID/transId`; commit `0a5e90acf5628b4ca6b11e5457436c10ffc125f6` records the fallback repair. |
| Settings conversion and defaults | **VERIFIED** for covered fields | Pinned tests cover malformed settings, calendar credentials, commute completeness, no speaker/child defaults, and invalid response fallback. Phoenix `reportConfig.test.js` covers conversion, source commute enum order, default shape, and settings failure; commit `09587f2870d88add5e74cbcf80d465be8216b782` records the order repair. |
| Category ordering and toggles | **VERIFIED** for the checked report paths | Pinned `GetDataNode.ts` provider request order is calendar, weather, commute, news; `PersonalReport.ts` toggles/output order is weather, calendar, commute, news. Phoenix `nodes.js` and `personalReport.js` preserve both orders. `report.e2e.test.js`, `reportSubskills.test.js`, and Results analytics tests observe selected category sequences. |

### Criterion 2 — speaker/prefs/failure/continuation/analytics behavior

| Acceptance slice | Result | Direct evidence and limits |
| --- | --- | --- |
| Recognized adult full report | **VERIFIED** for local fixture behavior | Phoenix emits the source-shaped kickoff, active category MIMs, per-service degradation, outro, and Results analytics for a recognized adult. `report.e2e.test.js` exercises a real local Lasso peer; `intentResponses.test.js` exercises dead-settings/default degradation. |
| Unknown speaker and `WhoIsThis` | **VERIFIED** for local NI/NM/session state | The source tests explicitly cover `WhoIsThis` QN, maxNI exit, and maxNM default flow. Phoenix fresh-session probes reproduce the QN prompt, `_mim` counters, `noInputMax`, `noMatchMax`, final state, and continuation. |
| No preferences | **VERIFIED** for source-shaped default selection | Pinned Settings tests and `PersonalReport.test.js` define weather/news active and calendar/commute inactive defaults. Phoenix `SettingsClient.getDefaultPrefs` and report tests produce that shape. |
| All-disabled preferences | **VERIFIED** for source-shaped proposal/fallback | The pinned Personal Report tests distinguish `OptInConfigured` from `OptInNotConfigured` and restore defaults when no category is active. Phoenix reproduces the distinction and fallback. |
| Partial provider failures | **VERIFIED** for the exercised local degradation contract; **INFERRED** for every provider/error permutation | Phoenix runs each selected provider, preserves remaining report categories when a provider returns a service-down result, records `up/down` Results status, and closes with the source outro. This is covered by `report.e2e.test.js`, `reportAnalytics.test.js`, and the full unit run. The source graph's `Promise.all` and catch structure is read directly, but no exhaustive pinned-original runtime matrix for every rejected-provider permutation is stored here. |
| Multi-turn opt-in accepted/not-in-loop/declined | **VERIFIED** for serialized Phoenix sessions | Fresh-process probes and `s03MimFactories.test.js` cover cached speaker restoration, `yes`, `no`, `wrongID`, `notInLoop`, NI/NM exhaustion, and response finality. Phoenix `personalReport.js` preserves the source graph return transitions. |
| Matching analytics | **VERIFIED** for accepted bounded scope | `reportAnalytics.test.js` checks category order, selected-service status, empty selection, configured state, and the real report response path. Prior accepted `report-analytics-review.json` records 5/5 source builder controls and strict43 candidate 0 differences, while explicitly limiting the claim to analytics. |
| Exact original runtime output for the complete S-08 matrix | **UNKNOWN** | Source code and source test names were read at the pinned SHA, and Phoenix local tests/probes pass. A single committed source-vs-Phoenix replay covering every acceptance row, including live Settings/provider interactions, is not present in this artifact. |

## Compact behavior matrix

This matrix records the observed source contract and Phoenix result. Prompt
indices vary because the source MIM renderer chooses among valid prompt
variants; MIM identity, transition, session state, finality, category order,
and analytics are the stable comparison fields.

| Input/session | Pinned source behavior | Phoenix observation | Label |
| --- | --- | --- | --- |
| Proactive adult with active prefs | `GetUserPrefs` sets configured, then `OptInConfigured` VERIFY_ID proposal | `OptInProposalVerifyID`, `shared/verify_id`, `userPrefsConfigured=true` | **VERIFIED** |
| Proactive adult with all categories disabled | `userPrefsConfigured=false`, then `OptInNotConfigured` proposal | `PersonalReportOptInNotConfigured_*`, `shared/verify_id`, configured flag false | **VERIFIED** |
| Configured proposal + `yes` | Opt-in `Accepted` returns to GetPrefs and runs report | Final report sequence; Skill Offer `yes`; Results details in source category order | **VERIFIED** |
| Configured proposal + `wrongID` + `notInLoop` | SetLooper NotInLoop returns to GetPrefs; defaults weather/news | Final default report with weather/news active and calendar/commute inactive | **VERIFIED** |
| Configured proposal + `no` | Opt-in `Declined` reaches final node | Final `OptInDecline`; no report Results | **VERIFIED** |
| Proposal + no-input/no-match exhaustion | Proposal ladder reaches decline | Final `OptInDecline`, matching `no-input`/`no-match` Skill Offer modality | **VERIFIED** |
| Reactive full report, no speaker + `loopmember` referent | SetLooper success sets present person and continues | `SET_PRESENT_PERSON` followed by report sequence | **VERIFIED** |
| Reactive full report, no speaker + repeated no-input | QN → NI exhaustion → UserID MaxNI → final | Second identity update final with no action and `noInputMax=true` | **VERIFIED** |
| Reactive full report, no speaker + repeated no-match | QN → NM exhaustion → SetLooper NotInLoop → default report | Second identity update runs default report | **VERIFIED** |
| Reactive child speaker | Settings defaults; category-specific calendar/commute path requires adult | Phoenix child calendar emits `PersonalReportMustBeAdult`; full report uses defaults | **VERIFIED** |
| One provider unavailable while others respond | Selected categories continue through source failure/degradation path and Results status | Local Lasso fixture emits remaining MIMs and `service_details` up/down values | **INFERRED** for exhaustive source-runtime equality |

## Detached prefetch rejection

**VERIFIED finding:** the pinned `PrefetchWeatherNode.ts` calls
`LassoClient.fetchDarkSky(data, null, true)` and the yesterday call without
awaiting or attaching a rejection handler. The accepted Lasso evidence records
`sourceUnhandledRejections: 1`, `candidateUnhandledRejections: 0`, with the
request and resolved value otherwise agreeing; the vector was excluded from
the 51 exact transport controls.

This difference is process-observable, but it is not observable in the HTTP
client's returned Report response for the tested failure: the WhoIsThis/report
turn, defaults, MIMs, final state, and Results analytics remain the same. It
can be observed by a process-level `unhandledRejection` listener, logging
policy, or a runtime that terminates on unhandled rejections. Phoenix catches
the detached rejection in `packages/skills/src/report/userId.js` to keep that
process hazard from escaping.

No repair is recommended in this closure artifact. Imitating the source's
unhandled rejection would reproduce a process hazard without changing the
client-visible Report contract. If exact Node 8 process events are later made
part of the acceptance contract, this needs a separately reviewed decision and
a source/candidate process-level control.

## Live provider and deployment boundary

**VERIFIED:** the two literal S-08 acceptance strings in `docs/parity/tasks.json`
require source-test comparisons and verification of speaker, preferences,
partial failures, continuation, and analytics. They do not explicitly require
live provider DNS/TLS access, a deployed Settings/Lasso service, a Hub, or a
physical robot.

**UNKNOWN:** this review does not prove live provider behavior, credentials,
DNS/TLS, network retries, deployed service routing, or real-robot Report
behavior. The prior accepted Lasso review explicitly lists live providers,
complete Report orchestration, and deployment as limits. Those are release or
integration concerns unless the lead expands S-08's acceptance text.

The current `S-08` finding in `docs/parity/tasks.json` also names live provider
behavior and deployment as open. That is a tracker finding and scope warning;
it is separate from the two literal acceptance strings above.

**INFERRED:** local peer tests are a useful simulation of provider success and
failure, but they cannot establish that the production provider responses,
credentials, network timing, and deployment logger seam match the historical
environment.

## Commands and results

Commands were run from `/home/shell/work/phoenix-s08` at
`09587f2870d88add5e74cbcf80d465be8216b782`.

```text
node --test packages/skills/test/reportConfig.test.js \
  packages/skills/test/report.e2e.test.js \
  packages/skills/test/intentResponses.test.js \
  packages/skills/test/reportAnalytics.test.js \
  packages/skills/test/reportSubskills.test.js \
  packages/skills/test/s03MimFactories.test.js
# tests 77; pass 77; fail 0; skipped 0

node --test packages/data/test/calendar-relay.test.js
# tests 19; pass 19; fail 0; skipped 0

npm run test:unit
# tests 1969; suites 7; pass 1960; fail 0; skipped 9; exit 0
```

The first full-unit attempt encountered a transient `EADDRINUSE :::7810` in
unrelated `packages/data/test/calendar-relay.test.js` case D-04/19. The
isolated 19-test retry passed, followed by the green full-unit retry above.

Prior accepted receipts add these bounded results:

- `report-analytics-review.json`: 486 unit passes, 5/5 source builder controls,
  and strict43 candidate 0 differences; source builder ran in host Node 22 and
  did not certify full Report runtime/provider behavior.
- `report-lasso-review.json`: 512 unit passes, 51/51 source transport controls,
  and strict43 candidate 0 differences; the detached prefetch process event is
  explicitly outside those exact controls.

## Closure decision

The requested local behavior is sufficiently covered to support a review of
the Report implementation, but the evidence does not justify changing S-08 to
`verified`. Keep the task open until the lead either records a complete
pinned-original/runtime differential for the remaining orchestration rows or
explicitly accepts the source-runtime and live/deployment limits. The
detached prefetch rejection should remain a named divergence rather than be
silently treated as exact parity.
