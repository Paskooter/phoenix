# A-04 member photo implementation in progress

Status: **HTTP/storage candidate implemented; original-client verification and independent review pending; not deployed**.

Adds source-shaped update/remove photo functions and a local public-object
storage adapter. The controller authorizes an owner or robot, finds the member,
uploads the replacement, deletes any previous object, and saves the new URL.
Removal saves a null URL even if there was no previous object. Neither source
operation checks suspension, child status or normal member editability.
Completed binary effects remain completed if a later delete/save fails, while
failed persistence leaves the in-memory Loop and notification outbox unchanged.

The local adapter preserves stream bytes, atomically publishes completed files,
cleans up interrupted uploads and implements idempotent deletion. The public
URL is explicit configuration through `loopConfig.server.photoBaseUrl` and optional
`photoDirectory`, or an injected provider. Account serves public bytes at
`GET /member-photos/:key`. Both photo operations are registered on the public
Loop face. Deployment configuration remains pending.

Source: `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2`, LoopController photo methods and
LoopHandler binary/header registration. Jibo MCP also located
`jiborobot/srv-jibo-binary` at `4b193fde1679ecf2cb4e2d5e4aaec40098f724fc`;
its `src/index.js` supplies the createPublic/remove contract. That archive head
reports version 1.0.23; the Account dependency is a range starting at 1.0.6.
This is not a claim that archive head was the deployed dependency version.

The earlier source harness's `@jibo/binary` module is a constructor-only stub;
it cannot establish photo storage behavior and is not used as that authority.

The initial two controller/storage tests pass, covering byte preservation, interrupted streams,
replacement/removal order, authorization failures, suspended child targets,
idempotent removal, save failure and outbox rollback. Private logs are in
`.parity/reviews/a04-photos-root-20260908/`. The HTTP increment adds request-scoped raw parser selection, streaming Classic
forwarding, header validation, public retrieval and removal. Original Hapi
16.4.1 under Node8 preserved exact stream bytes for seven content/body cases,
including invalid JSON labeled application/json. Ten focused common/auth/photo
checks pass. The full suite passes 871 tests, with seven skipped and no failures. Uploads with declared hashes retain source verifier semantics;
requests without that header are hashed while spooling to private disk and
verified without adding a synthetic signed header. The temporary body is removed
after completion or authentication failure.

Next: original generated-client controls, actual source controller photo
controls, one-gigabyte limit/error framing, interrupted HTTP uploads, and
independent review.
No real household photos were read or modified. Whole A-04 remains open.
