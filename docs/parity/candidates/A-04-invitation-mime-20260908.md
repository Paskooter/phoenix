# A-04 invitation MIME compatibility follow-up

Status: **implementation candidate, unverified; root review is required.**

This follow-up starts from `4eb6e91e29dc61f47a89e958677bb98e7c0065a0`, the
reviewed local SMTP/event transport candidate. It addresses the remaining
substantive mail boundary: the previous writer marked both invitation parts
as `8bit`, which a relay without `8BITMIME` rejects or cannot safely deliver.

## Source contract

The source control uses the recovered Nodemailer `1.4.0` tree at
`/tmp/a04-invitation-mime-runtime-20260908-v2/node_modules`, executed by
Node `v22.22.0`. The source files used for MIME selection and encoding are:

| Source | SHA-256 |
| --- | --- |
| `nodemailer/src/compiler.js` | `21a27d1a6a4057a496596d28b01ca686593ad67cca3c7d570d5bcbcd653ed372` |
| `buildmail/src/buildmail.js` | `eec46dcd0bdfc30f202091844555315d9fd698972b7de74baccbb607884f58ae` |
| `libmime/src/libmime.js` | `95af25ec416ea3d967983dd1ca48f3de9fb0d1567ff05cac21e7379f3de64eab` |
| `libqp/lib/libqp.js` | `f55116d44b9a9fb130d236f6707d73bf136dc6eba68050e879d547df5e93ecac` |
| `nodemailer-smtp-transport/src/smtp-transport.js` | `e243eb7375816fc891779c27d791710e272221f5e2af8ac78f46a441c52d16aa` |
| `smtp-connection/src/data-stream.js` | `6babcb8a8f61b71b1b4a71e68bcd3b29740cbc19a26f7734fc60d5e1c7661249` |

The resolved source dependency versions are Nodemailer `1.4.0`, libmime
`1.2.0`, buildmail `1.3.0`, libqp `1.1.0`, nodemailer-smtp-transport `1.1.0`,
and smtp-connection `1.3.8`; these transitive versions are recorded as the
actual recovered tree, rather than inferred as the original lockfile.

`libmime.isPlainText` classifies printable ASCII, tab, and line breaks as
plain text. For a Unicode or control character, BuildMail selects
`quoted-printable`, and libqp encodes the UTF-8 bytes. The source SMTP
DataStream then normalizes line endings and performs SMTP dot stuffing.

## Implementation

`packages/account/src/smtpMail.js` now applies the same source plain-text
boundary to each text and HTML invitation part. Non-plain parts are encoded
from UTF-8 bytes as quoted-printable, with safe trailing whitespace handling
and physical lines no longer than the MIME limit. ASCII parts remain 7bit.
The existing SMTP envelope, configured `fromAddress`, default
`no-reply@jibo.com`, STARTTLS, authentication, and explicit local transport
configuration remain unchanged.

The deployment test now decodes quoted-printable content before checking the
source template split. This preserves assertions that text keeps literal
`{name}` while HTML performs option substitution.

## Source/candidate control

The source control command was:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-review-20260908/source-mime-control.cjs > source-mime-control.json 2> source-mime-control.err
```

It exited `0`. The candidate control command was:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-review-20260908/candidate-mime-control.mjs > candidate-mime-control.json 2> candidate-mime-control.err
```

It exited `0`. Both controls use the same synthetic sender, recipient,
subject, Unicode text (`café`, an emoji, and an em dash), and HTML owner
content. Each starts an owned loopback SMTP relay which advertises no
`8BITMIME` capability and rejects any non-ASCII DATA byte.

The decoded comparison command was:

```text
node /home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-review-20260908/compare-mime.cjs source-mime-control.json candidate-mime-control.json comparison.json
```

It exited `0`: one source case and one candidate case, zero decoded
differences, zero DATA high bytes on either side, equal plain and HTML
decoded bodies, equal media types and transfer encodings, and equal envelope
addresses. The machine-readable comparison is
`/home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-review-20260908/comparison.json`.

The source closes the SMTP connection after the send callback without a
recorded `QUIT`; the candidate sends `QUIT`. The comparator records this as a
session-level difference while excluding it from the decoded MIME result.
Generated boundaries, dates, message IDs, and source/candidate SMTP success
prose are likewise not used as MIME equality fields.

The candidate control output hashes are:

| Artifact | SHA-256 |
| --- | --- |
| `source-mime-control.cjs` | `a572272eb12c8405fd422492c8f6e06d125042c64edb221ecc08bf7a87256bb8` |
| `candidate-mime-control.mjs` | `3caa4cbfc11cfa7fd00774cdb43f03d75aee3943d6285c7a4d38cbc42556b818` |
| `compare-mime.cjs` | `c04682491b88c1e4d1ff8d7c7eb39f2b6e195b1c8db18d6f36996335b1f645d3` |
| `source-mime-control.json` | `437092cc964ea816661430f39e858efd14da7cdd0b3212606cd28c030f62ca67` |
| `candidate-mime-control.json` | `d3306ac95903b1d661c498c17607302d8b9cf21cb64f73431df4afa430c3fce4` |
| `comparison.json` | `983e44f04c21b67a540edc651f9b14ba2609b54367ef1be8b44c9fd18e017481` |

The source and candidate JSON controls contain raw DATA as base64 for
reproduction; the relay itself never writes outside this evidence directory.

## Validation

The focused command was:

```text
node --test packages/account/test/invitationDeployment.test.js packages/account/test/invitationTransport.test.js
```

It exited `0` with **8 passed, 0 failed**. The full Account test command was:

```text
node --test packages/account/test/*.test.js
```

It exited `0` with **210 passed, 0 failed**. The receipt is
`/home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-review-20260908/account-unit.tap`
(SHA-256 `d8670eb311e8a323c4341c860225c3951cd253d7676b49b82649cfa4fd18d8f1`).
The focused deployment test exercises configured sender
`local-sender@fixture.test`; the transport test and candidate control exercise
the default `no-reply@jibo.com` and a configured sender respectively. The
earlier pinned SMTP STARTTLS/LOGIN control remains in
`a04-invitation-transport-repair-20260908` and covers configured source SMTP
options.

## Limits

This is a bounded invitation MIME repair, not a full Nodemailer replacement.
Attachments, alternative types beyond the two invitation parts, provider
pooling, SES, SNS, and OAuth token refresh remain outside the candidate. The
source comparison runs the recovered old package tree on Node 22 rather than
an original Node 8 executable. Raw header folding, generated identity fields,
and the explicit `QUIT` difference remain qualified; decoded content and
relay compatibility are the substantive checked boundary. Root must perform
the final integration and deployment review.
