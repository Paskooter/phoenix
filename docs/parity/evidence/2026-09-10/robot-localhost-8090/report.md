# Repeating `getaddrinfo ENOTFOUND localhost localhost:8090` in the `be` renderer — diagnosis + fix

**Date:** 2026-09-10
**Target:** physical Jibo `Moth-Radius-Breazeal-Felt` @ `192.168.1.217` (root SSH, BatchMode), region `api`.
**Worktree:** `/home/shell/work/phoenix/.parity/worktrees/w3-localhost` (branch `w3/localhost`).
**Verdict: fixed on the robot.** The failing client is the **stock Be jetstream client** (`@jibo/jetstream-client`), not the native notification socket. It failed because the Electron renderer runs as uid 2000 and **could not read `/etc/hosts`** (symlink → `/var/etc/hosts`, mode `700`), so glibc's `files` NSS module was skipped and `localhost` was sent to DNS, which cannot answer it. Making the hosts file readable (the only change on the robot) stopped the spam and, as a side effect, brought the jetstream sockets up.

Every claim is tagged **VERIFIED** (observed directly), **INFERRED** (reasoned from observation), or **UNKNOWN**.

---

## 0. The symptom, measured

VERIFIED — robot log `/tmp/messages`, verbatim (one line, fields elided in the middle):

```
2026-09-10T19:21:24.842Z Moth-Radius-Breazeal-Felt be[3024,warning]:
  [1@1 frames="[{\"method\":\"errnoException\",\"filename\":\"dns.js\",\"line\":28,\"column\":10},
   {\"method\":\"GetAddrInfoReqWrap.onlookup [as oncomplete]\",\"filename\":\"dns.js\",\"line\":76,\"column\":26}]"
  message="getaddrinfo ENOTFOUND localhost localhost:8090" code="ENOTFOUND" errno="ENOTFOUND"
  syscall="getaddrinfo" hostname="localhost" host="localhost" port="8090"]
  [versions@1 release="3.3.0 InDev"] T.SF.Client.WSClient: socket error getaddrinfo ENOTFOUND localhost localhost:8090
```

VERIFIED — the only thing `be[3024]` logs is this error:

```
$ grep -o 'be\[3024,[a-z]*\]: .\{0,40\}' /tmp/messages | sed 's/[0-9]//g' | sort | uniq -c
    262 be[,warning]: [@ frames="[{\"method\":\"errnoExcepti...
```

VERIFIED — distinct `T.SF.*` messages in the log, all from the same process:

```
$ grep -o 'T\.SF\.Client\.[A-Za-z]*: [a-z ]*' /tmp/messages | sort | uniq -c | sort -rn
    749 T.SF.Client.WSClient: socket error getaddrinfo
     18 T.SF.Client.HTTPClient: could not parse
      4 T.SF.Client.NotificationsDispatcher: notification message being dropped here
```

---

## 1. Which client it is (VERIFIED)

The `be` process is PID **3024**, the Electron *renderer* running the parity skill as uid **2000 (`jibo-skill`)**:

```
$ tr '\0' ' ' < /proc/3024/cmdline    # (head)
/usr/bin/electron/electron --type=renderer --no-sandbox --lang=en-US --node-integration=true --hidden-page ...
$ ls -l /proc/3024/cwd
/proc/3024/cwd -> /opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity
$ awk '/^Uid:/{print}' /proc/3024/status
Uid:  2000  2000  2000  2000
```

`T.SF.Client` is the logger root of **`jibo-client-framework`** (`SF.Client`), and `WSClient` is that package's
WebSocket client:

```
$ grep -n "new jibo_log_1.Log" node_modules/jibo-client-framework/lib/jibo-client-framework.js
877: exports.default = new jibo_log_1.Log('SF.Client');
761: const log = log_1.default.createChild('WSClient');
782:             log.warn('socket error', err);
```

Line 782 is literally the failing line. Which `WSClient` instance? The URL is the giveaway — `localhost:8090/events`
and `/vad` are only built in one place:

```
$ grep -rIn "ws://" --include=*.js node_modules | grep -v aws-sdk
./@jibo/jetstream-client/lib/jetstream-client.js:408:  this.eventWS = new jibo_client_framework_1.WSClient(`ws://${this.options.hostname}:${this.options.port}/events`);
./@jibo/jetstream-client/lib/jetstream-client.js:420:  this.vadWS   = new jibo_client_framework_1.WSClient(`ws://${this.options.hostname}:${this.options.port}/vad`);
```

Their host/port come from the jetstream plugin in stock `jibo`:

```
$ sed -n '7778,7784p' node_modules/jibo/lib/jibo.js
        const record = Runtime_1.default.instance.records.find(record => (record.name === 'jetstream'));
        ...
            this.api.init({
                hostname: 'localhost',
                port: record.port
            })
