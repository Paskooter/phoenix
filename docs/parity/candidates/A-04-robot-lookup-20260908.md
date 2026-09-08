# A-04 candidate: robot lookup operations

Status: **root accepted bounded implementation; A-04 remains open.**

This isolated candidate adds `Loop.GetRobot`, `Loop.FindOwner`, and
`Loop.ListOwnerRobots` to the Classic AWS-JSON dispatcher. It is based on
`d7934a6d1fb6ef92187bf6a2c54034aca4b3d295` and has completed root software review. Live robot acceptance remains pending.

## Source contract

The implementation follows the pinned source files from
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`:

| Source file | SHA-256 |
| --- | --- |
| `src/handlers/loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| `src/controllers/loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `src/controllers/base.loop.ctrl.ts` | `b85870f98589aa5c932d5b14942cae803cba355b7f8c15aacea2925192b1f3d9` |
| `src/schemes/loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| `src/schemes/account.ts` | `1d69c02223ec3df088bbfa10c1ff1c8b29a4f003f9229fa89f3c531ee1f3b2c5` |

The generated API model is
`jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`,
`apis/loop-2016-03-24.normal.json` (the archived minified copy used by the
workspace has SHA-256
`1f3731c87e5f5173361ba7f817cc843818693133ef3310640b03c7bf38be3e5e`). The
model declares `GetRobot`'s `accessKeyId`, `secretAccessKey`, and `friendlyId`
output fields, `ListOwnerRobots` as a string list, and an object result for
`FindOwner`.

The relevant source lines are:

- `LoopHandler.ListOwnerRobots` (handler lines 186–193) validates an optional
  `accountId`, otherwise uses parsed credentials, and calls `listRobots`.
- `LoopHandler.GetRobot` (lines 195–205) requires `loopId`, authorizes with the
  parsed owner ID, and calls `toJSON({ unsafe: true })` on the robot account.
- `LoopHandler.FindOwner` (lines 244–249) requires `accountId` and has no
  credential decorator.
- `LoopController.list` (lines 167–197) queries active loops for an owner or
  accepted/invited member. If the requested identity is itself a robot, it
  keeps only that robot's active, unsuspended loop.
- `LoopController.getRobot` (lines 578–584) finds the loop before checking its
  owner, then loads the related account.
- `LoopController.listRobots` (lines 585–595) preserves query order and returns
  each related account's `friendlyId`.
- `LoopController.findOwnerId` (lines 622–625) uses an `$or` for member account
  ID or owner ID and returns `{ id: loop && loop.owner }`.
- `BaseLoopController.findById` (lines 7–13) and the Loop schema middleware
  (lines 93–102) exclude missing and soft-deleted loops before lookup.

## Candidate behavior

`GetRobot` first verifies the public SigV4 request and active account using
the existing source-backed verifier. It then validates a nonempty string
`loopId`, resolves the loop, and checks the authenticated account is its owner. It returns the three generated `RobotAccount` fields,
including the robot secret required by the source's unsafe serialization. An
unknown or deleted loop returns `LOOP_NOT_FOUND` (404) before an owner check;
an existing loop with a non-owner caller returns
`CAN_BE_ACCESSED_BY_OWNER` (403). A stale robot relation follows the source's
unguarded `robotAccount.toJSON` boundary as a generic 500
`InternalFailure`; `ROBOT_NOT_FOUND` is reserved for the separate source
`ClearRobot` operation.

`FindOwner` validates a nonempty `accountId`, then scans active loops in store
order for an owner or any member account ID. Member status is deliberately not
filtered, matching the source query, so a removed membership can still resolve
the active loop owner. No match serializes as `{"id":null}` because Mongoose `findOne` resolves
to null and the source preserves that value. The internal query does not use caller credentials; the public route still
requires a valid signed request.

`ListOwnerRobots` accepts an optional nonempty string `accountId`; when present
it selects that query identity even if it differs from the signed caller, as in
the source handler. Otherwise it uses the caller's stored access-key identity.
Active loops owned by or joined through an accepted/invited member are visible.
Owners see their active loops in insertion order, including suspended loops;
when the requested identity is a robot, source `list` filtering leaves only its
own unsuspended loop. Related robot accounts contribute their `friendlyId` in
the same order. A stale relation is kept as the source's unexpected 500
boundary instead of being converted to `ROBOT_NOT_FOUND`.

