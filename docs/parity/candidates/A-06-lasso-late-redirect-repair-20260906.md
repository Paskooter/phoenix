# A-06 Lasso late-redirect repair (unverified)

This follow-up is based on `754a7baf8c2e27cfd651de5787eaec8e1212b45a` and changes only the Lasso request lifecycle. The pinned Wreck source at `.parity/reviews/a06-original-runtime/node_modules/wreck/lib/index.js:218-224,234-262` removes `options.timeout` before constructing each redirected request, while the timeout callback aborts only the request that owns that timer. The previous Phoenix adapter destroyed every request in its shared `activeRequests` set, suppressing later redirect hops.

The repair keeps the shared deadline and public rejection, but destroys only the root request that owns the timer. Redirect children continue to process their responses after settlement, matching the source-visible side effect while their completion remains ignored by the already-settled outer promise.

The focused regression test sends an immediate 307, delays the second 307 by 100 ms, sets `ETCO_server_http_timeout=25`, waits 250 ms after the public rejection, and requires the third request. It independently checks each request's `Host` against that peer listener's address and port.

Fresh pinned source versus candidate evidence is in `.parity/reviews/a06-lasso-late-redirect-repair-20260906`:

- Node 8 source and Node 22 candidate both reject with `Failed to get google calendar credentials`.
- Both issue the exact three-request sequence through `/v1/credential?hop=3`.
- All source and candidate request methods, paths, bodies, headers, raw header order, and Host checks match after normalizing only each listener's generated authority.

Validation:

```text
node --test packages/account/test/settingsLassoNetwork.test.js packages/account/test/settingsProviders.test.js
15 passed, 0 failed
```

The candidate remains unverified pending root review.
