# A-10 native NotificationSubsystem source contract

Status: **source-only candidate**. No Phoenix runtime code was changed. This
does not claim robot or Phoenix parity.

Task ID: `A-10-native-notification-source-20260907`  
Worktree HEAD: `950d832876f3fd58e585c6c2c34ed452b34f9832`  
Hashbrown baseline (project pin, unused here): `5c0a7390539663ba749d360de348a428c088505c`  
Date: 2026-09-07

Native production owner (given by root, not re-measured here):
`/usr/local/bin/jibo-server-service` on port 8888, config
`NotificationSubsystem.refreshInterval = 15000` and
`serverURLSuffix = "-socket.jibo.com"`. Local
`/server/notifications/status` returned three status-2 frames.

## How to read this document

Each numbered answer is split into **source-proven**, **inferred**, and
**unknown**. Citations are `repo/path@revision:lines`. Hashes of every file
relied on are in
`.parity/reviews/A-10-native-notification-source-20260907/source-manifest.json`
(gitignored with `.parity/`) and copied at the end of this file so they are
committed.

The JS `@jibo/jibo-server-client` `Notification` class and the Node 6.5 HTTPS
untrusted-cert observation are **not** the native transport. They appear only
where they independently corroborate a native source fact, and are labeled.

## Pins

| Artifact | Revision | Role |
| --- | --- | --- |
| `PlatformTeam/server-service` | `341e7da85cec8c0e48b5ca80c52ba5761adb19d4` | Native `jibo-server-service`. This **is** `master` HEAD (commit 2018-05-30, AWS-SDK-CPP >= 1.3 signer). |
| `patrick/poco` branch `jibo/1.8.1` | `994744ea0f96c326953eada9866bcbb03b1466da` | Poco 1.8.1 NetSSL used to interpret `Context` / `RejectCertificateHandler` / hostname verify. Makefile of server-service links `-lPocoNetSSL`. The robot binary's exact Poco revision was **not** read from the robot. |
| `PlatformTeam/system-manager` | `3f1b11ebba5f2ab334145235d5837afaefbed54f` (`master` HEAD) | Local `/credentials` and `/identity` that native calls. |
| `jiborobot/srv-notification-ws` | `e42bfe01506a8febf3005ac536fda735bba49d0d` | Cloud `NewRobotToken` that native posts to. Same pin as the earlier A-10 Phoenix store candidate. |
| `jiborobot/srv-entrypoint-socket-ws` | `5247ab9c02f6c984e4a7ab31b09577af63308436` | Cloud WSS that native connects to after it has a token. |
| `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | API model + JS URL templates. **Not** the on-robot path. |
| `server/notification-ws` | `523824db1e2bca5a7ba8a90f537459ed6d0f3470` | Older JS notification-ws. DeviceId-keyed; later TS service is account-keyed. |

Source config `PlatformTeam/server-service/config/jibo-server-service.json`
sha256 `42f7b9d8ba90825efe79944b22a79f55e8e7cd916c4f556d16ca4a1a9acf7cbc`
**equals** the robot configuration hash recorded by root in
`docs/parity/evidence/2026-09-07/hardware/notification-transport/review.json`.
The installed config file is the same bytes as this source file.

Retrieval command (archive Gitea, no robot, no third-party network beyond the
configured Jibo portal):

```text
curl -fsSL https://pvindex.org/gitea/<repo>/raw/commit/<revision>/<path>
sha256sum <saved-file>
```

---

## 1. URL construction

### Source-proven

Native builds **two** outbound HTTPS hosts from the robot's **credentials
`region` string**. It does not read JS `region_config.json`. It does not
concatenate an account id. `serverURLSuffix` is **only** used for the
websocket host.

Token HTTP (before the socket):

```text
POST https://{region}.jibo.com:443/
```

- Host: `region + ".jibo.com"` (`NotificationSubsystem.cpp:326-327`).
- Port: hardcoded `443`.
- Path: hardcoded `"/"`.
- Scheme: `Poco::Net::HTTPSClientSession` (`:335`).

Websocket (after a token is obtained):

```text
GET wss://{region}{serverURLSuffix}:443/{token}
```

which with the installed suffix is

```text
GET wss://{region}-socket.jibo.com:443/{token}
```

- Host: `region + _params.serverURLSuffix` (`:201`).
- Default suffix `"-socket.jibo.com"` (`:49`, config `:11-14`).
- Port: hardcoded `443` (`:202`).
- Path: `"/" + token` (`:203`).
- Scheme: `HTTPSClientSession` + `Poco::Net::WebSocket` upgrade
  (`ServerPort.cpp:117-124`). Required HTTP status is `101 Switching
  Protocols` (`ServerPort.cpp:136-137`).

Worked example: if system-manager credentials `region` is `R`, token is `T`:

| Purpose | Effective URL |
| --- | --- |
| Mint token | `https://R.jibo.com:443/` |
| Notification socket | `wss://R-socket.jibo.com:443/T` |

