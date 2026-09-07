# N-08 gzip storage for portable compiled-FST snapshots

Status: candidate unverified; pending root review. This is a distribution
slice for the explicit `compiled-fst` profile. It does not change the default
AST profile, the binary profile, or claim full N-08 parity.

The candidate extends the existing versioned decoded-FST JSON profile with an
optional `gzip` storage mode. JSON remains the decoded content: gzip is applied
only to the stored artifact bytes. Each compressed graph and factory entry
records the decoded JSON SHA-256/byte count as well as the stored gzip
SHA-256/byte count. The profile records `format.storage: "gzip"`; a loader
rejects a profile or entry whose storage mode does not agree. At startup it
checks the stored hash and size, decompresses, checks the decoded hash and
size, parses the versioned FST document, and checks source provenance. Gzip
errors, malformed metadata, truncated data, and hash mismatches fail before
the runtime is returned.

The exporter is
`packages/nlu/tools/exportCompiledFstSnapshots.mjs`. Plain JSON remains the
default; `--gzip` selects deterministic level-9 gzip output. The runtime is
opt-in through `PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST` and cannot be combined
with binary artifact settings. The loader retains verified JSON bytes for lazy
public-rule construction, retains only the launch FST after its validation
pass, and retains decoded factory FSTs without duplicate factory JSON
documents or raw bytes.

The private export used for this candidate is:

`/home/shell/work/phoenix/.parity/reviews/n08-fst-json-gzip-20260907/profile-gzip-v2/profile.json`

It contains 98 public graph snapshots and 15 decoded factory FST snapshots;
the 16th factory-directory file (`factory_list.txt`) remains a hashed
provenance entry. The source and profile pins are unchanged from the JSON
candidate:

- source revision: `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`
- reference revision: `5c0a7390539663ba749d360de348a428c088505c`
- source runtime label: `jibo-nlu v2.8.3`
- native parser SHA-256: `373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`
- approved launch SHA-256: `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`
- inventory SHA-256: `4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5`
- rule manifest SHA-256: `363fb4a663fb2a09920a38c9ae021301670fc38c8d6fe4f9612343d3cfef60fd`
- factory manifest SHA-256: `4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e`
- gzip profile manifest SHA-256: `3b3894f51d2aef72b74d257c6ec816ec1758acb8afd14a6381b5ca7fcb0a3f25`

The exact private size receipt is derived from that manifest:

| data | decoded JSON bytes | gzip bytes |
| --- | ---: | ---: |
| 98 public graphs | 170,143,253 | 9,453,601 |
| 15 factory FSTs | 9,317,512 | 466,834 |
| profile manifest | 57,472 | 57,472 |
| total snapshot data and manifest | 179,518,237 | 9,977,907 |

The compressed snapshot data and manifest are 5.56% of the decoded JSON size
and 21.49% of the 46,438,634 bytes of pinned binary graph and factory source
files. The complete private bundle is about 9.98 MB; no graph artifacts are
committed.

Validation evidence is private under
`.parity/reviews/n08-fst-json-gzip-20260907`:

- `triple-controls.json` runs 142 controls through three explicitly labeled
  Phoenix executors: pinned binary-decoded OpenFST graphs, decoded plain JSON
  snapshots, and decoded gzip JSON snapshots. It compares complete result
  objects, including rule, intent, entities, score, and native heuristic. All
  142 plain-vs-binary, gzip-vs-binary, and plain-vs-gzip rows are equal. This
  is executor equivalence; the binary side is not a direct original native
  parser execution.
- `corruption-controls.json` records four isolated overlay tests. Stored-hash
  mismatch, decoded-JSON hash mismatch, malformed gzip, and truncated gzip
  each terminate with exit code 1 before a runtime is returned. The private
  export itself is unchanged.
- `profile-gzip-v2/profile.json` and the exporter output provide the source,
  reference, inventory, entry, and stored-byte hashes used by those controls.

On this Node 22 host, loading the 98-graph/15-factory plain JSON profile took
2.154 seconds from the runtime call and 2.27 seconds wall time with a peak RSS
of 1,120,728 KB. Loading the gzip profile took 2.243 seconds from the runtime
call and 2.35 seconds wall time with a peak RSS of 1,130,424 KB. Both returned
98 rules and 15 factories. Compression reduces distribution size; it does not
reduce the decoded startup memory footprint, which remains about 1.1 GB for
this profile.

The focused configured run was:

```text
PHOENIX_NLU_RUNTIME=compiled-fst \
PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST=<private gzip profile>/profile.json \
node --test packages/nlu/test/compiledFstSnapshot.test.js \
  packages/nlu/test/compiledFstSnapshotProfile.test.js \
  packages/nlu/test/compiledFstRuntimeGuards.test.js \
  packages/nlu/test/compiledFst.test.js \
  packages/nlu/test/compiledFstNativeBoundaries.test.js
```

It completed 22 tests: 21 passed, one binary-profile-dependent test skipped,
and zero failed. With snapshot variables unset, the complete NLU test glob
completed 90 tests: 86 passed, four configuration-dependent tests skipped,
and zero failed.

The strict 43-case service harness was not modified to accept a snapshot
manifest, so it was not rerun with this private data path. The 142 controls
are low-level executor controls rather than service, deployment, or robot
acceptance. No 20,528/20,534 replay, native container trial, Moth validation,
or source-to-binary rebuild is claimed. Deployment still has to provision the
private manifest and all gzip artifacts selected by configuration; the loader
does not read archived Jibo binaries or `.parity` source paths in snapshot
mode.
