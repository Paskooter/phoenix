# S-09 Weather differential

This harness compares the pinned Pegasus Weather implementation with the
Phoenix report weather implementation. The matrix is a checked-in declaration
of every named test in
`jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/tests/subskills/Weather.test.js`:

```
54 named cases / 57 expanded runs
top-level 3, parse 14, daytime 19, evening 9, views 9
```

The source runner loads the compiled Pegasus modules from the prepared
reference checkout and must run inside the digest-pinned `node:8.9.4-slim`
image with `--network none`. The candidate runner imports Phoenix's real
`packages/skills/src/report/weather.js` and runs on the host Node runtime.
Only the observable weather object, ordered MIM names, and complete weather
view JSON are compared. MIM paths are reduced to their basename so the source
and candidate checkout roots do not create a false difference.

The source checkout and source hashes are obtained from the Jibo/Gebo archive;
the harness never uses web search. The prepared reference is read-only and is
not modified.

From this worktree, with the prepared reference at the default sibling path:

```bash
node scripts/parity-s09-source-diff/make-matrix.mjs
node scripts/parity-s09-source-diff/compare.mjs --out .parity/runs/s09-weather
```

Use `--reference /path/to/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`
when the reference is elsewhere. A successful run writes `source.json`,
`candidate.json`, `comparison.json`, and runner logs. The comparator exits
nonzero if a side fails, a case/run is missing or unexpected, a row hash does
not recompute, or any projected value differs.