The **local** sockets BE talks to are a different pair, served by the same
native process on port 8888:

| Local path | Registration | Role |
| --- | --- | --- |
| `/server/notifications` | `^/server/notifications/?$` (`ServerService.cpp:76`) | Fan-out of cloud frames to on-robot clients. |
| `/server/notifications/status` | `^/server/notifications/status?$` (`ServerService.cpp:77`) | 1 Hz status JSON. The `?` makes the final `s` optional. |

Platform test list is exactly those two paths
(`platform-test/ss-WSTest.json`). Confluence
`ENG/Server Service` documents them as
`ws://<service address>/server/notifications` and
`ws://<service address>/server/notifications/status`.

`region` is the Jibo stack/region from `/var/jibo/credentials.json` via
system-manager GET `/credentials`, **not** an AWS geography name: it is
interpolated as a DNS label. Phoenix portal default
`ETCO_account_region \|\| 'phx'` would yield `phx.jibo.com` /
`phx-socket.jibo.com` if that string is what the robot stores.

### Inferred

JS `lib/region_config.json` `globalSSL` pattern
`https://{region}.jibo.com` / `wss://{region}-socket.jibo.com` matches the
native hosts. JS then appends `'/'+ result.token`
(`lib/services/notification.js:77-79`). That is independent corroboration of
the URL shape. It is **not** what the native binary executes.

### Unknown

- The actual `region` string on Moth (`/var/jibo/credentials.json`) was not
  read in this task.
- Whether production DNS for `{region}-socket.jibo.com` CNAME/A-records still
  exist, and whether they currently resolve to original AWS or nowhere.
- Whether any on-robot hosts file already overrides those names.

---

## 2. Token

### Source-proven

Native does **not** hold a long-lived notification token. Every `connect()`
mints a new one.

**Step A — local credentials** (`getCredentials`, `:399-535`):

1. Query service registry on `127.0.0.1:{registryPort}` (default 8181) for
   name `"system-manager"`.
2. HTTP GET `http://{system-manager.host:port}/credentials` with header
   `jibo::HTTP_HEADER_AUTHENTICATION: "foobar"` (hardcoded; TODO in source).
   5 second timeout. Require HTTP 200. Cereal-parse
   `accessKeyId`, `secretAccessKey`, `region`.
3. HTTP GET `.../identity` with the same dummy auth. Cereal-parse
   `name` into `robot`.

System-manager serves those from `/var/jibo/credentials.json` and
`/var/jibo/identity.json`
(`CredentialsHandler.cpp`, `IdentityHandler.cpp`, `CredentialsManager.cpp`).

Empty `robot`, `accessKeyId`, or `region` aborts connect and posts
`CANNOT_CONNECT_TO_SERVER` (`NotificationSubsystem.cpp:175-187`). Empty
`secretAccessKey` is **not** in that emptiness check.

**Step B — SigV4 headers** (`getSignedHeaders`, `:261-309`):

- AWS SDK C++ `InitAPI` / `ShutdownAPI` on every call.
- Credentials: robot `accessKeyId` / `secretAccessKey`. Session token is
  hardcoded `""` with a source TODO (`:269-275`).
- Signer: `Aws::Client::AWSAuthV4Signer`, service name `"jibo"`
  (`JIBO_SERVICE_NAME`, `:37`),
  `PayloadSigningPolicy::Always`, `urlEscapePath = true`.
- Signed request: `HTTP_POST` of URI `https://{region}.jibo.com` with **no
  body attached to the AWS request object**.
- `configuration.region` is **never assigned** from the robot region. The
  signer is constructed with `configuration.region` (`:291`).
- Copied onto the Poco request: every signed header **except** `"host"`
  (`:303-308`).

**Step C — NewRobotToken POST** (`getRobotToken`, `:311-379`):

```text
POST / HTTP/1.1
Host: {region}.jibo.com:443
Content-Type: application/json
X-Amz-Target: Notification_20150505.NewRobotToken
<SigV4 headers from step B>
Content-Length: <cereal JSON length>

{ cereal JSON of deviceId = robot identity name }
```

- Body is `cereal::JSONOutputArchive` of `CEREAL_NVP(deviceId)` where
  `deviceId` is the identity `name` (`:343-348`).
