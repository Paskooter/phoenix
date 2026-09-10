# A-10 — independent verification: notification token & socket delivery lifecycle

Date: 2026-09-10 · Verifier: independent worker (not the earlier candidate's author) ·
Worktree `.parity/worktrees/w2-a10`, branch `w2/a10`, base `5aaf98d` (`Record the A-18 joi-message and map-note findings`).
Implementation under test: `packages/classic/src/notification.js` (+ `notificationStore.js`, `index.js`) and
`scripts/ensure-tls-certs.mjs`.

**Verdict: criteria 1 and 2 are demonstrated at runtime against the pinned source and the pinned client;
the observable half of criterion 3 (DNS/TLS + SNI socket handshake, separated from REST discovery) is
demonstrated. The robot half of criterion 3 stays UNKNOWN — the firmware is not available **and** no
shipped script repoints the robot's `wsendpoint`, so a real robot's socket still resolves to the dead
`<region>-socket.jibo.com`. Per the project's own standard ("only fully verified A-10 counts"), do not
mark A-10 verified yet; what remains is a hardware/deployment step root owns. No implementation defect
was found, so no source change was made — the work is the probe, three new regression controls, and
three falsifications.**

Everything below is re-derived from the pinned artifacts and from live processes. The earlier candidate
report (`docs/parity/candidates/A-10-candidate-20260910.md`, already merged) was read and then
re-derived; **two of its claims are contradicted or under-stated by the source** (§7).

---

## 1. Pinned artifacts used

| Artifact | How obtained | sha256 |
|---|---|---|
| `jiborobot/srv-jibo-server-client:apis/notification-2015-05-05.normal.json` | Jibo MCP `gitea_read_file` **and** the local pinned SDK checkout `/home/shell/work/phoenix-jibo-server-client` (3.0.105) | `b935151c…406155` (both byte-identical to the committed copy in `pinned/`) |
| `apis/notification-2015-05-05.min.json` (the model the generated client actually loads) | `@jibo/jibo-server-client@3.0.110` copy inside `.parity/yarn-cache` | `bd7f14fe…02e496` |
| `lib/services/notification.js` (the **consumer**) | 3.0.110 yarn-cache copy; byte-identical to the 3.0.105 checkout (`consumer3_0_105Identical: true` in `probe-output.json`) | `93b9677b…28bd9b` |
| `jiborobot/srv-notification-ws` `src/controllers/ctrl.ts`, `src/handlers/handler.ts`, `src/routes/route.ts`, `src/schemes/{token,notification}.ts`, `src/errors/errors.ts`, `config/config.json`, `src/event.handlers/*.ts` | Jibo MCP `gitea_read_file`; copies committed under `pinned/` with `pinned/manifest.json` | see manifest |
| `jiborobot/srv-entrypoint-socket-ws` `src/socket-server.ts`, `src/index.ts`, `src/clients/notification.client.ts`, `config/config.json` | same | see manifest |
| `jiborobot/srv-security-gw` `src/controllers/auth.ctrl.ts`, `src/errors/account.ts` | same | see manifest |
| `@jibo/server@4.0.15` `dst/validate.js` (the `validatePayload` decorator) | local yarn-cache copy | — |
| **joi 10.5.2** — the version `@jibo/server`'s `joi: ^10.5.2` resolves to in the original monorepo install | `.parity/reviews/a06-original-runtime/node_modules/joi` | measured, see §4 |
| The **pinned generated client** `@jibo/jibo-server-client@3.0.110` (`lib/node_loader.js`, `lib/core.js`, `clients/notification.js`, `apis/*.min.json`) | driven **live** against Phoenix in `probe.mjs` | — |

The 3.0.105 checkout ships an **empty** `clients/` directory (the generated entry points are a build
artifact of the original repo), so the probe loads the 3.0.110 cache copy, whose `clients/notification.js`
is the same generated loader and whose `lib/services/notification.js` is byte-identical to 3.0.105's.
That is the pinned client code with the pinned model — not a reimplementation.

Reproduce:

```
node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/probe.mjs      # live probe -> probe-output.json
node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/joi-matrix.cjs  # envelope matrix -> joi-matrix.json
node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/falsify.mjs     # 3 corruptions   -> falsification.json
node --test packages/classic/test/notificationSourceContract.test.js
```

---

## 2. Criterion 1a — every operation the pinned client model declares, served at runtime

The pinned model declares exactly **two** operations, and the wire name is built from the operation KEY
(aws-sdk JSON protocol: `metadata.targetPrefix + '.' + key`; `name` is absent on `GetStatus` in the
pinned file, so a reader that keys off `name` would lose it):

| # | Model op | wireName | input | output (required) |
|---|---|---|---|---|
| 1 | `NewRobotToken` | `Notification_20150505.NewRobotToken` | `RobotTokenRequest` (`deviceId`) | `Token` → `{ token }` |
| 2 | `GetStatus` | `Notification_20150505.GetStatus` | `GetStatusRequest` (`accountId`, required) | `GetStatusResponse` → `{ connected }` |

`metadata.targetPrefix = "Notification_20150505"`, `jsonVersion = "1.1"`, `protocol = "json"`.

**VERIFIED (observed, not statically inferred).** `probe-output.json → summary`:

- `declaredOperations: 2`, `servedOperations: 2`.
- The pinned client's own wire capture (against an echo server) is
  `POST /` + `x-amz-target: Notification_20150505.NewRobotToken` / `…GetStatus`, body
  `{"deviceId":"wire-device"}` / `{"accountId":"account-alpha"}`, signed
  `host;x-amz-content-sha256;x-amz-date;x-amz-target`, `content-type: application/json`.
- Pointed at a live Phoenix entrypoint, the pinned client got `200 {token: <128 hex>}` and
  `200 {connected: false}`.
- Dispatch is prefix-based, not a wildcard: `Notification_20150505.DeleteAll` (undeclared) → `400
  ValidationException` "unknown Notification operation: DeleteAll"; `Notifier_20150505.NewRobotToken`
  (undeclared prefix) → `400 UnknownOperationException`.
  This is the check the project rule demands — the dispatch really is reached at runtime, not merely
  present in source (`packages/classic/src/router.js:50-61`, `index.js:59`, `notification.js:474-483`).

Regression control: `packages/classic/test/notificationSourceContract.test.js` test 1.

---

## 3. Criterion 1b — token issuance / reuse / replacement / invalidation / ownership

Source: `pinned/…srv-notification-ws__src_controllers_ctrl.ts` — `newToken` (`:31-45`) mints
`randomBytes(64).toString('hex')` and **rotates the one Token document per `accountId`**
(`Token.findOne({accountId})` → update, else create); `findByToken` (`:81-87`) looks up by `tokenKey`
and throws `Boom.createWithCode(Errors.TOKEN_NOT_FOUND)` (`:84`) when absent; `getStatus` (`:109-117`) answers purely from the
persisted `lastConnected` window with a TODO admitting there is no ownership check; `markConnected`
(`:95-100`) / `markDisconnected` (`:102-107`) update **all** tokens of the account (`multi:true`).
Schema: `pinned/…src_schemes_token.ts:6-10` (`accountId`, `created`, `lastConnected` default
`new Date(2000,0,1)`, `tokenKey`, `updated`).

**VERIFIED (observed).** `probe-output.json → tokenLifecycle`:

| Behaviour | Source | Observed on Phoenix | Verdict |
|---|---|---|---|
| `NewRobotToken` status/body | 200 `{token}` | `200`, keys `["token"]` | VERIFIED |
| token shape | 64 random bytes hex | `/^[a-f0-9]{128}$/` | VERIFIED |
| Token document fields | accountId, created, lastConnected, tokenKey, updated (+_id) | same six keys | VERIFIED |
| replacement | rotates the SAME document | `rotationKeepsTokenDocument: true`, `rotationChangesTokenKey: true` | VERIFIED |
| invalidation | old `tokenKey` no longer resolvable | `oldKeyResolvableAfterRotation: false`; old key rejected at the socket upgrade (401) | VERIFIED |
| account isolation | tokens keyed by accountId | second account gets a different document; the first is untouched | VERIFIED |
| ownership on `GetStatus` | **none** (source TODO) | `{accountId:"account-beta"}` from account-alpha's signed request → `200 {connected:true}` | VERIFIED — matches source, incl. the missing check |

No implementation change was needed here.

---

## 4. Criterion 1c — error envelopes and exact status codes, measured against the pinned validator

Source handler (`pinned/…src_handlers_handler.ts`): `NewRobotToken` is
`@parseCredentials({})` + `@validatePayload({ deviceId: Joi.string() })` (`:23-26`); `GetStatus` is
`@parseCredentials({})` + `@validatePayload({ accountId: Joi.string().required() })` (`:37-40`).
`@jibo/server`'s decorator is `Joi.validate(request.payload, schema, { allowUnknown: true })` and on
failure rejects `Boom.badData(err)` = **HTTP 422** with `{statusCode, error, message}`.

Rather than transcribe the expected strings, `joi-matrix.cjs` runs **joi 10.5.2** (the pinned
`^10.5.2` resolution) over all 19 payloads and writes `joi-matrix.json`.

**VERIFIED (observed):** every one of the 19 measured `Joi.validate(...).error.message` values is
byte-identical to the live Phoenix 422 message. Spot table (full matrix in the artifact):

| Payload | joi 10.5.2 message = Phoenix message |
|---|---|
| `{deviceId:{}}` / `[]` / `true` / `null` | `child "deviceId" fails because ["deviceId" must be a string]` |
| `{deviceId:""}` | `child "deviceId" fails because ["deviceId" is not allowed to be empty]` |
| `""` / `null` / `[]` / `false` / `0` / `"scalar"` | `"value" must be an object` |
| `{}` (GetStatus) | `child "accountId" fails because ["accountId" is required]` |
| `{accountId:null}` / `7` | `child "accountId" fails because ["accountId" must be a string]` |
| `{accountId:""}` | `child "accountId" fails because ["accountId" is not allowed to be empty]` |
| `{}` (NewRobotToken), `{deviceId:"x",unknown:1}`, `{accountId:"a",extra:1}` | no error (422 not raised — `allowUnknown`) |

All 422 bodies are `{"statusCode":422,"error":"Unprocessable Entity","message":…}` with
`x-powered-by` removed, and a rejected request leaves the prior token in place
(`auth-*`/`reject*` cases, plus `validAfterRejects: 200`), i.e. validation precedes mutation exactly as
the decorator order requires.

### The second auth layer (gateway allow-lists)

`pinned/…srv-security-gw__src_controllers_auth.ctrl.ts`: `unauthorizedMethods` (`:9-30`) lists
Backup/Account/Loop/Crew/OOBE targets only — **neither Notification target appears**; `unsignedMethods`
(`:31-32`) is an empty array. So both Notification operations are admissibility-gated: a call without a
valid SigV4 signature must never reach the handler. Status codes and codes are pinned by
`pinned/…srv-security-gw__src_errors_account.ts`.

**VERIFIED (observed)** — `probe-output.json → authMatrix`, all with a real signature verifier:

| Case | Source code / status (`errors/account.ts`) | Observed | Verdict |
|---|---|---|---|
| no `Authorization` | `MISSING_AUTH_HEADER` 401 | 401 `MISSING_AUTH_HEADER`, `__type` matches header | VERIFIED |
| `Authorization` present, date absent | `MISSING_DATE_HEADER` 401 | 401 `MISSING_DATE_HEADER` | VERIFIED |
| unknown access key | `ACCESS_KEY_NOT_FOUND` 401 | 401 `ACCESS_KEY_NOT_FOUND` | VERIFIED |
| known key, wrong secret | `SIGNATURE_MISMATCH` 401 | 401 `SIGNATURE_MISMATCH` | VERIFIED |
| inactive account | `ACCOUNT_NOT_ACTIVE` 403 | 403 `ACCOUNT_NOT_ACTIVE` | VERIFIED |
| clock skew > 15 min | `CLOCK_SKEW_TOO_LONG` 401 | 401 `CLOCK_SKEW_TOO_LONG` | VERIFIED |
| any of the above | must not mutate | token key unchanged; `GetStatus` still `connected:false` | VERIFIED |

The same six cases are pinned as a regression control in
`packages/classic/test/notificationSourceContract.test.js` test 2, including the
`x-amzn-errortype`-equals-`__type` pairing.

---

## 5. Criteria 1–2 — socket authentication, framing, delivery, reconnect, ack, expiry, queue, isolation

Pinned socket behaviour: `pinned/…srv-entrypoint-socket-ws__src_socket-server.ts` — token is the **last
`/` segment of the raw upgrade url** (`:38`); a token lookup failure closes the socket with
`err.statusCode` (`:30`); connect → `deliverAllPending(token)` (`:68`, `:73-78`); `deliver` sends
`JSON.stringify(notification)` — the **full document**, not a `{name,payload}` wrapper — and deletes the
row only from a successful send callback (`:80-96`); a periodic `startDelivery` polls every
`config.server.notification.frequency = 15000` (`config.json:8`, `socket-server.ts:114-126`). Token
documents are keyed by accountId, so only that account's rows are fetched (`ctrl.ts:27-28`,
`:89-93`). Notification TTL: `expireAfterSeconds: 300` on `created`
(`pinned/…src_schemes_notification.ts:6`). Consumer: `pinned/…lib_services_notification.js` —
`new NotificationEmiter({url: wsEndpoint + '/' + result.token})` (`:69`), and on **any** `close` or
`error` it re-schedules `connect` after `reconnectInterval` (default 10 s, `:17`, `:46-52`) **with the
same URL/token**.

