# S-08 Report LassoClient edge follow-up

Status: unverified; follow-up candidate for lead review.

Base candidate: `d80c45f4aca7dc076b9ac9ec675b789b6a7cb8db`.

This follow-up keeps the source-shaped Axios transport and adds the source
response lifecycle and boundary behavior that the first candidate did not
cover:

- `IncomingMessage.aborted` now finishes a plain truncated response with the
  received bytes. The relay extractor then returns the source
  `Incomplete Lasso data from: DarkSky` error. Truncated gzip and deflate go
  through decompression and retain the source `Z_BUF_ERROR`.
- Request headers now distinguish `toHeader() === undefined` from `null` or
  `{}`. The pinned Axios source omits its default `Accept` header only for the
  undefined case.
- Source method preconditions are preserved for missing `log`, `req`, `jibo`,
  `toHeader`, `runtime.location`, and string coordinates. `relayData` values
  that are false, null, empty, zero, or absent remain incomplete responses.
  A real Phoenix logger object without `createChild` is retained as the
  deployment logger; absent or primitive logs still take the source failure
  boundary.
- Redirects cover relative and cross-authority locations, GET and HEAD 307,
  and the pinned 21-redirect limit. Raw request lines, header order, and body
  bytes are retained in the evidence.
- Non-2xx errors retain complete response status, status text, headers, and
  transformed data.

The source oracle remains Pegasus `5c0a7390539663ba749d360de348a428c088505c`
under the pinned Node `v8.9.4` image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The final candidate `lassoClient.js` hash is
`a3ab46410d6ccdba3f65ec03766807af7066f9592dd27f3df18fcfacaa994205`.

Fresh source and candidate receipts are under
`.parity/reviews/s08-lasso-followup-20260906/`:

- `source-edge.json` and `candidate-edge.json` contain 26 ordered raw-TCP
  vectors. `edge-comparison.json` reports 21 exact cases and five cases
  qualified solely for Node 8 versus Node 22 property-access wording; all
  request bytes, response data/headers, status, methods, and boundary
  outcomes agree.
- `source-prefetch-rejection.json` and `candidate-prefetch-rejection.json`
  are intentionally separate. Source emits one unhandled rejected Axios
  promise for a failed fire-and-forget HEAD; Phoenix catches that rejection
  and emits none. The candidate does not imitate the source process hazard.
- `all-comparison.json` compares the original 11 core and 7 boundary vectors
  again plus the 26 edge vectors. It asserts identical case count and order,
  rejects timeout-shaped results, and reports `11/11`, `7/7`, and `26/26`.

Focused source-edge tests pass, including truncated plain/gzip/deflate,
complete status error fields, method boundaries, and the 21-redirect limit.
The complete skills suite passes `123/123`; direct Report test fixtures now
carry the source-shaped request/Jibo seam instead of relying on a missing
request fallback. No Report scheduling, Settings code, provider content,
main, robot, golden, or comparator behavior was changed.