- Success: HTTP **200 only** (`:368`). Then
  `cereal::JSONInputArchive` of `CEREAL_NVP(token)` (`:372-373`).
- Non-200: `NotificationException("Could not receive robot token: " +
  response.getReason())`. The numeric status is **not** included. There is
  **no** 4xx-vs-5xx branch, no retry-after, no backoff inside this function.
- Parse failure, send failure, or receive failure: also
  `NotificationException`. Caught by `connect()` (`:193-198`), which logs
  and posts `CANNOT_CONNECT_TO_SERVER`, then returns. Next attempt is the
  refresh timer (section 3).

Cloud handler (`jiborobot/srv-notification-ws` `handler.ts:24-36`):
`NewRobotToken` is `@parseCredentials` (SigV4 via the security gateway) and
`@validatePayload({ deviceId: Joi.string() })` — `deviceId` is optional for
backward compatibility. Token is 64 random bytes hex, stored per
**accountId**, not per deviceId (`ctrl.ts:31-46`). Response `{ token:
result.tokenKey }`.

API model (`notification-2015-05-05.normal.json`): target prefix
`Notification_20150505`, operation `NewRobotToken`, output required
`token` string.

The same SigV4 header map is then passed into `ServerPort::connect` for the
websocket GET (`:223`). Original entrypoint-socket-ws authenticates the
socket by the **path token only** (`socket-server.ts:33-44`). It does not
read Authorization.

### Inferred

- Cereal JSON for the request is a JSON object with key `deviceId`. Exact
  whitespace/pretty-print was not produced by executing cereal. Phoenix
  already accepts a JSON object with optional string `deviceId`.
- Signing an empty POST and then attaching `Content-Type`, `X-Amz-Target`,
  and a JSON body is the same pattern A-02 established for Jetstream
  `CreateHubToken`. Phoenix SigV4 verification that honors explicit
  `x-amz-content-sha256` is the matching server-side behavior.
- Signing region in the credential scope is whatever AWS-SDK-CPP
  `ClientConfiguration.region` defaults to (server-service was updated for
  SDK >= 1.3 in `341e7da`). The robot region is **not** that value. Phoenix
  must take the region from the Authorization credential, not require it to
  equal the DNS label.

### Unknown

- Exact AWS-SDK-CPP `ClientConfiguration.region` default string: aws-cpp-sdk
  source was **not** in the Gitea index used here.
- Exact cereal JSON bytes (spaces, newline, key order).
- Whether production security-gw still accepts a signed empty-body POST
  with a later JSON entity (A-02 says the archived gateway does).
- Robot identity `name` and whether it equals the Classic account/device id
  Phoenix uses.

---

## 3. Retry / refresh (`refreshInterval = 15000`)

### Source-proven

`refreshInterval` drives **one** timer: reconnect-if-disconnected. It is
**not** token refresh on a live socket, **not** status publication, and
**not** a notification poll.

`NotificationSubsystem::start` (`:91-104`):

1. Start the socket reactor thread.
2. `_refreshConnectionsTimer.setStartInterval(3000)`.
3. `_refreshConnectionsTimer.setPeriodicInterval(_params.refreshInterval)`
   → 15000 from config.
4. Start the timer.
5. Call `connect()` **immediately**.

Timer callback (`onRefreshConnectionsTimer`, `:133-141`):

```text
if (!_reconnect) return;
if (!_serverPort->isConnected()) connect();
```

If the websocket pointer is non-null, the timer is a no-op. A live
connection is not periodically re-authed.

`connect()` always mints a **new** token (section 2) and **replaces** the
`ServerPort` object (`:216-221`) as a workaround for JIBO-2587.

Independent timers, not `refreshInterval`:

| Timer | First fire | Period | What it does |
| --- | --- | --- | --- |
| `_refreshConnectionsTimer` | 3000 ms | **15000 ms** (`refreshInterval`) | Reconnect if down. |
| `_serverNotificationsStatusTimer` | 3000 ms | **1000 ms** | Broadcast local status JSON (`ServerService.cpp:46-49, 116-137`). |
| `_refreshServiceConnectionsTimer` | (Poco default) | 10000 ms | Service-registry refresh. Unrelated. |
| `ServerPort` ping timer | 3000 ms after attach | **3000 ms** | Send WebSocket ping; disconnect if `_lastContact` older than **120000 ms** (`ServerPort.cpp:29, 387-416`). |

`_lastContact` is updated on successful connect and on inbound
text/binary/ping/pong. Outbound pings do **not** update it. The peer must
pong (or send data) at least once per 120 seconds.

