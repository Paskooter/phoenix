# A-03 candidate: email change, phone verification, terms

Status: **candidate; unverified pending root review.** This is the contact-detail
and consent slice of A-03. It does not close A-03 and does not implement
activation, password recovery, Facebook, photos, `Remove`, `ResetKeys`,
`Search`, or the access-token pair.

Base revision: `1a410c1`. Implementation commit:
`9700b75ba87bef50ac7233746c563fa0eceab570`. Task id:
`a03-email-phone-20260911`.

## Source contract

Pins actually read through the Jibo archive (not original-runtime execution):

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Account handler | `src/handlers/account.handler.ts` |
| Account controller | `src/controllers/account.ctrl.ts` |
| Account schema | `src/schemes/account.ts` |
| Email reset schema | `src/schemes/email.reset.ts`, `src/schemes/email.reset.status.ts` (`new` / `used` / `canceled`) |
| Phone verification schema | `src/schemes/phoneVerification.ts` (6-digit `randomBytes(6) % 10`) |
| Account errors | `src/errors/account.ts` |
| Token errors | `src/errors/token.ts` |
| Mail controller | `src/controllers/mail.ctrl.ts` plus `resources/templates/emailReset{,.Complete}.{txt,html}` |
| Framework dispatch | `jiborobot/srv-server` `src/server.ts` `lowerMethodName` = `split('.')[1]`, first character lowercased; empty handler result → `reply()` |
| Framework credentials | `jiborobot/srv-server` `src/parseCredentials.ts` (`adminOnly` → `AUTHORIZED_UNDER_ADMIN` 401) |
| Framework validation | `jiborobot/srv-server` `src/validate.ts` (`Joi.validate(..., {allowUnknown:true})` → `Boom.badData` 422) |
| Generated API | `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`, `apis/account-2015-11-11.normal.json` and `apis/accountadmin-2015-11-11.normal.json` |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c` `auth.ctrl.ts` |

Gateway `unauthorizedMethods` for this slice: **only**
`Account_20151111.ConfirmEmailReset`. `ChangeEmail`, `ResetEmail`,
`SendPhoneVerificationCode`, `VerifyPhoneByCode`, and `AcceptTerms` require a
signature. A supplied `Authorization` header is always verified.

## Candidate behavior

The six operations live in `packages/account/src/accountIdentity.js` beside the
identity core. `robotFace.js` awaits that dispatcher before OOBE/`CreateHubToken`.
Unimplemented Account operations still return `UnknownOperationException` so
Classic keeps proxying them.

Public identity is the signed access key (A-04 Loop pattern).
`x-amz-credentials` cannot grant admin. `ResetEmail` is `adminOnly` on the
source handler; the public face reads `isAdmin` from the verified account.

Two-step email change follows the controller:

1. `ChangeEmail` / `ResetEmail` write an `emailResets` row (`uuid` code, status
   `new`) and return `{id: emailReset._id}`. They do **not** write `account.email`.
2. The old email keeps working on `Login`. A `Login` with the pending new email
   hits the identity-core `findByEmail` path and returns
   `ACCOUNT_EMAIL_CHANGE_INCOMPLETE 401`.
3. `ConfirmEmailReset` (public) looks up the code, enforces status `new` and a
   24-hour TTL, sets `account.email`, calls `reset()` (new access keys), marks
   the matching row `used` and siblings `canceled`, and returns an empty 200.

Mail is fire-and-forget through the existing local SMTP seam (`emailReset` to
the new address, `emailResetComplete` to the old). No real mail is sent in
tests. SMS uses an injected provider or optional `ETCO_account_smsUrl` HTTP
POST `{to, body}`; the default with neither configured is a contained no-op
success. A failing provider returns `PHONE_VERIFICATION_SERVICE_FAILED 503`
**after** the verification row is saved, matching source order.

Phone codes are six decimal digits. `VerifyPhoneByCode` accepts only the latest
row for the signed account, expires at 10 minutes, writes `phoneNumber`, and
deletes every verification for that account.

`AcceptTerms` stamps `termsAccepted = Date.now()` and returns the safe Account
projection. A later call overwrites the stamp.

## Operation matrix

| Wire operation | Auth | Ownership | Declared errors covered | Persistence | Candidate status |
| --- | --- | --- | --- | --- | --- |
| `ChangeEmail` | SigV4 | signed account; password must match | `WRONG_PASSWORD 401`, `EMAIL_WAS_NOT_CHANGED 409`, `EMAIL_ALREADY_EXISTS 409`, Joi 422 | `emailResets` row survives reopen; `account.email` unchanged | **ready for bounded review** |
| `ResetEmail` | SigV4 + signed `isAdmin` | admin; `payload.id` is the target | `AUTHORIZED_UNDER_ADMIN 401`, `EMAIL_WAS_NOT_CHANGED 409`, deleted-occupant rewrite | reset id is the EmailReset `_id`; account email waits for confirm | **ready for bounded review** |
| `ConfirmEmailReset` | none for the exact target | public code lookup | `EMAIL_RESET_TOKEN_NOT_FOUND 404`, `EMAIL_RESET_TOKEN_EXPIRED 409` | email + rotated keys + USED/CANCELED survive reopen | **ready for bounded review** |
| `SendPhoneVerificationCode` | SigV4 | signed account | Joi 422, `PHONE_VERIFICATION_SERVICE_FAILED 503` | row saved before SMS; failure leaves the row | **ready for bounded review** |
| `VerifyPhoneByCode` | SigV4 | signed account; latest code only | `TOKEN_NOT_FOUND 404`, `PHONE_TOKEN_EXPIRED 409` | `phoneNumber` survives reopen; all rows for the account removed | **ready for bounded review** |
| `AcceptTerms` | SigV4 | signed account | `MISSING_AUTH_HEADER 401`, `ACCOUNT_NOT_ACTIVE 403` | `termsAccepted` stamp survives reopen; later call overwrites | **ready for bounded review** |

None of the six is claimed **bounded accepted**. That label is root's. None is
verified parity.

`PHONE_TOKEN_NOT_FOUND` in `src/errors/token.ts` is declared with wire code
`TOKEN_NOT_FOUND`. This candidate emits that code.

`ChangeEmail` lowercases the email in the handler before `resetEmail`.
`ResetEmail` does not; `EMAIL_WAS_NOT_CHANGED` is an exact `account.email ===
email` comparison, then the stored reset email is `email.toLowerCase()`. That
follows the source handler/controller split.

## Candidate divergences (for root to classify)

These are differences vs pinned source. They are **not** recorded in
`DIVERGENCES.md`. Root owns that file and the harmless/required decision.

1. **`confirmEmailReset` USED vs CANCELED identity.** Source is
   `if (request._id === emailReset._id)` on Mongoose ObjectIds after
   `EmailReset.find({ accountId })`. Those are different document instances, so
   reference `===` would mark every sibling — including the confirmed row —
   `canceled`. Phoenix `_id` values are strings, so value equality marks the
   matching row `used` and the others `canceled`. This candidate implements the
   string-id / schema-intended split.
2. **No unique email index.** Source `Account.email` is unique+sparse. A second
   `ConfirmEmailReset` onto an email that became live after the first confirm
   would fail at Mongo. Phoenix JSON storage does not enforce that index;
   `resetEmail` only rejects a live occupant at request time.
3. **`AccountUpdated` postSave SNS** is not implemented. `AcceptTerms`,
   confirm, and phone verify persist the document only. Same gap as the
   identity-core candidate.
4. **Default SMS seam.** Source awaits Twilio and throws 503 on failure.
   Phoenix with no `ETCO_account_smsUrl` and no injected provider succeeds
   without sending. A failing injected or HTTP provider still returns 503 and
   leaves the row.
5. **Mail transport.** Source MailController uses configured SMTP or SES and
   swallows send failures. Phoenix uses the invitation local SMTP seam when
   configured, otherwise a no-op. Templates were copied from the pinned
   `resources/templates`.
6. **Mongoose `toJSON`.** Numeric `updated`, no `__v`. Same as identity core.
   Confirm empty body is `content-length: 0`; original Hapi `reply()` envelope
   was not replayed.

A-01 map notes that were **not** followed because they disagree with the
pinned handler/controller (source wins):

- ChangeEmail `EMAIL_NOT_VALID 422` is not thrown; invalid email is Joi
  `Boom.badData` 422 from `Joi.string().email({minDomainAtoms: 2})`.
- ChangeEmail does **not** cancel prior reset rows. Only `confirmEmailReset`
  rewrites statuses.

## Evidence

Focused candidate tests (synthetic fixtures only):

```
node --test packages/account/test/accountEmailPhone.test.js
```

Result: 11 pass / 0 fail. Receipt:
`.parity/reviews/a03-email-phone-20260911/focused.stdout`.

`npm test` from the worktree root at implementation
`9700b75ba87bef50ac7233746c563fa0eceab570`:

```
# tests 960
# pass 953
# fail 0
# skipped 7
# todo 0
```

`parity:check` reported a valid tracker. `parity:gate` reported
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
Full transcript: `.parity/reviews/a03-email-phone-20260911/npm-test.stdout`.

Baseline at `1a410c1` from the main checkout is 949 tests / 941 pass / 0 fail /
8 skip. This run is 960 / 953 / 0 / 7. The 11 new focused tests account for the
added cases. The skip count 7 vs 8 is the documented worktree path artifact
(`scripts/nlu-compiled-graphs-install.test.mjs` resolving
`<repo>/../../reference/...`); it is not a product change from this slice.

## Remaining gates (not claimed)

1. Original Node 8 / `@jibo/server` 4.0.12 handler execution was not replayed.
2. Live Twilio, SES, and campaign URL maps were not exercised.
3. No original `@jibo/jibo-server-client` Node 8 run and no live robot/family.
4. `AccountUpdated` delivery remains unimplemented.
5. Exact Hapi empty-body headers for `ConfirmEmailReset` vs Phoenix
   `content-length: 0` were not compared on the original runtime.

## Explicitly unchanged

- Identity-core Create/Login/Get/Update/CheckEmail/ChangePassword.
- `Account_20151111.CreateHubToken` remains the A-02 SigV4 path.
- Activation and password-recovery operations remain unimplemented by design
  (other agent).
- Unimplemented Account operations keep proxying through Classic.

## Reporting split

**Verified against pinned source reading plus Phoenix HTTP tests (not original
runtime):**

- Auth mode per operation, including ConfirmEmailReset on the gateway anonymous
  list and ResetEmail admin-only on the signed account.
- Two-step email change: pending row identity, old email still logs in, pending
  new email is `ACCOUNT_EMAIL_CHANGE_INCOMPLETE`, confirm writes email and
  rotates keys.
- Phone code format, latest-only, 10-minute TTL, single-use delete-all, 503 on
  SMS failure after insert.
- AcceptTerms stamp and overwrite.
- Store reopen for reset rows, phone number, terms stamp, and USED status.

**Inferred from source reading (not original-runtime replay):**

- Hapi `reply()` empty body for ConfirmEmailReset.
- Mongoose unique index behavior on a second confirm.
- ObjectId `===` USED/CANCELED source path.
- Twilio `messages.create` field names other than `to` / `body` (messaging
  service SID is not sent on the Phoenix HTTP seam).

**Still unknown:**

- Deployed gateway aliases and original Node 8 envelopes.
- Campaign-specific confirm URLs from `config.campaign[campaign].emailReset`.
- Whether any surviving client observes ConfirmEmailReset empty-body headers.
