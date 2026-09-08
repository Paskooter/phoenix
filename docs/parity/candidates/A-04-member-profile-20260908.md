# A-04 member profile and enrollment operations

Status: **root accepted for the bounded implementation**.
A-04 remains open. Candidate `62fa849e6617f789251d3d73092001b8f148cc12`
was reviewed with additional root fixes before integration.

The increment adds `SetEnrollment`, `UpdateNickname`, and
`UpdatePhoneticName` through the existing Loop AWS-JSON dispatcher. Enrollment
returns the populated Loop; name changes return the original command response.
All three retain lookup, owner-or-robot authorization, suspension, and member-ID
check ordering. Names allow null or omission, reject empty strings, and are
assigned without trimming. Enrollment updates only supplied boolean fields.

The archived Joi decorator accepts case-insensitive string booleans but discards
its converted result. The original controller therefore saves and emits its
update while leaving enrollment flags unchanged for these strings. Root repaired
the candidate validation to preserve this behavior. Each profile operation now
uses a detached Loop draft so a rejected save cannot expose unsaved fields in
the shared Store. An injected flush failure reproduced the original candidate
leak before the repair.

## Source and execution provenance

The implementation was initially described using a reconciled older snapshot.
The independent review fetched these exact files from Jibo MCP at
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`:

| Source file | Saved SHA-256 |
| --- | --- |
| `src/controllers/loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `src/handlers/loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| `src/schemes/account.ts` | `1d69c02223ec3df088bbfa10c1ff1c8b29a4f003f9229fa89f3c531ee1f3b2c5` |
| `src/schemes/loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |

Saved controller lines: `setEnrollment` 601, `updateNickname` 706,
`updatePhoneticName` 722. Handler methods begin at 234, 281, and 296.
The older `a04-source-methods-20260907` harness executes `b525601...` and is
not evidence of full-file equivalence to 6cea.

The independent reviewer compiled and executed the exact 6cea controller and
handler with the original `@jibo/server` 4.0.12 decorators on Node 8.9.4.
Mongo query/document-save and event delivery were controlled seams; the
original save hooks and event construction ran. Sixteen operation controls
matched status/code, changed member state, successful response projections,
and save/event counts against the candidate. Clock values were normalized;
raw Loop `_id` and `isDeleted` metadata were excluded and remain an explicit
raw-serialization difference. All 22 validation controls also match status,
save occurrence, and event count after the root repairs. Valid JSON primitives
now reach profile validation and return 422; malformed JSON remains 400.
The original generated client does not model
those fields. The comparison retains member identifiers and substantive data.

Root separately ran the original generated `jibo-server-client` 3.0.110 on
Node 8.9.4 against isolated Phoenix Classic and Account HTTP services with
normal client parameter validation. Eight controls passed: owner/robot
enrollment, both names, null clearing, rejected outsider access, and a final
ListLoops read. Requests were signed by the real client. This does not prove
full server-side SigV4 verification at the existing Classic identity boundary.

## Verification and remaining scope

All test identities and profiles are invented. No household capture is used
as a public fixture. The focused HTTP suite covers seven tests, including failed
persistence with unchanged memory, outbox, disk, and reload, plus lower-, upper-,
and mixed-case string booleans. The combined profile and membership persistence
increment passes 826 unit tests with eight skips and no failures; the strict
43-case smoke comparison has no differences or invariant failures.

Private review artifacts are under
`.parity/reviews/a04-member-profile-root-20260908` and
`.parity/reviews/a04-member-profile-review-20260908`. Source controls and
client controls use synthetic fixtures only; only sanitized review outcomes
are published.

This acceptance does not cover a real Mongo process, complete Mongoose casting
and serialization, production provider delivery, full signature verification,
or real robot execution of these new operations. Remaining Loop operations and
A-04 stay open. The running robot backend has not been changed by this increment.