CredentialsChanged (system-manager, channel GENERAL): ServerService
disables reconnect, `disconnect()`, `connect()`, restores the flag
(`ServerService.cpp:154-176`). That is an event-driven reconnect, not the
15 s timer.

Cloud entrypoint-socket polls pending notifications every
`config.server.notification.frequency` = **15000 ms**
(`config.json`, `socket-server.ts:123`). That 15 s is a **server-side**
delivery poll. It is coincidentally the same number as native
`refreshInterval` and is a different loop.

### Inferred

Poco `Timer` start interval is the delay before the first callback, then
the periodic interval repeats. Combined with the immediate `connect()` in
`start()`, native tries at t=0, then at ~3 s if still down, then every 15 s.

### Unknown

- Whether Poco Timer on the robot build fires the first periodic from t=0
  or from t=startInterval. Did not execute Poco Timer.
- Observed reconnect timing on Moth.

---

## 4. TLS / CA (decisive for Phoenix)

### Source-proven

Both the token POST and the websocket upgrade construct the **same** Poco
client context (`NotificationSubsystem.cpp:328-335` and
`ServerPort.cpp:107-117`):

```cpp
new RejectCertificateHandler(true);
new Context(Context::CLIENT_USE, "",
            Context::VERIFY_RELAXED, 9, true,
            "ALL:!ADH:!LOW:!EXP:!MD5:@STRENGTH");
SSLManager::instance().initializeClient(NULL, pInvalidCertHandler, pContext);
HTTPSClientSession(host, port, pContext);
```

This is the 6-argument `Context` constructor
(`Context.h:188-196`, `Context.cpp:78-94`):

| Argument | Value | Meaning |
| --- | --- | --- |
| usage | `CLIENT_USE` | Client SSL_CTX (`SSLv23_client_method` / `TLS_client_method`). |
| caLocation | `""` | **No** extra CA file or directory is loaded (`Context.cpp:123-134` skipped). |
| verificationMode | `VERIFY_RELAXED` | `SSL_VERIFY_PEER`. Client: if verification fails, handshake is terminated (`Context.h:70-77`). |
| verificationDepth | `9` | Max chain depth. |
| loadDefaultCAs | `true` | `SSL_CTX_set_default_verify_paths` (`Context.cpp:136-144`). OpenSSL built-in / default CA paths only. |
| cipherList | `ALL:!ADH:!LOW:!EXP:!MD5:@STRENGTH` | |

`_extendedCertificateVerification` defaults to **true** on this constructor
(`Context.cpp:88`). `HTTPSClientSession::connect` sets SNI / peer hostname
to `getHost()` (`HTTPSClientSession.cpp:143-146`). After handshake,
`SecureSocketImpl::verifyPeerCertificateImpl` compares the peer cert CN/SAN
to that hostname (`SecureSocketImpl.cpp:356-370`,
`X509Certificate.cpp:77-123`). Loopback hosts skip this extra check unless
mode is `VERIFY_STRICT`. `{region}.jibo.com` is not loopback.

`RejectCertificateHandler(true)`: the `true` argument means **server-side**
event subscription (`InvalidCertificateHandler.cpp:29-32`). Native is a
client, so this handler is attached to `ServerVerificationError`, not
`ClientVerificationError`. That is a source bug relative to the usual
`RejectCertificateHandler(false)` client pattern.

It does **not** make native accept bad certs. OpenSSL `SSL_VERIFY_PEER`
still fails the handshake on an untrusted chain. `SSLManager::verifyCallback`
(`SSLManager.cpp:193-207`) fires `ClientVerificationError`; with no client
delegate, `VerificationErrorArgs._ignoreError` defaults to **false**
(`VerificationErrorArgs.cpp:27`), so `ok` stays 0. Independently,
extended hostname verification throws
`CertificateValidationException` if CN/SAN does not match the host.

There is **no** `AcceptCertificateHandler`. There is **no**
`VERIFY_NONE`. There is **no** application config key to add a CA. Native
is **not** unconditionally rejecting every certificate; it is rejecting any
certificate that fails OpenSSL default-path verification **or** hostname
match.

What a Phoenix certificate must satisfy for this client:

1. Serve TLS on **port 443** for **two names**: `{region}.jibo.com` (token)
   and `{region}-socket.jibo.com` (websocket). A wildcard SAN such as
   `*.jibo.com` would match both under Poco's wildcard matcher
   (`X509Certificate.cpp:126-144`).
