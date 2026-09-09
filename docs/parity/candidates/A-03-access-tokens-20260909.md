# A-03 candidate: access tokens and key rotation

Status: **candidate; unverified pending root review.** This implements three
Account operations (`CreateAccessToken`, `GetAccountByAccessToken`,
`ResetKeys`). It does not close A-03. It does not touch `UpdatePhoto` /
`RemovePhoto`, `Search` / `Remove`, `loopMembership.js`, or the verified
`CreateHubToken` path.

Base revision: `8795d10c47aa42ed6f0a4bc3736daf87f654d255`.
Implementation commit: `43210f54494df8b8ebda0861301cd8180816394c`.
Task id: `a03-access-tokens-20260909`.

## Source contract

Pins actually read through the Jibo archive (not original-runtime execution):

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea434` (`6cea43470825657d6a5722162f28c8f233153ee2` on related A-03 slices) |
| Account handler | `src/handlers/account.handler.ts` |
| Account controller | `src/controllers/account.ctrl.ts` (`createAccessToken`, `getAccountByAccessToken`, `reset`, `findById`) |
| Token controller | `src/controllers/token.ctrl.ts` (`createWebToken`, `getWebToken`, `WEB_TOKEN_LIFETIME`) |
| Account schema | `src/schemes/account.ts` (`fillAccessKeys`, `toJSON` `{unsafe:true}`) |
| Token errors | `src/errors/token.ts` (`TOKEN_EXPIRED` is the 15-minute Token scheme, not web JWTs) |
| Framework WebToken | `jiborobot/srv-server` `src/webtoken.ts` (`ITokenPayload`, `sign` / `verify`; web tokens constructed with old-secret `""` and timestamp `0`) |
| Framework dispatch | `jiborobot/srv-server` `src/server.ts` (`lowerMethodName`; non-Boom → `Boom.badImplementation`) |
| Framework credentials | `jiborobot/srv-server` `src/parseCredentials.ts` (`adminOnly` is the only reject; empty `{}` is otherwise attached) |
| Framework validation | `jiborobot/srv-server` `src/validate.ts` (`Joi.validate(..., {allowUnknown:true})` → `Boom.badData` 422) |
| Generated API | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, `apis/account-2015-11-11.normal.json` |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c` `src/controllers/auth.ctrl.ts` |

**Decorator trap (verified by reading `account.handler.ts` top to bottom):**
decorators sit *above* the method they apply to. Attribution:

- `ResetKeys`: `@parseCredentials({})` immediately above `public async ResetKeys`. No `@validatePayload`. Not `adminOnly`.
- `CreateAccessToken`: `@parseCredentials({})` then `@validatePayload({ payload: Joi.string() })` immediately above `public async CreateAccessToken`. Same pair as `CreateHubToken`, which is the *next* method.
- `GetAccountByAccessToken`: `@parseCredentials({})` then `@validatePayload({ token: Joi.string().required() })` immediately above `public async GetAccountByAccessToken`.

## Auth classification

| Wire operation | Handler decorator | Gateway `unauthorizedMethods` | Phoenix public face |
| --- | --- | --- | --- |
| `CreateAccessToken` | `@parseCredentials({})` — uses `request.auth.credentials.id` | **not listed** | **signed** (`auth: 'parseCredentials'`) |
| `GetAccountByAccessToken` | `@parseCredentials({})` — does **not** read credentials | **listed**: `Account_20151111.GetAccountByAccessToken` in `auth.ctrl.ts` `unauthorizedMethods` | **anonymous** for that exact target (`auth: 'none'`); a supplied `Authorization` is still verified |
| `ResetKeys` | `@parseCredentials({})` — uses `request.auth.credentials.id` | **not listed** | **signed** (`auth: 'parseCredentials'`) |

None of the three is `adminOnly`. A missing `ACCOUNT_ANONYMOUS_TARGETS` entry
for `GetAccountByAccessToken` would have turned the public gateway operation
into a 401; it is listed.

