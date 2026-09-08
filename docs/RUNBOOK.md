# Runbook: stand up a server and point a robot at it

A linear procedure that ends with a real Jibo talking to your own Phoenix server.
Every step here has been run against real hardware. For reference material rather
than a procedure, see [Operations](OPERATIONS.md).

**What you need**

- A Linux host on the same network as the robot. This guide calls it the *server*.
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

## 3. Create a CA and a server certificate

The robot's native client verifies the certificate chain **and** the hostname, and
it only trusts CAs in its OpenSSL store. So the certificate must carry Subject
Alternative Names for both hostnames from step 2. A certificate for `localhost`
will be rejected no matter what you install.

```bash
mkdir -p ~/.local/share/phoenix/moth && cd ~/.local/share/phoenix/moth

# A CA. Keep ca.key private; it is what the robot will trust.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ca.key -out ca.crt -subj "/CN=Phoenix development CA"

# A server key and request.
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost"

# The SANs are the part that matters. Use YOUR region and server IP.
cat > server.ext <<'EXT'
subjectAltName=DNS:localhost,DNS:api.jibo.com,DNS:api-socket.jibo.com,IP:127.0.0.1,IP:192.168.1.182
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EXT

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -extfile server.ext -out server.crt
chmod 600 server.key server.crt ca.key
```

Check it before continuing:

```bash
openssl x509 -in server.crt -noout -ext subjectAltName
```

Both `<region>.jibo.com` and `<region>-socket.jibo.com` must appear.

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
export PHOENIX_ROBOT_TLS_CERT=~/.local/share/phoenix/moth/server.crt
export PHOENIX_ROBOT_TLS_KEY=~/.local/share/phoenix/moth/server.key
bash scripts/run-compose-stack.sh
```

Confirm it is listening and answering:

```bash
ss -ltn | grep ':443'
curl -sk -o /dev/null -w '%{http_code}\n' https://192.168.1.182/healthcheck   # expect 200
```

If binding fails with a privileged-port error, step 4 did not take effect.

## 6. Point the robot at the server

One script does both halves: it redirects the hostnames and installs your CA into
the robot's trust store so the redirect is actually accepted.

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

It only ever changes data — hosts entries, config files and certificates. It never
patches robot code, so the robot stays a genuine unmodified client.

## 7. Verify

The robot's own log is the authority. The native client retries every 15 seconds,
so give it half a minute.

```bash
# The robot fetches from your server using ITS OWN trust store. No -k.
ssh root@<robot> 'curl -s -o /dev/null -w "%{http_code} via %{remote_ip}\n" https://api.jibo.com/healthcheck'

# The notification transport.
ssh root@<robot> 'grep NotificationSubsystem /var/log/messages | tail -5'
```

You are looking for `established connection to server`, followed by **silence** —
the retry timer only logs when it is disconnected, so quiet means connected.

> A `curl` or Node TLS probe on the robot does **not** prove the native path works.
> Node ships its own CA bundle and ignores the OpenSSL store the native service uses.
> Trust the service log.

## 8. When it does not work

| Symptom in `/var/log/messages` | Cause | Fix |
|---|---|---|
| `Could not request robot token: SSL connection unexpectedly closed` | Certificate rejected, or nothing listening on 443 | Check SANs (step 3) and that the CA is installed (step 6) |
| `Could not establish connection to server` | Hostname resolves somewhere wrong, or no server there | `ssh root@<robot> 'ping -c1 <region>-socket.jibo.com'` should show your server |
| Nothing at all about notifications | The native service is not running | `ssh root@<robot> 'ps | grep jibo-server-service'` |
| Connects, then reconnects every ~2 minutes | Server is not answering the client's pings | The client disconnects after 120s without traffic |

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

## What this does not do

Getting the robot connected is not the same as a fully working robot.

- **Conversation** needs the robot's hub target pointed at the server as well. See
  [Operations](OPERATIONS.md) for `point-robot-at-phoenix.sh` and the hub port.
- **A robot that never paired with Phoenix** has no account here. Pair it through
  the portal, or adopt an already-credentialed robot with
  `scripts/adopt-existing-robot.mjs`.
- **Public exposure** over the internet is a different setup — DNS, a real
  certificate and a reverse proxy. [Operations](OPERATIONS.md) covers it.
- Microphone/wake-word and physical-ring behavior are **not verified** by this
  procedure, and are still open work in the parity ledger.
