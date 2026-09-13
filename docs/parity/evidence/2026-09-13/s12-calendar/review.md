# S-12 calendar expanded review

Status: **verification complete; candidate recommends `verified`**

Branch: `w21/s12-calendar`
Base: Phoenix `4bcdfbacb2c36623fd01b7dfb3fc2b168a1979e1`
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Worktree: `/home/shell/work/phoenix-s12-calendar`

The first archive lookup was Jibo MCP `jibo_search` for the Pegasus calendar source; it returned no hits. Gitea source reads then pinned the archive above. No web source was used. The Node 8 source runner reads `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`.

## Source branches audited

The pinned source was read at these paths and ranges:

- `packages/report-skill/src/subskills/calendar/CalendarData.ts:22-69`: `moment.parseZone(...).add(1, 'day').endOf('day').format()`, Google-over-Outlook precedence per personal/work slot, no-connected empty result, concurrent `Promise.all`, merge/sort, and all-or-nothing null on either provider failure.
- `packages/report-skill/src/subskills/calendar/CalendarParse.ts:29-97`: null input, today/tomorrow selection, asked-tomorrow selection, missing-summary fallback, missing-start/dateTime filtering, past timed filtering, full-day inclusion, and work-arrival/early classification.
- `packages/report-skill/src/subskills/calendar/CalendarMimLogic.ts:38-166`: ServiceDown/AppSetup, single-skill count/tomorrow/parallel/cap/Outro, full-report Nothing/NothingToday/EventToday/EventTomorrow/full-day variants, and EarlyEvent suppression.
- `packages/report-skill/tests/subskills/Calendar.test.js:70-560`: source controls for AppSetup/ServiceDown, Data provider selection and failure, malformed parse rows, full-report branches, and the two server-timezone controls.

The existing Phoenix repair in `packages/skills/src/report/calendar.js` keeps the source end-date wall date, written offset, and second precision. The repair remains bounded to the runtime ISO contract; it does not add Moment to Phoenix.

## Graph matrix and branch manifest

The expanded main matrix has 37 rows and runs every row through the pinned source graph, direct Phoenix graph, and the real Phoenix Data HTTP service with fixture upstreams. It includes AppSetup, asked-tomorrow with no events, missing-summary spoken fallback, isolated non-early full-report today/tomorrow, both full-day report variants, early plus full-day suppression for today/tomorrow, custom work time, both Google slots, both Outlook slots, Google-over-Outlook precedence on both slots, mixed provider failure/all-or-nothing, original merge/count/parallel/cap rows, provider failures, DST, and the two `-05:00`/`+05:00` source timezone controls.

The 5-row parse matrix separately exercises raw null, missing summary, missing start, missing `start.dateTime`, and past timed filtering. Malformed starts are kept in direct `CalendarParse` controls because source `CalendarData` sorts `start.timestamp` before parsing; the main matrix still carries missing-summary through the real provider normalization and complete action.

`scripts/parity-s12/branch-manifest.json` is fail-closed: every main row and every parse row is named, each material MIM branch has required/forbidden IDs or row-specific sequences/counts, provider selection has exact slot expectations, precedence has required/forbidden summaries, mixed failure has ordered probe statuses, and source paths are recorded per branch.

Hashes and differential results:

- main matrix: `38a79b79aafef0402af04304b8a7d5adeb55c81e5f113f8b2290c8791d220ca5`
- parse matrix: `2ecf96554f49bc34e81a00b547d0ced61fd1305bea18c09510011be347d38820`
- branch manifest: `e9569c74e5386c66bbd94db97d81cbefbb860b9c7ac349723774ef239a61057d`
- source runtime: `9b64c4ab2ea25d356319049b9971fd4bc13f63f6f53b3892aff2163170c58af1`
- direct candidate: `50e646fcbea5451fec57ca5b7f4af787876593efeae2427c4ad7f971901185f3`
- source/direct differential: `86100f20ae519ea0614d99ac2215b76ce191050a28738d1ee3b0cdb9aa959b1e`
- real-service candidate: `29be08a836cc45f08615f27573adae4f0487cb0beb656aa82bbe5ee071b35eef`
- source/real differential: `86100f20ae519ea0614d99ac2215b76ce191050a28738d1ee3b0cdb9aa959b1e`
- parse source: `74ea62285e84c083e2419885612686b97a5d9055dfe965484786749de76332ca`
- parse candidate: `a235f692b8cab959c910c7ad2afd1ef1426588498b0c8b3614f850dc8da09f3b`
- parse differential: `a2a763348740ff4f49a7f18d06d302353f80f688adde0e543aadfcfd4084838b`

The source/direct result is `pass`, 37/37 semantic matches, 37/37 prompt-signature matches, 37/37 complete normalized action matches, and zero coverage errors. Source/real is the same. The parse result is `pass`, 5/5 matches, and zero coverage errors.

