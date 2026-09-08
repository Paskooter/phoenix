# A-04 CreateLoop robot gate and creation event

Status: **implemented candidate; pending independent review and integration**.
Base: membership-event candidate `19cace36afb88a33a48658d6fa0673d1c9f61789`.

Account source `6cea43470825657d6a5722162f28c8f233153ee2`,
`LoopController.create` and `src/clients/robot.client.ts`, checks robot-read
before creating or relocating account state. A read failure is tolerated;
only a literal `robot.payload.suspended === true` rejects creation with
`ROBOT_DISABLED` (409). A successful populated save precedes `LoopCreated`.
Event delivery rejection is contained after that save.

The candidate adds an injectable robot-read client and the configured
`NET_robotread` peer. Its POST uses `Robot_20160225.GetRobot`, `{id: friendlyId}`,
and the original trusted peer admin-credential header. An unconfigured peer
rejects the lookup, which creation tolerates as the original does. This does
not implement the separate robot-read service. JSON MIME responses are parsed;
text MIME remains bytes, matching the source Wreck smart JSON boundary.
The membership dispatcher now returns asynchronous results through the HTTP
service so responses wait for the robot check and cannot complete early.

Validation:

- Exact compiled source controller under Node 8.9.4: eight controls covering
  missing ID, missing/failed lookup, true/string suspension, success, failed
  save, and rejected event delivery. Robot/account/relocation/save/event seams
  are controlled; no full Mongo claim.
- A local HTTP robot-read peer verifies target, trusted peer credentials, and
  payload through Account and Classic. Ten creation requests cover explicit
  suspension, success, provider rejection, string suspension, and text MIME.
- Full candidate suite: **874 passed, 7 skipped, 0 failed**.

Synthetic receipts are under `.parity/reviews/a04-create-root-20260908/`.
No real robot was provisioned, suspended, or moved. Original generated-client
controls, independent review, integration with current main, robot-read service
parity, transport dependencies, and whole A-04 acceptance remain open.
