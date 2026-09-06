# C-03 main integration review

Root accepted the bounded slice in `16d4db2` after request-ownership and route-isolation repairs. See the [integration review](../evidence/2026-09-06/service-integration/review.json) for 448-unit confirmation, 78 source TCP matches, original Report-client controls and remaining limits. Earlier candidate observations below retain their original scope; full task acceptance is open.

Original candidate status: awaiting root review (superseded by the acceptance above). C-03 remains open.

This candidate starts from main `25430c15a1a66837fe3025bf6e08279bacea8ae8` in
`codex/candidate-c03-main-review-20260906` and imports only the report environment/cache,
report clients, generic skills CLI parser, relevant report tests/probes, and report launcher
wiring from `eb19f9489ce123b73e572e1eb55eb7b1b7dc924e`. Current main registry, NLU, tracker,
and unrelated service changes were retained.

The report environment now follows the pinned Pegasus names and defaults: `NET_lasso` is
`lasso:8080`, `NET_settings` is `settings.jibo.aws`, and `prefsFromConfig` is `false`.
`getReportEnv()` returns one mutable cached object until `clearReportEnvCache()`/`clearCache()`;
legacy `NET_data` and `ETCO_report_prefsFromConfig` are consulted only when their source names
are absent. Docker and native launchers set the source names explicitly while retaining the
Phoenix per-skill deployment selection.

The executable path uses the pinned Pegasus minimist 1.2.0 source (MIT license), with a narrow
guard against `__proto__`, `constructor`, and `prototype` dotted paths. Its 26-case generic
argv plus `parseInt(argv.p || argv.port || ETCO_server_port || '8080')` comparison matched
the source output 26/26. Source output was produced by the Node 8.9.4 image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`; candidate
replay ran with the candidate-local Node 22 workspace.

The original Node 8 report clients were also executed against a local recording peer with the
same logical fixture as the candidate clients. Decoded DarkSky and Settings values, URL paths,
and request bodies matched. Two wire differences remain recorded in the comparison: the
original Lasso GET forwards the synthetic `x-source-header` from `req.jibo.toHeader()` while
the Phoenix client sends no such header, and Axios emits
`application/json;charset=utf-8` for the original Settings POST while fetch emits
`application/json`. These are retained as explicit source-boundary differences; this slice
does not invent an authentication adapter. The source and candidate client receipts are under
`.parity/reviews/c03-main-review/client-comparison.json`.

Validation after `npm ci --ignore-scripts --offline` in this worktree passed the three focused
report tests 17/17 (log `.parity/reviews/c03-main-review/focused-report.log`, SHA-256
`16b2d337a90c96141f2c707022038b4d462fcd31c459d08a02fa1535f6cebcbc`) and the complete skills
suite 105/105. Workspace package links resolve into this candidate worktree; the receipt is
`.parity/reviews/c03-main-review/candidate-runtime-resolution.json` (SHA-256
`b28c95f257905a9d71db9eb0a4c62bf59421ec89f13cadd9db8b8f5c9a4bdb00`).

The 26-case control exercises parser and port-expression behavior, not the historical report
`run-service.js` wrapper. Actual help stderr behavior and the common runner's five-second
no-promise shutdown remain outside this candidate. No compose service, live port, robot, or
strict production capture was run, and provider/full C-03 parity remains unverified.
