# S-07 contextual source/runtime differential

Review date: 2026-09-13
Branch: `w20/s07-context`
Worktree: `/home/shell/work/phoenix-s07-context`
Base: `4bcdfba`
Pinned source: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`

**Recommendation: UNKNOWN — keep S-07 open.** This lane found no
client-observable Phoenix divergence in the identity, loop, PromptData,
DateTime, location, or contextual MIM branches it exercised. It therefore
commits evidence only; no Phoenix code repair is justified. The complete S-07
acceptance still requires the broader source/runtime comparison of every
Chitchat intent, MIM/ESML/JCP/analytics result, fun-and-games path,
fallback/deflection path, and any accepted multi-turn contract.

## Source provenance

The first source operation was Jibo MCP `jibo_search` with the query
`Pegasus Chitchat LoopMemberDetector birthday age gender zodiac date isInRange context`
against `gitea-repos,gitea-issues,repository` (limit 50). It returned zero
hits. Gitea source reads followed at the pinned revision above. No web source,
ledger, remote, deployment, Moth, or hardware operation was used.

The source files directly read were:

- `packages/baseskill/src/graph/mims/utils/slimmer/PromptData.ts` (86-115,
  166-203), `LooperData.ts` (21-27, 54-77), `NLData.ts`, and `Utils.ts`
  (10-24, 30-62).
- `packages/baseskill/src/graph/mims/utils/slimmer/Slimmer.ts` (63-83,
  93-112, 119-200).
- `packages/parser/src/utils/LoopMemberDetector.ts` (29-91) and
  `packages/parser/src/handlers/ParseRequestHandler.ts` (25-37, 41-119).
- `packages/baseskill/src/graph/nodes/SetLooperIDNode.ts` (24-59) and
  `packages/baseskill/src/GraphSkill.ts` (70-85, 100-130, 161-172).
- `packages/chitchat-skill/src/Chitchat.ts` (56-91),
  `nodes/ProcessQueryNode.ts` (31-155), and `nodes/IntentSplitNode.ts`
  (19-33).
- `packages/hub/src/skill/SkillRequestHelper.ts` (90-102) and
  `packages/hub/tests/skill/SkillRequestMaker/InjectDialogContext.test.js`
  (36-70).
- `packages/chitchat-skill/tests/Chitchat.test.js` (89-135), including the
  direct scripted, semi-specific, and missing-memo controls.

The Phoenix asset fixture records byte identity for the Chitchat library:
4,424 MIMs plus 66 category CSVs, aggregate SHA-256
`47ab0d7b250ea5439801da1026263e0c4889155c23c4f01651450436ac5b45f3`.
`node --test packages/skills/test/assetProvenance.test.js` passed all 6 tests,
including source digest, parse/load, CSV, and real HTTP-host reachability.
Every one of the 4,424 Chitchat MIMs is `mim_type: "announcement"`.

## Behavior matrix

| Surface | Pinned source behavior | Phoenix evidence | Result |
| --- | --- | --- | --- |
| Speaker/referent present, absent, empty, and unknown | `PromptData.addLoopData()` resolves `perception.speaker` and `dialog.referent` independently by exact user ID; missing/unknown values remain null. | 100-row PromptData matrix, including `perception-*` and `dialog-*` cases, source/candidate deep comparison. | **VERIFIED**: 100 rows, 0 diffs. |
| Owner/list/count and thresholds | Users are appended in order; owner is the last matching duplicate; `loop.list` uses `makePronounceable`; `loop.count` is the user array length. Source MIMs use `loop.count > 1`, `== 1`, `!!loop.list`, and `!!loop.owner`. | `loop-empty-users`, one/two/five-user, missing-owner, duplicate-ID, and pronounceable-name cases; 35 selected MIM renders. | **VERIFIED**: source/candidate fields and selected ESML exact. |
| Known/unknown loop members | `LoopMemberDetector` uses, in order: given+last entities, given entity, full-name text, then first-name text only when a given-name key was expected; all matches are case-insensitive and array-first. | `node --test packages/nlu/test/loopMemberDetector.test.js` (31/31), including aliases, precedence, ambiguity, punctuation, missing fields, and guards. | **VERIFIED** for the source detector contract. |
| Parser result and host injection | The parser trims text, returns `EMPTY_NLU` for empty input, selects valid parser/Dialogflow output, then calls the detector. The hub copies a nonempty `loopMemberReferent` into `runtime.dialog.referent`; it does not alter `perception.speaker`. | `identityIntroGreetings` (8/8), N-06 real WebSocket/parser/skill-host test (2/2), and source helper test read above. | **VERIFIED** for the bounded parser/host path. |
| Host continuation | Source `LISTEN_UPDATE` carries the opaque session and omits launch memo; source helper preserves the same runtime context and injects a referent when present. | `listen.skillHandoff` (7/7) and `listenTransaction.lifecycle` (2/2). | **VERIFIED** for generic host continuation; Chitchat-specific continuation is structurally absent as described below. |
| Birthday/non-birthday and age | `LooperData`/`JiboData` normalize birthdate, expose birthday/isBirthday, all `NLAge` units, and use the source zodiac helper. | 100 contexts plus the 15-row birthdate probe (numeric, null/empty/boolean, date-only, offset, invalid, leap, and numeric-string inputs). | **VERIFIED**: 15 rows, 0 diffs; three additional explicit offset contexts also 0 diffs. |
| Gender and zodiac | Gender is copied unchanged; `USR_WhoIsLoopMember.mim` branches on referent gender/age; zodiac is rendered from the source `NLZodiac` value. | Matrix includes male/female/partial values, age boundaries, zodiac boundaries, and `USR_WhoIsLoopMember` in the selected render set. | **VERIFIED** for PromptData and selected MIM branch eligibility. |
| Jibo color | `JBO_WhatColorAreYou.mim` selects WHITE, BLACK, or fallback according to `jibo.color`; absent/null Jibo reaches fallback. | Source/candidate selected MIM renders include WHITE, absent, and null Jibo; asset digest is exact. | **VERIFIED** for these client-visible branches. |
| Location city and regions | Source `Location` preserves fields and source error behavior; `USR_WhatIsCurrentLocation.mim` guards on `!!location.city`. | 100 contexts include Boston, Canada, Japan, Mexico, UK, partial/no-city, case, numeric, null-string, and region-method cases; S-05 source vectors passed. | **VERIFIED**: source/candidate deep comparison is exact. |
| Date and year wrap | Source `DateTime.isInRange` accepts the source `M/D` pairs, including wrapped intervals; PromptData uses the runtime location offset for `dt.now`. | The source manifest contains 358 date condition occurrences and 43 unique dates. For every date, every one of 852 distinct pairs was compared: 36,636 bits, 0 diffs. The broader S-05 matrix compares 1,847 boundary dates × 852 pairs = 1,573,644 bits, plus leap/century/DST/quarter-hour/year-wrap cases. | **VERIFIED** for the pinned date surface. |
| Distinct `dt.now.isInRange` intervals | Date conditions appear in 2,841 conditioned prompts across 923 MIMs; 961 unique condition strings contain `dt.now.isInRange`. The extracted production pair corpus has 852 distinct argument pairs. | Source/candidate DateTime output: `seasonDates` 1,847, `ranges` 1,847 rows, `dt` 264, `periods` 297, `phrasing` 16,623; all sections deep-equal. | **VERIFIED** for DateTime/condition eligibility. |

The 43 unique source-manifest dates were:

```text
2018-01-01 2018-01-02 2018-02-01 2018-03-01 2018-04-01 2018-04-10
2018-09-01 2018-10-01 2018-10-03 2018-10-05 2018-10-10 2018-10-15
2018-10-16 2018-10-20 2018-10-26 2018-10-27 2018-10-28 2018-10-30
2018-10-31 2018-11-01 2018-11-02 2018-11-05 2018-11-15 2018-11-17
2018-11-18 2018-11-20 2018-11-23 2018-11-24 2018-11-25 2018-11-26
2018-11-28 2018-12-01 2018-12-02 2018-12-10 2018-12-12 2018-12-15
2018-12-19 2018-12-20 2018-12-21 2018-12-24 2018-12-25 2018-12-26
2018-12-31
```

## Contextual MIM differential

The source and Phoenix MIM trees are byte-identical. A source/candidate
condition probe evaluated all 1,070 distinct condition expressions from the
4,424 MIMs over the 100 tracked runtime contexts: 107,000 evaluations, with
zero non-random differences. The only 37 raw differences were the one source
condition `Math.random()<.2`, evaluated in separate VM RNG streams; these are
the expected conditional-prompt selection variation already recorded by the
S-07 runtime lane.

A second probe called the source compiled `Slimmer.generateSlim` and Phoenix's
`generateSlimFromMim` for 14 contextual MIMs and 35 rows, with both weighted
samplers fixed at `Math.random() = 0`. It compared prompt ID, rendered ESML,
and listen presence. The result was 35 rows, 0 differences, and `listen=false`
for every row. The MIMs covered loop count/list/owner, Jibo age/birthday,
color, user age/gender, location city, and New Year date branches.

The source `Chitchat.createGraph()` routes all Chitchat response transitions
through `ANFactory` with `final: true`. `Slimmer.generateListen()` creates a
listen action only for `question` or `optional-response` MIM types, while all
4,424 Chitchat MIMs are announcements. The source Chitchat tests launch each
MIM and contain no update/answer turn. Therefore the exact source conclusion is:

> Announcement-only Chitchat has no skill-owned multi-turn obligation. A
> Chitchat response finishes its skill graph after the announcement; a
> `LISTEN_UPDATE` can only be supplied by a host/global flow or another skill
> whose MIM explicitly asks a question.

This does not claim that the whole Phoenix host or every other skill has no
multi-turn behavior; the generic host continuation controls above cover the
bounded session/injection contract.

## Commands and receipts

All commands below ran in this worktree with the source root
`/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`:

```text
S05_SOURCE_ROOT=$SRC node packages/skills/tools/s05-context-matrix-source.cjs \
  packages/skills/test/fixtures/s05-prompt-contexts.json /tmp/s07-context-source.json
