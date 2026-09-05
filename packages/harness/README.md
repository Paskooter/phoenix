# @phoenix/harness — original/Phoenix behavioral comparison

From the repository root:

```bash
npm run harness -- --out .parity/runs/compare
npm run harness -- --candidate original --out .parity/runs/control
npm run harness -- compare --reference reference.json --candidate candidate.json --out comparison.json
node --test packages/harness/test/diff.test.js packages/harness/test/parityCompare.test.js
```

The first command runs the same 28 HTTP and WebSocket fixtures against the frozen original
Pegasus modules and current Phoenix services in separate containers. The second calibrates
the gate using two independent original runs. Exit codes are **0** for agreement, **1** for
observed differences or invariant failures, and **2** for setup or capture errors. A failing
Phoenix comparison is expected while the [parity backlog](../../docs/parity/TASKS.md) is open.

See [runner instructions](../../scripts/parity-compare/README.md) for prerequisites, pinned
images, retained artifacts and the adapter boundary. The [reference setup](../../docs/parity/REFERENCE.md)
records how the original modules and dependencies are recovered and verified.

## Coverage and comparison policy

The initial suite covers shared HTTP responses/errors/routing/authentication, robot skill-list
URLs, hub launch/relaunch/continuation, no-match/provider failures, WebSocket authentication,
malformed frames and the first 2.1 seconds after a terminal frame. Local fixture peers supply
NLU, skill actions and history acknowledgements. Action tests verify that the hub preserves
complete synthetic JCP/ESML/analytics payloads. They do not verify real skill rendering,
live providers, audio, persistence, clients, deployment or hardware. Those retain separate tasks.

`compareTraces()` compares all JSON fields, types, presence and array ordering, plus HTTP
status/headers and captured side effects. Its limited equivalence rules are in
[parityCompare.js](src/parityCompare.js):

- Generated envelope UUIDs may differ at listed paths only, with a bijection preserving
  identity relationships. Input and fixture-peer IDs remain literal.
- Fixture addresses may differ at listed URL/error/Host paths only. Other URL ports remain significant.
- Measured wall durations must satisfy per-fixture bounds and ordering. Frozen timestamps,
  message timing keys and sentinel values remain exact.
- Raw bytes must agree with decoded values and declared lengths. ETags must match their
  entity bytes; the derived digest may differ while header presence and weak/strong form stay exact.
- Full session contents remain compared. Independent checks require the issued session to be
  returned, forwarded unchanged and accepted/advanced by the fixture skill.

The comparison report lists the rules, invariant failures and JSON-pointer differences.
Intentionally corrupted captures exercise the gate in unit tests, including its CLI exit code.

## Other package utilities

`normalizeMessage()` and `normalizeStream()` now clone and sort object keys without dropping
fields. `diffStreams()` defaults to D2, comparing the entire payload; D1 is an explicitly selected
message-type diagnostic. Neither silently permits timestamp, ID, port or session differences.

`SkillConversation`, mock runtime data and the existing chitchat `corpusRunner.js` remain available.
The corpus runner's intent/MIM score is narrower than the strict trace gate and does not certify
entities, named rules, actions or the complete original test denominator. V-03 tracks that work.
