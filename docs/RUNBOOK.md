# Runbook: stand up a server and point a robot at it

A linear procedure that ends with a real Jibo talking to your own Phoenix server.
These are the steps used to bring up real robots; the capture records from those
runs are under [`parity/evidence/`](parity/evidence/). For reference material rather
than a procedure, see [Operations](OPERATIONS.md).

> **Internet launch gate:** read [SECURITY.md](SECURITY.md) and
> [DEPLOYMENT.md](DEPLOYMENT.md) before exposing a hostname. The commands in the
> early sections are suitable for a private LAN only; the production baseline is
> loopback-bound services behind an nginx TLS edge. Never publish ports 9000 or
> 9003–9014 directly and never use the development auth/secret defaults.

**What you need**

- A Linux host to run Phoenix on. This guide calls it the *server*. Steps 1–9
  assume it shares a network with the robot; step 10 covers hosting it on the
  internet instead.
- Node.js ≥ 20 on the server.
- For an Internet deployment: Docker Compose, nginx, a host/cloud firewall, and
  certificates for the portal, Classic, socket, and optional hub names. Do not
  use a public reverse proxy as a substitute for the robot's private CA trust.
- `root` SSH access to the robot, key-based. (Stock robots ship with `root:jibo`;
  copy your key over with `ssh-copy-id` so the scripts can run unattended.)
- The robot powered on and on your WiFi.

Throughout, `192.168.1.182` is the server and `root@moth-....jibo` is the robot.
Substitute your own.

---

## 1. Install

```bash
git clone <this repo> phoenix && cd phoenix
npm install
cp .env.example .env
chmod 0600 .env
# Fill HUB_TOKEN_SECRET, ETCO_account_internalPeerToken, OTA_PUBLIC_URL,
# CLASSIC_PUBLIC_URL, and PHOTO_PUBLIC_URL. Generate the two secrets separately.
# Keep DISABLE_AUTH=false, ETCO_account_secureCookies=true,
# and PHOENIX_BIND_HOST=127.0.0.1.
```

Generate the hub secret with `openssl rand -base64 48`; do not paste it into a
ticket or commit it. The Compose launcher refuses to start when required values
are missing. The native launcher also defaults to loopback and must be fronted by
TLS for any browser or robot outside the host.

## 2. Learn what the robot expects

This is the step people skip, and it determines everything that follows. The robot
does **not** ask you where its cloud is. It builds the hostname itself from a
`region` string stored on the robot, and it hardcodes port 443.

Read the region:

```bash
ssh root@<robot> 'curl -s http://127.0.0.1:8181/registry' | tr ',' '\n' | grep -A2 system-manager
# note the system-manager port, usually 8585, then:
ssh root@<robot> 'curl -s -H "Authentication: foobar" http://127.0.0.1:8585/credentials'
```

The `region` field (commonly `api`) gives you two hostnames the robot will insist on:

| Purpose | Hostname | Port |
|---|---|---|
| Cloud API, notification token | `<region>.jibo.com` | 443 |
| Notification WebSocket | `<region>-socket.jibo.com` | 443 |

Both are fixed in the robot's native code. You cannot configure them away — you
redirect them (step 5) and serve a certificate that matches them (step 3).

> The `/credentials` response also contains the robot's access key and secret.
> Don't paste it anywhere. You only need `region`.

## 3. Tell the server which regions to serve

You do not create certificates by hand. The server generates a CA and a serving
certificate on its first start and reuses them afterwards.

It only needs to know which regions to cover, because it cannot ask the robot at
startup. The default is `api`, which is what a stock robot reports. If step 2
showed something else, or you want one server to accept robots with different
regions, set:

```bash
export PHOENIX_TLS_REGIONS=api,someotherregion
```

Optionally add internet-facing names with `PHOENIX_TLS_EXTRA_NAMES=hub.example.com`.

Certificates land in `~/.local/share/phoenix/tls` (override with
`PHOENIX_TLS_HOME`), and every local IP address is included automatically. To
use your own certificate instead, set `PHOENIX_ROBOT_TLS_CERT` and
`PHOENIX_ROBOT_TLS_KEY`; explicit paths always win.

## 4. Choose the private service bind and TLS edge

The robot hardcodes 443, but the Phoenix services should not bind it directly in a
public deployment. Use nginx as the single TLS edge and keep the native/Compose
backends on loopback. `scripts/run-compose-stack.sh` now defaults to:

```bash
PHOENIX_BIND_HOST=127.0.0.1
```

For a private-LAN-only experiment, an operator may set `PHOENIX_BIND_HOST` to a
specific private interface after adding a source firewall rule. Do not set it to
`0.0.0.0` on an Internet host. The separate authenticated robot launcher can own
443 directly only on a dedicated address and only with its own firewall/TLS policy;
do not run it on the same address as nginx.

## 5. Start the server

