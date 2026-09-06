# S-01 graph identity main integration candidate

Status: **candidate, awaiting lead review**

Base: `26f4b1f4807e3b7ceb80a27e2ee7f07d04bb11e3`

This candidate applies only the S-01 graph allocation commits `d77c6e3` and
`0959452` to the current main checkpoint. The main checkpoint's CLI
failure/logger repair and SettingsClient transport changes remain intact.
Selected Chitchat/PersonalReport hosts allocate from a fresh manager, while
the combined host constructs Chitchat before PersonalReport on one manager.

The focused deployment controls cover explicit `start(0, { skillId:
'report-skill' })`, `PHOENIX_SKILL_ID=report-skill` with `start(0)`, and the
cohosted route. They pass 20/20. The full skills suite passes 117/117.

The compiled strict43 capture used the profile pinned in
`.parity/reviews/service-wave-root/verify.py`:

- Node image: `node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94`
- launch FST SHA-256: `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`
- network: `none`; `PHOENIX_ENV_FILE=/dev/null`
- suite/reference: preserved service-wave artifacts, 43 cases

The candidate completed 43/43 cases with zero execution failures. Comparison
to the preserved service-wave reference has 290 differences, zero invariants,
and zero coverage gaps. The control comparison has 440 differences, zero
invariants, and zero coverage gaps. The complete unchanged/removed/added
records are in
`.parity/reviews/s01-graph-nodeid-main-integration-20260906/difference-set-comparison.json`:
283 records are shared, 157 control records disappear with the graph repair,
and 7 records are added from the resulting response changes. Added records
are retained in full, including cases 23, 25, 26, and 37–40; no request-order
values were collapsed.

Source/link manifests and capture/comparison receipts are retained in the
same review directory. The candidate is unverified pending independent lead
review and integration.
