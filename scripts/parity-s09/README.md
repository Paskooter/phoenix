# S-09 HTTP report graph

This harness runs the pinned Pegasus personal report through its real report
HTTP service and runs the Phoenix report skill through the same HTTP boundary.
Both sides call a local frozen Data peer that returns the DarkSky relay
envelope and AP News XML; it never reaches a live provider. The source
revision is `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`, acquired
from the Jibo/Gebo archive. No web lookup is involved.

The 15-case matrix covers full reports before and after the evening boundary,
single-skill today/tomorrow selection, all condition-change branches, Celsius
and Fahrenheit changes, sanitized summaries, service-down and partial failure,
weather-view presence versus fallback, an offset-aware night icon, and both
unknown-icon MIM fallback paths. Every case asserts two DarkSky GETs at the
frozen coordinates: one timestamped yesterday request and one timestamp-free
current/forecast request. The news case also asserts the four source IDs and
proves that a weather failure still allows the news graph to complete.

Run the complete source/candidate/comparison receipt from this worktree:

```bash
node scripts/parity-s09/run.mjs
```

Use `--reference PATH` to point at another prepared source checkout and
`--out DIR` for receipt files. The source run uses the digest-pinned Node
8.9.4 image with `--network none`. A checkout at the old `311dd62` base
intentionally reports four differences for the offset night case (MIM,
speech, and normalized action); after the offset-aware runtime fix is present,
the same command reports `pass`, 15 cases, and zero differences.
