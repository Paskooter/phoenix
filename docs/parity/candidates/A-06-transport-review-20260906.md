# A-06 Settings transport clean-main integration candidate

Status: bounded candidate, awaiting root review. This revision covers the recovered
Settings listener boundary and the explicit public adapter; it does not close A-06 or
claim a live security-gateway/API-gateway deployment.

Worktree: `codex/candidate-a06-main-review-20260906`
Base: `25430c1`

This clean-main candidate copies only the reviewed Settings source/provider/transport
implementation, its Account listener wiring, focused Settings tests, and this report.
It does not carry the predecessor branch ancestry or unrelated A03, Account-peer,
registry, NLU, ledger, or tracker changes.

## Boundary recovered from source

The pinned Pegasus consumers use an internal peer contract. Hub's
`packages/hub/src/utils/SettingsClient.ts` and Report's
`packages/report-skill/src/SettingsClient.ts` send ordinary JSON to the configured
Settings URL, with `x-amz-target: Settings_20160801.GetSettings` and
`x-amz-credentials: {"id": accountId}`. They do not send SigV4 Authorization. Hub's
default host and Report's `NET_settings` default are `settings.jibo.aws`.

The public AWS contract is a separate path. The pinned security gateway authenticates
SigV4 first, replaces caller metadata with verified credentials, changes the exact
`application/x-amz-json-1.1` entity type to `application/json`, and forwards the
original entity to API-GW. `createPublicSettingsForwarder` keeps that ordering
explicit: it requires an authenticator, rejects an unredacted secret, overwrites all
caller credential headers with the authenticated envelope, and preserves the body
object/Buffer. A caller-supplied `x-amz-credentials` value is never accepted as public
identity.

The candidate therefore adds `createSettingsInternalService`, an explicitly selected
internal listener. It is not silently substituted for the Account robot AWS face,
which remains a LAN compatibility endpoint. Root must wire the correct listener and
authentication boundary for any public deployment.

## Source pins

- Pegasus reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`.
  Hub SettingsClient SHA-256:
  `6fb7c357ecac197afca2fac6bafdb96069bbe883e6ea6b015ef689a7c8ecf94b`; Report
  SettingsClient:
  `d64a853b1d65be0519be5fd7b57d688427d13be9ad60c7fbe121e0b4dc598635`; Report
  EnvVars:
  `9b62f558b9c7470f25ca69be4dcadcee647042c8bbe34abb2050ab8157b03f27`.
- Settings service: `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`.
  Fresh source handler SHA-256:
  `f363c55006b9c9de71e28ba7e503f5726afc042f8fc0d789bb6cb3b3d0ff4506`; controller:
  `322bb8606b57954ffe981b68e5cd22fa536c15ca91e6f04d47eb9e13a5949d90`.
- Original wrapper: `@jibo/server@4.0.12` using Hapi 16.4.1, Joi 10.5.2, Boom
  5.1.0, TypeScript 2.5.3, and the pinned Node 8.9.4 runtime. Its API route sets
  `payload.maxBytes` to `1000000000`, which the raw compatibility listener retains.
- Security gateway: `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`.
  The reviewed auth scheme redacts `secretAccessKey` to the literal `***hidden***`
  before forwarding.

## Implemented source behavior

`settingsInternalRoutes` now follows the original wrapper's target and parser order:

- It takes only the second `x-amz-target` segment and lowercases only its first
  character. The prefix is ignored, and later target segments are ignored. Thus
  `GetSettings.extra` succeeds, `getsettings` and `GETSETTINGS` are 404, and missing
  or empty operations produce the wrapper's generic 500 before payload parsing.
- Unknown operations return the Hapi-shaped 404 and do not invoke a provider. The
  route's early target failures retain the source `vary: accept-encoding` shape;
  handler and parser responses retain `vary: origin,accept-encoding`.
- MIME parsing follows the recovered Subtext classes: default/application JSON and
  `+json` parse with JSON.parse; `text/*` stays a string for Joi-style validation;
  form bodies use Node `querystring.parse`; octet-stream produces a Buffer/null;
  `application/x-amz-json-1.1` is rejected with 415 at this internal boundary;
  malformed JSON produces the source 400 payload. The request is bounded at the
  source route's 1,000,000,000-byte limit and uses a null-prototype querystring
  result, avoiding parser-created prototype mutation.
- Present Origin requests receive the source allow-origin echo and
  `WWW-Authenticate,Server-Authorization` expose header. The normal source
  response/error framing removes Express-only `x-powered-by`/`keep-alive` headers.

The source target/content/CORS controls are in
`packages/account/test/settingsInternalTransport.test.js`. They cover all fourteen
rows remaining in the root A-06 review: ten target forms, malformed JSON, text/plain,
AWS JSON, and Origin. The test also asserts provider non-invocation for early target,
malformed-body, and unsupported-media failures. The transport test retains the
forged-identity and raw-body checks for the public adapter.

## Evidence and validation

The original Node 8 TCP controls remain preserved and unchanged under
`/home/shell/work/phoenix/.parity/reviews/a06-root/`:

- `original-tcp.json` SHA-256
  `8ed8ca37e9eb1c687481b4a619161d71dc871b080916b71dee4e1ba3ef85db9d`;
- `cases.json` SHA-256
  `60e848e8de2ffefd95c82a33467d29518dcb7603d61ebfb056f6c6d9a9ec4c0e`;
- `credentials-repair-review.json` records the earlier 78-row aggregate boundary
  run: 64 matches after credential fixes, with the fourteen rows above isolated as
  listener/transport behavior rather than silently normalized away.

Fresh isolated candidate checks pass:

```text
node --test packages/account/test/settingsInternalTransport.test.js packages/account/test/settingsProviders.test.js packages/account/test/settingsTransport.test.js
# 9 passed, 0 failed
node --test packages/account/test/settings.test.js
# 12 passed, 0 failed
node --check packages/account/src/settingsFace.js packages/account/test/settingsInternalTransport.test.js
git diff --check
# passed
```

The candidate's `@phoenix/common`, `@phoenix/account`, `@phoenix/classic`, and
`@phoenix/contracts` links resolve to this review worktree, not main or another
worktree.

## Remaining boundaries

The Account robot face still serves its established AWS/LAN compatibility route and
therefore is not a public authentication boundary. This candidate does not wire a
live security gateway, API-GW registry, SigV4 verifier, TLS listener, or public route.
The internal raw listener does not yet reproduce Hapi's compressed-entity decoding or
automatic OPTIONS preflight; the pinned Hub/Report clients send ordinary uncompressed
JSON, and those broader server behaviors remain open. Update/Delete handler parity,
provider persistence, and full A-06 acceptance remain separate work.

No main, root tracker, shared cache, robot, live service, or source capture was
changed.
