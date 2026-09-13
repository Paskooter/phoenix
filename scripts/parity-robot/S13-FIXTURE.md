# S-13 diagnostic fixture mode

`stack.mjs` has an opt-in fixture branch for exercising the real NLU → Gateway
→ Skills/Report → Data HTTP path. It is disabled unless
`PHOENIX_ROBOT_S13_FIXTURE_FILE` (or the compatibility alias
`PHOENIX_ROBOT_FIXTURE_FILE`) is set. The fixture branch does not replace NLU,
the Hub, the Skills host, Report, or Data routes. It supplies source-shaped
provider responses at the existing Data boundaries.

Create a private starter file in an isolated run directory. The template resolves
the current date and local offset in `America/New_York` (override with
`PHOENIX_S13_FIXTURE_TIME_ZONE`), and chooses a concrete work time roughly 75
minutes ahead, rounded to five minutes. Generate it immediately before the run
so Normal/Bad/Terrible remain in the departure-view window:

```sh
cd /home/shell/work/phoenix
RUN=/tmp/phoenix-s13-run
mkdir -m 700 -p "$RUN"
node scripts/parity-robot/s13-fixture-template.mjs "$RUN/fixture.json"
```

The template emits mode `0600` and refuses to overwrite an existing file. The
fixture schema is:

```json
{
  "schema": "phoenix-s13-robot-fixture-v1",
  "caseId": "Normal",
  "integrity": { "casesSha256": "<sha256 of stable JSON(cases)>" },
  "cases": {
    "Normal": {
      "userPrefs": { "weather": {}, "calendar": {}, "commute": {}, "news": {} },
      "maps": {
        "status": "OK", "geocoded_waypoints": [],
        "routes": [{ "legs": [{
          "duration": { "text": "10 mins", "value": 600 },
          "duration_in_traffic": { "text": "15 mins", "value": 900 }
        }] }]
      },
      "calendar": {
        "google": { "personalCalendar": { "items": [] }, "workCalendar": { "items": [] } },
        "outlook": { "personalCalendar": { "value": [] }, "workCalendar": { "value": [] } }
      },
      "meta": {
        "date": "2026-09-13", "timeZone": "America/New_York",
        "workTime": { "hour": 19, "min": 45 },
        "eventTimestamps": []
      }
    }
  }
}
```

`meta` binds the resolved execution date, local timezone, commute work time and
every source calendar event's `(service, calendar, index, start, end)`
timestamp. The loader rejects a case if those bindings do not match the
preferences or calendar payload. The generated
`calendar-four-card-field-matrix` case has tomorrow's ordered single-provider
cards: `Company holiday` full-day, `Birthday party and board meeting ` followed
by 30 dots at `10:25` (the real view truncates it), `Work meeting` at `14:00`
(generic icon fallback), and `Dog walk` at `20:25`. The generated
`calendar-parallel` case has same-time personal Google and work Outlook events,
so the real report graph produces its parallel card path. Both use the phrase
`what is on my calendar tomorrow`; the report request must carry NLU date
entity `tomorrow`.

`userPrefs` is already-converted Report preferences. A case may instead use
`prefs` with the same shape, or `settings` with a source `GetSettings` object
(or an array containing `{ "skillId": "report-skill", "data": ... }`); the
real `SettingsClient.convertSettingsToPrefs` conversion is used for the last
form. The generated cases intentionally use converted preferences and direct
provider callbacks to isolate S-13 view rendering; Settings conversion,
OAuth, and provider behavior are covered by the S-11/S-12 source lanes and are
not claimed by this fixture. Maps is a Google Maps response, and may be keyed
by travel mode or wrapped in `relayData`. Google calendar provider data uses
`items`; Outlook uses `value`; bare `events` arrays are also accepted. Calendar
event normalization remains the real Data implementation.

The `casesSha256` digest covers only the canonical `cases` object, with object
keys sorted recursively. This lets the operator change `caseId` between turns
without changing the digest. The optional
`PHOENIX_ROBOT_S13_FIXTURE_CASES_SHA256` checks that digest, while
`PHOENIX_ROBOT_S13_FIXTURE_SHA256` checks the complete file bytes for an
immutable run. A schema, mode, JSON, case selector, provider shape, or digest
failure aborts startup or the next request; no live provider fallback is used
by fixture callbacks.

