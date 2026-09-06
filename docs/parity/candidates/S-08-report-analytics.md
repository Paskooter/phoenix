# S-08 candidate: Personal Report results analytics

Status: **bounded analytics slice accepted by root; full S-08 remains open**

Root independently verified 486 unit passes, five original compiled-builder
controls and a fresh strict43 capture with 375 differences. The
[root review](../evidence/2026-09-06/service-integration/report-analytics-review.json)
records runtime limits and all seven changed content-length failures. The
agent evidence below retains its original scope.

Owner: Luna Max
Base: `26f4b1f4807e3b7ceb80a27e2ee7f07d04bb11e3`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Audit date: 2026-09-06

## Observed difference

The reviewed root production comparison at
`.parity/reviews/service-wave-root/production/comparison.json` records nine
repeated Report analytics differences. Phoenix emitted four boolean category
properties (`weather`, `calendar`, `commute`, and `news`) while the original
emitted the three source properties `details`, `service_details`, and
`config_state`. The repeated examples are the full report success/failure
paths and the single calendar/commute paths; this is a general builder and
caller mismatch rather than a case-specific response patch.

The frozen original implementation is
`packages/report-skill/src/Analytics.ts` (compiled control:
`packages/report-skill/lib/Analytics.js`). It selects active categories in
the order `weather, calendar, commute, news`, marks each selected provider
`up` when `data.result[category]` is truthy and `down` otherwise, and derives
`config_state` from `_personalReport.userPrefsConfigured`.

The compiled source control is SHA-256
`e846f7139299713f1842d28041438f3ef10f3310dc72c67aaefa9ca3e5e66d39`.

## Candidate change

`packages/skills/src/report/analytics.js` ports that builder and
`packages/skills/src/report/nodes.js` now uses it when recording the
`Personal Report Results` event. The framework `Skill Entry` event and the
raw provider/result data remain separate. No case IDs, response comparator,
goldens, or inactive fields are filtered at the comparison layer.

## Source control

The review-only control
`packages/skills/tools/s08-report-analytics-source-differential.mjs` executes
the pinned compiled original builder and the candidate builder over the same
five synthetic preference/result graphs: full weather/news success, weather
failure, single calendar, single commute failure, and no active services.
It compares complete property objects with key order preserved. Run it from
the candidate worktree with:

```text
node packages/skills/tools/s08-report-analytics-source-differential.mjs \
  /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c
```

The source path and SHA are recorded in the generated output and the private
review evidence under
`.parity/reviews/s08-report-analytics-integration-20260906/`.

The fresh integration capture reused the hash-pinned 43-case golden and the
compiled-FST profile from
`.parity/reviews/service-wave-root/verify.py`:

```text
PHOENIX_NLU_COMPILED_FST_SHA256=2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a
```

The exact capture is in `production/` under the private integration evidence.
Root's reviewed comparison had 440 differences, including 63 Report
analytics differences. The integration candidate has 375 differences, zero
Report analytics differences, zero invariants, and zero coverage gaps. All
375 remaining difference paths are shared with root; 65 root paths disappear
(63 analytics properties and two response content-length paths), with no new
paths. Of the shared records, 368 are byte-identical and seven content-length
records change because the corrected analytics object has a different size.
The complete 11 source/candidate Report analytics records are byte/key-order
equal. Full path and record details are in
`comparison-diff-report.json` in the private evidence.

The integration workspace fingerprint is stable before and after capture;
all `@phoenix/*` links resolve inside this worktree. The compiled profile,
source tree hash, commands, and exit statuses are recorded in `run.json`,
`workspace-before.json`, and `workspace-after.json`.

## Validation and limits

Focused builder tests cover full-report success/failure, single-category
selection, configured state, an empty selection, and one real report graph
response through the local Lasso peer. The integration worktree's complete
skills suite passed 116/116 tests with zero skips or failures; the focused
S-08 file has four passing tests.
The source differential is a builder control, not a complete original service
execution. Provider HTTP behavior, Settings/Lasso deployment, report
views/news payloads, graph session differences, and the remaining strict
production differences remain outside this candidate. Root has completed the independent integration checks linked above. Remaining
Report provider ordering and graph lifecycle work continues in separate candidates.
