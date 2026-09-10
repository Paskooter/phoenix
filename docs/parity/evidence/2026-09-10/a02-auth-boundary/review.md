# A-02 verification — Classic dispatch, authentication and error handling

**Date:** 2026-09-10
**Gateway pin:** `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`
**Framework pin:** `jiborobot/srv-server@master`
**Client pin:** `aws-sdk` in `.parity/reference/5c0a7390539663ba749d360de348a428c088505c`
**Result:** pass — all four acceptance criteria addressed

## The shape of the problem

The authoritative statement of *who may call what* is not in the service
handlers. It is the security gateway's three allow-lists, and Phoenix
reimplements them per service face rather than in one gateway process. Every
check below therefore diffs Phoenix against the pinned gateway rather than
asserting Phoenix against itself.

## Criterion 1 — aliases, validation, status, errortype, signed-request parsing

**Target parsing** (`target-parsing.json`). Pinned `srv-server` `lowerMethodName`
is `target.split(".")[1]` with the first character lowercased. Phoenix's
`accountMethodName` is the same rule, driven live over eight targets:

| target | result | note |
|---|---|---|
| `Account_20151111.Get` | 200 | canonical |
| `Account_20151111.Get.Extra` | 200 | trailing segment ignored on **both** |
| `account_20151111.get` | 200 | prefix case-insensitive |
| `ACCOUNT_20151111.GET` | 400 | `GET` → `gET`, unknown on **both** |
| `WrongPrefix.Get` | 400 | see A9 |
| `Account_20151111.` | 400 | malformed |
| `NoDot` | 400 | malformed |
| *(empty)* | 400 | empty |

**Error envelopes** (`errortype-equivalence.json`). Source emits a Hapi/Boom
payload with a `code` key and no header; Phoenix emits `__type` plus
`x-amzn-errortype`. These *look* divergent and are not. The pinned `aws-sdk`
`extractError()` resolves `error.code` from `body.__type || body.code`, with the
body overriding the header, so the two are indistinguishable to a generated
client. Verified by **executing** the pinned parser over both shapes for four
codes, all matching, with falsification checked. Recorded as A11; it also
corrects A8, which had wrongly called coded envelopes divergent.

The genuine difference is the status code for an unknown method (Phoenix 400 vs
source 404/500) — A8.

## Criterion 2 — identity, ownership, expiry/replay, internal credentials

**Allow-lists** (`static-boundary.json`, `a02_auth_boundary.py`). 14/14 exact
across Account, Loop and OOBE for `unauthorizedMethods`; `unsignedMethods` empty
on both; `unactiveMethods` is `Account_20151111.Remove` on both. Falsification:
6 injected drifts, 6 detected.

**Live behaviour** (`live-auth-boundary.json`). 27 checks over a running Account
face: 14 anonymous targets reach their handlers unsigned, 10 credentialed targets
return `MISSING_AUTH_HEADER`, and an inactive account is refused
`ACCOUNT_NOT_ACTIVE` everywhere except `Remove`, which succeeds at 200.

**Expiry and replay** (`skew-ordering.json`). Eight cases: fresh and 14-min-old
signatures accepted; 16 minutes past **and future** rejected with
`CLOCK_SKEW_TOO_LONG`, matching source's `Math.abs`; missing date and missing
authorization produce their own codes; and when **both** are missing the auth
error wins, matching the gateway's ordering where `getCredentials` tests the
authorization header before ever calling `parse()`. Recorded as A10: replay is
bounded only by the 15-minute window, faithfully.

**Ownership** (`ownership-boundary.json`). Seven cases with issued test keys.
A caller reaches its own record and is refused another principal's
(`MEMBER_CAN_REQUEST`, `OWNER_CAN_MANIPULATE`); empty `ids` defaults to the
caller alone; updates bind to the authenticated caller. The decisive case: a
**bad secret** fails as `SIGNATURE_MISMATCH`, distinct from the coded refusal a
valid-but-unauthorized caller receives — so refusals are authorization
decisions, not credential failures.

## Criterion 3 — header forwarding, LAN bypass

Five cases across a real Classic → Account hop (`header-forwarding.json`). The
load-bearing ones: a request **signed for the Classic host** verifies downstream
(200), and a body-sensitive operation succeeds (200) — proving `Host` survives
verbatim and the payload is byte-identical. `router.js` uses native
`http.request` precisely because `fetch` rewrites `Host`, and `forwardHeaders`
drops only the RFC 7230 hop-by-hop set. `x-amzn-errortype` propagates back
through the proxy.

**There is no LAN bypass to test, and that is the finding.** Searched every
package for privileged-network shortcuts, trusted-host lists and skip-auth
paths: none. The only `x-forwarded-for` / `remoteAddress` reads are in the
gateway preprocessor and the GQA skill, where the value is descriptive CONTEXT
data — identity there comes from the decoded JWT, never the socket address. An
unsigned loopback request with a spoofed `x-forwarded-for` is rejected exactly
like any other unsigned request.

## Criterion 4 — CreateHubToken

Satisfied by the 2026-09-06 hardware run
(`docs/parity/evidence/2026-09-06/hardware/a02-native-auth-reviewed.json`):
a real robot issued a signed `Account_20151111.CreateHubToken` over TLS 1.2 and
received a 200 with the expected token keys.

## Honest scope

- All evidence is against the pins above. No original Node 8 runtime was used
  for these checks; the 2026-09-06 hardware run covers the native client path.
- "Ownership" here means the Account face's cross-principal boundary. Per-service
  ownership rules (robot vs owner vs manufacturing vs admin) are A-01's
  per-operation attributes and are not re-verified here.
- Replay (A10) and the unscoped Search directory (A4) are real properties of the
  original design that Phoenix reproduces. Neither is a Phoenix defect, and
  neither is repaired.

## Reproduce

```bash
python3 scripts/parity-coverage/a02_auth_boundary.py
python3 scripts/parity-coverage/a02_auth_boundary.py --falsify
node .parity/reviews/a02-gateway-root-20260910/live-auth-boundary.mjs
node .parity/reviews/a02-gateway-root-20260910/skew-ordering.mjs
node .parity/reviews/a02-gateway-root-20260910/header-forwarding.mjs
node .parity/reviews/a02-gateway-root-20260910/ownership-boundary.mjs
node .parity/reviews/a02-gateway-root-20260910/target-parsing.mjs
node .parity/reviews/a02-gateway-root-20260910/errortype-equivalence.mjs
```
