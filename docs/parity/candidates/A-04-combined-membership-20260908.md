# A-04 combined membership review

Status: **implementation review in progress; not deployed or fully verified**.

This integration combines the reviewed public Loop authentication with the
isolated candidates for UpdateLoop, RemoveLoop, ClearRobot, UpdateLoopMember,
and source COPPA configuration. Original-client verification of the new
operations and provider effects remains acceptance work. A-04 remains open.

Root resolved the overlapping changes by retaining one shared public Loop
signature check, preserving primitive bodies for each newly validated handler,
and passing the source COPPA configuration through the service constructor.
The shared boundary now excludes deleted accounts, matching the source
AccountController access-key query, and retains the verified account for
membership authorization. The redundant member-update signature check was
removed. Generic credential-lookup error-code mapping remains under separate
source/client review; these controls establish rejection and preserved state.

Source: `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2`,
`src/controllers/account.ctrl.ts`, `findByAccessKeyId` explicitly filters
`isDeleted: {$ne:true}`. The public gateway source and the individual operation
pins are recorded in their linked candidate reports.

Root verification:

- Record operations plus existing membership checks: 17 passed.
- Combined Loop tests, including COPPA and public authorization: 62 passed.
- Full suite: 866 passed, seven skipped, zero failed.

The combined candidate has not changed the deployed robot or household. Mail
and invitation-event providers, remaining Loop handlers, Mongo-specific
behavior, and full lifecycle parity remain open. Passing these tests does not
close a checklist task.
