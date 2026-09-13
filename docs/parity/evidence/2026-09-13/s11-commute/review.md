# S-11 commute calculations and condition tables verification

Date: 2026-09-13  
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`  
Reviewed Phoenix implementation: `8f8c234b80d94dff57eb0396a29fdc098c2d1b7e`

## Verdict

**VERIFIED:** Phoenix matches the pinned Pegasus commute calculation,
condition-table, MIM, speech, view, preference, Report HTTP, and Data relay
contracts exercised by the archived tests and the source-backed boundary
matrices. The four independent runtime lanes finish with zero source/candidate
differences, and their fail-closed controls reject reduced, reordered,
semantically rewritten, stale, or provenance-rewritten evidence.

Source files were obtained through the Jibo/Gebo archive and executed from the
prepared pinned checkout. Source runs use the digest-pinned Node 8.9.4 image
with networking disabled. Phoenix provider peers are loopback-only; no web
lookup or live third-party response participates in this proof.

## Archived commute runtime differential

`scripts/parity-s11-source-diff/compare.mjs` executes the compiled Pegasus
Commute implementation and current Phoenix implementation under the same
frozen New York time and deterministic random seed. The immutable contract
pins the complete archived `Commute.test.js` inventory, its supporting
`TestUtils.js`, source and compiled dependencies, view resources, current
Phoenix modules, and the exact five supplemental mode descriptors.

The final clean-HEAD receipt at
`.parity/runs/s11-final-8f8c234/source-clean/` records Phoenix revision
`8f8c234b80d94dff57eb0396a29fdc098c2d1b7e` and reports:

- all 33 archived cases, 33 expanded runs, and 36 direct archived assertions;
- five supplemental mode runs for driving, transit, bicycling, walking, and an
  invalid mode, explicitly carrying zero archived-assertion credit;
- the eight archived groups: top level, data, parse, non-driving, both driving
  departure ranges, late driving, and views;
- exact preservation of `undefined` versus `null` and semantic MIM paths;
- zero differences;
- source receipt SHA-256
  `ced243b9d8962b1509de2edb2fe8ca9403030ec0443fbcd2fa02542608eb1eb9`;
- candidate receipt SHA-256
  `d705fed31e16b66419b645497a043988862c91a194884d8678eefa65211ec7e4`;
- comparison SHA-256
  `29fa6bee5fc1cbce6e4303433320d5b26786700783d77299543f9ca014ac56ca`.

The eleven adversarial checks remove and reorder receipt rows, rewrite and
rehash a result, replace an archived row while keeping the same aggregate
counts, rewrite the supplemental driving input, replace the archived test
path, collapse `undefined` to `null`, corrupt a MIM path, alter the current
implementation, and replay a stale receipt after a code change. Every control
is rejected. Its receipt SHA-256 is
`da00d1287fc15084162b252f298a075577d77bf87a48844120b6a9ac81ac97e4`.

## Real Report HTTP graph

`scripts/parity-s11-http-graph/run.mjs` starts the actual pinned Pegasus and
Phoenix Report HTTP services against deterministic Data peers. Its immutable
semantic matrix fixes all 33 case IDs and order, 34 returned actions, and 31
provider requests. It covers all four commute modes, missing traffic, exact
five/fifteen-minute severity boundaries, departure and minutes-left edges,
duration flooring, work versus early-calendar arrival, full and single-skill
reports, identity and adult gates, confirmation, incomplete and invalid
preferences, Settings failure, Maps failure/empty/malformed envelopes,
calendar dependency, category isolation, `ServiceDown`, and
`AllServicesDown`.

The comparator checks complete normalized actions; ordered MIM and prompt IDs;
rendered ESML and spoken values; traffic and departure views; analytics;
transitions; and every provider request's route, raw query, decoded query,
headers, status, and order. The final clean-HEAD receipt at
`.parity/runs/s11-final-8f8c234/http-clean/` records Phoenix revision
`8f8c234b80d94dff57eb0396a29fdc098c2d1b7e` and passes 33/33 with zero
differences. Its hashes are:

- source `d7354d5d9d3f1f70dd9e67450aa64db5f5a8b67efbf7a70405adfcc492d87508`;
- candidate `f11acddcd25e3db6aeef36fa69df4b5f036171ffc7133caed3480482abaf78ae`;
- comparison `44f75aa7ed986243532de6f23dce7cff949da712ebd421dede459a9c06b18094`.

Fourteen negative controls reject MIM order, prompt, ESML, view, analytics,
transition, action, and provider-call mutations as well as paired matrix and
receipt removal, reorder, MIM, speech, and provider rewrites. The control log
SHA-256 is
`e7f73d7e3f0976a6928696aaee1355d415dc708988913caffc11310402975688`.

## Settings conversion and HTTP boundary

`scripts/parity-s11-settings-http/run.mjs` runs the pinned and Phoenix
`SettingsClient` implementations directly and through local Settings HTTP
peers. The 43 fixed cases cover the numeric commute enum `0..3`, negative,
large, fractional, `NaN`, string, null, and missing mode values; every one of
the seven required commute fields; zero and out-of-range presence semantics;
malformed settings; default preferences for missing, not-in-loop, and child
speakers; adult account/loop/transId wire data; missing credentials; non-2xx,
empty, null, malformed, and missing report responses.

The final clean-HEAD receipt at
`.parity/runs/s11-final-8f8c234/settings-clean/` records Phoenix revision
`8f8c234b80d94dff57eb0396a29fdc098c2d1b7e` and passes 43/43 with 12 actual
loopback requests and zero differences. A code-pinned provenance
manifest verifies 55 source/runtime/dependency files and nine Phoenix files
before import. The hashes are:

- provenance manifest
  `0dce7437bd5d1df7415b77a0bdd7c2fc034d7d11f831584d0ce60171b1654225`;
- source receipt
  `aeaf38873d66807a0ec757211ed5fa89ad8d87207dd85865de358f31ef1a71d2`;
- candidate receipt
  `2b227cd7a15788d8cace76e0560b300c7bab9931fdc544bcda407246db95dd29`;
- comparison
  `c109027204d31e7d82ed51705a3c39dd773672a5f13425ee7b818918592c0ea3`.

All eleven receipt, paired-matrix, semantic, request, error, and provenance
controls pass. The control log SHA-256 is
`6f3244cdadd014517da4356b92241554d70a92221e39132db8c3d11fa4595f29`.

## Data and Maps relay boundary

`scripts/parity-s11-data-maps-diff/run.mjs` executes the pinned Pegasus Lasso
GoogleMaps handler over HTTP with a local Google provider seam, then executes
the actual Phoenix Data HTTP service with a local ORS seam. It preserves each
side's real provider request construction and compares the shared semantic
response, cache, and error effects.

The fixed 20 cases produce 28 requests and 17 provider calls per side. They
cover miss/hit caching, a cold HEAD and later warm hit, empty replies,
upstream-status errors, zero routes, both `skipCache` truthiness forms, all four
modes, and exact missing, invalid, range, and JSON-parse errors. Source,
compiled, archived test, Google fixture, Phoenix, and harness bytes are pinned.

The final clean-HEAD receipt at
`.parity/runs/s11-final-8f8c234/data-maps-clean/` records Phoenix revision
`8f8c234b80d94dff57eb0396a29fdc098c2d1b7e` and passes with zero differences
and zero receipt errors. Its hashes are:

- source `288757dca6ecdd27e2d3666a60c23235ada052fe2725866f66bcbd6c5ade6310`;
- candidate `fd4b2fc2d414818f7f9c9bc02db9115ff1a5d8eabb390d0299c51ef04453e1ea`;
- comparison `5ede1149c848681d13800b8432a4016b1d6216e8ebef503b3208f6a859e98c86`;
- nine-control falsifier
  `1ac7e87e5d3fc17099628222d41c77386932fde1626faae2adb6197c26d2a183`.

The independent HEAD-order review also proved the source sends the empty HEAD
response before cache/provider work begins. Reverting the production repair
or reducing its nested scheduling to one immediate fails the named regression;
the restored implementation passed 200 unique HEAD iterations with every
provider starting after the client response.

## Language, timing, and direct tests

All fifteen Commute MIMs and the two view resources plus shared prompt resource
match the pinned source bytes. All 169 Commute prompts render through Slimmer
with their dynamic traffic, duration, countdown, and departure values. Frozen
tests cover numeric offsets, midnight, half-hour zones, DST offset changes,
today/tomorrow/full-day event selection, first-early ordering, floor and
negative traffic deltas, positive and negative half-minute rounding, and every
MIM boundary.

Root directly falsified the one production repair. Removing the arrival-time
catch failed the malformed-work-time regression. A superficially plausible
short-circuit implementation also failed because Pegasus evaluates the work
arrival before choosing an earlier calendar arrival. The restored
`packages/skills/src/report/commute.js` hash is
`609e4bca42da771ea4bea7dcbcfd985d220648242504e21610f3b0072e22c414`.

The final focused S-11, Maps, relay, report-view, and report-subskill suite
passes 117/117. The controlled-concurrency repository rerun passes 2,254 tests
with nine skips and zero failures. Its first run had one unrelated encoded-ASR
fixture hit its fixed three-second timeout under load; that named test then
passed five consecutive isolated runs before the complete green rerun. The
tracker is structurally valid, and the strict production smoke gate matches all
43 cases with zero differences, invariants, or coverage gaps.

## Retained provider gaps

S-11 verifies the Report skill's original calculations and branches, including
Google-shaped traffic and every travel-mode input. It does not erase the two
explicit D-07 provider limitations:

- `mode=transit` remains accepted, but the live ORS adapter uses the
  `driving-car` profile and supplies no transit details or departure data;
- ORS has no traffic model, so its live `duration_in_traffic` equals the base
  duration and cannot presently reach real poor or terrible traffic branches.

The source Data differential proves Pegasus sends `departure_time=now`,
`traffic_model=pessimistic`, and the selected mode. Phoenix proves its current
ORS wire behavior separately. Poor and terrible traffic calculation and
presentation are therefore **VERIFIED** against pinned Google-shaped source
fixtures, while their live provider reachability and real transit behavior
remain the already accepted **PARTIAL** D-07 implementation gaps.

Pegasus logs its caught arrival-time error and some CommuteData diagnostics
that Phoenix does not emit. Return values, error classification, actions, and
wire behavior match; internal diagnostic wording is outside the S-11
acceptance contract.

## Reproduction

```bash
node scripts/parity-s11-source-diff/compare.mjs --out .parity/runs/s11-commute-source
node scripts/parity-s11-source-diff/falsify.mjs --run-dir .parity/runs/s11-commute-source
node scripts/parity-s11-http-graph/run.mjs --out .parity/runs/s11-commute-http
node scripts/parity-s11-settings-http/run.mjs --out .parity/runs/s11-settings-http
node scripts/parity-s11-data-maps-diff/run.mjs --out .parity/runs/s11-data-maps
node --test packages/skills/test/s11*.test.js packages/skills/test/reportViews*.test.js packages/skills/test/reportSubskills.test.js packages/data/test/maps*.test.js packages/data/test/relay-contract.test.js
node --test --test-concurrency=4
npm run parity:check
npm run parity:gate
```
