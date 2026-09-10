# A-10 — production-path verification (MCP re-derivation + closed gaps)

Date: 2026-09-10 · Worktree `.parity/worktrees/w4-a10`, branch `w4/a10`, base/HEAD `001fc651cade05b6e882fca361c4faa31336cbbd`.
Supersedes the earlier candidate report's verdict. Implementation under test:
`packages/classic/src/notification.js` (+ `notificationStore.js`, `packages/classic/src/index.js:161`, `scripts/ensure-tls-certs.mjs`).

This file exists because the previous A-10 pass left the whole task at "not recommended for
verified" on two grounds: (a) the robot half of acceptance criterion 3 was UNKNOWN, and (b) the
committed TLS control pinned a **synthetic** region (`phx`) rather than the name the robot dials.
Root has since proved (a) on hardware. This pass closes (b) and re-derives the whole contract
from the Jibo archive MCP — design docs **and** pinned source — rather than the local checkout alone.

**Verdict: A-10's acceptance criteria are met. Criterion 3's robot half is covered by root's
hardware evidence plus an independent read of the live production state; the only remaining
UNKNOWN is robot firmware internals, which no server-side control can observe.**

---

## 1. Sources read through the Jibo archive MCP (design intent + implementation)

Every pinned file cited below was fetched fresh from `https://pvindex.org/mcp`
(`gitea_read_file`) during this pass, and the copies already committed under `pinned/` were
confirmed **byte-identical** to that fresh read (sha256 of the body after the tool's header line):

| Artifact | sha256 (16) | match |
|---|---|---|
| `jiborobot/srv-notification-ws:src/controllers/ctrl.ts` | `30df666cecba8ce9` | ✅ |
| `jiborobot/srv-entrypoint-socket-ws:src/socket-server.ts` | `0ac116d08b31b94f` | ✅ |
| `jiborobot/srv-notification-ws:src/errors/errors.ts` | `2e6062d851100898` | ✅ |
| `jiborobot/srv-jibo-server-client:apis/notification-2015-05-05.normal.json` | `500016ae1f1bb6e7` | ✅ |
| `jiborobot/srv-entrypoint-socket-ws:config/config.json` | `a0dea6f8d64c8f1a` | ✅ |

Design documents (`jibo_search` → `jibo_read`):

- **`/confluence/display/SER/Notifications`** — the notification architecture. Robot section quotes:
  - *"It should be possible to send "system notifications" to Jibo Robots."*
  - *"A robotWebSocketToken should be stored securely because if attacker knows it, he will be
    able to receive notifications for particular robot. A robotWebSocketToken may expire at any
    time and robot will need to request new one using owner's access/secret keys."*
  - *"If same robot requested new robotWebSocketToken for same owner, old token will become
    invalid."*  ← rotation/invalidation is a stated design rule.
  - *"As a security improvement server may consume particular robotWebSocketToken only once. Thus
    it may require new token for every new WebSocket connection."*  ← **optional** ("may").
  - *"every time robot gets online it establishes WebScoket connection using URL like
    wss://<SERVER>.jibo.com/<robotWebSocketToken>"*  ← token is the **last path segment**, no prefix.
  - *"When a notification is received via the WebSocket connection, it has (to be defined)
    identifier of a skill it is for."*  ← the `skillId` member.
  - Components list: *"Notification-ws – service that creates and maintains web-socket connections
    with Jibo Robots and delivers notification to them"*.
- **`/confluence/display/SER/Robot+Notifications`** — the notification **type/payload** catalogue
  over the WebSocket: `AccountUpdated`, `ActionCreated`, `LoopUpdated`, `MediaCreated`,
  `MediaDeleted`, `KeyNeeded`, `KeyShared`, `LevelChanged`, `RomConnectionRequested`, each framed
  `{ name, payload: { …, eventKey } }` — i.e. the value carried in a Notification document's
  `payload` member, not the whole wire frame.

Pinned implementation (line numbers in the committed `pinned/` copies):

- `pinned/…src_controllers_ctrl.ts:12` `const NOTIFICATIONS_LIMIT = 100;`
- `:27-28` `findNotificationByTokenId` → `Notification.find({tokenId}).sort({created:1}).limit(100)`
- `:31-45` `newToken` → `randomBytes(64).toString("hex")`, one Token per `accountId`, **rotates** it
- `:81-85` `findByToken` → `Token.findOne({tokenKey})` else `Boom.createWithCode(Errors.TOKEN_NOT_FOUND)`
- `:95-106` `markConnected`/`markDisconnected` → `Token.update(..., {multi:true})`
- `:109-117` `getStatus` → `lastConnected > now-24h`
- `pinned/…src_errors_errors.ts:3-6` `TOKEN_NOT_FOUND { statusCode: 404 }`
- `pinned/…src_socket-server.ts:38` `tokenKey = url.substring(url.lastIndexOf('/')+1)`
- `:30` setup failure → `ws.close(err.statusCode)` (i.e. **101 then close 404**, see D-1)
- `:83-90` `JSON.stringify(notification)` — the **full document** — then `markAsDelivered` only in the success callback
- `:114-126` `startDelivery` re-arms with `config.server.notification.frequency`
- `pinned/…config_config.json:5,8` `wsPort: 8090`, `frequency: 15000`
- consumer `jiborobot/srv-jibo-server-client:lib/services/notification.js` — `wsEndpoint + '/' + result.token`;
  `reconnectInterval = 1000 * 10`; reconnect scheduled from **both** `close` and `error`.

## 2. Operations — enumerated from the pinned model, confirmed served at runtime

`metadata.targetPrefix = "Notification_20150505"`, `jsonVersion "1.1"`, `protocol "json"`.
The model declares exactly **two** operations; the wire name is `targetPrefix + '.' + key`
(`GetStatus` has **no** `name` key in the pinned file, so a reader keying off `name` loses it):

| Model op | wireName | input | output |
|---|---|---|---|
| `NewRobotToken` | `Notification_20150505.NewRobotToken` | `RobotTokenRequest` | `Token {token}` |
| `GetStatus` | `Notification_20150505.GetStatus` | `GetStatusRequest` (required `accountId`) | `GetStatusResponse {connected}` |

**VERIFIED (runtime, this pass).** `probe.mjs` re-run at HEAD `001fc65` → `probe-output.json`:
`declaredOperations: 2`, `servedOperations: 2` (both 200 via the pinned generated client and via
raw SigV4); an undeclared op on the prefix → `400 ValidationException`; an undeclared prefix →
`400 UnknownOperationException`. Pinned by `notificationSourceContract.test.js` test 1.

## 3. Token lifecycle vs the MCP design rules

| Design rule / source behaviour | Pinned site | Observed on Phoenix | Verdict |
|---|---|---|---|
| Token minted from `randomBytes(64)` hex, one per account | `ctrl.ts:31-45` | `200 {token}`, `/^[a-f0-9]{128}$/` | VERIFIED |
| Re-request invalidates the old token | design *"old token will become invalid"*; `ctrl.ts:35` | same Token document, new `tokenKey`; old key 404s at the socket upgrade (401 in Phoenix, D-1) | VERIFIED |
| Token document fields | `schemes/token.ts` | `_id, accountId, created, lastConnected, tokenKey, updated` | VERIFIED |
| Status = persisted `lastConnected` within 24 h | `ctrl.ts:109-117` | `GetStatus` from persisted window; no ownership check (source has none either) | VERIFIED |
| Notification TTL | `schemes/notification.ts` `expireAfterSeconds: 300` | 300 s, purge-on-read, pinned by `notificationDurability.test.js` | VERIFIED |
| Queue cap 100, `created` ascending | `ctrl.ts:12,27-28` | global 100 cap + created-ascending, pinned by `notificationDurability.test.js:160-175` | VERIFIED |
| Socket URL = token as last path segment | design `wss://<SERVER>.jibo.com/<token>`; `socket-server.ts:38` | `/{token}` and `/socket/{token}` both attach; bare root / trailing slash → 401 | VERIFIED |
| Skill identity in the frame | design *"identifier of a skill"* | `skillId` member (`-1` for LoopUpdated) | VERIFIED |

### Docs-vs-implementation disagreements (design vs pinned code)

1. **Single-use token is documented but NOT implemented.** The design calls it a "security
   improvement server **may**" adopt. Neither `ctrl.ts` (no consume-on-connect) nor
   `socket-server.ts` consumes the token, and neither does Phoenix. A behaviour change here would
   diverge from the shipped implementation, so Phoenix correctly mirrors the code, not the "may".
2. **Token expiry is documented but NOT implemented.** The design says the token "may expire at
   any time". `schemes/token.ts` has **no TTL**; only Notification documents expire. Phoenix
   matches the code (no token TTL). A robot rotating via `NewRobotToken` is the only path that
   changes a token.
3. **The design attributes the WebSocket to `notification-ws`; in the code it lives in
   `srv-entrypoint-socket-ws`.** `notification-ws` holds the Mongo Token/Notification documents and
   only exposes internal HTTP (`GET /token/{id}`, `DELETE /notification/{id}`,
   `POST /notifications/`, `routes/route.ts`). Phoenix merges those two processes; `/notify` is the
   in-process producer route (`index.js:161`). The design doc's component line conflates the two.
4. **`<SERVER>` in the design is `<region>-socket.jibo.com` in the client config** — the socket host
   is built from `serverURLSuffix "-socket.jibo.com"` and is **independent** of the REST host.

## 4. Gap closed — the serving certificate's region now matches the robot

The previous control generated its fixture with `PHOENIX_TLS_REGIONS: 'phx'`
(`notificationSourceContract.test.js:275`), a region the robot never uses, and delivered under SNI
`phx-socket.jibo.com`. The robot's native config is region **`api`**, `serverURLSuffix
"-socket.jibo.com"` → `wss://api-socket.jibo.com:443/<token>`; `regionsFrom()` already defaults to
`api` (`scripts/ensure-tls-certs.mjs:27`).

**Fix:** the control now uses the **default** region (no override) and asserts
`api.jibo.com` / `api-socket.jibo.com` on the SAN, delivering under SNI `api-socket.jibo.com`,
and asserts `phx-socket.jibo.com` is **not** on the default cert. A new test
(`notificationProductionPath.test.js` test 1) pins `regionsFrom({}) === ['api']`.

**VERIFIED (read-only, live deployment).** The serving certificate root deploys already carries
the robot names:
`openssl x509 -in ~/.local/share/phoenix/moth/server.crt -noout -ext subjectAltName` →
`DNS:localhost, DNS:api.jibo.com, DNS:api-socket.jibo.com, IP:127.0.0.1, IP:192.168.1.182`.

## 5. Socket delivery proven end to end (criterion 1/2) — incl. queue 1 → 0

New focused control `packages/classic/test/notificationProductionPath.test.js` drives the whole
deployed chain over TLS with the **verified SigV4 resolver** (no test-only compatibility path):
signed `NewRobotToken` under SNI `api.jibo.com` → `wss` upgrade carrying the token under SNI
`api-socket.jibo.com` with the Phoenix CA pinned → **`POST /notify`** (the real producer route) →
frame → ack. Results (this pass, 3/3 green):

- **queue 1 → 0 (VERIFIED).** With the socket offline, `POST /notify` returns
  `{queued: <24-hex id>}` and the durable row count for the token is **1**, `GetStatus` connected
  `false`. The robot socket then connects; the frame is delivered; after the send callback the row
  count is **0** (consumed/acked) and connected is `true`.
- **subscribed receives / unsubscribed does not (VERIFIED).** With sockets open for accounts A and
  B, an A-only `POST /notify` delivers to A (`frame.payload.payload.seq === 'isolated'`) and B sees
  **0 frames**; A's row is acked.
- **framing (VERIFIED).** The frame is the whole Notification document —
  `['_id','created','payload','skillId','tokenId']` — matching `socket-server.ts:83`.
- The pre-existing controls still pass: `notificationLifecycle.test.js` (HTTP `/notify` +
  same-token reconnect replay exactly-once + 401 on rotated/unknown token + multi-account
  isolation) and `notificationSourceContract.test.js` (operation coverage; six auth refusals; TLS/SNI).

The prior `probe.mjs`, re-run at HEAD `001fc65`, additionally shows the **pinned original consumer**
itself opening, being dropped, and reconnecting **10 s later with the same token**, receiving exactly
the row queued during the gap (`summary.socketDeliveryObservable` all `true`).

## 6. Criterion 3 — the real robot socket endpoint

- **Server-side DNS/TLS, separated from REST discovery:** VERIFIED over real TLS in
  `notificationSourceContract.test.js` test 3 and `notificationProductionPath.test.js` test 1
  (cert covers the socket host; a wrong SNI is rejected; the REST face keeps answering discovery).
- **The real robot endpoint:** **VERIFIED by root on hardware**, recorded in
  `docs/parity/evidence/2026-09-10/robot-socket-diagnosis/report.md`: the native
  `jibo-server-service` holds `192.168.1.217:44329 -> 192.168.1.182:443 ESTABLISHED`,
  logs `NotificationSubsystem::connect established connection to server`, and Phoenix's
  `lastConnected` matches that upgrade to **2.3 ms** with a signed `GetStatus → {"connected":true}`.
  Root additionally queued a notification via `POST /notify` and observed it consumed/acked
  (queue 1 → 0).
- **Independent corroboration of the live state (read-only, this pass):**
  `~/.local/share/phoenix/moth/run/notifications.json` holds the robot account's Token
  (`accountId 5a0b20f5ddee0000197e2880`) with `lastConnected 2026-09-10T21:02:24.144Z` — a
  re-rotation + connect seconds after the stack restart — and `notifications: []` (queue empty),
  consistent with the acked delivery.

## 7. Falsification (two corruptions, each on a FULL source line)

`docs/parity/evidence/2026-09-10/a10-notification-lifecycle/falsify-production.mjs`
replaces **one complete code line** (matched with leading newline + indentation so a comment
quoting it cannot match), asserts the anchor is unique, runs the focused file, records the failure,
restores byte-for-byte and re-runs. Record: `falsification-production.json`.

| # | Exact line replaced | Broken run | Restored | Result |
|---|---|---|---|---|
| 1 | `packages/classic/src/notification.js` — `            this.store.removeNotification(notification._id);` → `            void notification._id;` | exit 1, **1 pass / 2 fail**: *the production path: HTTPS /notify is queued offline (1) and consumed+acked by the signed robot socket (0)*; *a socket for a different account never receives another account notification frame* | 3 pass / 0 fail | **CAUGHT** |
| 2 | `scripts/ensure-tls-certs.mjs` — `  const raw = env.PHOENIX_TLS_REGIONS \|\| 'api';` → `  const raw = env.PHOENIX_TLS_REGIONS \|\| 'phx';` | exit 1, **0 pass / 3 fail** (all three production-path tests) | 3 pass / 0 fail | **CAUGHT** |

`allCaught: true`; each anchor verified unique before the run and each file byte-identical after
restore (`git status` clean for tracked source).

## 8. Verified / inferred / unknown

**VERIFIED (observed at runtime, or measured against fresh MCP reads)**
- The pinned model declares 2 operations; both wire targets served 200; undeclared op/prefix → 400.
- Token issuance, same-document rotation, old-key invalidation, account isolation, 24 h status
  window, 100-row created-ascending cap, 300 s expiry.
- Six gateway refusals with source-exact codes/statuses; a rejection never rotates the token.
- **Queue 1 → 0:** an HTTPS `POST /notify` enqueue is durable offline (1), delivered on the signed
  robot socket, and acked (0); an unsubscribed/other account receives nothing.
- Full-document framing; TLS delivery under the **robot's real** SNI `api-socket.jibo.com`; the
  default cert carries `api.jibo.com` / `api-socket.jibo.com` and not a synthetic `phx`.
- The committed `pinned/` copies are byte-identical to a fresh archive read.
- Two falsifications CAUGHT with clean restore.
- Root's hardware evidence (robot ESTABLISHED to :443, `lastConnected` 2.3 ms match, signed
  `GetStatus connected:true`) and the live queue-empty read.