```

So **the `be` hard-codes `hostname: 'localhost'` and takes the port from the registry's `jetstream` record**:

```
$ curl -s http://127.0.0.1:8181/registry | tr ',' '\n' | grep -A2 jetstream
{"name":"jetstream","host":"127.0.0.1","port":8090,"path":"/","ttl":21,"tls":""}
```

VERIFIED — the two sockets are the only `WSClient`s in this process that log **only** the framework's own
`socket error`: `NotificationsDispatcher` attaches its own handler (`log.warn('notification socket error', ...)`),
`RemoteClient` attaches a `message`/`reopen` handler, and jetstream attaches neither an `error` handler nor a
`notification socket error` companion — which is exactly the log shape observed (one `socket error` line per
attempt, no companion line).

**Conclusion (VERIFIED):** the failing client is `@jibo/jetstream-client` inside the `be` renderer, constructed by
the stock `jibo` JetstreamPlugin with `hostname: 'localhost'`, `port: 8090`.

---

## 2. Why `getaddrinfo` failed for `localhost` (VERIFIED)

### 2.1 It is *not* an IPv6 / `::1` problem, and *not* an nsswitch problem

```
$ cat /etc/hosts /etc/nsswitch.conf        # robot
127.0.0.1       localhost
127.0.1.1       Moth-Radius-Breazeal-Felt
...
192.168.1.182 api.jibo.com
192.168.1.182 api-socket.jibo.com
...
hosts:          files dns

$ ping -c1 localhost
PING localhost (127.0.0.1) 56(84) bytes of data.
64 bytes from localhost (127.0.0.1): icmp_seq=1 ttl=64 time=0.077 ms

$ node -e "require('dns').lookup('localhost',function(e,a,f){console.log(e,a,f)})"        # robot node v6.9.2
null 127.0.0.1 4
$ node -e "require('dns').lookup('localhost',{family:6},function(e,a,f){console.log(e,a,f)})"
{ Error: getaddrinfo ENOTFOUND localhost ... } undefined undefined

$ ELECTRON_RUN_AS_NODE=1 /usr/bin/electron/electron -e "var d=require('dns');d.lookup('localhost',function(e,a){console.log(e,a)})"
null 127.0.0.1            # electron 1.4.3 / node 6.5.0, same binary as the renderer
```

So `localhost` resolves fine for root-ish, `/etc/hosts`-reading processes, including the very Electron binary the
renderer runs on. The family-6 failure mode exists but is **not** what the `be` is hitting (see 2.2: family 0 and 4
fail there too).

### 2.2 Inside the live renderer, *every* family fails

Measured **inside PID 3024** over the Chrome DevTools Protocol (`--remote-debugging-port=9222`, target
`file:///opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/index.html`):

```js
// Runtime.evaluate in the be renderer, BEFORE the fix
require('dns').lookup('localhost', ...)             -> 'getaddrinfo ENOTFOUND localhost'
require('dns').lookup('localhost', {family:6}, ...) -> 'getaddrinfo ENOTFOUND localhost'
require('dns').lookup('localhost', {family:4}, ...) -> 'getaddrinfo ENOTFOUND localhost'
```

and the reason falls out immediately:

```js
require('fs').readFileSync('/etc/hosts')            -> "ERR EACCES: permission denied, open '/etc/hosts'"
require('fs').readFileSync('/etc/nsswitch.conf')    -> "# /etc/nsswitch.conf\npasswd: files..."   (readable)
require('dns').lookup('api.jibo.com', ...)          -> '192.168.1.135'   (!)
require('dns').lookup('google.com', ...)            -> '142.250.217.238' (DNS works)
```

VERIFIED, `/var/etc/hosts` (the target of the `/etc/hosts` symlink) is root-only:

```
$ ls -l /var/etc/hosts
-rwx------ 1 root root 614 Sep 10 15:11 /var/etc/hosts
$ readlink -f /etc/hosts
/var/etc/hosts
```

