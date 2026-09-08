# A-04 bounded candidate: ListLoops payload validation

Status: **candidate implementation complete; pending root review.** This
follow-up is based on `03e6a011bfccfe30273c5301e7497af5dc50255f` and addresses
the signed `ListLoops` primitive-body gap recorded in the shared Loop-auth
review. It does not claim full Loop-handler parity.

The pinned Account handler is
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`,
`src/handlers/loop.handler.ts` SHA-256
`abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d`.
`ListLoops` at lines 65-75 uses `@parseCredentials({})` and
`@validatePayload({ loopId: Joi.string() })`. The pinned `@jibo/server`
validator is `server-0a39764/src/validate.ts` SHA-256
`a8cedbd0765509577fed5d9b0df14e1074a1cc56a32b85a41f1827f87c99ba8a`,
which calls `Joi.validate(request.payload, schema, { allowUnknown: true },
callback)` and ignores the converted callback value. The original dependency
is Joi `10.5.2`, SHA-256
`aefc2338c657cf7ebde587825e43bab83069f76b806d7ce5c45a8627abf68ee6`.

The candidate now keeps the parsed top-level value for both `ListLoops` and
the compatibility `List` alias, validates before any loop-map read, and
returns the source-shaped 422 validation envelope for null, arrays, numbers,
booleans, strings, non-string `loopId`, and empty `loopId`. It accepts an
object without `loopId` and objects with unknown keys, matching the source
schema's optional field and `allowUnknown: true` behavior. A valid `loopId`
is applied as the source controller's optional `_id` filter. Invalid requests
leave the loop map, durable store bytes, and notification outbox untouched.

The source behavior was executed under Node `v8.9.4` in image
`node:8.9.4-slim` (digest
`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).
The 12-row result is in
`.parity/reviews/a04-list-validation-20260908/source-joi.json`; the command
used the read-only pinned runtime dependency directory and exited 0. It
confirms that every top-level primitive fails with `"value" must be an
object`, that `loopId: 1`, `null`, and `""` fail their Joi string checks, and
that unknown object keys remain on the original request object while the
validator's returned value is a separate object. This is why the candidate
validates the original body without replacing it with a converted clone.

The focused signed HTTP test is
`packages/account/test/loopListValidation.test.js`. It creates synthetic
Account data and runs the same signed raw bodies through an ephemeral Account
listener and the Classic listener proxy. The invalid matrix has eight body
classes and checks status, validation fields, no loop-map reads, unchanged
durable bytes, unchanged loop state, unchanged outbox, and recovery with a
valid `{}` request. It also checks unknown-key acceptance, optional
`loopId` selection, and an absent-loop result. Both faces passed.

Executed checks:

```text
timeout 120s node --test packages/account/test/loopListValidation.test.js       # exit 0
timeout 120s node --test packages/account/test/loopGatewayAuth.test.js          # exit 0
timeout 120s node --test packages/account/test/robotFace.test.js                # exit 0
timeout 120s node --test packages/account/test/loopHouseholdBootstrap.test.js packages/account/test/loopMembership.test.js  # exit 0
```

Captured outputs and hashes are under
`.parity/reviews/a04-list-validation-20260908/`, including
`candidate-list-validation-final.stdout`, `source-joi.json`, and the
regression outputs. The candidate worktree is
`.parity/worktrees/a04-list-validation-20260908`, with its own
`node_modules/@phoenix/*` links resolving inside that worktree.

## Authentication qualification

The List validation change does not repair account lookup or public
authentication. The pinned Account controller's
`findByAccessKeyId` implementation at
`.parity/consumers/account-ws-b525601/src/controllers/account.ctrl.ts` lines
223-228 queries `{ accessKeyId, isDeleted: { $ne: true } }` and throws
`ACCOUNT_NOT_FOUND` when no live account is found. The pinned security gateway
at `.parity/consumers/security-gw-43a692f/src/controllers/auth.ctrl.ts` lines
60-84 preserves a Boom error's code while changing its status to 401; its
`ACCESS_KEY_NOT_FOUND` fallback is reached only when the account client returns
no data. These are distinct source machine codes, even though both are
non-retryable authentication failures to the generated client in the normal
case.

The pinned generated SDK's `lib/protocol/json.js` lines 52-76 extracts the
`__type`, `code`, or `error` field into `error.code`; its retry policy in
`lib/service.js` lines 341-347 retries networking, expired/throttled, and
status-500-or-higher errors, so it does not retry either normal 401 lookup
failure. A fresh generated-client control was run against a local TCP peer
under the same Node `v8.9.4` image: both synthetic 401 bodies produced the
corresponding `error.name` and `error.code`, `statusCode: 401`, and
`retryable: false`. Its JSON result is
`.parity/reviews/a04-list-validation-20260908/source-sdk-error.json`, with
the runner and output hashes recorded in the review manifest. The source
controller and SDK files are retained by hash in the review manifest. The
candidate's existing local resolver still needs the source `isDeleted`
exclusion; root's combined authentication work is handling that separately.
It is outside this bounded List payload-validation commit and is reported here
so the List controls are not mistaken for auth parity.

The change remains bounded. Source `LoopController.list` also admits
accepted/invited member visibility and Mongo query ordering; this candidate
retains the existing Phoenix visibility implementation and only applies the
source-demonstrated optional `loopId` filter. Full Hapi/Mongo execution,
anonymous invitation/agreement operation implementations, live robot traffic,
and whole A-04 acceptance remain open.