2. Chain to a CA present in the robot's OpenSSL **default verify paths**
   (typical Linux: `SSL_CERT_FILE` / `SSL_CERT_DIR` / compiled-in
   OPENSSLDIR certs, often `/etc/ssl/certs`). A private CA must be
   **installed into that store on the robot**. Putting the CA only in
   Phoenix, or only in Node's extra-CA list, is not enough.
3. A self-signed Phoenix cert that is **not** in that default store will
   fail `SSL_VERIFY_PEER`. That is the expected native failure mode, and
   it is unrelated to the earlier Node `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
   probe.

`initializeClient` is called on **every** token POST and **every**
websocket connect, replacing the process-global SSLManager client context.

### Inferred

Robot firmware of this era likely uses OpenSSL 1.0.x default paths under
`/etc/ssl/certs`. Not confirmed on Moth.

### Unknown

- Exact OpenSSL version and default CA directory on Moth.
- Whether Moth already has a private CA in `/etc/ssl/certs`.
- Whether a Let's Encrypt (or other public) cert for `*.jibo.com` would
  verify against the robot store without installing anything. That depends
  on the robot CA bundle, which was not read.
- TLS protocol floor: native does not call `disableProtocols`. Offered
  versions follow the robot OpenSSL `SSLv23_client_method` /
  `TLS_client_method` plus `SSL_OP_ALL`.

---

## 5. Status codes

### Source-proven

Enum (`NotificationSubsystem.h:29-32`):

```cpp
enum Status : int {
    INVALID = 0,
    CONNECTED,      // 1
    DISCONNECTED    // 2
};
```

`NotificationSubsystem::status()` (`:253-259`):

- websocket pointer non-null → `CONNECTED` (1)
- else → `DISCONNECTED` (2)

It **never** returns `INVALID`.

`ServerService::onServerNotificationStatusTimer` (`:116-137`):

- If `_ns` is null → `INVALID` (0)
- Else `_ns->status()` which is 1 or 2
- Cereal-serialize `CEREAL_NVP(status)` as JSON and
  `broadcastFrame(..., FRAME_TEXT)` on the **local**
  `/server/notifications/status` port, every 1 second after a 3 s start
  delay.

`isConnected()` is `_pWebSocket != nullptr` (`ServerPort.cpp:174-178`).
Connect success requires 101. Connect failure, send/receive exception,
close opcode, reserved RSV bits, unknown opcode, empty data frame, or 120 s
idle all `disconnect()` and null the pointer → subsequent status frames are
2.

Confluence `ENG/Server Service` agrees: `0` invalid, `1` connected, `2`
disconnected, 1 Hz stream.

Root's three consecutive status-2 frames therefore mean: the
NotificationSubsystem pointer is set (otherwise 0), and the outbound
websocket to `{region}-socket.jibo.com` is **not** currently held. That is
compatible with DNS failure, TLS rejection, token POST failure, or 101
failure. Status-2 does **not** distinguish those causes. The error bus
posts `CANNOT_CONNECT_TO_SERVER` on those failures; that bus was not read
here.

`INVALID` (0) is only published if the status timer runs without
`setNotificationSubsystem`. `ServerApp::onInitialize` sets it
(`ServerApp.cpp:29`). After a normal start, 0 is not the steady state.

### Inferred

Cereal serializes this `enum : int` as a JSON number, producing a body
like `{"status":2}` (pretty-printed). Did not execute cereal.

### Unknown

- Exact JSON whitespace of the 1 Hz frames on Moth (root recorded the
  numeric statuses, not the raw frames, in the review JSON this task
  read).
- Whether ErrorTracker `CANNOT_CONNECT_TO_SERVER` is visible on the robot
  UI/logs for the current disconnect.

---

## 6. Server-side contract Phoenix must implement

This is the contract of the **native client**. Phoenix already implements
most of the Classic/TS side. Gaps below are deployment/TLS/URL, not a
missing `NewRobotToken` handler.

### Endpoints the native binary will call

1. **Token mint** — `POST https://{region}.jibo.com:443/`
   - Header `X-Amz-Target: Notification_20150505.NewRobotToken`
   - `Content-Type: application/json` (native does **not** send
     `application/x-amz-json-1.1`)
   - SigV4 for service `jibo`, empty-body signature, then JSON entity
     `{deviceId}`
   - Response **200** with a JSON object containing `"token"` (hex string).
     Native cereal-parses only that key. Extra keys are not required.
   - Any non-200 is a hard fail for that attempt (reason string only).

