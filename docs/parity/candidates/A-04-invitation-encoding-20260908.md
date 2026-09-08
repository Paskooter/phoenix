# Invitation-code encoding repair

Root accepted within the token-encoding scope; complete A-04 remains open.

Pinned Account source `6cea43470825657d6a5722162f28c8f233153ee2` uses
`Token.getRandomCode()` in Loop invitation creation and email assignment.
The token schema uses `bs58.encode` on five random bytes. The source was
rechecked through the Jibo MCP; its locked encoder packages are covered by
the [root token review](../evidence/2026-09-08/oobe-integration-root/review.json).

Phoenix had a separate integer encoder in `loopMembership.js` that discarded
leading zero bytes. The regression failed before the repair: five zero bytes
produced `1` instead of source `11111`. Both invitation paths now use the
shared, source-verified `newTokenId` encoder.

The regression exercises six archived encoder vectors through invitation
creation and subsequent email assignment, including disk reload. It restores
the synthetic crypto seam after execution. Thirteen focused invitation, member
update and service-token tests pass. This does not establish mail delivery,
concurrent lifecycle parity, or native robot acceptance.

The frozen product revision `a5d04b5` also passed 924 tests with seven skips
and the strict 43-case smoke gate. See the [integration result](../evidence/2026-09-08/invitation-token-encoding/review.json).
