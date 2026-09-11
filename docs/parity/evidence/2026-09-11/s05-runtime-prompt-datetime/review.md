# S-05 — Match runtime prompt data and date/time behaviour

Status: **implementation + differential verification complete; awaiting lead review**

Owner: w16/s05 subagent · Base (main): `3dd1cfa`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c` (pinned Pegasus)
Branch: `w16/s05` · Worktree: `.parity/worktrees/w16-s05`

## Scope

The S-05 acceptance criteria are the contract:

1. *Match pronounceable names/lists, owner/speaker/referent, age/birthdays,
   emotion and location values for reference contexts.*
2. *Verify date phrasing, timezone offsets, DST, midnight, leap days and
   seasonal windows independently of the server timezone.*

Reference files: `packages/baseskill/src/graph/mims/utils/slimmer/{PromptData,LooperData,NLData}.ts`
plus the `jibo-data-utils@3.0.1` shipped bundle that `PromptData`/`LooperData`
call. Phoenix files: `packages/skills/src/graph/mims/promptData.js`,
`packages/skills/src/graph/mims/{dateTime,nlData,locationData}.js`,
`packages/skills/src/report/dateTime.js`.

## Harness — differential against the pinned original

Prior art (S-02/S-03) runs the pinned original and diffs Phoenix probe-by-probe;
this task does the same with a much larger frozen input matrix. All probes are
committed and re-runnable.

| Piece | Path |
|---|---|
| season-window pairs extracted from the vendored MIMs | `packages/skills/test/fixtures/s05-isinrange-pairs.json` |
| frozen date/time matrix (dates, nows, isos, pairs) | `packages/skills/test/fixtures/s05-datetime-matrix.json` |
| matrix generator | `packages/skills/tools/s05-datetime-matrix-spec.mjs` |
| pinned-original matrix probe | `packages/skills/tools/s05-datetime-matrix-source.cjs` |
| Phoenix matrix probe (body-identical) | `packages/skills/tools/s05-datetime-matrix-candidate.mjs` |
| adversarial PromptData context matrix | `packages/skills/test/fixtures/s05-prompt-contexts.json` |
| context generator / probes | `packages/skills/tools/s05-context-matrix-{spec.mjs,source.cjs,candidate.mjs}` |
| multi-TZ driver + report | `compare.py`, `report.json` (this directory) |
| source-recorded regression golden | `packages/skills/test/fixtures/s05-datetime-golden.json` |
| live-entrypoint smoke | `s05-runtime-smoke.mjs`, `smoke-utc.json` (this directory) |
| pinned source quotes | `source-excerpts.txt` (this directory) |

Reproduce:

```sh
git -C <pegasus clone> rev-parse HEAD      # 5c0a7390539663ba749d360de348a428c088505c
PHOENIX_ROOT=$PWD REFERENCE_ROOT=/path/to/pegasus \
  python3 docs/parity/evidence/2026-09-11/s05-runtime-prompt-datetime/compare.py /tmp/s05-driver
