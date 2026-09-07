> Historical candidate report. This bounded implementation is accepted in the [root Hub review](A-06-hub-root-20260907.md). The helper-only process-failure interpretation is superseded by the actual Hapi boundary evidence; original observations below are retained.

# A-06 Hub provider failure at the full Settings boundary (unverified)

This follow-up is based on `b037a05bed8db0be0c90e719122f2a122a2a80a2` in the
isolated `a06-hub-boundary` worktree. The preceding Hub transport candidate and
its captures remain frozen. This slice owns one boundary defect: a Hub error
payload with a missing or invalid `statusCode` must become a request-scoped
HTTP 500 at the Settings listener, while the listener remains able to serve a
later request.

## Source boundary

The source side runs the pinned `@jibo/server` `App.start()` path. `App` loads
the registry/config, constructs `Server.newHttpServer`, registers the real Hapi
route and starts a TCP listener. The handler uses the recovered source
`Account` and `Hub` clients against controlled loopback peers. Person and Lasso
are named inert seams used only to make the successful follow-up deterministic.

Source pins:

- `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`
- `@jibo/server@4.0.12`, Hapi `16.4.1`, Boom `5.1.0`, Wreck `12.2.2`
- Node `v8.9.4`, image
  `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
- recovered Hub client source hashes: `account.ts`
  `ed710e31766213321331b155c9826bead8705329b90ac6002688b3adcfc982d1`,
  `hub.ts`
  `7371117942c8f4a81734e709dc151097f02be263f635dbc0d22dc2e83314383d`
- emitted Hub client hashes: `account.js`
  `7ebece4391078e6e03562fef3123a31ea1388ea95cc6936da575e19e409ae31f` and `hub.js`
  `c61be7648f597dffaa439cd72ed390a1e685f9182b1a1fcc4662105aaa0f4f8f`
- source App/Server hashes: `app.js`
  `4a81c32c5953e8acabe3a481f18a71738692b5b94c2936da11ef92bd9d7ac444`,
  `server.js`
  `a0c3b381e33cb0d6d460ee3b4697912e0bd79bd66d8dd574ec47a1510cd2de50`
- source response transport hashes: `wreck.js`
  `4432a7c3f77e0c1bce1bf4569d08fc5719bf68411c2d25f3d2f5f9a1939488b2`,
  `boom.js`
  `6af4d3d56c824b32f0a08b3707ac0021fee61b838513a3098fa6d1194fb979fa`

The source `BaseClient` passes Hub payload errors to Boom 5.1.0. Boom asserts
when `statusCode` is missing, `null`, below 400, or nonnumeric. Inside the real
Hapi request domain that throw produces the generic 500 response and does not
terminate the process. A second request on the same source listener confirms
that recovery behavior.

## Repair

`sourceHubRequest()` previously called `sourceBoomFromPayload()` inside a
promise fulfillment callback without handling its synchronous assertion. On
Node 22 this became an unhandled rejection and terminated the candidate before
the request boundary could reply. The callback now catches that assertion and
settles the transport promise with the error. `settingsFace.js` then performs
its existing request-scoped generic 500 projection. Ordinary valid Boom
errors, malformed response parsing, reset mapping and Person/Lasso paths are
unchanged.

The focused regression is
`packages/account/test/settingsHubBoundary.test.js`. It starts real TCP
Account and Hub peers, sends a missing-status or status-399 Hub error, checks
the 500 machine fields, then sends a valid Hub response on the same listener
and checks the successful data response.

## Fresh full-boundary controls

Evidence is retained under
`/home/shell/work/phoenix/.parity/reviews/a06-hub-boundary-20260907`:

- `source-bootstrap.cjs`: source `App.start()`/Hapi process and controlled
  Account/Hub peers;
- `candidate-bootstrap.mjs`: candidate internal Settings TCP listener and the
  same controlled peer protocol;
- `receipt.json`: exact source Docker and candidate argv, exit codes, durations,
  output hashes and source client hashes;
- `comparison.json`: decoded status/body comparison with every raw response
  retained in `outputs/source-*-final.json` and
  `outputs/candidate-*-final.json`.

Eight cases were executed independently. Each case sends a failing Hub reply
followed by a valid reply: valid baseline, missing status, numeric status 399,
non-numeric status, null status, malformed JSON, malformed error JSON, and a
connection reset. All 8/8 matched outer status and decoded functional fields;
all 8/8 source and candidate processes returned a second valid response. The
reset rows have the expected source/candidate log-marker timestamp difference
in the diagnostic `message`; status 504, error label, and all other response
fields match. The malformed JSON rows differ only in JSON object key order in
the raw text; decoded fields match. The prior unfixed candidate receipt is
retained as `outputs/candidate-missing-status.json`, exit 1 with an uncaught
`AssertionError`; the source receipt returned HTTP 500 and continued.

The source peer and candidate peer authorities are independently loopback
bound and are retained in each output. No production registry, credentials,
robot, source cache, main worktree or shared golden was changed.

## Validation

Passed in the candidate worktree with private workspace links resolving back
to this worktree:

```text
node --test packages/account/test/settingsHubBoundary.test.js       # 2 passed
node --test packages/account/test/settingsHubNetwork.test.js         # 4 passed
node --test packages/account/test/settingsHubTransport.test.js       # 6 passed
node --test packages/account/test/settingsProviders.test.js          # 2 passed
node --test packages/account/test/settingsPersonNetwork.test.js       # 15 passed
node --test packages/account/test/settingsLassoNetwork.test.js        # 13 passed
node --check packages/account/src/settingsProviders.js && node --test packages/account/test/settings*.test.js
                                                                       # 74 passed
```

The six focused files total 42 passing tests; the broader Settings glob adds
the remaining Account and internal-transport coverage. The full run also
rechecked accepted Person/Lasso and local persistence behavior after this
Hub-only change.

The candidate is frozen pending root review. Full production App registry and
live Hub deployment authentication remain outside this bounded control.
