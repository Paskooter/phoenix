# A-04 Loop record operations

Status: **candidate, unverified pending root review**.

This candidate is based on `d7934a6d1fb6ef92187bf6a2c54034aca4b3d295` and
implements the three Loop record operations on the Account face, with the
same operations reachable through the Classic proxy:

* `Loop_20160324.UpdateLoop` validates required string `loopId` and `name`,
  checks the owner, rejects a suspended loop, saves the new name, and returns
  `{ "result": "Command accepted" }`.
* `Loop_20160324.RemoveLoop` validates `loopId`, permits the owner only (the
  source handler passes `isAdmin: false`), does not require suspension, marks
  the Loop deleted, clears its `robot` relation, and returns the populated
  Loop. Members and the robot Account remain stored.
* `Loop_20160324.ClearRobot` requires an administrator and `robotId`, resolves
  the robot by friendly ID, resolves its active Loop, and delegates the same
  soft removal with `isAdmin: true`. A missing robot or missing active Loop
  returns `ROBOT_NOT_FOUND`.

The three record operations now have two route-scoped boundary repairs. Their
valid primitive JSON bodies are passed through the Account and Classic parsers
to the operation validator, which returns the source-shaped 422 object error.
Malformed JSON still fails in the parser with 400. Each operation also checks
the received body bytes against a verified SigV4 `Authorization` before
payload, ownership, or admin validation. The public face uses the access key
that signed the request; an `x-amz-credentials` header cannot elevate it.
Legacy membership operations keep their previous dispatch default.

## Source pin and exact controls

The source is `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
The exact saved source inputs for the executed handler/controller/schema/index
chain are in the private directory
`.parity/reviews/a04-member-profile-review-20260908/source-6cea`:

| Source file | SHA-256 | Relevant lines |
| --- | --- | --- |
| `loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` | `52-63`, `207-225` |
| `loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` | `155-165`, `567-576`, `597-600`, `771-779` |
| `base.loop.ctrl.ts` | `b85870f98589aa5c932d5b14942cae803cba355b7f8c15aacea2925192b1f3d9` | `7-13` |
| `loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` | `56-74`, `93-108` |
| `account.ts` | `1d69c02223ec3df088bbfa10c1ff1c8b29a4f003f9229fa89f3c531ee1f3b2c5` | schema/default/toJSON |
| `index.ts` | `75adaa214617ea1d017831cc1dde1001490f155538ab06c3c75c618431c1dda1` | `74-115` |

The source controls are in the separate private directory
`.parity/reviews/a04-loop-record-validation-node8-20260908`. Its
`compile-exact.cjs` transpiles all six source files with TypeScript `2.5.3`
and `ES2015/CommonJS` settings; the output was executed by Node `v8.9.4` in
image `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The compiled controller, handler, base controller, both schemas, and startup
trigger therefore come from the exact 6cea source inputs. The harness adds
only a static Loop/Account query seam, the trigger export, synthetic model
objects, and a controlled EventSender; those additions are listed in
`exact-transpile-manifest.json` and are not source-parity claims.

The source runner executes 40 ordered controls covering successful, denied,
missing, suspended, save-failure, event-failure, required-field, all four
primitive-body values (`null`, string, number, array) for each operation, and
ClearRobot admin-before-validation. The candidate runner executes the same
40 IDs through the Node 22 Account AWS-JSON listener with real synthetic
SigV4 requests. The fresh outputs and comparison are:

* `controls/source-loop-record-exact-node8.json`: 40/40 rows, 8 success, 19
  validation 422, exit 0.
* `controls/candidate-loop-record-node22.json`: 40/40 rows, 7 success, 19
  validation 422, exit 0.
* `controls/comparison-exact-candidate.json`: ordered IDs match 40/40,
  validation status matches for every primitive and object case, and
  successful Loop bodies have no semantic differences.

