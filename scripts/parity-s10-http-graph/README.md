# S-10 report news HTTP graph

This lane replays the pinned Pegasus report graph and the Phoenix report HTTP
graph against the same local AP-shaped Data peer. The peer records every
`GET /v1/ap_news` request and serves frozen XML; it has no network route to a
live provider. The source is `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`,
retrieved from the Jibo/Gebo archive, and runs in the digest-pinned Node 8.9.4
image recorded in the matrix.

The AP graph matrix has 16 cases. It covers configured category order, default
category fallback, one/two/many-category limits, the `strange` title, source
order, provider-header removal, missing summaries, missing preview/source/
dimensions, correction filtering, image geometry, dynamic title and Associated
Press attribution ESML, full and single-skill reports, unidentified speakers,
settings failure, empty and malformed XML, and all or partial AP service
failures. Both original `APNewsTestData.ts` exports are replayed through the
full report graph: the first retains its real AP media URLs and the second is
the source's empty/header-only response and must fail closed. The comparator
asserts normalized action/display graphs, exact MIM and prompt order, speech,
view projections, result analytics, and exact AP request route, query, headers,
status, and order.

The original AP XML exports are stored losslessly as gzip/base64 in
`original-ap-fixtures.cjs`; `ap-fixtures.cjs` keeps those fixtures separate from
the synthetic AP-shaped fixtures and from Phoenix's RSS adapter.

Run the complete source/candidate/comparator lane, including the negative
control, from this worktree:

```bash
node scripts/parity-s10-http-graph/run.mjs
```

Use `--reference PATH` to select another prepared Pegasus checkout and `--out
DIR` to choose where regenerated receipts and logs are written. The source
container uses `--network none`.

RSS/Atom behavior is a separate Phoenix Data adapter lane. It is deliberately
not counted as AP source parity: run the matrix's recorded verification command
to exercise the provider image forms, AP-envelope translation, attribution
handling, cache/poller lifecycle, and upstream errors:

```bash
node --test packages/data/test/news.test.js packages/data/test/news-poller.test.js
```

On the S-10 base these RSS tests pass 26/26. A source/candidate graph mismatch
or a forged ordered-MIM receipt makes `compare.mjs` exit nonzero; the negative
control requires that rejection and exits zero only when it observes it.
