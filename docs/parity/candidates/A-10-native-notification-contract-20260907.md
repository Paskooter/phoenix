# A-10 native Notification transport contract (root derivation)

Status: **root source derivation, not a parity acceptance.** This changes no
Phoenix runtime code, no ledger status, and no robot state. It establishes the
exact contract the real on-robot Notification client requires, so that the
authenticated bridge can be connected without guessing.

Source: `PlatformTeam/server-service` at revision
`341e7da85cec8c0e48b5ca80c52ba5761adb19d4`, files `src/NotificationSubsystem.cpp`
(18,421 bytes) and `src/ServerPort.cpp` (13,751 bytes), read through the pinned
archive. Robot-side observations referenced here are root's prior read-only
Moth captures recorded in `.parity/reviews/moth-notification-readonly-root-20260907`.

This supersedes, for the production path, every finding derived from the JS
`@jibo/jibo-server-client` `Notification` class: that class is **not** the
on-robot path. It also supersedes any inference drawn from BE's Node HTTPS
trust failure, which does not describe this native client.

## 1. Credential and identity acquisition (source-proven)

`NotificationSubsystem::initialize` reads the `NotificationSubsystem` config
view and connects a registry client to **`127.0.0.1:<registryPort>`**, default
**8181**. `getCredentials` then:

1. Calls `queryServices()` on that local registry and searches for the record
   named exactly **`system-manager`**. Absent record → `NotificationException`.
2. `GET /credentials` on that record's host/port, 5-second timeout, with header
   `jibo::HTTP_HEADER_AUTHENTICATION` set to the literal string **`"foobar"`**
   (an unresolved TODO in the source). Non-200 → exception. Body is parsed by
   cereal for **`accessKeyId`**, **`secretAccessKey`**, **`region`**.
3. `GET /identity` on the same host/port, same literal auth header. Body parsed
   by cereal for **`name`**, which becomes the `robot` / `deviceId` value.

If `robot`, `accessKeyId` or `region` is empty the subsystem posts a
`CANNOT_CONNECT_TO_SERVER` RECOVERABLE error and returns without contacting the
cloud. Note `secretAccessKey` is **not** in that emptiness check.

## 2. Token request (source-proven)

`getRobotToken` issues, over TLS:

* Host **`<region>.jibo.com`**, port **443**, URI **`/`**, `POST`, HTTP/1.1.
* `Content-Type: application/json`.
* `X-Amz-Target: Notification_20150505.NewRobotToken`.
* All signed headers from `getSignedHeaders` except `host`.
* Body: cereal JSON `{"deviceId": "<robot name>"}`, with `Content-Length` set.

Any status other than 200 raises `NotificationException`. On 200 the body is
parsed by cereal for a field named exactly **`token`**.

## 3. SigV4 signing, and why it cannot be strictly verified (source-proven)

`getSignedHeaders` builds `AWSAuthV4Signer` with service name **`jibo`**,
`PayloadSigningPolicy::Always`, `urlEscapePath = true`, and a
`SimpleAWSCredentialsProvider` holding the local access key, secret key and an
**empty session token**. It signs a `StandardHttpRequest` for
`https://<region>.jibo.com`, method `POST`, and then copies every resulting
header except `host` onto the real requests.

Three consequences a strict verifier would reject, all present in the original:

1. The signed `StandardHttpRequest` carries **no body**. With
   `PayloadSigningPolicy::Always`, the payload hash is the hash of an *empty*
   payload, while the request actually sent carries the `{"deviceId":…}` JSON.
   The `x-amz-content-sha256` header therefore does not describe the real body.
2. The signer is constructed with `configuration.region` — the default
   `ClientConfiguration` region — **not** the `region` string obtained from
   system-manager. The credential scope region and the target host region can
   differ.
3. The same headers are replayed onto the WebSocket handshake, which is a `GET`
   to a *different* host (`<region>-socket.jibo.com`). Method and host both
   differ from what was signed.

**Implication for Phoenix:** the notification endpoints must derive identity
from these headers (access key id → account) and must **not** enforce payload
hash, host binding, or method binding, or the real robot can never connect.
Root's accepted bridge already resolves a verified Account document ID from
SigV4; this pins how strict that resolution may be.

## 4. WebSocket connection (source-proven)

`NotificationSubsystem::connect` composes:

* host = **`<region>` + `serverURLSuffix`**, default suffix **`-socket.jibo.com`**
* port = **443**
* URI = **`/` + `<token>`**

So the effective endpoint is `wss://<region>-socket.jibo.com:443/<token>`.

A **new `ServerPort` is constructed on every connect** — a deliberate
workaround for JIBO-2587 (a stale socket produced a continuation-opcode empty
frame after reconnect), documented in a source comment dated 2017/04/20.

`ServerPort::connect` performs an ordinary HTTP/1.1 `GET` of that path with the
signed headers applied, upgraded via `Poco::Net::WebSocket(session, request,
response)`. It requires **HTTP 101 Switching Protocols**; any other status is
logged and treated as failure. **No subprotocol is requested.**

