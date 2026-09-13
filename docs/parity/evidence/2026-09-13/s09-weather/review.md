# S-09 weather language and condition-table verification

Date: 2026-09-13  
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`  
Reviewed Phoenix implementation: `cce7def2f0be2178d7b6da25d60089d8f395b926`

## Verdict

**VERIFIED:** S-09 satisfies both written acceptance criteria for the source's
canonical weather input contract. Phoenix matches the pinned Pegasus weather
implementation on all 54 archived cases and all 57 expanded executions, then
matches it again in 15 frozen end-to-end Report HTTP cases. No source/candidate
difference remains in either receipt.

The source material was obtained through the Jibo/Gebo archive. The replay
uses the prepared pinned checkout only; it performs no web lookup or live
provider request.

## Source/runtime differential

`scripts/parity-s09-source-diff/compare.mjs` executes compiled Pegasus weather
modules under the digest-pinned Node 8.9.4 image with networking disabled and
runs Phoenix from the current worktree. It verifies the archived test and the
four compiled implementation hashes before executing rows. Its fail-closed
matrix requires every source and candidate row, rejects extra or duplicate
rows, recomputes row hashes, and compares parser output, ordered MIMs, weather
state, and complete view JSON.

The final receipt at `.parity/runs/s09-weather-source-diff-cce7def/` reports:

- 54/54 named cases and 57/57 expanded runs;
- 3 top-level, 14 parse, 19 daytime, 9 evening, and 9 view cases;
- zero differences;
- source receipt SHA-256
  `55336e79588108e73a938408c17351554e417b2ce385342ddf26500892491f8a`;
- candidate receipt SHA-256
  `88b60eef46cf8b529969682095d2825fdf9efe357fe2bfd251d9a12bc24db407`.

The pinned source identities are recorded in
`scripts/parity-s09-source-diff/branch-manifest.json`: the archived
`Weather.test.js` SHA-256 is
`b2209e30f28ae672d99b5842da8c673c6733f4b0af09bb0bf4f01420ddd8eeac`,
and the runtime image digest is
`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.

## Real Report HTTP graph

`scripts/parity-s09/run.mjs` starts the actual pinned Pegasus and Phoenix
Report HTTP services against the same frozen local Data peer. Each of its 15
rows asserts two DarkSky relay calls with exact coordinates, headers, and the
timestamped-yesterday versus timestamp-free-current query split. The matrix
covers full-report daytime/evening selection, single-skill today/tomorrow,
condition and temperature changes, Celsius, sanitization, wet-now/dry-later,
icon-only and ServiceDown fallbacks, fixed-offset night normalization, both
unknown-icon paths, and partial weather failure while News continues.

The comparator checks response type/finality, ordered MIM IDs, rendered speech,
weather-view presence, complete normalized JCP action, analytics, graph
transitions, and provider calls. The final receipt at
`.parity/runs/s09-weather-http-cce7def/` reports 15/15 cases and zero
differences. Source and candidate receipt SHA-256 values are respectively
`53fdfe761f5ee61b2bc801222f148042a52649e3ca186b402900c9e6cf54ba5b`
and `4fdcc7fd96c635c786fcb35dafceaa80551514289841c54fbe8a0e92286eaa11`.
A root negative control removed one candidate row; the comparator rejected it
with `row-count`, `row-order`, and `missing-row` differences.

## Language and repairs

**VERIFIED:** all 34 weather MIM files are byte-identical to the pinned source.
The test also checks every prompt count and dynamic reference, loader ID,
announcement type, and rendered Slimmer output. The weather prompt-text and
high/low-view resource hashes are
`1b987df35fd07a0094e502898071ac066544798c955f44b862cadb115cc61f71`
and `89cbcfd06e3e18d34226e7e600b756446078199db53335300ba4c5884c9d8a4a`.

Review found and repaired three source-contract regressions:

- `weatherParse` and its Report graph caller again preserve the asynchronous
  contract, including rejection on missing or non-string summaries;
- day/night selection now reads the location-local hour from the runtime ISO
  offset, preserving the source's 03:00 through 17:59 daytime interval;
- unknown non-enum icons now preserve the source's implicit `undefined` MIM
  suffix before both systems reach the same missing-resource error response.

Root replaced the fixed-offset calculation with host `Date#getHours()` and
observed seven named failures, including swapped today/tomorrow views and MIMs.
Root separately removed the `await` in `ParseDataNode` and observed the named
parser-node regression fail. Both files were restored byte-for-byte before the
passing runs. An independent Luna Max reviewer repeated those controls and also
proved the async declaration and string-only sanitizer tests fail when reverted.

The final integrated focused Report/S-09 suite passed 64/64. The
controlled-concurrency repository suite passed 2,135 tests with 9 documented
skips and no failures (2,144 total).

## Boundaries

**VERIFIED:** Pegasus and Phoenix both select `WeatherBasicCloudy` for partial
cloudy data, and both source trees omit `WeatherBasicCloudy.mim`; this shared
source/resource defect is preserved rather than filled with invented language.

**UNKNOWN:** live DarkSky availability and freshness, deployed-service behavior,
and physical Moth speech/display rendering are outside S-09. Malformed or bare
runtime date strings are also outside the canonical fixed-offset ISO contract.
Those boundaries remain assigned to provider, deployment, view, and hardware
tasks and receive no credit here.

## Reproduction

```bash
node scripts/parity-s09-source-diff/compare.mjs --out .parity/runs/s09-weather-source-diff-cce7def
node scripts/parity-s09/run.mjs --out .parity/runs/s09-weather-http-cce7def
node --test packages/skills/test/s09WeatherParse.test.js packages/skills/test/s09WeatherViews.test.js packages/skills/test/s09WeatherMim.test.js packages/skills/test/s09WeatherLanguage.test.js packages/skills/test/report.e2e.test.js packages/skills/test/reportSubskills.test.js packages/skills/test/reportViews.test.js packages/skills/test/reportViews.source-vectors.test.js
node --test --test-concurrency=4
npm run parity:check
npm run parity:gate
```