The template creates `Normal`, `Bad`, and `Terrible` commute cases. Their
source Maps baseline remains 10 minutes while traffic is independently
10/15/25 minutes. With the generated future work time, all three stay within
the 0–120 minute departure-view window when started promptly. The source
S-11/S-12 harness covers the AM/PM label variants; this generated fixture keeps
one concrete future departure window for the physical diagnostic run.

Start the real diagnostic stack with an unprivileged base port:

```sh
cd /home/shell/work/phoenix
PHOENIX_ENV_FILE=/dev/null \
PHOENIX_ROBOT_RUN="$RUN" \
PHOENIX_ROBOT_PORT=19000 \
PHOENIX_ROBOT_S13_FIXTURE_FILE="$RUN/fixture.json" \
node scripts/parity-robot/stack.mjs
```

Use `PHOENIX_ROBOT_AUTH=true` when the robot supplies a valid Hub JWT; the
default diagnostic profile keeps the existing transport-only mode. The startup
JSON includes `fixture.path`, the complete file `sha256`, `casesSha256`, and
the selected `caseId`. Every captured WebSocket event also carries those
fields, and each fixture provider read is recorded as a `fixture-provider`
event. The receipt is `$RUN/stack.json`; the wire trace is the `tracePath` in
that receipt. Both are written under the run directory.

To switch cases without restarting, prepare a new file from the current one,
change `caseId` exactly (for example `Bad`, `Terrible`,
`calendar-four-card-field-matrix`, or `calendar-parallel`), keep the
`casesSha256` value unchanged, set mode `0600`, and atomically replace the
path:

```sh
cp "$RUN/fixture.json" "$RUN/fixture.next.json"
# edit fixture.next.json; do not edit fixture.json in place
chmod 600 "$RUN/fixture.next.json"
mv -f "$RUN/fixture.next.json" "$RUN/fixture.json"
```

Changing provider data requires recomputing `integrity.casesSha256`; changing
only `caseId` does not. The fixture stack disables its in-memory relay caches
so the next Report turn reads the selected case through Data HTTP. A case
change during an in-flight turn is rejected when the Data request carries the
same transaction id as the prior Settings request. Replace the file only
after the current turn is complete and the robot is idle; this preserves one
case across the real Settings → Report → Data graph. An implementation that
sends Data without a transaction header cannot provide that additional
mid-turn guard, so the idle-turn rule still applies.

The mode covers report provider inputs and the real Hub/Skills path. It does
not claim physical Nimbus rendering, authenticated Classic/Account startup,
live Google/Outlook credentials, live Maps availability, server-side ASR, or
production deployment behavior. `stack.mjs` without either fixture-path
environment variable retains its existing startup and provider behavior.

### Physical WhoIsThis identity bridge

On a physical Moth turn, the source `WhoIsThis` graph can select a loop user
whose runtime object has an `id` but no `accountId`. The original
`LassoClient.fetchCalendarEvents` requires that field to build the unchanged
calendar request, so an absent value would make Data reject the request with
HTTP 400. When (and only when) the S13 fixture path is enabled, `stack.mjs`
installs a small bridge around that original Lasso method. For the selected
speaker only, it passes a shallow-cloned report runtime whose missing
`accountId` is the deterministic value
`phoenix-s13-fixture-calendar-account-v1`.

The bridge preserves the original Lasso method's URL construction, headers,
transaction, service selection, Data HTTP request, provider callback, and
calendar normalization. It does not mutate the graph's runtime object, replace
NLU/Gateway/Report/Data, or create an account, loop membership, token, OAuth
credential, or live-provider fallback. An existing non-empty string
`accountId` is preserved. Missing or malformed speaker, loop, user, or account
data fails closed before the original method is called. The synthetic identity
is accepted only by the fixture Data provider path, is not persisted, and is
reported in `stack.json` and wire metadata under `fixture.calendarIdentity`
with `credentials: "none"` and a calendar Lasso/Data-only scope.

The wrapper has an explicit restoration hook and is removed during diagnostic
stack shutdown or startup failure. Runs without
`PHOENIX_ROBOT_S13_FIXTURE_FILE` (or its compatibility alias) never install
this identity bridge.
