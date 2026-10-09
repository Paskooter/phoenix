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

### SigV4 adapter (production wiring)

`createGqaSigV4CallerVerifier` is the repository-standard cryptographic adapter:

```js
import { getStore } from '@phoenix/account';
import {
  createGqaSigV4CallerVerifier,
  startGqaMultiProviderService,
} from '@phoenix/skills';

const accountStore = getStore();
const verifyCaller = createGqaSigV4CallerVerifier({
  // This callback is synchronous, as required by @phoenix/common.verifySigV4.
  // Return null for an unknown/revoked key. Do not read request body fields.
  resolveCredentials(accessKeyId) {
    const account = accountStore.accountByAccessKeyId(accessKeyId);
    return account && account.isActive === true && account.isDeleted !== true ? account : null;
  },
  // This lookup runs only after the signature and clock-skew checks pass.
  // It must return the current account record, not a caller-supplied object.
  accountLookup(accountId) {
    const account = accountStore.accounts.get(accountId);
    return account && account.isActive === true && account.isDeleted !== true ? account : null;
  },
});

await startGqaMultiProviderService(port, {
  env: process.env,
  account: { endpoint: process.env.ETCO_server_accountService },
  attribution: { collection: database.attributes }, // deployment-owned Mongo handle
  attributionAuth: { verifyCaller },
});
```

The adapter requires these callback contracts:

- `resolveCredentials(accessKeyId)` returns `null` or a credential record with
  `isActive === true`, `secretAccessKey`, and one of `_id`, `accountId`,
  `accountID`, or `id`. (The adapter requires the boolean `isActive === true`
  and rejects deleted records.) The access key is taken only from the signed
  `Authorization` scope. The callback must reject deleted records.
- `accountLookup(accountId)` returns `null` or the current account record. Its
  identifier must match the trusted credential record, and `isAdmin === true`
  is the only value that grants administrative wipe access. It may be async.
- The adapter receives the original Node/Express request, including
  `method`, `headers`, `url`/`originalUrl`, and the exact `rawBody` captured by
  `@phoenix/common`'s JSON parser. Do not call it with a reconstructed body.
  Attribution targets must not contain query parameters.
- `allowNativeClientPayloadHash` remains `false` for GQA. That compatibility
  exception is for two unrelated native account operations and must not be
  enabled here. GQA also rejects non-`identity` `Content-Encoding`; the common
  parser exposes post-inflation `rawBody` bytes, so compressed transport cannot
  be authenticated as if it were the exact wire body.

`attributionAuth: { verifyCaller }` is accepted by
`createGqaMultiProviderProfile`, `createGqaMultiProviderService`,
`startGqaMultiProviderService`, `createGqaWikipediaService`, and
`startGqaWikipediaService`. A wrapper using the top-level `start` API can select
that standalone profile and pass the same object through `gqaConfig`:

```js
import { start } from '@phoenix/skills';

const account = { endpoint: process.env.ETCO_server_accountService };
const attribution = { collection: database.attributes };

await start(port, {
  gqaProfile: 'multi-provider',
  gqaEnvironment: process.env,
  gqaConfig: { account, attribution, attributionAuth: { verifyCaller } },
});
```

The CLI launchers cannot construct these callbacks from environment strings.
Their explicit deployment wrapper must create the adapter and pass it to the
programmatic API above. There is intentionally no environment variable that
installs a credential resolver or turns on an unverified identity path.
`ETCO_server_accountService` is only the source loop lookup endpoint; it is not
a SigV4 credential verifier and must not be substituted for `resolveCredentials`.
The exact credential-store ownership and launcher process boundary are
deployment-specific and remain a deployment wiring item until an operator
supplies them.

### Required environment and selection

The programmatic wrapper still needs the selected profile's ordinary environment:

- `PHOENIX_GQA_PROFILE=multi-provider` selects the standalone multi-provider
  service. `PHOENIX_GQA_DEFAULT_PROFILE=multi-provider` selects the GQA answer
  route on the shared `skills` host; that shared-host descriptor currently does
  not mount `/retrieveAtt` or `/wipeID`, so attribution must be mounted through
  the explicit `createGqaMultiProviderService`/`startGqaMultiProviderService`
  API (or a future launcher change) with the verifier above. Neither selector
  creates an identity verifier.
- `ETCO_gqa_wikiApi` and `ETCO_gqa_wolframApi` override the provider endpoints,
  which otherwise default to their public keyless endpoints. Microsoft retired
  the Bing Search API, so the first provider slot is DuckDuckGo
  (`ETCO_gqa_duckDuckGoApi`) unless `ETCO_gqa_bingApi` explicitly selects Bing.
  `ETCO_gqa_bingKey` and `ETCO_gqa_wolframKey` are provider secrets and must be
  supplied through the deployment secret mechanism, never committed or logged.
- `ETCO_server_accountService` identifies the source account loop-lookup
  endpoint used by the route's `account` option. It does not replace the local
  or secure credential resolver used by the SigV4 adapter.
- `PORT`/`ETCO_server_port` and the provider timeout variables are ordinary
  service settings; they do not affect authentication.

There is deliberately no `PHOENIX_GQA_SIGV4_*` environment-only mode. A secret
resolver cannot be safely represented by a URL or a caller-provided header. The
wrapper must inject the callbacks in code, then pass
`attributionAuth: { verifyCaller }` explicitly. Until that wrapper is wired,
the routes remain unavailable rather than accepting the skill context's
`accountID` or an unsigned request.

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
