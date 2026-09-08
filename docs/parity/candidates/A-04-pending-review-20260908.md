# A-04 implementation review status

Root accepted the combined invitation candidate `db4cdf8`: invitation mail and
event effects, membership lifecycle events, CreateLoop robot-read transport,
and deferred LoopUpdated publication. The full suite passed 896 tests with
seven skips; the strict gate matched 43 cases. The original Node 8 client
completed 20 lifecycle calls across Account and Classic. Root verified 52
artifact/source hashes and reproduced the lifecycle verifier.
See [acceptance evidence](../evidence/2026-09-08/invitation-acceptance/review.json)
and [client evidence](../evidence/2026-09-08/invitation-lifecycle-client/review.json).

The exact source defers LoopUpdated with setImmediate and awaits account reads
before LoopCreated. Root reproduced both relative sender orders with immediate
and delayed population. No universal sender or network arrival order is claimed.
Earlier failed captures and setup attempts remain qualified in the evidence.

Photos and membership-list changes were previously accepted and deployed.
Moth now runs `9672467`, with eight installed-client read-only checks passing
before and after deployment, all six services healthy and the complete
household store preserved. Invitation mail remains unconfigured on Moth. The newer candidate also passed
six installed Node 6 client photo checks against an isolated synthetic backend.
Completing the remaining A-04 state, failure and persistence coverage remains
open. Full checklist progress
is still 8/79 (10.1%); accepted pieces do not complete the entire lifecycle task.

## Account events and robot notifications

The pinned notification service `e42bfe01506a8febf3005ac536fda735bba49d0d`
registers 16 event handlers. It has no direct handler for InvitedToJoinLoop,
InvitationToLoopAccepted, InvitationToLoopDeclined, MemberRemovedFromLoop,
or LoopCreated. General event publication remains required; missing direct
robot delivery of those five events is not a defect at this service boundary.
Other services may consume those events.

Household saves separately emit LoopUpdated. Its source handler targets the
robot account, uses skill ID `-1`, and forwards the event payload under
notification name LoopUpdated. Installed-client checks and earlier canonical
robot KB readback cover separate portions of delivery. This does not establish
an on-screen notification indicator. See
[event registration evidence](../evidence/2026-09-08/event-routing/review.json).

All invitation provider controls used synthetic households and local peers.
No real mail or family mutations were used for this acceptance.
