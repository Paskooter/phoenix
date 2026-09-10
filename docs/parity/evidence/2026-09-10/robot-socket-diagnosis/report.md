# Robot notification WebSocket diagnosis — 2026-09-10

**Target:** physical Jibo `Moth-Radius-Breazeal-Felt` @ `192.168.1.217` (root SSH, BatchMode).
**Phoenix host:** `192.168.1.182` (this machine), Phoenix stack `node scripts/parity-robot/authenticated-stack.mjs`, rev `97bae61706367b8d162a786317d225907440ec35`, worktree `/home/shell/work/phoenix/.parity/worktrees/deploy-97bae61-20260910`.
**Verdict: the notification WebSocket channel DOES reach Phoenix.** Four independent signals below. There is no hostname, cert-name, port, path, CA, or process blocker. The premise "it does not reach Phoenix" is falsified as of this investigation.

Every claim is tagged **VERIFIED** (observed directly), **INFERRED** (reasoned from observation), or **UNKNOWN**.

---

## 0. Environment

VERIFIED:
- `hostname` → `Moth-Radius-Breazeal-Felt`; `uname -a` → `Linux ... 3.10.104 #1 SMP PREEMPT ... armv7l`.
- `node --version` → `v6.9.2`; `curl --version` → `curl 7.45.0 ... OpenSSL/1.0.2d`.
- **No `openssl` CLI** on the robot; `python`/`python2` present, no `python3`, no `nc`, no `ss`. `netstat` is BusyBox (`netstat -p` is unsupported).
- Phoenix listens on `0.0.0.0:443` (classic TLS entrypoint) and `0.0.0.0:29000` (hub), both owned by `node` PID `233359`.

---

## 1. Who owns the notification socket — is it attempted? (VERIFIED: yes)

The notification WebSocket client is the **native** binary `/usr/local/bin/jibo-server-service` (ELF 32-bit ARM), config `/usr/local/etc/jibo-server-service.json`:

```json
"NotificationSubsystem": {
    "registryPort": 8181,
    "refreshInterval": 15000,
    "serverURLSuffix": "-socket.jibo.com"
}
```

The binary builds the socket host as `region + serverURLSuffix` = `api` + `-socket.jibo.com` = `api-socket.jibo.com`. Process is running:

```
root 31924 0.5 0.3 119136 7248 ? Sl 14:26 0:11 /usr/local/bin/jibo-server-service -c /usr/local/etc/jibo-server-service.json
```

(A JS implementation also exists — `/usr/local/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/services/notification.js`, `url = wsendpoint + '/' + token` — but the **live** socket is the native one; see `/proc/net/tcp` owner and the `jibo-server-service[31924]` log prefix.)

**The socket is attempted and connected.** Robot log (`/tmp/messages*`, tag `jibo-server-service[31924]`):

```
2026-09-10T14:46:54.161451-04:00 ... jibo-server-service[31924,info]: - P.NotificationSubsystem:
  NotificationSubsystem::connect Connecting to api-socket.jibo.com:443/04db408756f151cb40d3bdaeb87bf54144d96dadfe606c70b26f0489cb1959d12d80906b0cb99d057408fd78de484ec2d0578887d64c016359fa7540f6d03e6e
2026-09-10T14:46:54.200698-04:00 ... jibo-server-service[31924,info]: - P.NotificationSubsystem:
  NotificationSubsystem::connect established connection to server
```

---

## 2. Does the robot reach 192.168.1.182:443? (VERIFIED: yes)

DNS from the robot (`getent` absent; used `ping`):

```
PING api-socket.jibo.com (192.168.1.182) 56(84) bytes of data.
64 bytes from api.jibo.com (192.168.1.182): icmp_seq=1 ttl=64 time=2.27 ms
```

Live TCP connection, from the robot's `/proc/net/tcp` (`D901A8C0` = 192.168.1.217, `B601A8C0` = 192.168.1.182, `01BB` = 443, state `01` = ESTABLISHED):

