# H-10 — the native signed `CreateHubToken` → `Bearer` upgrade, exercised on the real robot

Task `H-10` (pegasus, P0) — "Match hub authentication and context identity checks".
Worktree `/home/shell/work/phoenix/.parity/worktrees/w8-h10` (branch `w8/h10`), base `2c1f5c0`.
Pinned source: pegasus `5c0a7390539663ba749d360de348a428c088505c`, read from
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`.

The earlier `w3/h10` slice closed the code-level contract but explicitly left acceptance
item 4 — the *native* signed `CreateHubToken` → `Bearer` upgrade with expiry and the single
401 refetch/retry — **UNKNOWN** for want of a robot. Moth is live, so it is closed here with
robot-originated wire and log evidence, and pinned by a new regression test.

---

## 1. The native contract, re-derived from the pinned source

The hub-facing client on the robot is the native `jibohub-client`
(`.parity/consumers/git/jiboV2/jetstream/01ae81fc366ccd6e68ca66fa98f77f957dcdb1fb/jibohub-client/src`).

`Authentication.cpp`:

| what | where | behaviour |
|---|---|---|
| cache | `:30-31` | `static long long expirationMS = 0; static std::string token = "";` — one cached token per process |
| refetch trigger | `:45-46` | `if (entrypoint_hostname != "" and (token == "" or get_current_time_in_ms() > expirationMS))` |
| signing | `:103-160` | SigV4 over a mimicked `StandardHttpRequest("https://" + entrypoint_hostname, POST)` — **before** any body exists; service `"jibo"`, region from the robot's credential record |
| request | `:175-187,213` | `POST /`, `Content-Type: application/json`, `Content-Length: 2`, `X-Amz-Target: Account_20151111.CreateHubToken`, body `{}` |
| transport | `:203-207` | `HTTPSClientSession(entrypoint_hostname, **443**)` — the port is hard-coded, so the entrypoint is always reached on 443 |
| response | `:246-249` | `token = json.token`, `expiration = json.expires` → `expirationMS = stoll(expiration)` |
| failure | `:227-236` | any non-200 is a hard failure (no retry inside `get_token`) |

`ClientCloudConnection.cpp`:

| what | where | behaviour |
|---|---|---|
| upgrade | `:152-157` | `GET <listen_url>`, `Authorization: Bearer <token>`, `X-JIBO-transID: <HTID:uuid>`, `X-JIBO-robotID: <friendlyId>`, optional `X-JIBO-logging-config` |
| scheme/port | `:139-147` | TLS only when `port == 443`; otherwise plain `HTTPClientSession` |
| **single retry** | `:59-81` | `authenticateAndOpenOnce` once; `if (error_code == HTTP_UNAUTHORIZED) { LOG_WARNING << "Authorization error connecting to: " << hub_hostname << ", re-fetching token."; Authentication::invalidateToken(); authenticateAndOpenOnce(...); }` — **exactly one** refetch and one retry, never a loop |
| listen URL | `jetstream/src/HubclientSettings.h:87` + `/usr/local/etc/jibo-jetstream-service.json` | `/v1/listen` (proactive: `/v1/proactive`) |

The 401 is detected through Poco: `open()` catches the handshake exception and reads
`error_code = response.getStatus()` (`ClientCloudConnection.cpp:179,185,191`), so the server
**must answer the upgrade with HTTP status 401**, not a socket close, for the refetch to fire.

Phoenix's side of that contract (`packages/gateway/src/index.js:44-54,102-124`) was already
pinned by the 1965-case differential; what was missing was the live end-to-end exercise.

---

## 2. Live environment (VERIFIED — observed)

| fact | evidence |
|---|---|
| Robot `Moth-Radius-Breazeal-Felt` = 192.168.1.217, passwordless root SSH | `ssh root@192.168.1.217` |
| Robot resolves the entrypoint to Phoenix: `/etc/hosts` `192.168.1.182 api.jibo.com` (written by `scripts/parity-robot/repoint-robot.sh`) | robot `/etc/hosts` |
| Robot hub client config: `HubClient.override { hub_hostname: 192.168.1.182, hub_port: 29000, entrypoint_hostname: api.jibo.com }`, `listen_url: /v1/listen` | `/usr/local/etc/jibo-jetstream-service.json` on the robot |
| Credentials `region: "api"` (⇒ `api.jibo.com`/`neo-hub.jibo.com` region block) | `/var/jibo/credentials.json` |
| Phoenix deployment = `phoenix-robot@moth.service` (systemd --user), `scripts/parity-robot/authenticated-stack.mjs`, revision `e525894`, entrypointTls 443 + hub 29000 | `systemctl --user status`, journal `{"ready":true,…}` |
| A local turn can be driven on the robot through the original BE Jetstream SDK | `scripts/parity-robot/turn.py --mode local --slot phoenix-be-11-0-1-parity` (ack `{"requestID":"tid-…"}`); copy committed next to this file |

Two *native* log channels were used, both read-only: the robot's own jetstream syslog
(`C.Jetstream.*` / `C.Jibohub_client.*`, severity-tagged RFC5424 over UDP to 127.0.0.1:514 —
captured with `tcpdump -i lo -A udp port 514`, which is also why it never appears in
`/var/log/messages`) and `tcpdump -i wlan0 -A 'tcp port 29000 or tcp port 443'`. Nothing on
the robot was written, installed or reconfigured; the capture directory `/tmp/h10obs` was
removed afterwards.

## 3. The sequence (VERIFIED — observed, real robot, TLS 1.2 to Phoenix)

`runA-local-turn.json` / `runC-native-logs.txt` / `runC-hub-packets.txt`.

```
20:31:49.947  Jetstream.HttpHandler: Handling JetHttpHandler:/listen/start_local_turn
20:31:49.948  Jetstream.ListenLoop: hjw_JM_START_LOCAL_TURN
20:31:49.949  Jetstream.ListenLoop: Entering PH-W state          <- constructs LhubClient
20:31:49.952  GET /v1/listen HTTP/1.1
              Authorization: Bearer <sha256:3c9c3d95…>          <- cached token, from the earlier fetch
              X-JIBO-transID: tid-…
              X-JIBO-robotID: Moth-Radius-Breazeal-Felt
              Host: 192.168.1.182:29000
