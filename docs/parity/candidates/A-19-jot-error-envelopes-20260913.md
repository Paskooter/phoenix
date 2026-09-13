# A-19 Jot error-envelope follow-up

This bounded follow-up starts from the integrated Phoenix root revision `3f950ad27099773428d0ddab9e893a9676f8ab17` (the requested `6e817e3` is its parent) in the isolated worktree `.parity/worktrees/w18-a19-jot`, branch `review/w18-a19-jot`. It closes the three error-envelope findings recorded in [A-19's prior candidate](A-19-jot-versioned-contracts-20260911.md) without changing the parity ledger or the root checkout.

## Source basis

The Jibo archive was queried with `jibo_search` first, then the source files were read through the Gitea MCP:

| source | revision and file | behavior used |
| --- | --- | --- |
| `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/handlers/message.handler.js` | Every mapped operation is decorated with outer `@parseCredentials({})` and inner `@validatePayload`; `Joi.string()` rejects an empty string. |
| `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/controllers/message.ctrl.js` | Membership, robot-impersonation, and content/parts refusals call `Boom.createWithCode(Errors.JOT_*)`. |
| `server/server` | `master:src/validate.js` | Joi validation rejects with `Boom.badData(err)`. |
| `server/server` | `master:src/boom.js` | `createWithCode` copies the explicit error code into `error.output.payload.code`. |
| `server/server` | `master:src/server.js` | `lowerMethodName` reads `target.split('.')[1]` before auth/method lookup; a dotless target throws, while an unmapped operation returns `Boom.notFound`. |
| `server/server` | `master:src/server.js` | `requestHandler` replies `isBoom` errors raw and wraps non-Boom errors with `Boom.badImplementation('Internal server error.', err)`, whose public Hapi body is the generic `An internal server error occurred`. |
| `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/clients/account.client.js` | Missing registry/base throws `Boom.createWithCode(ACCOUNT_SERVICE_UNAVAILABLE)`; Wreck payload `{error,...}` throws `Boom.create(statusCode,message)`; Wreck errors reject unchanged. |
| `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e:src/clients/media.client.js` | The media client has the same missing-registry, upstream-payload, and raw-Wreck branches, using `MEDIA_SERVICE_UNAVAILABLE` for the typed 503. |
| `jiborobot/srv-jot-ws-archived` | `4432ac5d017ae1971a447f42e7a4b29da7eb2e58:package.json` and `archive/message.spec.js` | The archived runtime uses `@jibo/server~3.1.1`, literal `Jot_20160512.<Op>` targets, and the same Jot handler shape. |

The current Jot source pins `@jibo/server^2.1.3` (Hapi 13/Boom 3.1.2); the archived source pins `~3.1.1` (Hapi 16/Boom 5.1.0). Both recovered `lowerMethodName` implementations have the same split-and-lower-first behavior. The raw Boom reason phrases and generic 500 body are also consistent with the repository's existing source-compatible Account/Hapi response fixtures.

## Changes

`packages/classic/src/jot.js` now emits the source envelopes at the Jot handler boundary:

* `@validatePayload` failures are HTTP 422 with `{statusCode:422,error:"Unprocessable Entity",message}` and no `code`, `__type`, or `x-amzn-errortype`.
* The three `JOT_*` controller refusals are raw Boom bodies with the HTTP reason phrase and `code`, with no `__type` or `x-amzn-errortype`.
* Account/Media dependency failures follow the pinned wrapper: source-like `isBoom` errors are raw (503 plus `ACCOUNT_SERVICE_UNAVAILABLE`/`MEDIA_SERVICE_UNAVAILABLE` for missing registry, or the upstream status/message without a code), while plain Wreck/network errors are the raw generic 500 body `An internal server error occurred`.
* `Joi.string()` content validation now rejects an explicit empty `content` before the controller's content-or-parts check, matching the pinned schema.

`packages/classic/src/router.js` scopes the dotless-target compatibility branch to nonempty targets beginning with `Jot`. It emits the framework's generic HTTP 500 Boom body before authentication or operation lookup. Other malformed Classic targets keep their existing router response.

The Jot tests retain the prior operation, journey, durability, isolation, retry, and dependency-failure coverage. They now assert the changed envelopes and add a native `node:http` request that checks exact bytes, content type, absent AWS headers, auth-before-validation precedence, the dotless 500, and the unsigned unknown-operation 404.

## Raw wire checks

`node --test --test-name-pattern='A19e/f/g raw node:http envelopes' packages/classic/test/jot.test.js` passed 1/1. The request uses `http.request`, an explicit `content-length`, and does not use `fetch`.

The exact checks include:

```text
422 {"statusCode":422,"error":"Unprocessable Entity","message":"child \"loopId\" fails because [\"loopId\" is required]"}
403 {"statusCode":403,"error":"Forbidden","message":"You must be a member of the loop to list or create messages","code":"JOT_MUST_BE_LOOP_MEMBER"}
422 {"statusCode":422,"error":"Unprocessable Entity","message":"Either content or parts must be present","code":"JOT_CONTENT_OR_PARTS_REQUIRED"}
500 {"statusCode":500,"error":"Internal Server Error","message":"An internal server error occurred"}
404 {"statusCode":404,"error":"Not Found","message":"Method frobnicate not found."}
```

The signed invalid request produces 422; the unsigned invalid mapped request remains `401 MISSING_AUTH_HEADER` with the AWS envelope. The unsigned unknown operation remains the raw 404. The test asserts no `x-amzn-errortype` for the raw 422/403/500/404 paths and no `x-powered-by` on those responses. The dependency matrix also sends Account and Media registry, upstream, and generic network outcomes over raw `node:http` and checks their exact bodies.

## Deliberate falsification

Each repair was reverted temporarily with `apply_patch`, the same focused raw test was run, and the repair was restored with `apply_patch`:

| temporary break | command result |
| --- | --- |
| Validation branch restored `sendAmzError(...ValidationException...)` | `not ok 1`, expected status 422, actual 400; exit 1. |
| JOT business branch restored `sendAmzError(res,error)` | `not ok 1`, expected absent `code`/AWS header but actual `JOT_MUST_BE_LOOP_MEMBER`; exit 1. |
| Dotless branch removed | `not ok 1`, expected status 500, actual 400; exit 1. |
| Account/Media raw dependency classification restored to typed-503/AWS conversion | `not ok 1`, expected raw `{statusCode:503,error:'Service Unavailable',code:'ACCOUNT_SERVICE_UNAVAILABLE'}`, actual AWS `{__type:'ACCOUNT_SERVICE_UNAVAILABLE',message:...}`; exit 1. |

After each restore the raw test passed 1/1, the dependency matrix passed 1/1, and the complete Jot/stubs focus passed 32/32. No broken temporary state was committed.

## Verification

Commands were run from the isolated worktree:

```text
git diff --check                                      # clean
node --test packages/classic/test/jot.test.js packages/classic/test/stubs.test.js
  32 tests, 32 pass, 0 fail, 0 skipped
npm test
  unit: 1980 tests, 1972 pass, 0 fail, 8 skipped
  parity:check: 62/79 verified; tracker structure/dependencies/evidence valid
  parity:gate: strict 43 cases; result match; differences 0; invariants 0; coverageGaps 0
```

The full suite completed without an unrelated transient failure. The strict gate generated its normal private run directory under this worktree; no root or ledger files were edited.

## Criterion audit

| A-19 criterion | result | evidence and boundary |
| --- | --- | --- |
| 1. Versioned pairs and direct bulk route | **VERIFIED** | Existing Jot operation/model matrix covers 24 versioned pairs, the five recovered loop-era handlers, both observed prefixes, and `POST /numberOfUnreadMessagesBulk`; source refs are retained in the prior candidate and `packages/classic/test/jot.test.js`. |
| 2. Auth, membership, impersonation, validation, precedence, and errors | **VERIFIED for the recovered loop-era contract** | Existing focused tests cover the gates and source holes; this follow-up closes A19e Joi 422, A19f `JOT_*` Boom codes plus the Account/Media registry/upstream/network classes, and scoped A19g dotless 500 with raw TCP assertions. |
| 3. Create/list/read, pagination, media, and event effects | **VERIFIED for the recovered handler** | Existing Jot tests and the archived journey cover create/list/mark operations, exclusive windows, the 50-row page, media expansion, read state, and `JotMessageCreated`; no behavior change was made here beyond error serialization. |
| 4. Durability, retry, isolation, and original-client journey | **VERIFIED with stated substitution** | Existing tests cover in-process and SIGKILL process restart, retry ordering, loop isolation, and the archived `message.spec.js` request sequence over a real TCP socket. The real SDK SigV4/TLS gateway hop and Kafka consumer fan-out remain unavailable. |

## Remaining gaps and recommendation

The candidate is ready for root cherry-pick as bounded A-19 progress. The remaining gaps are the same evidence limits in the prior candidate: party-era Jot handlers have no recovered matching-era implementation, the real original SDK/gateway/TLS path is unavailable, and Kafka consumer fan-out is not reconstructed. The dotless branch intentionally covers only nonempty Jot targets; applying the source crash behavior to every malformed Classic target would be a separate shared-router decision.

No deployment, remotes, Moth, hardware, or `docs/parity/tasks.json` were touched.
