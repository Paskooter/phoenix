# A-06 Settings Person transport review

Root accepted this bounded slice on 2026-09-07. The final reviewed tree is
`609f20aa4fd1429077057e4e356f2a591d4b4ad2`; integrated runtime
`8f70fe19db21d2800057ee42fffcf85e5d8327e0` has the identical tracked tree.
Full A-06 remains open.

Person now uses the original Account/Loop property request shape, transaction
ID, redirect behavior and provider-error handling. An incomplete response or
invalid provider status fails the whole Settings request with HTTP 500 while
the service stays alive. Ordinary getter errors remain attached to the affected
setting. A failed write suppresses readback, and a readback failure retains the
preceding write request.

The original robot client selects `__type || code || error` as its error code.
The response label therefore matters when `code` is absent or empty. This
implementation preserves that machine identity. Human diagnostic wording may
differ under the user's compatibility policy.

Root verification:

- 26 full Settings requests match status, decoded behavior, response headers
  and ordered Person requests, with socket-derived Host values validated.
- 37 direct Person controls match ordered wire requests. Three original
  uncaught-callback cases are also covered inside the real Hapi bootstrap,
  where both implementations return HTTP 500 and remain alive.
- Seven original robot JSON-extractor controls match code/message/HTTP status.
  The archived extractor runs in Node 8 with a disclosed minimal `util.error`
  shim; this does not claim the complete SDK transport ran.
- The combined tree passes 568 unit tests, with three configured skips, and
  the strict 43-case smoke profile with zero differences, invariants or gaps.

Raw comparisons retain one JSON-key-order difference and one per-key parser
diagnostic difference. No substantive response field or provider side effect
is excluded. Source Settings, Hapi, Wreck, Boom and robot-client pins, hashes,
commands, failures and qualifications are in the
[root review](../evidence/2026-09-07/settings-person/review.json).

Full OAuth, Hub transport, public authentication, actual Mongo/provider
deployment and migration remain open. This slice has not been deployed to
Moth.
