# N-08 trusted hashes for portable compiled-FST snapshots

Status: candidate unverified; pending root review. This is a bounded
provenance and deployment slice for the opt-in `compiled-fst` snapshot
profile. It does not change the default AST profile, the binary profile, or
claim full N-08 parity.

The snapshot profile previously trusted the graph and factory hashes repeated
inside the profile being loaded. This candidate adds the committed,
hash-only resource
`packages/nlu/resources/compiled-fst-snapshot-hashes.json`. It is versioned
(`phoenix.nlu.compiled-fst-snapshot-hashes`, version 1) and contains source
labels, source hashes/sizes, canonical decoded JSON hashes/sizes, the pinned
inventory identity, and the rule/factory manifest hashes for 98 public graphs,
15 factory FSTs, and 16 factory-directory files. It contains no graph data.
The runtime pins the resource SHA-256 in `COMPILED_FST_PROFILE` and checks its
schema, profile identity, inventory/name sets, source metadata, and every
decoded graph/factory byte hash before returning an executor. A profile that
changes graph bytes while updating its own snapshot hashes or provenance is
rejected against this external anchor.

The canonical decoded bytes are UTF-8 JSON produced by
`stringifyFstSnapshot`, including its final newline, digested with SHA-256.
Gzip is only a storage encoding. The same anchor checks apply to plain JSON and
gzip profiles; existing profiles without the optional profile anchor field
still receive the external runtime check. The exporter accepts
`--anchor-output FILE`, validates that its generated anchor has the approved
SHA, and records that SHA in newly generated profile metadata.

The production harness now accepts:

```text
--compiled-snapshot-manifest PROFILE/profile.json
```

It preflights profile paths, storage mode, stored and decoded hashes/sizes,
artifact containment, required counts, and duplicate artifact paths. The
Phoenix container mounts only the selected profile directory read-only and
sets `PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST`; it supplies no binary FST,
factory, or rules-directory variables. Binary and default invocation paths
remain separate.

The candidate worktree is
`/home/shell/work/phoenix/.parity/worktrees/n08-fst-json-anchor-20260907`,
based on `39452deddf50a00a7776e8a02bc54ceec431b6bb`. The committed anchor
currently has these pins:

- anchor: 37,378 bytes,
  `805f357284e55e873c6a351a6fdd515dd4bb2df6c9f6be7824335e26574529dd`
- inventory SHA-256:
  `4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5`
- source revision: `91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e`
- reference revision: `5c0a7390539663ba749d360de348a428c088505c`
- source runtime label: `jibo-nlu v2.8.3`
- native parser SHA-256:
  `373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b`
- approved launch SHA-256:
  `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`
- rule manifest SHA-256:
  `363fb4a663fb2a09920a38c9ae021301670fc38c8d6fe4f9612343d3cfef60fd`
- factory manifest SHA-256:
  `4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e`

The private gzip profile used for the service check is
`/home/shell/work/phoenix/.parity/reviews/n08-fst-json-anchor-20260907/profile-gzip-anchor/profile.json`:

- profile: 57,565 bytes,
  `481d4088f7f745b7aeab5b19d5c5d7a5566a5e936d898941c5ea239d8e54f2ae`
- 98 public graph snapshots: 170,143,253 decoded bytes and 9,453,601 gzip
  bytes
- 15 factory snapshots: 9,317,512 decoded bytes and 466,834 gzip bytes
- profile plus compressed snapshot data: 9,978,000 bytes

Focused evidence is private under
`.parity/reviews/n08-fst-json-anchor-20260907`:

- `strict43-gzip-final2/run.json` completed with process exit 0 and
  `result=match`, 43 cases, 0 differences, 0 invariants, and 0 coverage
  gaps. The final comparison SHA-256 is
  `770b732908fc2a65d94c42f06197a14ef4c1054898d0f1ad04744e9fc30291c3`;
  the suite SHA-256 is
  `8e5d1b63851a5b1cc63d2f020a920b921667e24b2c1f7c3d086144c0621ed6c2`.
  Candidate and reference capture SHA-256 values are respectively
  `cd74a10f2bd0dae68d0ac66349b989c56a0423c88f907d9d196355085827f1e0` and
  `a9f40ba6a2acb9765750b1c9e084a6ce924d21409ffe07f4bfcf46d23b2128a7`.
  The harness recorded Phoenix source tree SHA-256
  `af10c68c7c765686d589053c382625d48f5b50014309537a0ab418693af3978d`.
- `triple-controls-final.json` contains 142 complete controls through three
  explicitly labeled Phoenix representations: pinned binary-decoded
  OpenFST graphs, plain JSON snapshots, and gzip JSON snapshots. All 142
  binary-vs-plain, binary-vs-gzip, and plain-vs-gzip rows are equal. These are
  executor representation controls, not direct original native parser
  results. The measured load times were 232 ms (binary), 2,686 ms (plain),
  and 2,937 ms (gzip) on the Node 22 host.
- `corruption-controls-final.json` records stored-hash mismatch,
  decoded-JSON hash mismatch, malformed gzip, and truncated gzip; all four
  current-code controls exited 1 before a runtime was returned.
- The configured snapshot test suite completed 23 tests: 22 passed, 1
  binary-only test skipped, and 0 failed. The same suite against the existing
  plain profile completed 12 tests: 11 passed, 1 skipped, and 0 failed. The
  new mutation test edits a graph, updates its profile snapshot/source
  metadata and stored gzip hash, and still receives the trusted-anchor
  rejection.
- With snapshot variables unset, the full NLU glob completed 91 tests: 86
  passed, 5 configuration-dependent tests skipped, and 0 failed. The full
  repository unit command completed 598 tests: 593 passed, 5 skipped, and 0
  failed.

No full 20,528/20,534 replay, direct native parser control, native container
trial, Moth validation, or source-to-binary rebuild is claimed. The private
snapshot artifacts are not committed. The current anchor is tied to the
candidate's current `rule-inventory.json`; root's later integrated inventory
metadata change must be reconciled by regenerating the anchor/profile metadata
from the final pinned inventory, preserving the canonical graph/factory bytes,
rather than manually editing trusted hashes. The final deployment still has
to provision the profile and all selected gzip artifacts and pin the package
revision containing the committed anchor.
