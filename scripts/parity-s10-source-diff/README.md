# S-10 News differential

This harness compares the pinned Pegasus News implementation with Phoenix's
current report News implementation. The checked-in matrix contains every
named row in
`jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/tests/subskills/News.test.js`:

```
22 named cases / 22 expanded runs / 60 archived `expect(...)` calls
top-level 7, filtering 7, views 8
```

The source runner executes the compiled Pegasus `NewsParse`,
`NewsMimLogic`, and `NewsViews` modules in the digest-pinned Node 8.9.4 image
with `--network none`. The candidate runner dynamically imports Phoenix's
current `news.js` and `newsViews.js`. Both sides use the same synthetic AP
feed shapes, deterministic RNG for the five-category trim, fixed clock, and
identified/child/non-identified speaker controls.

Each row compares parsed category state, ordered MIM basenames, selected
headlines and image metadata, and the complete headline view JSON. The
`assertionCount` on each row accounts for every archived assertion; the full
projection is retained so assertions about counts, order, identity, strings,
geometry, assets, and `leaveEmpty` cannot be silently omitted. Two supplemental
probes run both archived `APNewsTestData` exports: `apNewsXMLResponse` (11
entries) and `apNewsXMLResponseTwo` (one empty provider header). The normalized
artifact is hash-pinned to the source and compiled AP fixture files.

The source test hash, source TypeScript hashes, compiled input/output hashes,
view resource hash, fixture hashes, and row hashes are checked before a pass is
possible. The comparator exits nonzero for a failed side, missing or
unexpected/duplicate case or run, invalid or mutated row hash, metadata/count
mismatch, or semantic difference.

The source and source test were read from the Jibo/Gebo archive; this harness
does not use web search. The prepared source checkout is mounted read-only.
`ap-fixtures.json` keeps the parser-relevant result of parsing those archived
XML exports with Pegasus's pinned `xml2js` dependency; its source and compiled
export hashes are checked by the source runner.

From this worktree, with the prepared reference at the default sibling path:

```bash
node scripts/parity-s10-source-diff/make-matrix.mjs
node scripts/parity-s10-source-diff/compare.mjs --out .parity/runs/s10-news
```

Use `--reference /path/to/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`
when the reference is elsewhere. A run writes `source.json`,
`candidate.json`, `comparison.json`, and runner logs.

On the `575813d` candidate baseline, the replay produced one residual in
`s10:filtering:03` (`filters banned words in summary`): source MIMs were
`["NewsServiceDown"]`, while Phoenix produced
`["NewsIntro","NewsHeadline","NewsHeadline","NewsHeadline"]` because the
candidate keyword set omitted `fudgepacker`. A temporary candidate module with
that one keyword added produced `pass` with zero differences across all 22
rows and both AP fixture probes. The harness itself does not accept that
residual automatically.
