# A-04 candidate: shared public Loop authentication

Status: **root accepted bounded implementation; real robot acceptance pending.** A-02 and A-04 remain open.

The existing Loop dispatcher resolved an account from the access-key identifier
without verifying the request signature. A synthetic baseline control showed
that `ListLoops` returned a household with an incorrect secret. This violated
the source gateway boundary even when individual handlers checked ownership.

The shared public Loop dispatch now uses the existing source-backed SigV4
verifier before handler execution. Wrong signatures, unknown keys, inactive
accounts, and unsigned requests are rejected before household reads or writes.
Caller-supplied `x-amz-credentials` cannot authorize a request. Account and
Classic preserve parsed Loop JSON values so signature verification runs before
handler validation; malformed JSON remains a parser error.

The source is `jiborobot/srv-security-gw` at
`43a692fe7670660aaed6ab5979c6c83039eb711c`,
`src/controllers/auth.ctrl.ts` (SHA-256
`776c0908cbb5e842fe7866e7d1e6640578c390d604536c76652707b50785881d`).
Its unsigned-method list is empty. Only the exact Loop targets
`AcceptInvitationByCode`, `DeclineInvitationByCode`, and `UpdateAgreementStatus`
under `Loop_20160324` permit absent authorization. Supplied authorization is
verified even for these exceptions. This preserves the policy for those
currently unimplemented targets without claiming their handlers exist.

Existing membership, enrollment, household-bootstrap, suspension, persistence,
and notification integration tests now use real signatures from invented
fixture credentials. An explicit boundary test covers six read/mutation
operations through Account and Classic, checking wrong secrets, forged internal
metadata, inactive accounts, unchanged durable and in-memory household state,
and unchanged outbox state. Signed robot household reads remain successful.
The original notification integration test now expects the gateway's 401
`ACCESS_KEY_NOT_FOUND` for an unknown signer before suspension authorization.

Validation so far: 829 unit tests passed, seven skipped, zero failed. The new
boundary control reproduces the missing verification against the main baseline.
All fixtures are synthetic. Original Node 8 client replay, combined candidate
integration, and live robot verification are separate acceptance work; no real
household or deployment was modified. This change does not claim authentication
parity for non-Loop services or completion of the internal handler contracts.

## Root acceptance

The original generated client on Node 8 completed 36 signed calls through
Account and Classic, plus eight raw anonymous-policy controls. Root checked
68 expected outcomes and saved-state properties, all passing. The combined
lookup/authentication package tree at `4d55637` passed 839 unit tests with
seven skips and all 43 strict smoke cases. These controls verify this request
boundary; they do not claim completion of all Loop handlers or all services.

See [the acceptance receipt](../evidence/2026-09-08/loop-gateway-auth/review.json).
