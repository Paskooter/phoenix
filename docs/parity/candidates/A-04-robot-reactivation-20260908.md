# A-04 existing robot reactivation

Status: root accepted for the bounded Account activation/save boundary;
deployment and whole A-04 remain open.

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

Root verified the independent review (ten focused checks and 11 artifact/source
hashes), then accepted the change after eight original Node 8 client checks
across Account/Classic and service/store restart. Credentials were rejected
while inactive and accepted after creation with the same identity and keys.

The source may retain its mutated request-local document when save rejects.
Phoenix restores its shared Store map to the last committed account. This is
an internal reference difference, not a claim that the source rewinds its
request-local object. The client and persistence checks cover the external
behavior of this repair.
