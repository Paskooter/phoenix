# A-03 candidate: Account identity core

Status: **candidate; unverified pending root review.** This is the first
coherent Account slice (Create → Login → Get → Update → CheckEmail →
ChangePassword). It does not close A-03 and does not implement the remaining
Account operations.

Base revision: `5912ea4`. Task id: `a03-account-core-20260909`.

## Source contract

Pins actually read through the Jibo archive (not original-runtime execution):

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Account handler | `src/handlers/account.handler.ts` |
| Account controller | `src/controllers/account.ctrl.ts` |
| Account schema | `src/schemes/account.ts` |
| Account errors | `src/errors/account.ts` |
| Password hasher | `src/utils/password.ts` (`sha512$512$10000$salt$hash` pbkdf2) |
| Framework dispatch | `jiborobot/srv-server` `src/server.ts` `lowerMethodName` = `split('.')[1]`, first character lowercased |
| Framework credentials | `jiborobot/srv-server` `src/parseCredentials.ts` (JSON.parse `x-amz-credentials`; malformed → `{}`; JSON `null` retained) |
| Framework validation | `jiborobot/srv-server` `src/validate.ts` (`Joi.validate(..., {allowUnknown:true})` → `Boom.badData` 422; converted values are not written back) |
| Generated API | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, `apis/account-2015-11-11.normal.json` |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`; `auth.ctrl.ts` SHA-256 `776c0908cbb5e842fe7866e7d1e6640578c390d604536c76652707b50785881d` (same pin as A-04) |

The previous A-03 framing review (`docs/parity/candidates/A-03-review-20260906.md`)
is treated as a negative control: this slice does not use last-component
full-lowercase dispatch for these six operations, and it does not treat
caller-supplied `x-amz-credentials` as a public identity.

## Candidate behavior

`packages/account/src/accountIdentity.js` is the handler/controller pair for
the six operations. `robotFace.js` dispatches Account prefix requests through
it before the existing OOBE/`CreateHubToken` table. Unimplemented Account
operations still return `UnknownOperationException` so Classic keeps proxying
them without a local handler.

Public Classic/Account identity follows the accepted A-04 Loop pattern: the
security-gateway SigV4 verifier runs on this face. `Create`, `Login`, and
`CheckEmail` skip verification only for the exact unauthorized target strings
from `auth.ctrl.ts`. A supplied `Authorization` header is always verified.
`Get`, `Update`, and `ChangePassword` always require a live, non-deleted,
active account. Forged `x-amz-credentials` cannot replace the signed caller.

Internal `parseCredentials` is implemented and unit-tested as the original
Account-ws boundary. It is not a public caller switch.

Password hashing for these operations is the source pbkdf2 encoding. Portal
`createOwnerAccount` remains scrypt (Phoenix portal face). Login/ChangePassword
compare accepts both encodings so a portal-created fixture can authenticate
here. That dual compare is a Phoenix interoperability choice, not original
`compare()`.

Create follows the source defaults: `isActive` is false, keys are allocated,
the password is hashed, a dashless activation code is stored when the account
stays inactive, and no real mail is sent. Duplicate live emails are
`EMAIL_ALREADY_EXISTS 409`. A deleted row with the same email is removed and
replaced. Age under 13 is `CHILD_NOT_ALLOWED_TO_CREATE 403`.

## Operation matrix

| Wire operation | Auth | Ownership | Declared errors covered | Persistence | Candidate status |
| --- | --- | --- | --- | --- | --- |
| `Create` | none for exact `Account_20151111.Create`; signed header still verified | public create | `EMAIL_ALREADY_EXISTS 409`, `CHILD_NOT_ALLOWED_TO_CREATE 403`, `EMAIL_NOT_VALID 422`, `PASSWORD_NOT_VALID_LENGTH 401`, `PASSWORD_NOT_VALID_STRING 401`, Joi 422 for non-object | account row + activation code survive reopen; duplicate does not add a second row | **ready for bounded review** |
| `Login` | none for exact `Account_20151111.Login` | public password lookup | `ACCOUNT_IS_DELETED 404`, `ACCOUNT_EMAIL_CHANGE_INCOMPLETE 401`, `ACCOUNT_NOT_FOUND 404`, `WRONG_PASSWORD 401` | read only | **ready for bounded review** |
| `Get` | SigV4 / `parseCredentials` identity | caller or accepted members of loops the caller can list; admin skips the membership check | `MEMBER_CAN_REQUEST 401`, `MISSING_AUTH_HEADER 401`, `SIGNATURE_MISMATCH 401`, `ACCOUNT_NOT_ACTIVE 403`; empty/absent `ids` → `[credentials.id]` | read only | **ready for bounded review** |
| `Update` | SigV4 | authenticated account only; robots rejected | `ROBOT_CANNOT_BE_UPDATED 409`, `STALE_VERSION 409`; email/password/keys in the payload are ignored | firstName/gender/messagingAllowed survive reopen | **ready for bounded review** |
| `CheckEmail` | none for exact `Account_20151111.CheckEmail` | public existence; deleted counts as absent | Joi 422 for invalid email; `{exists}` otherwise | no write | **ready for bounded review** |
| `ChangePassword` | SigV4 | authenticated account; old password must match | `WRONG_PASSWORD 401`, `PASSWORD_NOT_VALID_STRING 401` | pbkdf2 hash survives reopen; old password fails Login | **ready for bounded review** |

None of the six is claimed **bounded accepted**. That label is root's. None is
verified parity. `OWNER_CAN_MANIPULATE` is listed on the A-01 Get row but is
not thrown by `AccountController.get`; this candidate follows the controller.

`Account.Get` previously answered unsigned Classic requests with
`CREDENTIALS_REQUIRED`. The public face now matches the gateway
`MISSING_AUTH_HEADER` used by Loop. The LoopManager fallback test was updated
and still returns `data[0].id` for a signed caller.

## Evidence

Focused candidate tests (synthetic fixtures only):

```
node --test packages/account/test/accountIdentity.test.js
```

Result: 15 pass / 0 fail. Receipt:
`.parity/reviews/a03-account-core-20260909/focused.stdout`.

Related regressions run before the candidate commit:

```
node --test packages/account/test/*.test.js packages/classic/test/*.test.js packages/common/test/*.test.js
```

Result: 309 pass / 0 fail.

`npm test` from the worktree root at candidate `3729f0b56f2d36020acb260dd4c2b6e8b1508923`:

```
# tests 923
# pass 916
# fail 0
# skipped 7
# todo 0
```

`parity:check` reported a valid tracker. `parity:gate` reported
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
Full transcript: `.parity/reviews/a03-account-core-20260909/npm-test.stdout`.
Baseline at `5912ea4` was 908 tests / 900 pass / 0 fail / 8 skip. This run adds
the 15 identity tests (923 total). Zero failures. One previously skipped case
is no longer in the skip count (7 vs 8); that is a runner-count observation,
not a claimed product change.

Per-operation HTTP controls live in
`packages/account/test/accountIdentity.test.js` and cover Account and Classic,
positive paths, declared error codes, Joi 422, forged credentials, inactive
signers, store reopen, and unimplemented `ActivateByCode` remaining unknown.

## Remaining gates (not claimed)

1. Original Node 8 / `@jibo/server` 4.0.12 handler execution and exact Joi 10
   messages for every primitive were not replayed. Validation messages here
   are source-shaped, not a 98-input original-runtime table.
2. Mongoose `toJSON` still emits Date ISO strings for `updated` and may include
   `__v`. Phoenix stores numeric `updated` and omits `__v`. Mongo `$in` result
   order is not claimed.
3. `AccountUpdated` SNS (`index.ts` postSave / `setImmediate`) is not
   implemented. Create/Update/ChangePassword persist the document only.
4. Create invitation linkage (`updateAccountByInvitation` /
   `updateInvitationsByEmail`) is implemented against the controller text but
   has no dedicated invitation-code fixture in this slice.
5. Activation mail is not sent. The activation code is stored. ActivateByCode
   remains unimplemented by design.
6. No original `@jibo/jibo-server-client` Node 8 run and no live robot/family.

## Explicitly unchanged

- `Account_20151111.CreateHubToken` remains the A-02 SigV4 path.
- Portal `/api/signup` and `/api/login` remain the Phoenix cookie face.
- Unimplemented Account operations keep proxying through Classic and return
  `UnknownOperationException` on the local Account service.
