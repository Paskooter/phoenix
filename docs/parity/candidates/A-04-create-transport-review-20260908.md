# A-04 CreateLoop robot-read transport follow-up

Status: **candidate; pending root review**.

Base: `eaa67241d1908916fd6525105a27a9c8e62e5c6e`.

The pinned MCP source `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2` implements `RobotClient` by
extending `@jibo/server` `BaseClient`, constructing
`http://${registry.get("robotread")}/`, and calling `wreckPost` with the
`Robot_20160225.GetRobot` target, the JSON `{isAdmin:true}` internal credential
header, and `{id:friendlyId}`. The source controller still checks robot state
before account lookup/relocation/save and tolerates every robot-read rejection;
only `payload.suspended === true` rejects creation.

The follow-up fixes the candidate's internal `RobotReadClient` to match the
observable Wreck transport boundary. It sends raw JSON bytes so fetch does not
invent a `Content-Type` header, applies the source 60-second header deadline
from `ETCO_server_http_timeout` (kept across redirects and cleared after final
response headers, before body read), preserves POST through 301/302/307/308,
and enforces the source `ETCO_server_http_maxredirects || 3` limit. Smart JSON
uses the same pinned Wreck MIME expression; an empty JSON response returns
`null` like `Wreck.read`.
The peer remains an internal configured `NET_robotread` service; the
`x-amz-credentials` value is a trusted internal service header, not public
caller authentication or SigV4 verification.

The baseline source capture and source notes are under
`.parity/reviews/a04-create-independent-review-20260908/`; the follow-up
receipts are under `.parity/reviews/a04-create-transport-followup-20260908/`:

- Node 8.9.4 source-Wreck control: 10 cases (MIME, empty/malformed/status,
  redirect and deadline) wrote `source-wreck-robot-read-node8.json`. The
  outer Docker command exited `124` while `--rm` cleanup stalled under host
  I/O; the container executed the script and wrote the complete Node 8 output.
  A later Node 8-only rerun that added the redirect-deadline mode was stopped
  after the named container remained in Docker `Created` during a daemon I/O
  stall; it produced no output and is retained as a failed attempt. The same
  pinned wrapper exited 0 on host Node 22 for an independent 11-mode receipt,
  including the redirect-deadline case.
- Candidate transport regression: 4 tests pass, covering request headers and
  target/body, smart JSON and empty bodies, one redirect and the four-hop
  limit, a shared header deadline across redirects, header timeout versus slow
  body, and recovery after timeout.
- Existing base evidence remains applicable: 8 exact Node 8 controller seam
  cases, 10 generated SDK calls through Account/Classic and 874 passed / 7
  skipped / 0 failed base candidate tests.

The focused combined candidate run passed 5/5 tests. The follow-up candidate
wire receipt passed 9 modes and recovery with 15 requests. No real robot,
account, live provider, or service was used. Fetch still adds generic client
headers (`Accept`, user agent, and encoding) that Wreck did not; the controlled
peer ignores them, and no source caller interprets them. Internal rejected-read
error object metadata is qualified: candidate errors carry ordinary Error
fields (and timeout `ETIMEDOUT`) while source Wreck returns Boom-shaped
objects; `CreateLoop` catches both classes as the source does.

One separate integration qualification remains outside this transport repair.
The candidate's accepted durable `LoopUpdatedOutbox.record` starts its
publisher during `saveLoop`, and an isolated control observed
`LoopUpdated` before `LoopCreated`. Source `loopSchema.post('save')` schedules
the LoopUpdated send with `setImmediate` (pinned `srv-account-ws` `index.ts`,
lines 75-116), after `create` sends LoopCreated. This follow-up leaves that
shared outbox/event region unchanged; root should decide whether delivery order
is part of the deployed notification contract.

Full robot-read service implementation, public gateway authentication, and
whole A-04 acceptance remain open.

The package-wide regression attempt under shared host I/O pressure produced
210/212 in a serialized run (the two failures were existing listener fetch
resets in `ListLoopMembers` and `ListOwnerRobots`); the changed transport and
`loopMemberUpdate` rerun passed (6/6). This transport follow-up's focused
tests are the relevant gate for the changed module.
