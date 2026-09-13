# S-12 calendar bounded review

Status: **verification complete; candidate recommends `verified`**

Branch: `w21/s12-calendar`
Base: Phoenix `/home/shell/work/phoenix` `4bcdfbacb2c36623fd01b7dfb3fc2b168a1979e1`
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Worktree: `/home/shell/work/phoenix-s12-calendar`

The first Jibo MCP operation was `jibo_search` for `Pegasus CalendarData endOfTomorrowISO Google Outlook calendar events`; it returned no hits. I then used the Jibo Gitea source tools against the pinned `jiboV2/pegasus` repository. No web source was used. The cached source root used by the Node 8 runner is `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`.

## Source finding and repair

Pinned `packages/report-skill/src/subskills/calendar/CalendarData.ts:22` computes the request boundary as:

```ts
moment.parseZone(iso).add(1, 'day').endOf('day').format()
```

That preserves the written offset and emits second precision. Phoenix previously converted the same instant to UTC with `.999` milliseconds. For an Eastern location, the old request was `2026-06-14T03:59:59.999Z`; the source request is `2026-06-13T23:59:59-04:00`. The Phoenix implementation in `packages/skills/src/report/calendar.js` now implements the source ISO calendar forms locally, preserving `Z`, `±HH:mm`, `±HHmm`, hour-only offsets, wall-date arithmetic, and `Invalid date` for malformed input. It does not add moment to the Phoenix runtime.

The source and candidate end-date receipts cover 23 rows, including UTC and zero offsets, `±HH:mm`, `±HHmm`, hour-only offsets, `+24:00`, `+99:00`, bare/date-only/month-only/year-only values, leap and non-leap February, month/year rollover, `24:00`, malformed dates, and trailing whitespace. The pinned Node 8 source and Phoenix candidate match `23/23`, with `coverageErrors=0`:

- matrix SHA256: `0b90e021f645c74d14d78b70ae45e44714cf03b4972342be7a5f6bc7a8adc8bc`
- source receipt SHA256: `bee25cc9afcb17395a72193fde3b1293e206db2e1b317c65b954e6c62e2f7dd2`
- candidate receipt SHA256: `5fb44214f3fb5225713d927ba10f8593b0ebd3b1a947c104f11653ee248d794e`
- differential receipt SHA256: `6fb28eb595b162794c7f188cf820dd286fc7301c339472427ae775e79aa5535f`

The missing `iso` case is fail-closed as `Invalid date`. The source's `moment.parseZone(undefined)` uses a live clock, while the report request contract supplies `runtime.location.iso`; this live-clock fallback is outside the S-12 request boundary.

## Source/runtime differential

The source paths read from the pinned archive were `CalendarData.ts`, `CalendarParse.ts`, `CalendarMimLogic.ts`, `CalendarFactory.ts`, `index.ts`, and `packages/report-skill/tests/subskills/Calendar.test.js`. The Phoenix paths are `packages/skills/src/report/calendar.js`, `packages/skills/src/report/calendar-lasso-integration.test.js`, and the S-12 runner/comparator files under `scripts/parity-s12/`.

The 21-row matrix covers:

- personal/work Google and Outlook requests, mixed Google-personal plus Outlook-work merge, no events, and concurrent equal-start events;
- today/tomorrow selection, an explicit tomorrow request, all-day and overnight events, daily event count/walk cap;
- early events against work arrival, before-noon and after-noon no-event full reports;
- Eastern spring/fall boundaries and a Pacific offset;
- Google and Outlook fixture provider failures representing expired credentials.

The pinned source graph ran in `node:8.9.4-slim`; the Phoenix direct runner and real-service runner used host Node `22.22.0`. For the direct graph differential:

- matrix SHA256: `a03c57429001e4ff884c7c7b58f036528408795cfce78be3d213edfa3c5e33c5`
- source runtime SHA256: `b35fff753c7637a0de650ab6339f8313d25b1e12e7bf24f5095f5844d72e70b3`
- candidate runtime SHA256: `183f91f28094b101e80fddbb36456c1a754dd7d8c640ad991283c6b53e08636a`
- differential SHA256: `08135d1d6e714d30cf1eb9b120d72cca0e117082aea7206be16ec35d5b5f8939`

The direct source/candidate result is `pass`, `21/21` semantic matches, `21/21` prompt signature matches, `21/21` complete normalized action matches, and zero coverage errors.

Action comparison retains all consumer-visible fields. The only generated IDs observed to differ across source and Phoenix are these four paths:

```text
config.jcp.id
config.jcp.children[*].id
config.jcp.children[*].config.play.id
config.jcp.children[*].config.display.id
```

No `nodeID` path differed. Stable component asset IDs and view IDs remain in the comparison. The comparator rejects a paired row omission, duplicate row ID, prompt mutation, and action-only mutation; the focused comparator controls pass `6/6`.

## Real Phoenix data-service path

`scripts/parity-s12/run-real-service-candidate.mjs` starts `createDataService` with Google and Outlook fixture upstreams, sets the report's `NET_data` peer, and runs the actual `reportSkill` graph. Each report request therefore traverses the HTTP calendar route, relay envelope, provider normalization, cache, and report action graph. After each report call the runner probes the same route again to verify the cached envelope; failed provider rows are probed as 502 text responses without allowing an uncached probe to extend the report-call loop.

The real-service receipt covers all 21 matrix rows and 23 report provider calls: 16 Google and 7 Outlook. It has 21 successful route probes with `lassoDataFromRedis=true` across 19 rows and two 502 fixture failures for the expired Google and Outlook rows. Source versus real-service candidate is exact: `21/21` semantic, prompt, and action matches with zero coverage errors.

