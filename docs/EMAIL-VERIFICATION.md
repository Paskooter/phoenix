# Email verification

Phoenix records mailbox ownership separately from whether an account is active.
An active imported account is not automatically considered verified.

## Owner experience

- With Account SMTP configured, portal signup sends a verification email and
  requires confirmation before the new account can sign in. If sending fails,
  the account remains recoverable through **Resend verification email** on the
  sign-in screen.
- Existing active accounts keep their access. Until their current email has been
  confirmed, the console displays a prominent warning with a send button on
  every page, a status in the sidebar, and a **Not verified** card under Account.
- Account always displays **Verified** or **Not verified**. The warning and card
  share the same resend countdown. Returning to the console after confirming in
  another tab refreshes the status.
- The emailed `/verify-email#token=…` link opens a confirmation page. Pressing
  **Verify email address** consumes it. Opening the page alone does not consume
  the link, which avoids accidental verification by mail previews.
- A successfully confirmed email-change link verifies the new address. Password
  recovery and existing mailbox activation links also count as mailbox proof.
  Administrative activation alone does not.

Without SMTP, the local/LAN signup behavior remains available. Accounts are
honestly shown as unverified, and the console explains that verification mail is
unavailable. No account is marked verified merely because it could sign in.

## Delivery configuration

Use the existing Account mail relay settings documented in
[the runbook](RUNBOOK.md#configure-account-email-before-inviting-people):
`ETCO_account_mailSmtpHost`, port, secure/requireTLS, user/password, and
`ETCO_account_mailFrom`. Set `ETCO_account_portalUrl` and `PHOENIX_SITE_URL` to
the same canonical public HTTPS origin. Links use the configured origin, never
a caller-supplied Host header.

The dedicated `emailVerification.html` and `emailVerification.txt` templates
live in `packages/account/resources/templates`. Both contain the actual link;
HTML template values are escaped. If an operator overrides the template
directory, include both new templates in that directory.

## Limits and storage

| Rule | Limit |
|---|---|
| Minimum time between attempts per account | 60 seconds |
| Attempts per account in a rolling hour | 5 |
| Attempts per account in a rolling day | 20 |
| Signup/resend requests per client IP | 40 per hour |
| Link confirmations per client IP | 100 per 15 minutes |
| Link lifetime | 24 hours |

Account attempt limits include the signup email and failed delivery attempts.
They are reserved before sending and persisted in the Account store, so
concurrent requests and process restarts cannot bypass them. Client IP limits
are an additional in-memory bound and reset on process restart. Authenticated
resends return HTTP 429 and `Retry-After` when limited; anonymous resends return
the same accepted message regardless of whether an account exists or needs
verification, unless the client IP limit has been reached.

Verification tokens have 256 bits of randomness. Only their SHA-256 hashes are
stored in the `emailVerifications` collection. Each token is bound to the account
and its current email, expires, and can be used once. A successful resend
replaces the previous token; a failed resend preserves the previous working
link and still uses the attempt budget. Confirmation and token consumption are
persisted together. Deleted accounts, robot accounts, and accounts deactivated
for reasons other than pending signup cannot be activated through this flow.

The email contains a URL fragment, which browsers do not send to the server.
The confirmation page removes that fragment from history immediately and sends
the token only in its confirmation POST. The verification page has a
`no-referrer` policy and is not cached by the console service worker.

Mailbox proof stores `emailVerified`, `emailVerifiedAddress`, and
`emailVerifiedAt`. Public account views expose only the boolean and timestamp.
The boolean is valid only while the stored verified address matches the current
address. Clients cannot set these fields through profile updates.

## API

| Route | Behavior |
|---|---|
| `GET /api/me/email-verification` | Signed-in status, delivery availability, and retry seconds |
| `POST /api/me/email-verification/resend` | Send to the signed-in account's current email |
| `POST /api/signup/resend` | Anonymous recovery/resend by email; does not disclose account existence |
| `POST /api/email-verification/confirm` | Confirm `{ "token": "…" }` without requiring an existing session |

All unsafe routes use the portal's existing same-origin protections. Existing
`/api/signup/verify` and `/activate` links remain compatible.

## Local verification

Run focused backend tests without loading a deployment environment:

```sh
PHOENIX_ENV_FILE=/dev/null node --test \
  packages/account/test/emailVerification.test.js \
  packages/account/test/portalMailRecovery.test.js \
  packages/account/test/invitationTransport.test.js
```

The SMTP integration test uses a local test relay. The browser smoke uses a
temporary store and in-memory mail sink; it contacts no production mailbox or
robot. Puppeteer/Chrome come from the sibling `jibo-web-sim` project, as with
the existing portal smoke:

```sh
node scripts/portal-email-verification-smoke.mjs
```

Set `EMAIL_VERIFICATION_SMOKE_OUT` to a local directory to save mobile and
desktop screenshots from that smoke run.