S05_CANDIDATE_ROOT=$PWD node packages/skills/tools/s05-context-matrix-candidate.mjs \
  packages/skills/test/fixtures/s05-prompt-contexts.json /tmp/s07-context-candidate.json
# 100 source rows / 100 candidate rows / 0 diffs

S05_SOURCE_ROOT=$SRC node packages/skills/tools/s05-datetime-matrix-source.cjs \
  packages/skills/test/fixtures/s05-datetime-matrix.json /tmp/s07-datetime-source.json
S05_CANDIDATE_ROOT=$PWD node packages/skills/tools/s05-datetime-matrix-candidate.mjs \
  packages/skills/test/fixtures/s05-datetime-matrix.json /tmp/s07-datetime-candidate.json
# seasonDates=1847, ranges=1847, dt=264, periods=297, phrasing=16623; 0 diffs

node --test packages/skills/test/s05PromptData.test.js \
  packages/skills/test/s05PromptData.source-vectors.test.js \
  packages/skills/test/s05DateTime.source-vectors.test.js \
  packages/nlu/test/loopMemberDetector.test.js \
  packages/nlu/test/identityIntroGreetings.test.js \
  packages/gateway/test/n06SpeakerReferent.test.js
# tests 64; pass 64; fail 0; skipped 0

node --test packages/skills/test/assetProvenance.test.js
# tests 6; pass 6; fail 0; skipped 0

