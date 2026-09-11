# D-07 evidence — match maps routes, modes and commute payloads

Track: pegasus · P1 · worktree `.parity/worktrees/w9-d07` (branch `w9/d07`, base `48f7489`).

Evidence labels: **VERIFIED** (observed by running something) / **INFERRED** (reasoned from
pinned source) / **UNKNOWN** (no claim).

Reproduce everything here with:

```
node docs/parity/evidence/2026-09-10/d07-maps/probe.mjs      # 26/26 expectations
node --test packages/data/test/maps-modes.test.js            # 14 tests
npm test                                                     # full suite + gate
```

## 0. Pinned sources

Fetched through the Jibo archive MCP (`jibo_search` → `gitea_read_file`, `repo=jiboV2/pegasus`,
`ref=5c0a7390539663ba749d360de348a428c088505c`) and compared line-for-line against the pinned
local checkout `.parity/reference/5c0a7390539663ba749d360de348a428c088505c` — **identical for all
nine files** (so every citation below is simultaneously MCP-served and checkout-served):

| pinned file | sha256 (checkout) | used for |
| --- | --- | --- |
| `packages/lasso/src/relay/GoogleMapsHandler.ts` | `e3c48c7c…56ec5` | query/validation/key/route contract |
| `packages/lasso/src/utils/LatLon.ts` | `108f3ca6…9f2d2` | coordinate validation + messages |
| `packages/lasso/tests/relay/GoogleMaps.test.ts` | `976c1114…e0cd0` | the exact expected messages/statuses |
| `packages/interfaces/src/personalreport/googlemaps.ts` | `7296e3f7…35f40` | `Maps`/`Route`/`Leg` shape, `CommuteMode`, `Status` |
| `packages/test-utils/src/lasso-test/GoogleMapsTestData.ts` | `aa07d5ea…1b4a4` | a captured Google route (geometry/bounds/units) |
| `packages/report-skill/src/LassoClient.ts` | `03c51556…c2c5` | the only production caller (wire form) |
| `packages/report-skill/src/SettingsClient.ts` | `d64a853b…8635` | `commuteType` → `CommuteMode` |
| `packages/report-skill/src/subskills/commute/CommuteParse.ts` | `c9d0ab6e…506f` | the payload consumer |
| `packages/lasso/src/relay/AbstractRelayRequestHandler.ts` | `106c0142…d7ce` | 400/502/upstream-error mapping |

Two archive facts worth recording:

* `jibo_search` returns **0 hits** for the lasso relay source (`GoogleMapsHandler`, `pegasus lasso
  relay`) — the pegasus source is not in the archive's indexed text; `gitea_read_file` still serves
  it by path. Live workaround: cite by path + `ref`.
