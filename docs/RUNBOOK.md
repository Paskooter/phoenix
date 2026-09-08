# Runbook: stand up a server and point a robot at it

A linear procedure that ends with a real Jibo talking to your own Phoenix server.
Every step here has been run against real hardware. For reference material rather
than a procedure, see [Operations](OPERATIONS.md).

**What you need**

- A Linux host to run Phoenix on. This guide calls it the *server*. Steps 1–9
  assume it shares a network with the robot; step 10 covers hosting it on the
  internet instead.
- Node.js ≥ 20 on the server.
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
```

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

## 4. Let the server bind port 443

The robot hardcodes 443, and 443 is privileged. Lower the unprivileged port floor:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443
echo 'net.ipv4.ip_unprivileged_port_start=443' | sudo tee /etc/sysctl.d/90-phoenix.conf
```

Alternatively redirect 443 to an unprivileged port
(`sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 29443`)
and set `PHOENIX_ROBOT_ENTRYPOINT_PORT` to match. Avoid `setcap` on the Node binary:
it applies to every Node process and is lost on upgrade.

## 5. Start the server

443 on all interfaces is the default, so the robot on your LAN can reach it.

```bash
bash scripts/run-compose-stack.sh
```

On the first start it creates the CA and certificate described in step 3 and
logs that it did so.

Confirm it is listening and answering:

```bash
ss -ltn | grep ':443'
curl -sk -o /dev/null -w '%{http_code}\n' https://192.168.1.182/healthcheck   # expect 200
```

If binding fails with a privileged-port error, step 4 did not take effect.

## 6. Point the robot at the server

One run does everything on the robot:

* redirects `<region>.jibo.com` and `<region>-socket.jibo.com` to the server,
* installs the CA **the server generated** into the robot's trust store, so the
  redirect is actually accepted,
* patches every installed Node `jibo-server-client` HTTP transport and installs
  its CA bundle, with backups and a guarded revert,
* points Jetstream's conversation hub at the server and restarts it, so speech
  reaches Phoenix too (`--hub-port`, default 9000; `--no-hub` to skip),
* registers the robot in the Phoenix account store using its own existing
  credentials, so a robot that paired with the original Jibo cloud years ago
  works here without re-running OOBE (`--no-adopt` to skip).

The robot's secret key is streamed straight from the robot into the local
adopter without being printed in a command line or log. The private account
store retains the credentials needed for authentication. Adoption is idempotent:
an existing loop is reused; an account missing its loop can be repaired.

Add `--classic-url http://<server>:9012` for a plain-HTTP deployment, which
rewrites every `region_config.json`. A TLS deployment does not need it — the
hosts entries already cover it — and rewriting would break it.

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
cached. See [the client divergence](../DIVERGENCES.md#robot-deployment-client).

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

Everything above assumes the robot and the server share a network. Putting the
server on the public internet works, but one constraint drives the whole design
and surprises people:

> **You cannot get a publicly trusted certificate for `<region>.jibo.com`,**
> because you do not own `jibo.com`. And you cannot change that hostname — the
> robot's native client builds it from its region and hardcodes the `.jibo.com`
> suffix and port 443.

So the robot's cloud API and notification socket need **your own CA installed on
the robot, whether you are on a LAN or on the internet**. Public hosting does not
remove that step. What changes is only *where the names point* and *how traffic
reaches you*.

It helps to split the hostnames into two groups:

| Group | Hostnames | Certificate | Why |
|---|---|---|---|
| **Baked into the robot** | `<region>.jibo.com`, `<region>-socket.jibo.com` | **Your own CA**, installed on the robot | You cannot own the name, so no public CA will issue for it |
| **Chosen by you** | hub, web portal | A normal public certificate (Let's Encrypt) | These hostnames are configuration, not hardcoded |

### The two ways to do it

**A. LAN (steps 1–9 above).** The robot reaches the server by private IP. Nothing
is exposed to the internet. This is the right choice for a robot in your home, and
it is what the rest of this runbook assumes.

**B. Internet.** Use this when the robot is somewhere the server is not.

1. **Include your public names in the server's certificate.** Set them before
   the server starts:
   ```bash
   export PHOENIX_TLS_EXTRA_NAMES=hub.example.com
   ```
   The `.jibo.com` names are still signed by your own CA. Only the names you own
   can also be served by a public certificate, via a reverse proxy.

2. **Make port 443 reachable.** Forward TCP 443 from your router or open it in the
   cloud firewall. The port is not negotiable; the robot hardcodes it.

3. **Point the robot at your public address.** Run the repoint script with
   `--phoenix <your-public-ip>`. It writes the same hosts entries, just with a
   routable address. Public DNS is not involved and cannot help you here: those
   names belong to someone else.

4. **Restrict who can reach it.** The entrypoint is now internet-facing. At
   minimum, firewall 443 to the robot's source address if it is static. Read the
   authentication caveats in [Operations](OPERATIONS.md) before exposing it —
   several Classic routes still rely on network trust, so "it is behind TLS" is
   not the same as "it is authenticated".

5. **Optionally give the hub and portal real certificates.** Those hostnames *are*
   configurable, so they can sit behind a normal reverse proxy with Let's Encrypt.
   [Operations](OPERATIONS.md) has a worked Caddy configuration.

### A dynamic address

If your public IP changes, the hosts entries the robot holds go stale and it
silently stops connecting. Either use a static address, or re-run the repoint
script when the address changes — it is idempotent and replaces the managed block
in place.

## What this does not do

Getting the robot connected is not the same as a fully working robot.

- **A robot that never paired with anything** has no credentials to adopt. Pair it
  through the portal's QR flow first; the script adopts a robot that already has
  `/var/jibo/credentials.json`, which includes any robot that paired with the
  original Jibo cloud.
- Microphone/wake-word and physical-ring behavior are **not verified** by this
  procedure, and are still open work in the parity ledger.
