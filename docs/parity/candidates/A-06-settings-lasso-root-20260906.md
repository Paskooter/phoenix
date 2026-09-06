# Settings Lasso: root acceptance of a bounded transport slice

Root accepted `a8117d2b727a17b4d17344952f19c6bda8ec7357` against
`jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`.
The [review and execution receipts](../evidence/2026-09-06/settings-lasso/review.json)
record the exact scope, commands, source hashes and remaining gaps.

GET, POST and DELETE now preserve the source query parameters, serialized
credential body, required-property assertions, transaction headers, response
decoding and operation-specific public errors. Redirects retain the original
method, body and headers. The request timer remains active across redirects
and informational responses, clears on final response headers, and does not
abort later redirect requests after the public promise has timed out.

Root independently reran 48 original Node 8 controls against a clean, frozen
worktree with its own dependencies. All 48 matched. They include a 25 ms
timeout with final headers delayed 100 ms, and a third redirect request
observed after rejection during a retained 250 ms observation window. The
comparator verifies each actual Host and raw Host against the receiving
listener before replacing ephemeral port metadata. Captured public error
properties, except stack, are compared without rewriting names or messages.

`npm test` passed 529 tests, skipped three configured-only tests, validated the
task ledger, and passed the default 43-case smoke gate with zero differences,
invariant failures or coverage gaps. The earlier combined adapter branch and
its 529-test receipt are separate historical evidence; this review uses the
final Lasso-only branch based on main `3d632e0`.

This accepts the Settings Lasso transport slice only. Person and Hub adapters
remain under review. Full OAuth exchange, Mongo/provider integration,
authentication, TLS peer behavior, general legacy URL edge cases and complete
consumer journeys remain open. The malformed missing-status control retains
an original uncaught-assertion versus candidate-rejection difference and is
excluded from the 48 exact controls. The string-zero infinite redirect
observation is also excluded; its finite counterpart is covered.

The parent A-06 task remains open, and verified checklist completion remains
7/79. This change has not been deployed to Moth.