* The **default branch** of `jiboV2/pegasus` serves a *later* revision of `GoogleMapsHandler.ts`
  (144 lines) whose body is itself the "2026 restoration" ORS shim ("Google Maps Directions key is
  dead. This handler now fetches from OpenRouteService"). That source is cited below only as the
  authority for the **ORS call itself** (it has no pinned revision behind it); every validation/route
  contract claim is anchored to `5c0a739`. Note that `GoogleMaps.test.ts` is byte-identical between
  `main` and `5c0a739`, i.e. the pinned tests still describe the shimmed handler.

## 1. D07a — out-of-range coordinates — VERIFIED FIXED

Before (`packages/data/src/maps.js@48f7489:25-26`, `Number.isFinite` only), real request through the
real data service:

```
FAIL  reject lat>90 -> 400 "Invalid latitude 800"  status=200
      body … "start_location":{"lat":800,"lng":58.6} … upstreamCalls=1
FAIL  reject lon>180 -> 400 "Invalid longitude 654"  status=200 upstreamCalls=1
FAIL  reject lat missing -> 400 "Invalid latitude undefined"  body="Invalid origin coordinates"
```

Probe tally at base: **15/26**. After: **26/26**, and the two `Invalid … coordinates` messages
(invented by the port) are gone.

Exact contract, re-derived from `LatLon.ts:9-31` (not from the sibling's report):

* `make_from_strings` gates on `/^\-?\d+\.?\d*$/`, and its message carries the **raw** value
  (`LatLon.ts:22-28`);
* the `LatLon` constructor then range-checks `[-90,90]` / `[-180,180]` and its message carries the
  **parsed** value (`LatLon.ts:9-14`);
* both throw `RangeError`, and `AbstractRelayRequestHandler.ts:58-62` renders any validation throw
  as `400` with `err.message` as the body.

Pinned expectations, both satisfied verbatim: `Invalid latitude 800`
(`GoogleMaps.test.ts:146`), `Invalid longitude 654` (`:150`). Also now correct: a missing `lat`
→ `Invalid latitude undefined` (previously `Number(undefined)=NaN` → the invented message), and
`Invalid mode: "undefined"` for an absent mode (`:166`, previously `Invalid mode: "null"` because
`URLSearchParams#get` returns `null` where Express's qs returns `undefined`).

The rejection happens **before** the cache key is built and before the provider is called — VERIFIED
by a counting provider (`calls === 0`) and by asserting nothing was cached.

## 2. The rest of the contract

| area | pinned | phoenix | label |
| --- | --- | --- | --- |
| wire form | `origin`/`destination` are JSON strings of `{lat,lon}` — axios JSON-stringifies object params, see `LassoClient.ts:59-69` | same, via `URLSearchParams` + `JSON.parse` | VERIFIED |
| missing origin/destination | `Origin required` / `Destination required`, falsy test (`GoogleMapsHandler.ts:35-40`) | same | VERIFIED |
| unparseable | `Could not parse origin: <raw>` | same | VERIFIED |
| modes | `mode in CommuteMode`; enum `driving,transit,bicycling,walking` (`googlemaps.ts:181-186`); `SettingsClient.ts:215` maps `commuteType` 0..3 onto that order | explicit allowlist, same order | VERIFIED |
| key | `google_maps:${oLat};${oLon};${dLat};${dLon};${mode}` (`GoogleMapsHandler.ts:67-70`) | same, built from the parsed floats | VERIFIED |
| empty routes | `{status:'ZERO_RESULTS', geocoded_waypoints:[], routes:[]}` (Google's own ZERO_RESULTS path) | same | VERIFIED |
| geometry | `Route.bounds` + `Route.overview_polyline.points` (`googlemaps.ts:20-26`); the captured Google route carries both (`GoogleMapsTestData.ts:15-19,62`) | mapped from ORS `route.bbox` `[minLon,minLat,maxLon,maxLat]` → `{northeast,southwest}` and ORS `route.geometry` (encoded polyline) → `points` | VERIFIED (mapping) / INFERRED (ORS response shape — <https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/>) |
| units | `distance.value` is always metres (`GoogleMapsTestData.ts:23`: `3851`) | metres | VERIFIED |
| traffic | original sent `departure_time=now&traffic_model=pessimistic` (`GoogleMapsHandler.ts:77-84`) so `duration_in_traffic` could exceed `duration`; `CommuteParse.ts:53-56` turns the delta into `extraMins` | ORS has no traffic model → `duration_in_traffic === duration` → `extraMins` always 0 | **gap retained** |
| empty upstream body | `502` + `Empty reply from GoogleMaps` (`GoogleMaps.test.ts:110-111`, `AbstractRelayRequestHandler.ts:167-169`) | `fetchMaps` returns `null`, the relay framework emits exactly that | VERIFIED |
| upstream HTTP error | reproduce the upstream status + `Error getting GoogleMaps data: ` + `JSON.stringify(response.data)` (`AbstractRelayRequestHandler.ts:159-163`) | `defaultOrsGet` now attaches `{status,data}` so the relay does exactly that | VERIFIED |
| ORS call | `POST /v2/directions/<profile>`, `[lon,lat]` pairs, `Authorization: <key>`, `Accept: application/json, application/geo+json, application/gpx+xml` (default-branch shim) | identical (Accept aligned to the shim) | VERIFIED |
| mode → profile | `driving→driving-car, transit→driving-car, bicycling→cycling-regular, walking→foot-walking` (default-branch shim) | identical | VERIFIED |

### Runtime demonstration, every mode (VERIFIED)

`probe.mjs` drives the **real** `createDataService` over HTTP with a stubbed global `fetch` that
records the outgoing request, so the real `defaultOrsGet` builds the real URL/body/headers:

```
PASS  mode=driving   -> 200 + /v2/directions/driving-car
PASS  mode=transit   -> 200 + /v2/directions/driving-car
PASS  mode=bicycling -> 200 + /v2/directions/cycling-regular
PASS  mode=walking   -> 200 + /v2/directions/foot-walking
        body coordinates [[-71.0589,42.3601],[-71.1229,42.3727]]   (lon,lat — VERIFIED)
        relayData.routes[0].legs[0].duration = {text:"25 mins", value:1500}
```

`transit` is answered but **not with transit data** — the ORS free tier has no transit profile and
the shim (and therefore the port) falls back to `driving-car`. That is a retained feature gap, not
functional transit verification.

## 3. Divergence candidates (for DIVERGENCES.md — not edited by me)

* **D07b — `transit` is not transit.** `mode=transit` returns a driving-car route: no transit legs,
  no `transit_details`, no `departure_time`. The original asked Google's Directions API with
  `mode=transit`. Unsupported behaviour retained on purpose; the alternative (rejecting `transit`)
  would break `SettingsClient.ts:215`, which can produce all four modes.
* **D07c — no traffic model.** `duration_in_traffic === duration` always, so `extraMins` is always 0
  and `CommuteMimLogic.ts:61-62/81-85` can never select `Poor`/`Terrible`. INFERRED from the ORS
  free tier; the pinned original used `traffic_model=pessimistic`.
* **D07d — route detail is thin.** `legs[0].steps` is always `[]`; `arrival_time`/`departure_time`,
  `warnings`, `fare`, `waypoint_order`, `geocoded_waypoints` and the per-road `summary` are absent
  (the port emits the literal `'OpenRouteService'`). `overview_polyline` + `bounds` were added by
  this change where ORS supplies them.
* **D07e — `mode` validation is an allowlist, the original's `in` walks the prototype chain.**
  `'toString' in CommuteMode` is `true` in the original (`GoogleMapsHandler.ts:59`), so those
  queries pass validation and are forwarded to the provider; the port answers
  `Invalid mode: "toString"`. INFERRED (not pinned by any test); deliberate — replicating it would
  forward prototype names to ORS.
* **D07f — JSON-in-query only.** `?origin[lat]=42&origin[lon]=-71` (the bracket form Express's qs
  parses) is answered `Origin required`; the original would answer
  `Could not parse origin: [object Object]`. Both reject; the message differs. INFERRED — the pinned
  test and `LassoClient.ts:74-77` both send the JSON string form, which is what the port accepts.
* **D07g — empty-reply message follows the pinned test, not the default-branch shim.** The current
  shim throws inside the provider, which the relay would wrap into
  `Error getting GoogleMaps data: Error: Empty reply from OpenRouteService`; the pinned test at
  `5c0a739` (`:110-111`) still requires `Empty reply from GoogleMaps`, and the pinned relay
  framework produces that for a falsy provider result — which is what the port does.

## 4. Falsification (VERIFIED)

Line broken, in this worktree (`packages/data/src/maps.js:59`):

```
  if (parsedLat < -90 || parsedLat > 90) throw new RangeError(`Invalid latitude ${parsedLat}`);
```

changed to `if (parsedLat < -90) throw …` (the upper bound removed). Result — 3 failures, 11 passes:

```
not ok 1  - D07/lat-range: origin {lat:800} -> "Invalid latitude 800" (pinned GoogleMaps.test.ts:146)
not ok 3  - D07/boundaries: +/-90 lat and +/-180 lon are accepted, just outside are not (LatLon.ts:9-14)
not ok 13 - D07/runtime-reject: out-of-range coords -> 400 text, provider untouched, nothing cached
              error: Invalid latitude 800        # assert.equal(r.status, 400) got 200
```

Line restored verbatim; `node --test … maps-modes.test.js maps.test.js` → `19 tests, 19 pass,
0 fail, 0 cancelled`.

## 5. Full suite — VERIFIED

`npm test` (unit + `parity:check` + `parity:gate`) on the committed tree:

```
# tests 1632
# pass 1625
# fail 0
# cancelled 0
# skipped 7

Checklist: 43/79 verified (54.4%)
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
EXIT 0
```

Base was 1618 tests; +14 from `packages/data/test/maps-modes.test.js`. The checklist stays at
`43/79` (D-07's `status`/`verification` rows in `docs/parity/tasks.json` were deliberately not
touched). Raw transcript: `npm-test.log` in this directory (trimmed to the runner summary).

**Flake observed.** One run of the identical tree reported `1 fail`:
`RobotReadClient applies the source header deadline and clears it before body reading`
(`packages/account/test/loopCreationTransport.test.js:86`, `ETIMEDOUT` at `:103`). That test arms a
25 ms header deadline (`:88`) against an 80 ms server and is timing-sensitive under load; it passes
4/4 in isolation (3 consecutive runs) and the re-run above is 0 failures. No maps file is involved.