```
293: D901A8C0:AD29 B601A8C0:01BB 01 00000000:00000000 ... 2780167 1 eb658580 20 4 14 5 3 jibo-server-service 31924
```

i.e. `192.168.1.217:44329 -> 192.168.1.182:443 ESTABLISHED`, owned by `jibo-server-service` PID 31924. `netstat -an` on the robot agrees:

```
tcp   0  0 192.168.1.217:44329   192.168.1.182:443   ESTABLISHED
```

The **same socket inode (2780167)** was still ESTABLISHED ~20 minutes later — the connection is stable, not flapping.

TLS handshakes with the **system** OpenSSL store succeed (curl, robot):

```
curl -sv --max-time 8 https://api-socket.jibo.com/ -o /dev/null   ->  < HTTP/1.1 404 Not Found
curl -sv --max-time 8 https://api.jibo.com/        -o /dev/null   ->  < HTTP/1.1 404 Not Found
```

(404 is expected: no `GET /` route; the point is the TLS handshake completed with no verify error.)

---

## 3. Does the robot trust the Phoenix CA? (VERIFIED for the system store; Node is the exception)

Phoenix CA `subject=CN = Phoenix Moth development CA`, `sha256 54:7B:7D:3C:04:42:05:D4:7F:F4:77:17:1C:1A:88:F4:88:53:B3:3D:55:28:49:F3:5B:D4:72:59:00:B1:D9:B7`.

Robot trust store — the **identical** CA is installed system-wide:

```
md5sum /home/shell/.local/share/phoenix/moth/ca.crt        -> d66cbee0d7e6a46db17252b528c8df80   (Phoenix)
md5sum /etc/ssl/certs/phoenix-ca.crt                        -> d66cbee0d7e6a46db17252b528c8df80   (robot)  IDENTICAL
md5sum /etc/ssl/certs/ad76badb.0                            -> d66cbee0d7e6a46db17252b528c8df80   (hashed symlink -> phoenix-ca.crt)
```

The CA PEM block is also present inside the concatenated bundle:

```
sed -n '2p' /etc/ssl/certs/phoenix-ca.crt | grep -c "$(that line)" /etc/ssl/certs/ca-certificates.crt  ->  1
```

So OpenSSL (the native binary and curl) trusts it, and the socket connects. **CA trust is NOT the blocker.**

**The one real asymmetry: Node.js on the robot does NOT trust it.** Running a Node client from the robot against `api-socket.jibo.com:443`:

```
DNS api-socket.jibo.com -> 192.168.1.182
TLS ERROR: unable to verify the first certificate
```
```
TCP+TLS up; peer authorized= false err= UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

INFERRED cause: Node.js (v6.9.2) validates against its own **bundled Mozilla root list**, not `/etc/ssl/certs`; `NODE_EXTRA_CA_CERTS` is not set. This is exactly why the repo ships `scripts/parity-robot/patch-server-client-ca.cjs` to inject `ca:` into JS clients. Any JS socket client on the robot must receive the CA explicitly; the native path does not.

---

## 4. End-to-end WebSocket test from the robot (VERIFIED — reachable, Phoenix answers)

No `wscat`/`openssl` on the robot, but Node v6 + the system `tls` module work. Probe `/tmp/robot-probe2.js` (TLS verify disabled so the reply is visible):

```
node /tmp/robot-probe2.js
TCP+TLS up; peer authorized= false err= UNABLE_TO_VERIFY_LEAF_SIGNATURE
--- Phoenix reply for bogus token ---
HTTP/1.1 401 Unauthorized
```

So the robot **is** reaching Phoenix's WebSocket upgrade handler on 443, and Phoenix answers `401` for an unknown token (not a silent drop). A real token yields `101` — see §5.

---

## 5. Phoenix's side — the upgrade is accepted and the socket registered (VERIFIED)

Phoenix `packages/classic/src/notification.js :: attachNotificationSocket` matches the token as the **last path segment**:

```js
const path = (req.url || '').split('?')[0];
const tokenKey = path.slice(path.lastIndexOf('/') + 1);
```

So the robot's `wss://api-socket.jibo.com/<token>` and the documented `/socket/<token>` both resolve to the same tokenKey. **No path mismatch.**

