# D-05 — weather data and forecast/date semantics

Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Artifacts in this directory: `probe.mjs` (runnable), `runtime.json` (its real captured output).

## Why this file exists

The wave-9 D-05 agent did real work but cited an evidence path it never created, so
`parity:check` failed with `D-05: incomplete or missing passing evidence` and `npm test` exited 1
with zero test failures. The probe and JSON here were produced by the integrator re-running the
behaviour directly, not copied from the agent's report.

## D05a — coordinate validation (closed)

Previously, missing or invalid coordinates were coerced to `0` and cached under `dark_sky:0;0`,
because `Number(null) === 0` passes `Number.isFinite`. Out-of-range values such as `lat=-555` were
forwarded to the provider. The pinned handler rejects all of these before the cache key is built:
`DarkSkyHandler.ts:29-40` validates through `LatLon.ts:20-31` (regex on the raw string) and
`LatLon.ts:9-14` (range on the parsed float), each raising `RangeError`, which
`AbstractRelayRequestHandler.ts:56-62` turns into a 400 whose body is the bare message.

Observed now, over real HTTP through the real `createDataService` (`runtime.json`):

| request | status | body | upstream calls | cache writes |
| --- | --- | --- | --- | --- |
| no coordinates | 400 | `Invalid latitude undefined` | 0 | 0 |
| `lat=abc&lon=2` | 400 | `Invalid latitude abc` | 0 | 0 |
| `lat=-555&lon=1.1` | 400 | `Invalid latitude -555` | 0 | 0 |
| `lat=1&lon=asdf` | 400 | `Invalid longitude asdf` | 0 | 0 |
| bad `secondsSinceEpoch` | 400 | `Invalid timestamp: 'very much not a number!'` | 0 | 0 |

A valid request still answers 200 with exactly one upstream call and warms `dark_sky:1;2`.
The zero-call, zero-write columns are the point: validation happens *before* the provider and
*before* the cache, as in the reference.

## secondsSinceEpoch = 0 — confirmed, not inferred

The pinned `createRedisKey` (`DarkSkyHandler.ts:18-27`) tests `request.query.secondsSinceEpoch`
as the RAW string, so `'0'` is truthy and the key gains a `;1970-01-01` segment. Coercing to the
number `0` made it falsy, collapsing that request onto the timestamp-less entry. Keys are now
composed as `dark_sky:1;2`, `dark_sky:1;2;1970-01-01`, `dark_sky:1;2;2018-01-19`.

## Falsification

Restoring the coercion at `packages/data/src/weather.js` —
`makeLatLon(q.get('lat') ?? undefined, ...)` → `makeLatLon(q.get('lat') ?? '0', ...)` —
fails two named tests:

- `D05/06 bad coordinates / timestamp -> 400 with the original message, no upstream call, no cache write`
- `D05/07 valid forecast request is 200 with today at daily.data[0] and a warmed cache`

Restoring the line returns the file to 9/9 passing.

## Open divergences

- **D05b** — historical timestamps outside Open-Meteo's `past_days=1` window fall back to the
  window's base day while the cache key still carries the requested date. The report skill's real
  historical request (now−24 h) is inside the window and is correct.
- **D05c** — `currently.apparentTemperature` equals `current_weather.temperature`; Open-Meteo's
  legacy current block carries no apparent temperature.
