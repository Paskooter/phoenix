# S-11 Commute source differential

This harness compares the archived Pegasus `Commute.test.js` contract with
Phoenix's current Commute implementation. The checked-in matrix contains all
33 archived rows and 36 direct `expect(...)` calls, plus five zero-assertion
supplemental logic probes for `driving`, `transit`, `bicycling`, `walking`, and
an invalid mode.

The source runner loads the pinned Pegasus compiled modules in
`node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
with `--network none`. The reference checkout and all source, compiled,
resource, archived test, and TestUtils hashes are checked before a pass. The
candidate runner imports the current Phoenix modules and records the same
projected parsed state, ordered MIM basenames, and complete view JSON.

From this worktree, with the prepared reference at the default sibling path:

```bash
node scripts/parity-s11-source-diff/make-matrix.mjs
node scripts/parity-s11-source-diff/compare.mjs --out .parity/runs/s11-commute
node scripts/parity-s11-source-diff/falsify.mjs --run-dir .parity/runs/s11-commute
```

`falsify.mjs` invokes the comparator's receipt-check mode against isolated
temporary copies. It verifies that a missing row, reordered candidate rows,
and a candidate value mutation with a recomputed row hash are all rejected.