Phoenix (`notification.js`): last-segment token (`:493-510`), `attachSocket` (`:110-159`), `deliver`
JSON-stringify of the full document (`:266-333`), ack via `removeNotification` only on a successful
send callback (`:291-304`), poll default 15000 (`:15`), store: 100-row global cap + `created` ordering
+ 300 s purge (`notificationStore.js:21-23`, `:330-338`), account-scoped retrieval and status
(`:277-288`, `:377-384`).

**VERIFIED (observed), live sockets:**

| Behaviour | Observation | Verdict |
|---|---|---|
| framing | delivered frame keys `["_id","created","payload","skillId","tokenId"]` — the full document | VERIFIED |
| subscribed client receives a live push | first frame after `enqueueNotification` = `payload.payload.seq == "live"` | VERIFIED |
| unsubscribed account receives nothing | other account's socket saw **0** frames across two deliveries | VERIFIED |
| ack | pending rows for the token after the send callback: `0` | VERIFIED |
| row retained while no socket is open | offline enqueue → row still stored (`rowRetainedWhileOffline: true`), `GetStatus` `connected:false` | VERIFIED |
| unknown token at the upgrade | rejected, HTTP `401` | VERIFIED (see divergence D-1) |
| rotated-away token at the upgrade | rejected, HTTP `401` | VERIFIED |
| consumer URL shape `/{token}` (no `/socket` prefix) | upgrade `open` | VERIFIED |
| trailing slash / bare root | rejected `401` (empty token, both layers) | VERIFIED |
| **the original consumer, driven live** | `svc.connect({deviceId})` → `'open'` → a live frame `payload.payload.seq == "consumer-live"`; then the server-side socket is terminated, a row is enqueued during the gap, and the consumer's own close→reconnect loop re-opens **10 s later with the same URL/token** and receives `payload.payload.seq == "consumer-gap"`; the acked row is not replayed (`events: ["open","message","close","open","message"]`, `consumerReusedTheSameToken: true`) | VERIFIED |

