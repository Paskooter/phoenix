# Isolated original/Phoenix comparison

Run from the Phoenix repository root with Node 22, Python 3, Git and Docker available:

```bash
npm run harness -- --out .parity/runs/compare
npm run harness -- --candidate original --out .parity/runs/control
```

`--source /path/to/pegasus` selects the local Git repository containing frozen original commit
`5c0a7390539663ba749d360de348a428c088505c`; the default is the sibling `pegasus` directory.
`--docker-host` defaults to `unix:///var/run/docker.sock`. Missing reference artifacts are prepared
using [parity-reference](../parity-reference/README.md), including its initial dependency downloads.
Missing runtime images are pulled by immutable digest:

| Subject | Runtime | Image |
|---|---|---|
| Original | Node 8.9.4 | `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` |
| Phoenix | Node 22.22.0 | `node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94` |

The runner checks all 376 original TypeScript source inputs against Git, checks 391 emitted
module hashes, and verifies the original report manifest and compiler/runtime provenance.
The [reference record](../../docs/parity/REFERENCE.md) explains the module-emission build and
excluded dependencies. The original application source is not rewritten for this comparison.

Each capture runs in a temporary container with `--network none`, no published ports and only
the required source/dependency/fixture paths mounted read-only. Services and fake peers communicate
over that container's loopback interface. No real service credentials or Phoenix `.env` are loaded.
Setup downloads occur outside those isolated captures.
The outer capture command allows 180 seconds for Docker startup, execution and cleanup;
individual observations still have the suite's 5 second bounds. `run.json` records command
durations separately so host/container overhead is not confused with service latency.

## Fixtures and adapters

[suite.json](suite.json) defines the 28 cases and time bounds. [driver.cjs](driver.cjs) is shared
unchanged by both runtimes: the same HTTP requests, ordered WebSocket messages, dummy authentication,
upstream fixtures, clock and PRNG seed. Continuations deliberately use each subject's previously
issued session. Original UUID generation is left intact and checked through explicit ID bindings.
The clock fixture freezes `Date`, seeded `Math.random` and the runtime's automatic HTTP `Date`
header. Modern Node generates that header through an internal clock which bypasses `global.Date`;
the shared response hook preserves explicitly supplied dates and `sendDate=false`. Unit tests
check these exceptions, and trace invariants require captured HTTP dates to match the fixture clock.

[original.cjs](original.cjs) starts actual `BaseService`/`BaseHttpHandler` and `HubService` modules.
The Google speech/gRPC import shims are inert; this suite uses public `CLIENT_ASR` text input.
[phoenix.mjs](phoenix.mjs) starts actual shared-service and gateway implementations. The only custom
handlers return the same synthetic HTTP fixture values; adapters do not repair missing production
authentication, routes or response behavior.

The fake parser, skill and history peers record every request and response, including headers,
full body and observation order. An `x-jibo-transid` header attributes requests to cases; missing
attribution or late unattributed work fails an invariant. A 50 ms drain follows each transaction.
This bound cannot establish the absence of arbitrarily delayed side effects.

The fixture skill supplies a full synthetic JCP/ESML/analytics action and an opaque session.
An update succeeds only if the original session fields arrive intact. This establishes hub
forwarding/continuation coverage; actual skill/MIM rendering and JCP consumer compatibility are
separate product gates. HTTP edge cases, skill-list aliases, errors and a 2.1 second terminal
socket observation complete the initial suite. Full parser corpora, audio, longer timeouts,
durability, other services, original clients and hardware remain outside this suite.

## Results and review

Each output directory contains:

- `reference.json` and `candidate.json`: requests, raw/decoded responses, ordered frames, timing,
  side effects, fixture endpoints and input/driver hashes.
- `comparison.json`: all differences, independent invariant failures and allowed equivalence rules.
- `phoenix-source.json`: Git HEAD and hashes of the entire tracked/nonignored package/script tree.
- `run.json` and logs: exact commands, pinned images, checked reference inputs, exit status and
  artifact hashes. The runner rejects a source/tool change during a capture pair.

Use a fresh output directory when retaining a distinct run. Exit **0** means agreement for these
fixtures, **1** means behavioral/invariant disagreement, and **2** means an operational failure.
An original-vs-original control must pass before using Phoenix failures as evidence. The strict
gate checks status, headers, presence/null/empty, full NLU/action/analytics and session behavior;
only the bounded paths in [parityCompare.js](../../packages/harness/src/parityCompare.js) receive
special treatment. No global port, timestamp, session or field deletion is allowed.

Offline comparison and mutation-test commands are documented in the
[harness package](../../packages/harness/README.md). Reviewed milestone evidence belongs under
`docs/parity/evidence/`; generated development captures stay in gitignored `.parity/runs/`.
Do not equate a passing runner calibration with completed Phoenix product tasks.
