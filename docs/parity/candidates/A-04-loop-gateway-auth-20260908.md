# A-04 candidate: shared public Loop authentication

Status: **root implementation candidate; original-client review and integration pending.** A-02 and A-04 remain open.

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
