# A-04 current integration review

Status: **bounded membership and list implementation accepted by root**.

Root accepted the combined candidate
`4d453eb8a85a0bebcac189a7dc643153d54ba35c`: record operations, member update
state/authorization, COPPA configuration, shared deleted-account authentication
and Loop list validation/visibility. Record and member client controls ran on
its unchanged membership parent `49b7cdfd84518dbd999a8bedbf8e48066a34e212`;
list controls ran on the final candidate. The integrated production source and dependencies
match that final tested candidate; one test has trailing whitespace normalized.

[Root acceptance evidence](../evidence/2026-09-08/loop-membership-list/review.json)
records 58 record-operation client calls, 22 member-update client calls, six
COPPA profiles with 18 source/candidate comparisons, and 66 list SDK/raw
controls. The full combined suite passed 868 tests and the strict 43-case gate.

Mail/invitation-event effects remain under implementation. The guardian and
agreement candidate is undergoing independent review in its own branch.
Mongo behavior, remaining operations and full lifecycle acceptance remain
open. This integration does not deploy the new code to the robot. Whole-task
progress stays at 8 of 79 verified tasks (10.1%).
