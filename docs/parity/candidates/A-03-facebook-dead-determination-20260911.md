# A-03 scope determination: the three Facebook operations are [DEAD]

Decided by root, 2026-09-11. Recorded here because it changes the A-03
denominator and must not be silently absorbed into a candidate write-up.

## The operations

| Operation | Input | Output |
| --- | --- | --- |
| `FacebookConnect` | `FacebookConnectRequest` | `Account` |
| `FacebookMobileConnect` | `FacebookMobileConnectRequest` | `Account` |
| `FacebookPrepareLogin` | (none) | `FacebookPrepareLoginResponse` |

All three are `mapped-original` in
`docs/parity/candidates/A-01-operation-map.json` — the source controller exists
and is readable. This is not a "we cannot find the source" exclusion.

## Why they are dead

These operations are thin wrappers over **Facebook's Graph API as it existed in
2015**, reached with a Jibo-owned Facebook application ID and app secret. Every
one of those dependencies is gone:

- The Graph API versions these calls target were retired years ago; Facebook
  enforces version deprecation on a ~2-year cycle and rejects retired versions
  outright rather than degrading.
- The Jibo Facebook application registration died with the company. A new app ID
  would not reproduce the original behavior — the permissions model, review
  requirements, and token formats have all changed.
- `FacebookPrepareLogin` returns a login URL scoped to that dead app ID.

This is the same class as the exclusions already recorded in `PARITY.md`:
Google STT, Bing/Wolfram, Dialogflow agents, real OAuth refresh. The project's
`[DEAD]` convention exists for exactly this: a dependency whose external side no
longer exists, where implementing the Phoenix half would produce a call that
cannot succeed and cannot be verified against anything.

## What is NOT excluded

The **account-side data** these operations touch stays implemented and is
already present:

- `Account.facebookAccessToken` is stored and preserved by the account model
  (`packages/account/src/model.js` `copyAcceptedAccount`).
- `facebookConnected` is projected by `accountIdentity.js` as
  `!!account.facebookAccessToken` and is part of the `Account` JSON shape.
- Loop member projections deliberately strip the token
  (`loopMembership.js`), which is source behavior and stays.

So an account restored from a household import that carries a Facebook token
still serializes correctly. What is excluded is only the three operations that
would have to talk to Facebook.

## Effect on the A-03 denominator

`Account_20151111` has 28 operations. With these three excluded, the
implementable set is **25**.

| State | Count |
| --- | --- |
| Implemented before 2026-09-09 | 7 (`CreateHubToken` + identity core) |
| Wave 3 in flight (activation/recovery + email/phone/terms) | +11 → 18 |
| Remaining live operations | 7 |
| `[DEAD]` Facebook | 3 |
| **Implementable total** | **25** |

The seven remaining live operations are `CreateAccessToken`,
`GetAccountByAccessToken`, `ResetKeys`, `UpdatePhoto`, `RemovePhoto`,
`Remove`, and `Search`.

## Standing caveat

If a Facebook-connected account ever needs to be re-authenticated on real
hardware, this decision must be revisited — but the outcome would be "build a
Phoenix-native replacement", not "restore the original call". Nothing in the
robot's conversational path depends on it; the token is profile data.