S05_CANDIDATE_ROOT=$PWD node docs/parity/evidence/2026-09-11/s05-runtime-prompt-datetime/s05-runtime-smoke.mjs
```

Corpus sizes actually compared (per run):

* **852** `isInRange` argument pairs lifted verbatim from the vendored MIM
  corpus (2,763 call sites; the two remaining pairs are template variables).
* **1,847** frozen dates: every day of 2016/2019/2020/2100 at 00:00, 23:59:59.999,
  06:00 and 12:00 across `-12:00`, `-05:00`, `+05:30`, `+14:00` and `Z`, plus
  leap-day, century-non-leap, DST-transition, year-boundary and quarter-hour
  offsets → **1,573,644 `isInRange` comparisons per run**.
* **297** (now, runtime-ISO) records × the full 12-time-period × 12-option
  `DateTime.toString` matrix, plus every mutation method.
* **16,623** PromptData date-phrasing records (9 clocks × 1,847 dates).
* **100** adversarial PromptData contexts (loop lists, owner/speaker/referent,
  ages/birthdays/zodiac, emotion, location).

## Results

`report.json` (produced by `compare.py`, hashes of all 20 probe outputs included):

| Section | original[UTC] vs Phoenix[TZ] | original[TZ] vs original[UTC] | Phoenix[TZ] vs Phoenix[UTC] |
|---|---|---|---|
| datetime matrix, UTC | 0 | 0 | 0 |
| datetime matrix, `America/New_York` | **0** | 0 | **0** |
| datetime matrix, `Asia/Tokyo` | **0** | 0 | **0** |
| datetime matrix, `Australia/Lord_Howe` | **0** | 0 | **0** |
| datetime matrix, `Pacific/Chatham` | **0** | 0 | **0** |
| context matrix, UTC | 0 | 0 | 0 |
| context matrix, `America/New_York` | **0** | 4944 | **0** |
| context matrix, `Asia/Tokyo` | **0** | 4964 | **0** |
| context matrix, `Australia/Lord_Howe` | **0** | 4970 | **0** |
| context matrix, `Pacific/Chatham` | **0** | 4958 | **0** |

Reading: Phoenix reproduces the pinned original **exactly** (0 field differences
across every matrix) and is **bit-stable across host timezones**, while the
original itself is not — see the finding below.

### Finding: the pinned original's birthdate handling leaks the host timezone

`LooperData`/`JiboData` compute `moment(looperInfo.birthdate).startOf('day').utc()`.
For the epoch-millisecond birthdates the runtime actually sends, `moment(ms)` is
an absolute instant and `startOf('day')` truncates in the **host** timezone before
`.utc()` is applied. Same matrix, same inputs, original only:

```
ctx orig[UTC] vs orig[America/New_York]            4944 differing fields
  /12/result/speaker/birthdate   UTC='February 2nd 1984'   NY='February 1st 1984'
  /12/result/speaker/age/...     UTC=1082503260159         NY=1082571660159
ctx orig[UTC] vs orig[Asia/Tokyo]                  4964
ctx orig[UTC] vs orig[Australia/Lord_Howe]         4970
ctx orig[UTC] vs orig[Pacific/Chatham]             4958
```

Phoenix is `0` in every column: it resolves birthdates on the UTC calendar, which
is exactly the original's behaviour on the UTC-configured cloud host. That is the
deliberate reading of acceptance criterion 2 ("independently of the server
timezone") and is unchanged by this task; it is recorded here because it is the
one place where "match the original" and "do not depend on the host" pull apart.
Emitting the host-dependent variant instead would make the same robot prompt vary
by machine, so UTC was kept.

## Divergences found and fixed

All four were found by the differential above; each is a real behavioural
difference from the pinned original, not a style change.

### 1. `Location` coerced non-string fields (source throws)

`packages/skills/src/graph/mims/locationData.js`. The original's
`areStringsEqual`/`toTitleCase` call String prototype methods directly, so a
non-string runtime field throws instead of being stringified:

```
source-excerpts.txt → jibo-data-utils toTitleCase/areStringsEqual
   31|    return str.replace(/\w\S*/g, function (txt) { ... });
   43|    return strA.toLowerCase() === strB.toLowerCase();
