# GQA attribution authorization

`/retrieveAtt` and `/wipeID` are sensitive internal routes. They are not public
application APIs.

## Deployment identity boundary

The gateway authenticates the robot WebSocket with its hub JWT and places the
account ID in the JSON skill context. `packages/gateway/src/skillClient.js`
forwards only the skill JSON body and trace headers; it does **not** forward the
verified JWT, a SigV4 authorization, or a signed identity to the skills HTTP
service. The skills service therefore cannot reconstruct the gateway caller
from the default/live launchers.

Attribution routes fail closed when no identity verifier is configured. A
caller-controlled `x-amz-credentials` header is never an identity source in
that mode.

A deployment that has a real authenticated front door must pass an explicit
`attributionAuth: { verifyCaller(request) { ... } }` option. `verifyCaller` must
cryptographically validate the request (or consume identity verified by that
front door) and return `{ accountId, isAdmin }`. The route uses only that result
for ownership and admin checks; request bodies and identity headers cannot
replace it.

## Legacy trusted-internal mode

For controlled local testing or a deployment where a separate authenticated
front door is guaranteed, an operator may explicitly set:

```text
PHOENIX_GQA_ATTRIBUTION_TRUSTED_INTERNAL=true
```

This mode is disabled by default. It accepts the legacy `x-amz-credentials`
identity only when the TCP peer is loopback (`127.0.0.1` or `::1`). A remote
internal deployment must additionally set the exact peer addresses:

```text
PHOENIX_GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES=10.0.0.7,10.0.0.8
```

The check uses `req.socket.remoteAddress`, never `X-Forwarded-For`. Do not
enable this mode on an internet-reachable skills listener, and do not treat the
legacy header as authentication outside the explicitly isolated boundary.
The current compose and simulation launchers do not provide a verifier or this
opt-in, so attribution remains unavailable unless a caller supplies one.

## Authorization rules

- Retrieval resolves the authenticated caller's account to its owned loop(s)
and searches only those loop IDs.
- Wipe requires the authenticated caller to own the requested loop, or to be
an authenticated admin. The request's `ID` selects a resource; it does not
establish ownership.
- Authentication and ownership failures use safe fixed messages.
- Unexpected GQA errors retain the source version/message envelope but never
include `error.stack` or internal error text. Sanitized name/code/message detail
is logged internally without stack frames.