That last row is the strongest available substitute for a robot: the pinned consumer's own code minted
its token through `NewRobotToken`, opened the socket, survived a server-side drop, and replayed exactly
the un-acked row — the ack/reconnect/exactly-once contract, end to end.

Persistence / restart / isolation are additionally pinned by the pre-existing
`notificationDurability.test.js` (store reopen, restart-then-deliver) and
`authenticatedNotificationIntegration.test.js` (Account→Classic outbox bridge, restart recovery,
multi-account isolation) — re-run green in this suite (§9).

---

## 6. Criterion 3 — the robot socket host, separately from HTTP service discovery

The robot builds a **second** hostname for the notification socket: `<region>` + `serverURLSuffix`
(default `-socket.jibo.com`), i.e. `wss://<region>-socket.jibo.com:443/<token>`. `ensure-tls-certs.mjs`
puts both `<region>.jibo.com` and `<region>-socket.jibo.com` in the serving certificate's SAN
(`scripts/ensure-tls-certs.mjs:44`), which is the DNS/TLS half of the criterion that is testable here.

**VERIFIED (observed), over real TLS on a live entrypoint with `tls:{cert,key}`:**

- SAN of the generated cert: `DNS:localhost, DNS:phx.jibo.com, DNS:phx-socket.jibo.com, IP:127.0.0.1, …`.
- REST discovery: signed `NewRobotToken` over TLS with SNI `phx.jibo.com` and the Phoenix CA pinned →
  `200 {"token": …}`.
