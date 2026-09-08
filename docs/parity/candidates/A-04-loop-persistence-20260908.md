# A-04 loop persistence failure isolation (root accepted subset)

Status: root accepted for bounded failure isolation after independent review.
Candidate `acbcb22a6991b7a801ab12a7dd2ccbd25327d1c0` is based on `fbc27c4`.
This increment has not been deployed or exercised against a robot.

The six public membership operations use one mutable object from the Phoenix
`Store` map. Before this change, a membership edit changed that shared object,
then `saveLoop` took its rollback snapshot. If the LoopUpdated outbox or the
store flush failed, the snapshot already contained the rejected edit. The
failed request could therefore leave a changed loop in memory even though the
last JSON snapshot was unchanged.

The candidate creates a pre-mutation snapshot and a separate loop draft for
each existing-loop save in Create relocation, Invite (new and existing
members), Accept, Decline, and Remove. `saveLoop` restores the previous map
object when recording the save fails. Create still leaves a robot Account that
was successfully saved before a later Loop save failure; it does not add an
account rollback transaction that the source operation does not have. Multiple
relocated loops retain earlier successful saves if a later per-loop save
fails. ListMembers remains read-only and is covered as such.

The source contract used for the implementation is the exact MCP read of
`jiborobot/srv-account-ws/src/controllers/loop.ctrl.ts` at
`6cea43470825657d6a5722162f28c8f233153ee2`. Its `saveAndPopulate` calls
`loop.save()` before population; Create saves the robot Account before
`removeRobotFromLoops` and the new Loop; relocation saves each loop in order;
membership methods mutate then save one Loop. The existing local source-method
harness under `a04-source-methods-20260907` executes revision `b525601...` and
is not presented here as a byte-identical 6cea execution. No private household
data is used.

Focused controls are in
`packages/account/test/loopMembershipPersistence.test.js`:

* an injected outbox failure covers Create relocation, Invite new/existing,
  Accept, Decline, and Remove, checking the shared object, map, committed
  bytes, reload, and empty outbox;
* a failed new Loop save confirms the separately committed robot Account stays
  while the Loop does not;
* a two-loop relocation failure confirms the first successful save remains and
  the later failed save is restored;
* ListMembers is checked for no state change, and an injected `Store.flush`
  failure checks the real LoopUpdatedOutbox rollback and reload bytes;
* an HTTP RemoveLoopMember request returns the injected AWS error and leaves
  state and disk unchanged after reload.

Validation run in this worktree:

```text
node --test packages/account/test/loopMembershipPersistence.test.js
5 passed, 0 failed

node --test packages/account/test/loopMembership.test.js
8 passed, 0 failed
```

The controls use synthetic Maps, a temporary JSON store, and a loopback HTTP
listener. They do not prove Mongo/Mongoose failure behavior, provider or mail
delivery, process crashes between filesystem operations, or live robot
acceptance. Root reproduced four failing controls against the preceding implementation
and all five passing with the repair. Thirteen focused and existing membership
tests pass together. The combined profile/persistence integration passes 826
unit tests with eight skips, plus the strict 43-case smoke gate with no
differences. Broader A-04 parity remains open.