`parseCredentials({})` on the Account-ws boundary does not itself require a
live `id` (only `adminOnly` rejects). The public Classic/Account face still
uses SigV4 as the A-04/A-03 identity, matching sibling slices.
`x-amz-credentials` is not a public caller switch.

## Candidate behavior

`packages/account/src/accountIdentity.js` adds the three `OPS` entries and
updates `ACCOUNT_IDENTITY_METHODS` / `ACCOUNT_ANONYMOUS_TARGETS`.
`robotFace.js` already dispatches Account prefix requests through
`handleAccountIdentity` before the A-02 `CreateHubToken` table; unimplemented
Account operations still return `UnknownOperationException`.

`CreateAccessToken` loads the signed account via `findById`, then signs the
same claim object as `createAuthenticatedHubToken` (`accessKeyId`, `email`,
`friendlyId`, `id`, `payload`, `secretAccessKey`, `iat`, `exp`) with
`ETCO_server_webTokenSecret` or `WEB_TOKEN_SECRET`. Lifetime is
`WEB_TOKEN_LIFETIME = 3 * 60 * 60` seconds. An omitted `payload` becomes
`null` (`payload = null` default in the controller). Hub tokens remain on
`ETCO_server_hubTokenSecret` / `HUB_TOKEN_SECRET`; this candidate only aliases
`createAuthenticatedWebToken` onto the existing hub helper and does not change
`issueHubToken`.

`GetAccountByAccessToken` verifies the JWT with the web secret
(`token.ctrl.ts getWebToken` → `webToken.verify`; no old-secret fallback
because source constructs the web `WebToken` as `(webTokenSecret, "", 0)`),
then `findById(tokenObj.id)` (`ACCOUNT_NOT_FOUND` / `ACCOUNT_IS_DELETED`), and
returns the verified claim object.

`ResetKeys` calls the existing `resetAccessKeys` helper (`fillAccessKeys`: 20
alnum `accessKeyId`, 40 alnum `secretAccessKey`, persist) and returns
`accountToSourceJson(..., { unsafe: true })` — the same unsafe projection as
`Create` / `Login`. No second projection.

`findById` is inherited by all three controller methods.

## Operation matrix

| Wire operation | Auth | Ownership | Declared errors covered | Persistence | Candidate status |
| --- | --- | --- | --- | --- | --- |
| `CreateAccessToken` | SigV4 | signed account | Joi 422 for non-object / non-string / empty `payload`; `MISSING_AUTH_HEADER 401`; `SIGNATURE_MISMATCH 401`; `ACCOUNT_NOT_ACTIVE 403` | none (JWT only) | **ready for bounded review** |
| `GetAccountByAccessToken` | none for exact `Account_20151111.GetAccountByAccessToken` | token `id`, not the caller | Joi 422 for missing/empty/non-string `token`; `ACCOUNT_NOT_FOUND 404`; `ACCOUNT_IS_DELETED 404`; jsonwebtoken failures → 500 (see divergences) | read only | **ready for bounded review** |
| `ResetKeys` | SigV4 | signed account; no robot block | `MISSING_AUTH_HEADER 401`; no payload validator (null body accepted) | new keys survive reopen; previous SigV4 keys become `ACCESS_KEY_NOT_FOUND` | **ready for bounded review** |

None of the three is claimed **bounded accepted**. That label is root's. None
is verified parity.

## Candidate divergences (for root to classify)

These are differences vs pinned source, or source behaviors that look
surprising. They are **not** recorded in `DIVERGENCES.md`. Root owns that
file and the harmless/required decision. This write-up does not classify them.

1. **jsonwebtoken failures on `GetAccountByAccessToken`.** Source
   `getWebToken` rethrows `jsonwebtoken` errors. `server.ts` maps non-Boom
   errors to `Boom.badImplementation("Internal server error.", err)` (Hapi
   500 JSON). Phoenix emits AWS-JSON `{__type: InternalFailure, message:
   "Internal server error"}` status 500. It does **not** remap to
   `TOKEN_EXPIRED` (that code is the 15-minute Token scheme in
   `token.ctrl.ts findById`, unused by these operations). Original Hapi
   envelope was not replayed.
