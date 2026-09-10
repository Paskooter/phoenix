# A-13 — Push delivery behind a replaceable provider

**Verified 2026-09-10.** Reference `srv-jibo-server-client@155d20a`
(`apis/push-2016-07-29`), Phoenix at the commit carrying this file.

Suite: **1139 tests, 1131 pass, 0 fail, 0 cancelled, 8 skipped**, gate 43/43.

---

## Criterion 1 — device creation/removal, durable registration, ownership, errors

Implemented in `packages/classic/src/push.js` (a 32-line stub before this work) with
13 tests in `packages/classic/test/push.test.js`:

- `CreateDevice` returns the active Devices list, with upsert/revival of a re-registered
  device; `RemoveDevice` returns the remaining list.
- `404 ACCOUNT_NOT_FOUND` / `404 DEVICE_NOT_FOUND`; `422` validation for missing or
  invalid fields, with unknown members allowed.
- Per-account ownership, and a single-owner pull so one `pushToken` cannot be held by two
  accounts.
- Durable registration across a registry re-open, with a failed write rolled back.

**This corrected two wrong assertions in the pre-existing `keyPush.test.js`**, which had
pinned the stub's behavior rather than the contract. Root verified the correction against
the pinned model before accepting it: shape **`S4`** is the declared output of *both*
`CreateDevice` and `RemoveDevice`, and it is a **list of device structures** — not `{}`.
Validation is Boom `badData` **422**, not 400.

## Criterion 2 — fixture provider *and then an available real client*

**Fixture-provider leg** (`packages/classic/test/push.test.js`): delivery to every active
device; a provider failure contained so it does not stop other deliveries; a
provider-reported invalid token triggering downstream device removal; and
`removeDeviceByToken` pulling a token from every account.

**Real-client leg — verified, previously recorded as unknown.** The worker reported this
as unavailable because the SDK ships no `lib/services/push.js` wrapper. That is true, but
it is not the whole picture: the SDK is aws-sdk based, and `AWS.Service` builds a real
client directly from the pinned `apis/push-2016-07-29.min.json`. That is the original
generated client machinery, not a hand-rolled request.

Driven against the **live** Phoenix classic face over HTTPS `:443` with SigV4 signed by a
real robot access key (`docs/parity/evidence/2026-09-10/a13-push-real-client/live-probe.json`):

| step | result through the real SDK |
|---|---|
| `CreateDevice` | parsed Devices list — confirms `S4`, not `{}` |
| `CreateDevice` (2nd) | both devices, accumulated in order |
| `RemoveDevice` | remaining device only |
| `RemoveDevice` unknown name | typed `DEVICE_NOT_FOUND`, **404** |
| `CreateDevice` missing fields | client-side `MultipleValidationErrors`, rejected pre-wire |

The SDK parsed both the success shape and the error envelope into typed values, so this
exercises the generated model end-to-end rather than only the HTTP status.

All probe devices were removed afterwards; the live account store contains **0** probe
leftovers.

## Criterion 2 — the part that remains unknown

Real **APNs/FCM delivery to a physical device** is not verified and is not simulated. Those
providers and their credentials are dead and no mobile client exists. Phoenix's provider
seam is exercised with a fixture, which is what the criterion asks for, but no push
notification has been delivered to a real handset.

---

## Divergences

`A13a` in `DIVERGENCES.md`: push delivery runs through an in-process fixture provider
because the original provider is dead. Recorded rather than presented as parity.

No other divergence: the stub-vs-source corrections (Devices-list response, 422 badData,
404 account/device ownership) are now source-faithful, so they close a gap rather than
open one.