- real-service candidate SHA256: `e011747a897b68d7ef0d6d586a46c79c8397d5286d1f3b9a16484888fa8963d7`
- real-service differential SHA256: `08135d1d6e714d30cf1eb9b120d72cca0e117082aea7206be16ec35d5b5f8939`

The real HTTP route evidence is local fixture evidence. It does not claim a live Google/Outlook account, external OAuth token, deployed Phoenix peer, or robot run. Existing data-service checks also pass 19 calendar relay tests and 15 OAuth/expired-credential tests (34 total in the focused command).

## Credential lifecycle through the real chain

The additional lifecycle runner seeds actual `CredentialStore` records and uses the real
`createOAuthProvider`, Data HTTP service, calendar relay and `reportSkill` graph. Google's
local token endpoint returns `invalid_grant` for an expired refresh; Outlook's fixture
provider raises the source-shaped 401 invalid-token error. Both report launches finish with
the exact source `CalendarServiceDown` action and the stored credential is inactive with the
source error code. A follow-up HTTP route request returns 502 after invalidation, proving the
Data failure is observable at the service boundary.

The lifecycle receipt is `pass` for both rows, with operation counters captured immediately
after the report and again after the follow-up probe:

- `google-refresh-failure`: HTTP 502, `REFRESH_FAILED`, one `CalendarServiceDown` MIM,
  complete action match to source row `google-personal-expired`; the report made exactly one
  `/google-token` request and zero Google provider calls, and the follow-up made no calls.
- `outlook-invalid-token`: HTTP 502, `INVALID_TOKEN`, one `CalendarServiceDown` MIM,
  complete action match to source row `outlook-work-expired`; the report made exactly one
  Outlook provider call and zero token requests, and the follow-up made no calls.

- OAuth lifecycle receipt SHA256: `9f6dbdb9db95d037e7704254bbfd7b398d1dca92761710b7221fae7914065022`

The focused lifecycle test executes this runner against a temporary output and asserts both
credential states, 502 responses, MIMs and complete source action matches.

## Verification matrix

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Personal/work Google and Outlook fixtures through real Phoenix data and report services | VERIFIED (bounded) | 21-row real-service runner; 23 HTTP provider calls; cached relay probes; exact source action receipt |
| No events and merged ordering | VERIFIED | `no-events`, `merge-google-personal-outlook-work`, `merge-concurrent-parallel` rows; source/runtime exact |
| All-day and overnight | VERIFIED | `all-day-today`, `overnight-today`; real HTTP normalization and exact action output |
| Today/tomorrow and explicit tomorrow | VERIFIED | `today-and-tomorrow`, `asked-tomorrow`, provider-specific rows |
| Work hours | VERIFIED | early today/tomorrow plus before/after noon full-report rows |
| Timezone and DST | VERIFIED | Eastern spring/fall, Pacific offset, source end-date 23-row differential |
| Expired credentials/provider failures | VERIFIED | two actual CredentialStore/OAuth -> Data HTTP -> Report rows; 502, stored `REFRESH_FAILED`/`INVALID_TOKEN`, `CalendarServiceDown`, and complete action matches; D-03 covers deeper OAuth permutations |
| Classifications, MIM selection, names/times, complete action output | VERIFIED (matrix) | source/direct and source/real receipts: 21/21 semantic, prompt, complete action |
| Live provider credentials, deployed peer, and robot rendering | SEPARATE SCOPE | S-12 acceptance is satisfied by local provider fixtures through real Phoenix Data/Report services; live accounts/deployment/robot rendering belong to other lanes |

The S-12 acceptance is complete on the written local-service boundary. Live provider accounts,
deployment and robot rendering remain explicit limits of this candidate and are tracked by the
other provider/deployment/display tasks; they are not S-12 blockers.

## Commands and results

```text
docker run --rm --network none --mount ... node:8.9.4-slim node /work/scripts/parity-s12/run-source.cjs ...
node scripts/parity-s12/run-candidate.mjs scripts/parity-s12/matrix.json .../candidate-runtime.json
node scripts/parity-s12/compare.mjs .../source-runtime.json .../candidate-runtime.json .../differential-receipt.json
node scripts/parity-s12/run-real-service-candidate.mjs scripts/parity-s12/matrix.json .../real-service-candidate.json
node scripts/parity-s12/compare.mjs .../source-runtime.json .../real-service-candidate.json .../real-service-differential.json
docker run --rm --network none --mount ... node:8.9.4-slim node /work/scripts/parity-s12/run-end-date-source.cjs ...
node scripts/parity-s12/run-end-date-candidate.mjs ...
node scripts/parity-s12/compare-end-date.mjs ...
node scripts/parity-s12/run-oauth-lifecycle-candidate.mjs scripts/parity-s12/matrix.json .../source-runtime.json .../oauth-lifecycle.json
node --test packages/skills/test/calendar-lasso-integration.test.js packages/skills/test/s12CalendarComparator.test.js packages/skills/test/s12CalendarOAuthLifecycle.test.js packages/data/test/calendar-relay.test.js packages/data/test/oauth.test.js
npm run test:unit
```

The focused command passes `45/45` with zero failures. The final full suite passes `1,989/1,998` with zero failures and nine skips (`npm run test:unit`).

The falsification temporarily restored the old UTC `.999` helper with `apply_patch` and ran `node --test packages/skills/test/calendar-lasso-integration.test.js`: `1/4` passed and `3/4` failed, with the request reverting to `2026-06-14T03:59:59.999Z`. The source-shaped helper was restored with `apply_patch`; the restore check passed `4/4`.

No root checkout, remotes, Moth, deployment, hardware, or Android files were changed. The
candidate does not change the task ledger; root may promote S-12 after review.