2. **`GetAccountByAccessToken` returns the full `jwt.verify` payload**,
   including `iat` and `exp`. Generated `TokenResponse` lists
   `id` / `accessKeyId` / `secretAccessKey` / `email` / `friendlyId` /
   `payload` only. Source returns `tokenObj` as-is.
3. **ResetKeys does not rewrite a previously issued web token.**
   `GetAccountByAccessToken` returns the secrets snapshotted into the JWT at
   `CreateAccessToken` time, then only `findById` for existence. After
   `ResetKeys`, lookup still returns the old keys while SigV4 with those keys
   fails. This is the source controller, not a Phoenix invention.
4. **`GetAccountByAccessToken` does not bind the caller to the token.** The
   handler never reads `request.auth.credentials`. Combined with the gateway
   unauthorized list, an unsigned request with a valid web token succeeds. A
   signed outsider also succeeds.
5. **Public SigV4 vs internal `x-amz-credentials`.** Same Phoenix public-face
   adapter as the other A-03 slices. Source Account-ws identity for
   `CreateAccessToken` / `ResetKeys` is the gateway-forwarded credentials
   header.
6. **Web secret configuration.** Source is `config.server.webTokenSecret`
   (`ETCO_server_webTokenSecret`). Phoenix also accepts `WEB_TOKEN_SECRET`.
   Missing secret was not executed against original `jsonwebtoken.sign`.
7. **`AccountUpdated` postSave SNS** is not implemented. `ResetKeys` persists
   the document only. Same gap as identity-core.
8. **Mongoose `toJSON`.** Numeric `updated`, no `__v`. Same as identity core.

## Evidence

Focused candidate tests (synthetic fixtures only):

```
node --test packages/account/test/accountAccessTokens.test.js
```

Result: tests 10, pass 10, fail 0. Receipt:
`.parity/reviews/a03-access-tokens-20260909/focused.stdout`.

Related regressions before the candidate commit (identity core, email/phone,
activation/recovery, CreateHubToken):

```
node --test packages/account/test/createHubTokenSigv4.test.js \
  packages/account/test/accountIdentity.test.js \
  packages/account/test/accountEmailPhone.test.js \
  packages/account/test/accountActivationRecovery.test.js
```

Result: tests 51, pass 51, fail 0.

`npm test` from the worktree root at implementation
`43210f54494df8b8ebda0861301cd8180816394c`:

```
npm test
```

Raw counts:

```
# tests 989
# pass 982
# fail 0
# cancelled 0
# skipped 7
# todo 0
```

`parity:check` valid. `parity:gate`
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.

Baseline on `8795d10` was tests 979 / pass 972 / skipped 7. The +10 tests /
+10 passes are the new focused file. The skip count of 7 is the known
worktree path artifact in `scripts/nlu-compiled-graphs-install.test.mjs`, not
this change.

Receipt: `.parity/reviews/a03-access-tokens-20260909/npm-test.stdout`.

CreateHubToken still verifies against `HUB_TOKEN_SECRET` and rejects
`WEB_TOKEN_SECRET` in the focused file; the A-02 `createHubTokenSigv4` suite
still passes.

## What this candidate did not establish

- Original-runtime HTTP for these three operations (source reading + Phoenix
  synthetic fixtures only).
- Original Hapi `Boom.badImplementation` wire bytes for a bad/expired web
  token.
- `jsonwebtoken` vs Phoenix `packages/common/src/jwt.js` byte identity for
  web tokens. Claim *keys and 3h lifetime* match the A-02 hub-token object;
  the signing secret is different by design.
- `FacebookPrepareLogin`, which calls `createAccessToken` (out of scope).
- Whether any original client depends on `iat`/`exp` in
  `GetAccountByAccessToken`.
- Live Classic/security-gw forwarding of `x-amz-credentials` for these
  operations.

## Concrete next step

Root reviews the auth split (signed CreateAccessToken/ResetKeys, anonymous
GetAccountByAccessToken), the JWT-failure 500 mapping, and the JWT snapshot
after ResetKeys, then either accepts this bounded slice or names the
envelope/auth repair. Do not mark A-03 verified from this candidate.