The native runner's listeners are loopback-only by default. Start it behind the
nginx configuration from [DEPLOYMENT.md](DEPLOYMENT.md):

```bash
PHOENIX_BIND_HOST=127.0.0.1 bash scripts/run-compose-stack.sh
```

On the first start it creates the CA and certificate described in step 3 and
logs that it did so.

Confirm only the private backends are listening and answering:

```bash
ss -ltn | grep -E ':(9000|9003|9004|9005|9006|9007|9008|9009|9010|9011|9012|9013|9014)'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9012/healthcheck   # expect 200
```

If nginx is the edge, verify the public HTTPS name separately; do not use `curl
-k` as proof of a trusted robot path. Keep TCP 80/443 as the only public
application ports.

## 6. Point the robot at the server

One run does everything on the robot:

* redirects `<region>.jibo.com` and `<region>-socket.jibo.com` to the server,
* installs the CA **the server generated** into the robot's trust store, so the
  redirect is actually accepted,
* patches every installed Node `jibo-server-client` HTTP transport and installs
  its CA bundle, with backups and a guarded revert,
* points Jetstream's conversation hub at the server and restarts it, so speech
  reaches Phoenix too (`--hub-port`, default 9000; `--no-hub` to skip),
* proves possession of an already-paired robot using the credentials in its
  own `/var/jibo/credentials.json`, without importing an original-cloud user
  account.

### Claim an already-paired robot into a new Phoenix account

The customer must first create and sign into their Phoenix account. In the
portal, open **Robots → Claim an existing Jibo**, then generate and copy its
single command. It includes a 15-minute, one-time claim code, for example:

```bash
scripts/parity-robot/repoint-robot.sh \
  --robot root@<robot-ip> --phoenix <public-server-ip> \
  --claim-code <portal-code> \
  --adoption-url https://<portal-origin>/api/adopt-robot --yes
```

The SSH script streams the robot secret directly to the HTTPS adoption request;
it never prints or stores that secret locally. The code is stored server-side
only as a hash, expires after 15 minutes, and is consumed only after the robot
secret and ownership link both succeed. A retry with the same code is rejected.
The resulting loop has exactly the new Phoenix account and robot as accepted
members. It keeps the robot's existing credentials and loop ID, but does **not**
import the former cloud account, people, passwords, sessions, or tokens.

If an older repoint run registered the robot before ownership linking existed,
run this claim command after the customer signs up: it idempotently converts
that unclaimed bootstrap loop. A robot already linked to a different real
Phoenix account is refused rather than silently transferred; an administrator
must explicitly handle that case.

Set `ETCO_account_repointHost` to the public IP the robot can reach before
launch. The portal displays that value in the command. Do not derive it from an
HTTP Host header or enter an internal/container address.

`scripts/import-household-snapshot.mjs` is a separate, operator-only migration
tool. It can stage a captured local KB root/member snapshot and public member
profiles after extensive conflict checks, but it deliberately carries household
identity data. Do **not** run it for the customer-account claim workflow above;
use it only when an operator has separately chosen to migrate that legacy
household and reviewed the staged snapshot.

Add `--classic-url https://<classic-host>` when the robot-facing Classic service
is behind an nginx TLS vhost and the robot's region configuration must be updated.
The `http://<server>:9012` form is for an isolated LAN test only and must never be
used on the Internet. A TLS deployment with hosts entries already covering the
region does not need this option — rewriting it unnecessarily can break it.

Before writing anything it confirms that the CA it is about to install genuinely
verifies the certificate the running server is presenting, under the hostname the
robot will use. If the server is loading a different certificate directory, it
says so and stops rather than installing trust for a CA the server never uses —
which would leave the robot rejecting the server for reasons that look like
anything but that.

```bash
./scripts/parity-robot/repoint-robot.sh \
  --robot root@<robot> --phoenix 192.168.1.182 --dry-run
```

Read the plan it prints. It refuses to continue if the host is not a Jibo, if the
hosts file is not writable, if your certificate lacks the required SANs, or if the
robot cannot reach the server. When the plan looks right, drop `--dry-run`.

Two things worth knowing about what it does:

- **Hosts.** `/etc/hosts` on a Jibo is a symlink to `/var/etc/hosts`, on a writable
  partition, so this survives reboot with no remount. The script writes a marked
  block and comments out older conflicting entries — many robots already have
  `<region>.jibo.com` pinned to `127.0.0.1` to stop the dead cloud from burning CPU
  on retries, and the resolver takes the first match.
- **Trust.** On a robot that has been configured by hand, `/etc/ssl/certs` is often
  a *bind mount* over the real directory. Writing through it appears to work and is
  silently lost on reboot. The script detects this and installs into the real
  directory underneath, which persists.

The Node CA backport modifies robot client code. Its upstream source pin and
patch hash are checked for every nested copy before installation; an unknown
version stops the patch operation. API and BE logic remain those of the original
client. The deployment records this qualification in its hardware evidence.

