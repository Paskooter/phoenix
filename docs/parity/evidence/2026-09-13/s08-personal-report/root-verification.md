# S-08 root verification

Status: **VERIFIED** for both written S-08 acceptance criteria.

The reviewed implementation is Phoenix `24c21e2`, containing the source-aligned
`MultiTurnNode` boundary from `6220817` and the fail-closed differential harness
from `688bc67`. The candidate work was produced at `d0c9f95`. The oracle is the
original Pegasus revision `5c0a7390539663ba749d360de348a428c088505c`, executed
under Node 8.9.4 from the pinned image recorded in the source-runtime receipt.

## Decision

The final matrix contains 43 graph conversations and 11 Settings seams. All 54
rows match in normalized behavior and exact prompt selection. It covers all five
launch intents, reactive and proactive flow, recognized adult and child speakers,
unknown speakers, identity success/cancel/not-in-loop/no-input/no-match paths,
Opt-In yes/no/no-input/no-match and wrong-ID continuations, configured/default/
all-disabled preferences, every non-empty provider failure subset, all-provider
failure, individual skills, incomplete configuration, Settings request/default
behavior, `prefsFromConfig`, ordered MIMs/listen contexts, transitions, session
state, service calls, and analytics.

The root reran the original compiled Personal Report and Settings code inside the
pinned Node 8 image, ran Phoenix independently, and obtained:

```text
source: graph=43 settings=11 ok=52 failed=2
candidate: graph=43 settings=11 ok=52 failed=2
result=pass rows=54 semanticMatches=54 promptMatches=54
coverageErrors=0 promptDifferences=0 unexpectedDifferences=0
```

The two failures on each side are deliberate equal negative controls for an
unknown launch intent and an omitted action-result boundary. Root directly
deep-compared the four source-test branches added after adversarial review:
WhoIsThis final no-match, Opt-In final no-match, wrong-ID to cancel, and wrong-ID
to loop-member continuation.

## Falsification and regression checks

- Restoring the old null-safe `MultiTurnNode` access made the named malformed-
  continuation test fail and reduced the differential to 49/50. Restoring the
  source-shaped boundary returned it to 50/50 before the four additional cases.
- Removing the same descriptor from both source and candidate receipts fails
  cardinality and missing-ID checks, closing the prior `undefined === undefined`
  comparator blind spot.
- Forging only one candidate `prompt_id` leaves semantic comparison equal but
  fails the comparator with one prompt difference.
- The final focused controls pass 4/4. A clean integrated `npm test` retry passes
  1,981 tests, skips 9 environment-dependent tests, and fails none; `parity:check`
  passes and the 43-case production gate has zero differences, invariants, or
  coverage gaps. An earlier concurrent full run hit two unrelated Account HTTP
  timeouts while a stale S-07 corpus container was active; both timed-out tests
  passed individually after that container stopped, before the clean full retry.

## Retained limits

The failed detached weather-prefetch control is intentionally different at the
process boundary: both implementations return a Promise immediately, the source
emits one unhandled rejection, and Phoenix consumes it. This can affect logging
or strict unhandled-rejection process policy. It does not alter either written
S-08 criterion, and reintroducing the unhandled rejection would reduce runtime
reliability, so root accepts it as an explicit compatibility improvement under
the consumer-focused compatibility policy.

No live Settings/Lasso/provider deployment, Hub turn, or physical robot behavior
is claimed here. Those integration and hardware boundaries remain tracked by
their service and release tasks rather than S-08's two source-runtime criteria.

Detailed receipts and reproduction commands are in
[`source-runtime-differential.md`](source-runtime-differential.md), with the
machine-readable final result in [`differential-receipt.json`](differential-receipt.json).
