# A-05 public OOBE parser and reconnect review

Date: 2026-09-13  
Reviewer: Codex root  
Integrated commits: `6c9bd4e`, `e784f95`  
Pinned Account source: `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`

## Decision

**VERIFIED bounded implementation; A-05 remains open.** The combined Phoenix
Account face now reproduces the public OOBE media/parser boundary and the pinned
source-simple reconnect controller while preserving newer Account routes. The
complete installed-client, restart, deployment and hardware acceptance required
by A-05 has not been repeated on this integrated revision.

## Source review

The source was read through the Jibo MCP before integration.

- `src/controllers/oobe.ctrl.ts` implements `reconnectRobot({ token })` by
  deleting the valid token and returning `COMMAND_RESULT`. It does not inspect
  the robot's loop membership or suspension state.
- The pinned handler passes only `token`. The proposed membership checks came
  from an unpinned later `master` revision and were rejected.
- `srv-account-ws` depends on `@jibo/server` 4.0.17. The matching
  `jiborobot/srv-server@master` package is version 4.0.17; `src/server.ts` uses
  ordinary Hapi POST payload defaults and reserves the 1 GB streaming limit for
  the separate binary route.

## Accepted behavior

- OOBE captures the original request bytes independently of the shared Express
  parser and validates the source Hapi media types and entity shapes.
- A truly absent `Content-Type` defaults to JSON. The regression uses raw
  `node:http` and asserts the client did not silently add the header.
- Vendor JSON, text subtypes, forms, binary entities, malformed JSON, invalid
  media headers, gzip and deflate reproduce the reviewed Hapi envelopes.
- Declared, chunked, underreported and compressed-expansion bodies are bounded
  at 1 MiB without retaining the rest of an over-limit stream.
- Reconnect requires the existing Phoenix gateway credential boundary, then
  validates and consumes the one-time token. It does not add the later,
  source-incompatible membership or suspension checks.

## Root falsification

Root temporarily changed the missing-header default from `application/json` to
`application/octet-stream`. The named raw HTTP test failed with actual 422
versus expected 200. Restoring the JSON default returned the test to green.

The worker separately replayed the same raw request against the pre-repair
parser, which returned 415. The chunked over-limit test sends 1,048,577 bytes
without `Content-Length` and receives the explicit source-style 400 size
envelope.

## Verification

Worker isolated review:

- Account/Common focused tests: 45 passed, zero failed.
- Full suite: 1,967 passed, zero failed, eight skipped.
- Strict production gate: 43/43, zero differences/invariants/gaps.

Root combined review with the N-03 candidate:

```text
node --test packages/account/test/robotOobePublicParser.test.js
1 passed · 0 failed

npm test
1,969 passed · 0 failed · 9 skipped
parity:check: 62/79 before any A-05 task credit
parity:gate: 43 cases · 0 differences · 0 invariants · 0 coverage gaps
```

## Remaining A-05 work

- Re-run the complete installed original SDK target matrix against this exact
  integrated revision, including every normal/admin target and token edge.
- Re-prove issued credential persistence across service and robot restart.
- Perform the task's fresh hardware/firmware/date acceptance and retain its
  artifact.
- Reconcile the remaining A-03/A-04 lifecycle dependencies in the complete OOBE
  flow. Previous bounded evidence is retained but does not close these items.
