# Phoenix full-stack deployment on a VPS or home server

This is the deployment guide for the **entire** Phoenix stack: the hub, parser,
history, data, skills, OTA, account/portal, and Classic entrypoint. It is not a
portal-only hosting guide.

The primary deployment in this document is **Docker Compose behind nginx**. The
same public routing model can be used with the native launcher, but the
process-supervision and filesystem details differ. Commands that need a target
host, DNS, root privileges, nginx, Certbot, a GPU, or a real robot are marked
**operator step — not run in this documentation update**.

> **SECURITY WARNING — read before exposing Phoenix.** Internet exposure is
> genuinely risky in the current implementation. TLS is transport encryption,
> not authentication. The Classic robot-facing requests are not SigV4-verified;
> anyone who can reach its `POST /` can call the robot-facing OOBE operations.
> The hub's `DISABLE_AUTH` setting and the per-account/per-robot gates are the
> meaningful controls. Do not expose this stack with the development defaults,
> do not expose the admin surface, and do not assume that a trusted certificate
> makes an operation authorized. Prefer a VPN or a source-address firewall for
> robot traffic. If a public deployment is unavoidable, restrict every surface
> as described below and accept that this is not a hardened multi-tenant cloud.
> This warning is a code-backed limitation, not a generic nginx disclaimer:
> `DIVERGENCES.md:44-51`, `packages/classic/src/robotFace.js:4-23`, and
> `packages/ota/src/service.js:23-30` describe the current trust boundaries.

## 1. The plain answer about nginx

**No: nginx does not have to front every Phoenix service.**

- The Compose services speak HTTP to one another over the private Compose
  network. They do not need nginx between containers. The Compose file gives
  each service container port `8080` and connects them by service name
  (`docker-compose.yml:29-42`, `44-247`).
- nginx should be the **single internet-facing front door** for the public
  surfaces: the portal, the robot Classic API and notification socket, OTA
  package downloads, member-photo reads, and (if used) the hub WebSockets.
- The parser, history, data/lasso, skills, account, OTA, and Classic host ports
  should not be reachable directly from the internet. nginx cannot protect a
  port that is already published by Docker or a wildcard-bound Node process;
  the host/cloud firewall or container network policy must do that.
- In the recommended Compose mode, Classic and OTA are plain HTTP backends and
  nginx terminates TLS. The robot's Classic names use a private CA; the names
  you own can use a public certificate.
