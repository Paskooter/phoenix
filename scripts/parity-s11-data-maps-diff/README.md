# S-11 Data/Maps relay differential

Run the harness from this checkout with:

```sh
node scripts/parity-s11-data-maps-diff/run.mjs
```

The runner first verifies the locally available `node:8.9.4-slim` image by
digest, then executes the pinned Pegasus Lasso compiled handler in a container
with `--network none`. Its Google provider call is redirected by a handler seam
to a loopback fixture; the source URL construction, Google query serialization,
HMAC signature, Redis reads/writes, HTTP handler, and asynchronous HEAD path
remain the pinned runtime code.

Phoenix runs its actual Data HTTP service. The ORS host is intercepted by a
loopback `fetch` seam, so Phoenix's profile selection, JSON coordinates,
headers, provider status handling, relay envelope, cache behavior, and HEAD
prefetch are observed without external network access. The common route body
uses the pinned Google test fixture's route geometry, bounds, endpoint
locations, distance, and duration, projected into the fields Phoenix emits;
the side-specific provider wire records retain the Google and ORS contracts.

The fixed matrix includes route miss/hit, cold HEAD and eventual warm/hit,
empty replies, provider status errors, zero results, both `skipCache` query
forms, all four modes, and the exact source validation errors for missing,
invalid, and unparseable inputs. Receipts pin source, compiled, test, fixture,
candidate, and harness SHA-256 hashes. The runners and comparator also carry
an out-of-band canonical semantic-matrix digest, an exact 20-ID/count
inventory, and independent byte-pin digests. `compare.mjs` rejects missing,
duplicate, reordered, metadata-mutated, self-hash-mutated, response, header,
body, provider-wire, cache-effect, and semantic rows. `falsify.mjs` proves
paired matrix-plus-receipt missing/reorder/semantic rewrites, a byte-pin
rewrite, and one-sided receipt and stale/recomputed row mutations all fail
closed.

The D07 gaps remain explicit in `matrix.json`: `transit` uses ORS
`driving-car`, and Phoenix has no traffic model while the pinned Google
request sends `departure_time=now` and `traffic_model=pessimistic`.
