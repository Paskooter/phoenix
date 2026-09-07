# A-04 public Loop validation candidate — pending review

Status: **candidate, unverified**. This is a bounded repair for the public
`Loop_20160324.SuspendLoop` and `Loop_20160324.SuspendRobotLoop` validation
envelope. It does not close A-04 or claim public authentication parity.

## Observed source contract

The pinned account source is
`jiborobot/srv-account-ws@b525601390108b8635a31794dfa5cc3fda8a37d0`,
`src/handlers/loop.handler.ts`. The source file bytes used for the hash in the
receipts are SHA-256
`dcef10c095f0b781387663118e13f5d47f1f0a8b258340e4168a09ab6bf5b12d`.
`SuspendLoop` has `@parseCredentials({})` followed by
`@validatePayload({ loopId: Joi.string().required() })`.
`SuspendRobotLoop` has `@parseCredentials({ adminOnly: true })` followed by
`@validatePayload({ friendlyId: Joi.string().required() })`. Thus the admin
credential gate runs before the robot-operation payload validator.

The pinned public gateway is
`jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`.
Its route, auth-scheme, auth-controller, and V4 verifier hashes are recorded
in `source-client-validation-attempt-2.json` and
`source-files-manifest.json` under the evidence directory. The source control
uses the actual compiled gateway/auth route and the original generated Loop
client in Node `8.9.4`; its loopback peer applies the pinned
`@jibo/server@4.0.12` Hapi 16, Joi `10.5.2`, and Boom `5.1.0` validation
semantics. The peer is deliberately controlled because the archived account
application's Mongo/provider bootstrap is not available in this slice; this
qualification is recorded rather than presented as a full original Account
application run.

For a missing required field, the source validation response is HTTP 422 with
the Hapi/Boom JSON envelope:

```json
{"statusCode":422,"error":"Unprocessable Entity","message":"..."}
```

The original Node 8 `@jibo/jibo-server-client@3.0.110` extracts
`Unprocessable Entity` as both the error name and machine-readable code. Empty
strings produce the Joi `not allowed to be empty` message; numbers, objects,
and arrays produce `must be a string`. `SuspendLoop` returns
`{"result":"Command accepted"}` on success. `SuspendRobotLoop` has no return
statement in the source handler, so the successful response is zero length.

## Candidate repair

`packages/account/src/robotFace.js` now sends `sendValidationError` for the
required `loopId`/`friendlyId` branch in `loopSuspend`. That helper emits the
source-shaped 422 envelope. The change is local to these two operations. The
existing AWS-JSON `sendAmzError` path remains in place for lookup,
authorization, and controller failures, preserving their existing codes and
statuses. No common parser, global error mapper, or unrelated Classic route
was changed.

`packages/account/test/loopSuspend.test.js` adds both operations over missing,
empty, null, number, object, and array field values, asserts the complete 422
body and no state mutation, then sends a valid request and checks durable
suspension. The test also retains the original access-key ownership,
admin-only ordering, forged `x-amz-credentials`, persistence, and success
controls.

## Differential evidence

All values below are synthetic and contain no live account or robot
credentials. The source and candidate controls use the same 14 ordered IDs:
six `SuspendLoop` validation cases, a following valid loop request, six
`SuspendRobotLoop` validation cases, and a following valid robot request.

| Comparison | Result |
| --- | ---: |
| Source IDs / candidate IDs | 14 / 14 |
| HTTP status matches | 14 / 14 |
| Raw response-body matches | 14 / 14 |
| Decoded response-data matches | 14 / 14 |
| Original-client status/code and error-shape matches | 14 / 14 |
| Stable result matches | 14 / 14 |
| Differences | 0 |

The twelve invalid requests returned 422 on both sides. The two following
valid requests returned 200 with respectively
`{ result: "Command accepted" }` and `{}` from the generated client. The
source and candidate framework response headers are retained in their raw
captures but are not claimed identical: Hapi and Express add different
transport/framework headers. The comparison does not discard a body or status
mismatch as a header normalization.

The prior five-control public-wire receipt on the parent candidate recorded
the pre-repair validation difference: source Hapi/Boom returned
`error: "Unprocessable Entity"`, while Phoenix returned AWS-JSON
`__type: "ValidationException"`; the coded authorization and ownership cases
were unchanged. The new 14-case receipt demonstrates the repaired branch and
retains the earlier evidence instead of retagging it.

## Reproduction and receipts

Evidence directory:
`/home/shell/work/phoenix/.parity/reviews/a04-public-validation-20260907`.
The authoritative source run is `source-client-validation-attempt-2.json`
with Node 8 container exit 0 in
`source-client-validation-attempt-2.node8.exit`. The authoritative candidate
run is `candidate-client-validation-attempt-3.json` with exit 0 in
`candidate-client-validation-attempt-3.node8.exit`. The source/candidate
comparison is `comparison-public-validation.json`; its assertions require
equal ordered IDs, equal counts, all validation statuses 422, matching
following status/data, and zero differences. Candidate request and response
wire captures are in `candidate-server-validation.captures.json`.

The source command was:

```text
timeout 75s docker run --rm --network host \
  -v <jibo-server-client-3.0.110>:/client:ro \
  -v <a06-original-runtime>/node_modules:/deps:ro \
  -v <a04-public-validation-20260907>:/review \
  -e NODE_PATH=/deps \
  -e LOOP_HANDLER_HASH=dcef10c095f0b781387663118e13f5d47f1f0a8b258340e4168a09ab6bf5b12d \
  -e OUTPUT=/review/source-client-validation-attempt-2.json \
  node:8.9.4-slim node /review/source-client-validation.node8.cjs
```

The candidate used the same original Node 8 client runner against the
ephemeral Account/Classic listeners started from this worktree; its output
and exit receipts are the `candidate-client-validation-attempt-3.*` files.
The differential command was:

```text
node compare-public-validation.cjs
```

Focused and package tests ran with Node 22:

```text
node --test packages/account/test/loopSuspend.test.js       # 1/1
node --test packages/account/test/*.test.js                  # 117/117
node --test packages/classic/test/*.test.js                  # 24/24
node --test packages/common/test/*.test.js                   # 21/21
```

The corresponding stdout, stderr, and exit files are retained in the evidence
directory. The three broad unit commands each exited 0; the focused command
also exited 0.

## Authentication boundary and limitations

`Account_20151111.CreateHubToken` is the separately bounded signed path in
`packages/account/src/robotFace.js` and calls `verifySigV4`. The public Classic
Loop compatibility face still resolves its legacy caller from the stored
access-key ID; it does not independently verify the full SigV4 signature.
It never treats a caller-supplied `x-amz-credentials` header as an admin
identity. The pinned security gateway verifies the upstream Authorization and
rewrites that internal header, including the source literal redaction of the
secret; that gateway-to-account hop is outside this validation-envelope slice.

The generated client serializes a null string property as an empty string, so
the source-client `null` rows intentionally prove the original wire behavior.
The focused raw HTTP candidate test additionally covers a literal JSON null.
Top-level primitive/array payloads are not constructible through the original
Loop operation model and are therefore outside the 14-case client matrix.
Other Loop operations, full original Account/Hapi/Mongo execution, exact
framework headers, complete public SigV4 enforcement, and the remaining A-04
authorization/state surface remain open. Root acceptance is required before
this candidate is integrated or described as verified.
