# A-03 verification — Account operations and account lifecycle

**Date:** 2026-09-10
**Phoenix revision:** A-02 verification (`5a76197`)
**Result:** pass — all three acceptance criteria addressed

## Criterion 1 — every Account and AccountAdmin operation

The trap here is that `account-2015-11-11` and `accountadmin-2015-11-11` are two
**different API files that both declare `targetPrefix: Account_20151111`**. Two
operations — `ActivateById` and `ResetEmail` — exist **only** in the admin file,
with different required input from any Account operation:

| operation | declared in | input shape | required |
|---|---|---|---|
| `ActivateById` | AccountAdmin only | `IdRequest` | `id` |
| `ResetEmail` | AccountAdmin only | `ResetEmailRequest` | `id`, `email` |

A check that read only the Account API file, or compared operation names alone,
would miss the admin contract entirely and still report success.
`scripts/parity-coverage/a03_account_coverage.py` reads both files and confirms
Phoenix implements the **admin** shape: `validateActivateById` requires `id`, and
`validateResetEmail` requires both `id` and `email` plus an optional `campaign`.

Result: **24/25 live operations implemented and tested** (25 = 28 minus the three
dead Facebook operations, excluded with a written determination in
`DIVERGENCES.md` D-fb). Falsification: 3 injected gaps, 3 detected.

`CreateHubToken` is a special case the checker had to learn: it is dispatched by
`robotFace.js` (`createhubtoken: issueHubToken`), not the account-identity table,
because it is the bounded A-02 SigV4 operation. It is implemented and guarded to
require the Account prefix.

**Lifecycle** (`lifecycle.mjs`, 15/15): signup → inactive → activate → login →
key rotation → password change → store reopen. Durable state survives the
reopen, and rotating keys invalidates the old pair.

Two probe corrections worth recording, because both looked like product defects:

- `ResetKeys` regenerates **both** `accessKeyId` and `secretAccessKey`
  (`fillAccessKeys()` → `randAlnum(20)`/`randAlnum(40)`). Reusing the old access
  key id yields `ACCESS_KEY_NOT_FOUND` — a probe bug, not a parity result.
- Login before activation **succeeds**, because pinned `account.ctrl.ts` `login()`
  compares the password and never consults `isActive`. Phoenix reproduces this
  faithfully. The probe now asserts the source behavior instead of an assumed one.

## Criterion 2 — validation, roles, errors, ownership, durable state, downstream effects

Covered by the focused suites (`accountIdentity`, `accountActivationRecovery`,
`accountEmailPhone`, `accountAccessTokens`, `accountPhotos`,
`accountSearchRemove`, `loopMembership`, `loopProjectionEdges`) plus the A-02
auth verification that A-03 depends on.

Seven behavior findings were classified against pinned source this session as
**A4–A10** in `DIVERGENCES.md`, all source-faithful and retained rather than
repaired:

- **A4** — `Search` is a signed but unscoped directory (privacy-relevant)
- **A5** — `Remove` splices the member subdocument; `RemoveLoopMember` marks status
- **A6** — robot accounts satisfy the emailless-dependent guard on `Remove`
- **A7** — self-delete requires an omitted `id`, not your own
- **A8** — unknown/malformed target gives 400 vs source's 404/500
- **A9** — Phoenix rejects wrong-prefix dispatch; source would dispatch it
- **A10** — replay is bounded only by the 15-minute skew window

**A3** (null `photoUrl` omitted from the Loop member projection) was found by
the photos candidate, confirmed by root against pinned `loop.ctrl.ts`, and
**repaired** with a falsification-checked regression test.

**A11** records the opposite: coded error responses are **not** divergent,
because the pinned `aws-sdk` `extractError()` reads `body.__type || body.code`.

## Criterion 3 — portal verification and paired-robot preservation

`packages/account/src/portalApi.js` with `portalAuth.test.js`, and
`householdImport.test.js` covers the migration claim directly —
*"buildHouseholdImport preserves source IDs/status/enrollment and transfers only
robot credentials"* plus collision-rejection and non-destructive staging tests.
That is precisely "preserve existing paired robots during migration."

## Honest scope

- No original Node 8 / Mongoose 4.9.8 replay was run for these checks; evidence
  is source-pinned reading plus the Node 22 test suite.
- The three Facebook operations are excluded by determination, not implemented.
- Per-service ownership rules beyond the Account boundary are A-01's
  per-operation attributes and are not re-verified here.
- `AccountAdmin` is verified only for its two operations' **input contracts**;
  there is no separate admin role enforcement in Phoenix to compare against,
  since the admin surface shares the Account wire prefix and gateway path.

## Reproduce

```bash
python3 scripts/parity-coverage/a03_account_coverage.py
python3 scripts/parity-coverage/a03_account_coverage.py --falsify
node .parity/reviews/a03-lifecycle-20260910/lifecycle.mjs
```

Suite: **1007 tests, 999 pass, 0 fail, 8 skipped**, gate 43/43.