Phoenix's durable notification store (`/home/shell/.local/share/phoenix/moth/run/notifications.json`) — the robot's token document, for the robot's account:

```json
{
  "_id": "c200a99035417877cec525ec",
  "accountId": "5a0b20f5ddee0000197e2880",
  "tokenKey": "04db408756f151cb40d3bdaeb87bf54144d96dadfe606c70b26f0489cb1959d12d80906b0cb99d057408fd78de484ec2d0578887d64c016359fa7540f6d03e6e",
  "created": "2026-09-08T03:08:26.070Z",
  "lastConnected": "2026-09-10T18:46:54.203Z",
  "updated": "2026-09-10T18:46:54.156Z"
}
```

- `updated 18:46:54.156Z` = the robot's `NewRobotToken` REST call (5 ms before the robot logged "Connecting").
- `lastConnected 18:46:54.203Z` = Phoenix `attachSocket() -> store.markConnected()`.
- The robot's own log line is `14:46:54.200698-04:00` = `18:46:54.200698Z` — a **2.3 ms** match. This is the robot's upgrade being accepted, not a coincidence.

Independent confirmation — a **read-only** SigV4 `Notification_20150505.GetStatus` using the robot's own credentials:

```
Notification_20150505.GetStatus {"accountId":"5a0b20f5ddee0000197e2880"} => {"status":200,"body":"{\"connected\":true}"}
```

Account binding is correct: robot `/var/jibo/credentials.json` `accessKeyId = qT6kpa6DTrPlYY8pEfo0` → Phoenix `account.json` account `_id 5a0b20f5ddee0000197e2880, friendlyId "Moth-Radius-Breazeal-Felt"` — the same account the token is bound to.

---

## 6. Port (VERIFIED: 443 is correct)

The robot's URL is `wss://api-socket.jibo.com/<token>` → port **443** (default). Phoenix's classic TLS entrypoint listens on `0.0.0.0:443`, and it hosts **both** the REST routes and the WebSocket upgrades on that same server (`authenticated-stack.mjs`: `serve both HTTP and notification upgrades on one TLS server`). Match. (Phoenix's `:29000` is the ASR hub; the jetstream config's `hub_port 29000` is the audio hub, unrelated to the notification socket.)

---

## 7. The reconnect "flap" (VERIFIED drops / INFERRED cause)

Robot log drops, e.g.:

```
2026-09-10T14:37:04 ... jibo-server-service[31924,warning]: - P.Application.ServerPort:
  ServerPort[2]::onReadable Disconnecting because of socket exception: SSL connection unexpectedly closed
2026-09-10T14:37:09 ... jibo-server-service[31924,err]: - P.NotificationSubsystem:
  NotificationSubsystem::connect Failed to connect to the server: Could not request robot token: Connection refused
```

INFERRED: these drops coincide with Phoenix restarts. During 14:37:09–14:37:39 the robot could not even fetch a token (`Connection refused` = Phoenix down); it reconnects ~10 s after Phoenix returns. No drop has occurred since the 14:46:54 connect (same socket inode still ESTABLISHED at 15:0x). The `ServerPort[N]::onReadable ... SSL connection unexpectedly closed` line is the robot noticing the peer went away; its exact internal owner is INFERRED (not proven from the binary).

---

## 8. Why the premise likely existed

VERIFIED: the `phoenix-robot@moth.service` journal contains only the startup line —

```
Sep 10 18:46:44 shell-host node[233359]: {"ready":true,"started":"2026-09-10T18:46:44.345Z", ... "endpoints":{"entrypointTls":443,"hub":29000,...}}
```

and nothing else. The stack runs with `LOG_LEVEL=warn` (from `~/.config/phoenix/moth.env`), but the success path logs at **info**:

```js
reportSocketInfo(log, 'socket connected', { accountId: token.accountId });
```

