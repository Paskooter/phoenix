# S-08 Report Lasso header snapshot follow-up

Status: unverified; isolated candidate for lead review.

Base: `6f5490084b1a5cc4615e638b102f9da7a13bcf8f`, the frozen Lasso boundary
follow-up. This candidate only changes
`packages/skills/src/report/lassoClient.js` and its focused source-edge tests.

The original client copies the object returned by `req.jibo.toHeader()` while
constructing the first Axios request. A source-shaped control mutates that
same returned object after the first request arrives and before the 302 or
307 response is sent. Node 8 keeps the original `x-jibo-mutable: before` value
and omits the newly added header on every redirect. The candidate previously
sent the mutated values; it now copies the initial map before redirect
recursion. Relative 302, cross-authority 302, relative 307 GET, and relative
307 HEAD all match exactly, including one `toHeader()` call per case.

The request-header boundary now captures `data.req`, `req.jibo`, and
`jibo.toHeader` once, preserves the source `this` binding, and emits the
source Node 8 non-function diagnostic without re-evaluating those properties.
Getter-counting tests cover that evaluation order.

Evidence is under
`.parity/reviews/s08-lasso-snapshot-followup-20260906/`. The source run used
Pegasus `5c0a7390539663ba749d360de348a428c088505c`, the pinned Node 8 image,
and the readonly reference/dependency tree mounted at `/reference`. The
exact Docker command, mount paths, source output, candidate output, and
comparison hashes are recorded beside `header-mutation-comparison.json`.

Validation:

```text
node --test packages/skills/test/lassoClient.source-edge.test.js \
  packages/skills/test/lassoClient.source-wire.test.js               11/11
node --test packages/skills/test/*.test.js                           133/133
```

The candidate remains pending root review. No main, robot, Settings, source
reference, golden, scheduler, driver, or comparator files were changed.
