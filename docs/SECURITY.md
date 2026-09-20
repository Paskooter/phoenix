# Phoenix production security baseline

This document is the launch gate for an Internet-facing Phoenix installation. It is intentionally
shorter than the compatibility and hardware notes: if a deployment conflicts with this baseline,
it is a development or private-LAN deployment and must not be advertised as a public service.

## Non-negotiable edge boundary

The only Internet-facing listener should be a TLS reverse proxy (nginx or an equivalent, reviewed
separately) on TCP 443, plus TCP 80 only for ACME HTTP-01 and an immediate redirect. Do not publish
the Phoenix service ports to the Internet:

| Surface | Production path | Direct host exposure |
|---|---|---|
| Portal/account API | nginx HTTPS vhost → loopback `127.0.0.1:9011` | No |
| Classic REST and notification WebSocket | robot TLS vhost → loopback `127.0.0.1:9012` | No |
| OTA package service | nginx/Classic private upstream → loopback `127.0.0.1:9010` | No |
| Conversation hub WebSocket | nginx WebSocket vhost → loopback `127.0.0.1:9000` | No |
| Parser, history, data, skills | Compose network only (`:8080`) | No |

The default [`docker-compose.yml`](../docker-compose.yml) follows this table. It publishes the four
edge backends on loopback solely for a host reverse proxy; all other services have `expose`, not
`ports`. [`docker-compose.dev.yml`](../docker-compose.dev.yml) restores localhost test ports and
must never be used as a public deployment. A host firewall is still required: Docker forwarding
rules can bypass an overly broad UFW policy, so verify from a second host.

Check the actual result after every deployment:

```sh
sudo ss -lntup
docker compose --env-file .env ps
nmap -Pn -p 80,443,9000-9014 <public-ip>   # run from a different host
```

The external scan should show only the intended 80/443 edge. SSH (22) is an administration path,
not an application path; restrict it to a VPN or a fixed administrator source range.

## Required production configuration

Copy [`../.env.example`](../.env.example), keep it mode `0600` (owned by the
unprivileged native service user when using `phoenix-native.service`), and fill every blank
required value before starting the stack:

```sh
install -m 0600 /dev/null .env
openssl rand -base64 48       # put the result in HUB_TOKEN_SECRET
```

At minimum:

```dotenv
HUB_TOKEN_SECRET=<unique-random-secret>
DISABLE_AUTH=false
ETCO_account_internalPeerToken=<different-32-byte-random-secret>
ETCO_account_secureCookies=true
OTA_PUBLIC_URL=https://classic.example.com
CLASSIC_PUBLIC_URL=https://classic.example.com
PHOTO_PUBLIC_URL=https://classic.example.com
PHOENIX_BIND_HOST=127.0.0.1
```

The hardened Compose file fails closed if `HUB_TOKEN_SECRET`, `ETCO_account_internalPeerToken`, `OTA_PUBLIC_URL`, or
`CLASSIC_PUBLIC_URL` is missing. Never restore the historical `dev-hub-token-secret` or
`DISABLE_AUTH=true` on a public instance. `OTA_PUBLIC_URL` and `CLASSIC_PUBLIC_URL` must be fixed
HTTPS origins owned by the operator; do not allow application URLs to be derived from a request
`Host` header. Keep OAuth/API/SMTP credentials in the mode-0600 environment or a secret manager,
not in Git, image layers, logs, tickets, or browser configuration.

After copying an existing environment, inspect it for stale development settings before starting:

```sh
grep -nE '^(HUB_TOKEN_SECRET|DISABLE_AUTH|ETCO_account_secureCookies|OTA_PUBLIC_URL|CLASSIC_PUBLIC_URL|PHOTO_PUBLIC_URL)=' .env
git check-ignore -v .env
stat -c '%a %n' .env
```

The account and Classic stores contain credentials, sessions, household data, media indexes, and
robot identity material. Keep their directories private (`0700`), files private (`0600`), and give
the `node` container user (UID 1000 in the official image) only the specific writable directories
it needs. Compose mounts Account's data root and Classic's
`packages/account/data/classic` state root separately; the Classic environment maps notification,
backup, log, media, IFTTT, person, Jot, voice-training, key, robot, and push stores below that
private root. Do not mount the whole checkout writable into a container.

## Docker hardening

The production image and Compose stack are deliberately restrictive:

- `scripts/Dockerfile` installs dependencies as the unprivileged `node` user and runs as that user;
- Compose uses `read_only: true`, a small `noexec,nosuid,nodev` `/tmp`, `no-new-privileges`, and
  drops Linux capabilities;
- application source is baked into the image; Account alone receives the writable account-data
  mount, Classic receives only its attribution subdirectory, and OTA receives reviewed artifacts
  read-only;
- `.dockerignore` excludes environments, credentials, stores, photos, backups, TLS keys, logs,
  OTA artifacts, runtime bundles, and parity receipts.

Build from a reviewed commit and inspect the effective configuration without publishing it:

```sh
git status --short --branch
docker compose --env-file .env config --quiet
docker compose --env-file .env build --pull
docker compose --env-file .env up -d
```

