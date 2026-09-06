# H-10 rotated-token duplicate 401 analysis

This is a read-only source analysis of the completed Moth H-10 trace. It does not change the robot, services, native source, captures, or goldens.

## Result

The two old-token 401s are consistent with two different retry layers in the inspected source. This is a causal explanation to verify, because the exact source build of Moth's loaded Poco library remains unknown:

1. The Poco WebSocket client sends the first HTTP upgrade and receives 401. In the pinned Poco source, `WebSocket::connect` drains the response, applies any HTTP authentication challenge, and sends one second upgrade request.
2. Only after that second request is also 401 does `ClientCloudConnection::authenticateAndOpen` see `HTTP_UNAUTHORIZED`, invalidate its cached token, fetch once through `Account_20151111.CreateHubToken`, and call the open path once more.

That source implements this sequence:

```text
cached Bearer token
  -> WebSocket handshake #1: 401 (old token)
  -> Poco handshake retry #2: 401 (old token)
  -> native 401 handler: invalidateToken()
  -> one CreateHubToken: new token
  -> WebSocket handshake: 101 (new token)
```

The trace shows 401 at `03:33:18.396Z` and `03:33:18.406Z`, one issuer `CreateHubToken` at `03:33:18.482Z`, and a new-token 101 at `03:33:18.492Z`. The first-to-second 401 gap is 10 ms; the second 401-to-issuer gap is 76 ms; issuer-to-101 is 10 ms. The later `/v1/proactive` 101 at `03:33:43.779Z` uses the same new token and has no additional `CreateHubToken` event.

The public hash-only observation records the old token as
`5dd51c1f9b6a9acf242f495bcc729cb016dcf80182298239662e98b8dbd8abc6` for both 401s and the new token as
`8e719d8abf0f24ae73eb4d2d16aa858583bae20d72894de87bc8a1f8ad5ba7d9` for the successful listen/proactive exchanges. No token contents are included here.

## Source evidence

The native source is Jetstream revision `01ae81fc366ccd6e68ca66fa98f77f957dcdb1fb`:

- `ClientCloudConnection.cpp:53-80` documents and implements exactly one outer retry after `HTTP_UNAUTHORIZED`; it calls `Authentication::invalidateToken()` and then one more `authenticateAndOpenOnce`.
- `ClientCloudConnection.cpp:94-100` gets one authenticated token and calls `open`.
- `ClientCloudConnection.cpp:152-166` puts `Authorization: Bearer <token>` on the request and invokes the three-argument Poco `WebSocket` constructor.
- `Authentication.cpp:41-72` returns the cached token unless empty or expired; `Authentication.cpp:173-182` sets the `Account_20151111.CreateHubToken` target for a fetch.

The downloaded upstream archive is `poco-1.7.9-release.tar.gz`, SHA-256
`150b8d8486fbd01f4bbe359a56439ccf14b62fb9994991baa9663a2656acee27`.
Its `Net/src/WebSocket.cpp:51-60` shows that the three-argument constructor selects `_defaultCreds`. `Net/src/WebSocket.cpp:149-197` sends the first request, and on 401 drains the response, calls `credentials.authenticate`, sends exactly one second request, and throws on a second 401. `Net/src/HTTPCredentials.cpp:76-91` only changes the request when a Basic or Digest `WWW-Authenticate` challenge is present. `Net/src/WebSocket.cpp:200-212` completes the WebSocket only after a 101 response.

Both rejected requests directly carry the same old token hash. What remains inferred is their grouping inside one Poco constructor: the observer did not retain response challenges, WebSocket-key hashes or a native open-attempt identifier. The inspected default credentials handler only handles Basic/Digest challenges, which supports resubmission of the Bearer token through this path. The trace does not show two token refetches.

## Firmware version pin and limit

The available Buildroot recipe is
`/home/shell/work/hermes-be/firmware/sources/buildroot/package/poco/poco.mk`, SHA-256
`49cd4b4f77b30dd6a2218d423904e362755ced90f23ec1b2107802290d3f96e1`, and declares `poco-1.7.9-release` from the Poco GitHub tag. This pins the firmware source recipe to Poco 1.7.9. The H-10 native library itself is identified by the observed SHA-256
`26600cf90703d4b06d3c45846f2b30d16e8615da1e1e9b3057a1b601d9298b49`, but its byte image is not available in this archive for source/build comparison. A sibling Pegasus `libPocoNet.so.48` has SONAME `.48`, while the downloaded upstream 1.7.9 source reports `libversion` 49; therefore the exact loaded Moth library build remains unproven. The report uses Poco 1.7.9 as the firmware recipe pin and the source behavior as a high-confidence explanation, not as a byte-for-byte library identification.

## Minimal observer improvement

Future rotation evidence should associate every Hub upgrade with a connection-attempt ID, attempt ordinal, path, status, and token hash. Retain a boolean for whether `WWW-Authenticate` was present and, if required, a hash of the sanitized challenge scheme. At the native boundary, associate `authenticateAndOpenOnce`, `invalidateToken`, `CreateHubToken`, and final connection-result events with the same attempt ID. Keep credentials, Authorization values, JWT contents, response bodies, and certificates out of the log.

The raw inputs and existing public hash-only derivation are unchanged:

- `.parity/robots/moth/20260906/h10-native-rotation-root7/rotated/hub.jsonl` (SHA-256 `d19121be60917ffd6261f09b2a196b86e2dc3cd81a85ec2cddb15e65cd40d375`)
- `.parity/robots/moth/20260906/h10-native-rotation-root7/rotated/issuer.jsonl` (SHA-256 `6a1b732f2b516d7a2db67e14639a8e8527280ea9e0a95c57e7c20e69ed0569e3`)
- `.parity/robots/moth/20260906/h10-native-rotation-root7/trial.json` (SHA-256 `910f4293392d64a91b63c09e2e0709e433c049e3b5c71bc52b4a89a08b6d1204`)
- `hash-only-observations.json` (SHA-256 `92507216278f2f495ee9a8b7a6b355a307def1c51eb548b328b022af0cecd256`)

Root independently checked these trace/native-source hashes, the upstream archive and all five listed Poco source hashes, and inspected the retry and credentials functions. This accepts the source analysis with its build/grouping limitation; it closes no additional H-10 criterion.
