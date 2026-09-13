# Phoenix S-07 Chitchat routing closure

Status: **open / verification UNKNOWN**. The scoped source/candidate
differential at candidate revision `1b9b7fdbf72462b65caf538e206625a11ec8b130`
is clean for every planned routing and normalization control. S-07
is intentionally not marked verified because the seven malformed internal
request cases below retain known source-versus-candidate precedence differences.

The run uses the pinned Pegasus source revision
`5c0a7390539663ba749d360de348a428c088505c`, Node `v8.9.4`, and image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The candidate is Phoenix revision
`1b9b7fdbf72462b65caf538e206625a11ec8b130` under Node `v22.22.0`. This commit
only adds parity scripts and compact evidence; it does not change production
Chitchat implementation files. The launch
matrix is split into 19 deterministic batches of at most 256 rows, retaining
all 4,808 planned IDs on both sides.

The matrix covers 4,369 scripted MIMs, all 54 emotion MIMs through four memo
families (216 rows), the fallback MIM, the retained 46 boundary controls, six
accepted memo types plus the unknown-family control, all 151 semispecific MIMs,
all 66 category CSVs including 15 unreachable-category sentinels, and the
three source/native normalization collisions. Direct MIM rows use the pinned
MIM's observed Entry-Core `mim_id` set, preserving source-authored aliases such
as `JBO_AreThereOthersLikeYou` emitting `CCAreThereOthersLikeYou`.

This is the complete source-MIM memo-routing inventory. The broader utterance
and parser corpus remains owned by N-08; S-07 carries only the three collision
inputs at this parser/normalization boundary so their normalized launch
entities can be paired with the routing rows here.

The aggregate found 4,801 semantic and exact matches, with exactly the seven
declared malformed differences. The source and candidate inventories agree on
scripted (4,369), emotion (54), fallback (1), semispecific MIM (151), stem
(34), and category (66) counts and hashes. Every source receipt reports the
pinned revision, runtime, image, and equivalent inventory tables; candidate
revision and runtime are consistent across all batches. The receipt records
the row-ID digest `d2b3ba54c18089626c4b6200ef8967761e1fbba9f8e7f4e977f4f8c119be0d86`,
batch digest `702db977fa9a76f366d12166b48255b039758675bc6bc70671132ca7748f317c`,
and observed-MIM route digest
`39364874da75b33e7a84391bb269d25e5ccdc8b29055b2913f7c6ab216b538f5`.
It also records and checks the actual source/candidate boundary-runner file
digests, rather than trusting receipt-provided hash vectors.

The semispecific lane treats the three source rows whose category CSV has no
usable value as `CC_Fallback`. It also records Zodiac as a successful
`Reactive → SemiSpecificResponse → Success → Done` zero-eligible-prompt
baseline in the pinned context; its direct-MIM and weighted lanes still cover
the eligible prompt selection. Promptless direct scripted/emotion rows are
accepted only with the expected transition and successful query analytics.

## Known malformed precedence differences

| ID | Pinned source outcome | Candidate outcome |
| --- | --- | --- |
| `malformed-result-omitted` | `Cannot read property 'nlu' of undefined` | `Chitchat launched without required memo!` |
| `malformed-result-null` | `Cannot read property 'nlu' of null` | `Chitchat launched without required memo!` |
| `malformed-result-empty` | `Cannot read property 'intent' of undefined` | `Chitchat launched without required memo!` |
| `malformed-nlu-omitted` | `Cannot read property 'intent' of undefined` | `RA_JBO_FlipCoin_AN_05` |
| `malformed-nlu-null` | `Cannot read property 'intent' of null` | `RA_JBO_FlipCoin_AN_05` |
| `malformed-semi-entities-omitted` | `Cannot convert undefined or null to object` | `CC_GQA_Failure_scripted_AN_12` |
| `malformed-semi-entities-null` | `Cannot convert undefined or null to object` | `CC_GQA_Failure_scripted_AN_12` |

## Fail-closed falsification

`falsify.mjs` starts from a fresh copy for each mutation and runs the aggregate
against the paired receipts. All eight controls were rejected: paired
plan/spec/source/candidate omission, candidate row-ID mutation, candidate
routing/MIM mutation, candidate result/ESML mutation, candidate error mutation,
paired candidate revision/runtime metadata mutation, normalization provenance
mutation, and pinned source-runtime metadata mutation. The compact outcomes are in
`falsification.json`.

The three normalization collision rows are exact against the pinned parser
capture (including normalized intent, entities, union handle, and MIM). The
normalization spec, capture SHA/revision/runtime, candidate revision/runtime,
and differential mode are all pinned and independently checked; see
`normalization-differential.json`. Raw batch captures remain in the temporary
run directory and are not part of this evidence.

Validation commands:

Run these from the pinned candidate checkout (`1b9b7fd`) so the normalization
runner's git-HEAD provenance remains the recorded candidate revision.

```sh
for f in scripts/parity-s07-routing-closure/*.mjs; do node --check "$f"; done
node scripts/parity-s07-routing-closure/run-all.mjs --dir /tmp/s07-routing-final-20260913-1
node scripts/parity-s07-routing-closure/falsify.mjs /tmp/s07-routing-final-20260913-1
node --test packages/nlu/test/s07ChitchatEntityNormalization.test.js
```