- Socket: `wss://…/<token>` with SNI **`phx-socket.jibo.com`**, CA pinned, `rejectUnauthorized:true` →
  handshake completes and the pushed frame arrives (`via == "tls"`), then the row is acked.
- Without the Phoenix CA: rejected (`unable to verify the first certificate`).
- With SNI `other.jibo.com`: rejected (`Hostname/IP does not match certificate's altnames`).

Regression control: `notificationSourceContract.test.js` test 3 (skips only where `openssl` is absent).

### What is NOT demonstrated (UNKNOWN)

- A real robot completing the upgrade and acting on a frame. The firmware is not available.
- Production DNS for `<region>-socket.jibo.com`. **This is also a live deployment gap, not just a
  test limitation:** `scripts/robot-repoint-server-client.sh:10` documents that it edits each
  `region_config.json` `endpoint` "leaving the `wsendpoint`/socket entries alone", and
  `DIVERGENCES.md:59` (H-frontdoor) records the same. The pinned config puts the socket host in
  `patterns.globalSSL.wsendpoint = "wss://{region}-socket.jibo.com"`
  (`.parity/consumers/be-12.0.0/server-clients/root/lib/region_config.json`), so a repointed robot
  still dials the dead host until `wsendpoint` (or DNS for that name) is repointed too. Root owns that
  change; it is the one concrete item standing between here and a closed A-10.
