# S-07 Chitchat runtime differential

Review date: 2026-09-13
Branch: `w19/s07-runtime`
Worktree: `/home/shell/work/phoenix-s07-runtime`
Base: `6eec06bbd44ffbf4f711d81cbad86e0ccedb5666`
Pinned source: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`

**Recommendation: UNKNOWN — keep S-07 open.** This receipt records the
source/runtime comparison for fun-and-games, fallback/deflection, MIM/ESML/JCP,
analytics, identity, emotion, birthday, seasonal, and available turn contexts.
It contains no Phoenix code repair. The complete production fixture replay was
attempted but stopped before capture completion; explicit Chitchat multi-turn
coverage and exact conditional prompt selection remain unproven.

## Source evidence

Jibo MCP search was run first for the Chitchat runtime query. It returned no
search hits; the pinned Gitea source was then read directly at the revision
above. The source controls and implementation files are:

- `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts` — valid intent/MIM
  dispatch, semi-specific resolution, fallback, prompt data, and analytics.
- `packages/chitchat-skill/src/nodes/IntentSplitNode.ts` — required memo and
  source access order.
- `packages/chitchat-skill/src/utils/FunAndGamesUtils.ts` — two dice rolls and
  one coin flip generated for a valid response.
- `packages/chitchat-skill/src/utils/Analytics.ts` — scripted and emotional
  event types and success values.
- `packages/baseskill/src/graph/mims/utils/slimmer/Slimmer.ts` — category and
  condition filtering, weighted prompt choice, ESML resolution, and listen
  generation for question/optional-response MIMs.
- `packages/chitchat-skill/tests/Chitchat.test.js` — direct scripted,
  semi-specific, JCP, and missing-memo controls.

The source test controls assert `RI_JBO_LikesPenguins_AN`,
`OI_USR_IsHappy_AN`, `OI_JBO_IsDoingGreat_AN`,
`RI_JBO_Likes_SS_Cheese_AN`, and either Seafood or Sealife for Crab. The
invalid launch control expects `ERROR` with
`Chitchat launched without required memo!`.

The checked-in Phoenix assets are byte-identical to the pinned Chitchat
assets: 4,424 MIM files and 66 category CSV files (4,490 files in the
provenance aggregate, SHA-256
`47ab0d7b250ea5439801da1026263e0c4889155c23c4f01651450436ac5b45f3`). Every
Chitchat MIM in the pinned tree is an announcement. Therefore this fixture
does not exercise a Chitchat `listen` action or an explicit second turn.

## Runtime matrix

The production fixture contains 20,534 cases: 11,432 Chitchat cases, 9,002
hub-client cases, 73 report cases, 21 boundary cases, and 6 skill cases. The
Chitchat context split is 10,035 `known`, 483 `identified`, and 914 historical
date contexts. The matrix compares routing memo/type, selected MIM, JCP
action, prompt ID, ESML, analytics, trace, turn count, and effect count. The
counts in the table are from the prior reviewed source/control diagnostic and
focused Phoenix checks; the current-head full replay failed before producing a
candidate capture, so these rows do not by themselves close current-head
acceptance.

| Slice | Cases | Source-shaped result | Status |
| --- | ---: | --- | --- |
| Fun-and-games | 665 | Prior diagnostic fields agreed; Dice/Coin constructors are directly covered by focused tests | INFERRED |
| Fallback/deflection | 13 | Prior diagnostic rows were no-route; invalid memo fallback is directly source-shaped | INFERRED |
| Identity | 929 | Prior diagnostic had 928 exact; one conditional `JBO_WhoMadeYou` prompt choice differed | UNKNOWN |
| Emotion | 4,388 | Prior diagnostic fields agreed, including emotion analytics | INFERRED |
| Birthday/seasonal | 1,330 | Prior diagnostic fields agreed | INFERRED |
| Other Chitchat | 4,921 | Prior diagnostic fields agreed | INFERRED |
| Chitchat aggregate | 11,432 | Current-head full capture unavailable; prior diagnostic had the conditional prompt residual | UNKNOWN |
| Explicit Chitchat multi-turn/listen | 0 | No production fixture case; all bundled Chitchat MIMs are announcements | UNKNOWN |

The source-shaped analytics distribution in the production fixture is:
11,419 `Skill Entry` events, 10,885 `scripted_response` query events, 316
`known_unknown` query events, 218 `Chitchat Emotion` events, and 217 true
`emotion_query` query events plus one false event. Routed Chitchat cases have
one turn; the 13 no-route cases have zero turns. No category produced a
Phoenix-only analytics event or action shape in the comparison.

## Conditional prompt residual

The sole selected-field residual is the source `JBO_WhoMadeYou.mim`, which
contains one prompt guarded by `Math.random() < .2` among otherwise
unconditional prompts. The pinned source Slimmer evaluates that condition in a
VM and then performs weighted selection. Phoenix preserves the same condition,
prompt content, weights, and separate condition/selection random streams. The
two source-shaped runs can therefore choose different valid prompt IDs for the
same identity query without indicating a dispatch, MIM content, ESML, JCP, or
analytics mismatch. The prior fixture comparison identifies the same
logical residual (the hub-client duplicate follows the same conditional
MIM): `chitchat:4597:0:base` selected source `AN_02` versus candidate `AN_03`,
and `hub-client:65:0:base` selected source `AN_04` versus candidate `AN_05`.
No repair is justified unless S-07 requires deterministic prompt IDs across
independently seeded runtime streams.

## Verification

The attempted current-head replay used the pinned reviewed golden files:

```text
python3 scripts/parity-production/run.py \
  --golden packages/harness/resources/goldens/production-full \
  --out .parity/runs/s07-runtime-full-20260913
