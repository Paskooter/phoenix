# S-08 Report Lasso integration verification

Status: unverified; isolated integration candidate for lead review.

Base: `726430ac26a36f1d79dafb13d77da99e7f7c86d2` (`main726430a`). The only
product delta is the frozen S-08 Lasso transport follow-up from `d80c45f` and
`9965efd`; the integration commits are `148a378` and `4e58bbf`.

The candidate source hash is:

```text
packages/skills/src/report/lassoClient.js
sha256 a3ab46410d6ccdba3f65ec03766807af7066f9592dd27f3df18fcfacaa994205
```

Fresh source controls and candidate replays are recorded under
`.parity/reviews/s08-lasso-integration-20260906/`, using Pegasus
`5c0a7390539663ba749d360de348a428c088505c` and the pinned Node
`v8.9.4` image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The 44 source-controlled vectors are 11 core, 7 boundary, and 26 raw-TCP
edge cases. Their source/candidate case order and counts match. The edge
comparison reports 21 exact rows and five explicit Node 8 versus Node 22
property-access TypeError wording qualifications:
`missing-req`, `missing-jibo`, `missing-log`, `missing-location`, and
`null-location`. It does not qualify request bytes, headers, response fields,
status, or operation outcomes. The separate prefetch control retains the
source's one unhandled rejected promise versus zero in the candidate; this is
an explicit divergence and is not hidden by the 44-case comparison.

The exact compiled profile from `.parity/reviews/s01-label-root/verify.py`
was used for the fresh strict production run. The 43-case result is
`match`, with 0 differences, 0 invariants, and 0 coverage gaps. The previous
baseline's 218 literal difference records are preserved in
`strict43-delta.json`: all 218 were removed and none were added. The strict
run also verified the candidate workspace fingerprint was unchanged before
and after capture, with all `@phoenix/*` links resolving inside this
worktree.

Validation on the integration worktree:

```text
node --test packages/skills/test/*.test.js       129/129
node --test packages/skills/test/lassoClient.source-wire.test.js packages/skills/test/lassoClient.source-edge.test.js  7/7
```

No main, robot, Settings, source reference, golden, comparator, or scheduling
files were changed.
