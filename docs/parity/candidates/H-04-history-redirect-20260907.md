# H-04 reviewed launch behavior

Root accepted the bounded release-mediation, launch/update/redirect and history
implementation at `1f9860366d19d4eebe123ac431d14318747d96a3`. The complete
H-04 task remains open.

Older report requests now launch the original release-appropriate skills and
memos. Successful initial and redirected requests receive separate history
records with their own sessions; failures are excluded. History uses the
speaker or `UNKNOWN`, and redirected request data omits ASR while the robot
notification preserves it.

The [root review](../evidence/2026-09-07/skill-launch/review.json) records 171
original Node 8 mediator controls, all nine original mediator tests, and 12
source HTTP launch controls. The history comparison improves from 3/12 to
12/12. Root captured actual source response emitters and retained failed
baseline observations. Integrated main passes 550 unit tests and strict43
with zero differences, invariants or gaps.

Validated generated IDs and measured timing values are separated from the
functional comparison. Error wording is nonblocking under the user's policy;
request fields, skill selection, final flags, sessions and side effects are
still compared. Full WebSocket/client lifecycle, trace propagation, close/reset,
complete continuation and robot acceptance remain open. No full-task checkmark
was added.
