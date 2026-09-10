# D-01 evidence — match the common relay and cache contract

Track: pegasus · P0 · worktree `.parity/worktrees/w7-d01` (branch `w7/d01`).

Evidence labels: **VERIFIED** (observed by running something) / **INFERRED**
(reasoned from pinned source) / **UNKNOWN** (no claim).

Pinned reference (re-derived, not trusted from the prior report):

* `jiboV2/pegasus:packages/lasso/src/relay/AbstractRelayRequestHandler.ts@5c0a7390539663ba749d360de348a428c088505c`
  — read through the archive MCP (`gitea_read_file`) and identical to the local
  checkout `/home/shell/work/pegasus` at `d682547a3` (byte-identical: `git diff`
  between the two revisions for this path is empty).
  <https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/lasso/src/relay/AbstractRelayRequestHandler.ts>
* `jiboV2/pegasus:packages/interfaces/src/lasso.ts@5c0a739` — `LassoRelayParams`
  (`lassoDataFromRedis` required, `lassoInsertedIntoRedisAt` optional).
* `jiboV2/pegasus:packages/lasso/tests/relay/{DarkSky,APNews,GoogleMaps}.test.ts@5c0a739`
  and `packages/lasso/tests/FakeRedisClients.ts@5c0a739`.
* `jiboV2/pegasus:packages/utils/src/service/handlers/BaseHttpHandler.ts` line 48-53
  — the relay handler is an Express `router.get/head`, so `request.query` is
  Express's qs-parsed object (pegasus pins `express@^4.16.2`).
* Executed original: `docs/parity/evidence/2026-09-05/reference/transactions.json`
  (`relay-*` transactions + `relayEffects`) and `scripts/parity-reference/capture.cjs:253-283`.

## 1. Independent runtime replay — VERIFIED

The captured original transactions were replayed through Phoenix's `createRelay`
with the clock frozen at the reference instant (`2018-05-30T12:00:00.000Z`), and
**every response header** — not just the body — was compared:

| transaction | status | content-type | content-length | ETag (original == Phoenix) | body |
| --- | --- | --- | --- | --- | --- |
| relay-cache-miss | 200 | application/json; charset=utf-8 | 54 | `W/"36-ubWu+rtBDjPOL6hoZGQ200T4yHI"` | `{"relayData":{"events":[]},"lassoDataFromRedis":false}` |
| relay-cache-hit | 200 | **text/html; charset=utf-8** | 107 | `W/"6b-yAQpi7If9eBMRZJx3ChHya1ztDU"` | stored bytes verbatim, `lassoDataFromRedis:true` + `lassoInsertedIntoRedisAt` |
| relay-skip-cache-string-false | 200 | application/json; charset=utf-8 | 54 | `W/"36-ubWu+rtBDjPOL6hoZGQ200T4yHI"` | refetched, `lassoDataFromRedis:false` |
| relay-head-prefetch | 200 | *(none)* | *(none)* | *(none)* | `""` |
| relay-invalid-input | 400 | text/html; charset=utf-8 | 20 | `W/"14-zxZbQCsV+3+3cKwnMkFxZY5y3pg"` | `fixture key required` |
| relay-provider-failure | 502 | text/html; charset=utf-8 | 71 | `W/"47-YyLi7eIvFZfWP7CFcet3O7Dquds"` | `Error getting FixtureCalendar data: Error: fixture provider unavailable` |
| relay-empty-provider | 502 | text/html; charset=utf-8 | 32 | `W/"20-2193Mgn8o694I2ybIPPvURAp1Ks"` | `Empty reply from FixtureCalendar` |

All seven match byte-for-byte, including the weak ETag, so the relay output is
observationally identical to the original for these transactions. Pinned by
`packages/data/test/relay-runtime.test.js` D01/17.

The captured `relayEffects` ordering was also replayed
(cache GET → provider fetch → cache SET; a provider failure or empty reply is
never cached; a validation error never touches the cache). Pinned by D01/18.

## 2. Gap found and fixed — `skipCache` truthiness (relay.js)

The reference tests `request.query.skipCache` (line 77), i.e. Express's
**qs-parsed** value. Phoenix read `url.searchParams.get('skipCache')`, which
collapses a bracket/repeated encoding to `null`/`''`. Measured on the same
Express version the original pins:

```
$ node -e "require('express/package.json').version"   # 4.16.2  (qs 6.5.1)
Express req.query.skipCache truthiness:
  ?skipCache            false      ?skipCache[]=1     true (Array ['1'])
  ?skipCache=           false      ?skipCache[]=       true (Array [''])
  ?skipCache=false      true       ?skipCache=a&b      true (Array)
  ?skipCache=0          true       ?skipCache=&=       true (Array ['',''])
  ?skipCache=1          true
```

Before: `/x?skipCache[]=1`, `/x?skipCache[]=` and `/x?skipCache=&skipCache=`
performed a cache read where the original skipped it. `packages/data/src/relay.js`
now reconstructs the qs truthiness in `skipCacheRequested()` (line 64-77); the
matrix now matches Express for every encoding (VERIFIED, D01/20).

