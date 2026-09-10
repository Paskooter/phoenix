# S-06 — MIM, manifest and grammar asset provenance

Task: **S-06** (`pegasus`, phase 3, P0, implementation `partial`)
Title: *Verify all MIM, manifest and grammar asset provenance*
Worktree: `/home/shell/work/phoenix/.parity/worktrees/w3-s06` (branch `w3/s06`)
Date: 2026-09-10

Acceptance (from `docs/parity/tasks.json`):

1. Map every source MIM, category CSV, view/config, manifest entry and required
   helper to a Phoenix asset and consuming behavior.
2. Check hashes or documented transformations, parse/load every asset and
   validate that referenced assets resolve.
3. Preserve legacy robot asset names/paths; uncovered files become explicit
   tasks rather than being omitted from progress.

Recommendation: **VERIFIED (with 3 recorded gaps / divergence candidates)** —
see [Gaps and candidates](#gaps-divergences-and-candidates) and
[Unknowns](#unknowns).

---

## 1. Method and pinned sources

The task names the Jibo archive MCP (`jibo_search`, `gitea_read_file`). Those
tools are **not exposed in this subagent's tool catalog** (only the offline
`jibo_*` robot tools are). SUBSTITUTE: the two locally pinned checkouts that
`docs/parity/SOURCES.md` already documents as the audit basis:

| role | path | revision |
| --- | --- | --- |
| authoritative pin (original candidate) | `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c` | `5c0a7390539663ba749d360de348a428c088505c` |
| working checkout (cross-check) | `/home/shell/work/pegasus` | `d682547a31511cd164db0913b6104eb1786455a2` |

Both are complete Pegasus trees; their MIM / CSV / view / rule trees are
**byte-identical to each other** (verified, 0 hash diffs across
`packages/chitchat-skill/mims`, `packages/report-skill/mims`,
`packages/baseskill/mims`, `packages/report-skill/resources`,
`packages/chitchat-skill/res`, `packages/parser/robust-parser/rules_src`).

Provenance was **re-derived from the pins** by
`scripts/parity-assets/generate.mjs` (committed). It hashes every asset family,
computes a canonical aggregate digest (`sha256` over the sorted lines
`` `<relpath> <sha256>\n` ``), records per-file hashes for trees ≤ 300 files and
source-equivalence counts (identical / only-source / only-phoenix / differing).
The committed fixtures are what the tests assert against, so the suite never
depends on the external checkouts.

```
node scripts/parity-assets/generate.mjs \
  --source <5c0a739 reference> --source2 /home/shell/work/pegasus \
  --revision 5c0a7390539663ba749d360de348a428c088505c \
  --out packages/skills/test/fixtures/asset-provenance.json \
  --out-manifests packages/gateway/test/fixtures/manifest-provenance.json \
  --out-grammar packages/nlu/test/fixtures/grammar-provenance.json
```

## 2. Inventory and provenance — 4,800 files

### MIM / view / config assets (`packages/skills`)

| family (Phoenix) | source | files | aggregate SHA-256 | provenance |
| --- | --- | ---: | --- | --- |
| `resources/mims/chitchat` | `chitchat-skill/mims` (4,424) + `chitchat-skill/res/semi_specific_categories` (66) | 4,490 | `47ab0d7b250ea543…` | **VERIFIED** byte-identical |
| `resources/mims/report` | `report-skill/mims` | 82 | `6872311f97c38edc…` | **VERIFIED** byte-identical |
| `resources/mims/base` | `baseskill/mims` | 4 | `ce7f6e9f08bcca74…` | **VERIFIED** byte-identical |
| `resources/mims/template` | `template-skill/mims` | 1 | `297041178376996c…` | **VERIFIED** byte-identical |
| `resources/mims/gqa` | recovered `srv-gqa-ws@ebe1a7d` `pegasus_mims` (10) + 1 Phoenix-authored | 11 | `a69cb542f4d9fc33…` | 10 **VERIFIED**, 1 authored (see gap G1) |
| `resources/mims/color` | none | 2 | `fbd9b44d8273fd33…` | **INFERRED** Phoenix-authored (gap G2) |
| `resources/views` | `report-skill/resources/views` | 6 | `0e022f2debbf9408…` | **VERIFIED** byte-identical |
| `resources/gqa` | recovered `srv-gqa-ws@ebe1a7d` data files | 4 | `0fb42de339427290…` | **INFERRED** (Q-01 recovery, not a git pin) |
| `resources/report-mimPromptText.json` | `report-skill/resources/mimPromptText.json` | 1 | `31463e27c9e44559…` | **VERIFIED** byte-identical |
| `resources/report-prefsConfig.json` | `report-skill/resources/prefsConfig.json` | 1 | `350ada68b86d2ad8…` | **VERIFIED** byte-identical |

Full digests are in `packages/skills/test/fixtures/asset-provenance.json`.

Category CSVs are **re-homed** from `packages/chitchat-skill/res/semi_specific_categories`
to `resources/mims/chitchat/semi_specific_categories/`; the 66 files are
byte-identical, so the re-home is a path change only. The consumer is
`packages/skills/src/chitchat/library.js:26-46` (per-directory MIM id sets +
category→Value mapping, matching `Chitchat.ts:44-53`).

### Manifest assets (`packages/gateway`)

| family | source | files | provenance |
| --- | --- | ---: | --- |
| `resources/skills` (indexes + manifests) | `hub/resources/skills`, `hub/pegasus-skills`, `hub/be-skills`, `hub/external-skills` | 33 | 26 source-derived, 7 Phoenix-authored |

Per-file classification (fixture `indexFiles` / `sourceEquivalence`):

- `skills-local.json`, `skills-pegasus1.json`, `skills-pegasus2.json`,
  `stringNormalizationMap.json` — **VERIFIED** byte-identical to `5c0a739`
  (`fdbcea33…`, `c41ab0d3…`, `de4b4ef9…`, `3679ae74…`). Note `skills-local.json`
  and `skills-pegasus2.json` **differ from the `d682547a` working checkout**
  (which has local edits: `answer-skill:8080` entry and `:8080` ports) — the
  Phoenix copies track the `5c0a739` pin, not the working-branch edit.
- `be-skills/*` (17) and `external-skills/*` (2) — **VERIFIED** byte-identical.
- `pegasus-skills/chitchat|example|report|template` — **VERIFIED** byte-identical.
- `pegasus-skills/color_skill_manifest.json`, `skills-phoenix.json`,
  `skills-native.json`, `skills-gqa-{default,multi-provider,wikipedia}.json` —
  **INFERRED** Phoenix deployment adapters (no source counterpart).
- `pegasus-skills/answer_skill_manifest.json` — **documented transformation**
  (see gap G3).

Consumers: `packages/gateway/src/registry.js:30-47` (`loadRegistry` reads the
index, then every `configPath`, and rewrites `config.URL`);
`packages/gateway/src/config.js:40-80` (`loadConfig`).

### Grammar assets (`packages/nlu`)

| family | source | files | aggregate SHA-256 | provenance |
| --- | --- | ---: | --- | --- |
| `resources/rules-src` | `parser/robust-parser/rules_src` | 117 | `a570729f40fa2cb9…` | **VERIFIED** byte-identical |
| `resources/grammar` (globals/shared/skills, loaded) | subset of `rules_src` | 29 | `a307427e8071a5ca…` | **VERIFIED** byte-identical |
| `resources/rules/@be` (launch-rule engine) | `rules_src/<skill>/launch.rule` | 10 | `aaed208af1c225bd…` | **adapted** (gap G4) |
| `resources/data/eq_words.txt` | reference build `data/en-us/word_lists/eq_words.txt` | 1 | `f71e318c932c91ea…` | **INFERRED** |
| `resources/factory-words/*` | reference build factory word lists | 6 | `817daed63b9d8a72…` | **INFERRED** |
| `resources/factory/*.grm` | reference factory grammar handles | 2 | `529edbca2453d667…` | **INFERRED** |

Independent in-repo oracle: `resources/rule-inventory.json` pins
`referenceRevision 5c0a739…`, all **117 rules** (path + sha256), all **98 public
compiled FSTs**, the 2 factory grammars and the 7 supporting word lists. The test
asserts every recorded hash against the vendored files and against the pinned
source `rules_fst` files. **VERIFIED** — 0 mismatches.

Consumers: `packages/nlu/src/fullGrammar.js` (loads `grammar/globals`,
`grammar/shared`, `grammar/skills/<x>/launch.rule`),
`packages/nlu/src/launchRules.js` (loads `rules/@be/<x>/launch.rule` + `factory/`),
`packages/nlu/src/grammar/*` (the matcher).

## 3. Parse / load every asset — and resolve references

**VERIFIED** (`packages/skills/test/assetProvenance.test.js`):

- All **4,524** `.mim` files load through the production loader
  (`loadMimFile`, `packages/skills/src/graph/mims/loadMim.js`). Every file is a
  JSON object with a non-empty `prompts` array; all **12,798** prompts carry
  string `prompt` / `media` / `prompt_id` fields.
- Schema note (source property, not a defect): `mim_type` is absent from the
  GQA and most chitchat MIMs; both the source and Phoenix derive `mim_id`/type
  from the filename or the caller (`loadMim.js`; `gqaAnswerSkill.js:37-45`).
  `prompt_id` duplicates exist in the pinned source too (e.g.
  `report/en-us/PersonalReportOptInConfigured.mim` ships `…_HR_01` twice), so
  uniqueness is not asserted.
- Semi-specific resolution: 151 `*_SS_*` scripted MIMs → 53 distinct category
  stems → 66 CSVs. Two stems (`PetDied`, `ScaryCreature`) have **no CSV in the
  pinned source either** — reproduced, not silently dropped.
- All 66 CSVs parse with the `Value,Synonyms` header.

## 4. Runtime reachability — assets actually served

Static hashes do not prove reachability. Each of the following was **requested
through the running service** and the reply compared to the on-disk asset.

### Skills HTTP host (`packages/skills/test/assetProvenance.test.js`)

- Started via `start(0)` (`packages/skills/src/index.js`), `POST /v1/chitchat-skill/main`
  with memo `{mim:'RI_JBO_LikesIceCream', type:'ScriptedResponse'}`. Served
  `meta.mim_id = RI_JBO_LikesIceCream`, `meta.prompt_id = RI_JBO_LikesIceCream_AN_01`,
  and the ESML is one of that file's prompts (`RI_JBO_LikesIceCream.mim`).
  **VERIFIED**.
- `POST /v1/report-skill/main` (`requestWeatherPR`) against a local dark-sky
  relay. Every served `mim_id` resolves to `resources/mims/report/en-us/<id>.mim`
  and the served ESML is the rendered form of an on-disk prompt (observed
  `WeatherIntro`, `WeatherChangeCloudyWet`, `WeatherTodayWarmer`). **VERIFIED**.
- The same report reply carries the **view config**: `viewConfig.id =
  weatherTempView` and every `componentConfigs[].id` / `position.x` from
  `resources/views/weatherHiLo.json`, plus the Nimbus asset path
  `assets/personal-report-skill/weather/bg/tempNormal_v01.crn` derived by
  `weatherViews.js` → `getJSON('views/weatherHiLo')`. **VERIFIED**.

### Gateway (`packages/gateway/test/manifestProvenance.test.js`)

- `loadConfig({})` resolves the index + all 21 `configPath` entries (a bad entry
  throws at startup). Started `createGateway(config)`; `GET /v1/skills` returns
  200 with 21 skills whose `{id, intents}` are the loaded manifests; the
  `answer` entry serves all 19 pinned external-answer intent names. **VERIFIED**.
- Shared-host profile (`NET_skills=localhost:9014` → `skills-phoenix.json`)
  serves `answer-skill` from `pegasus-skills/answer_skill_manifest.json` with
  every source intent plus the 7 merged intents. **VERIFIED**.

### NLU (`packages/nlu/test/grammarProvenance.test.js`)

- Started `start(0)` (`packages/nlu/src/index.js`); `_loadedSkillCount() === 20`
  equals the number of `grammar/skills/*/launch.rule` files on disk.
- `POST /v1/parse`: `"sing me a song"` → `requestSingSong` (literal defined in
  `grammar/skills/chitchat/launch.rule`); `"turn on the lights"` → `lightsOn`,
  `entities.skill = @be/hue-control` (`grammar/skills/hue-control/launch.rule`);
  `"set a timer for five minutes"` → `start`, `@be/clock` (literal
  `_intent = 'start'` defined in `rules/@be/clock/launch.rule`);
  `"blurf gnax wibble"` → `null` (no invented match). **VERIFIED**.

## 5. Falsification

Two deliberate breakages; both anchored on **full code/data lines**.

**F1 — runtime MIM reachability (primary, highest-risk).**
Broke `packages/skills/src/chitchatSkill.js:136`, the full line

```js
    data.local.path = join(baseDir, `${mimID}.mim`);
```

to

```js
    data.local.path = join(MIM_DIRS.FALLBACK, `${mimID}.mim`);
```

(the served path no longer points at the scripted-responses tree).
`node --test packages/skills/test/assetProvenance.test.js` → test 5
*"S-06 runtime: the skills host loads and serves chitchat + report MIM assets"*
**FAILED** with `Cannot read properties of undefined (reading 'config')`
(no SLIM was produced). Restored the line, re-ran → 6/6 pass.

**F2 — pinned byte-identity.**
Changed the line `"id": "tempBGClip",` in
`packages/skills/resources/views/weatherHiLo.json` to
`"id": "tempBGClipFALSIFY",`. The family-digest test **FAILED** on the `views`
aggregate (`expected 0e022f2debbf9408… actual 834033687a8be2e1…`). Restored via
`git checkout`; the file is again byte-identical to source; suite green.

Observation: F2 was caught by the digest layer but **not** by the runtime view
assertion, because that assertion correctly proves the served payload tracks the
on-disk file — if the file changes, both sides change together. That is the
intended reachability semantics (it would fail if the view were hard-coded or
read from elsewhere), and it is why the digest layer is kept alongside it.

## Gaps, divergences and candidates

*Reported as candidates only — `docs/parity/tasks.json` and `DIVERGENCES.md`
were not edited.*

- **G1 / candidate — `GQA_banned_word.mim` has no pinned source file.**
  `resources/mims/gqa/` holds 11 MIMs; the recovered
  `srv-gqa-ws@ebe1a7d` set (`…/reviews/q01-gqa-20260906/source/pegasus_mims/`)
  holds 10 and the recovered `gqa/gqa.py:506` calls
  `slim_from_mim("GQA_banned_word")`. The file is Phoenix-authored/imported from
  an unrecorded source. sha256 `c4c20e693f351129…`. Needs an explicit pin or a
  recorded derivation before S-06 can call that one file source-backed.
- **G2 / candidate — colour MIMs are invented.**
  `resources/mims/color/{qn.mim,an.mim}` (`mim_id` `ColorQN`) were added in
  commit `bc6e4ce`; no pinned skill ships an AskColor MIM. Names/paths are
  Phoenix choices; the QN/AN field shape matches the reference `MimConfig`.
- **G3 / candidate — `pegasus-skills/answer_skill_manifest.json` is a
  transformed source file.** It is a pretty-printed superset of the
  `d682547a` checkout's manifest (+7 intents: `isUnknownDescriptor`,
  `requestWeather`, `whenIsBirthday`, `whereIsPerson`, `whereIsThing`,
  `whoIsPerson`, `whyIsUnknownDescriptor`). All 7 are present in the pinned
  `hub/external-skills/answer_manifest.json`, and the source `id`/memos are
  preserved, so the merge is source-backed — but the file itself is **not**
  byte-identical to any source and should be listed as a deliberate
  transformation in `DIVERGENCES.md`.