So a successful socket connection produces **no log line at the configured level**. Absence of Phoenix logs is not absence of the connection. Combined with the transient `Connection refused` windows during restarts, that fully explains a "does not reach Phoenix" impression.

---

## Root cause

**There is no blocker preventing the robot's notification WebSocket from reaching Phoenix — it reaches Phoenix and Phoenix registers it.** VERIFIED by (a) the robot's ESTABLISHED TCP to `192.168.1.182:443`, (b) the robot's "established connection to server", (c) Phoenix's `lastConnected` matching to 2.3 ms, (d) Phoenix's signed `GetStatus` returning `{"connected":true}`.

The only genuine defect found is a **CA-trust asymmetry for JS clients**: the native `jibo-server-service` (and curl) use the system OpenSSL store, which contains the Phoenix CA, so they connect; the robot's Node.js uses its own bundled root list and rejects the cert (`unable to verify the first certificate`). This does **not** affect the native notification socket, but it will break any un-patched JS socket client.

## Minimal precise fix

- **For reach (the asked question): none required.** No hosts, cert, port, path, or process change is needed.
- **If a JS notification client must reach the socket**, make it trust the CA — either set `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/phoenix-ca.crt` in that client's service environment, or ensure `scripts/parity-robot/patch-server-client-ca.cjs` has been applied to that copy of `@jibo/jibo-server-client`.
- **For observability**, run the stack at `LOG_LEVEL=info` (or log a warn-level line on connect) so a successful upgrade is visible.

## Changes made to the robot

**None** to configuration or services. Only two read-only probe scripts were copied to the robot's `/tmp` (`/tmp/robot-probe.js`, `/tmp/robot-probe2.js`); they open outbound TLS/WS connections and print results, and can be deleted freely. No hosts, CA, config, token, or service was modified. No notification was enqueued (I deliberately did not use `POST /notify` to avoid mutating robot-visible state).

---

## Command appendix (exact commands run)

```sh
# SSH sanity
ssh -o BatchMode=yes -o ConnectTimeout=12 root@192.168.1.217 'hostname; uname -a; cat /etc/hosts'

# Process / socket owner
ssh ... 'ps aux | grep jibo-server-service; cat /usr/local/etc/jibo-server-service.json'
ssh ... 'grep -i "01BB" /proc/net/tcp'          # ESTABLISHED 192.168.1.217:44329 -> 192.168.1.182:443
ssh ... 'netstat -an | grep 443'

# DNS / reach
ssh ... 'ping -c 2 -W 2 api-socket.jibo.com'
ssh ... 'curl -sv --max-time 8 https://api-socket.jibo.com/ -o /dev/null'
ssh ... 'curl -sv --max-time 8 https://api.jibo.com/ -o /dev/null'

# CA trust
md5sum /home/shell/.local/share/phoenix/moth/ca.crt
ssh ... 'md5sum /etc/ssl/certs/phoenix-ca.crt /etc/ssl/certs/ad76badb.0'
ssh ... 'L=$(sed -n 2p /etc/ssl/certs/phoenix-ca.crt); grep -c "$L" /etc/ssl/certs/ca-certificates.crt'

# Socket attempt + connect (robot log)
ssh ... 'grep -ahE "NotificationSubsystem|ServerPort\[" /tmp/messages /tmp/messages.1 | tail -60'

# E2E from robot (Node)
scp /tmp/robot-probe.js  root@192.168.1.217:/tmp/ && ssh ... 'node /tmp/robot-probe.js'    # -> unable to verify the first certificate
scp /tmp/robot-probe2.js root@192.168.1.217:/tmp/ && ssh ... 'node /tmp/robot-probe2.js'   # -> HTTP/1.1 401 Unauthorized

# Phoenix side
cat /home/shell/.local/share/phoenix/moth/run/notifications.json
journalctl --user -u phoenix-robot@moth.service -n 80 --no-pager
node /tmp/robot-getstatus.mjs   # SigV4 Notification_20150505.GetStatus -> {"connected":true}
```
