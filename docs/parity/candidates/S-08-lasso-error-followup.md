# S-08 Report Lasso error and redirect follow-up

Status: unverified; isolated candidate for lead review.

Base: `db15280b6c5ee54bdbefe2b09acd221d32e1402e`, the reviewed S-08 Lasso
integration candidate. This follow-up is limited to
`packages/skills/src/report/lassoClient.js`, its focused source-edge tests, and
the realistic logger shape used by the affected Lasso test fixture.

The candidate makes the five direct property-access boundaries report the
Node 8 wording observed from the original client, while leaving provider and
response errors untouched. It also keeps the Phoenix logger adapter limited to
an object with callable `debug`, `info`, `warn`, and `error` methods; malformed
source logger objects still fail at `createChild`. Redirects now reuse one
initial `req.jibo.toHeader()` result, matching Axios/follow-redirects; the
destination `Host` remains transport-owned.

Evidence is under
`.parity/reviews/s08-lasso-error-followup-20260906/`. The original controls
use Pegasus source `5c0a7390539663ba749d360de348a428c088505c`, Node `v8.9.4`
image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`,
and the complete read-only mounted source/dependency tree
`/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c`
mounted at `/reference`. That tree contains both
`/reference/packages/report-skill/lib` and `/reference/node_modules`; no
separate mutable dependency mount was used. The exact Docker command and
output/script hashes are recorded in
`followup-receipt.json` in the evidence directory.

The fresh 44 functional controls match in case count and order: 11/11 core,
7/7 boundary, and 26/26 raw-TCP edge rows are exact, including the five
property-access messages that were qualified in the frozen `db15280` report.
The separate prefetch rejection control remains an explicit runtime
difference: original Node 8 records one unhandled rejected promise and the
Node 22 candidate records zero. No comparator or source golden was changed.

The added header-snapshot control covers relative GET, cross-authority GET,
and relative 307 HEAD redirects. Both runtimes call `toHeader()` once and
reuse the changing sentinel header on every hop; only dynamic ports/Host
values differ. The focused snapshot comparison is recorded beside the raw
outputs.

Validation in this worktree:

```text
node --test packages/skills/test/*.test.js                         131/131
node --test packages/skills/test/lassoClient.source-edge.test.js \
  packages/skills/test/lassoClient.source-wire.test.js               9/9
```

This remains pending root review and fresh integration. No main, robot,
Settings, source reference, golden, scheduler, driver, or comparator files
were changed.
