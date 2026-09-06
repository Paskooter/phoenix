# S-08 Report LassoClient wire candidate

Status: unverified; isolated candidate for lead review.

Base: `14acdecdf8df1bde1127e3e2f43a77d08b1122bf`.

The candidate replaces the Report Lasso calls' global `fetch` path with a
small source-shaped HTTP adapter. The adapter follows the pinned Axios 0.17.1
request contract: parameter insertion order and nested-object JSON encoding,
the Axios Accept/User-Agent/Connection headers, JSON response transformation,
non-2xx response errors, gzip/deflate decompression, and follow-redirects
method behavior. Dark Sky, Google Maps, AP News, and calendar calls now use
that adapter. AP category errors remain attached to their individual category.
`relayData` is required to be truthy, matching `LassoClientUtils`.

The source oracle is frozen Pegasus commit
`5c0a7390539663ba749d360de348a428c088505c`. Relevant source hashes are:

```text
packages/report-skill/src/LassoClient.ts       03c51556c302c9ddf48147b62b3abea2ecd250db55a00b03cca5820bc148c2c5
packages/report-skill/src/LassoClientUtils.ts  6d45345b87df0e3c325c5e8f8317f57f4894a595b4d530915110a5bcd53eb121
packages/report-skill/lib/LassoClient.js       38c2640d359d693228d422daa015d99007fdb3d8a4c1de34bd0de2e692dc1501
axios/package.json                             c4da53715686c72861c8876808bb4c3832a93e39eb260b609ea4a0be567ba1e0
axios/lib/adapters/http.js                     bfdf6268e34b49b7199ef095f2583710f941f9cf502f592781889cdde8e5344e
axios/lib/helpers/buildURL.js                   9f6b41fef812223a1fcd8b8e92297cf09701cab4a7218ae025b1804cfab043b4
```

The candidate source hash is
`510e09564c1c409782db62c5b18560d86b27528d6b45c4979f416a70afcdadb9`.

Evidence and repeatable probes are in
`.parity/reviews/s08-lasso-20260906/`:

- `source-lasso.json` and `candidate-lasso.json` compare 11 core vectors:
  Dark Sky GET/UTC/HEAD prefetch, nested Google Maps parameters, three AP
  categories including an unknown category, calendar parameters, 503, empty
  and invalid JSON, gzip, and a redirect.
- `source-lasso-boundary.json` and `candidate-lasso-boundary.json` compare 7
  source-executed boundary vectors: HEAD/GET redirects, 302 without Location,
  empty and malformed gzip, AP per-category 503 errors, and an unknown AP
  category.
- `comparison.json` records hashes, runtime identities, and the exact
  comparison normalization. Both sets match `11/11` and `7/7`. Only the
  synthetic peer's dynamic Host port and the core probe's deliberate
  top-level error wrapper are normalized.

The source boundary probe was run in
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
(Node `v8.9.4`). The candidate ran on Node `v22.22.0`. The source probe
confirmed that Axios lower-cases `HEAD` before the pinned follow-redirects
release, so a redirected HEAD becomes GET except for status 307; that detail
is retained intentionally.

Focused tests are in
`packages/skills/test/lassoClient.source-wire.test.js`. The complete skills
test invocation passed `118/118`:

```text
node --test packages/skills/test/*.test.js
```

The candidate does not change Report `GetDataNode` scheduling or provider
content. It has only been exercised against synthetic local peers; a fresh
strict production capture and live provider behavior remain for lead review.
The adapter also does not reproduce Axios's ambient proxy environment or
arbitrary Axios configuration options because these Report calls use fixed
GET/HEAD requests to the configured Lasso peer.