- The separate authenticated colocated launcher is different: it runs a TLS
  Classic server itself and defaults to `0.0.0.0:443`. nginx cannot bind the
  same address and port at the same time. That mode is covered in [Choosing a
  deployment mode](#3-choose-a-deployment-mode).

The repository's `deploy/nginx/phoenix.conf` deliberately covers only the portal
and explicitly excludes the robot Classic surface (`deploy/nginx/phoenix.conf:1-15`).
The server blocks in this guide add the missing full-stack front door.

## 2. Target architecture

For a single host, use this shape:

```text
                         internet / robot / browser
                                     |
                       TCP 80/443 only at the host edge
                                     |
                                  nginx
              +----------------------+----------------------+
              |                      |                      |
       portal.example.com     classic.example.com       hub.example.com
       public LE certificate  public LE certificate      public LE certificate
              |                      |                      |
      account :9011          Classic :9012          hub :9000 (WS)
              |              /member-photos -> account          |
              |              /ota/package -> OTA :9010          |
              +----------------------+----------------------+
                                     |
                         private Docker/network boundary
                                     |
 parser :9005 · history :9006 · lasso :9007 · skills :9003/:9004/:9008/:9009
 example :9013 · template :9014 · account :9011 · OTA :9010 · Classic :9012
                                     |
                          external private ASR URL
                              Parakeet :6972
```

The `classic.example.com` alias is optional but useful. It gives browsers a
publicly trusted origin for member photos and OTA package URLs while the robot
continues to use its baked-in `<region>.jibo.com` names. If you do not create
that alias, set the public URL variables to the robot-facing name and expect
ordinary browsers to distrust its private-CA certificate.

The Classic entrypoint is the robot's single AWS-JSON front door. It dispatches
lightweight Classic services in-process and proxies OOBE/account/loop/settings
to Account and Update operations to OTA (`packages/classic/src/index.js:1-7`,
`packages/classic/src/index.js:294-300`). Its notification WebSocket is on the
same server (`packages/classic/src/index.js:347-445`). Do not put the portal
hostname in front of robot `POST /`; the portal root is an HTML page and the
robot request belongs to Classic.

## 3. Choose a deployment mode

### Recommended: Docker Compose plus nginx

Use this for a VPS or a home server that needs the complete independently
started service set and one public TLS front door.

- It starts the 13 services declared in `docker-compose.yml`.
- Internal service discovery uses Compose names such as `account:8080`,
  `ota:8080`, `parser:8080`, and `lasso:8080`.
- nginx owns host ports 80/443; the Compose host ports remain private behind a
  firewall.
- The account store and other durable files can remain on the host because the
  Compose runtime bind-mounts `./packages` at `/phoenix/packages`
  (`docker-compose.yml:29-42`). This is a bind mount, not an automatically
  managed database volume; back it up explicitly.
- The image is built from `scripts/Dockerfile`, which uses Node 20, ffmpeg, and
  `npm ci` (`scripts/Dockerfile:1-19`).

### Native process launcher

`scripts/run-compose-stack.sh` is the no-Docker equivalent. It starts the same
reference-shaped host-port layout, including the extension services, and writes
one log per process (`scripts/run-compose-stack.sh:1-5`, `84-163`). Use it only
with a real supervisor and private filesystem paths. It does not create a TLS
front door; use the nginx configuration below and set the upstreams to the
native host ports.

The native launcher sources `.env`, accepts `PHOENIX_LOG_DIR`, and can shift all
reference ports with `PHOENIX_PORT_OFFSET` (`scripts/run-compose-stack.sh:10-45`).
For production, leave the offset at zero unless every nginx upstream and every
internal peer is changed consistently.

### Separate mode: `authenticated-stack.mjs`

`scripts/parity-robot/authenticated-stack.mjs` is a **different deployment mode**,
not another spelling of Compose. It is a long-running colocated robot profile
with real Account hub-token issuance and Hub JWT verification. It starts the
service modules in one process at `basePort + N`, not one container per service
(`scripts/parity-robot/authenticated-stack.mjs:54-85`, `162-225`). Its defaults
include:

- base port `19000` for the hub;
- parser `base+5`, history `base+6`, data `base+7`, skills `base+3`;
- OTA `base+10`;
- Account `base+11`, loopback by default;
- an additional loopback Classic HTTP listener at `base+12` for the portal;
- Classic TLS and notification upgrades on `PHOENIX_ROBOT_ENTRYPOINT_PORT`,
  default `443`, bound to `0.0.0.0` by default;
- a gateway listener on `0.0.0.0` at the base port
  (`scripts/parity-robot/authenticated-stack.mjs:278-315`, `342-358`).

The default in the launcher is 19000, but the live Moth profile has used
`PHOENIX_ROBOT_PORT=29000` (`docs/parity/evidence/2026-09-11/h10-native-bearer-upgrade/review.md:56-58`).
That is a deployment-specific colocated-stack choice, not the Compose hub
contract and not a port that Cloudflare can proxy directly.

Do not run its defaults on the same address as nginx. If you deliberately use
this mode with nginx, move Classic TLS to a private unprivileged port and host,
for example `PHOENIX_ROBOT_ENTRYPOINT_PORT=19443` and
`PHOENIX_ROBOT_ENTRYPOINT_HOST=127.0.0.1`, then make nginx proxy to an HTTPS
upstream with verification against the Phoenix CA. Keep Account on its default
loopback `base+11`. Alternatively give the launcher a separate public IP and
let it own port 443. The Compose path is simpler and is the recommended mode
for this guide because nginx can terminate all public TLS consistently.

The launcher requires private 0600 files, a private 0700 run directory, and
`PHOENIX_ENV_FILE=/dev/null` (`scripts/parity-robot/authenticated-stack.mjs:15-21`,
`54-85`). Its `PHOENIX_ROBOT_PUBLIC_URL` and `ETCO_server_parakeetUrl` settings
are meaningful in this mode; the Compose variables are described below.

## 4. Prerequisites and sizing

### Host prerequisites

**Operator step — not run here:**

1. Linux with a stable absolute checkout path, systemd, Docker Engine plus the
   Docker Compose plugin, nginx, OpenSSL, and a host/cloud firewall.
2. Node.js `>=20` if you will run the native launcher, the TLS helper, the
   account-admin utility, or repository verification commands. The repository
   declares that engine requirement (`package.json:5-9`).
3. A static public IPv4 address is strongly preferred. A home server also needs
   router port-forwarding of TCP 80 and 443 to the nginx host, and an IPv6 plan
   if an AAAA record is published.
4. DNS A/AAAA records for the names you own: `portal.example.com`,
   `classic.example.com`, and optionally `hub.example.com`. Do not create DNS
   records for someone else's `jibo.com` names; see [DNS and hostname groups](#6-dns-and-hostname-groups).
5. A private ASR endpoint reachable from the hub container. Parakeet is not a
   service in `docker-compose.yml`; it is an external dependency
   (`docker-compose.yml:66-67`, `services/parakeet-asr/README.md:96-107`).
6. A source of time synchronization. SigV4 and JWT expiry are time-sensitive;
   keep the VPS, ASR host, and robot clocks sane.

### Starting sizing recommendation

These are operating recommendations, not minimums encoded by the repository:

- Start the Node/Compose host at **2 vCPU, 4 GiB RAM, and 20 GiB free disk**.
  Increase RAM/CPU if several robots or large Classic uploads are active.
- Reserve at least the size of the OTA artifacts plus working space. The two
  common OTA tarballs are approximately 249 MiB and 326 MiB; plan for roughly
  575 MiB for the pair, plus a temporary buildroot, backups, and future
  versions. The manifest names the OS and Services artifacts but does not ship
  their bytes (`packages/ota/manifest.json:15-59`), and the loader measures the
  actual file size at startup (`packages/ota/src/catalog.js:94-126`).
- Run Parakeet on a separate GPU-capable private host unless you have measured
  that the VPS has enough GPU/VRAM and disk bandwidth. The full image loads a
  NeMo model before serving requests; the contract-only image cannot
  transcribe (`services/parakeet-asr/Dockerfile:41-52`,
  `services/parakeet-asr/README.md:121-131`).
- Add disk for member photos, Classic media, robot backups, logs, and at least
  one off-host encrypted backup. JSON stores are household-scale and are not a
  substitute for a replicated database (`DIVERGENCES.md:48-50`,
  `packages/account/src/store.js:1-4`).

## 5. Obtain the checkout and prepare private storage

Use a reviewed commit, not a mutable development worktree. The commands below
are a procedure for the target host; no checkout or service is modified by this
documentation update.

**Operator step — not run here:**

```sh
sudo install -d -m 0755 /srv/phoenix
sudo chown "$USER":"$USER" /srv/phoenix
cd /srv/phoenix
# Clone or copy the reviewed Phoenix checkout here, then select its revision.
# Do not use a working tree that contains secrets or generated OTA files in Git.
git status --short --branch
npm install
```

The Compose image uses `npm ci` itself. `npm install` is still useful on the
host for the Node-side scripts and native launcher. Keep `.env`, TLS keys, and
account data outside Git. The account store writes an atomically replaced JSON
snapshot with private temporary files (`packages/account/src/store.js:36-57`).

Create durable directories under the checkout or another host path that you
bind into the containers. The examples below use the repository bind mount so
the container paths are stable:

**Operator step — not run here:**

```sh
cd /srv/phoenix
install -d -m 0700 \
  packages/account/data \
  packages/account/data/member-photos \
  packages/account/data/classic-backups \
  packages/account/data/classic-media \
  packages/account/data/classic-keys \
  packages/account/data/classic-logs \
  packages/ota/data
install -m 0600 /dev/null .env
```

Do not put a TLS private key or a copied account store below
`packages/account/portal`; the nginx template's final static fallback can serve
files physically placed below its `root` (`docs/portal-nginx-hosting.md:258-266`).

## 6. DNS and hostname groups

There are two fundamentally different groups of names.

| Group | Names | DNS and certificate strategy |
|---|---|---|
| **Baked into the native robot client** | `<region>.jibo.com` and `<region>-socket.jibo.com` | You do not own `jibo.com`, so public DNS and Let's Encrypt cannot solve this. The robot must resolve both names to your server, trust the Phoenix CA, and receive a certificate whose SANs contain both names. The native client uses port 443. |
| **Chosen by the deployment** | `portal.example.com`, `classic.example.com`, `hub.example.com` | Point A/AAAA records at nginx and use a normal public certificate such as Let's Encrypt. These are aliases for the human portal, a browser-safe Classic/OTA/photo origin, and optional hub WebSockets. |

This is the key internet-hosting constraint documented by the robot-facing code:
the account face derives the REST and socket names from the region
(`packages/account/src/portalApi.js:51-64`), and the certificate helper explicitly
creates `<region>.jibo.com` and `<region>-socket.jibo.com`
(`scripts/ensure-tls-certs.mjs:41-50`). The robot is not made public-CA-trusted
by pointing a DNS record at your IP.

For a VPS, allow TCP 80/443 at the cloud firewall and point the owned names at
that address. For a home server, forward only TCP 80/443 at the router and
keep all service ports unforwarded. If the public address changes, update the
owned DNS records and rerun the robot repoint procedure; the robot's managed
hosts entries otherwise become stale.

### Robot name resolution

The supported PC-side repoint utility maps the live region and socket names in
the robot's persistent `/etc/hosts`, installs the CA into the real persistent
OpenSSL store, and patches the supported Node client copies without disabling
TLS verification (`scripts/parity-robot/repoint-robot.sh:1-35`). It checks the
certificate being served for the robot's actual region before it changes trust
(`scripts/parity-robot/repoint-robot.sh:313-345`). Use that mechanism instead of
trying to invent a public `api.jibo.com` DNS record.

## Cloudflare proxy, 443, and the robot

### The direct answer

**Yes: Cloudflare's normal DNS proxy can carry HTTPS on port 443.** The
supported proxied HTTPS ports are `443`, `2053`, `2083`, `2087`, `2096`, and
`8443`; supported HTTP ports include `80`, `8080`, `8880`, `2052`, `2082`,
`2086`, and `2095`. A Phoenix hub listening on `9000` or `29000` cannot be
placed behind the normal Cloudflare proxy. For a proxied hub, the public
listener must be a supported port, normally 443. Source: Cloudflare's [network
ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
documentation.

That answer is **not** enough to make a stock robot connect through Cloudflare.
The default robot-facing names are not in your Cloudflare zone:

- `/var/jibo/credentials.json` supplies the robot's `region` string.
- The native client derives `<region>.jibo.com` for the HTTPS entrypoint and
  `<region>-socket.jibo.com` for the notification WebSocket.
- The archived native configuration records the production region table as
  `dev-entrypoint -> dev-hub.jibo.com`, `alpha-entrypoint -> alpha-hub.jibo.com`,
  `stg-entrypoint -> stg-hub.jibo.com`, `preprod-entrypoint ->
  preprod-hub.jibo.com`, and `api -> neo-hub.jibo.com` with `api.jibo.com` as
  the API entrypoint. Those production values use hub port 443.
- The native token request uses `HTTPSClientSession(entrypoint_hostname, 443)`
  and signs `https://<entrypoint_hostname>`; the notification URL is
  `wss://<region>-socket.jibo.com/<token>` on 443.

The project evidence for the hard-coded entrypoint port and the live region
record is [`docs/parity/evidence/2026-09-11/h10-native-bearer-upgrade/review.md`](parity/evidence/2026-09-11/h10-native-bearer-upgrade/review.md#1-the-native-contract-re-derived-from-the-pinned-source)
(lines 20-29 and 50-58). The native notification contract records the REST and
socket names and port 443 in `docs/parity/candidates/A-10-native-notification-contract-20260907.md:42-88,173-188`.
The server-side TLS helper independently requires `<region>.jibo.com` and
`<region>-socket.jibo.com` in the certificate SAN (`scripts/ensure-tls-certs.mjs:41-50`).

You cannot add `jibo.com` to a Cloudflare zone you do not control. Therefore
Cloudflare cannot proxy `api.jibo.com`, `api-socket.jibo.com`, or another
stock `<region>` name, regardless of whether the origin certificate is public
or private. Cloudflare also cannot make a public DNS record for those names.
The normal robot path remains: map the two names on the robot to the origin
address, serve the Phoenix private-CA certificate at nginx on 443, and install
that CA on the robot as described above. Cloudflare is not in that path.

### Recommended split architecture

Use Cloudflare for names you own and keep the native robot names direct:

```text
browser -> Cloudflare orange-cloud portal.example.com:443
                         |
                         v
                 origin nginx:443 -> account :9011

robot -> api.jibo.com / api-socket.jibo.com (robot hosts override)
                         |
                         v
                 origin nginx:443 -> Classic :9012
                         |
                         +-> OTA :9010 / Account member photos

optional owned hub.example.com -> Cloudflare or direct nginx:443
                                         |
                                         v
                                 hub :9000 (plain WS)
```

1. Put `portal.example.com` (and, if desired, the owned
   `classic.example.com` and `hub.example.com` aliases) in your Cloudflare
   zone and enable the orange-cloud proxy. Cloudflare terminates the browser's
   public TLS and connects to nginx over TLS. Set Cloudflare SSL/TLS mode to
   **Full (strict)** and give nginx a valid origin certificate, such as the
   Let's Encrypt certificate already used in this guide or a Cloudflare Origin
   CA certificate. See Cloudflare's [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
   documentation.
2. Keep the robot's `<region>.jibo.com` and `<region>-socket.jibo.com` names
   grey-cloud/direct. They must resolve on the robot to the origin IP, not to
   Cloudflare anycast addresses. Keep the Phoenix private CA and the nginx
   robot vhost for those names.
3. Keep all Compose service ports private. Cloudflare is an outer edge proxy,
   not a replacement for the host firewall. For orange-cloud names, allow
   origin 443 only from Cloudflare's published IP ranges plus any deliberately
   direct operator sources. For the direct robot vhost, allow the robot's
   stable source address where possible.
4. Keep `CLASSIC_PUBLIC_URL`, `PHOTO_PUBLIC_URL`, and `OTA_PUBLIC_URL` pointed
   at an owned hostname only if the robot can resolve it and trust its public
   certificate. Otherwise use the direct/private-CA robot name for URLs that
   the robot must fetch. Do not silently mix a Cloudflare hostname into a
   robot flow that only trusts the Phoenix CA.

The portal works well behind the orange-cloud proxy because it is a normal
owned HTTPS hostname. The stock robot path does not. **Cloudflare does not
solve the jibo.com certificate or DNS problem.**

### Can the robot use an owned Cloudflare hostname for the hub?

The robot-side `HubClient.override` is configurable: the supported repoint
script writes arbitrary `hub_hostname`, `hub_port`, and
`entrypoint_hostname` values (`scripts/robot-repoint-server-client.sh:230` and
`scripts/parity-robot/repoint-robot.sh:566-574`). Thus an operator can, in
principle, point the hub at `hub.example.com:443` and let nginx/Cloudflare
carry a WebSocket on 443. Cloudflare supports proxied WebSockets without
additional configuration on supported ports; see its [WebSockets](https://developers.cloudflare.com/network/websockets/)
documentation. nginx must still send HTTP/1.1 `Upgrade` and `Connection` headers,
as in the hub block in this guide.

This is an **untested option, not the recommendation for a first internet
rollout**. The robot verifies the TLS peer name using its own trust store;
through Cloudflare it would see the Cloudflare edge certificate, and Cloudflare
can rotate that certificate chain. The robot's trust store, SNI, hub override,
and the separate notification endpoint must all be tested with the exact
firmware. Use a direct grey-cloud owned hub name or the LAN/VPN path until that
end-to-end test succeeds. A custom hub override also does not change the
stock Classic entrypoint/socket names; configure and verify those separately.

Cloudflare Spectrum is a paid TCP passthrough product, but it still needs an
application/hostname in a Cloudflare zone that you control (see [Spectrum
configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/)).
It cannot attach a Spectrum listener to `jibo.com` for you, so it does not solve
the stock robot suffix problem. It is unnecessary for the recommended direct
robot vhost.

### Cloudflare settings that matter for Phoenix

- **WebSockets:** enable Cloudflare WebSockets for the zone. The hub paths are
  `/listen`, `/v1/listen`, `/proactive`, and `/v1/proactive`; keep nginx's
  `proxy_http_version 1.1`, `Upgrade`, `Connection`, buffering, and long read
  timeout settings. A successful Cloudflare TCP/HTTPS connection alone does
  not prove a WebSocket upgrade or a valid Phoenix Bearer token.
- **Timeouts:** Cloudflare's current 524 documentation lists a default proxy
  read timeout of 125 seconds. Treat that as an upper bound, not a service
  target; make every API request produce a response well under roughly 100
  seconds and ensure streaming endpoints send data promptly. nginx's `1h`
  OTA timeout cannot extend Cloudflare's edge timeout. Source: [Cloudflare
  Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).
- **Cache:** create explicit Cache Rules to bypass cache for `/api/*`,
  `/ota/package*`, `/member-photos/*`, Classic POST/robot routes, and hub
  WebSocket paths. Do not cache session-bearing or robot responses. Static
  portal assets may be cached only if their cache headers and release process
  make that safe. The two common OTA tarballs are approximately 249 MiB and
  326 MiB; keep buffering off, confirm the Cloudflare plan's large-response
  behavior, and test a complete download. Cloudflare's [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
  documentation describes the bypass controls.
- **Client IPs and rate limiting:** Cloudflare presents the visitor IP in
  `CF-Connecting-IP` and also supplies `X-Forwarded-For`. Without correction,
  nginx's `$remote_addr` and the existing `limit_req_zone $binary_remote_addr`
  rules see Cloudflare edge addresses, so unrelated visitors can share a rate
  bucket. In nginx's `http` context, add the current Cloudflare published CIDR
  ranges with `set_real_ip_from`, then set
  `real_ip_header CF-Connecting-IP` and `real_ip_recursive on`; keep the
  origin firewall restricted to those ranges so clients cannot spoof the
  header by reaching nginx directly. Cloudflare recommends using
  `CF-Connecting-IP` for the original visitor IP; see its [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
  documentation. Re-check the published ranges when maintaining nginx.
- **Cookies:** retain `ETCO_account_secureCookies=true`; Cloudflare's public
  HTTPS edge and the HTTPS origin must preserve the forwarded scheme and the
  portal's `Secure`, HttpOnly session behavior. Do not use Cloudflare cache or
  header transformations that reuse one user's portal response for another.
- **Origin exposure:** orange-clouding a hostname does not hide an origin whose
  IP is discoverable or whose 443 accepts arbitrary direct traffic. Keep the
  direct robot host separate, firewall the proxied origin to Cloudflare ranges,
  and never expose 9000 or 9003–9014.

Cloudflare account configuration, orange-cloud DNS, WebSockets, Full (strict),
Cache Rules, Spectrum, origin-header restoration, and the Cloudflare edge
path were **not tested in this environment**. Verify them on the target zone
with the checks in [Verification checklist](#15-verification-checklist). The
nginx and Certbot limitations at the end of this guide still apply.

## 7. Certificates and robot trust

### 7.1 Public certificates for names you own

Use Let's Encrypt for the owned names. One certificate may contain all of them:

```text
portal.example.com
classic.example.com
hub.example.com
```

The existing portal template uses Certbot-style `fullchain.pem` and `privkey.pem`
paths and leaves the HTTP-01 challenge location reachable
(`deploy/nginx/phoenix.conf:46-61`, `73-80`). Keep that ACME location in the
port-80 server block. Do not enable an nginx TLS block that points at certificate
files which do not exist yet.

**Operator step — not run here:**

```sh
sudo install -d -m 0755 /var/www/certbot
# First install a temporary HTTP-only vhost for the owned names with the
# /.well-known/acme-challenge/ location, then issue the certificate.
sudo certbot certonly --webroot --webroot-path /var/www/certbot \
  --cert-name phoenix-public \
  -d portal.example.com \
  -d classic.example.com \
  -d hub.example.com
sudo certbot renew --dry-run
```

Configure a renewal deploy hook to reload nginx only after renewal:

```sh
sudo certbot renew --deploy-hook '/usr/bin/systemctl reload nginx'
```

Certbot, public DNS, and ACME issuance were not available in the authoring
environment. Treat these as target-host operations, not as evidence that a
certificate exists.

### 7.2 Private CA for the robot names

Generate and retain the Phoenix CA before enabling the robot vhost. The helper
creates a CA and serving certificate, reuses them, and reissues the serving
certificate when it no longer covers every required name or is within seven days
of expiry (`scripts/ensure-tls-certs.mjs:73-134`). It includes localhost, local
IPv4 addresses, every configured region's REST/socket names, and
`PHOENIX_TLS_EXTRA_NAMES` (`scripts/ensure-tls-certs.mjs:31-54`).

Set the actual region, and use a private directory readable by nginx's root
master process:

**Operator step — not run here:**

```sh
sudo install -d -m 0700 /etc/phoenix/tls
sudo chown "$USER":"$USER" /etc/phoenix/tls
PHOENIX_TLS_HOME=/etc/phoenix/tls \
PHOENIX_TLS_REGIONS=api \
node scripts/ensure-tls-certs.mjs
sudo chmod 0600 /etc/phoenix/tls/ca.key /etc/phoenix/tls/server.key
```

Replace `api` with the region written in the robot credentials, or list all
regions served by this host as a comma-separated value. Never overwrite or
regenerate `ca.key` casually. The CA key is the root of robot trust: losing it
means every robot must be provisioned again with a replacement CA. Back up the
CA certificate and key offline in an encrypted secret store. Back up the
serving key too; it is replaceable under the same CA, but keeping it simplifies
recovery.

Inspect the names without printing private key material:

```sh
openssl x509 -in /etc/phoenix/tls/server.crt -noout -subject -issuer -ext subjectAltName
openssl x509 -in /etc/phoenix/tls/ca.crt -noout -fingerprint -sha256
```

nginx serves `server.crt` and `server.key` for the robot names. The robot trusts
`ca.crt`; it does not need a public CA for those names.

### 7.3 Install the CA and repoint a robot

Do this only after the Classic nginx vhost is listening on 443 and the custom
certificate covers the robot's real region.

**Operator step — not run here:**

```sh
cd /srv/phoenix
scripts/parity-robot/repoint-robot.sh \
  --robot root@<robot> \
  --phoenix <public-ip-as-seen-by-the-robot> \
  --cert-dir /etc/phoenix/tls \
  --no-hub \
  --dry-run
```

Review the plan. Then repeat without `--dry-run` and confirm the prompt (or use
`--yes` only after reviewing the plan):

```sh
scripts/parity-robot/repoint-robot.sh \
  --robot root@<robot> \
  --phoenix <public-ip-as-seen-by-the-robot> \
  --cert-dir /etc/phoenix/tls \
  --no-hub
```

The script maps both `<region>.jibo.com` and `<region>-socket.jibo.com` to the
public address, installs the CA into the boot-persistent trust store, and keeps
TLS verification enabled (`scripts/parity-robot/repoint-robot.sh:454-543`). If
portal adoption already created the robot's Phoenix account, add `--no-adopt`;
otherwise let the supported adoption path run and point it at the store the
server actually reads. Re-run with `--revert` to remove the managed change; the
script keeps timestamped backups.

The native Jetstream client hardcodes `wss://` for the hub. The repository
includes a TLS proxy for the plain Phoenix hub and documents that the override
controls only host and port (`scripts/hub-tls-proxy.mjs:1-8`). nginx's hub block
below is the TLS proxy, so set Jetstream's hub target to the owned name and port
443. The robot-side helper can write that override while preserving the baked
Classic names:

**Operator step — not run here:**

```sh
# Run on the robot, after the CA/hosts step above; --dry-run first.
sh scripts/robot-repoint-server-client.sh \
  https://api.jibo.com \
  --hub hub.example.com:443 \
  --dry-run
sh scripts/robot-repoint-server-client.sh \
  https://api.jibo.com \
  --hub hub.example.com:443
```

The first script handles the private CA and `/etc/hosts`; the second writes the
native server-client endpoint/socket and the Jetstream hub override. Keep the
backups both scripts create. If the robot cannot resolve `hub.example.com`, use
a name/IP plan that the robot can resolve and ensure the certificate SAN and
transport match; do not silently fall back to an open plain-WS port.

## 8. Environment and public URL contract

Copy `.env.example` and put secrets only in a root-owned, mode-0600 environment
file. The following is a **template**; replace angle-bracket placeholders and
never commit the file or print its contents:

```dotenv
# Region/cookies
ETCO_account_region=api
ETCO_account_secureCookies=true

# Required for any internet deployment; use a password-manager-generated value.
HUB_TOKEN_SECRET=<long-random-secret-kept-only-on-the-server>
DISABLE_AUTH=false

# Owned public origin used by Classic-generated URLs and browser-safe photos/OTA.
CLASSIC_PUBLIC_URL=https://classic.example.com
PHOTO_PUBLIC_URL=https://classic.example.com
OTA_PUBLIC_URL=https://classic.example.com

# Compose-internal peers. These are not public URLs.
NET_lasso=lasso:8080
NET_settings=account:8080

# ASR is external to docker-compose.yml. This URL must be reachable from the hub container.
PARAKEET_URL=http://<private-asr-host>:6972

# Optional OpenAI-compatible parser/answer provider.
#LLM_URL=http://<private-llm-host>:1234/v1
#LLM_MODEL=google/gemma-4-e4b

# Durable paths inside the Compose bind mount.
ETCO_account_dataFile=/phoenix/packages/account/data/store.json
PHOTO_DIRECTORY=/phoenix/packages/account/data/member-photos
ETCO_account_photoDirectory=/phoenix/packages/account/data/member-photos
ETCO_ota_dataDir=/phoenix/packages/ota/data
ETCO_ota_manifest=/phoenix/packages/ota/manifest.json
ETCO_classic_notificationFile=/phoenix/packages/account/data/notifications.json
ETCO_classic_backupDir=/phoenix/packages/account/data/classic-backups
ETCO_classic_mediaDir=/phoenix/packages/account/data/classic-media
ETCO_classic_mediaFile=/phoenix/packages/account/data/classic-media.json
ETCO_classic_iftttFile=/phoenix/packages/account/data/ifttt.json
ETCO_classic_jotFile=/phoenix/packages/account/data/jot.json
ETCO_classic_voiceTrainingFile=/phoenix/packages/account/data/voice-training.json
ETCO_classic_keyFile=/phoenix/packages/account/data/keys.json
ETCO_classic_keyBinaryDir=/phoenix/packages/account/data/classic-keys
ETCO_classic_robotDir=/phoenix/packages/account/data/robots
ETCO_classic_personFile=/phoenix/packages/account/data/person.json
ETCO_classic_pushFile=/phoenix/packages/account/data/push.json
ETCO_classic_logDir=/phoenix/packages/account/data/classic-logs
ETCO_gqa_attributionFile=/phoenix/packages/account/data/gqa-attribution.json
```

Why these variables matter:

- Compose maps `OTA_PUBLIC_URL` to `ETCO_ota_publicUrl` and the account photo
  URL to `ETCO_account_photoBaseUrl` (`docker-compose.yml:185-221`). Native
  startup maps the same names (`scripts/run-compose-stack.sh:73-82`,
  `107-130`).
- `CLASSIC_PUBLIC_URL` is passed to Classic so self-hosted backup/media/photo
  URLs do not point at an internal container address
  (`docker-compose.yml:223-244`). Classic's URL builder otherwise derives an
  origin from the request (`packages/classic/src/index.js:364-366`).
- In `authenticated-stack.mjs`, use
  `PHOENIX_ROBOT_PUBLIC_URL=https://classic.example.com`; the launcher maps it
  to `ETCO_classic_publicUrl` and accepts `ETCO_server_parakeetUrl`
  (`scripts/parity-robot/authenticated-stack.mjs:117-128`, `342-358`). It is
  not a replacement for `OTA_PUBLIC_URL`/`PHOTO_PUBLIC_URL` in Compose.
- `ETCO_account_secureCookies=true` causes the `phx_session` cookie to include
  `Secure`; the session remains HttpOnly and SameSite=Lax
  (`packages/account/src/sessions.js:1-6`, `38-45`).
- Compose wires hub per-robot verification to the private Account service and
  sets the skills/settings peers by container name
  (`docker-compose.yml:45-67`). Do not set `ETCO_hub_accountUrl` to the public
  portal URL; the internal `account:8080` path is the intended boundary.
- `NET_settings=account:8080` is important for the report skill. The Compose
  report service otherwise falls back to the dead source hostname
  `settings.jibo.aws` (`docker-compose.yml:113-126`).
- The default secret and auth values are development conveniences
  (`docker-compose.yml:51-57`, `211-214`). Override both for the internet.
  The symmetric secret can mint tokens for any identity if leaked
  (`DIVERGENCES.md:49-50`).

The portal administrator is a per-account `isAdmin` flag, not a shared password.
Every `/api/admin/*` request checks it and returns 401 for a signed-out caller or
403 for a signed-in non-admin (`packages/account/src/portalApi.js:87-116`,
`227-266`). After signing up, grant the flag against the **same store file the
running Account service uses**:

```sh
node scripts/portal-grant-admin.mjs \
  --store /srv/phoenix/packages/account/data/store.json \
  --email <your-account-email>
```

Do not expose `/api/admin/` merely to make the page load. The nginx configuration
below keeps it on a private allow-list as a second boundary.

## 9. Build OTA packages and provide ASR

### 9.1 OTA packages

The OTA service is part of the full stack, but the package bytes are not in
Git. Its manifest entries are skipped when their files are absent, and startup
logs `available: 0` in that case (`packages/ota/src/index.js:21-37`,
`packages/ota/src/catalog.js:11-17`). Build production packages before asking a
robot to update:

**Operator step — not run here:**

```sh
cd /srv/phoenix
scripts/build-ota-packages.sh \
  --buildroot <production-buildroot-path-or-url> \
  --version <version> \
  --out packages/ota/data
```

The builder requires `tar`, `bzip2`, and either root loop mounts or `debugfs`
(`scripts/build-ota-packages.sh:17-21`, `47-51`). Use production buildroots for
a production-fused robot. After building, the server computes the exact file
length and SHA-1 at startup (`packages/ota/src/catalog.js:94-126`); do not hand-edit
those values into a response.

The OTA API returns a package URL under `/ota/package?id=...` with an exact
`Content-Length` and streams the file with `createReadStream`
(`packages/ota/src/service.js:214-228`, `packages/ota/src/catalog.js:306-324`). The
current code does **not** implement HTTP Range parsing. nginx should stream
without buffering and use a long read timeout, but this guide does not claim
206/resumable downloads. Test the actual response; if resumable range downloads
are a requirement, put a range-capable object/static server in front or add that
feature to the OTA service rather than assuming nginx adds it.

### 9.2 Parakeet ASR

There is no `parakeet` service in `docker-compose.yml`. The hub's default ASR
factory uses `ETCO_server_parakeetUrl`, then `PARAKEET_URL`, then the historical
LAN default `http://192.168.1.252:6972`
(`packages/gateway/src/asr/factory.js:13-28`). A VPS must set `PARAKEET_URL` to a
real reachable endpoint; leaving it blank does not create ASR.

The repository supplies a full service under `services/parakeet-asr/`. Run the
model image on a private GPU/LAN host and allow only the Phoenix hub to reach
port 6972:

**Operator step — not run here:**

```sh
cd /srv/phoenix/services/parakeet-asr
docker build -t phoenix-parakeet-asr:reviewed .
docker run -d --name phoenix-parakeet \
  --restart unless-stopped --gpus all \
  -p <private-asr-address>:6972:6972 \
  phoenix-parakeet-asr:reviewed
```

Set `PARAKEET_URL=http://<private-asr-address>:6972` in the Compose environment.
Do not use `localhost` unless the hub and ASR share a network namespace. Verify
from a network namespace that can reach the hub container:

```sh
curl -fsS http://<private-asr-address>:6972/healthz
```

The expected body reports `ok: true`, API version, and sample rate
(`services/parakeet-asr/app/server.py:116-119`). This is a cheap readiness probe,
not proof that the NeMo model has loaded or that a real transcription works; the
service README explicitly limits its tests to the wire contract unless a model
run is performed (`services/parakeet-asr/README.md:121-131`). The contract-only
Docker target is useful for API tests but cannot transcribe
(`services/parakeet-asr/Dockerfile:15-19`, `32-39`).

## 10. Complete nginx front door

The following is a coherent template for the recommended Compose mode. Replace
all example hostnames and paths before installation. It is written as one site
file included from nginx's `http` context; `map`, `upstream`, and
`limit_req_zone` must be in that context. The host ports are the Compose host
ports, not the container ports.

This configuration exposes:

- the portal at `portal.example.com`;
- the browser-safe Classic/OTA/photo alias at `classic.example.com`;
- the optional hub at `hub.example.com`;
- the robot's `api.jibo.com` and `api-socket.jibo.com` names with the private CA.

**Operator step — not run here:**

```nginx
# /etc/nginx/sites-available/phoenix

map $http_upgrade $phoenix_connection_upgrade {
    default upgrade;
    ''      close;
}

upstream phoenix_account { server 127.0.0.1:9011; keepalive 16; }
upstream phoenix_classic { server 127.0.0.1:9012; keepalive 16; }
upstream phoenix_ota     { server 127.0.0.1:9010; keepalive 8;  }
upstream phoenix_hub     { server 127.0.0.1:9000; keepalive 8;  }

limit_req_zone $binary_remote_addr zone=phoenix_auth:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=phoenix_api:10m  rate=60r/s;

# Owned names: ACME HTTP-01 and redirect. The robot jibo.com names are not
# listed here because they are not public-DNS names you control.
server {
    listen 80;
    listen [::]:80;
    server_name portal.example.com classic.example.com hub.example.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

# ------------------------------ portal.example.com -------------------------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name portal.example.com;

    ssl_certificate     /etc/letsencrypt/live/phoenix-public/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/phoenix-public/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:phoenix_tls:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    server_tokens off;

    root /srv/phoenix/packages/account/portal;
    index index.html;
    charset utf-8;
    client_max_body_size 25m;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_connect_timeout 10s;
    proxy_read_timeout 120s;

    # The account REST face and session cookie.
    location /api/ {
        limit_req zone=phoenix_api burst=120 nodelay;
        proxy_pass http://phoenix_account;
        proxy_buffering off;
    }
    location = /api/login {
        limit_req zone=phoenix_auth burst=5 nodelay;
        proxy_pass http://phoenix_account;
        proxy_buffering off;
    }
    location = /api/signup {
        limit_req zone=phoenix_auth burst=5 nodelay;
        proxy_pass http://phoenix_account;
        proxy_buffering off;
    }

    # Keep the application gate AND restrict this path to the operator network.
    # Replace these RFC1918 ranges with the actual VPN/admin source ranges.
    location /api/admin/ {
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;
        proxy_pass http://phoenix_account;
        proxy_buffering off;
    }
    location = /admin {
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;
        try_files /app.html =404;
    }

    # Account owns the photo bytes. PHOTO_PUBLIC_URL points at the owned
    # Classic alias below, not at account:8080 or localhost.
    location ^~ /member-photos/ {
        proxy_pass http://phoenix_account;
        proxy_buffering off;
        proxy_read_timeout 120s;
        add_header X-Content-Type-Options "nosniff" always;
    }

    location = /        { try_files /index.html =404; }
    location = /app     { try_files /app.html =404; }
    location = /terms   { try_files /terms.html =404; }
    location = /privacy { try_files /privacy.html =404; }
    location = /security { try_files /security.html =404; }

    location ~* \.(?:html|json|webmanifest|css|js|mjs)$ {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    location ~* \.(?:svg|png|jpg|jpeg|webp|avif|ico|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000" always;
    }
    location ~ /\. { deny all; }
    location ~ \.map$ { deny all; }
    location / { try_files $uri $uri/ $uri.html =404; }
}

# ------------------------------ classic.example.com ------------------------
# This owned alias is used by CLASSIC_PUBLIC_URL, PHOTO_PUBLIC_URL, and
# OTA_PUBLIC_URL. It is browser-trusted and can also be used by a robot for the
# package URL returned by Update_*.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name classic.example.com;

    ssl_certificate     /etc/letsencrypt/live/phoenix-public/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/phoenix-public/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    server_tokens off;
    client_max_body_size 1g;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_connect_timeout 10s;

    # The OTA service returns this path in its Update JSON. It streams the
    # 249/326 MiB-class tarballs from disk; do not buffer them in nginx.
    location ^~ /ota/package {
        proxy_pass http://phoenix_ota;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        send_timeout 1h;
    }

    # Account owns the object; Classic also has a proxy route for the same
    # public path. Direct Account routing avoids a second byte-stream hop.
    location ^~ /member-photos/ {
        proxy_pass http://phoenix_account;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    # REST POST /, all Classic prefixes, health, and notification WebSocket
    # upgrades share this front door.
    location / {
        proxy_pass http://phoenix_classic;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $phoenix_connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 5m;
        proxy_send_timeout 5m;
        send_timeout 5m;
    }
}

# ------------------------------ api.jibo.com -------------------------------
# Replace api/api-socket with every real PHOENIX_TLS_REGIONS name. This block
# uses the private-CA leaf generated by ensure-tls-certs.mjs. It is intentionally
# not a Let's Encrypt certificate: you cannot obtain one for jibo.com.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.jibo.com api-socket.jibo.com;

    ssl_certificate     /etc/phoenix/tls/server.crt;
    ssl_certificate_key /etc/phoenix/tls/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    add_header X-Content-Type-Options "nosniff" always;
    server_tokens off;
    client_max_body_size 1g;

    # If the robot has a stable public source address, add an allow/deny
    # policy here, for example:
    #   allow <robot-public-ip>;
    #   deny all;
    # Do not enable a broad allow-list by accident; this block is the
    # unauthenticated Classic/OOBE boundary described at the top of this guide.

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $phoenix_connection_upgrade;
    proxy_connect_timeout 10s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 5m;
    proxy_send_timeout 5m;
    send_timeout 5m;

    # A robot's Update response may use an owned OTA URL. If instead
    # OTA_PUBLIC_URL=https://api.jibo.com, keep this location; the robot trusts
    # the private CA and the bytes remain behind the same robot-facing name.
    location ^~ /ota/package {
        proxy_pass http://phoenix_ota;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        send_timeout 1h;
    }

    location ^~ /member-photos/ {
        proxy_pass http://phoenix_account;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    # REST Classic POST / and the /<token> notification socket both arrive here.
    location / {
        proxy_pass http://phoenix_classic;
    }
}

# ------------------------------ hub.example.com ----------------------------
# The hub backend is plain WS/HTTP. TLS is terminated here. The robot's native
# Jetstream client uses wss:// and needs the Upgrade/Connection headers.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/phoenix-public/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/phoenix-public/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    server_tokens off;

    proxy_pass_request_headers on;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $phoenix_connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 5m;
    proxy_send_timeout 5m;
    send_timeout 5m;

    location / {
        proxy_pass http://phoenix_hub;
    }
}
```

The hub's own WebSocket paths are `/listen`, `/v1/listen`, `/proactive`, and
`/v1/proactive`; it verifies `Authorization: Bearer <JWT>` during the upgrade
when auth is enabled (`packages/gateway/src/index.js:3-10`, `25-26`,
`43-54`, `102-124`). The catch-all hub location intentionally also forwards
`/healthcheck` and `/v1/skills`.

The long timeouts are deliberate. The protocol constants allow a 180-second
WebSocket maximum (`packages/contracts/src/constants.js:80-89`), and OTA files
are streamed with `Content-Length` rather than buffered in application memory.
The current OTA code does not implement Range requests, so the nginx config
preserves streaming but does not promise `206 Partial Content`.

### Install and validate nginx

1. Put the file in the distribution's nginx `http` include path. On Debian-like
   systems that is commonly `/etc/nginx/sites-available/phoenix` plus a symlink
   under `sites-enabled`.
2. Replace every example hostname, the portal `root`, the Classic region names,
   and the private admin source ranges.
3. Issue the public certificate first, as described above.
4. Test before every reload:

**Operator step — not run here:**

```sh
sudo ln -sfn /etc/nginx/sites-available/phoenix /etc/nginx/sites-enabled/phoenix
sudo nginx -t
sudo systemctl reload nginx
```

nginx and Certbot are not installed in the authoring environment. No nginx
syntax check, reload, ACME issuance, or public reverse-proxy hop is claimed.

## 11. Start the complete Compose stack and supervise it

### First start

Run the config parser before starting. It should resolve all services without
printing private environment values in a shared log:

**Operator step — not run here:**

```sh
cd /srv/phoenix
docker compose --env-file .env config --quiet
docker compose --env-file .env build
docker compose --env-file .env up -d
```

The Compose file maps the complete host-port contract as follows
(`docker-compose.yml:44-247`):

| Host port | Service | Container port | Internet role |
|---:|---|---:|---|
| 9000 | hub | 8080 | Private; optionally exposed only through `hub.example.com` nginx WS/HTTP |
| 9003 | report-skill | 8080 | Private |
| 9004 | chitchat-skill | 8080 | Private |
| 9005 | parser/NLU | 8080 | Private |
| 9006 | history | 8080 | Private |
| 9007 | lasso/data | 8080 | Private |
| 9008 | color-skill | 8080 | Private |
| 9009 | answer-skill | 8080 | Private |
| 9010 | OTA | 8080 | Private; only `/ota/package` is proxied by nginx |
| 9011 | account + portal | 8080 | Private; portal and photo routes go through nginx |
| 9012 | Classic entrypoint | 8080 | Private; Classic REST/socket go through nginx |
| 9013 | example-skill | 8080 | Private |
| 9014 | template-skill | 8080 | Private |

The ASR service at 6972 is intentionally absent from this table because it is
external to Compose. The native runner uses the same service names/ports and
starts OTA, Account, and Classic in addition to the conversational services
(`scripts/run-compose-stack.sh:84-163`).

### systemd unit for Compose

The Compose file has no per-service restart policy. Use a host-level unit so a
reboot or a Docker daemon restart brings the whole stack back. Keep
`/etc/phoenix/compose.env` mode 0600 and either put `COMPOSE_PROJECT_NAME=phoenix`
and the non-secret Compose variables there, or use `.env` in the checkout.

**Operator step — not run here:**

```ini
# /etc/systemd/system/phoenix-compose.service
[Unit]
Description=Phoenix full stack (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/phoenix
EnvironmentFile=-/etc/phoenix/compose.env
ExecStartPre=/usr/bin/docker compose --env-file .env config --quiet
ExecStart=/usr/bin/docker compose --env-file .env up --build --remove-orphans
ExecStop=/usr/bin/docker compose --env-file .env down
Restart=on-failure
RestartSec=5
TimeoutStartSec=infinity
TimeoutStopSec=120
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

Install it and inspect the first startup:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now phoenix-compose.service
sudo systemctl status phoenix-compose.service
sudo journalctl -u phoenix-compose.service -n 200 --no-pager
```

If you use the native launcher instead, use a separate unit with
`ExecStart=/usr/bin/bash /srv/phoenix/scripts/run-compose-stack.sh`,
`PHOENIX_LOG_DIR=/var/log/phoenix`, `KillMode=control-group`, and the same
`Restart=on-failure` policy. Do not run both launchers against the same ports.

## 12. Firewall and hardening

### Edge and private ports

Only nginx's 80/443 should be reachable from the internet. The Compose `ports`
entries publish host ports; they are not private merely because the containers
share a network. Block 9000 and 9003–9014, and block 6972 unless the ASR host is
intentionally reachable only from the private network.

**Operator step — not run here:**

```sh
# Adjust SSH source policy and interface/ranges for the host.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from <admin-network> to any port 22 proto tcp
sudo ufw deny 9000:9014/tcp
sudo ufw deny 6972/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker can install forwarding rules that bypass a simplistic UFW policy. Verify
from a different host with an nmap/TCP probe that 9000 and 9003–9014 are closed.
If they are not, add equivalent rules in the Docker `DOCKER-USER` chain or use a
Compose override that binds the published ports to `127.0.0.1`; validate the
actual result rather than assuming the firewall did it. Keep cloud security
 groups and home-router forwards equally narrow.

If the robot has a stable source address, add an nginx `allow <robot-address>` /
`deny all` policy to the `api.jibo.com` and `api-socket.jibo.com` server block.
If the robot's address changes, use a VPN/private overlay or accept that an
address allow-list will strand it. Do not solve that problem by exposing the
internal service ports.

### Application controls that are mandatory

- Set `DISABLE_AUTH=false`. The Compose default is `true` for LAN convenience
  (`docker-compose.yml:51-57`, `scripts/run-compose-stack.sh:134-143`).
- Set a long, unique `HUB_TOKEN_SECRET`, store it at mode 0600, and never put it
  in Git, shell history, tickets, or logs. It is an HS256 shared secret; anyone
  who obtains it can mint identities (`DIVERGENCES.md:49-50`).
- Keep the hub's internal Account verification path enabled. Compose wires
  `ETCO_hub_accountUrl=http://account:8080`, which lets deactivation invalidate
  a robot at the next upgrade (`docker-compose.yml:55-58`,
  `packages/gateway/src/index.js:56-77`).
- Set `ETCO_account_secureCookies=true` and use HTTPS everywhere for the portal.
- Keep `/admin` and `/api/admin/` on a VPN or an explicit source allow-list. The
  application `isAdmin` check is still required; the nginx restriction is a
  second boundary, not a replacement.
- Never expose 9011 directly. Standalone Account calls `server.listen(port)`
  without a host (`packages/common/src/service.js:173-182`,
  `packages/account/src/index.js:351-357`), so a direct standalone listener is
  not made loopback-only by nginx. In the Compose deployment, the host firewall
  is the boundary.
- Do not enable diagnostic audio capture or verbose per-request logging on an
  internet-facing host unless the data handling is intentional. Phoenix logs
  structured JSON to stdout/stderr and includes transaction IDs
  (`packages/common/src/log.js:1-35`). Configure bounded Docker/journald and
  nginx log retention.
- Do not expose `/debug`, source maps, `.env`, data files, the TLS directory, or
  the Docker socket. Keep the nginx document root limited to portal assets.
- Consider a separate public IP or VPN for the robot Classic names. The private
  CA solves trust and hostname verification; it does not make Classic requests
  authenticated.

## 13. Persistence and backups

Back up these items before every upgrade and copy them off-host encrypted:

1. **Account store:** `packages/account/data/store.json` (or the path set by
   `ETCO_account_dataFile`). It contains accounts, sessions, loops, robot
   credentials, hub-token material, and settings. The store is the durable
   source for portal and robot identity (`packages/account/src/store.js:11-21`).
2. **OTA:** `packages/ota/manifest.json` and every file under
   `packages/ota/data`. The server computes the package's actual length and
   SHA-1 from those files; missing files are not offered
   (`packages/ota/src/catalog.js:11-17`, `94-126`).
3. **TLS trust:** `/etc/phoenix/tls/ca.crt`, especially `ca.key`, plus the
   serving key/certificate. Losing the CA key means re-provisioning every
   robot. Do not put these in the Git checkout or a public backup bucket.
4. **`.env`/Compose environment:** it contains `HUB_TOKEN_SECRET` and public/internal
   wiring. Store it as a protected secret, not in the backup report.
5. **Classic state:** the explicit notification file, backup directory, media
   index and object directory, photo directory, GQA attribution file, and any
   optional Jot, voice-training, key, robot, person, push, IFTTT, and log paths.
   The notification store, backup store, and media store all have durable-file
   implementations when given explicit paths (`packages/classic/src/notificationStore.js:71-105`,
   `packages/classic/src/backup.js:36-43`, `61-123`,
   `packages/classic/src/media.js:105-145`). Do not rely on their `/tmp` defaults.

Example archive procedure; choose a real encrypted backup destination and do not
print the archive contents:

**Operator step — not run here:**

```sh
sudo install -d -m 0700 /var/backups/phoenix
sudo tar --xattrs --acls -C /srv/phoenix \
  -czf /var/backups/phoenix/phoenix-data-<timestamp>.tgz \
  .env packages/account/data packages/ota/manifest.json packages/ota/data
sudo tar --xattrs --acls -C /etc/phoenix \
  -czf /var/backups/phoenix/phoenix-tls-<timestamp>.tgz tls
sudo chmod 0600 /var/backups/phoenix/*.tgz
```

Test restoration on a separate host. A backup that contains the account store
without the matching TLS CA still leaves robots unable to connect; preserve both
sets together. A backup that contains the CA without `HUB_TOKEN_SECRET` can
restore TLS but not the hub authentication contract.

## 14. Logging and health checks

Every Phoenix HTTP service exposes `/healthcheck` through the shared service
boundary; the default response is `ok`, while History can report a real failing
status when its store is not usable (`packages/common/src/service.js:40-43`,
`84-89`, `packages/history/test/healthcheck.test.js`). The Parakeet service uses
`/healthz`, not `/healthcheck` (`services/parakeet-asr/app/server.py:116-119`).

Use Docker/journald and nginx logs as separate layers:

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs --since=10m hub classic account ota
sudo journalctl -u phoenix-compose.service -f
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

Prefer a logrotate or Docker json-file size/retention policy. Do not log `.env`,
Authorization headers, QR payloads, account stores, or robot credentials.

For a deployment health sweep, use the host-local backends before testing nginx:

**Operator step — not run here:**

```sh
for port in 9000 9003 9004 9005 9006 9007 9008 9009 9010 9011 9012 9013 9014; do
  printf 'port %s: ' "$port"
  curl --silent --show-error --max-time 5 "http://127.0.0.1:${port}/healthcheck"
  printf '\n'
done
```

Expected: HTTP 200 for healthy services; most bodies are `ok`, while History's
body is its source-shaped status object. A failure or timeout is a private
service problem, not an nginx problem.

## 15. Verification checklist

Run these in order on the target deployment. These are acceptance checks, not
claims that they were run in the authoring environment.

### 15.1 Compose and local routing

```sh
cd /srv/phoenix
docker compose --env-file .env config --quiet
docker compose --env-file .env ps
```

Expected: config validation succeeds; all 13 Compose services are running.
The ASR container, if used, is a separate service and should have its own
health check.

Run the port sweep in [Logging and health checks](#14-logging-and-health-checks).
Then inspect that no internal port is externally reachable from a second host.

`node scripts/verify-compose-contract.mjs` is the repository's running-stack
smoke check (`scripts/verify-compose-contract.mjs:1-8`). Its WebSocket lane is
written for the development `DISABLE_AUTH=true` configuration and expects the
unauthenticated CONTEXT failure described in that script
(`scripts/verify-compose-contract.mjs:64-86`). Do **not** turn off authentication
on an internet host just to make that development probe pass. Run it only in an
isolated verification deployment, or use the health and authenticated probes
below for production.

### 15.2 nginx and certificates

```sh
# Owned public certificate and portal surface.
curl --silent --show-error --output /dev/null \
  --write-out 'portal / %{http_code} %{content_type}\n' \
  https://portal.example.com/
curl --silent --show-error --output /dev/null \
  --write-out 'portal /api/me %{http_code} %{content_type}\n' \
  https://portal.example.com/api/me

# Robot name with SNI and the private CA; --resolve is useful from an operator
# workstation because api.jibo.com is not public DNS.
curl --cacert /etc/phoenix/tls/ca.crt \
  --resolve api.jibo.com:443:<public-ip> \
  --silent --show-error --write-out 'classic %{http_code}\n' \
  https://api.jibo.com/healthcheck

openssl s_client -connect <public-ip>:443 -servername api.jibo.com \
  -CAfile /etc/phoenix/tls/ca.crt -verify_return_error </dev/null
```

Expected: portal `/` is 200; unauthenticated `/api/me` is 401; the Classic
health check is 200 with `ok`; the private-CA handshake verifies and the
certificate SAN contains both `api.jibo.com` and `api-socket.jibo.com`.

Check the owned public alias too:

```sh
curl --silent --show-error --output /dev/null \
  --write-out 'classic alias %{http_code}\n' \
  https://classic.example.com/healthcheck
curl --silent --show-error --output /dev/null \
  --write-out 'hub %{http_code}\n' \
  https://hub.example.com/healthcheck
```

Expected: both are 200. A 502 means nginx reached no upstream or the upstream
is on the wrong port; a 404 from Classic's health path usually means the
request was sent to the wrong server block or a different process.

### 15.3 WebSocket authentication

Without a token, the hub must reject the upgrade when `DISABLE_AUTH=false`.
With a real Account-issued token, it must accept the upgrade with HTTP 101.
Keep the token out of shell history and output:

```sh
# Operator supplies a real short-lived token through a protected mechanism.
websocat -v \
  -H='Authorization: Bearer <short-lived-token-not-logged>' \
  wss://hub.example.com/listen
```

The hub verifies the Bearer JWT during upgrade and can then check the access key
against Account (`packages/gateway/src/index.js:102-124`). Do not treat a 101
from an auth-disabled test as production evidence.

### 15.4 OTA streaming and range behavior

With a built package present:

```sh
curl --silent --show-error --dump-header - --output /dev/null \
  'https://classic.example.com/ota/package?id=os-13.0.0'
curl --silent --show-error --range 0-1023 --dump-header - --output /dev/null \
  'https://classic.example.com/ota/package?id=os-13.0.0'
```

Expected for the first request: 200, `Content-Type: application/octet-stream`,
and a `Content-Length` matching the package. The current application does not
implement ranges; unless a later proxy or code change adds them, the second
request should not be treated as a 206 acceptance criterion. Confirm that large
files stream to completion and nginx does not time out.

If the manifest package is absent, `UPDATE_NOT_FOUND` or a 404 is expected; it
is not fixed by nginx. Inspect `docker compose logs ota` and the configured
`ETCO_ota_dataDir`.

### 15.5 Photos and the robot path

After a test member photo exists, request the exact generated URL without
printing its key in shared logs:

```sh
curl --silent --show-error --output /dev/null \
  --write-out 'member photo %{http_code} %{content_type}\n' \
  'https://classic.example.com/member-photos/<known-test-key>'
```

Expected: 200 and the streamed object content type. `PHOTO_PUBLIC_URL` must be
an externally reachable origin; Account rejects photo configuration without a
public base URL and writes files with private modes
(`packages/account/src/memberPhotoStorage.js:8-35`).

From the robot, verify the exact baked names and port 443 after the CA/repoint
procedure:

```sh
jibo-get-update --credentials /var/jibo/credentials.json \
  --subsystem os --version 3.3.4
```

Expected: the robot receives the matching Update JSON and the OTA log records an
update query. A real conversation test should then use the hub override and the
private-ASR endpoint. These robot checks require hardware and were not run here.

### 15.6 Cloudflare edge checks (operator-only)

These checks apply only when an owned hostname is orange-clouded. They were not
run here because there is no Cloudflare zone or account in the authoring
environment.

```sh
# Orange-cloud names should resolve to Cloudflare addresses, not the origin.
dig +short portal.example.com

# Inspect headers without logging cookies or Authorization values.
curl --silent --show-error --dump-header - --output /dev/null \
  https://portal.example.com/
curl --silent --show-error --dump-header - --output /dev/null \
  https://portal.example.com/api/me
```

Expected: the owned hostname presents its public certificate through
Cloudflare, `/` is 200, and `/api/me` is 401 when unauthenticated. The API
response must not be a cache hit. Inspect the origin nginx access log and
confirm that the Cloudflare `CF-Connecting-IP` value is restored as the client
address only after `set_real_ip_from` is restricted to Cloudflare's published
ranges.

If you intentionally test a custom owned hub hostname, test the WebSocket
path separately; this does **not** test the stock `api.jibo.com` robot path:

```sh
websocat -v wss://hub.example.com/listen
# Supply a protected, short-lived Account-issued Bearer token for the 101 test.
websocat -v -H='Authorization: Bearer <short-lived-token>' \
  wss://hub.example.com/listen
```

Expected: no token is rejected with HTTP 401 when auth is enabled; a valid
Account-issued token upgrades with HTTP 101. Do not set `DISABLE_AUTH=true` to
make this check pass. Finally, download a complete OTA package through the
Cloudflare-owned alias and confirm that it finishes without a 524, that the
response is not cached, and that the content length matches the package. The
Cloudflare edge behavior, including large-response limits and the custom-hub
robot trust path, remains an operator acceptance test.

## 16. Upgrade and rollback

### Upgrade

1. Schedule a maintenance window and take the encrypted data/TLS backups in
   [Persistence and backups](#13-persistence-and-backups).
2. Check the current serving revision and save the current Compose image IDs:

   **Operator step — not run here:**

   ```sh
   git -C /srv/phoenix rev-parse HEAD
   docker image inspect phoenix-runtime:local --format '{{.Id}}'
   ```

3. Stage the new reviewed checkout separately. Do not replace the live checkout
   while nginx or Docker is reading it.
4. Validate `.env`, all public URL values, the region/SAN list, and OTA package
   paths. Never change `HUB_TOKEN_SECRET` casually; doing so invalidates existing
   hub tokens and must be coordinated with robot reauthentication.
5. Run `docker compose config --quiet`, build, and start the staged revision.
   Run the local health sweep and the nginx/WS/OTA checks before declaring it
   live.
6. Switch the `current` symlink or checkout path only after checks pass, then
   restart the systemd unit. Reload nginx only after `nginx -t` succeeds.
7. If the serving certificate was reissued under the **same CA**, reload nginx.
   Do not regenerate the CA. If the CA changes, re-provision every robot before
   removing the old trust anchor.

### Rollback

- Restore the previous reviewed checkout/image and run the same `config --quiet`,
  health, and nginx syntax gates.
- Restore the previous nginx file or symlink, run `sudo nginx -t`, then reload.
- Do not delete `/etc/phoenix/tls`, the CA key, or the public certificate during
  a code rollback.
- Restore a data backup only if the new version changed or damaged the data
  format; take the current data snapshot first. Restoring an old account store
  can roll back newly adopted robots, sessions, and settings.
- If the failure is limited to OTA packages, keep the account/TLS state and
  restore only the previous `manifest.json` and package directory.

The account store uses atomic file replacement, but atomic writes are not a
backup strategy. Keep the pre-upgrade copy off-host.

## 17. Troubleshooting

### `nginx -t` fails or nginx will not reload

- Check that the public Certbot paths exist and nginx can read them.
- Check that `map`, `upstream`, and `limit_req_zone` are included in nginx's
  `http` context, not a `server`/`location` context.
- Check duplicate `default_server`/port 443 listeners. The colocated launcher
  must not still own `0.0.0.0:443`.
- Check every `server_name`, certificate SAN, and nginx SNI block. Never use a
  public certificate for the jibo.com names.

### Portal 502 or direct account access

- Confirm Compose mode uses Account `127.0.0.1:9011` at the host, or native
  mode uses its configured `PORT`.
- Confirm `docker compose ps account` and its logs.
- Confirm the host firewall blocks remote 9011. A loopback nginx upstream does
  not stop a wildcard Node listener from being reached through another address.
- If admin HTML is 403, the source address is outside the nginx allow-list. If
  `/api/admin/me` is 401 from an allowed source, the application correctly has
  no admin session. Grant the `isAdmin` flag against the correct store.

### Robot says unknown CA, wrong hostname, or TLS failure

- Confirm the robot is resolving both `api.jibo.com` and
  `api-socket.jibo.com` to the server, not public DNS or a stale hosts entry.
- Confirm `server.crt` SANs contain the robot's actual region and socket region.
- Confirm nginx is serving the certificate signed by the CA installed on the
  robot. The repoint script performs this exact live verification.
- Confirm port 443 reaches nginx after router/cloud forwarding; the robot client
  does not negotiate an arbitrary alternate port.
- If the CA key was lost, stop trying to repair one robot with the old CA: issue
  a new CA and deliberately re-provision every robot.

### Classic request reaches the portal or returns HTML

The portal vhost owns `/` as an HTML page; Classic owns robot `POST /` with
`X-Amz-Target`. Check SNI and the `server_name` first. The robot's region name
must route to the Classic server block, not `portal.example.com`.

### WebSocket 400/401/502 or disconnects

- `401` with auth enabled means the Bearer token is absent, malformed, expired,
  or fails the Account check. Do not set `DISABLE_AUTH=true` on the public host.
- `502` means the nginx upstream is wrong or the hub/Classic process is down.
- Check that `proxy_http_version 1.1`, `Upgrade`, and the mapped `Connection`
  header are present. Check `proxy_read_timeout` against the 180-second protocol
  maximum.
- The real robot hub uses `wss://`; a plain `ws://` Compose listener must be
  behind nginx or the repository's TLS proxy.

### OTA returns no update or download hangs

- Check `packages/ota/manifest.json`, `ETCO_ota_dataDir`, and the OTA startup log.
  Missing package files are skipped by the catalog.
- Check that `OTA_PUBLIC_URL` is a URL whose host/port the robot can resolve and
  whose nginx server block has `/ota/package` routed to 9010.
- Check `proxy_buffering off`, `proxy_max_temp_file_size 0`, and the one-hour
  timeouts. A normal nginx proxy does not add Range support to the current OTA
  application.
- Check that the package directory and the backup disk have enough free space.

### Photos are broken or URLs point at `account:8080`

Set `PHOTO_PUBLIC_URL` to the externally reachable Classic/owned alias, not a
Compose service name or localhost. Confirm the Account photo directory exists,
is writable by the container process, and the nginx `/member-photos/` block
reaches Account. The Account and Classic paths are intentionally separate from
portal static files.

### Voice does not work

- Confirm the hub container can reach `PARAKEET_URL`; `localhost` inside the hub
  container is the container itself.
- Check `/healthz` on the ASR host, then perform a real `.wav` transcription.
- A green `/healthz` only proves the cheap HTTP readiness response; model load,
  GPU availability, and confidence output require a model-backed run.
- Do not expose port 6972 publicly just to make the hub reach it; use a private
  network address and firewall it.

### Direct internal ports are visible from the internet

This is an incident, not an nginx configuration detail. Check the cloud security
group, router forwards, host firewall, Docker `DOCKER-USER` chain, and any IPv6
rules. Rotate `HUB_TOKEN_SECRET` if an unauthorized party could reach the hub,
review account/robot state, and preserve logs before closing the exposure.

## 18. Code-backed source map

The main deployment claims in this guide were checked against these repository
locations:

| Claim | Source |
|---|---|
| Compose services, container port, host-port map, internal peers, public URL env wiring | `docker-compose.yml:29-247` |
| Native all-service launcher, port layout, env mapping, log paths | `scripts/run-compose-stack.sh:1-174` |
| Hub paths and Bearer upgrade auth | `packages/gateway/src/index.js:3-10`, `25-26`, `43-54`, `102-124`, `171-175` |
| Classic is the single front door, prefix proxies, notification socket, photo route | `packages/classic/src/index.js:1-7`, `294-300`, `347-445`; `packages/classic/src/photoProxy.js:35-123` |
| Account portal, admin flag, member photos, service port | `packages/account/src/index.js:2-9`, `227-357`; `packages/account/src/portalApi.js:87-116`, `227-266`; `packages/account/src/memberPhotoStorage.js:8-35` |
| OTA URL, streaming body, exact length/SHA-1, no application Range implementation | `packages/ota/src/index.js:21-37`; `packages/ota/src/service.js:109-120`, `214-231`; `packages/ota/src/catalog.js:94-126`, `306-324` |
| Robot CA names and generated files | `scripts/ensure-tls-certs.mjs:20-54`, `73-134` |
| Robot hosts/trust installation and live certificate/SAN gate | `scripts/parity-robot/repoint-robot.sh:1-67`, `313-345`, `454-553` |
| Native robot REST/socket names and hub TLS requirement | `scripts/robot-repoint-server-client.sh:1-57`, `127-142`; `scripts/hub-tls-proxy.mjs:1-30` |
| Classic SigV4 divergence, symmetric hub secret, JSON persistence | `DIVERGENCES.md:44-51`; `packages/account/src/store.js:1-57` |
| Account cookie security and private static root | `packages/account/src/sessions.js:1-55`; `packages/account/src/static.js:1-142` |
| Standalone wildcard bind versus colocated loopback Account and Classic 443 | `packages/common/src/service.js:173-182`; `scripts/parity-robot/authenticated-stack.mjs:54-85`, `216-287` |
| External Parakeet contract and model limitations | `packages/gateway/src/asr/factory.js:13-38`; `services/parakeet-asr/Dockerfile:15-52`; `services/parakeet-asr/app/server.py:116-151`; `services/parakeet-asr/README.md:96-134` |
| Structured logs and service health | `packages/common/src/log.js:1-35`; `packages/common/src/service.js:40-43`, `84-89` |
| Existing portal-only nginx boundaries and rate/cache policy | `deploy/nginx/phoenix.conf:1-21`, `29-44`, `116-204`; `docs/portal-nginx-hosting.md:248-270` |
| Native region/entrypoint/HubClient evidence used for internet routing | `docs/parity/evidence/2026-09-11/h10-native-bearer-upgrade/review.md:20-29`, `50-58`; `docs/parity/candidates/A-10-native-notification-contract-20260907.md:42-88`, `173-188`; `scripts/robot-repoint-server-client.sh:230`; `scripts/parity-robot/repoint-robot.sh:566-574` |
| Cloudflare port, WebSocket, 524, source-IP, TLS-mode, cache, and Spectrum guidance | Cloudflare documentation linked in [Cloudflare proxy, 443, and the robot](#cloudflare-proxy-443-and-the-robot); design guidance only, not a Phoenix runtime test |

## 19. Verification scope and limitations

This guide was written from the repository source and existing operational
artifacts. The documentation change does not restart, stop, or reconfigure the
live `phoenix-robot@moth.service` unit.

Not tested here: Docker image build/start, public DNS, router/cloud forwarding,
nginx syntax, nginx reload, Certbot installation/issuance/renewal, a public
reverse-proxy hop, a GPU-backed Parakeet model, a real external client, or a
real robot crossing the internet. Run the target-host checks in this document
before calling the deployment complete.