node --test packages/skills/test/intentResponses.test.js \
  packages/skills/test/promptFallbackSource.test.js \
  packages/skills/test/s04MimContracts.test.js \
  packages/skills/test/s03MimFactories.test.js \
  packages/skills/test/mimGraph.test.js
# tests 74; pass 74; fail 0; skipped 0

node --test packages/gateway/test/listen.skillHandoff.test.js \
  packages/gateway/test/listenTransaction.lifecycle.test.js
# tests 9; pass 9; fail 0; skipped 0

npm run test:unit
# tests 1990; pass 1981; fail 0; skipped 9; exit 0
```

The deep-equal context receipt SHA is
`d6ecf9dded415417d1629f4fc6b8d14414f5f1c34c5a3f163a3edffd09d5e5ae` for both
outputs. The DateTime receipt SHA is
`05795db73980081f62224fc98597984c2303bfd0be880c286b9a31d7bdc5702f` for both
outputs. The 15-row birthdate receipt SHA is
`472ad3bbf716818c830f4ada59ba97dcfa260e78ac58689f8b37933f3aefe782` for both
outputs.

## Falsification and limits

The suspected contextual gaps were falsified by independent source/candidate
outputs rather than by assuming equivalent implementation. In particular,
host-offset birthdate strings, malformed birthdates, empty/unknown IDs,
duplicate users, no-city locations, all date boundaries, and every non-random
MIM condition produced the same observable values. The fixed-RNG MIM probe also
produced the same prompt ID and ESML. Because no source-backed observable gap
was found, there was no code patch to break and restore; no source-shaped repair
was committed.

The following remain open for S-07:

- Complete source/runtime coverage of all intent/entity/memo branches and all
  semi-specific categories, including the 117 manifest MIM residuals already
  classified by the prior S-07 lane.
- A full direct source/candidate comparison of every Chitchat MIM's ESML, JCP,
  analytics, fun-and-games RNG sequence, emotion state, fallback/deflection,
  and production manifest occurrence. The 35-row contextual render is a
  bounded slice, not the complete criterion.
- Any live-provider, deployment, hardware, or unhosted-cloud behavior outside
  the frozen source and local runtime controls.

S-07 therefore remains open and this branch contains evidence only.