## 7. Verify

The robot's own log is the authority. The native client retries every 15 seconds,
so give it half a minute.

```bash
# The robot fetches from your server using ITS OWN trust store. No -k.
ssh root@<robot> 'curl -s -o /dev/null -w "%{http_code} via %{remote_ip}\n" https://api.jibo.com/healthcheck'

# The notification transport.
ssh root@<robot> 'grep NotificationSubsystem /var/log/messages | tail -5'
```

You are looking for `established connection to server`. Confirm the current
connection with `netstat -tn` or the native Notification status WebSocket
(`/server/notifications/status`, status `1`). Logs rotate; silence alone does
not establish a connection.

> A `curl` or Node TLS probe on the robot does **not** prove the native path works.
> Node ships its own CA bundle and ignores the OpenSSL store the native service uses.
> Trust the service log.

## 8. When it does not work

| Symptom in `/var/log/messages` | Cause | Fix |
|---|---|---|
| `Could not request robot token: SSL connection unexpectedly closed` | Certificate rejected, or nothing listening on 443 | Check SANs (step 3) and that the CA is installed (step 6) |
| `Could not establish connection to server` | Hostname resolves somewhere wrong, or no server there | `ssh root@<robot> 'ping -c1 <region>-socket.jibo.com'` should show your server |
| Nothing at all about notifications | Logs may have rotated, or the service may not be running | `ssh root@<robot> 'ps | grep jibo-server-service'` |
| Connects, then reconnects every ~2 minutes | Server is not answering the client's pings | The client disconnects after 120s without traffic |

The Node clients have a separate trust path. The repoint installer patches every
nested `jibo-server-client` copy to load `lib/http/phoenix-ca.pem`, using the robot's
system CA bundle with Phoenix's CA added. `JIBO_EXTRA_CA_CERTS` can override that
path. Verification stays on; a configured but unreadable file is an error. Node 6
replaces its built-in roots when `ca` is supplied, so use the complete bundle.
Restart the processes using the package after installation; existing agents are
cached. See [the client divergence](./DIVERGENCES.md#robot-deployment-client).

Also confirm that a BE skill is running. A healthy hub and Notification socket do
not establish that the robot's experience has started. On a developer-mode robot,
`GET http://127.0.0.1:8779/skill/list` reports each skill's `running` state. Start
the intended installed skill through `POST http://127.0.0.1:8686/run` with
`{"dirName":"<installed package name>"}`. Moth's selected validation package is
`@be/phoenix-parity-11-0-1`. Starting it restored a clock turn before the Node CA
patch; do not attribute that failure to TLS merely because TLS errors also appear.

Two failure modes worth calling out because they look like something else:

- **Wrong SANs** present as a TLS failure that looks like a trust problem. It is not
  — the chain can be perfect and still fail hostname verification.
- **A stale hosts entry** silently wins over a new one. Check with `ping`, which uses
  the resolver, rather than reading the file.

## 9. Undoing it

```bash
./scripts/parity-robot/repoint-robot.sh --robot root@<robot> --revert
```

This removes the hosts block and the CA. Every file the script edited also has a
timestamped `.phx-bak-*` backup beside it on the robot.

---

## 10. Hosting on the internet instead of a LAN

The complete VPS/home-server deployment, nginx front door, Cloudflare design
options, port map, private-CA procedure, firewall rules, backups, upgrades,
and verification checklist are maintained in
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md). Read that guide before exposing any
Phoenix listener to the internet.

The concise launch gate and common failure modes are in
[`docs/SECURITY.md`](SECURITY.md). It is part of this runbook: use its external
port scan, header checks, backup procedure, and rollback checklist before sharing
the DNS names.

The short version is:

- The robot's native `<region>.jibo.com` and `<region>-socket.jibo.com` names
  and port 443 are not configurable by public DNS. They require an operator CA
  installed on the robot and a certificate with those names.
- The portal and other names you own can use a public certificate behind nginx
  (and optionally Cloudflare). Cloudflare's normal proxy cannot proxy the
  stock `jibo.com` names because they are not in your zone.
- TLS is not authentication. Keep Classic on its dedicated TLS hostname and
  source allow-list/VPN where possible, keep internal ports private, set
  `DISABLE_AUTH=false`, use a real hub secret, and keep the portal admin path on
  an operator network.

Do not duplicate the deployment procedure here; update `docs/DEPLOYMENT.md`
when the hosting topology or code contract changes.

## What this does not do

Getting the robot connected is not the same as a fully working robot.

- **A robot that never paired with anything** has no credentials to prove
  possession. Pair it through the portal's QR/OOBE flow first. A robot that
  paired with the original Jibo cloud instead uses the signed-in claim command
  and its existing `/var/jibo/credentials.json`.
- Microphone/wake-word behaviour and the physical ring are outside this
  procedure: it establishes the cloud connection. Step 7's checks are what
  confirm the robot is talking to your server.
