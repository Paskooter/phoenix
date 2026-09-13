# S-11 HTTP commute graph differential

This lane drives the archived Pegasus HTTP endpoint and the current Phoenix
HTTP endpoint through the same 33-case matrix. It compares ordered MIMs,
prompt IDs, ESML, normalized actions, commute views, analytics, graph
transitions, response sequences, and provider wire calls.

The source run uses Pegasus revision
`jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c` in the immutable
`node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
image with Docker `--network none`. The only reachable service is the local
fixture peer bound inside the runner. Phoenix runs with Node 20 or newer and
uses the same peer over loopback.

From this worktree, run:

```bash
node scripts/parity-s11-http-graph/run.mjs --out .parity/runs/s11-http-graph
```

The command writes source, candidate, comparison, and negative-control logs to
the selected output directory. It exits nonzero for any missing, reordered, or
mutated observable. The negative-control phase independently forges MIM order,
prompt IDs, ESML, views, analytics, transitions, normalized action, and a
provider query and requires every mutation to be rejected.
