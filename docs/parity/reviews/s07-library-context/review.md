# S-07 Chitchat library/context review

## Scope and provenance

- Worktree: `/home/shell/work/phoenix-s07-library`
- Branch: `w20/s07-library`
- Base: `4993508ca610a11faeb491d8ebbbce1b07700e58`
- Pinned source: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
- No root checkout, ledger, remotes, deployment, or Moth state was changed.

Jibo MCP search was used before source reads. `jibo_search` found the pinned
`jiboV2/pegasus` repository and the Chitchat package; the source reads used the
local archive of that exact revision after the MCP result identified the repo.
The relevant source files are:

- `packages/chitchat-skill/src/Chitchat.ts`: initialization and MIM/category
  maps (lines 44-53), stem construction (98-123), and CSV mapping (129-149).
- `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts`: semispecific entity
  resolution and source intent/fallback routing (lines 31-143).
- `packages/chitchat-skill/src/utils/Utils.ts`: `Math.floor(Math.random() *
  arr.length)` sampling (lines 1-7).
- `node_modules/jibo-cai-utils/lib/jibo-cai-utils.js`: concurrent file
  discovery and completion-order appends (lines 795-827), with
  `node_modules/async-parallel/index.js` invoking concurrent jobs (76-85).

The plan is source-derived and records complete manifest rows, duplicate row
IDs, all source MIM IDs, all CSV values, and source tree digests. The source
tree inventory is 4,369 scripted MIMs, 54 emotion MIMs, one fallback MIM, 151
semispecific MIMs across 34 stems, and 66 CSV files. The pinned manifest has
4,705 rows and 4,077 distinct MIM values; 350 source MIM IDs are absent from
that manifest. Fifty-three CSV categories are reachable through a source stem;
15 remain inventory-only because no source stem references them.

Source tree SHA-256 digests in the generated plan are:

```
scripted   4d32edf99802ac9651e6351ae451c419968d469dc8daf0ced5822ede7d10663d
emotion    009481eb40e34906695b717cdd04d61a08e6842e819c522169a6ca644e424bfd
fallback   49b44bd6d537e49401d198c568887caa2fcf7bf9ea973472419c9be479bfeb5e
categories f5ae94d04fffa7f7cb8dbacbf475ace46a770a2953edfbbcb361e51d0f985b4e
manifest   ea70a399299e0d5cc3c654268b407a5bdc61cfa0602ce3f8d8db34dc8a177ccd
```

## Matrix and commands

The plan contains 24,148 cases, preserving every planned row ID:

| Family | Rows | Source errors | Candidate errors |
| --- | ---: | ---: | ---: |
| Missing scripted MIMs | 1,813 | 0 | 0 |
| Emotion MIMs and memo types | 3,196 | 0 | 0 |
| Semispecific concrete CSV values | 18,833 | 0 | 0 |
| Semispecific ambiguous entity/order cases | 300 | 0 | 0 |
| Fallback and wrong-family controls | 6 | 0 | 0 |
| **Total** | **24,148** | **0** | **0** |

The reproducible commands were:

```sh
node scripts/parity-s07/library-plan.mjs \
  --source-root /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c \
  --source-revision 5c0a7390539663ba749d360de348a428c088505c \
  --out /tmp/s07-library-plan.json

docker run --rm --network none \
  --mount type=bind,source=/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c,target=/ref,readonly \
  --mount type=bind,source=/home/shell/work/phoenix-s07-library,target=/work,readonly \
  --mount type=bind,source=/tmp/s07-library-plan.json,target=/plan.json,readonly \
  --mount type=bind,source=/tmp,target=/out \
  -e NODE_PATH=/ref/node_modules -e TZ=UTC -w /ref/packages/chitchat-skill \
  node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /work/scripts/parity-s07/run-source-library.cjs /plan.json /out/s07-source-library.json

/usr/bin/time -f 'elapsed=%E maxrss=%MKB' \
  node scripts/parity-s07/run-candidate-library.mjs \
  /tmp/s07-library-plan.json /tmp/s07-candidate-library.json

node scripts/parity-s07/compare-library.mjs \
  /tmp/s07-library-plan.json /tmp/s07-source-library.json \
  /tmp/s07-candidate-library.json /tmp/s07-library-differential-order-audit.json

node scripts/parity-s07/falsify-library-comparator.mjs \
  /tmp/s07-library-plan.json /tmp/s07-source-library.json \
  /tmp/s07-candidate-library.json /tmp/s07-library-falsification-order-audit.json
```

The source receipt reports Node `v8.9.4`; the candidate receipt reports Node
`v22.22.0`. The candidate run took `0:17.50`, with a recorded maximum RSS of
1,290,844 KB. The source invocation completed and wrote all 24,148 rows; its
elapsed value was not captured by the original shell wrapper, so no source
wall-time claim is made here.

The tightened comparator passed with 24,148 source rows, 24,148 candidate rows,
zero failures, and zero row-level observable differences. It compares the complete
normalized action, JCP type, slim metadata, MIM IDs, prompt IDs, ESML, and
analytics. Only the two source-proven generated action ID paths are removed:
`config.jcp.id` and `config.jcp.config.play.id`; every other `id` remains
observable and is checked.

