# A-06 Settings Lasso body snapshot follow-up

Status: unverified candidate, pending root review.

This isolated follow-up starts at `9b5fc091ccae339a087e17047c100fa0cf357d96`
in branch `codex/candidate-a06-lasso-body-followup-20260906`. It changes only
the configured Settings Lasso request helper, its focused network test, and
this report. The preceding A-06 candidate and its receipts remain frozen.

## Source contract

The source is
`jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`,
specifically `src/clients/lasso.ts`. The prepared source snapshot hash is
`a5e45ffea53d0c9660cdeb1a650adba1b56fe1f6886bffa898a135a6bf536145`; its
compiled client hash is
`6aeae8b8c2a43f42be4d30f5182288fbc1c5737235003d910494c4c68094fd38`.
The exact source control runs Node `v8.9.4` from the image resolved in
`docs/parity/evidence/2026-09-05/compatibility-pins.json` and mounts the
`@jibo/server`/Wreck runtime read-only.

At `src/clients/lasso.ts:84-88`, the source passes the object payload to
`BaseClient.wreckPost`. The pinned BaseClient serializes that object once at
`@jibo/server/dst/wreck.js:34-38`; Wreck reuses the serialized
`options.payload` on a redirect at `wreck/lib/index.js:218-220`. The candidate
previously called `JSON.stringify(payload)` from every recursive request.

## Repair and evidence

`lassoRequest` now accepts an internal serialized-body snapshot. The first hop
serializes the object, while redirect recursion passes the same string. Header
snapshot behavior is unchanged. The focused test uses equal-length `first!` and
`after!` values so a stale `Content-Length` cannot hide the content mismatch;
the source and repaired candidate both send the first value on both POST hops,
with one serialization.

The new source/candidate controls cover that POST case plus four timeout
boundaries: a three-hop redirect chain whose total time exceeds the single
source deadline, delayed final headers after a redirect, a delayed final
response after an informational response, and delayed body bytes after final
headers. The old candidate's socket inactivity timers let the multi-hop chain
complete; the source's Wreck timer is one wall-clock deadline started before
the first request. `lassoRequest` now carries one timer state through redirect
recursion, clears it at final headers, and clears it on Node 22's informational
response event to match the pinned Node 8 behavior. The repaired full captured
comparison is **5/5 exact** after normalizing only generated runtime, duration,
source marker, and loopback Host port.

Focused validation:

```text
node --test packages/account/test/settingsLassoNetwork.test.js packages/account/test/settingsProviders.test.js
12 passed, 0 failed
```

Private receipts and commands are under
`/home/shell/work/phoenix/.parity/reviews/a06-lasso-body-followup-20260906/`:

- `outputs/source-controls-4.json` — pinned Node 8 source;
- `candidate-controls-repaired.json` — candidate Node 22;
- `comparison-controls-repaired.json` — full-field 5/5 comparison;
- `README.md` — source attribution, command, hashes, and limits.

The candidate remains unverified pending root integration and rechecking.