```

Phoenix had `String(value).replace(...)` / `String(a).toLowerCase()` and, in
`equals`, an early `if (!other) return false`, and in `isInRegion` an
`Array.isArray` guard. Differential output before the fix (context matrix):

```
/loc-numeric-city/location/home/string          orig=None (threw str.replace)      cand='42, ZZ'
/loc-numeric-city/location/home/prefix/error    orig='strA.toLowerCase is not a function'  cand=None
/loc-numeric-city/location/home/isLocal         orig=None (threw)                  cand=False
/loc-numeric-city/location/home/log             orig=None                          cand='[Location: 42, ZZ]'
```

Now source-exact: no coercion anywhere, `equals(loc)` dereferences `loc` like the
source, and `isInRegion` walks `regions.length` (so a string matches whole, a
length-less value misses, and `null` throws the same TypeError). Parameter names
`strA`/`strB`/`str` are kept because the thrown `TypeError` text carries them.

### 2. `getLocalYYYYMMDD` padded the year

Source concatenates the raw year (`rtn += date.getUTCFullYear()`). Phoenix
zero-padded it to 4 digits, which differs for years < 1000:

```
source probe, iso 0500-02-28T12:00:00.000-05:00 → yyyymmdd '5000228'
```

### 3. `DateTime` was missing three source behaviours

`packages/skills/src/graph/mims/dateTime.js`:

* `stripTime()` always collapsed; the source only collapses time-bearing periods
  and leaves `year`/`month`/`week`/`weekend`/`day` untouched (bundle lines 807-819).
* `jumpToNextDayPeriod()` and `toMoment()` were absent. Both are now ported
  line-for-line (bundle lines 744-772 and 1139-1168) so the class is a complete
  port; the differential shows 0 differences on them across the whole matrix.
* `getOrdinal` used `number % 100 ∈ 11..13`; the source special-cases only
  `num < 20 && num > 10`, so `getOrdinal(111)` is `111st`, not `111th`
  (bundle lines 1615-1632).
* `new DateTime(numberOrDate, timezone)` ignored the timezone argument; the
  source assigns `timezone || new Timezone()`. Reachable through the new
  `toMoment()`, which the source implements with `new DateTime(Date.now(), tz)`.

Verified *not* to diverge, so deliberately left alone: `isInRange` (1.57 M
comparisons), `toString` option/time-period matrix, `getLocalTime`,
`getRelativeDays/Hours`, `isPast/isFuture`, `addDays/addHours/addYear/setTime`,
`Timezone.toISOString`, `toJSON/clone` round-trips, and the whole
`PromptData`/`LooperData`/`JiboData`/`NLAge`/`NLZodiac`/`makePronounceable` surface.

### 4. Pre-existing host-timezone flake in the proactive date code (fixed)

`packages/gateway/src/proactive/contextRules.js` read `getPartOfDay`'s input with
`date.getHours()/getMinutes()` and `DAY_OF_WEEK` with `.getDay()`. The input is
`getTimezonedDate(iso)` = *the robot's wall clock encoded as a UTC instant*, so
the local accessors only equalled the wall clock on a UTC host. On
`TZ=America/New_York` the checked-in suite failed 4 tests:

```
not ok 7 - part-of-day: the 13 source boundaries resolve to the source pods
          expected: 'NIGHT/MID'   actual: 'EVENING/MID'
not ok 8 - day-of-week: the timezone offset is carried into the wall clock day
          expected: 0             actual: 6
```

These now use `getUTCHours/getUTCMinutes/getUTCDay`, which is identical on a UTC
host (the decommissioned cloud's configuration) and wall-clock-correct
everywhere: **24/24 in all five host timezones**. The 13-boundary
`PartOfDayTimes` table itself was already correct (verified in H-06) and is
untouched.

## Acceptance mapping

* **Criterion 1** — 100 adversarial contexts × full PromptData surface, 0 diffs
  vs the pinned original under UTC. Pronounceable lists (0/1/2/3/5 members,
  `null`/`undefined`/empty/unicode/embedded-`and` names), owner/speaker/referent
  (missing ids, duplicate ids last-wins, all-three-equal, unknown speaker),
  ages (all 8 units), birthdays (today, tomorrow, leap day, epoch 0, future,
  hour edges, invalid), zodiac, emotion (absent/null/partial/negative) and
  location (boston/JIBO_HOME, CA, JP, MX, GB, partial, `'null'` strings,
  numeric) all match.
* **Criterion 2** — 1,573,644 `isInRange` comparisons over the real MIM corpus
  (midnight, 23:59:59.999, leap day 2020/2024, non-leap 1900, non-leap century
  2100, year boundaries, DST transition instants, `±HH:MM`/`±HH:MM` half- and
  quarter-hour offsets, `Z`), 16,623 date-phrasing records and the full
  `toString` matrix: 0 diffs vs the pinned original, and both the original and
  Phoenix were additionally run under 5 host timezones. A real `isInRange`
  divergence in this surface was found and fixed (`getLocalYYYYMMDD`).

## Live entrypoint

`s05-runtime-smoke.mjs` drives the real vendored
`chitchat/scripted-responses/RI_USR_WhatShouldDoForThanksgiving.mim` through the
service entrypoint `generateSlimFromMim` with PromptData built from a live
runtime context (only the location ISO varies):

```
iso 2020-11-01T18:00:00.000-05:00  dt.now 6:00 PM  seasonal(9/1-11/23)=true   → "Great question. You could
                                                                                always get together … potatoes."
