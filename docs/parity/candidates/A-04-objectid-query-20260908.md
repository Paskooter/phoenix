# A-04 candidate: source-compatible ObjectId query casing

Status: **candidate; unverified pending root review.** This is a bounded query
and identifier comparison repair. It does not close A-04.

## Source contract

The source pin is `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
The retained source files are under
`.parity/reviews/a04-robot-lookup-source-20260908/source-6cea/`:

- `base.loop.ctrl.ts:7-12` calls `Loop.findById(loopId)` and reports
  `LOOP_NOT_FOUND` only when that query resolves no document.
- `loop.ts:56-64` declares Loop `_id`, `owner`, and `robot` as Mongoose
  `ObjectId` paths. Member account and member IDs are ObjectId paths too.
- `loop.ctrl.ts:155-184` passes the handler's `loopId` directly to the update
  and list queries; `loop.ctrl.ts:578-584` does the same for `getRobot`.
- `loop.handler.ts:52-74` uses `Joi.string()` for `UpdateLoop` and `ListLoops`,
  so a valid uppercase string is accepted and forwarded without an ID
  canonicalization step.

The pinned Mongoose 4.9.8 control retained by root in
`.parity/reviews/a04-objectid-query-root-20260908/source-cast.json` shows a
valid 24-hex query cast to the lowercase ObjectId representation and
`ObjectId.equals()` accepting the uppercase spelling. The generated client
3.0.110 also forwards the string unchanged: its Loop model has no ID-specific
wire format, and `lib/query/query_param_serializer.js:68-78` serializes the
provided value without lowercasing it.

## Candidate change

`packages/account/src/id.js` provides the shared source boundary:

- `mapGetById` first retains an exact Map lookup, then performs a bounded
  case-insensitive scan only when the requested value is a string containing
  exactly 24 hexadecimal characters.
- `idsEqual` honors an ObjectId-like `.equals()` method, otherwise compares
  values exactly and applies the same 24-hex-only case folding.
- Friendly IDs, emails, UUID-like values, 12-byte strings, and invalid
  ObjectId-looking strings remain case-sensitive and are never rewritten.
  Map keys are not mutated.

The helper is used at the public Loop query/comparison boundaries in
`loopMembership.js`, `robotFace.js`, `robotLookup.js`, `loopMemberPhotos.js`,
and `loopAgreements.js`. This covers record, membership, profile, photo,
guardian, list, robot lookup, suspension, and OOBE reconnect lookups that
accept or compare Loop/Account ObjectId values. Existing friendly-ID matching
stays exact.

## Evidence

The pre-repair candidate witness in
`.parity/reviews/a04-objectid-query-root-20260908/candidate.json` returned
`LOOP_NOT_FOUND`/404 for uppercase `UpdateLoop` and accepted the lowercase
spelling. On this candidate, a deterministic signed Account HTTP listener
accepted uppercase `UpdateLoop`, `ListLoops`, `GetRobot`, and `SuspendLoop`
requests and updated the lower-case stored record. The focused test also
asserts that friendly IDs and non-24-hex identifiers do not gain case-folded
matching.

The exact source handler and generated-client controls ran independently under
Node `v8.9.4`:

- The decorated source `LoopHandler.UpdateLoop` accepted
  `ABCDEFABCDEFABCDEFABCDEF` and passed that exact string to its controller
  seam.
- The original generated client 3.0.110 sent the exact JSON body
  `{"loopId":"ABCDEFABCDEFABCDEFABCDEF","name":"source client casing"}`
  with target `Loop_20160324.UpdateLoop` to a controlled local HTTP peer.

The source/client commands, exits, source/runtime identities, and sanitized
output hashes are retained in
`.parity/reviews/a04-objectid-query-candidate-20260908/receipt.json`.

Candidate worktree tests:

```text
node --test packages/account/test/loopObjectId.test.js \
  packages/account/test/loopInvitationProviders.test.js
# exit 0; 4 tests passed

node --test packages/account/test/*.test.js
# exit 0; 232 tests passed, 0 failed
```

The worktree has its own installed dependencies and `@phoenix/*` workspace
links. No main branch, robot, live service, source cache, golden, or private
household data was changed.

## Limits

The source Mongoose cast control is a real pinned runtime check, while the
candidate uses a file-backed Map and has no Mongoose dependency. Mongo indexes,
duplicate ObjectId prevention, query planner ordering, and persistence under a
real Mongo server remain outside this slice. Twelve-character Mongoose cast
semantics and invalid ObjectId cast errors are intentionally not generalized:
the evidence only establishes the valid 24-hex case, and Phoenix's legacy
opaque IDs must retain exact matching.

Internal Settings peer routes and unrelated Account/portal lookups still use
their existing exact string boundaries; they are outside the A-04 public Loop
operation slice and were not silently counted as repaired. Full A-04 lifecycle,
public deployment, and robot acceptance remain open.
