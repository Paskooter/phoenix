# Isolated original reference

This executes original Hashbrown Pegasus modules under Node 8.9.4 with exact lock-pinned runtime dependencies and the requested NLU 2.8.3 binary. Phoenix is not used to generate expected responses. The [compatibility manifest](../../docs/parity/COMPATIBILITY.md) fixes the source and version boundary.

From the Phoenix root:

```bash
# Pull once if the pinned image is not already local.
docker -H unix:///var/run/docker.sock pull node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c

python3 scripts/parity-reference/run.py --out .parity/runs/reference
# Later runs can omit dependency installation; source integrity is still checked.
python3 scripts/parity-reference/run.py --skip-install --out .parity/runs/reference-repeat
```

Use `--source /path/to/pegasus` if the sibling checkout is elsewhere, and `--docker-host` for a different local daemon. The source must contain the exact frozen Git object. The original checkout is read only; `.parity/` contains the extracted source, dependencies, generated modules and downloaded artifacts. Provisioning needs archive access, Python 3.10+, Node and Docker. Runtime execution uses `--network none`, no published ports and local fixture peers. No existing services are stopped.

The command exits nonzero on provisioning, source-integrity or fixture failure. `run.json` records commands, image identity, hashes and exclusions. `transactions.json` retains raw HTTP status/headers/bodies, ordered WebSocket frames and peer side effects. The clock, seeded randomness, fixture IDs and provider substitution points are recorded there. A fixture pass establishes that the reference can execute those scenarios; it does not establish Phoenix parity.

The current fixture covers:

- Original BaseService/BaseHttpHandler health, null/undefined, HEAD, JSON/form/query parsing, missing paths, thrown errors and HTTP/WS authentication.
- All four original robot-specific skill-list routes, using the original report settings manifest.
- Original hub CLIENT_ASR launch, global relaunch despite an existing session, local continuation, no match and provider failure. A final transaction frame does not close the original socket; the fixture records its own explicit close.
- The original hub Settings client, including `Settings_20160801.GetSettings` and the exact Axios-fork request.
- The original parser request handler with injected robust/Dialogflow results: empty/malformed requests, no match and a named-rule request.
- The original common Lasso relay with fixture data and Redis callbacks: live/cache envelopes, HEAD prefetch, skip-cache truthiness and errors.
- The original NLU **2.8.3** `parse` executable and original `launch.fst`, with two positive utterances and one no-match input. This is a CLI smoke check, not the complete production parser/corpus.

## Build adaptations and limits

The first full development install exhausted available disk space while copying `ffprobe-static`; its failed log is retained in the V-01 evidence. Only artifacts from that attempt were removed. The reproducible profile installs production dependencies for 15 server/client/library workspaces. The CLI and two integration-test workspaces are excluded from installation; their source remains available. The root workspace-selection manifest changes, while every included service manifest and compiled source file is checked against the original Git object.

Registry URLs relocate from the old private cache to public npm or the Jibo archive. Original versions and SHA-1 fragments are preserved; the Axios Git fork stays pinned. Lifecycle scripts are disabled. The NLU archive and TypeScript/Yarn tools are downloaded separately with integrity checks.

`compile.cjs` uses original TypeScript **2.5.3** `transpileModule` to emit separate CommonJS files and package entry wrappers. It records every input/output SHA-256. It does **not** claim that the original Gulp/browserify build or type checking passed. Where module emission could affect behavior, source tests and the original release build remain follow-up evidence; never relabel this as a historical production binary.

Google speech/gRPC imports are inert fixtures because the original ASR factory constructs its Google client at import time. The hub uses its original public CLIENT_ASR mode. Actual Google streaming recognition, timing under real ASR, Dialogflow, Mongo/Redis persistence, live OAuth/providers, GQA, complete skill sessions, proactive conversations and real clients/firmware remain unverified. Their product tasks and the full corpus/consumer gates stay open. If a module cannot execute, preserve its failure and derive a labeled fixture from original source/tests; do not invent a runtime result.
