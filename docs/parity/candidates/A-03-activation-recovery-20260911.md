# A-03 candidate: Account activation and password recovery

Status: **candidate; unverified pending root review.** This is the second
coherent Account slice (ActivateByCode, ActivateById, ResendActivationCode,
SendPasswordReset, PasswordResetByCode). It does not close A-03 and does not
implement the other agent's email/phone/terms operations.

Base revision: `1a410c1`. Task id: `a03-activation-recovery-20260911`.
Candidate revision: `60e9de849beb8954f9ccb8b4c4b9e35798fdde2a`.

## Source contract

Pins actually read through the Jibo archive (not original-runtime execution):

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Account handler | `src/handlers/account.handler.ts` |
| Account controller | `src/controllers/account.ctrl.ts` (`sendActivation`, `activateByCode`, `activateById`, `resendActivation`, `sendPasswordReset`, `passwordReset`) |
| Account schema | `src/schemes/account.ts` (`dashlessUuid`, `toJSON` transform, `activationCode` / `passwordResetCode`) |
| Account errors | `src/errors/account.ts` |
| Mail controller | `src/controllers/mail.ctrl.ts` (`activation` / `passwordReset` subjects) |
| Config campaigns | `config/config.json` `campaign.salesforce.{activation,resetPassword}` |
| Framework dispatch | `jiborobot/srv-server` `src/server.ts` `lowerMethodName` = `split('.')[1]`, first character lowercased |
| Framework credentials | `jiborobot/srv-server` `src/parseCredentials.ts`; `adminOnly` → `AUTHORIZED_UNDER_ADMIN` |
| Framework validation | `jiborobot/srv-server` `src/validate.ts` (`Joi.validate(..., {allowUnknown:true})` → `Boom.badData` 422) |
| Generated API | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, `apis/account-2015-11-11.normal.json` |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`; `auth.ctrl.ts` unauthorizedMethods includes `ActivateByCode`, `ResendActivationCode`, `SendPasswordReset`, `PasswordResetByCode`. `ActivateById` is **not** on that list. `unactiveMethods` is only `Account_20151111.Remove`. |

The identity-core candidate
(`docs/parity/candidates/A-03-account-core-20260909.md`) is the reviewed
reference for this family. This slice reuses its SigV4 public face,
`accountToSourceJson`, pbkdf2 hasher, Joi-shaped 422 envelope, and store
persist/rollback helper.

## Candidate behavior

`packages/account/src/accountIdentity.js` now handles the five operations
alongside the identity core. `robotFace.js` passes the existing invitation
mail/SMTP seam through as `mailProviders`. Unimplemented Account operations
still return `UnknownOperationException` so Classic keeps proxying them
without a local handler. `ChangeEmail` is the explicit remaining-unknown
control in both test files.

Public Classic/Account identity follows the accepted A-04 Loop pattern: the
security-gateway SigV4 verifier runs on this face. The four public
activation/recovery targets skip verification only for the exact
unauthorized strings from `auth.ctrl.ts`. A supplied `Authorization` header
is always verified. `ActivateById` always requires a live, non-deleted,
**admin** account. Forged `x-amz-credentials` cannot replace the signed
caller. `@parseCredentials({ adminOnly: true })` runs before Joi, matching
the TypeScript decorator order.

Codes are `Account.dashlessUuid()` (uuid v4 with `-` stripped). There is
**no TTL** in these five controller methods. Re-issue overwrites the stored
code; consume clears it. Mail is fire-and-forget: `MailController.send`
rejections are logged and do not fail the request. Real SES/SMTP is not
contacted in tests; capturing providers and the local SMTP seam from the
invitation work are used instead.

Create now goes through `sendActivation` (source `create` →
`sendActivation` when `!isActive`) so an injected activation provider sees
the same dashless code the identity core already persisted. That is a
Create side-effect alignment, not a new operation.

## Operation matrix

| Wire operation | Auth | Ownership | Declared errors covered | Persistence | Candidate status |
| --- | --- | --- | --- | --- | --- |
| `ActivateByCode` | none for exact `Account_20151111.ActivateByCode`; signed header still verified | public code lookup | `ACTIVATION_CODE_NOT_FOUND 404`, `ACCOUNT_ACTIVATED 409`, `ACCOUNT_IS_DELETED 404`, `ACCOUNT_NOT_ACTIVE 403` for an inactive signer, Joi 422 for missing code | `isActive` true and `activationCode` absent after reopen | **ready for bounded review** |
| `ActivateById` | SigV4 + admin | payload `id`; non-admin is `AUTHORIZED_UNDER_ADMIN` before Joi | `AUTHORIZED_UNDER_ADMIN 401`, `ACCOUNT_NOT_FOUND 404`, `ACCOUNT_ACTIVATED 409`, `ACCOUNT_NOT_ACTIVE 403`, `MISSING_AUTH_HEADER 401`, `SIGNATURE_MISMATCH 401` | same activation clear as by-code | **ready for bounded review** |
| `ResendActivationCode` | none for exact target | public email lookup | Joi 422 invalid email, `ACCOUNT_NOT_FOUND 404`, `ACCOUNT_IS_DELETED 404`, `ACCOUNT_EMAIL_CHANGE_INCOMPLETE 401`, `ACCOUNT_ACTIVATED 409` | new dashless code replaces the old one; old code then 404s | **ready for bounded review** |
| `SendPasswordReset` | none for exact target | public email lookup | Joi 422 missing email, `EMAIL_NOT_VALID 422`, `ACCOUNT_NOT_FOUND 404`, `ACCOUNT_IS_DELETED 404` | `passwordResetCode` stored; allowed on active and inactive accounts | **ready for bounded review** |
| `PasswordResetByCode` | none for exact target | public reset-code lookup | Joi 422 missing code, `PASSWORD_NOT_VALID_STRING 401`, `PASSWORD_CODE_WRONG 404` | new pbkdf2 hash, `isActive` true, code cleared, **access keys unchanged** after reopen | **ready for bounded review** |

None of the five is claimed **bounded accepted**. That label is root's.
None is verified parity.

Handler JSON: `ActivateByCode` and `PasswordResetByCode` call
`toJSON({ unsafe: true })`. `ActivateById`, `ResendActivationCode`, and
`SendPasswordReset` return the document without `unsafe`, so keys are
omitted. Password/activation/reset codes never leave the wire body.

## Primary source findings (reported, not classified)

These are the places the task asked to treat as primary. Phoenix follows
the pinned controller text. Root owns whether any of them is a divergence.

1. **Code format.** Dashless uuid, same generator the identity core already
   stores on inactive Create.
2. **TTL.** None on activation or password-reset codes. The same controller
   expires phone codes at 10 minutes and email-reset tokens at 24 hours;
   these five methods do not.
3. **Single-use.** Re-issue overwrites. Consume deletes the field. A
   consumed or superseded code is not found.
4. **Already-active account.** Activate/resend throw `ACCOUNT_ACTIVATED
   409`. SendPasswordReset is allowed. PasswordResetByCode sets
   `isActive = true` and does not throw `ACCOUNT_ACTIVATED`.
5. **Reset vs credentials/sessions.** `passwordReset` hashes the password,
   clears `passwordResetCode`, and sets `isActive`. It does **not** call
   `reset()` / `fillAccessKeys`. Existing `accessKeyId` /
   `secretAccessKey` still authenticate. Account-ws has no session table;
   Phoenix portal cookies are not touched.
6. **Deleted account + leftover password reset code.**
   `Account.findOne({ passwordResetCode })` has no `isDeleted` filter.
   Phoenix follows that path: the reset succeeds, `isDeleted` stays true,
   `isActive` becomes true. This is a **candidate finding for root**, not
   a silent "harmless" classification.
7. **Signed ActivateByCode from the inactive account** is
   `ACCOUNT_NOT_ACTIVE` at the gateway (`unactiveMethods` is only
   `Remove`). The intended client path is unsigned.

SendPasswordReset validates email as `Joi.required()` then
`EMAIL_NOT_VALID`; ResendActivationCode uses
`Joi.string().email({minDomainAtoms:2}).required()` and therefore 422s
invalid addresses. That is the handler text, not a Phoenix invention.

## Evidence

Focused candidate tests (synthetic fixtures only):

```
node --test packages/account/test/accountActivationRecovery.test.js packages/account/test/accountIdentity.test.js
```

Result: 31 pass / 0 fail (16 activation/recovery + 15 identity core).
Receipt: `.parity/reviews/a03-activation-recovery-20260911/focused.stdout`.

`npm test` from the worktree root at candidate
`60e9de849beb8954f9ccb8b4c4b9e35798fdde2a`:

```
# tests 965
# pass 958
# fail 0
# skipped 7
# todo 0
```

`parity:check` reported a valid tracker. `parity:gate` reported
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
Full transcript: `.parity/reviews/a03-activation-recovery-20260911/npm-test.stdout`.

Baseline at `1a410c1` from the main checkout is 949 tests / 941 pass / 0
fail / 8 skip. This run adds the 16 activation/recovery tests (965 total).
Zero failures. Skip count in this worktree is 7; that is the documented
path artifact for
`scripts/nlu-compiled-graphs-install.test.mjs`, not a product change.

## Remaining gates (not claimed)

1. Original Node 8 / `@jibo/server` 4.0.12 handler execution and exact Joi
   10 messages for every primitive were not replayed. Validation messages
   here are source-shaped, not a 98-input original-runtime table.
2. Mongoose `toJSON` still emits Date ISO strings for `updated` and may
   include `__v`. Phoenix stores numeric `updated` and omits `__v`.
3. `AccountUpdated` SNS (`index.ts` postSave / `setImmediate`) is not
   implemented. These operations persist the document only.
4. No original `@jibo/jibo-server-client` Node 8 run and no live
   robot/family. Mail was exercised with capturing providers and the
   existing local SMTP seam, not SES.
5. Campaign URL mapping is the controller's `config.campaign[name]`
   lookup. Only the pinned `salesforce` keys were fixture-tested.
6. HTML template bytes include source branding assets (S3 image URLs).
   Placeholder substitution `{firstName}`, `{email}`, `{url}` is the
   asserted contract; original MIME wrapping of these two templates was
   not re-run as a separate SMTP capture.

## Explicitly unchanged

- `Account_20151111.CreateHubToken` remains the A-02 SigV4 path.
- Portal `/api/signup` and `/api/login` remain the Phoenix cookie face.
- The other agent's six operations, Facebook, photos, `Remove`,
  `ResetKeys`, `Search`, and the access-token pair keep proxying through
  Classic and return `UnknownOperationException` on the local Account
  service.

## Reporting split

**Verified against pinned source or a real Phoenix runtime**

- Handler auth decorator vs gateway unauthorizedMethods for all five
  targets, including `ActivateById` admin-only and the four public
  targets.
- Declared controller error codes listed in the matrix, exercised over
  HTTP on Account and Classic.
- Dashless code format, overwrite-on-resend, clear-on-consume, no TTL
  branch in these methods.
- Unsafe vs safe JSON split from the handler `toJSON` calls.
- Password reset does not rotate access keys; Login/Get with the same
  keys succeed after reset once `isActive` is true.
- Store reopen for activation consume + password reset consume.
- Mail fire-and-forget containment (rejected provider does not fail the
  request).

**Inferred from source reading**

- Mongoose `findOne({ activationCode })` / `findOne({ passwordResetCode })`
  equality is emulated by scanning the JSON store.
- `activationCode = undefined` then `save()` unsets the field; Phoenix
  `delete`s it so in-memory and reopened snapshots agree.
- Campaign object shape beyond the pinned `salesforce` keys.
- Exact original Hapi serialization of a mongoose document returned
  without `toJSON({unsafe})` (ISO `updated`, possible `__v`).

**Still unknown**

- Deployed gateway alias / Node 8 handler replay.
- Original SES/SMTP delivery and EventSender `AccountUpdated` wire.
- Whether any client depended on password reset rotating keys (source
  does not rotate; reported above).
- Whether root wants `PasswordResetByCode` on a deleted row recorded as
  a divergence or left as source-faithful behavior.

All five operations in this slice are **ready for bounded review**. Root
owns the "bounded accepted" label.
