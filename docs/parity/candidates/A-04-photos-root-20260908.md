# A-04 member photo implementation in progress

Status: **controller/storage foundation only; not exposed through HTTP or deployed**.

Adds source-shaped update/remove photo functions and a local public-object
storage adapter. The controller authorizes an owner or robot, finds the member,
uploads the replacement, deletes any previous object, and saves the new URL.
Removal saves a null URL even if there was no previous object. Neither source
operation checks suspension, child status or normal member editability.
Completed binary effects remain completed if a later delete/save fails, while
failed persistence leaves the in-memory Loop and notification outbox unchanged.

The local adapter preserves stream bytes, atomically publishes completed files,
cleans up interrupted uploads and implements idempotent deletion. The public
URL is explicit configuration. HTTP serving and deployment wiring are pending;
the controller functions are not yet registered as callable wire operations.

Source: `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2`, LoopController photo methods and
LoopHandler binary/header registration. Jibo MCP also located
`jiborobot/srv-jibo-binary` at `4b193fde1679ecf2cb4e2d5e4aaec40098f724fc`;
its `src/index.js` supplies the createPublic/remove contract. That archive head
reports version 1.0.23; the Account dependency is a range starting at 1.0.6.
This is not a claim that archive head was the deployed dependency version.

The earlier source harness's `@jibo/binary` module is a constructor-only stub;
it cannot establish photo storage behavior and is not used as that authority.

Two focused tests pass, covering byte preservation, interrupted streams,
replacement/removal order, authorization failures, suspended child targets,
idempotent removal, save failure and outbox rollback. Private logs are in
`.parity/reviews/a04-photos-root-20260908/`. Next: source-compatible binary
parsing/limits, signature-preserving Classic forwarding, public retrieval,
header validation, original source/client controls and full regression checks.
No real household photos were read or modified. Whole A-04 remains open.
