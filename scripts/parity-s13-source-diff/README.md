# S-13 report-view source differential

This lane compares the four isolated report-view helper families (weather,
traffic/departure, news, and calendar) against the pinned Pegasus compiled
helpers. The checked-in matrix has 61 immutable, ordered IDs: weather 20,
traffic 7, depart 4, news 5, and calendar 25. Every row is one complete view
JSON comparison.

The source runner executes freshly in
`node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The candidate runner executes in
`node:22.22.0-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94`.
Both containers use `--network none` and read the source/candidate trees
read-only. The source output is generated on every run; no golden output is
trusted.

The contract pins the candidate implementation revision
`0902410c597f8dc424af60ee98fc4d32f19a1bb0`. A run records the actual tested
HEAD separately and requires it to be a descendant of that implementation
revision, so adding this harness does not invalidate the implementation pin.

The prepared Pegasus reference is expected at the sibling worktree's
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`. Supply another
location with `--reference PATH` or `PHOENIX_S13_REFERENCE`.

Run the differential and its adversarial controls:

```bash
node scripts/parity-s13-source-diff/run.mjs --out .parity/runs/s13-report-views
node scripts/parity-s13-source-diff/falsify.mjs --run-dir .parity/runs/s13-report-views
node --test scripts/parity-s13-source-diff/test.mjs
```

A passing run reports 61 rows, 61 matches, and zero differences. Receipts use
tagged outcomes: `fulfilled` values preserve `undefined`, `NaN`, `Infinity`,
`-Infinity`, `-0`, symbols, functions, and cycles; `rejected` outcomes carry
an explicit error name/message/code. Rows carry an input self-hash and an
outcome self-hash. The comparator rejects omissions, duplicates, reordering,
receipt rehash tricks, stale revisions, matrix replacement, harness/source
substitution, resource/dependency changes, and candidate implementation
changes before accepting a pass.

`make-matrix.mjs` regenerates the deterministic matrix bytes. Any replacement
is rejected by the code-pinned contract until its review pins a new contract.