2. **Notification websocket** — `GET https://{region}-socket.jibo.com:443/{token}`
   upgrade to WebSocket.
   - Path is `/{token}`, **not** `/socket/{token}`.
   - Port **443**.
   - HTTP 101 required.
   - Auth is the path token. SigV4 headers on this GET are leftover from
     the token POST; original socket server ignores them.
   - No `Sec-WebSocket-Protocol` is set by native (`ServerPort.cpp:97-124`
     never sets it).

Phoenix Classic currently documents `/socket/<token>` and its tests connect
that way. `attachNotificationSocket` takes
`path.slice(path.lastIndexOf('/') + 1)`, which **would** accept native
`/{token}` on the same HTTP server. That is Phoenix source, not a robot
measurement. Original `socket-server.ts:36` uses the same last-segment
rule.

Native will **not** hit Phoenix unless `{region}.jibo.com:443` and
`{region}-socket.jibo.com:443` terminate on Phoenix with a cert the robot
trusts. The authenticated launcher's loopback `:19443` plus
`https://localhost` public URL is **not** an address native will open.

### Handshake / frames / ping

- Standard RFC 6455 upgrade, HTTP/1.1, no subprotocol.
- Native sends a ping every 3 s after attach (`ServerPort.cpp:387-416`).
  The peer must pong. `ws` servers typically auto-pong.
- Native pongs inbound pings (`:283-295`).
- Idle > 120 s without inbound ping/pong/text/binary → native drops.
- Empty text/binary/continuation payload → native drops
  (`ServerPort.cpp:247-257`).
- RSV bits, unknown opcodes, close opcode → drop.
- Max frame buffer 16384 (`ServerPort.h:41`).
- Cloud messages are forwarded locally with the **same flags**
  (`ServerService.cpp:147-148`). Original socket server sends
  `JSON.stringify(notification)` text frames
  (`socket-server.ts:79-82`): a Notification document (`_id`, `created`,
  `payload`, `skillId`, `tokenId`), not a raw `{name, payload}` wrapper.
  Confluence `SER/Robot Notifications` describes the inner payload names
  (`LoopUpdated`, `AccountUpdated`, …). Native does not parse them; it
  relays bytes to local `/server/notifications`.

### What Phoenix already has vs what connecting Moth still needs

Already in Phoenix Classic (prior A-10 work; not re-verified here):
`NewRobotToken`, durable token/notification store, last-segment socket
token, ping-capable `ws` server, SigV4 account resolver on the
authenticated launcher.

Still required to satisfy **this native client**, and **not** implemented
as a code change in this task because they are deployment/trust, not a
missing handler:

1. DNS (or robot hosts) for `{region}.jibo.com` **and**
   `{region}-socket.jibo.com`.
2. TLS listener on **443** with a certificate whose CN/SAN matches those
   names **and** whose chain is in the robot OpenSSL default CA store.
3. Confirm a `GET /{token}` upgrade on that TLS listener (Phoenix last
   segment already allows it; tests currently only use `/socket/{token}`).

No Phoenix runtime edit is directly forced by this source reading. A
follow-up test that upgrades `/{token}` would be a small, source-backed
guard. Changing `serverURLSuffix` on the robot, installing a CA, or
binding :443 is root/hardware work.

---

## What this task did not establish

- Any packet capture or TLS handshake on Moth.
- Moth `region`, identity `name`, OpenSSL version, or `/etc/ssl/certs`
  contents.
- Exact cereal JSON bytes and exact AWS SDK signing-region string.
- Whether Phoenix `/{token}` upgrade works under the authenticated TLS
  launcher (not run).
- Live `NewRobotToken` against Phoenix from the native signer.
- BE `NotificationsDispatcher` source (local consumer only; native is
  the cloud client).

Passing Phoenix unit tests is not evidence that Moth can connect.

## Concrete next step

Root, on the robot (read-only first):

1. Read `/var/jibo/credentials.json` `region` (no secrets in logs) to
   materialize the two hostnames.
2. Confirm whether those names resolve, and to where.
3. Only then choose **one** of: install a public/private CA that native
   will accept for both names on :443, or change robot DNS/hosts to point
   those two names at Phoenix. Do not infer success from a Node HTTPS
   probe.

A Phoenix follow-up (separate candidate): add a focused test that a
websocket at `/{token}` — not only `/socket/{token}` — attaches, and that
the TLS cert hostname is `{region}.jibo.com` / `{region}-socket.jibo.com`
rather than `localhost`.

---

## Source manifest (committed copy of the gitignored JSON)

Retrieval: `https://pvindex.org/gitea/<repo>/raw/commit/<revision>/<path>`.

