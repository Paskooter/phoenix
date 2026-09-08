# A-04 guardian and agreement candidate

Status: **implemented candidate; independent review and original-client verification pending**.

Adds SetLegalGuardian and UpdateAgreementStatus with source validation,
authorization order, parent eligibility checks, agreement lookup and persistence.
Guardian assignment uses the source direct-update behavior: it stores agreement
and guardian fields without a save timestamp or LoopUpdated event. A signed
agreement accepts the member through a save and records LoopUpdated. Unsigned
agreements leave state unchanged; an already accepted agreement is not found.
The existing exact anonymous gateway exception permits agreement callbacks;
requests supplying credentials must still pass signature verification.

Adds an injectable EchoSign-shaped provider implementing token refresh, user
creation, agreement submission and signed-status lookup. It preserves the
source request paths, form/JSON bodies (including the GET `null` body), token
header, document/recipient fields and best-effort user creation. No external
agreement or email was sent during implementation or testing. Without provider
configuration Phoenix returns ECHO_SIGN_UNAVAILABLE without a network call;
this explicit deployment behavior is not a claim about absent source config.

Source: `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2`, LoopController and LoopHandler,
the loop schema/save hook, and `src/controllers/echosign.ctrl.ts`. The latter
was read through Jibo MCP and retained privately with SHA-256
`3dec72195d97781b9658d31e692194370658cc5333f774700d4195e1440f7dfd`.

Root verification:

- Signed Account and Classic guardian requests and anonymous callbacks cover
  state transitions, event/timestamp differences, eligibility/ownership errors,
  invalid bodies, provider rejection and persistence rollback.
- Provider controls check request order, token/form fields, callback/redirect
  fields, status lookup and continued submission after user-creation failure.
- Four controls execute the exact compiled source controller under Node 8.9.4,
  with model/account/provider/save seams controlled. They confirm direct update
  versus save, unsigned no-op, signed acceptance and accepted-code rejection.
- Full combined suite: 870 passed, seven skipped, zero failed.

Private evidence: `.parity/reviews/a04-agreements-root-20260908/`.
Source controls are not Mongo or actual EchoSign integration. Transport failure
envelopes, provider protocol comparison against original Wreck, concurrent saves,
and original generated-client controls require further review. Legacy uppercase
member status normalization remains an explicit storage adaptation. This branch
has not changed the robot runtime and does not close A-04.

## Root acceptance

The repaired candidate `486933265bc55444255832a1ed4563db3ee4a812` passed bounded root review and integration checks: 10 original Node 8 SDK operation checks through Account and Classic, 871 unit tests passed (7 skipped), and all 43 strict smoke cases matched. Root independently checked source transport behavior and 30 source/candidate/evidence hashes. See [review evidence](../evidence/2026-09-08/loop-agreements/review.json). This supersedes the pending-review status above for this bounded implementation. Live providers, full Mongo concurrency, deployment, and whole A-04 acceptance remain open.
