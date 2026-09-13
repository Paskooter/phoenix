# S-07 semi-specific order audit

This is an evidence-only audit from Phoenix implementation base `af44596494bfea55637bf56b2a09547a3bbecf68`; it contains no production change. The pinned Pegasus source is `5c0a7390539663ba749d360de348a428c088505c`, executed as Node `v8.9.4` from image digest `sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`. The candidate receipt was regenerated after the evidence runner commit `f3a4e44d2870a841ae78d9b067d74b25fdb2208c` and records that revision separately.

The source runner performed 50 sequential clean Node 8 child-process initializations. The receipt also carries 12 selected-order witnesses from a second clean source batch because three rare completion-order inversions did not recur in the 50-run batch. The auxiliary runs are used only for stem-order/inversion coverage; one primary run retains the complete per-value source lists and resolver checks. Source inventory counts were stable in every run: 4,369 scripted MIMs, 54 emotion MIMs, 1 fallback MIM, and 66 category CSVs.

The source contract is visible at `packages/chitchat-skill/src/Chitchat.ts:44-54,98-149` and `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts:121-143`. `Chitchat.init()` obtains MIM and CSV paths through `FileUtils.findAllFilesWithExt`; `generateSemiSpecificStemMapping()` appends categories in the returned MIM order; `resolveSemiSpecificMim()` iterates `Object.keys(entities)`, filters each stem's category list, concatenates those lists, and samples one index. The pinned `FileUtils` implementation opens/stat/closes up to 50 paths concurrently and appends on completion (`node_modules/jibo-cai-utils/lib/jibo-cai-utils.js:795-832`), so the source order is not a portable lexical contract. Source sampling is uniform by index (`packages/chitchat-skill/lib/utils/Utils.js:7-9`). Phoenix uses the same resolver sequence and uniform index choice at `packages/skills/src/chitchatSkill.js:211-222`; its library inventory is built at `packages/skills/src/chitchat/library.js:24-70`.

The seven reported stem-order inversions were each reproduced against the candidate order. Their category CSV intersections are all empty, so they cannot change any per-value match list:

| Stem | Pair | Candidate order | Source orders observed | Source/candidate inversions | CSV intersection |
| --- | --- | --- | --- | ---: | --- |
| `RI_JBO_HasOpinionAbout_SS` | `Fruit / FoodGeneral` | `FoodGeneral<Fruit` | both | 5 | empty |
| `RI_JBO_Is_SS` | `Zodiac / Sealife` | `Sealife<Zodiac` | both | 8 | empty |
| `RI_JBO_Likes_SS` | `Drink / Dinosaur` | `Dinosaur<Drink` | both | 7 | empty |
| `RI_JBO_Likes_SS` | `HairType / Fruit` | `Fruit<HairType` | both | 9 | empty |
| `RI_JBO_Likes_SS` | `ScaryCreature / RoomInHouse` | `RoomInHouse<ScaryCreature` | both | 5 | empty (`ScaryCreature` has no CSV values; left count 0) |
| `RI_JBO_Likes_SS` | `SchoolSubject / RoomInHouse` | `RoomInHouse<SchoolSubject` | both | 1 | empty |
| `RI_JBO_Likes_SS` | `Seafood / RoomInHouse` | `RoomInHouse<Seafood` | both | 1 | empty |

The full source/candidate per-value audit covers 8,186 distinct `(stem, entity value)` rows: 2,387 for `HasOpinionAbout`, 1,004 for `Is`, and 4,795 for `Likes`. Source and candidate have equal category membership multisets for every row, with zero mismatches. The source resolver's endpoint checks over all 8,186 rows and the candidate resolver's corresponding checks both report zero mismatches. The source has 17 overlapping values in `HasOpinionAbout`, none in `Is`, and 103 in `Likes`; this is the relevant overlap population, separate from the seven disjoint pair inversions.

Real overlap probes include `Ginger` (`HerbAndSpice/Vegetable`), five shared religion values (`Religion/ReligionPerson`), `Australia` (`Continent/Country`), and `Coke` (`Drink/Drug`). For every probe, deterministic RNG values `0` and `0.999999999` select the first and last possible category respectively, and the selected MIM IDs plus MIM SHA-256 values are recorded. Source clean runs observed both orders for the religion values, Australia, and Coke; the focused mutation witness also swaps Ginger. The source and candidate multi-entity probes concatenate each entity's matching list in `Object.keys(entities)` order, and both reverse-key-order probes pass that check.

The mutation falsification swaps overlapping categories and requires the selected MIM endpoint to change for all four overlap probes (`4/4`). It swaps each of the seven disjoint pair families over 13 exclusive-value probes and requires the selected MIM to remain unchanged (`13/13`). A second falsification removes one category from an 8,186-row candidate list and corrupts one multi-entity sequence; the analyzer rejects both mutations with nonzero status.

Because `sample()` is uniform by index, preserving each per-value category multiset preserves the reachable MIM set and category probabilities. The raw stem arrays are nevertheless nondeterministic across clean source startups, and a fixed injected RNG can select a different category identity when an overlapping list is permuted. This audit therefore recommends no production ordering repair: the seven named failures are inventory-only, while the broader source order is an asynchronous initialization property whose observable distribution remains equivalent. S-07 remains open for the other acceptance dimensions (intent/entity/memo branches, fun-and-games transformations, fallback/deflection, identity/emotion/birthday/seasonal/multiturn runtime parity, and client-facing ESML/JCP/analytics coverage).

Focused validation:

```text
node scripts/parity-s07-order/analyze-order.mjs \
  docs/parity/evidence/2026-09-13/s07-order/source-runtime.json \
  docs/parity/evidence/2026-09-13/s07-order/candidate-runtime.json \
  docs/parity/evidence/2026-09-13/s07-order/order-receipt.json
=> result=pass, sourceRuns=50, listedPairs=7,
   perValue=2387+1004+4795, overlapMutations=4/4,
   exclusiveMutations=13/13

node scripts/parity-s07-order/falsify-order.mjs \
  docs/parity/evidence/2026-09-13/s07-order/source-runtime.json \
  docs/parity/evidence/2026-09-13/s07-order/candidate-runtime.json
=> removed-overlap-category... rejected status=1
   multi-entity-order-corruption rejected status=1
   result=pass, cases=2
```

Repository checks: `npm run parity:check` passed (64/79 verified; S-07 remains the next open task), and `npm run parity:gate` passed its 43-case strict production smoke gate. The full `npm test` run reached 1,990 tests with 1,980 passing and 9 skipped; one unrelated environment-sensitive test failed at `packages/account/test/accountAccessTokens.test.js:201` with `fetch failed`, so the overall command exited 1 before the parity scripts. No source or Phoenix production file was changed by this audit.

The JSON receipt is compacted from the source run to retain one complete 8,186-row source mapping plus all clean-startup selected-order/probe rows. The primary raw source output SHA-256 is recorded in `source-runtime.json.rawReceiptSha256`.
