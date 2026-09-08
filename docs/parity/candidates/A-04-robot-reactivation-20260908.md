# A-04 existing robot reactivation

Status: candidate awaiting independent review and final client verification.

The source `LoopController.findOrCreateRobotAccount` at `6cea434` always sets
`isActive = true` and saves the robot Account, including an existing account.
Phoenix previously returned an existing account without either step. Creating
a Loop for an inactive robot could therefore leave its credentials inactive.

The repair saves a detached account draft, preserving identity and keys. A
rejected Account save restores the prior in-memory account (or removes a new
uncommitted row). The source saves the Account before relocating or creating
Loops: if that later Loop save fails, the earlier successful Account save
remains. The old relocation test incorrectly required both to roll back; its
replacement asserts the source transaction boundary explicitly.

Three exact-source Node 8 query/save controls and three failing old-code
regression checks establish the difference. The repaired candidate passes 11
focused tests and the full 908-test suite (901 passed, seven skipped), followed
by the 43-case strict gate. These controls use synthetic fixtures; they do not
claim Mongo concurrency or real-robot reactivation acceptance.

See [candidate receipt](../evidence/2026-09-08/robot-reactivation-candidate/review.json).