# run.json: result=error; cases=20534
# candidate container exit=137 at progress=11200; no candidate.json.gz was written
```

The run was active and advancing until the parent terminated the stale
network-disabled container after more than 40 minutes with `docker stop
--time 10`; `run.json` therefore records exit 137. This is a stopped-run
receipt, not evidence of a spontaneous runtime or memory failure.
Its stable inputs are still recorded: `suite.json` SHA-256
`7adb8a8f48b0806cebc31ec420f289bca10703c15195aeaf5fd1ed60deddd327` and
`reference.json.gz` SHA-256
`b1cd1f9895932d1424633fa8c9a2e1bf52eb1d340214b0a71e23104ed192bd53`.
The failed run is not counted as a Phoenix pass. The prior reviewed
source/control diagnostic covers 20,533 cases and reports six action-field
differences (the same conditional prompt family), zero invariants, and 16
unhosted cloud coverage gaps; the current-head replay remains an acceptance
gap rather than being silently substituted by that older receipt.

Focused source-shaped controls:

```text
node --test packages/skills/test/intentResponses.test.js \
  packages/skills/test/promptFallbackSource.test.js \
  packages/skills/test/s04MimContracts.test.js \
  packages/skills/test/s03MimFactories.test.js \
  packages/skills/test/mimGraph.test.js
```

The fallback control specifically verifies that an invalid memo samples
`CC_Fallback` without constructing Dice/Coin first, preserving the source
random stream. A falsification temporarily changed the valid-path guard in
`packages/skills/src/chitchatSkill.js` from `if (validIntent && transition)`
to `if (true)` with `apply_patch`; the focused fallback test then failed on
the expected random-call count. The guard was restored with `apply_patch` and
the tracked source is clean.

Focused controls completed with `74` tests, `74` pass, `0` fail, and `0`
skipped. The full local unit command completed with `1,984` tests, `1,975`
pass, `0` fail, and `9` skipped (exit 0). `npm run parity:check` passed with
the tracker at 63/79 verified. The strict production gate also passed: 43
cases, 0 differences, 0 invariants, and 0 coverage gaps; its comparison
artifact was
`.parity/runs/ci-production-88f94944-76a5-4308-921c-affa6b368d81/comparison.json`,
SHA-256 `770b732908fc2a65d94c42f06197a14ef4c1054898d0f1ad04744e9fc30291c3`.

The broader S-07 challenge list is intentionally still outside this receipt:
350 valid library MIMs are absent from the production manifest (including 272
`OI_LM`/`RI_LM` cases), all 34 semi-specific stems/categories with ambiguous
entities, exact fun-and-games RNG branches, all 54 emotion MIMs/states, and
parser/host loop-context continuation. These require direct source/runtime
controls rather than inference from the manifest aggregate. Identity, age,
gender, date, location, promptData shape, and malformed-input boundaries also
remain explicit follow-up slices.

The source shape audit also found that Phoenix carries parser `entities` and
`intent` alongside `dice` and `coin` in its internal promptData object, while
Pegasus `addPromptData()` creates only the latter two. A scan of all 4,424
pinned Chitchat MIMs found no template or condition reference to those extra
fields, and the focused MIM/ESML/JCP/analytics outputs are unchanged. This is
therefore recorded as an unobservable internal divergence; no code repair or
shape-only test was committed under the consumer-facing acceptance boundary.

## Acceptance boundary

The asset identity, source direct controls, valid/fallback prompt-data side
effect split, and fun-and-games constructors are VERIFIED by the source and
focused Phoenix tests. The broader MIM dispatch, JCP shape, analytics, and
known/identified/historical context rows are INFERRED from the prior diagnostic
matrix because the current-head full capture was stopped before comparison. The
source-shaped interpretation of the conditional prompt residual is INFERRED
from the pinned Slimmer implementation and matching MIM condition.

S-07 remains open. UNKNOWN items are explicit Chitchat multi-turn behavior,
the unobservable promptData shape until a consumer reads the extra fields,
malformed input that omits NLU before the memo check, exact deterministic
conditional prompt IDs, and any live-provider or deployment behavior outside
the frozen fixture. The next bounded slice should add a direct source/runtime
multi-turn control (or record a written acceptance decision that announcement-
only Chitchat is sufficient) and settle whether conditional prompt identity is
required for exact comparison.
