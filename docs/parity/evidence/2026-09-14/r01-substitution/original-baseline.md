# R-01 all-original baseline — 2026-09-14

Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Suite: `packages/integration-tests-int`, 8 files, 14 `describe` blocks, 25 cases
Runtime: `node:8.9.4-slim`, `mocha -r ts-node/register ./tests/index.js`
Status: **baseline only — R-01 is not claimed or verified by this file.**

This is the reference behaving as itself, with no Phoenix in the picture. It is
the yardstick every substitution run has to be measured against, so it has to
exist before any substitution claim can mean anything.

## Result

```
21 passing (18s)
4 failing
```

The 4 failures are all in `lasso.test.ts`, and all four are dead third-party
endpoints:

| # | case | observed |
| --- | --- | --- |
| 1 | Dark Sky — live GET with cache miss | `502`, `ENOTFOUND api.darksky.net` |
| 2 | Dark Sky — rejects invalid timestamp | asserts `400`, observed `502` (same dead host) |
| 3 | Google Maps — live GET with cache miss | `403` |
| 4 | AP News — live GET with cache miss | `502`, `ENOTFOUND syndication.ap.org` |

Google's response is explicit about why it is permanent:

> Maps Platform client IDs are deprecated since May 26, 2025, and can no longer
> be used after May 31, 2026. Instead of using a client ID, you must use API Key
> credentials… Provided 'signature' is not valid for the provided client ID

Jibo's `gme-jiboinc` client ID is retired. Apple retired Dark Sky, and
`syndication.ap.org` no longer resolves.

The split is precise rather than a blanket "the cloud is gone": the Google
Calendar and Outlook Calendar "live GET with cache miss" cases **pass**, because
`lasso.test.ts:130-180` nocks those two APIs. Only the four genuinely
un-intercepted calls fail.

## Getting to this baseline

Three things had to be fixed first, and each is a finding in its own right.

1. **The test workspaces were never installed.** `parity-prepared.json` excludes
   `integration-tests-int`, `integration-tests-ext` and `hub-client-cli` and
   installs production dependencies only. Restoring those three workspaces and
   running `yarn install --frozen-lockfile` against the original lock installs
   1,068 packages.
2. **One relocation gap.** `jsdoc-jibo` matches none of `prepare.py`'s archive
   prefixes, so it routed to npmjs.org and 404'd. It exists on the archive and
   is the only lock entry containing "jibo" routed to npmjs.
3. **Two build steps the production profile skips.** `grpc@1.7.3` needs its
   native extension (the hub's `GoogleASRProvider` requires it at load time);
   the prebuilt `node-v57-linux-x64-glibc` binary installs from
   `storage.googleapis.com`. And `hub-client-cli` had no compiled `lib/`, so its
   three cases failed with `Cannot find module '..'`. Compiling it with the
   reference's own TypeScript 2.5.3 and adding the `lib/hub-client-cli.js` entry
   stub that the original build produces — verified against `hub-client`, whose
   built entry is exactly `module.exports = require('./index.js');` — recovered
   all three, taking the run from 18 passing to 21.

All of this was done in a scratch copy at
`~/.local/share/phoenix/r01/ref-with-devdeps`. **The pinned reference tree was
not modified.**

## What this means for R-01's acceptance criterion

R-01 requires "zero unexplained behavioral differences". The reference itself
cannot reach 25/25 on today's internet, so that phrase needs a decision rather
than an assumption:

- Requiring Phoenix to pass cases the reference fails is incoherent.
- Quietly dropping those cases from the denominator would overstate coverage.

The defensible reading is to compare Phoenix against the **achievable** original
baseline case-for-case — 21 cases that can pass, 4 named exclusions carrying the
exact HTTP evidence above — and to publish both numbers rather than only the
favourable one. **This decision is deliberately left open here** and should be
confirmed before any R-01 claim is written.

## Not yet done

The substitution runs themselves. Nothing has been run against a Phoenix
service. The next step is to point the original `HubService`'s `parser.baseURL`
at a Phoenix parser and re-run these same 25 cases, then repeat for the hub and
the skill service, then the all-Phoenix stack, capturing per-case HTTP/WS/JCP
and side-effect evidence for comparison.
