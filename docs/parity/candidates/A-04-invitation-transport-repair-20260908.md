# A-04 invitation transport repair

Status: **implementation candidate, unverified; root review is required.**
This candidate is based on `ba0e3b417cd7e2c95dd3c4ec5d7cf671499e1b7e` and
keeps its local deployment scope. The earlier deployment report remains
unchanged; this note records the transport corrections that close two source
visible gaps.

## Source boundary

The mail behavior is pinned to `smtp-connection@1.2.0`, used by the recovered
Nodemailer 1.4 transport. The source file used for the controls is
`/tmp/a04-invitation-smtp-connection-20260908/package/src/smtp-connection.js`
(SHA-256 `3317ca2fede3487c48fa1d0157babac3db5dbe0c8a1ca4ed444dfb0ef6887590`)
and its package archive is
`/tmp/a04-invitation-smtp-connection-20260908/smtp-connection-1.2.0.tgz`
(SHA-256 `01bb719bfedccce4d42f36fcbc82d2fabd7d1567743d8abbebef66e9b6f1a77d`).
The relevant source behavior is:

- after a successful EHLO, STARTTLS is sent when advertised unless
  `ignoreTLS` is set; `requireTLS` also sends it so a relay without support
  fails explicitly (lines 662-684);
- the connection wraps the existing socket in TLS and repeats EHLO before
  authentication (lines 726-764);
- advertised authentication mechanisms are recorded in source order
  `PLAIN`, `LOGIN`, `CRAM-MD5`, `XOAUTH2` (lines 687-705), and the first
  supported mechanism is selected unless `authMethod` is explicit (lines
  214-256).

The event boundary is the pinned `@jibo/server@4.0.12` EventSender at
`/home/shell/work/phoenix/.parity/reviews/a06-original-runtime/node_modules/@jibo/server/dst/eventSender.js`
(SHA-256
`039e57b81a570d3e1650c9b6f18c9500f2e10be953bfcf50410a28e99bf14237`). Its
`send` method creates a Promise before it reads `event.payload.eventKey` or
calls `event.validate()` (lines 11-21), so synchronous validation failures are
rejected promises.

The archived NotificationHub source at
`jiborobot/srv-notification-ws@e42bfe01506a8febf3005ac536fda735bba49d0d`
registers sixteen events, including `LoopUpdated`, but none of
`InvitedToJoinLoop`, `InvitationToLoopAccepted`, `InvitationToLoopDeclined`,
`MemberRemovedFromLoop`, or `LoopCreated`. This candidate therefore keeps a
configured local event publisher as an explicit deployment adapter and does
not invent a NotificationHub handler for the invitation event.

## Changes

`packages/account/src/smtpMail.js` now:

- parses EHLO STARTTLS and AUTH capabilities;
- upgrades the same connection with `tls.connect({socket})`, repeats EHLO, and
  authenticates only after the TLS handshake;
- selects source-supported PLAIN, LOGIN, CRAM-MD5, or XOAUTH2 mechanisms,
  honoring an explicit `authMethod` and the source PLAIN fallback when no
  mechanism is advertised;
- exposes `ignoreTLS`, `requireTLS`, `authMethod`, and nested TLS options in
  object and environment configuration.

`packages/account/src/invitationEventOutbox.js` now wraps event validation,
timestamping, and durable commit in a Promise boundary. Filesystem,
serialization, or event validation errors that happen before a publisher is
called are therefore rejected promises and leave the last committed queue
state intact. Publisher failures continue to retain and count the event.

## Controls

The focused loopback test command was:

```text
node --test packages/account/test/invitationDeployment.test.js packages/account/test/invitationTransport.test.js
```

It exited `0` with **7 passed, 0 failed**. The receipt is
`.parity/reviews/a04-invitation-transport-repair-20260908/node22-focused.tap`.
The SMTP control creates a short-lived synthetic localhost certificate with
OpenSSL, advertises STARTTLS and LOGIN, and records that the second EHLO,
AUTH LOGIN exchange, credentials, envelope, and DATA all occur after TLS.
A second relay control verifies `requireTLS` rejects a relay that returns 502
to STARTTLS. The event test checks both a throwing `validate()` method and a
throwing atomic rename: each `send()` call immediately returns a Promise that
rejects, and the failed commit has no pending in-memory row.

The unchanged exact-source control command was:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-invitation-transport-repair-20260908/source-smtp-control.cjs
```

It exited `0` against the pinned `smtp-connection@1.2.0` implementation. Its
receipt is
`.parity/reviews/a04-invitation-transport-repair-20260908/source-smtp-control.json`.
The source sequence is `EHLO`, `STARTTLS`, `EHLO`, `AUTH LOGIN`, username,
password, `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT`; the candidate test asserts the
same sequence and TLS boundary. The only stderr is the old package's Node 22
`Buffer()` deprecation warning.

The changed files at the candidate checkpoint and their SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `packages/account/src/smtpMail.js` | `cf1f9ca0600f31a57939862dd8594ec0e594c752ea0feeebc1350c6fde061e1e` |
| `packages/account/src/invitationEventOutbox.js` | `1c24c8a9f3acfe141eef42a06403dacffd2a2e74d3f5009b428dfb80e92bcc76` |
| `packages/account/test/invitationDeployment.test.js` | `9db84775341665ce7b09727998e6c246ed93176104de7a40e2d902aa2089dd3a` |
| `packages/account/test/invitationTransport.test.js` | `174e2617218dd446827048f00aa7624f04c0c629af0b46dcb4602bf644aa69eb` |

## Limits

This remains a local SMTP/event deployment adapter, not SES/SNS acceptance or
live mail delivery. The adapter supports the source mechanisms exercised by
the controls; provider-specific pooling, OAuth token-refresh callbacks, and
all Nodemailer MIME encodings remain outside this bounded repair. Existing
mail bodies still use Phoenix's dependency-free multipart writer; a mail
client that treats 8-bit and the source's quoted-printable encoding
differently needs a separate source control. No cloud event consumer or robot
notification is claimed. Root must verify integration, configured deployment,
and any provider-specific TLS policy before acceptance.
