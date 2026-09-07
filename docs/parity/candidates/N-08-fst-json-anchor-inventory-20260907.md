# N-08 inventory-reconciled trusted anchor for portable compiled-FST data

Status: candidate unverified; pending root review. This is a bounded metadata
and provenance follow-up for the explicit `compiled-fst` snapshot profile. It
does not change the default AST profile, compiled-FST graph execution, or the
private snapshot payloads.

This candidate imports the portable JSON and gzip loader/exporter work from
`c24d42b`, `39452de`, and `b61c12e`, then reconciles it with the approved rule
inventory in base `9304139`. The shipped approval manifest is
`packages/nlu/resources/compiled-fst-approval.json`; the runtime exports
`APPROVED_INVENTORY_SHA256` from that manifest, while
`COMPILED_FST_PROFILE.approvedInventorySha256` must agree with it. The
always-run runtime guard hashes the shipped `rule-inventory.json` and fails
when that value drifts. The production comparison runner reads the same small
approval file, so configured verification and runtime cannot silently use
different inventory approvals.

The approved inventory is now:

```text
7dddc9854981f388480fed90f4714b51f22fe69d5174964e18bb4584b441c4f4
```

It has 98 public rules and 13 factory dependencies. Compared with the
previous snapshot profile's inventory (`4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5`), the only inventory leaf change is
`/supporting/factory-words/first_name/sha256`, from
`c5cef118d476f5657f8eea58f1fc0303d6dd90f1adef670d237ecbb1edd7d951` to
`baffd024ff6c002de92531255def1d0125479123220c239eda76438ae9e98e69`.

The exporter was rerun from the pinned source rather than editing the anchor
by hand:

```text
node packages/nlu/tools/exportCompiledFstSnapshots.mjs \
  --inventory packages/nlu/resources/rule-inventory.json \
  --rules-dir <reference-5c0a739>/packages/parser/robust-parser \
  --factory-dir <reference-5c0a739>/packages/parser/robust-parser/build/data/en-us/factory_rules \
  --output <private-profile>/profile-gzip-anchor --gzip \
  --anchor-output packages/nlu/resources/compiled-fst-snapshot-hashes.json
```

The regenerated canonical anchor is 37,378 bytes with SHA-256
`882e4e7e3b541b7fcd9b059279b1ce8079a39c158b36ade95309f8d5c0a95520`. The
gzip profile manifest is 57,565 bytes with SHA-256
`16225da770c3efd4befe28f8f9f4c8b97d502cae86d5910a8c5355c3f6f09ab7`. It
contains 98 graph snapshots, 15 executable factory FST snapshots, and 16
factory-directory provenance entries. The private bundle is 9,978,000 bytes:

| data | decoded JSON bytes | gzip bytes |
| --- | ---: | ---: |
| 98 public graphs | 170,143,253 | 9,453,601 |
| 15 factory FSTs | 9,317,512 | 466,834 |
| profile manifest | 57,565 | 57,565 |

The private source/decoded reconciliation receipt is
`.parity/reviews/n08-fst-json-anchor-inventory-20260907/source-byte-and-decoded-hash-proof.json` (SHA-256
`7341ea05b173cec4a44a1b63201c23c71ee66ec345221b43796f3f52abae1efe`). It
compares the old and regenerated profiles against reference revision
`5c0a7390539663ba749d360de348a428c088505c` and records:

- 98/98 public graph source files byte-identical to both profile inventories;
- 98/98 decoded graph snapshot hashes and sizes unchanged;
- 15/15 factory FST source files byte-identical to both profiles;
- 15/15 decoded factory snapshot hashes and sizes unchanged;
- unchanged rule-manifest SHA-256 `363fb4a663fb2a09920a38c9ae021301670fc38c8d6fe4f9612343d3cfef60fd`;
- unchanged factory-manifest SHA-256 `4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e`.

The strict configured service comparison selected only the private gzip
profile and passed 43/43 cases with 0 differences, 0 invariants, and 0
coverage gaps. Its fresh evidence is under
`.parity/reviews/n08-fst-json-anchor-inventory-20260907/strict43-gzip-final`:

- `run.json` SHA-256 `c163e97a90d18d3acd00ebf9787cd714126dfb47fa1eea13ead4ab399461a9ac`;
- `comparison.json` SHA-256 `770b732908fc2a65d94c42f06197a14ef4c1054898d0f1ad04744e9fc30291c3`;
- `candidate.json.gz` SHA-256 `fecfd68aa54eb354ee01dbbd3971800cb8d3c79e0064ba6d6edc3d0554233cdf`;
- `reference.json.gz` SHA-256 `a9f40ba6a2acb9765750b1c9e084a6ce924d21409ffe07f4bfcf46d23b2128a7`;
- `phoenix-source.json` SHA-256 `58233f692f37b37d91aa6fc177f3cf8caae7c321f760c177b044e4cec0e96531`.

The focused configured snapshot/runtime suite passed 23 tests and skipped one
binary-only test. The full local `npm run test:unit` run passed 638 of 643
tests, skipped 5 configuration-dependent tests, and failed 0. Its preserved
log and receipt are under
`.parity/reviews/n08-fst-json-anchor-inventory-20260907/unit-full`.

The profile data and source reference remain private; no graph or factory
payloads are committed. This candidate has no full 20,528/20,534 replay,
direct native parser claim, Moth/robot trial, or source-to-binary rebuild.
Deployment still needs to provision the selected profile and all gzip files,
and any later approved inventory change must regenerate the anchor/profile
metadata from the final inventory while preserving the canonical decoded
graph/factory hashes.