20:31:49.959  HTTP/1.1 401 Unauthorized
              Connection: close
              Content-Type: text/html
              Content-Length: 36
              JsonWebTokenError: invalid signature            <- Phoenix checkAuthentication catch
20:31:49.963  GET /v1/listen  (same token)  -> 20:31:49.965  401 again
20:31:49.964  Jibohub_client.Connection: Authorization error connecting to: 192.168.1.182, re-fetching token.
20:31:49.973  TCP SYN 192.168.1.217:xxxxx -> 192.168.1.182:443   <- ONE refetch of the signed CreateHubToken
20:31:50.040  GET /v1/listen  Authorization: Bearer <sha256:a205c3c6…>   <- freshly issued token
20:31:50.042  HTTP/1.1 101 Switching Protocols
20:31:50.043  Jetstream.LhubClient: Hub Client connection opened.
20:31:50.044  Jetstream.LhubClient: Hub LISTEN request keystone log entry  (requestID/transID tid-…)
20:31:55.6    phw_JM_HUB_LISTEN -> HJ-W
              BE: Jetstream: localTurnResult: … asr.annotation 'SOS_TIMEOUT' … status 'SUCCEEDED'
```

`wire-summary.txt` (produced by `analyze-wire.py` over the raw captures) is the
machine-readable form of the exchange — per-attempt status, timestamp and token SHA-256;
`runB-hub-packets.txt` / `runC-hub-packets.txt` are the TCP-level extracts (dial, TLS
session to the entrypoint, connection teardown) with the bearer tokens replaced by their
SHA-256, so no credential is stored.

Run B is the same exchange in the other direction (`runB-*`, rotation S0→S1): stale token
`34826cc0…` → 401 → refetch → `3c9c3d95…` → 101. Run C restores the original secret, so the
token Run B was issued becomes Run C's stale token — two independent, chained observations.

**Verified facts.** The Bearer credential the hub accepted is the *output of
`Account_20151111.CreateHubToken`*, not a portal token: `token-claims.txt` decodes the wire
token as `accessKeyId, friendlyId, id, payload, secretAccessKey, iat, exp` with `payload = null`
(the native `{}` body) and `exp - iat = 10800` s, which is
`packages/account/src/model.js:107-121 createAuthenticatedHubToken` in source order. The
signature verified against `ETCO_server_hubTokenSecret`, a secret only the Account issuer
holds, so the token cannot have come from anywhere else. `email` is absent because the live
account document has no `email` property (JSON drops `undefined`), the same way the source
behaves.

**Expiry.** The native predicate (`now_ms > expires`) could not be crossed for real inside a
session: `expires` is `issued + 3 h` (`model.js:10,120`), so the pure expiry-driven refetch
would need either a 3-hour wait or a forged issuer response, and forging would no longer be
the original contract. What is observed is the same cached-token window the predicate gates:
the token fetched during Run A was reused, with no refetch, 109 s later in Run B, and the
server-side half is pinned by test 3 of the new suite (an expired token is a 401
`TokenExpiredError: jwt expired`). The expiry *crossing* itself is INFERRED, not observed.

**What building the request looked like.** The SigV4-signed `CreateHubToken` request line and
`Authorization: AWS4-HMAC-SHA256 …` headers were **not** captured in the clear: they travel
inside TLS 1.2 to 192.168.1.182:443, the robot's OpenSSL negotiates ECDHE, and no host
privilege was available for a decrypting capture. What proves the request happened and was
the native one is the exchange above: a fresh TLS session to the entrypoint immediately
before the accepted token, and a token whose claim object and 3 h lifetime are unique to the
`CreateHubToken` handler. The project's own byte-level reproduction of the native
sign-before-body request is committed at
`packages/account/tools/originalClientCompat.wire-corrected.evidence.js:126-149`, and the new
gateway test below uses the same construction.

## 4. What was wrong / missing, and what changed

No production behaviour was wrong. The Rediscovered gap is narrower than "the code":

| gap | resolution |
|---|---|
| Nothing in `npm test` exercised the *sequence* — Account-issued token → Hub upgrade → 401 on rotation → single refetch → retry. The differential fixtures pin the auth *matrix*; the runtime tests pin CONTEXT identity; the issuer's own tests stop at token issuance. A regression in the 401 status or in the shared-secret wiring would have passed the whole suite. | new `packages/gateway/test/hubAuth.sequence.test.js` (4 tests) |

The new suite drives the real `Store`/Account service, the real Classic entrypoint and the
real Hub: it POSTs the native sign-before-body `CreateHubToken` (empty signed payload with an
explicit `x-amz-content-sha256`, wire body `{}`, `application/json`,
`X-Amz-Target: Account_20151111.CreateHubToken`), then asserts:

1. all four registered upgrade paths accept the issued token (101), `/v1/unknown` still 404s
   with a valid token (the allow-list layer) and no credentials is still
   `401 Authorization is required` (the credential layer runs first);
2. after the secret rotates, the cached token is `401 JsonWebTokenError: invalid signature`
   and a modelled `authenticateAndOpen` recovers with **exactly one** refetch and **exactly
   one** retry, carrying a different token;
3. an expired token is `401 TokenExpiredError: jwt expired`;
4. a `CONTEXT` is validated against the identity in the `CreateHubToken` claims — mismatch
   rejected with `data.general.accountID is not equal to socket accountID` and no `code`, on
   both `/listen` and `/proactive`, and the matching identity completes a turn.

## 5. Falsification (performed)

One corruption, anchored on a full code line, confirmed with `grep -n` in this worktree
before and after, restored afterwards.

**F1 — the 401 the native client's refetch depends on.**
Broke `packages/gateway/src/index.js:114`
`      if (error) { log.warn('ws auth failed', { error }); return cb(false, 401, error); }`
→ `      if (error) { log.warn('ws auth failed', { error }); return cb(false, 200, error); }`
(`grep -n` confirmed line 114 then read `return cb(false, 200, error)`).
Result: **3 failed / 1 passed** in `packages/gateway/test/hubAuth.sequence.test.js` —
`not ok 1 - the native signed CreateHubToken issues a token the Hub accepts as a Bearer credential`
(`AssertionError: 200 !== 401`, sequence test line 244),
`not ok 2 - a rotated Hub secret is a 401 on the cached token and the native client recovers with exactly one refetch and one retry`,
`not ok 3 - an expired CreateHubToken is refused with the source 401 body`.
Test 4 (CONTEXT identity over an authenticated socket) still passed, which shows the
corruption was narrow. Log: `falsify-401-line114.log`.
Restored with the inverse patch; the file was re-run and is green (4/4, exit 0).

## 6. Divergence candidates / observations (for root; DIVERGENCES.md not edited)

1. **`X-JIBO-logging-config` is accepted but not honoured.** `BaseService.ts:250-273` turns the
   header into a per-socket `jibo-log` namespace level via
   `parseLoggingConfigHeader`/`parseLogLevels` (`:88-106`). Phoenix carries only
   `x-jibo-transid` into its logger context (`packages/gateway/src/index.js:132`). This is
   log-infrastructure, not authentication, and the robot always sends it; noted, not changed.
2. **`remoteAddress` has one extra fallback.** Source `getRemoteIPAddress`
   (`BaseService.ts:285-295`) returns `x-forwarded-for` (whole header) else
   `req.connection.remoteAddress`, and `undefined` with a warning if neither exists; Phoenix
   (`index.js:129`) appends `|| ''`. Unreachable in practice — a real TCP/TLS socket always
   has a remote address — so it is not observable on this surface. Reported, not changed.
3. **The transport-level duplicate stale attempt is Poco's, not Phoenix's.** Each observed
   rejection answered `Connection: close`, and the native client then re-dialled and repeated
   the same stale request once before its own refetch (Run B/C: `401`, `401`, then the single
   refetch → `101`). The server-side contribution is only the 401 + body; the retry count that
   the refetch depends on (`ClientCloudConnection.cpp:59-81`) is exactly one and is observed
   as exactly one. The mechanism inside Poco's `HTTPClientSession` was not instrumented, so
   the *reason* for the duplicate is INFERRED.

## 7. Claim ledger

**VERIFIED (observed)**

- A real robot performed `GET /v1/listen` with `Authorization: Bearer <CreateHubToken JWT>`
  against Phoenix and received `101 Switching Protocols`; the turn then completed
  (`phw_JM_HUB_LISTEN`, `SOS_TIMEOUT`, `status: SUCCEEDED`) with the Hub's LISTEN keystone
  entry logged natively.
- A rotated Hub secret produced `401 Unauthorized` with body
  `JsonWebTokenError: invalid signature`, the native warning
  `Jibohub_client.Connection: Authorization error connecting to: 192.168.1.182, re-fetching token.`,
  exactly one new TLS session to the entrypoint on 443, and exactly one retry that carried a
  **different** token and upgraded (101). Reproduced twice, in both rotation directions.
- The accepted credential is the Account `CreateHubToken` output (claim set/order,
  `payload = null` from the native `{}` body, `exp - iat = 10800`), verified against the hub
  secret, so portal token creation is not a substitute for it.
- The cached token is reused across turns while inside its `expires` window (no refetch in
  Run B's first attempt, 109 s after issuance).
- The robot reaches Phoenix because `/etc/hosts` maps `api.jibo.com` to 192.168.1.182; the
  `CreateHubToken` port is hard-coded to 443 in `Authentication.cpp:204`.
- The new gateway suite (4 tests) passes; the whole `npm test` run is green (section 8).

**INFERRED (reasoned from source)**

- The native expiry *crossing* (`get_current_time_in_ms() > expirationMS`) — see §3; the
  predicate and its observable proxy (cached reuse, and the server's expired-token 401) are
  verified, the 3 h crossing was not waited out.
- The duplicate pre-refetch attempt is Poco's keep-alive/closed-connection retry (§6.3).
- The `expires` field the native client stores equals `exp*1000`: not observed as bytes (it is
  inside TLS) but consistent with `model.js:120` and with the observed reuse window.

**UNKNOWN**

- The plaintext SigV4 `CreateHubToken` request line and headers from the live robot (§3).
- Anything requiring microphone recognition, the wake word, the physical ring, a robot reboot,
  or a persistent multi-host rollout: not touched.
- Whether H-10 as a whole should be flipped to verified — that is the parent's call; this
  slice closes acceptance item 4's observable sequence and the regression guard.

## 8. Test run

`npm test` in this worktree (`w8-h10`), one run, no concurrent suite (`npm run test:unit && npm run parity:check && npm run parity:gate`):

```
# tests 1566
# suites 7
# pass 1559
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 67731.5
```

`npm test` exit code **0**. `parity:check`: `Checklist: 39/79 verified (49.4%)`, structure valid.
Parity gate JSON: `{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
The 4 new tests account for the delta from the 1562-test baseline; the 7 skips are the
reference-path artifact.

## 9. Reproducing this evidence

```bash
# observers on the robot (read-only)
ssh root@192.168.1.217 'mkdir -p /tmp/h10obs; cd /tmp/h10obs; \
  nohup /usr/sbin/tcpdump -i lo -s0 -A -l "udp port 514" > logs.txt 2>/dev/null </dev/null & \
  nohup /usr/sbin/tcpdump -i wlan0 -s0 -A -l "tcp port 29000 or tcp port 443" > hub.txt 2>/dev/null </dev/null &'
# drive one local turn through the original BE Jetstream SDK
python3 turn.py --native-port 18090 --cdp-port 19223 --slot phoenix-be-11-0-1-parity \
  --mode local --duration 20 --out run.json
# rotate (backup first) and repeat to observe the single 401 refetch
```