- **G4 / candidate — `resources/rules/@be/*/launch.rule` are adapted, not
  vendored.** All 10 differ from the byte-identical `grammar/skills` copies
  (arm pruning, intent renames, factory rewrites — e.g. clock `askForDate` →
  `askForDay`, timer `D_TIMER_INTENT_VALUE_REQ` → `D_TIMER_SET_VALUE_REQ`). The
  launch-rule engine is live (`launchRules.js`, `index.js:14`) so the adaptation
  is behaviour-relevant. Fixture `documentedDivergences` records it; the file
  paths and intent names are preserved.
- **G5 / minor — re-homed asset path.** `chitchat-skill/res/…` →
  `resources/mims/chitchat/semi_specific_categories/`. Contents identical; the
  legacy directory name is not preserved literally, but no legacy *file* name is
  lost.
- **G6 / candidate — the `d682547a` working checkout is locally edited.**
  `packages/hub/resources/skills/skills-local.json` and `skills-pegasus2.json`
  there differ from the `5c0a739` pin (added `answer-skill:8080` entry,
  `:8080` ports, a `_comment_2026`). Phoenix tracks the pin; worth recording so
  future audits do not treat the working checkout as pristine.

## Unknowns

- **U1** — The archive MCP (`jibo_search`/`gitea_read_file`) was unavailable in
  this subagent; provenance is anchored to the local `5c0a739` reference plus the
  `d682547a` checkout, which agree on every asset family. Whether a *newer*
  upstream revision changes any of these files is **UNKNOWN**.