| repo | revision | path | sha256 | bytes |
| --- | --- | --- | --- | --- |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | Makefile | `30438f581397213145c307ad98d635ea7b7ff280cbcd5bffa18794f834d75b44` | 4435 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | config/jibo-server-service.json | `42f7b9d8ba90825efe79944b22a79f55e8e7cd916c4f556d16ca4a1a9acf7cbc` | 845 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | include/jibo/server/NotificationSubsystem.h | `0f1c73f7225e7e16970bc8ebdca400f8d1db74d34c52565bbe1e891bdee46874` | 3140 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | include/jibo/server/ServerApp.h | `86401590b7e9799b01c826a24d41d805b389136d07eca909e3b71c23abca4e71` | 707 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | include/jibo/server/ServerCommon.h | `da59564c33c63f6ee85c6c15597f5cfd8817440f841b5551eb93a627f18864c5` | 1888 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | include/jibo/server/ServerPort.h | `550a59139c800716ee08b6614849117b2fcfdcf4bc704d31b1d9cd77e9e7bcdc` | 3024 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | include/jibo/server/ServerService.h | `5eada47d7878035119ff3401ea0c8e2d2ef23f54259107a936fa1f4d000092f3` | 1720 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | platform-test/ss-WSTest.js | `c57c876cc3ec01416b2ca65bec28cc22ff8c48e653d77077175adc956c37619b` | 743 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | platform-test/ss-WSTest.json | `dc5842a81c496b95f00cbc61a319db17686bf4bae8a56f7c07351fc804f137e5` | 96 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/NotificationSubsystem.cpp | `501f78c5b5542cb3256cda023c89a660cd47130f3ae5a5e8921353c0b6d3c194` | 18421 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/ServerApp.cpp | `0d763d3203a86d1426503c3ea4d6298f56c899e7a7e29f7be7e7ba4500d9e162` | 1000 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/ServerCommon.cpp | `504688b219810b146188e0087679444d02ddf6fa6eb3db7c9b4c0063a8361b6f` | 392 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/ServerPort.cpp | `c990463d8bc73497b267e147850596ac10fd28284d52fb328b3cf48b5520862c` | 13751 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/ServerService.cpp | `8d096e4d86fe5571b6ee08e0c99ee074dbd972b8320c1a99ef9d143f5fbcd4dd` | 5605 |
| PlatformTeam/server-service | 341e7da85cec8c0e48b5ca80c52ba5761adb19d4 | src/server_service.cpp | `4fe29519c2ec4386359fb36a6dca041549bdedfc6f2abe54c1390c05789d8483` | 137 |
| PlatformTeam/system-manager | 3f1b11ebba5f2ab334145235d5837afaefbed54f | src/CredentialsHandler.cpp | `cb781713fe7da3b3e5e72aa122615e3f1900122f91ac6b36d362bb8fc7fab28f` | 4026 |
| PlatformTeam/system-manager | 3f1b11ebba5f2ab334145235d5837afaefbed54f | src/CredentialsManager.cpp | `8eb82c16361fa68c59387b1154a0447b00a17d374d8b8767799bfc0de39a3af6` | 3092 |
| PlatformTeam/system-manager | 3f1b11ebba5f2ab334145235d5837afaefbed54f | src/IdentityHandler.cpp | `476ced3e237b57d6da25a24a7e6ef39f040ea0370bf96c67943bd5285572f1c4` | 3168 |
| jiborobot/srv-entrypoint-socket-ws | 5247ab9c02f6c984e4a7ab31b09577af63308436 | config/config.json | `4f312ed950bcba06c27c3f6ae48c23bdcf245e1e4afe1c73f36ce93a461679b1` | 203 |
| jiborobot/srv-entrypoint-socket-ws | 5247ab9c02f6c984e4a7ab31b09577af63308436 | src/index.ts | `b51a841d5c845c5e795bd054c9c42e13615188675764044e83d388542e96e3e6` | 744 |
| jiborobot/srv-entrypoint-socket-ws | 5247ab9c02f6c984e4a7ab31b09577af63308436 | src/socket-server.ts | `ae0d0de803358a98b688ca1204426012788ff4cc6e0c8b6614388f484ae6e771` | 4078 |
| jiborobot/srv-jibo-server-client | 155d20a8102960b2aeb89c197bdf04dc1f1fc344 | apis/notification-2015-05-05.normal.json | `b935151cec00c31a56ad0e4e34ce878fccdde416afe557f62847a11931406155` | 1738 |
| jiborobot/srv-jibo-server-client | 155d20a8102960b2aeb89c197bdf04dc1f1fc344 | lib/region_config.json | `f1514e59a030b87da7aac8ac5e9b56f5fc0e4dd034e12ad2f1eadb1cca904bcb` | 721 |
| jiborobot/srv-jibo-server-client | 155d20a8102960b2aeb89c197bdf04dc1f1fc344 | lib/services/notification.js | `93b9677b95a3a153a540b98f79d15c5c0c28fb4819b0f1aed99abae93828bd9b` | 2329 |
| jiborobot/srv-notification-ws | e42bfe01506a8febf3005ac536fda735bba49d0d | src/controllers/ctrl.ts | `d4780195b1be8e19eddb80e51e7dc09fb327542c50477a6954b99beeb8d010f1` | 3610 |
| jiborobot/srv-notification-ws | e42bfe01506a8febf3005ac536fda735bba49d0d | src/handlers/handler.ts | `ded461b5a019553a2ac3f38e2973675fbd266ab7cdc3f47b0bf593b451b6a78c` | 1413 |
| jiborobot/srv-notification-ws | e42bfe01506a8febf3005ac536fda735bba49d0d | src/index.ts | `7bdf0a0c5433daa71bae4d7e82a31daf8b084f117071f7e58f9e127e6302d721` | 4949 |
| jiborobot/srv-notification-ws | e42bfe01506a8febf3005ac536fda735bba49d0d | src/routes/route.ts | `557747fb1b777778459b4900daa75c2ae363fd4e987353d2e0a4d8629554418e` | 2100 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/include/Poco/Net/Context.h | `3ecaf759b1bf6396e7783c4898dc57d9a427410e254abcca96693380bb19bd33` | 14305 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/include/Poco/Net/RejectCertificateHandler.h | `b1ac96b76b2d4014a692d4b76c372cabb3103d41b63fb46c7932a8783bcd013e` | 1114 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/include/Poco/Net/SSLManager.h | `cc9331df6a0a183ed22825a9fcef5edc19b5ceb5de239a64d779edcf45fd2bdd` | 18531 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/include/Poco/Net/VerificationErrorArgs.h | `e78aafc2555318109afa3e2cafac358e62c0966937d258bd73b47364a74f13d2` | 2276 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/Context.cpp | `70b0fd42a3f24d3e4e110392717845d84a90d50af2c901fa67ab2b199ec1206e` | 14633 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/HTTPSClientSession.cpp | `762db1e050408763c361b8816b82e50976f747be975eef23cd64c9907fcb359b` | 3772 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/InvalidCertificateHandler.cpp | `60815d98ba3fb611e9a80a857100f821db600bcfa5abbb29d0485a6ca6d1b691` | 1471 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/RejectCertificateHandler.cpp | `516aa8d3270ce2e520f352f4cdd9768e610cd548340d10dcdf8ebf9175c53ad3` | 680 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/SSLManager.cpp | `15b4fb835d9090fdbc4b43d69612fcb5e7049877e7e150f1ec744176742e72cc` | 13957 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/SecureSocketImpl.cpp | `c6215a9df5c1a1a6bd445d0ceaff2765d5711ece499ea82658aef14e998393e5` | 10904 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/VerificationErrorArgs.cpp | `954a52e0f994b6789b9eb5af15c3c512de180aee692dfa83c4e79060def0f18a` | 661 |
| patrick/poco | 994744ea0f96c326953eada9866bcbb03b1466da | NetSSL_OpenSSL/src/X509Certificate.cpp | `4705190d8f0f3e2521b56326177d3e53b94928ba9ea7da557adce4b0e01ca4be` | 3629 |
| server/notification-ws | 523824db1e2bca5a7ba8a90f537459ed6d0f3470 | README.md | `9159bd706b16c35720d920467e88548b1da70023bc9cf8a6e51d167ca11273fc` | 1908 |
| server/notification-ws | 523824db1e2bca5a7ba8a90f537459ed6d0f3470 | src/controllers/robot.ctrl.js | `c788ac6d6da56b781c7bd0d441bb2996e88d50e8f64f2efbf6d119e49e4c9c3f` | 2792 |
| server/notification-ws | 523824db1e2bca5a7ba8a90f537459ed6d0f3470 | src/handlers/handler.js | `2be396655017900a9c58512d5fcf43f4e7da6bc25d4d38025fb9a5e4c97b68df` | 3327 |
| server/notification-ws | 523824db1e2bca5a7ba8a90f537459ed6d0f3470 | src/index.js | `9da6abfcc7a36ffc8384b97e07e9c8d0df394e482b6258d6f38c22980cf96da8` | 632 |
