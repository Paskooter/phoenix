# A-04 current candidate review

Status: **awaiting completion of root review; not deployed**.

The combined candidate `49b7cdfd84518dbd999a8bedbf8e48066a34e212` contains
UpdateLoop, RemoveLoop, ClearRobot, UpdateLoopMember, COPPA configuration
and shared authorization corrections. Root verified the record-operation
client layer: 58 original Node 8 client calls, persisted synthetic state,
expected errors, and 87 correctly hashed signed requests across Account and
Classic. The combined suite passed 866 tests and the strict 43-case gate.
See the [bounded client review](../evidence/2026-09-08/loop-record-client/review.json).

The follow-up candidate `4d453eb8a85a0bebcac189a7dc643153d54ba35c` restores
ListLoops payload validation, accepted/invited member visibility, and source
robot inference after optional loop selection. Root's 15 focused tests, 868
full-suite tests and the strict 43-case gate pass. Six exact original Node 8
controller controls confirm the query and robot-selection rules using
controlled model/population seams. Original-client list verification is pending.

Both candidate branches are published to GitHub and Gitea. Original-client
UpdateLoopMember/COPPA review and invitation side-effect implementation remain
active. Source Mongo behavior, remaining Loop operations, and full lifecycle
acceptance remain open. None of these candidates changes the currently deployed
robot runtime. Whole-task progress stays at 8 of 79 verified tasks (10.1%).
