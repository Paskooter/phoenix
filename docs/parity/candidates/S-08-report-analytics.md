# S-08 candidate: Personal Report results analytics

Status: **bounded candidate; unverified pending root review**

Owner: Luna Max
Base: `7ae5fbc7793c88113fc41b7bd3fcb17bfef9081d`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Audit date: 2026-09-06

## Observed difference

The strict production comparison at
`.parity/reviews/n08-integration-root/production/comparison.json` records nine
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
review evidence under `.parity/reviews/s08-report-analytics-20260906/`.

The isolated production run reused the hash-pinned 43-case golden and the
compiled-FST profile. Its exact capture is in
`production-after/` under that private directory. The baseline comparison
had 488 differences, including 63 report analytics differences. After this
change the candidate had 423 total differences, zero report analytics
differences, zero invariants, and zero coverage gaps. The complete 11
source/candidate Report analytics records were byte/key-order equal; the
remaining differences are shared response/header framing, session, provider
requests, skill-request, and other runtime fields outside this candidate.

## Validation and limits

Focused builder tests cover full-report success/failure, single-category
selection, configured state, an empty selection, and one real report graph
response through the local Lasso peer. The full isolated unit run completed
with 487 tests, 484 passing, zero failures, and three skips; the focused S-08
file has four passing tests.
The source differential is a builder control, not a complete original service
execution. Provider HTTP behavior, Settings/Lasso deployment, report
views/news payloads, graph session differences, and the remaining strict
production differences remain outside this candidate. Root must rerun the
integrated production capture and review whether those provider/session
differences are independently owned.