Because the renderer runs as uid 2000, the `files` NSS module cannot read the hosts file, resolution falls through
to `dns` (nsswitch: `hosts: files dns`), and **`localhost` is not a DNS name** → `EAI_NONAME` → Node's
`getaddrinfo ENOTFOUND localhost`. `api.jibo.com` returning `192.168.1.135` (the LAN resolver's answer) instead of
the `192.168.1.182` written in `/etc/hosts` is the same fact from the other side: **the renderer was not reading the
repointed hosts file at all.**

**Root cause (VERIFIED):** `/var/etc/hosts` mode `700 root:root` + renderer uid `2000` ⇒ no `files` lookup in the
`be` process ⇒ `localhost` unresolvable ⇒ the jetstream `WSClient` retry loop logs `getaddrinfo ENOTFOUND
localhost localhost:8090` forever.

UNKNOWN: when the mode changed to `700`. The file's mtime is `Sep 10 15:11` (local) while its content is byte-identical
to the 2026-09-08 00:56:54 UTC repoint output, and no `.phx-bak-20260910-*` exists — i.e. the content was rewritten
(same bytes) *without* the repoint script's backup step. INFERRED: some out-of-band write today re-created the file
with mode `0700`. A busybox `sed -i` on this robot does **not** change the mode (tested: a 777 file stayed 777), so
the repoint script's own hosts edit is not the mechanism.

---

## 3. What *should* be on `localhost:8090` (VERIFIED: the on-robot jetstream service — and it is there)

```
$ busybox netstat -tln
tcp        0      0 0.0.0.0:8090            0.0.0.0:*               LISTEN
$ grep -i ":1F9A" /proc/net/tcp | head -1
/proc/net/tcp: 31: 00000000:1F9A ... 2938097 1 c877cac0 100 0 0 10 0 jibo-jetstream-service 2325
```

`0x1F9A` = 8090, owner `jibo-jetstream-service` PID 2325. It completes a WebSocket handshake:

```
$ node -e "var WS=require('./node_modules/ws'); ... "    # plain node v6.9.2, skill's ws 3.3.3
ws://localhost:8090/events => OPEN
ws://127.0.0.1:8090/events => OPEN
```

So the expectation `localhost:8090` is **correct, not stale**: the robot's own jetstream service is listening there.
Nothing needs to be added to Phoenix for this; Phoenix's role in this path is the *hub* on `:9000` (see
`repoint-robot.sh --hub-port`). VERIFIED: nothing in the Phoenix repo serves 8090, and nothing needs to.

SECONDARY, VERIFIED: the native notification socket is a different process (`jibo-server-service` PID 31924, root,
reads `/etc/hosts` fine) and was unaffected by this. During this session it was logging
`P.NotificationSubsystem: No...` every ~15 s because **Phoenix's classic server is not currently running** — VERIFIED:
`curl -sk https://192.168.1.182/healthcheck` from the robot → exit 7 / HTTP `000`, and nothing on this machine
listens on `:443` (only `:9000`, the hub, does). Out of scope here, flagged because it is the next thing you will see
in the log.

---

## 4. The fix (applied to the robot)

Chosen fix: **restore the hosts file's readability** — the least invasive change that removes the cause rather than
the symptom, and it also repairs every other hostname-based lookup in the renderer.

```
$ STAMP=$(date -u +%Y%m%d-%H%M%S)                     # 20260910-192703
$ ls -l /var/etc/hosts
-rwx------ 1 root root 614 /var/etc/hosts
$ cp -p /var/etc/hosts /var/etc/hosts.phx-bak-$STAMP
$ chmod 644 /var/etc/hosts
$ ls -l /var/etc/hosts /var/etc/hosts.phx-bak-20260910-192703
-rw-r--r-- 1 root root 614 /var/etc/hosts
-rwx------ 1 root root 614 /var/etc/hosts.phx-bak-20260910-192703
$ busybox su -s /bin/sh -c 'cat /etc/hosts >/dev/null && echo YES || echo NO' jibo-skill
YES
```

* Content unchanged (byte size 614 before and after; no line edited).
* Backup: **`/var/etc/hosts.phx-bak-20260910-192703`**.
* Reversible with `chmod 700 /var/etc/hosts` (or by restoring the backup).
* `644` matches the sibling `/var/etc/hostname` (`-rw-r--r-- root`) and is the standard `/etc/hosts` mode. It leaks
  nothing new: every `hosts.phx-bak-*` file in that directory is already mode `777`.

Repo-side hardening (worktree `w3/localhost`): `scripts/parity-robot/repoint-robot.sh` now `chmod 644`s the hosts
file after it rewrites it, with a comment explaining why readability is load-bearing there.

---

## 5. Verification — the error stops

### 5.1 Renderer resolution, after

```js
// Runtime.evaluate in PID 3024, AFTER the fix
require('fs').readFileSync('/etc/hosts')       -> "16 lines"
require('dns').lookup('localhost', ...)        -> '127.0.0.1'
require('dns').lookup('api.jibo.com', ...)     -> '192.168.1.182'   # the repointed Phoenix, not the DNS answer
```

### 5.2 Error line counts, comparable 60 s windows

| window (UTC) | `getaddrinfo ENOTFOUND localhost` lines | `be[3024]` lines |
|---|---|---|
| **before** 19:25:25 → 19:26:25 (60 s) | **117** (283 → 400) | 117 |
| **after** 19:27:19 → 19:28:19 (60 s) | **0** | 0 |
| **after, sustained** 19:27:04 → 19:29:59 (~3 min) | **0** | 0 |