Do not use `docker compose run --service-ports`, `--network host`, a wildcard `ports` override, or
the Docker socket in a Phoenix container. If a local robot needs direct access, use a private/VPN
address and a source firewall; never change the production edge binding to `0.0.0.0` just to make a
test pass.

## Native launcher hardening

`scripts/run-compose-stack.sh` is suitable for a private host only when supervised and fronted by
TLS. It now defaults `PHOENIX_BIND_HOST=127.0.0.1` and propagates that value to every service via
`packages/common/src/service.js`. The native production unit must set it explicitly:

```ini
Environment=PHOENIX_BIND_HOST=127.0.0.1
Environment=PHOENIX_ENV_FILE=/srv/phoenix/.env
```

Nginx then proxies the loopback ports. If a trusted LAN/VPN robot must reach a listener directly,
choose the private interface deliberately, restrict its source range, and document the firewall
rule. A wildcard Node listener is never an acceptable Internet edge.

## TLS and reverse-proxy controls

Install [`deploy/nginx/phoenix.conf`](../deploy/nginx/phoenix.conf) only after replacing the example
hostname, document root, certificate paths, and upstream port. Run `nginx -t` before every reload.
The template:

- rejects unknown HTTP `Host` values and unknown TLS SNI names rather than serving a default site;
- redirects to the configured canonical hostname rather than reflecting `$host`;
- sets CSP, HSTS, `X-Content-Type-Options`, frame, referrer, and permissions policies;
- preserves those headers in static regex locations by using `expires` instead of child
  `add_header` directives;
- overwrites `X-Forwarded-For` with the direct peer address, sets the canonical forwarded host and
  scheme, and does not trust arbitrary incoming forwarding chains;
- applies body/header/send timeouts, a connection cap, a general API rate limit, and a tighter
  login/signup rate limit;
- restricts `/admin` and `/api/admin/` to an explicit private administrator network in addition to
  the application authorization check.

If a CDN or load balancer is placed before nginx, configure its trusted source ranges and real-IP
module before changing rate-limit keys. Do not blindly switch to `X-Forwarded-For` supplied by the
Internet. Keep the robot Classic REST and notification WebSocket hostnames on their own TLS vhost;
do not send robot AWS-JSON `POST /` traffic to the portal vhost.

## Launch and upgrade checklist

Before announcing a hostname:

1. Confirm DNS A and AAAA records both terminate on the intended edge host; remove stale AAAA and
   wildcard records.
2. Confirm certificates cover every portal, Classic, socket, and hub hostname actually used. A
   private robot CA provides trust only after it is installed on the robot; it is not authentication.
3. Confirm `nginx -t`, reload, and check the security headers and canonical redirect with `curl -I`.
4. Confirm `/api/me` is `401` without a session, login attempts are rate-limited, and admin paths
   are `403` from an unapproved source network.
5. Confirm health checks succeed through the private upstreams, then verify the external port scan
   shows no `9000` or `9003–9014` listener.
6. Back up the account store, Classic state, OTA manifest/artifacts, `.env`, TLS CA and private key
   off-host with encryption. Test restoring to a separate host before an upgrade.
7. Run `npm audit --omit=dev`, review the lockfile diff, rebuild the image, and retain the previous
   image/config until the new health and rollback checks pass.

Rotate `HUB_TOKEN_SECRET`, robot credentials, OAuth/API keys, SMTP credentials, session material,
and TLS keys after any suspected exposure. A secret visible in a shell history, image layer,
container environment dump, log, or plaintext service port should be treated as compromised.

## Common pitfalls

- **Using the dev override in production:** it opens every reference service port on loopback and
  is intended only for local contract tests. It is not a replacement for nginx or TLS.
- **Setting `PHOENIX_BIND_HOST=0.0.0.0`:** this makes native services reachable on every interface.
  Use loopback plus nginx, or a single private/VPN interface plus a source firewall.
- **Starting with an old `.env`:** an old `DISABLE_AUTH=true` or development secret defeats the
  security boundary even when nginx is configured correctly. Recheck the effective environment.
- **Assuming a container network is a host firewall:** a `ports` entry publishes to the host; an
  `expose` entry does not. Inspect `docker compose config` and scan from another machine.
- **Putting secrets below the portal root:** nginx static fallback can serve files physically under
  that directory. Keep stores, TLS keys, backups, and `.env` outside the document root.
- **Mounting data as root-owned:** the image runs as UID 1000. Create and `chown` persistent data
  directories before startup, or the service will fail (operators sometimes “fix” this by running
  the container as root, which is not an acceptable fix).
- **Trusting a certificate as authorization:** TLS encrypts and authenticates the endpoint, but the
  application still needs verified robot/account credentials and a protected admin path.
- **Forgetting IPv6:** an AAAA record or router forward can expose a service that IPv4 firewall rules
  block. Test both families or remove the AAAA record.
- **Reloading without a config check:** always run `nginx -t`; keep the previous vhost and image
  available for rollback.
