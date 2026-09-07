# A-06 Settings Hub provider transport candidate (unverified)

This candidate is based on 95942834fdd0ca87b620dae9163cfe56527f4dec. It owns the
Account-to-Hub friendly-ID request path and the local Hub fallback in
packages/account/src/settingsProviders.js. Person and Lasso implementation
paths remain unchanged. A-06, public authentication, OAuth, Mongo, and live
service acceptance remain open.

## Source contract

The pinned Settings service is jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830.

- src/clients/account.ts constructs GET /loopPopulated?loopId=<context.loopId>
  and returns loop.robotFriendlyId without checking HTTP status or the value.
- src/clients/hub.ts awaits that Account call, constructs
  new URL('/v1/skills/settings/' + robotFriendlyId, base), sends only
  X-JIBO-transID, and returns response.skills.
- The pinned @jibo/server@4.0.12 wrapper uses Wreck 12.2.2 with json: true,
  redirects: process.env.ETCO_server_http_maxredirects || 3, and
  timeout: process.env.ETCO_server_http_timeout || 60000. It ignores HTTP
  status, parses only JSON-compatible content types, rejects truthy decoded
  payload.error, and reads until the response stream completes after the
  request timer is cleared at final response headers.
- Wreck maps a request reset to Boom 504, other request errors to Boom 502,
  response stream failures and JSON parse errors to Boom 500, and preserves
  the pinned Boom status coercion/output/data fields.

Source file hashes are retained in the private receipt:

- Account client TS: ed710e31766213321331b155c9826bead8705329b90ac6002688b3adcfc982d1
- Hub client TS: 7371117942c8f4a81734e709dc151097f02be263f635dbc0d22dc2e83314383d
- emitted Account client: 7ebece4391078e6e03562fef3123a31ea1388ea95cc6936da575e19e409ae31f
- emitted Hub client: c61be7648f597dffaa439cd72ed390a1e685f9182b1a1fcc4662105aaa0f4f8f
- @jibo/server/dst/wreck.js: 4432a7c3f77e0c1bce1bf4569d08fc5719bf68411c2d25f3d2f5f9a1939488b2
- @jibo/server/dst/boom.js: 6af4d3d56c824b32f0a08b3707ac0021fee61b838513a3098fa6d1194fb979fa

The original controls run with Node v8.9.4 image
node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c.
The candidate runs with Node v22.22.0.

## Implementation

The network Account/Hub path now uses a native HTTP/HTTPS request adapter for
this source contract. It retains the original URL construction and header
values, uses keep-alive agents, and does not apply the generic Phoenix
non-2xx handling. It:

- leaves ordinary non-2xx JSON and non-JSON payloads to the original
  response.skills/friendly-ID property access;
- parses only the original application JSON MIME classes;
- follows the original GET redirect statuses, legacy URL resolution,
  redirect counter, header propagation, and shared request deadline;
- clears the deadline when final response headers arrive, so a slow body is
  still read;
- maps reset, connection, stream, timeout, malformed JSON, and provider
  error envelopes to source Boom status/isServer/data/output behavior;
- preserves string status parsing through parseInt(statusCode, 10);
- keeps the local Hub fallback's Account friendly-ID prerequisite and its
  existing report-skill view shape.

## Fresh differential controls

Private evidence is under
/home/shell/work/phoenix/.parity/reviews/a06-hub-transport-20260907.

The extended 40-case matrix uses one real TCP Account peer and one real TCP Hub
peer per case. It covers JSON MIME/content-type behavior, empty/null/primitive
responses, ordinary non-2xx responses, truthy/falsy error fields, Boom status
coercion and missing/empty/falsy messages, transaction-header values, friendly
IDs containing URL-sensitive characters, and raw request headers/body/path.

- source output: out/source-extended-final.json
- candidate output: out/candidate-extended-final.json
- comparison: comparison-extended-final.json
- cases SHA-256: 7613683f10ace8337ee430c32087b51299abf7b57bf86c64f5db97c89e5fee1c
- comparison SHA-256: 6b973fe7c6bc35526e99db7d5fa08f3e46108e20777e19338a1976704246517d

Result: 40/40 ordered IDs, result/error records, and wire rows match. Both
source and candidate peer Host values match their independently observed
listener authorities. The complete comparison has zero other result/error
differences and zero wire differences.

The 11-case deadline/redirect matrix uses a fresh real TCP peer and a 25 ms
configured timeout. It covers relative and absolute redirects, missing
Location, the maximum redirect boundary, 303 body handling, delayed headers,
delayed bodies after headers, redirect deadline sharing, and an upstream
socket reset.

- source output: out/redirect-source-final.json
- candidate output: out/redirect-candidate-final.json
- comparison: comparison-redirect-final.json
- cases SHA-256: 62d890b7d0aebfe6eb2ae9489fe4152daad1625604bf8d67a43e4b32aee0329b
- comparison SHA-256: 54ee9768fa6b3f4ffbc714f9b7fdf27b3d7cfcc8c90ed4cb48ed029073ae7adc

Result: 11/11 machine-readable result/error records and 11/11 wire rows
match. One reset row has a qualified timestamp-only log-marker message
difference; the status 504, Boom fields and output label match. Source and
candidate Host validation has zero failures.

The separate refused-connection control is retained in
out/error-source.json and out/error-candidate.json; both produce the source
502 Bad Gateway envelope with ECONNREFUSED and preserved transport data.
Invalid provider error envelopes without a usable status remain an explicit
source process-failure boundary from the earlier controls and are not claimed
as exact parity.

## Tests

The focused command passed:

    node --test packages/account/test/settingsHubNetwork.test.js packages/account/test/settingsHubTransport.test.js packages/account/test/settingsProviders.test.js packages/account/test/settingsPersonNetwork.test.js packages/account/test/settingsLassoNetwork.test.js packages/account/test/settingsInternalTransport.test.js
    # 42 passed, 0 failed

The new Hub tests cover redirects, deadline/header/body boundaries, reset
mapping, smart JSON MIME behavior, Boom envelope fields, and local-provider
state. Person and Lasso regression files pass in the same run.

The broader Account Settings regression command also passed:

    node --check packages/account/src/settingsProviders.js && node --test packages/account/test/settings*.test.js
    # 72 passed, 0 failed

No main, robot, gateway lifecycle, Person/Lasso source, shared cache, or
historical credential data was changed. This candidate remains unverified
pending root review.
