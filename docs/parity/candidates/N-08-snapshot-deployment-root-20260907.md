# N-08 portable snapshot deployment — root accepted

The installer validates the approved complete JSON/gzip graph bundle and loads it
through the real portable runtime before atomically installing a new versioned
directory. The target needs Node and the application dependencies. The bundle is
provisioned separately; private graph payloads and original executables are not
committed.

```sh
node scripts/install-nlu-snapshot.mjs \
  --input /path/to/approved-bundle \
  --output runtime/nlu-snapshot-v1
```

For a native parser process, select the installed manifest:

```sh
PHOENIX_NLU_RUNTIME=compiled-fst \
PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST=runtime/nlu-snapshot-v1/profile.json \
  node packages/nlu/src/index.js
```

For Compose, select the optional overlay. It requires an existing bundle directory
and mounts it read-only at the parser's configured container path:

```sh
PHOENIX_NLU_SNAPSHOT_DIR=./runtime/nlu-snapshot-v1 docker compose \
  -f docker-compose.yml -f docker-compose.nlu-snapshot.yml up
```

Root corrected the candidate's regression in the existing compiled-binary path,
kept base Compose and the native launcher unchanged, and excluded `runtime/` from
Git and the image build context. The overlay selects the snapshot runtime itself;
the base configuration retains its existing behavior.

Root installed both gzip and JSON representations, verified all 114 installed
files, passed all four configured installer checks and nine configured binary
checks, then built and started the actual Node20 image. Both native-launcher
profiles passed seven service healthchecks and 15 complete parser-data checks;
Compose passed the same 15 parser checks. The bundle mount is read-only, and the
image excludes the runtime payload. Test containers exposed no host ports and
were removed after inspection.

The [deployment review](../evidence/2026-09-07/nlu-snapshot-deployment/review.json)
retains two failed root health probes and a test-checkout workspace-link failure.
Corrected probes and the independent combined `939c670` checkpoint pass: 675 unit
tests, seven skips, strict43 with zero differences/invariants/gaps, actual npm
exit0. No failing capture was rewritten.

A [temporary real-Moth trial](../evidence/2026-09-07/hardware/portable-snapshot/review.json)
verified native signed TLS issuance, both authenticated sockets, clock/TTS/display,
joke playback calls and a synthetic proactive exchange with the installed portable
profile. Root verified rollback to the existing diagnostic backend. Microphone
recognition, hotphrase/physical-ring behavior, persistent authenticated deployment
and full N-08/H-10 remain open.