## 5. TLS and CA trust — the decisive deployment question (source-proven)

Both the token request and the WebSocket handshake configure TLS identically:

```
RejectCertificateHandler(true)
Context(CLIENT_USE, "", VERIFY_RELAXED, 9, true,
        "ALL:!ADH:!LOW:!EXP:!MD5:@STRENGTH")
SSLManager::instance().initializeClient(NULL, pInvalidCertHandler, pContext)
```

* `loadDefaultCAs` is **`true`** — the system CA store is used.
* Verification mode is `VERIFY_RELAXED` with depth 9.
* The invalid-certificate handler **rejects**; there is no interactive or
  permissive fallback.

Therefore a private or self-signed CA **is** acceptable to this client, but
**only** by being installed in the robot's system CA store. Root's owned trust
bind at `/etc/ssl/certs` is the correct and necessary mechanism; it is not a
workaround. The client will not accept an untrusted leaf. The cipher string
excludes ADH/LOW/EXP/MD5, so the Phoenix TLS endpoint must offer a modern
non-anonymous suite (the observed TLS 1.2 issuance path already satisfies this).

## 6. Reconnect timing, and why NewRobotToken repeats (source-proven)

`start()` arms `_refreshConnectionsTimer` with start interval **3000 ms** and
periodic interval **`refreshInterval`**, whose config default is **15000 ms** —
matching Moth's observed `/usr/local/etc/jibo-server-service.json`. On each
tick, if reconnect is enabled and `_serverPort->isConnected()` is false, it
calls the **full** `connect()`: credentials, identity, SigV4 signing, and a
**fresh `NewRobotToken` request**.

This answers the previously open question in the root handoff. The repeated
`Notification.NewRobotToken` requests are **not** a token TTL, not a refresh
policy, and not an emitter reconnect — they are the 15-second connection
retry loop re-requesting a token on every failed attempt. `refreshInterval`
drives reconnection only. There is no token expiry or refresh anywhere in this
client.

Separately, `ServerPort::attachSocket` arms a **3000 ms** periodic timer that
sends a client **PING** every 3 seconds, and `onTimer` disconnects when there
has been no contact for **`_timeout` = 120000 ms (2 minutes)**.

## 7. Frame handling Phoenix must satisfy (source-proven)

From `ServerPort::onReadable`, per received frame:

* Any of `RSV1`/`RSV2`/`RSV3` set → **disconnect**.
* `CONT`/`TEXT`/`BINARY` with `inBytes > 0` → delivered to observers, contact
  clock refreshed. With `inBytes == 0` → logged "Empty Message" and
  **disconnect**. A zero-length data frame therefore kills the connection.
* `PING` → replies `PONG`, refreshes contact clock.
* `PONG` → refreshes contact clock only.
* `CLOSE` → disconnect.
* Any other opcode → **disconnect**.

Outgoing frames always have `FRAME_FLAG_FIN` OR-ed in. Message buffer size is
the `ServerPort` `maxSize` constructor argument.

## 8. Status values

`NotificationSubsystem::status()` is binary: `CONNECTED` when `_serverPort`
holds a socket, else `DISCONNECTED`. The `0 = invalid / 1 = connected /
2 = disconnected` triple observed on `/server/notifications/status` is the web
layer's encoding of that enum plus an invalid state. Moth's three status-2
frames therefore mean only "`_pWebSocket == nullptr`" — they do not by
themselves distinguish a credential failure, a token failure, a TLS rejection
or a failed upgrade. Those are separable only from the service log.

## What Phoenix must provide, in order

1. A local `system-manager` record in the robot's service registry answering
   `GET /credentials` → `{accessKeyId, secretAccessKey, region}` and
   `GET /identity` → `{name}`.
2. `https://<region>.jibo.com:443/` accepting `POST` with
   `X-Amz-Target: Notification_20150505.NewRobotToken` and `{"deviceId":…}`,
   returning 200 with `{"token": "…"}`.
3. `wss://<region>-socket.jibo.com:443/<token>` answering the upgrade with 101.
4. A serving certificate chaining to a CA in the robot's system store.
5. Server-side PING/PONG tolerance, no zero-length data frames, and traffic at
   least every 120 seconds.

Items 1–3 require the robot's name resolution for `<region>.jibo.com` and
`<region>-socket.jibo.com` to reach Phoenix. That routing is **not** established
by the current tunnel configuration and remains open.

## Explicitly not established here

* Whether Moth's `system-manager` currently returns credentials at all, and
  what `region` value it returns. Not captured; requires a read-only robot check.
* The service-registry record contents on Moth for `system-manager`.
* Any claim that connecting this path succeeds. Nothing was deployed.
* The `web/` status-layer encoding was inferred from the observed 0/1/2 triple
  and the binary enum, not read from source.
