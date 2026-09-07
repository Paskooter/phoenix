# N-08 portable snapshot deployment input — candidate

Historical candidate report. The later [root acceptance](N-08-snapshot-deployment-root-20260907.md) records the reviewed implementation, current instructions and verification limits.

This is an unverified deployment slice pending root review. It makes the already
approved portable compiled-FST profile usable as an externally provisioned input;
it does not change the AST default or publish the private graph payloads.

The target-side workflow is:

1. Provision a complete exporter output directory containing `profile.json`, its
   declared `graphs/**` and `factories/**` JSON or gzip files, and no native Jibo
   executable. The reviewed profile has 98 public graphs, 15 factory FSTs and 16
   factory-file provenance entries.
2. Install it atomically with:

   ```sh
   node scripts/install-nlu-snapshot.mjs \
     --input /path/to/provisioned/profile-bundle \
     --output runtime/nlu-snapshot
   ```

   The installer requires the approved profile schema, inventory, source/runtime
   provenance and tracked decoded hash anchor. It checks every declared path is a
   relative POSIX path, rejects symlinks and duplicate paths, verifies stored and
   decoded hashes/sizes, copies only declared payloads, and loads all 98 graphs and
   15 factories through `compiledFstRuntime.js` before an atomic rename. An existing
   destination is rejected so a versioned path can be selected for each update.
3. Opt in explicitly at the service boundary:

   ```sh
   PHOENIX_NLU_RUNTIME=compiled-fst \
   PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST=runtime/nlu-snapshot/profile.json \
     node packages/nlu/src/index.js
   ```

   For Compose, set `PHOENIX_NLU_SNAPSHOT_DIR=./runtime/nlu-snapshot` and
   `PHOENIX_NLU_RUNTIME=compiled-fst`; the parser container sees the fixed
   `/phoenix/runtime/nlu-snapshot/profile.json` path. Leaving the runtime variable
   unset keeps the AST path selected.

The Compose and native launcher changes only pass this explicit opt-in through and
keep the target bundle outside the image. The image still supplies Node and the
ordinary application dependencies; the snapshot target needs no original Jibo
binary, compiler, or private `.parity` path.

Evidence in the candidate worktree's ignored review directory
`.parity/reviews/n08-profile-deploy-20260907` records:

- gzip installation from the root-generated private bundle: exit 0, 98 graphs,
  15 factories, 16 factory files, 114 installed files, 9,920,435 stored payload
  bytes and 179,460,765 decoded bytes;
- JSON installation after a representation-preserving conversion of that same
  bundle: exit 0, with the same 98/15/16 counts and runtime anchor metadata;
- configured installer tests: 4 passed, including missing-artifact and corrupt
  gzip rejection, real listener startup and a `POST /v1/parse` parse;
- default dependency-free installer test: 2 passed and 2 artifact-dependent tests
  skipped when no private bundle is supplied;
- Docker Compose static configuration validation and native launcher shell syntax.

The configured service test measured installation plus runtime verification and
listener startup in the local Node 20 environment. It did not start Compose or a
production port. The private source bundle and converted JSON payloads remain
ignored evidence and are not part of this candidate. Full production replay and
robot acceptance remain root-owned.
