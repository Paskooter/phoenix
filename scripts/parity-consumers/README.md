# Robot consumer source references

Run from the Phoenix root with Python 3.10 or later:

```bash
python3 scripts/parity-consumers/recover-be12.py --download \
  --manifest docs/parity/evidence/2026-09-05/consumers/be-12.0.0-sources.json
python3 scripts/parity-consumers/verify-sources.py --restore \
  --out .parity/runs/consumer-source-verification.json
```

The first command checks the original 192,233,932-byte release archive's SHA-256
and restores 300 `src/` files embedded in seven source maps. It retains the
compiled bundles, maps and package manifests beside the recovered files under
`.parity/consumers/be-12.0.0`. Browserify preludes and sources outside each
package's `src/` tree are excluded explicitly. Type-only files omitted from the
maps and the rest of the SDK monorepo are not recovered by this command.

The second command verifies all recorded bytes and 13 cross-profile file
comparisons. With `--restore`, it retrieves missing Git files at their pinned
commits and extracts selected Jibo Server Client files from the verified archive.
Existing modified bytes fail validation. Neither command installs dependencies,
executes archive code, starts a simulator, or connects to a robot.

The user supplied `/home/shell/work/hermes-be/SOURCE.md` as a discovery lead.
Its archive pin was independently verified; its modified working tree is not a
reference. Native Jetstream comes from its original 2018 commit, before the
archive's URL-migration commit. [CONSUMERS.md](../../docs/parity/CONSUMERS.md)
records the interaction contracts, source limits and remaining acceptance work.