The last error line in the log is `2026-09-10T19:27:03.899Z`; the `chmod` ran at `19:27:03Z`. At the sustained check the
hosts file was `-rw-r--r--` and the renderer still held its two ESTABLISHED sockets to 8090. Log volume fell from
~68.7 kB/60 s to 464 B/30 s (~76×).

### 5.3 The jetstream sockets are now actually connected

VERIFIED — two ESTABLISHED sockets owned by the renderer to port 8090 (`0x1F9A`), whereas there were none before:

```
/proc/net/tcp: 218: 0100007F:A25B 0100007F:1F9A 01 ... 2961103 2 ... electron --type=renderer
/proc/net/tcp: 140: 0100007F:A25F 0100007F:1F9A 01 ... 2961105 1 ... electron --type=renderer
```

(these are the `/events` and `/vad` sockets; before the fix there were zero renderer→8090 connections).

### 5.4 What did *not* change — do not over-claim the CPU

VERIFIED: the renderer's CPU did **not** drop. Same measurement method
(`/proc/3024/stat` utime+stime, 100 jiffies = 1 s-core):

| window | jiffies | ≈ % of one core |
|---|---|---|
| before, 60 s | 2377 | 39.6 % |
| after, 60 s | 2415 | 40.3 % |
| after, 30 s (later sample) | 1201 | 40.0 % |

The bug's cost was **log spam and a dead jetstream client**, not CPU. The `be` renderer burns ~40 % of a core
independently of this loop (it has done so since the process started on Sep 7 — `ps` shows 1898 min CPU, 49.4 %).
That is a separate defect worth its own task.

---

## 6. Assumptions, gaps, and what was deliberately not touched

UNKNOWN:
* The exact first occurrence of the spam. The rotated archives `/var/log/messages.{2,3}.gz` cannot be decompressed by
  this robot's busybox (`busybox gzip -dc <file>` emits 0 bytes and no error), so the oldest *readable* occurrence is
  `/var/log/messages.1` → `2026-09-10T19:15:00.041Z`. If the onset is real, it is 4 minutes after the hosts file's
  mtime (`15:11` local = `19:11Z`).
* Who/what set `/var/etc/hosts` to mode 700 (see §2).
* Whether the jetstream client (now connected) actually *does* anything useful on this robot — not exercised here.

Deliberately unchanged: `/tmp/messages*` / `/var/log/messages*` rotation, the `777` mode on the `hosts.phx-bak-*`
files, and anything belonging to the native notification path.

### Candidates for `docs/parity/tasks.json` / `DIVERGENCES.md` (not edited here)
1. **Robot deployment invariant:** `/etc/hosts` (→ `/var/etc/hosts`) must be readable by uid 2000. If it is not, the
   Electron `be` renderer silently loses *all* `/etc/hosts` resolution: `localhost` → `ENOTFOUND`, and
   `api.jibo.com`/`api-socket.jibo.com` → whatever the LAN DNS says (observed `192.168.1.135`) instead of the
   repointed Phoenix host. Any tool that writes that file must not create it `0600/0700`.
2. `repoint-robot.sh` should assert post-write that the hosts file is readable by `jibo-skill` (the `chmod 644` added
   here covers the script's own path only).
3. The `be` renderer's sustained ~40 % CPU is unexplained and unrelated to this bug.
4. The `hosts.phx-bak-*` backups in `/var/etc/` are mode `777` (world-writable) — hygiene.
5. The stock `jibo` jetstream plugin hard-codes `hostname: 'localhost'`; it would have been immune had it used the
   registry record's `host` (`127.0.0.1`) the way `NotificationsDispatcher` does. Patching stock vendor code was
   rejected as more invasive and non-persistent across skill updates.

---

## 7. Exact commands used (for replay)

```bash
# what owns the log line
grep -n "socket error" /opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/jibo-client-framework/lib/jibo-client-framework.js
sed -n '7778,7784p'    /opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/jibo/lib/jibo.js
grep -n 'ws://'        /opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jetstream-client/lib/jetstream-client.js

# the resolution probe, run inside the live renderer over CDP (port 9222)
node /tmp/cdp-eval.js "ws://127.0.0.1:9222/devtools/page/<id>" \
  '(function(){var d=require("dns");window.__p={};d.lookup("localhost",function(e,a){__p.l=e?e.message:a});
    try{__p.hosts=require("fs").readFileSync("/etc/hosts","utf8").length}catch(e){__p.hosts="ERR "+e.message};
    return "go"})()'

# the fix
STAMP=$(date -u +%Y%m%d-%H%M%S); cp -p /var/etc/hosts /var/etc/hosts.phx-bak-$STAMP; chmod 644 /var/etc/hosts

# before/after counting
C0=$(grep -c "getaddrinfo ENOTFOUND localhost" /tmp/messages); sleep 60
C1=$(grep -c "getaddrinfo ENOTFOUND localhost" /tmp/messages); echo "delta=$((C1-C0))"
```
