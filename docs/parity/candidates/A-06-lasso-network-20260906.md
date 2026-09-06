# A-06 Settings network Lasso candidate

Status: unverified candidate, pending root review.

This candidate starts at main `43c81f32b4ea2ef3a6f172944ce8bb6e6ebac150` in
`codex/candidate-a06-lasso-network-20260906`. It changes only the configured
Settings Lasso provider, its focused network tests, the existing configured
peer expectation, and this report. The accepted local Account/Person/Lasso
storage and Settings controller remain unchanged. Report's Axios client is not
shared or modified, and OAuth token exchange is outside this slice.

## Source contract

The source is `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`,
specifically [`src/clients/lasso.ts`](https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/commit/0d37e1fd2f4fca40538fb470194a3c5daf2c9830/src/clients/lasso.ts).
The source file prepared for the control has SHA-256
`a5e45ffea53d0c9660cdeb1a650adba1b56fe1f6886bffa898a135a6bf536145`.

The source client uses `@jibo/server` 4.0.12's `BaseClient`, whose pinned
runtime uses Wreck 12.6.2. The original controls run the exact transpiled
client under Node `v8.9.4` from
`node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.

The recovered behavior is:

- GET and DELETE validate truthy `skillId`, `serviceName`,
  `serviceAccountName`, and `scopes`, then serialize scopes as indexed
  `scopes[0]`, `scopes[1]`, and so on.
- POST validates those fields and `authCode`, sends only the source fields in
  source insertion order (`skillId`, context `accountId`, service fields,
  `scopes`, `authCode`, then truthy `clientId` and `redirectUri`), and returns
  the decoded response.
- All three methods send `Content-Type: application/json` and
  `X-JIBO-transID`. JSON response decoding depends on an
  `application/json` or `application/*+json` content type. Empty responses,
  non-JSON bodies, malformed JSON, and missing GET `credentialExists` are
  handled through the source operation-specific error messages.
- BaseClient reads the body before considering HTTP status. A JSON response
  without an `error` field therefore remains a decoded result even for 4xx or
  5xx status; this includes successful DELETE completion for a JSON 500 body.
  Redirects 301/302/307/308 follow the source method-preserving Wreck path,
  with the source default limit of three. `ETCO_server_http_timeout` and
  `ETCO_server_http_maxredirects` are honored.

The candidate uses a Settings-local Node `http`/`https` implementation to
preserve the Wreck wire shape: header order/casing, explicit JSON byte length,
keep-alive agents, source response MIME handling, status treatment, bounded
redirects, and premature response handling. It does not alter the generic
Account, Hub, or Person fetch helper.

## Differential evidence

Fresh private evidence is under
`/home/shell/work/phoenix/.parity/reviews/a06-lasso-network-20260906/`.
`provenance-final.json` records source/runtime pins, commands, and hashes.

- `cases-accepted.json` contains 24 controls covering special-character and
  empty scope arrays, POST identity/field ordering, 201/204/400/404/500
  responses, malformed and non-JSON bodies, source validation failures,
  missing transaction IDs, and a truncated response.
- `original-final.json` is the pinned Node 8 source capture and
  `candidate-final.json` is the Node 22 candidate capture.
- `comparison-final.json` is **24/24** for operation result/error outcome,
  request method/URL/body/header values, and raw header order/casing. Only the
  independently assigned loopback `Host` port is normalized. The source and
  candidate runtimes are recorded as `v8.9.4` and `v22.22.0`.
- Final result hashes are `original-final.json`
  `7b09f384c66b96630fbf6abe5fa92d13cf62ba6f7584649da6c82e5fb20347da`,
  `candidate-final.json`
  `fd2ee974fa0c66599ebdb9971e2c2e9f7cb150126e422e6f031b591e868076ea`, and
  `comparison-final.json`
  `6e90935ada7c79f8a2ca4c46bbc531eb78ad2c9b3037000f82a3392936a0db1c`.
- `redirect-cases.json`, `redirect-original.json`,
  `redirect-candidate.json`, and `comparison-redirect.json` provide an
  independent source/candidate control for 307/302 follow, 303 no-follow, and
  the three-hop redirect limit: **4/4**.

The source client test harness is a real TCP loopback HTTP provider; it does
not use a mocked fetch implementation. No live Lasso, Mongo, OAuth, robot, or
production peer was started.

## Validation

The focused network suite passes 4/4:

```text
node --test packages/account/test/settingsLassoNetwork.test.js
```

The existing provider suite and network suite pass 5/5 together. The accepted
Settings mutation/persistence suite passes 9/9 after its configured-peer
expectation was corrected to the source indexed scope key. Syntax and diff
checks pass:

```text
node --test packages/account/test/settingsProviders.test.js packages/account/test/settingsLassoNetwork.test.js
node --test packages/account/test/settingsUpdateDelete.test.js
node --check packages/account/src/settingsProviders.js
git diff --check
```

The complete Account test directory passes 74/74 and the complete Common test
directory passes 21/21. The candidate worktree's `node_modules/@phoenix/*`
links resolve to this worktree's package directories; no package dependency or
lockfile change is required for this built-in HTTP implementation.

One source-dependency edge is retained explicitly in the private evidence:
the pinned Wreck/BaseClient process raises an uncaught Boom assertion when a
2xx JSON body has a truthy `error` field but omits `statusCode`. The candidate
maps that malformed provider envelope to the normal operation-specific error;
the status-bearing error envelope control matches the source. This avoids
propagating a peer-induced process crash while leaving the source behavior
visible for root review.

Remaining scope is live Lasso deployment, Mongo persistence, provider-side
credential validation, TLS/registry configuration, and OAuth authorization or
token exchange. These controls establish the Settings outbound client boundary
only; the candidate remains unverified until root review.