The compact durable receipts are [differential-summary.json](./differential-summary.json),
[falsification-summary.json](./falsification-summary.json), and
[raw-receipt-manifest.json](./raw-receipt-manifest.json). The manifest records
the byte sizes and SHA-256 hashes of the raw plan, source, candidate,
differential, and falsification receipts that remain outside Git.

For 613 rows whose source-defined matching category set had more than one
member, source and candidate selected the same category for every seeded row:

| Stem | Rows | Invalid selections | Output differences |
| --- | ---: | ---: | ---: |
| `OI_USR_Likes_SS` | 73 | 0 | 0 |
| `OI_USR_TravelsTo_SS` | 4 | 0 | 0 |
| `RI_JBO_HasOpinionAbout_SS` | 76 | 0 | 0 |
| `RI_JBO_Likes_SS` | 416 | 0 | 0 |
| `RI_JBO_Wants_SS` | 44 | 0 | 0 |
| **Total** | **613** | **0** | **0** |

The bounded four-row source HTTP/service probe and the direct GraphSkill probe
were byte-equivalent after the same normalization (`4/4` rows, zero errors).

## Mapping order and source nondeterminism

The raw mapping receipts have identical sets. Four order-only differences are
recorded. The comparator does not waive a whole stem array: for every stem it
builds the distinct source CSV values represented in the plan, filters both raw
orders to the categories matching each value, and requires those per-value
matching sequences to be identical. It also enumerates every crossed category
pair. The seven crossed pairs below all have an empty source-value
intersection, so their order cannot affect `possibleCategories` for any
entity value:

- `RI_JBO_HasOpinionAbout_SS`: `Fruit` / `FoodGeneral`;
- `RI_JBO_Is_SS`: `Zodiac` / `Sealife`;
- `RI_JBO_Likes_SS`: `Drink` / `Dinosaur`, `HairType` / `Fruit`,
  `ScaryCreature` / `RoomInHouse`, `SchoolSubject` / `RoomInHouse`, and
  `Seafood` / `RoomInHouse`;
- the 66-name category CSV order.

This is not a Phoenix production behavior change. The pinned source calls
`FileUtils.findAllFilesWithExt`; its implementation starts up to 50 `fs.open`
and `fstat` jobs and appends each path when its stat completes. The source then
iterates that resulting `Set` to build stem arrays. The candidate preserves the
same sets and records its synchronous directory order. The comparator therefore
requires equal mapping sets, exact per-value matching order, and exact row
outputs. It allows only the seven proven disjoint crossings and the lookup-only
CSV name order; it has no generic order waiver. A second clean source
initializer was not completed:
duplicate mapping-only probes were stopped after their resource cost became
apparent. The receipt contains one completed source order, and the source
implementation makes that order an unspecified completion-order detail. No
production order fix is justified by the current exact seeded outputs; a
future stability worker may sample the source order separately.

## Named falsification

`falsify-library-comparator.mjs` ran against the full receipts. All six checks
passed by requiring a nonzero comparator result:

1. forged prompt ID: rejected as an observable difference;
2. forged MIM ID: rejected as an observable difference;
3. forged ESML: rejected as an observable difference;
4. forged JCP action type: rejected as an observable difference;
5. omitting the same row from both receipts: rejected by inventory checks.
6. swapping overlapping `Religion`/`ReligionPerson` stem categories:
   rejected as `semispecific-matched-order-difference`.

## Repository checks

- Focused Chitchat tests: `21/21` pass in `0.74s`.
- Full `npm test`: `1,980` pass, `9` skip, `1` transient failure. The failure
  was `authenticatedNotificationIntegration.test.js`,
  `account-a message timeout after 1500ms`, as an unhandled rejection. A
  targeted rerun of that exact file passed `1/1` in `0.64s`; no S-07 code was
  changed in response.
- `npm run parity:check`: pass; tracker structure and generated checklist are
  valid (`64/79` verified at this checkpoint).
- `npm run parity:gate`: pass; final strict production smoke `43/43`, zero
  differences, zero invariants, zero coverage gaps, elapsed `0:57.52`.

## Criterion audit

The source-derived inventory, all 350 absent-manifest IDs, 54 emotion MIMs,
all 34 semispecific stems, all 66 category CSV inventories, 613 overlapping
value rows, context profiles, fallback controls, row identity, and normalized
client-visible action fields are covered by the passing matrix. Missing/extra
rows, duplicate IDs, missing MIMs, category-set differences, invalid selected
categories, prompt/MIM/ESML/action mutations, and paired omissions fail closed.

The remaining task-level limitation is prompt coverage: this lane does not
enumerate every weighted prompt branch in every source MIM; it exercises one
fixed seeded stream per planned row and all requested context dimensions.
S-07 therefore remains open for the broader weighted-prompt closure. Fifteen
CSV categories are also unreachable through any source stem and are
inventory-checked rather than pretended to have a resolver path. No Phoenix
production code repair is needed from this audit. The isolated branch
currently contains only the reproducible S-07 harness and this review
artifact.