The public face verifies SigV4 for all three operations. The pinned gateway
`jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`
(`src/controllers/auth.ctrl.ts`, SHA-256
`776c0908cbb5e842fe7866e7d1e6640578c390d604536c76652707b50785881d`)
has no anonymous exception for them and its unsigned-method list is empty.
The source handler's internal credential metadata is not a public caller switch.

## Controls

`packages/account/test/robotLookup.test.js` runs five focused HTTP subtests and
22 requests against a temporary Store and ephemeral Classic listener. The
controls cover:

- owner success, outsider and anonymous authorization, lookup-before-auth,
  case-insensitive operation names, forged `x-amz-credentials` rejection as an
  identity switch, and the unsafe three-field robot response;
- missing, empty, null, numeric, and array payload values for required and
  optional Joi-shaped fields;
- owner, accepted member, invited member, removed member, robot caller,
  supplied-account override, suspended/deleted loops, and stable list order;
- first active owner resolution, no-match `{"id":null}`, and stale robot relations;
- no mutation or provider/event side effects on any lookup path.

Executed command:

```sh
node --test packages/account/test/robotLookup.test.js
```

Result: **5 subtests passed, 22 HTTP controls passed, 0 failed** under the
candidate's Node 22 workspace. The controls are source-shaped synthetic Store
fixtures; they are not an original Mongo/Node 8 execution or generated-client
TCP replay.

## Remaining boundaries

This candidate does not implement the other Loop operations, Mongo query/index
behavior, Mongoose account serialization beyond the generated robot fields,
the original Hapi route, or full Classic gateway policy beyond these three operations. Store insertion
order is used as the deterministic stand-in for Mongo's natural query order.
The source's `RobotClient`/disabled-robot path is not involved in these three
handlers. No real credentials, household data, robots, live services, or
shared parity captures were used.

The installed SSM LoopManager notification consumer traced during the same
source investigation is retained separately at
`.parity/reviews/moth-notification-readonly-root-20260907/installed-skills-service-manager.js`:
`KB_SLICE_NAME`/constructor and initialization are around lines 7320–7518,
robot-account fallback is around 7628–7665, cloud loop/member projection is
around 7768–7813, and `AccountUpdated`/`LoopUpdated` subscriptions are around
7364–7366. That installed bundle path is a read-only deployment artifact, not a
dependency of this candidate.

## Root review repairs

The unmerged implementation accepted a known owner access-key identifier
without verifying its signature. Root reproduced the defect with synthetic
credentials and added the existing source-backed SigV4 verifier before
`GetRobot` validation and lookup. Wrong secrets, altered signed bodies/targets,
expired dates, inactive accounts, and forged internal credential headers are
covered through both Account and Classic. The original generated client
3.0.110 running on Node 8.9.4 passed ten signed controls across those two
entry points, with its default parameter validation enabled.

Original method comparisons exposed the no-match null response and primitive
JSON validation differences. Root repaired both and preserved parsed primitive
values through Loop dispatch. The same Classic parser correction covers the
three previously implemented profile operations. The source comparison uses
controlled model seams; it does not prove full Mongo or live robot parity.

Root accepted these repairs for integration after the original-client review.
No whole parity task is closed, and no household or robot state was changed.

The subsequent integration review extended signature verification to
`FindOwner` and `ListOwnerRobots` after inspecting the gateway exception lists.
Both entry points reject wrong secrets, modified signed payloads, inactive
accounts, and unsigned requests with forged internal metadata. Authenticated
query semantics, including selecting another account in the payload, remain
those of the source controller.

## Root acceptance

The final reviewed package tree is `9e28499`. The original Node 8.9.4 client
3.0.110 completed 22 signed calls through Account and Classic. Root unit tests
passed 837 with seven skips; all 43 strict smoke cases matched. The source
framework generic error check confirms HTTP 500 and retryable behavior match,
while the client error code differs (`Internal Server Error` versus
`InternalFailure`). That qualification is retained rather than claimed equal.

The sanitized acceptance receipt is
[account-lookup/review.json](../evidence/2026-09-08/account-lookup/review.json).
Live robot lookup acceptance, other operations, and full A-04 remain open.