The one status difference is `clear-forged-admin`: the direct source method
trusts its internal `x-amz-credentials` fixture and returns success, while the
public candidate correctly authenticates the owner-signed request and rejects
admin-only access. The comparison also retains source-versus-candidate error
wire envelopes, the detached-store versus Mongoose suspended/save-failure
state observation, and source post-save versus targetless outbox event
observations. No differences are hidden by rewriting the old 29-row evidence
in `.parity/reviews/a04-loop-record-node8-20260908`; that earlier run remains
frozen as historical evidence.

The repeatable source command is the `run-exact-source.cjs` wrapper. It reads
the image digest from the earlier machine-readable source manifest and runs
with the source harness and dependency trees read-only:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-loop-record-validation-node8-20260908/run-exact-source.cjs
```

The candidate and comparison commands used for the fresh rows were:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-loop-record-validation-node8-20260908/run-candidate.cjs
```

Use this exact comparison command:

```text
python3 /home/shell/work/phoenix/.parity/reviews/a04-loop-record-validation-node8-20260908/compare-exact-candidate-final.py
```

The final candidate commit is `906a998dee73fe1978a5ec1365734df34fd256d7`. The
candidate file SHA-256 values are:

| Candidate file | SHA-256 |
| --- | --- |
| `packages/account/src/index.js` | `0c063246ac1f20cc7140af52bfc5056c8d00e0ae26e1ffb862f84cd7e4243973` |
| `packages/account/src/loopMembership.js` | `2d607e09c54b5e9183f8ecedc12b8db99af94e495f6837fff567b6ce5541f492` |
| `packages/account/src/robotFace.js` | `c309147c7085dc5aee4c6a0590b8b067eb6e86099e9b7eda72cb1a3d8fa7ea0d` |
| `packages/classic/src/index.js` | `3adebf3c840d12129dbf9af34cfb754694d4549c3b9e0baf00a2bcfee67f7b56` |

The final private evidence hashes are `source-loop-record-exact-node8.json`
`5bbaf20d4f1149709ea0e10c5290603bde1f0cc6abc7411a9ad0a5419b639218`,
`candidate-loop-record-node22-final.json`
`9329c47cc8bec4a7b65e221b4620cc514cd6ba722fae5059930d279af5061e58`, and
`comparison-exact-candidate-final.json`
`2c9a21715e78fe42f1f63a0ea3904d8adcf1d886ffc69fd0d602c59380611492`.

## Source behavior and limits

The source handler decorators validate the parsed payload before the
operation-specific controller. `ClearRobot` performs its admin credential
check before the payload validator. `UpdateLoop` assigns the name before its
suspended-loop guard but does not save a suspended document. Phoenix uses a
detached Store draft and checks suspension before changing the committed
object, so a rejected request cannot leak a name through shared memory. This
is a model-layer observation difference; neither path reports a successful
mutation or durable name change.

The source startup hook constructs and sends `LoopUpdated` asynchronously after
Loop saves, including removal saves. Phoenix's existing outbox has no routable
robot target after the association is cleared, so the fresh comparison retains
those event-delivery observations as open infrastructure behavior. Save-failure
controls use controlled seams and do not claim Mongo transaction equivalence.

The source rows are direct decorated method calls with controlled model/save
and EventSender seams, not the original Hapi listener or a live Mongo service.
The candidate rows use the Phoenix AWS-JSON HTTP face and JSON Store. Hapi
network framing, Mongoose casting/index behavior, source gateway
authentication, external EventSender/SNS delivery, and robot-client behavior
remain unverified. This candidate does not change older membership operation
authentication or claim complete A-04 parity.

Focused candidate tests:

```text
node --test packages/account/test/loopRecord.test.js       # 8/8
node --test packages/classic/test/loopRecordValidation.test.js  # 1/1
node --test packages/account/test/*.test.js                 # 171/171
```

All fixtures are synthetic. No source service, Mongo process, robot, live
store, reference/golden, or deployment file was changed.
