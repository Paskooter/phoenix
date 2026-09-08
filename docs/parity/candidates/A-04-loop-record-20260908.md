# A-04 Loop record operations

Status: **candidate, unverified pending root review**.

This candidate is based on `d7934a6d1fb6ef92187bf6a2c54034aca4b3d295`
(`main` at worktree creation). It adds the three record operations that were
still absent from the Phoenix Classic Loop dispatcher:

* `Loop_20160324.UpdateLoop` validates required string `loopId` and `name`,
  checks the owner, rejects a suspended loop, saves the new name, and returns
  `{ "result": "Command accepted" }`.
* `Loop_20160324.RemoveLoop` validates `loopId`, permits the owner only (the
  source handler passes `isAdmin: false`), does not require suspension, marks
  the Loop deleted, clears its `robot` relation, and returns the populated Loop.
  Members and the robot Account remain stored.
* `Loop_20160324.ClearRobot` requires an administrator and `robotId`, resolves
  the robot by friendly ID, resolves its active Loop, and delegates the same
  soft removal with `isAdmin: true`. A missing robot or missing active Loop
  returns `ROBOT_NOT_FOUND`.

The source controller is `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
The source files used for this candidate are the saved MCP snapshot under
`.parity/reviews/a04-member-profile-review-20260908/source-6cea`:

| Source file | SHA-256 | Relevant lines |
| --- | --- | --- |
| `loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` | `53-63`, `207-225` |
| `loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` | `155-165`, `567-576`, `597-600`, `771-779` |
| `base.loop.ctrl.ts` | `b85870f98589aa5c932d5b14942cae803cba355b7f8c15aacea2925192b1f3d9` | `7-13` |
| `loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` | `56-74`, `93-108` |
| `index.ts` | `75adaa214617ea1d017831cc1dde1001490f155538ab06c3c75c618431c1dda1` | `74-115` |

`LoopController.update` assigns the name before its suspended-loop guard, but
does not save when suspended. Phoenix Store values are shared plain objects,
so the candidate checks that guard before mutating a detached draft. This keeps
the failed request from exposing a name that the source Mongoose request would
not persist. Successful saves use the existing LoopUpdated outbox transaction
and preserve the pre-mutation object on an outbox failure.

The source startup hook in `index.ts` schedules `LoopUpdated` after every Loop
save, including the save performed by removal. The existing Phoenix outbox
cannot route an update after `robot` has been cleared, so a successful
RemoveLoop/ClearRobot save has no outbox row when no robot target remains. The
soft-deleted Loop and its source members are still persisted. External
EventSender delivery is not claimed by this candidate.

Focused synthetic controls are in
`packages/account/test/loopRecord.test.js`. They cover successful and denied
UpdateLoop, missing and suspended loops, required-field validation, owner-only
RemoveLoop, removal of a suspended loop, persisted soft deletion and reload,
admin-only ClearRobot, unknown/no-loop robots, preserved members, and rejected
outbox writes for all three mutations. Six tests pass in Node 22. The test
identities and loop data are invented; no robot, Mongo process, source service,
or household data is used.

Remaining qualification: this worktree uses the Phoenix JSON Store and its
AWS-JSON compatibility face rather than Mongo/Mongoose and the original Hapi
decorators. The candidate has not been exercised against the original Node 8
service or a real robot client. Source event construction/delivery, Mongo
casting, and deployment authentication remain open for root review.