The complete action comparator keeps prompt text, prompt IDs, MIM IDs, ESML, display/view data, analytics, transitions, and stable asset IDs. It strips only the four observed graph-generated paths: `config.jcp.id`, `config.jcp.children[*].id`, `config.jcp.children[*].config.play.id`, and `config.jcp.children[*].config.display.id`.

## Real Data HTTP path

`run-real-service-candidate.mjs` starts `createDataService`, injects Google and Outlook fixture providers, sets the report `NET_data` peer, and runs the actual `reportSkill` graph. Each report therefore uses the HTTP calendar route, relay envelope, provider normalization, cache, and report action. The runner probes every initiated route after the report and records cache/failure behavior. HTTP arrival order is scheduler-dependent, so the semantic receipt canonicalizes requests to the source personal-then-work order while retaining actual provider-call order in the service trace. The ephemeral listener port is emitted as `http://localhost:<ephemeral>` so the receipt hash is reproducible.

The receipt has 42 provider calls (32 Google, 10 Outlook) across 37 rows. AppSetup makes zero calls. Three rows have a 502 probe (`google-personal-expired`, `outlook-work-expired`, and `mixed-provider-failure-all-or-nothing`); the other 33 provider-bearing rows have cached 200 probes with `lassoDataFromRedis=true`. The mixed row initiates both selected slots, receives `[502, 200]` in source slot order, and the report action is `CalendarServiceDown` with null parsed data, proving the source `Promise.all` all-or-nothing result even though the successful route is independently cacheable.

The Google-over-Outlook row initiates exactly Google personal and Google work, and its complete parsed/action data contains the two Google summaries while excluding both Outlook summaries. Both-Google and both-Outlook rows each initiate exactly their two selected slots.

## Malformed parse and end-date controls

The parse receipt proves `No event description`, filters events without `start` or `start.dateTime`, and filters a past timed event. These rows match source and direct Phoenix exactly.

The pinned end-date matrix has 23 accepted/malformed ISO forms, including `Z`, zero and signed offsets, `±HH:mm`, `±HHmm`, hour-only offsets, `+24:00`, `+99:00`, date-only/bare values, leap/month/year rollover, `24:00`, and invalid input. Source and candidate match 23/23 with zero coverage errors:

- end-date matrix: `0b90e021f645c74d14d78b70ae45e44714cf03b4972342be7a5f6bc7a8adc8bc`
- source: `bee25cc9afcb17395a72193fde3b1293e206db2e1b317c65b954e6c62e2f7dd2`
- candidate: `5fb44214f3fb5225713d927ba10f8593b0ebd3b1a947c104f11653ee248d794e`
- differential: `6fb28eb595b162794c7f188cf820dd286fc7301c339472427ae775e79aa5535f`

The runtime ISO contract is the standard uppercase-T form supplied by report location data. Malformed/nonstandard forms are documented by the end-date receipt rather than generalized into a regional timezone promise; `parseZone` preserves the written fixed offset.

## Credential lifecycle

The existing OAuth lifecycle receipt remains `pass` for Google refresh failure and Outlook invalid token through actual CredentialStore/OAuth -> Data HTTP -> Report operations. It records one Google token request and zero Google provider calls for the Google row, and one Outlook provider call with zero token requests for the Outlook row; both credentials become inactive with `REFRESH_FAILED`/`INVALID_TOKEN`, and both report actions select `CalendarServiceDown`. Receipt SHA256: `9f6dbdb9db95d037e7704254bbfd7b398d1dca92761710b7221fae7914065022`.

## Fail-closed falsification and commands

Removing `asked-tomorrow-none` from the branch manifest with `apply_patch` made `node --test packages/skills/test/s12CalendarBranchCoverage.test.js` exit 1 with `single-asked-tomorrow-none: branch row IDs missing`; restoring the row made both branch tests pass. Temporarily forcing the old UTC/millisecond helper output made `node --test packages/skills/test/calendar-lasso-integration.test.js` fail 2/4 (D-04/i1 and S-12/i3 expected `2026-06-13T23:59:59-04:00` but received `2026-06-14T03:59:59.999Z`); removing the mutation restored 4/4.

The focused command was:

```text
node --test packages/skills/test/calendar-lasso-integration.test.js packages/skills/test/s12CalendarComparator.test.js packages/skills/test/s12CalendarOAuthLifecycle.test.js packages/skills/test/s12CalendarBranchCoverage.test.js packages/data/test/calendar-relay.test.js packages/data/test/oauth.test.js
```

It passed 51/51 with zero failures. The comparator tests include paired-null and paired-omitted semantic/action falsifications, paired-omitted and wrong-ISO end-date falsifications, prompt/action mutations, duplicate IDs, and paired row omission. Temporary comparator directories are removed in `finally` blocks.

The source commands use `docker run --rm --network none` with `node:8.9.4-slim`; direct and real candidates use host Node 22. `npm run test:unit` passed 1,995/2,004 with zero failures and nine skips. No live provider account, deployment, Android, robot, Moth, or hardware run is required by S-12's local fixture-through-Data/Report acceptance boundary.