## 3. Real routes relaying — VERIFIED

`createDataService` (index.js) over real HTTP with only the provider seam
injected (`weatherGet`/`newsGet`/`mapsGet`), matching the original tests' nock
seam:

```
GET  /v1/dark_sky?lat=1&lon=2   -> 200 application/json; charset=utf-8  (miss, cached)
GET  /v1/dark_sky?lat=1&lon=2   -> 200 text/html; charset=utf-8         (hit)
GET  /v1/ap_news?sourceID=42209 -> 200 application/json … then text/html (hit)
GET  /v1/google_maps?…&mode=driving -> 200 application/json … then text/html (hit)
cache keys: ["dark_sky:1;2","ap_news:42209","google_maps:1;2;3;4;driving"]
HEAD /v1/dark_sky?lat=9&lon=9   -> 200 no entity headers, warms the key; next GET is a hit
```

Per-relay key composition matches the subclass `createRedisKey` implementations
(`dark_sky:lat;lon[;YYYY-MM-DD]`, `ap_news:<sourceID>`,
`google_maps:oLat;oLon;dLat;dLon;mode`). Pinned by D01/21; real-clock expiry by
D01/22 (the mocked-clock boundary stays in D01/16).

## 4. Durability — proven by ACTUALLY RESTARTING — VERIFIED

Two separate `node` processes serving the same port; the child PID differs and
the relay cache does **not** survive:

```
--- process A ---   pid 662161
GET /v1/dark_sky?lat=1&lon=2 -> 200 application/json; charset=utf-8 len=589 fromRedis=false
GET /v1/dark_sky?lat=1&lon=2 -> 200 text/html; charset=utf-8        len=642 fromRedis=true
HEAD /v1/dark_sky?lat=1&lon=2 -> 200 null len=null
GET /v1/dark_sky?lat=1&lon=2&skipCache=false -> 200 application/json; charset=utf-8 len=589 fromRedis=false
--- process B (restarted) ---   pid 662174 (differs: true)
GET /v1/dark_sky?lat=1&lon=2 -> 200 application/json; charset=utf-8 len=589 fromRedis=false
GET /v1/dark_sky?lat=1&lon=2 -> 200 text/html; charset=utf-8        len=642 fromRedis=true
```

The restarted service relays correctly; the warmed entry is gone. That is the
recorded substrate divergence **D-01a** (Redis is shared/persistent, Phoenix is an
in-process `Map`), now executable evidence rather than an assertion. Pinned by
D01/23.

## 5. Falsification — VERIFIED

Corrupted one full code line in `packages/data/src/relay.js` (line 77):

```
  return occurrences > 1 ? true : !!single;
```
→
```
  return occurrences > 1 ? true : false;
```

Result: `not ok 4 - D01/20 skipCache truthiness matches Express qs for every
encoding` (plus D01/17, D01/18, D01/21, which all exercise `skipCache=false`/`=1`).
7 tests: 3 pass / 4 fail. Restored from a pristine copy (`diff` empty) →
`# tests 7 / # pass 7 / # fail 0`.

## 6. What is still open (divergence candidates, not edited here)

1. **Weather validation accepts a missing `lat`/`lon`.** `GET /v1/dark_sky`
   (no params) returns **200** with `latitude:0, longitude:0` and caches
   `dark_sky:0;0`; the original's `LatLon.make_from_strings` throws
   `RangeError("Invalid latitude undefined")` → 400 (captured reference test
   `DarkSky.test.ts` "Rejects missing lat"). Root cause: `Number(null) === 0`
   passes `Number.isFinite` in `weather.js:7-9`. File owned by **D-05**.
   VERIFIED at runtime; not edited by D-01.
2. **Maps does not range-check coordinates.** The reference rejects
   `{lat:800}` with `Invalid latitude 800` and `{lon:654}` with
   `Invalid longitude 654`; `maps.js:25-26` only checks `Number.isFinite`.
   File owned by **D-07**. INFERRED from the pinned reference tests; not
   replayed here.
3. **`secondsSinceEpoch=0` cache key.** The reference keeps the query value as a
   string, so `secondsSinceEpoch=0` is truthy and the key gains `;1970-01-01`;
   `weather.js:12` converts it to the number `0`, which `weatherKey` treats as
   absent. File owned by **D-05**. INFERRED from source; not replayed.
4. **Cache substrate (D-01a)** — already recorded in `DIVERGENCES.md`; no new
   claim. The reference's fake Redis never expired, so Redis-side `EX` timing,
   eviction and concurrency remain UNKNOWN.
5. **Calendar relay and APNews poll/prefetch** remain D-04 / D-06; the base
   handler they inherit is the one verified above.

## 7. Files

* `packages/data/src/relay.js` — `skipCacheRequested()` qs-faithful truthiness.
* `packages/data/test/relay-runtime.test.js` — 7 tests (D01/17-23).
* `packages/data/test/relay-contract.test.js`, `cache.js`, `index.js` — reviewed,
  unchanged.