- Live `NewRobotToken` from the robot's native SigV4 signer, and the native client's 3 s ping /
  120 s idle keepalive.

---

## 7. Where the earlier candidate report is wrong (source wins)

1. **"Unknown token → 404 `TOKEN_NOT_FOUND`" mischaracterises the source as an upgrade rejection.**
   The source does **not** reject the HTTP upgrade. `srv-notification-ws` raises
   `TOKEN_NOT_FOUND { statusCode: 404 }` (`pinned/…src_errors_errors.ts:3-7`) through the internal
   `GET /token/{id}` route, and `srv-entrypoint-socket-ws` completes the WebSocket handshake first and
   only then runs `ws.close(err.statusCode)` on the setup-failure path
   (`socket-server.ts:25-30` — the failure is caught from `onServerConnection`, i.e. *after* the
   `connection` event). So the source emits **101 then a close frame with code 404**; Phoenix emits an
   HTTP **401** on the upgrade. The consumer therefore observes `open`→`close` against the source and
   `error`(websocket error)→`close` against Phoenix — a different event shape, not merely a different
   number. Both loop on the 10 s reconnect, so recovery converges; the candidate's "no client-visible
   behavior change is expected" is too strong, and its "hard upgrade rejection" description of the
   source is simply wrong. Recorded as D-1.
2. **The candidate's own DIVERGENCES note is right but under-stated.** It flags that
   `DIVERGENCES.md`'s "notification state is in-memory, not persisted" is stale; re-derived here:
   `NotificationStore` persists Token and Notification documents to `ETCO_classic_notificationFile`
   (atomic rename, mode 0600) and the deployed launcher passes
   `notificationFile: resolve(directory,'notifications.json')`
   (`scripts/parity-robot/authenticated-stack.mjs:120,159-163`). The stale row is H-inmemory
   (`DIVERGENCES.md:60`). Root owns that file; flagged, not edited.

Everything else in the candidate's comparison table reproduced against source and runtime, including
the 100-row global cap, `created`-ascending order, 300 s expiry, 15 s poll default, full-document
framing, and the source's missing ownership check on `GetStatus`.

---

## 8. Divergence candidates (for root — `tasks.json` and `DIVERGENCES.md` untouched)

