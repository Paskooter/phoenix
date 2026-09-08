# A-04 pending implementation reviews

Main contains accepted guardian/agreement and membership-list work. Moth is
on `0998f79`, verified with eight installed-client read-only checks and two
synthetic public-photo ingress checks. The candidates below are separate worktrees;
passing a candidate check does not mark the whole lifecycle verified.

| Candidate | Revision | Current evidence and remaining work |
| --- | --- | --- |
| Photos | `4e581d0` | Accepted and integrated into main after source/client/Docker checks and 876 unit passes. Deployed on Moth with read-only client and synthetic public-photo ingress checks passed; full lifecycle remains open. |
| ListLoopMembers | `660fe838` | Accepted after source/client/integration checks; deployed with installed-client membership/filter checks passed. |
| Invitation transport | `9e8bc5b` | STARTTLS/AUTH, sender Promise boundary, Unicode and long ASCII MIME repairs submitted. Strict relay control reproduced the old failure and passes with matching decoded source content after repair. Root verified 15 long-line evidence/product hashes; final integration acceptance pending. |
| Membership events | `19cace3` | Three original event payloads match; 873 tests pass, 7 skipped. Independent controller/client review and transport dependency acceptance pending. |
| CreateLoop gate/event | `eaa6724` | Eight original controller controls, ten original SDK calls, ten HTTP peer checks; 874 tests pass, 7 skipped. Independent review and dependency acceptance pending. |

Root verified all 27 photo review artifact hashes. Photo acceptance requires
normal deployment to supply durable storage and robot-reachable public URLs.
The combined candidate now passes seven original-client public HTTPS checks
with normal Account startup, including exact object bytes and persistence
after an Account restart. The first test attempts exposed a harness watchdog
and a Node 8 helper signature issue; both are preserved in the qualified
[public TLS evidence](../evidence/2026-09-08/photo-public-tls/review.json).
[Root photo acceptance](../evidence/2026-09-08/photo-acceptance/review.json)
records the subsequent full suite: 876 passed, zero failed, seven skipped after
the five observed synthetic test helpers were repaired. Production code matches
the strict-gate and original-client candidate.
The strict gate matches all 43 cases. Earlier full default and serial candidate suites
each report 874 passed, two failed, and seven skipped. Root reproduced the
same idle-connection reset mechanism on unchanged main; those suite failures
remain recorded and are not converted into passing results.
Hashless binary staging remains an explicit extension; the original generated
client sends a body hash. The exact deployed binary dependency version is still
unresolved. See [photo review](../evidence/2026-09-08/photo-independent-review/review.json).

CreateLoop original-client calls used Node 8.9.4 and client 3.0.110 against
Account and Classic with a synthetic local robot-read peer. Four successful
creations produced four creation events and four save events. Explicitly
suspended robots, invalid credentials, and missing fields left state unchanged.
See [client evidence](../evidence/2026-09-08/create-original-client/review.json).

No real provisioning, family data, or live mail was used in these controls.
The verified checklist remains 8/79 (10.1%).

## Account events and robot notifications

The pinned notification service `e42bfe01506a8febf3005ac536fda735bba49d0d`
registers 16 event handlers. It has no direct handler for `InvitedToJoinLoop`,
`InvitationToLoopAccepted`, `InvitationToLoopDeclined`, `MemberRemovedFromLoop`,
or `LoopCreated`. Missing direct robot delivery of these five events is
therefore not a parity defect at this service boundary. General event
publication remains required; this finding does not exclude consumers in
other services.

Household saves separately emit `LoopUpdated`. Its source handler targets
`evt.payload.robot`, uses skill ID `-1`, and forwards the event payload under
notification name `LoopUpdated`. Phoenix uses that same mapping in
`packages/account/src/loopUpdatedOutbox.js`; installed-client checks and the
earlier canonical robot KB readback cover separate portions of its delivery.
This does not establish an on-screen notification indicator. See
[event registration evidence](../evidence/2026-09-08/event-routing/review.json).

The invitation transport review instead requires repairs for substantive
SMTP negotiation and the event sender Promise boundary: synchronous storage
errors must become rejected delivery promises so the completed membership
save does not incorrectly turn into an HTTP failure. The transport and Promise-boundary repairs are submitted as candidates.
Root verified the long-line repair after a strict relay accepted the source,
rejected the old candidate, and accepted the repaired candidate with matching
decoded content. Incidental MIME formatting differences do not block acceptance.

The combined invitation branch at `649da10` includes the MIME repair and
source-compatible robot-read timeout/redirect/body handling from `1565dbd`.
Root focused checks pass 21/21. Before those repairs, the strict gate matched
43 cases and the Account suite passed 216/218; socket diagnostics reproduced
idle-connection failures. Source event invocation ordering and a test-only
connection harness repair remain under review. No full lifecycle acceptance
or hardware/provider deployment is claimed.
