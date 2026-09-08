# A-04 invitation MIME long-line follow-up

Status: **implementation candidate, unverified; root review is required.**

This follow-up starts from the frozen MIME candidate
`2eaaea2cf69484890b66c97fcb1621f4100bec7a`. It closes a relay-compatibility
gap found after that candidate: an ASCII HTML line 1,207 octets long was sent
as `7bit` and was rejected by a relay enforcing the SMTP 998-octet line limit.

## Source contract

The source control uses the recovered Nodemailer tree at
`/tmp/a04-invitation-mime-runtime-20260908-v2/node_modules`, executed with
Node `v22.22.0`. The relevant source files and hashes are:

| Source | SHA-256 |
| --- | --- |
| `nodemailer/src/compiler.js` | `21a27d1a6a4057a496596d28b01ca686593ad67cca3c7d570d5bcbcd653ed372` |
| `buildmail/src/buildmail.js` | `eec46dcd0bdfc30f202091844555315d9fd698972b7de74baccbb607884f58ae` |
| `libmime/src/libmime.js` | `95af25ec416ea3d967983dd1ca48f3de9fb0d1567ff05cac21e7379f3de64eab` |
| `libqp/lib/libqp.js` | `f55116d44b9a9fb130d236f6707d73bf136dc6eba68050e879d547df5e93ecac` |
| `nodemailer-smtp-transport/src/smtp-transport.js` | `e243eb7375816fc891779c27d791710e272221f5e2af8ac78f46a441c52d16aa` |
| `smtp-connection/src/data-stream.js` | `6babcb8a8f61b71b1b4a71e68bcd3b29740cbc19a26f7734fc60d5e1c7661249` |

The recovered dependency versions are Nodemailer `1.4.0`, libmime `1.2.0`,
buildmail `1.3.0`, libqp `1.1.0`, nodemailer-smtp-transport `1.1.0`, and
smtp-connection `1.3.8`. These are the observed recovered tree versions;
the control does not claim the original lockfile was identical.

`buildmail` uses `libmime.hasLongerLines(content, 76)` while setting a string
body. For long plain text it adds `format=flowed` to `text/plain` and emits
flowed wrapping. For long HTML, `getTransferEncoding()` selects
`quoted-printable`; `libqp` then folds physical lines to the MIME limit. The
source therefore keeps the HTML body and its decoded content intact while
avoiding an overlong SMTP DATA line.

## Candidate change

`packages/account/src/smtpMail.js` now applies the source long-line decision to
each invitation part. Plain text longer than 76 characters uses source-shaped
flowed wrapping and `format=flowed`; long HTML uses quoted-printable. The
existing UTF-8/control-character quoted-printable path, SMTP envelope,
STARTTLS/authentication, and configured local relay behavior remain intact.

The transport test relay now records DATA line lengths and rejects a line over
998 octets. A regression test sends a 1,200-character ASCII HTML payload and
checks successful delivery, no rejected line, no high DATA bytes, decoded HTML
content, and quoted-printable transfer encoding.

## Original/candidate control

The source input is one synthetic invitation with `plain\\r\\n` text and an
HTML paragraph containing 1,200 ASCII `A` characters. Both relays reject any
8-bit DATA byte and any DATA line over 998 octets.

The source command was:

```text
node source-longline-control.cjs > source-longline.json 2> source-longline.err
```

It exited `0`: one accepted message, zero high bytes, maximum DATA line 76,
and no rejected line. The pre-repair candidate command was:

```text
node candidate-longline-control.mjs > candidate-before.json 2> candidate-before.err
```

It exited `1`: the relay observed a 1,207-octet line, accepted zero messages,
and the candidate surfaced `SMTP_550` (`line too long`). This failed output is
retained as the causal before artifact.

After the change, the same candidate command exited `0`: one accepted message,
zero high bytes, maximum DATA line 93, and no rejected line. The comparison
command was:

```text
node compare-longline.cjs source-longline.json candidate-after.json comparison.json
```

It exited `0`. The comparison has one source and one candidate case, equal
decoded sender/recipient/subject and plain/HTML bodies, equal media types and
transfer encodings, and zero decoded differences. Source HTML is
`quoted-printable`; source plain text is `7bit`. The candidate adds an SMTP
`QUIT` command after delivery; this remains a session-level qualification and
does not change the decoded message or relay acceptance.

The evidence is in
`/home/shell/work/phoenix/.parity/reviews/a04-invitation-mime-longline-20260908/`:

| Artifact | SHA-256 |
| --- | --- |
| `source-longline-control.cjs` | `8eb304199ad6ad22f08fca975955f097b02c88778cd62561c65a780edd017cba` |
| `candidate-longline-control.mjs` | `12f515cc256ca42b1a5613947b27992c42c6cac4411aa845a5e62154138c2147` |
| `compare-longline.cjs` | `ff48108e351e7be797b24167ad9e0a4becb37363f9b65047ffeb53cb037e6054` |
| `source-longline.json` | `266648f0b57dd9438e090c0066b88ac98f4ba4844ca1bbe93032ed9ccd7c6f47` |
| `candidate-before.json` | `914f6480671b6efb44fb8484fbcb1d555aa08188c1faf62cc4e6abe9a08a7e72` |
| `candidate-after.json` | `448be83b25e23196349a8da41219b1208854ae53e620a43f111b2d0a322c4862` |
| `comparison.json` | `051f928918d07c4cfaeb96021ecc16e0e4ce031fbd269936b07886532b4c3a9b` |

The empty stderr artifacts have the platform empty-file hash. The focused test
receipt is `focused.tap` (nine tests passed, zero failed).

## Validation and limits

The focused command was:

```text
node --test packages/account/test/invitationDeployment.test.js packages/account/test/invitationTransport.test.js
```

It exited `0` with 9 passed and 0 failed. The source comparison and focused
test use the recovered package tree under Node 22, not a Node 8 executable.
The control covers a long ASCII HTML line and the existing candidate's
Unicode/no-8BITMIME path; it does not replace Nodemailer's general attachment,
alternative-part, pooling, SES, SNS, or OAuth behavior. Root must perform the
final integration and deployment review.