- **D-1 — socket rejection shape for an unknown/rotated token: Phoenix HTTP `401` vs source
  `101` + close `404`.** Source evidence: `srv-notification-ws/src/errors/errors.ts` +
  `srv-entrypoint-socket-ws/src/socket-server.ts:25-30`. Observed: `upgradeStatus()` →
  `{outcome:"rejected", status:401}`. The pinned consumer reconnects either way (it schedules
  `connect` from both `close` and `error`), but the events it sees differ (`open` vs `websocket
  error`), so this is a real, if low-impact, client-visible difference rather than a cosmetic one.
  Not changed here: both a fix (accept the handshake, then close with 404) and any regression test
  would need root's call on whether to reproduce a source bug-shaped behaviour.
- **D-2 — the upgrade token parse strips the query string.** Phoenix keeps only the last path segment
  (`notification.js:494`), so `/<token>?probe=1` attaches (`{outcome:"open"}` observed); the source
  takes `url.substring(url.lastIndexOf('/')+1)` from the raw upgrade URL
  (`socket-server.ts:38`), so the query stays glued to the token and the lookup fails. No pinned
  consumer sends a query; recorded rather than changed.
- **D-3 — envelope for a body that is not JSON at all.** `NewRobotToken` with body
  `not json at all` → `400 {type:"ERROR",msgID,ts,final,data:{message:"Unexpected token o in JSON at
  position 0"}}`; the source front door is Hapi/body-parser and answers `400 {statusCode:400,
  error:"Bad Request",message:"Invalid request payload JSON format"}`. This is the shared
  `packages/common/src/service.js:217-224` (`serviceError`) handler, i.e. classic-wide, not
  notification-specific, and no pinned client ever emits a malformed body. Flagged low.
- **D-4 (doc) — `DIVERGENCES.md:60` H-inmemory is stale for notification**, which now persists Token
  and Notification documents durably; see §7.2.
- **D-5 (scope note, not a defect) — the internal notification-ws HTTP surface does not exist in
  Phoenix.** The source's `GET /token/{id}`, `DELETE /notification/{id}` and `POST /notifications/`
  (`srv-notification-ws/src/routes/route.ts`) are the *entrypoint-socket-ws → notification-ws*
  internal hops. Phoenix merges those two processes, so `NotificationHub` calls the store directly
  and exposes `/notify` for in-process producers (`packages/classic/src/index.js:114-126`). No robot
  path reaches those routes. Recorded so a future auditor does not read their absence as a gap.

---

## 9. Falsification (three corruptions, each on a full source line)

`falsify.mjs` replaces **one complete code line** (matched with its leading newline + indentation, so a
comment quoting the line cannot match), asserts the anchor is unique, runs the focused test files,
records the failure, restores the file byte-for-byte and re-runs. Full record:
`falsification.json`.

| # | Corruption (exact line replaced) | Broken run | Restored run | Result |
|---|---|---|---|---|
| 1 | `packages/classic/src/notification.js` — `case 'getstatus':` → `case 'getstatus-renamed':` (served-at-runtime claim) | exit 1, 5 pass **3 fail**: *both operations … are served at their wire target*, *reconnect with the same token redelivers only un-acked rows*, *rotation makes the old token unreachable* | exit 0, 8 pass 0 fail | **CAUGHT** |
| 2 | `packages/classic/src/notification.js` — `this.store.removeNotification(notification._id);` (inside the send callback) → `void notification._id;` (ack / exactly-once claim) | exit 1, 3 pass **2 fail**: *reconnect with the same token redelivers only un-acked rows, exactly once*, *multi-account isolation … across reconnects* | exit 0, 5 pass 0 fail | **CAUGHT** |
| 3 | `scripts/ensure-tls-certs.mjs` — `dns.push(\`${region}.jibo.com\`, \`${region}-socket.jibo.com\`);` → `dns.push(\`${region}.jibo.com\`);` (TLS/SNI claim) | exit 1, 2 pass **1 fail**: *the robot socket hostname is served over TLS with SNI and delivers …* | exit 0, 3 pass 0 fail | **CAUGHT** |

`allCaught: true`. Each corruption was verified present in the file before the run
(`codeLineChanged: true`) and the file was byte-identical after restore (`restoredByteIdentical: true`);
`git status` shows no modified tracked source afterwards.

---

## 10. Tests added

`packages/classic/test/notificationSourceContract.test.js` — 3 tests, all green in 1.4 s:

1. both declared operations served at their wire target; output shapes; the undeclared
   `Notification_20150505.DeleteAll` → 400 `ValidationException`; an undeclared prefix → 400
   `UnknownOperationException`.
2. the gateway layer: unsigned / unknown key / wrong secret / inactive / skewed / date-less calls all
   refused with the pinned code + status, `x-amzn-errortype` equals the body `__type`, and **no**
   rejection rotates the account's token (a later valid call does).
3. TLS + SNI: certificate SAN carries both hostnames; signed REST discovery over TLS under
   `phx.jibo.com`; socket delivery under SNI `phx-socket.jibo.com` with the Phoenix CA pinned;
   untrusted-CA and wrong-SNI handshakes must fail.

No production source line was changed by this task (`git diff --stat` for tracked files is empty; the
only tracked change is the new test file).

---

## 11. Verified / inferred / unknown

### VERIFIED (observed at runtime, or measured against pinned artifacts)
- The pinned client model declares exactly 2 operations; both wire targets are served (200) and nothing
  else answers on that prefix (400s observed). Operation names, target prefix, `jsonVersion 1.1`.
- The exact wire request the pinned client emits per operation (§2).
- Token: 200 `{token}`, 128-hex shape, six-field Token document, same-document rotation, old key
  unresolvable after rotation, account isolation.
- All 19 measured `joi 10.5.2` messages equal the live 422 messages; 422 envelope shape; rejection
  precedes mutation.
- Auth: six refusal cases with source-exact codes and statuses; `__type` == `x-amzn-errortype`.
- Socket: full-document framing; live delivery to the subscribed account; silence for another account;
  ack removes the row only on a successful send; un-acked rows survive with no socket and are
  replayed on reconnect; unknown/rotated tokens rejected; `/{token}` root-segment URL works.
- The **pinned original consumer** connects, receives a live frame, is dropped by the server,
  reconnects **10 s later with the same token** and receives exactly the row queued during the gap.
- TLS: certificate SAN covers both robot hostnames; signed discovery under `phx.jibo.com`; socket
  delivery under SNI `phx-socket.jibo.com` with the CA pinned; untrusted-CA and wrong-SNI rejected.
- Three falsifications CAUGHT with clean restore.

### INFERRED (reasoned from pinned source; not directly observed here)
- `markConnected`/`markDisconnected` written directly by `attachSocket`/`close` are behaviourally
  equivalent to the source's `SocketConnected`/`SocketDisconnected` → SNS → handler path
  (`ctrl.ts:95-107`, `socket-server.ts:44-52,98-111`); the durable `lastConnected` effect is the same,
  only the propagation delay differs (source is eventually consistent, Phoenix is immediate).
- Immediate delivery on enqueue is faster than the source's ≤15 s poll, because the source's
  `SocketAcceptedForDelivery` event has no consumer in `srv-entrypoint-socket-ws` (its `Handler.mapping`
  is empty, `index.ts` starts only `SocketServer`). Delivery is eventual in both.
- The deployed launcher genuinely reaches this code: `phoenix-robot@.service` runs
  `authenticated-stack.mjs`, which passes both `notificationFile` and the verified SigV4 resolver
  (`authenticated-stack.mjs:155-163`). The resolver-less compatibility path in
  `notification.js:456-460` is therefore test-only.
- The `ws` server auto-pongs client pings, so the native client's keepalive would be satisfied.

### UNKNOWN (not observable without hardware or the original runtime)
- A real robot's upgrade, frames and keepalive on Moth; the native client's reaction to 401-vs-404.
- Whether production DNS for `<region>-socket.jibo.com` resolves/passes a public CA — and, in Phoenix's
  own deployment, whether a robot's `wsendpoint` will be repointed at all (today: no).
- Live `NewRobotToken` from the robot's native SigV4 signer and the exact cereal body bytes it sends.
- Mongo's own TTL sweeper timing (Phoenix purges on read at the same 300 s boundary).

---

## 12. Whole-A-10 status

Criteria 1 and 2: **verified** and now pinned by executable controls. Criterion 3: the DNS/TLS + SNI
half is **verified**; the robot half is **UNKNOWN** and additionally blocked by a known deployment gap
(the `wsendpoint` repoint, §6). Recommendation: **do not mark A-10 verified yet**; the
next step is root's, on hardware.