- **U2** — `resources/data/eq_words.txt`, `resources/factory-words/*` and
  `resources/factory/*.grm` are anchored to `rule-inventory.json` hashes, not to
  a directly inspected source file (the reference `build/…` tree). Their upstream
  origin is **INFERRED**, not independently read.
- **U3** — `resources/gqa/{banned_words,wikipedia_*}.json` inherit Q-01's
  recovery (`srv-gqa-ws@ebe1a7d`); the recovery is a private artifact under
  `.parity/reviews/q01-gqa-20260906/`, not a re-readable git pin.
- **U4** — No renderer/hardware proof: the view `.crn` assets referenced by
  `weatherHiLo.json` are resolved by name only (S-13 covers Nimbus packaging).
  S-06 does not claim display-render parity.
- **U5** — Pre-existing `*_SS_` category gaps (`PetDied`, `ScaryCreature`) are
  source-inherited; whether those utterances were ever reachable on the original
  robot is **UNKNOWN**.

## Verification runs

- New focused tests (all pass):
  `node --test packages/skills/test/assetProvenance.test.js`
  `node --test packages/gateway/test/manifestProvenance.test.js`
  `node --test packages/nlu/test/grammarProvenance.test.js` → **14/14**.
- Falsification F1/F2 as above; both restored and re-confirmed green.
- **Full `npm test` (single run, 2026-09-10):**

  ```
  # tests 1233
  # suites 7
  # pass 1226
  # fail 0
  # cancelled 0
  # skipped 7
  # duration_ms 25415.928266
  ```

  `npm run parity:check`:
  `Checklist: 16/79 verified (20.3%)` … `Tracker structure, dependencies,
  evidence links and generated checklist are valid.`

  `npm run parity:gate` (strict production smoke, 43 cases):

  ```json
  {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
  ```

  Exit code `0`. Gate evidence dir:
  `.parity/runs/ci-production-70be366f-016d-4079-b1f8-344b80fc9808`.

