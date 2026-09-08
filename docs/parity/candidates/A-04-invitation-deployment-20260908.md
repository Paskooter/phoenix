# A-04 follow-up: configurable invitation delivery

Status: **implementation candidate, unverified; root review is required.** This
follow-up is based on `fbb3df53433bb9dca3071a12fedde2c22d7c0fd5` and only adds
the local deployment boundary for the invitation side effects already covered
by `A-04-invitation-side-effects-20260908.md`.

## Source contract

The source is `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
The relevant source behavior is in `src/controllers/mail.ctrl.ts` and
`src/controllers/loop.ctrl.ts`:

- `MailController` reads `resources/templates/{invitation,invitationExistingUser}.{html,txt}` at construction, uses subject `Invitation`, chooses `config.mail.smtp` when present, and otherwise constructs the SES transport.
- `send(to, options)` replaces own option keys in the HTML template using the source `for ... in`/`hasOwnProperty` loop. The text template is passed through unchanged. Its `sendMail` Promise is caught by the invitation controller without delaying the HTTP response.
- `sendInvitationMail` uses the existing-user template and `/home?email=...` when an account exists, and the new-user template and `/create?email=...&code=...` otherwise. The controller calls mail before constructing/sending `InvitedToJoinLoop`.

The local template files in this candidate were copied from that source path
without edits. Their SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `packages/account/resources/templates/invitation.html` | `fdb9818b8244c5e55601aa2c6422aeeae72d67cf2e9e28e8dd2acdd56d91e386` |
| `packages/account/resources/templates/invitation.txt` | `be86b455bb22b97e2eba2a3b9f1da5527c38f344fdbb226218b73f83cfd0335c` |
| `packages/account/resources/templates/invitationExistingUser.html` | `debb21ba494fbf1587cca1cba328adc4fbba951cf9e91ece28617f6e132ad8ec` |
| `packages/account/resources/templates/invitationExistingUser.txt` | `be86b455bb22b97e2eba2a3b9f1da5527c38f344fdbb226218b73f83cfd0335c` |

The event contract remains the pinned `@jibo/server@4.0.12` `EventSender` /
`InvitedToJoinLoop` contract. The source EventSender publishes validated event
JSON to SNS. The read-only runtime files used for the source-shape comparison
are under `.parity/reviews/a06-original-runtime/node_modules/@jibo/server`:

| Runtime file | SHA-256 |
| --- | --- |
| `dst/eventSender.js` | `039e57b81a570d3e1650c9b6f18c9500f2e10be953bfcf50410a28e99bf14237` |
| `dst/events/base.js` | `c9fc5a65a5e1a25fe0f534423a9840b0f333119a34f7d6d078129c0beafb7e07` |
| `dst/events/loop/InvitedToJoinLoop.js` | `d672494dbb071473e549adfd3cb648b303fa5678e2e0c162cf55b000c34ba5c1` |

This candidate does not claim SNS compatibility or map this account event
into the separate Classic `NotificationHub`: the archived notification-ws
handlers do not register `InvitedToJoinLoop`.

## Candidate implementation

`createAccountService()` now resolves `invitationProviders` through
`createConfiguredInvitationProviders()`. Explicit providers remain untouched;
missing providers can be filled from local deployment settings:

| Purpose | Explicit option | Environment setting |
| --- | --- | --- |
| SMTP URL | `invitationSmtp` | `ETCO_account_mailSmtpUrl` or `ETCO_account_mailSmtp` |
| SMTP object | `invitationSmtp` | `ETCO_account_mailSmtpHost`, `...Port`, `...Secure`, `...User`, `...Password`, `...TimeoutMs`, `...Servername`, `...RejectUnauthorized` |
| portal URL | `invitationProviders.portalUrl` | `ETCO_account_portalUrl` |
| sender address | `invitationMailFrom` | `ETCO_account_mailFrom` |
| event queue file | `invitationEventFile` | `ETCO_account_invitationEventFile` or `ETCO_account_eventFile` |
| HTTP event consumer | `invitationEventUrl` | `ETCO_account_invitationEventUrl` or `ETCO_account_eventUrl` |
| event timeout/headers | `invitationEventTimeoutMs`, `invitationEventHeaders` | `ETCO_account_invitationEventTimeoutMs`, `ETCO_account_invitationEventHeaders` |

`SmtpMailProvider` is a small dependency-free SMTP client for `smtp:` and
`smtps:` endpoints. It supports the source mail options, SMTP authentication,
CRLF/dot-stuffed DATA, bounded command and whole-operation timeouts, and
explicit transport errors. No AWS credentials are read or required.

`InvitationEventOutbox` is a private file-backed EventSender counterpart. It
writes an event before attempting a configured publisher, atomically replaces
its file with a `0600` record, and removes a row only after a publisher
acknowledges it. A failure increments the attempt record and retains the event
for `recover()` or `consume(handler)` after restart. A configured HTTP consumer
posts the exact serialized event JSON with `x-phoenix-event-key` and accepts
2xx responses; a configured function/object publisher is also supported. A
URL with no explicit file derives `invitation-events.json` beside the Account
store. A file with no publisher is an explicit durable queue for a later local
consumer. With neither SMTP nor event configuration, the missing external
transport remains an explicit unavailable boundary rather than being presented
as delivered.

The existing `LoopUpdatedOutbox` and Classic `NotificationStore` remain
separate. This candidate does not invent an SNS-to-robot delivery path.

## Controls

`packages/account/test/invitationDeployment.test.js` runs entirely on loopback
with synthetic data:

- an actual Account HTTP request sends both the unknown-account `/create` mail
  and known-account `/home` mail to an ephemeral SMTP server, checks subject,
  recipient, substituted HTML, unchanged text template, event payload and
  `0600` queue cleanup;
- an actual HTTP event recipient receives the serialized
  `InvitedToJoinLoop` and acknowledges it with 202;
- a rejected publisher leaves one durable row with an attempt count, and a
  reopened sender publishes and removes it;
- absent configuration remains null, partial SMTP configuration fails
  explicitly, and string boolean options normalize correctly.

Command and result:

```text
node --test packages/account/test/invitationDeployment.test.js
3 passed, 0 failed
```

The previous frozen A-04 source/controller controls remain in
`.parity/reviews/a04-invitation-side-effects-20260908`; this follow-up does not
rewrite them. The complete Account package regression was also run with
`node --test packages/account/test/*.test.js`: **205 passed, 0 failed, 0
skipped**. The new loopback receipts are under
`.parity/reviews/a04-invitation-deployment-20260908/`.

## Remaining scope

This is not SES/SNS, Mongo, Hapi, generated-client, public security-gateway,
SMTP-provider, or live-robot acceptance. SMTP wire formatting is implemented
for a configured local relay but does not reproduce every Nodemailer feature
or provider-specific extension (for example, STARTTLS negotiation and pooled
connections are outside this adapter; use a local `smtps:` endpoint when TLS is
required). The HTTP event sink is a local deployment
adapter for the source event JSON, not an SNS protocol implementation. If no
mail or event configuration is supplied, those effects remain unavailable by
design and must be wired by deployment. Provider-error containment and the
mail-before-event ordering are inherited from the frozen A-04 candidate.