iso 2020-12-05T18:00:00.000-05:00  dt.now 6:00 PM  seasonal(11/24-1/31)=true  → "I think Thanksgiving has
                                                                                come and gone …"
iso 2020-06-15T18:00:00.000-05:00  dt.now 6:00 PM  both false                 → "Good question, we have
                                                                                plenty of time …"
iso 2020-11-01T00:05:00.000+05:30  dt.now 12:05 AM seasonal(9/1-11/23)=true   (wall clock, not host)
iso 2020-12-05T00:05:00.000+09:00  dt.now 12:05 AM seasonal(11/24-1/31)=true
```

`smoke-utc.json` is byte-identical under `TZ=UTC`, `America/New_York`,
`Asia/Tokyo` and `Pacific/Chatham` (sha256 `2ff77cdf0b890e15…` for all four).

## Falsification

Mandated single-line falsification, `falsification.log`:

* broke `packages/skills/src/graph/mims/locationData.js` line 19 back to
  `return String(strA).toLowerCase() === String(strB).toLowerCase();`
* `node --test packages/skills/test/s05DateTime.source-vectors.test.js` →
  **2 named failures**: `not ok 11 - S-05 location throws for non-string fields
  instead of coercing them` (`error: 'Missing expected exception (TypeError).'`,
  `message: 'strA.toLowerCase is not a function'`) and `not ok 5 - S-05 location
  values and thrown messages match the pinned original`; summary `# pass 10 # fail 2`
* restored the line → `# pass 12 # fail 0` (UTC and `America/New_York`)

## Tests added

`packages/skills/test/s05DateTime.source-vectors.test.js` (12 tests): the golden
fixture is the *pinned original's own output* (`s05-datetime-golden.json`,
recorded under a UTC host by `s05-datetime-matrix-source.cjs`), so it cannot
drift with Phoenix. It pins all 852 real MIM window pairs over 30 boundary dates,
90 date-phrasing records, the 27-record `toString`/period matrix, the mutation
surface, 18 location contexts (values *and* thrown messages) and named edge
vectors for `getOrdinal`, `stripTime`, `jumpToNextDayPeriod`, `toMoment` and
`getLocalYYYYMMDD`. The whole file passes under UTC, `America/New_York` and
`Asia/Tokyo`.

`packages/gateway/test/proactiveSelection.test.js` was hardened to read the
wall-clock-as-UTC instant with UTC accessors.

## Final `npm test`

`npm-test-summary.txt` (this directory): **# tests 1942 / # pass 1934 / # fail 0 /
# cancelled 0 / # skipped 8**, parity gate
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`,
**exit code 0**.

An earlier run of the same tree exited 1 with `# cancelled 5` while
`test:unit` still reported 0 failures; re-running the identical tree produced
`# cancelled 0` and exit 0, so those cancellations are the known retained
ASR-fixture timeouts, not a regression. Both runs are in the worktree log.

## Residual / out of scope

* `packages/skills/src/report/dateTime.js` (an S-05-listed file) has a bare-local-
  string fallback that uses `-new Date().getTimezoneOffset()`, i.e. the host
  offset. It is unreachable in the report path (every caller passes the
  offset-bearing `runtime.location.iso`, and the pinned `DateTime` *throws* for a
  bare local string: `Cannot read properties of null (reading 'setUTCHours')`),
  so it was left alone rather than changed into a throw for the whole report
  skill. Reported as a divergence candidate.
* `packages/skills/src/report/weather.js:115` uses `new Date(iso).getHours()` —
  the same host-local pattern, outside S-05's file list. Recorded as candidate.
* The `jibo-data-utils` NLU date *parser* (`_parseInput`: relative days, weekday
  and month names, `M/D`, `MM/DD/YYYY`) is not reachable from PromptData for the
  pinned runtime inputs (PromptData only ever hands `DateTime` the location ISO,
  which for the source's parser must carry an explicit offset or `Z`). Not ported
  and not claimed.
* No IANA timezone database, and no zone inference from lat/lng: the runtime
  carries a fixed offset only. `Timezone.fetch` (Google API) is not implemented.
