# A-06 Person failure propagation candidate

Root update: this bounded candidate is accepted as part of the
[final Person review](A-06-settings-person-root-20260907.md). The original
submission below is retained as historical evidence; full A-06 remains open.

This candidate carries the source Settings boundary for failures that originate in
the Person HTTP response stream. It is based on
`4c290c7be0c66fe32853ed4f217405eda3f0fb5d` and remains unverified pending root
review.

The pinned Settings client uses `@jibo/server` Wreck/Boom. Wreck turns an
incomplete response into a Boom error, and the wrapper then calls
`Boom.badImplementation` with that already-Boom error. Boom's assertion escapes
the Person callback; inside the normal Hapi Settings bootstrap, the request
domain turns it into one generic HTTP 500. The same boundary occurs when the
Person payload carries `error` without a valid 400+ `statusCode`, because
`Boom.createWithCode` asserts its first argument. A valid status, including
HTTP 400 with `statusCode: 400` in the JSON payload, is an ordinary provider
error and remains eligible for GetController's per-key error projection.

`settingsProviders.js` now marks response stream failures and provider-status
assertions with a non-enumerable structural symbol. `settingsFace.js` rethrows
that category from the Person/loop service catch so the request-level boundary
serializes the generic 500. Malformed JSON remains the ordinary
`Boom.badImplementation(SyntaxError)` rejection and is still projected to a
per-key error. UpdateSettings already has no Person per-key catch, so a marked
Person write or readback reaches the same generic boundary while preserving the
source write-then-read scheduling and partial side effects.

The focused unit file
`packages/account/test/settingsPersonFailurePropagation.test.js` covers
partial socket reset, short Content-Length, missing status on HTTP 200 and 400,
an invalid 399 status, valid provider 400, malformed JSON, both Get operations,
and an UpdateSettings Person readback failure. The existing Person, Settings,
transport, provider, and Update/Delete suites also pass.

## Evidence

The fresh candidate bootstrap receipt is at
`/home/shell/work/phoenix/.parity/reviews/a06-person-failure-propagation-20260907`.
It compares six real loopback Person controls against the pinned full App/Hapi
source receipt in
`a06-settings-bootstrap-fate-20260907`:

| control | source and candidate result |
| --- | --- |
| valid provider | HTTP 200, identical decoded response body |
| delayed partial reset | HTTP 500 generic body |
| short Content-Length then FIN | HTTP 500 generic body |
| missing provider status on HTTP 200 | HTTP 500 generic body |
| HTTP 400 with missing provider status | HTTP 500 generic body |
| HTTP 400 with explicit status 400 | HTTP 200 with the per-key `person request error` |

All 6/6 status values, complete response bodies, process exits, request
completion, selected Person method/target/credentials/body/length/connection
wire fields, and independently validated loopback Host shapes match. The
candidate process exits 0 after deliberate listener shutdown in every control;
the source process does the same. No response or body normalization was used.
Raw candidate JSON/stdout/stderr, the comparator, command log, provenance,
source receipt references, and hashes are retained in that review directory.

The source control uses `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`,
`@jibo/server 4.0.12`, Hapi 16.4.1, Wreck 12.6.2, Boom 5.1.0, Hoek 4.1.1,
and Node 8.9.4 image
`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The candidate uses its own worktree-local `@phoenix/*` links and Node
`v22.22.0`; the source/candidate distinction is recorded rather than hidden.

This slice does not change Lasso, shared server behavior, or the public AWS
face. Direct callers that bypass the Settings Hapi boundary still receive a
safe marked rejection instead of reproducing the source's uncaught process
exit; that is an intentional safety boundary and remains open for any caller
that depends on the lower-level crash fate. Exact Node diagnostic wording and
Boom function metadata are outside this candidate's acceptance claim.