**INFERRED**
- `markConnected`/`markDisconnected` written directly by `attachSocket`/`close` are equivalent in
  durable effect to the source's `SocketConnected`/`SocketDisconnected`→SNS handler path, minus the
  propagation delay (Phoenix is immediate, source eventually consistent).
- `ws` auto-pongs the native client's keepalive.
- The design's optional single-use token / token-TTL were never shipped; matching the code is correct.

**UNKNOWN (not observable without the firmware)**
- Robot firmware internals: the native client's reaction to Phoenix's 401-vs-source 404, its exact
  cereal body bytes, and its keepalive cadence beyond "the connection is ESTABLISHED and stable".
- Mongo's own TTL sweeper timing (Phoenix purges on read at the same 300 s boundary).

## 9. Divergence candidates (not fixed here; `tasks.json` / `DIVERGENCES.md` untouched)

- **D-1** socket rejection shape: Phoenix writes HTTP `401` on the upgrade for an unknown/rotated
  token; the source completes the handshake then `ws.close(404)` (`socket-server.ts:25-30`,
  `errors.ts:3-6`). Both loop on the 10 s reconnect, but the consumer sees `error`→`close` vs
  `open`→`close`. Root's call.
- **D-4 (doc)** `DIVERGENCES.md:60` H-inmemory is stale for notification, which now persists
  Token/Notification documents durably.
- **D-2/D-3** (carried from the earlier pass): query-string token parsing; the classic-wide non-Hapi
  400 envelope for an unparseable body. Low.
- **D-5 (doc)** the earlier pass's `phx` TLS fixture was a non-robot region — now corrected in the
  control.
