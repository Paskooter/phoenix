# A-04 suspension candidate — awaiting root acceptance

The isolated candidate adds missing-loop/robot errors, robot-or-admin suspension
checks, durable suspension timestamps, robot list filtering and the original
empty success body for SuspendRobotLoop. Invalid payloads use the source-shaped
422 envelope consumed by the original client. Main has not integrated this code.

Root integration `9833185` passes 678 unit tests, seven skips and strict43 with
zero differences, invariants or gaps. Root removed a test dependency on the
sibling Hermes checkout and verified the focused test in a network-isolated
Node 20 container with only Phoenix mounted read-only.

Root also executed 87 ordered calls with the original Node 8 Loop client.
The 12 invalid/valid pairs and three denied or forged requests pass 1,179
checks for complete operation responses, client errors, fixture lists and state.
Nine corrupted controls are rejected, including timestamp mutation and numeric
or null suspension values. The comparator returns a failure exit code on mismatch.

The 87-call reference executes the original security gateway with a modeled
Account peer. Root has now separately reproduced 21 actual original
LoopHandler/LoopController controls under Node 8 (53 checks), using controlled
model/query/save boundaries. Source revision differences are documented.
The source also emits LoopUpdated after suspension; its downstream notification
effects are being traced before complete feature acceptance. List metadata
differs between synthetic fixtures; the comparison verifies its stability and
state consistency.
Full Classic signature verification, LoopUpdated events, remaining Loop
operations and robot acceptance are open. This candidate does not close A-04.

The [pending review](../evidence/2026-09-07/account-suspension-pending/review.json)
records the execution scope and hashes.
