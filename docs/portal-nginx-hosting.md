# Phoenix portal behind nginx

This is the public-hosting runbook for the portal vhost. It deliberately does **not** configure the
robot-facing Classic API: that is a separate TLS service and hostname/surface. The portal is the
account service's web UI plus its same-origin REST face.

The hardened deployment baseline is loopback-only: Compose publishes Account on
`127.0.0.1:9011`, while the native launcher sets `PHOENIX_BIND_HOST=127.0.0.1` by
default. Nginx is the only public browser ingress; use a private/VPN bind address
only with an explicit firewall policy.

The guide is based on the code at the current Phoenix revision, not on an assumed framework:

- `packages/account/src/static.js` — the explicit `GET` route inventory, MIME types, and no-cache
  behavior.
- `packages/account/src/index.js` — the account service entrypoint and the three account faces.
- `packages/common/src/service.js` — `server.listen(port, host)` with the
  `PHOENIX_BIND_HOST` production boundary.
- `packages/contracts/src/constants.js` — `DefaultPort.account = 7016`.
- `scripts/parity-robot/authenticated-stack.mjs` — the colocated stack's `basePort + 11` account
  port and loopback/LAN bind choice.
- `packages/account/src/portalApi.js` and `sessions.js` — API behavior and the admin gate (the account's `isAdmin` flag).
- `deploy/nginx/phoenix.conf` — the working vhost template, including the rate limits and cache
  policy.

Steps labeled **On the target host** need an operator's host, DNS, root privileges, or real
certificates, so they are written to be run there rather than reproduced here. The local curl
probe described under [Verification](#verification) was run against a live portal.

## 1. Architecture and deployment choice

The portal files are plain HTML, CSS, JavaScript, JSON, SVG, and metadata. There is no portal build
step, framework, npm dependency, or content hashing. The account service can serve these files from
`packages/account/portal/`, but a public deployment should let nginx serve them directly and proxy
the dynamic account API back to the account service. This keeps HTML/assets out of the Node request
path while preserving the same-origin `phx_session` cookie for `/api/*`.

The supplied vhost also proxies `/member-photos/` because the account service owns that streamed
endpoint when member-photo storage is configured. It is the only non-`/api` exception in the portal
vhost. The robot-facing Classic entrypoint is not an exception to add here: its AWS-JSON `POST /`
and robot notification socket are a separate TLS surface.

Choose one account deployment mode before editing the nginx upstream:

| Mode | Account port | Bind behavior | nginx upstream |
|---|---:|---|---|
| Standalone account process | `7016` by default; `PORT` overrides it | `start()` calls `createAccountService().listen(port)`. Set `PHOENIX_BIND_HOST=127.0.0.1` (or a private/VPN address) before starting it; an unset host retains Node's wildcard behavior for legacy callers. | Change the template's upstream from the Compose default `127.0.0.1:9011` to the selected private port, and verify the listener with `ss`. nginx cannot change a bind after the process starts. |
| `authenticated-stack.mjs` colocated development/robot stack | `basePort + 11`; the launcher default is `19000`, so the account port is `19011`. `basePort=0` makes it ephemeral and is not suitable for a fixed nginx upstream. | `accountHost` defaults to `127.0.0.1`. `PHOENIX_ROBOT_ACCOUNT_HOST=0.0.0.0` is an explicit opt-in for a trusted LAN. | Change the template to `127.0.0.1:19011` for the default stack, or to the actual `basePort + 11`. |

Do not blur these ports. The template's `9011` is the hardened Compose edge default; standalone
Account remains `7016` unless `PORT` overrides it, and the colocated launcher uses `basePort + 11`.
The colocated launcher also defaults its **separate** Classic TLS
entrypoint to `0.0.0.0:443`; nginx cannot bind the same address and port at the same time. Give the
Classic entrypoint a different address/port or a separate TLS front door. Do not send robot Classic
traffic to this portal vhost just because both services use TLS.

## 2. Prerequisites

Before installing the vhost, have all of the following:

1. A Linux host with Node.js `>=20` (the repository engine requirement), an installed nginx with
   an `http`-context include for site files, and the account service's runtime dependencies.
2. A checkout at a stable absolute path. The template uses
   `/srv/phoenix/packages/account/portal`; change `root` if the checkout is elsewhere.
3. An account service process using one of the modes above, with its persistent account store and
   normal environment configured. There is no admin password to set: the admin surface follows the
   signed-in account. Grant it after signing up with
   `node scripts/portal-grant-admin.mjs --email <address>` (`--list`, `--revoke`).
4. A dedicated public portal hostname, for example `portal.example.com`, with its A and/or AAAA
   records pointing at the nginx host. If both records exist, both must reach this host; an AAAA
   record pointing elsewhere commonly breaks ACME and TLS checks.
5. Inbound TCP 80 and 443 allowed to nginx. The account listener port must not be published as a
   public service; in standalone mode, enforce that with the host/container network policy because
   the Node default bind is wildcard.
6. A separate hostname/IP/port plan for the robot-facing Classic TLS entrypoint. The portal
   certificate and portal `server_name` do not automatically cover the Classic service.

**On the target host — target-host dependency installation:**

```sh
cd /srv/phoenix
npm install
```

Run that only in the checkout used by the account service. The public vhost does not need a portal
build; it needs the files present at `root` and the account service dependencies installed.

## 3. DNS, names, and certificates

### Portal name

Replace `phoenix.example.com` in **both** server blocks of
`deploy/nginx/phoenix.conf` with the exact portal hostname. If the portal should answer aliases,
list every alias in both `server_name` directives and include every alias in the certificate SANs.
Do not use a hostname that the robot's Classic region is expected to resolve to unless the two
surfaces are intentionally separated by address/SNI and certificate configuration.

The vhost redirects ordinary HTTP requests to HTTPS but leaves
`/.well-known/acme-challenge/` on port 80 under `/var/www/certbot`. That plain-HTTP exception is
intentional: it is how HTTP-01 renewal reaches the challenge files.

### First certificate

The template references these Certbot-style paths:

```text
/etc/letsencrypt/live/portal.example.com/fullchain.pem
/etc/letsencrypt/live/portal.example.com/privkey.pem
```

Use the actual hostname in place of `portal.example.com`. On first issuance those files do not
exist, so do not enable the full TLS vhost and then expect `nginx -t` to pass. First publish a
temporary HTTP-only server for the same `server_name` whose only useful location is the ACME
webroot, then request the certificate, remove the temporary server, install the full template, and
test it.

The temporary HTTP-only server should contain the equivalent of this (the snippet was not run
here):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name portal.example.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / { return 404; }
}
```

**On the target host — Certbot bootstrap:**

```sh
sudo install -d -m 0755 /var/www/certbot
sudo certbot certonly --webroot --webroot-path /var/www/certbot \
  --cert-name portal.example.com \
  -d portal.example.com
```

For aliases, add one `-d` for each alias. The command above is a procedure, not evidence of a
certificate: Certbot was not installed here, and no public DNS or ACME issuance was attempted.
Do not print the resulting private key or paste it into configuration management logs.

After issuance, set `ssl_certificate` and `ssl_certificate_key` in the template to the resulting
`live/<cert-name>/` paths. The current template requires TLS 1.2 or 1.3 and enables HSTS with
`includeSubDomains`; use a hostname hierarchy where every affected subdomain is HTTPS-ready before
leaving that HSTS policy enabled.

### Renewal

Keep the port-80 ACME location in the installed vhost. It must remain reachable even though all
other HTTP paths redirect. Certbot normally installs a systemd timer or cron job; verify that the
renewal mechanism exists on the target host and make a successful renewal reload nginx so nginx
opens the renewed certificate rather than retaining the old worker state.

**On the target host — renewal and deploy hook:**

```sh
sudo certbot renew --dry-run
sudo certbot renew --deploy-hook '/usr/bin/systemctl reload nginx'
```

Use the target distribution's actual `systemctl` path or Certbot integration if it differs. The
first command is a dry run; the second is the renewal policy to configure, not a command run during
this documentation update.

### The Classic certificate is separate

`packages/classic` is the robot-facing AWS-JSON/notification front door. The portal is not that
front door. The account code documents the robot region convention: a region resolves to a REST
host `<region>.jibo.com` and a socket host `<region>-socket.jibo.com`; the default account region
is `api`. If a deployment retains that convention, the Classic certificate needs SANs for the
actual REST and socket names used by the robots (for the default region, the corresponding
`api` and `api-socket` names). If a deployment uses custom names, use the exact names written into
the robots' region configuration instead. Those SANs belong to the Classic TLS surface, not to this
portal certificate unless both names are deliberately terminated by the same TLS service.

## 4. Install and wire the nginx vhost

Start from the repository copy and edit these values before installation:

- both `server_name` directives: the portal DNS name(s);
- `root`: the absolute path to the **same** `packages/account/portal` directory the checkout uses;
- `ssl_certificate` and `ssl_certificate_key`: the real certificate paths;
- `upstream phoenix_account server`: `127.0.0.1:9011` for hardened Compose, `127.0.0.1:7016`
  for standalone, or the colocated
  `127.0.0.1:(basePort + 11)` value;
- the `allow`/`deny` admin network ranges if administrators come from a known network that is not
  already covered. Keep an allow-list; do not make the admin API public merely to make the page
  load.

On Debian-family nginx installs the usual site locations are `/etc/nginx/sites-available` and
`/etc/nginx/sites-enabled`. On another distribution, put the file in the distribution's `http`
include path; `upstream` and `limit_req_zone` must be in nginx's `http` context.

**On the target host — privileged install:**

```sh
cd /srv/phoenix
sudo cp deploy/nginx/phoenix.conf /etc/nginx/sites-available/phoenix
sudo ln -sfn /etc/nginx/sites-available/phoenix /etc/nginx/sites-enabled/phoenix
sudo nginx -t
sudo systemctl reload nginx
```

The last two commands are a safety gate: do not reload a configuration that fails `nginx -t`.
The nginx executable was not present in this environment, so this guide does not claim a live
syntax check or reload.

## 5. Exact routing and proxy boundaries

### Canonical account-service static route inventory

`staticRoutes()` registers 27 explicit `GET` routes: seven page/branding entrypoints plus the
20-file list below. The two console entrypoints are intentionally the same shell:
`GET /app` and `GET /admin` both serve `app.html`; the browser's hash route selects the UI, and
`/admin` maps the bare path to `#/admin` in `app.js`.

| Request path | Served file or behavior | Node content type |
|---|---|---|
| `/` | `index.html` | `text/html; charset=utf-8` |
| `/app` | `app.html` (console shell) | `text/html; charset=utf-8` |
| `/admin` | `app.html` (same console shell; admin hash route) | `text/html; charset=utf-8` |
| `/terms` | `terms.html` | `text/html; charset=utf-8` |
| `/privacy` | `privacy.html` | `text/html; charset=utf-8` |
| `/security` | `security.html` | `text/html; charset=utf-8` |
| `/branding.json` | defaults, or defaults deep-merged with `PHOENIX_BRANDING_FILE` by the Node service | `application/json; charset=utf-8` |
| `/index.html` | direct file route | `text/html; charset=utf-8` |
| `/app.html` | direct file route | `text/html; charset=utf-8` |
| `/terms.html` | direct file route | `text/html; charset=utf-8` |
| `/privacy.html` | direct file route | `text/html; charset=utf-8` |
| `/security.html` | direct file route | `text/html; charset=utf-8` |
| `/404.html` | direct file route | `text/html; charset=utf-8` |
| `/theme.css` | direct file route | `text/css; charset=utf-8` |
| `/site.css` | direct file route | `text/css; charset=utf-8` |
| `/console.css` | direct file route | `text/css; charset=utf-8` |
| `/app.js` | direct file route | `text/javascript; charset=utf-8` |
| `/site.js` | direct file route | `text/javascript; charset=utf-8` |
| `/brand.js` | direct file route | `text/javascript; charset=utf-8` |
| `/qr.js` | direct file route | `text/javascript; charset=utf-8` |
| `/map.js` | direct file route | `text/javascript; charset=utf-8` |
| `/vendor/leaflet.js` | direct vendored file route | `text/javascript; charset=utf-8` |
| `/vendor/leaflet.css` | direct vendored file route | `text/css; charset=utf-8` |
| `/assets/favicon.svg` | direct asset route | `image/svg+xml` |
| `/robots.txt` | direct metadata route | `text/plain; charset=utf-8` |
| `/sitemap.xml` | direct metadata route | `application/xml; charset=utf-8` |
| `/manifest.webmanifest` | direct metadata route | `application/manifest+json; charset=utf-8` |

The account service also has dynamic REST routes under `/api/*`, an account-owned streamed
`GET /member-photos/:key`, and a separate robot AWS-JSON face at `POST /`. Those are not portal
files.

### What the supplied nginx file serves

The template maps the extensionless page paths explicitly and serves the portal directory from
`root`. It proxies:

- `/api/` to `phoenix_account`, with the exact `/api/login` and `/api/signup` locations getting
  the tighter `phoenix_auth` bucket;
- `/api/admin/` to the account service after the private-network allow-list;
- `/member-photos/` to the account service with buffering disabled for streamed bytes.

Everything in the canonical table is static from the portal root **except the template's
external `/404.html`**: its exact nginx location is `internal`, so nginx uses it only as the
custom error body. The Node account service does expose `GET /404.html` because it is in the
explicit file list. The template's final
`try_files $uri $uri/ $uri.html =404` is deliberately simple, but it is broader than the Node
allow-list: nginx can serve any additional non-dot, non-`.map` file physically placed under `root`.
Keep that directory limited to portal files and never put `.env`, keys, account stores, deployment
backups, or other secrets below it. If strict parity with the 27 Node routes is required, replace
the final catch-all with an explicit nginx allow-list rather than adding extra files to the root.

The portal vhost must not proxy robot Classic `POST /`. A request for `/` on this vhost is the
public landing page; a robot's `X-Amz-Target` request belongs on the separate Classic TLS host.

## 6. Admin gate and rate limits

`/admin` is not an authorization bypass and a `200` for its HTML shell is not an unlocked admin
session. The page calls `/api/admin/me` with the ordinary `phx_session` cookie, and the server
answers:

- `401` when nobody is signed in — the console sends the visitor to the sign-in screen;
- `403` when the signed-in account is not an administrator;
- `200` with `{ admin: true, account }` for an administrator.

Administrator access is the `isAdmin` flag on the account, re-checked server-side on every
`/api/admin/*` route. There is **no shared admin password and no `/api/admin/login`** — that route
was removed, and a request to it answers `404`. Grant access with
`node scripts/portal-grant-admin.mjs --email <address>` (`--list`, `--revoke`). Because the flag is
read per request, revoking takes effect immediately with no stale admin session to wait out.

The nginx template adds a second boundary: `/admin` and `/api/admin/` are restricted to loopback
and RFC1918 IPv4 ranges by default. Adjust those ranges for the real administrator network,
including any intentional IPv6 range, but keep the application gate even on a private LAN. Remember
that the normal `/app` shell is the same `app.html`; protecting the `/admin` alias alone does not
make the admin API public. The sensitive operations remain under `/api/admin/` and its per-account
check.

The application has no brute-force lockout of its own. The template therefore applies:

- `phoenix_auth`: `10r/m`, `burst=5`, `nodelay` to account login, signup, and admin login;
- `phoenix_api`: `60r/s`, `burst=120`, `nodelay` to the general `/api/` location.

The buckets use `$binary_remote_addr`. If another proxy or CDN is placed in front, configure nginx's
trusted real-IP handling deliberately before changing the key; do not blindly trust an arbitrary
`X-Forwarded-For` header. Tune the limits only with a reason and preserve a tighter bucket for
password endpoints.

The template also rejects unknown HTTP `Host` values and unknown TLS SNI names. The HTTP redirect is
to the configured canonical hostname, never to `$host`; this avoids turning an unrecognized Host
header into an open redirect. It overwrites `X-Forwarded-For` with the direct client address, sets
short header/body/send timeouts, caps concurrent connections, and returns `429` when a limit trips.
If a CDN or load balancer is added, define its trusted source range and real-IP policy before
changing those settings.

## 7. Cache headers and keeping the two serving modes consistent

The Node `serve()` helper reads each file once and caches it in memory. Every explicit static route
and the branding response sends `Cache-Control: no-cache` and `X-Content-Type-Options: nosniff`.
The nginx template matches the no-build/no-hash design while preserving the server-wide security
headers (it uses `expires`, rather than a child `add_header`, so nginx header inheritance cannot
silently drop CSP/HSTS/nosniff):

- HTML, JSON, webmanifest, CSS, JS, and MJS: `Cache-Control: no-cache`;
- SVG, PNG, JPEG, WebP, AVIF, ICO, and WOFF/WOFF2: `public, max-age=2592000` (30 days);
- `X-Content-Type-Options: nosniff` is set on the HTML/data/script/style locations and the security
  headers apply at the server level.

Do not add `immutable` to the HTML, JSON, CSS, or JavaScript while filenames remain unhashed. If
an image or font changes at the same URL, either use a new filename or temporarily lower its cache
policy.

The nginx `root` and the Node `PORTAL_DIR` are the same files in the checkout. Choosing nginx
static delivery versus Node static delivery is a deployment choice, not two independent builds:

- update the one checkout that both modes reference, or deliberately update both copies if they
  are separate;
- after changing files, nginx sees the new disk contents, while the Node service may retain the
  old bytes until its process is restarted because `static.js` caches on first read;
- no portal build or fingerprint step exists, so verify the root path and the response headers after
  each update;
- `PHOENIX_BRANDING_FILE` makes the Node service deep-merge an operator JSON over defaults. An nginx
  `alias` for `/branding.json` serves the aliased file directly and does not perform that merge;
  provide the complete intended response when using the static alias.

## 8. Verification

Run the checks from a client that is allowed by the admin address rules. The commands below are
operator checks and were **not executed against a public HTTPS deployment**; replace the example
base with the real portal URL.

**On the target host — deployed HTTPS checks:**

```sh
BASE=https://portal.example.com

for path in / /app /admin /terms /privacy /security /branding.json \
  /theme.css /site.css /console.css /app.js /site.js /brand.js /qr.js /map.js \
  /vendor/leaflet.js /vendor/leaflet.css /assets/favicon.svg /robots.txt \
  /sitemap.xml /manifest.webmanifest; do
  curl --noproxy '*' --silent --show-error --output /dev/null \
    --write-out "$path %{http_code} %{content_type}\n" "$BASE$path"
done

curl --noproxy '*' --silent --show-error --output /dev/null \
  --write-out '/api/me %{http_code} %{content_type}\n' "$BASE/api/me"
curl --noproxy '*' --silent --show-error --output /dev/null \
  --write-out '/api/admin/me %{http_code} %{content_type}\n' "$BASE/api/admin/me"
curl --noproxy '*' --silent --show-error --output /dev/null \
  --write-out '/not-real %{http_code} %{content_type}\n' "$BASE/not-real"
```

Expected results for the nginx vhost are:

| Request | Expected status | Expected content type |
|---|---:|---|
| `/`, `/app`, `/terms`, `/privacy`, `/security` | `200` | `text/html` (possibly with `charset=utf-8`) |
| `/admin` from an allowed source | `200` | `text/html` (same `app.html` shell as `/app`) |
| `/admin` from a disallowed source | `403` | nginx error response |
| `/branding.json` | `200` | `application/json` |
| CSS | `200` | `text/css` |
| JS | `200` | JavaScript MIME from the host's nginx `mime.types` (normally `application/javascript`; Node direct is `text/javascript; charset=utf-8`) |
| `/vendor/leaflet.js` | `200` | JavaScript MIME |
| `/assets/favicon.svg` | `200` | `image/svg+xml` |
| `/robots.txt` | `200` | `text/plain` |
| `/sitemap.xml` | `200` | `application/xml` |
| `/manifest.webmanifest` | `200` | `application/manifest+json` |
| `/api/me` without `phx_session` | `401` | `application/json` |
| `/api/admin/me` without an admin session, from an allowed source | `401` | `application/json` |
| `/not-real` | `404` | the nginx `404.html` response, normally `text/html` |

A public request to `/api/admin/*` from outside the configured allow-list should be `403` before
it reaches the account service. That is expected. A `401` from an allowed source proves that the
request reached the application and that no admin session was supplied.

Check the no-cache policy directly:

**On the target host — deployed HTTPS header check:**

```sh
curl --noproxy '*' --silent --show-error --dump-header - --output /dev/null \
  "$BASE/app"
curl --noproxy '*' --silent --show-error --dump-header - --output /dev/null \
  "$BASE/branding.json"
curl --noproxy '*' --silent --show-error --dump-header - --output /dev/null \
  "$BASE/app.js"
```

`/app` and `/branding.json` should include `Cache-Control: no-cache` and
`X-Content-Type-Options: nosniff`. `/app.js` should also be no-cache. An image such as the favicon
should instead show the 30-day policy from the template.

Check SNI and the certificate SAN without sending credentials:

**On the target host — real certificate/SNI check:**

```sh
openssl s_client -connect portal.example.com:443 -servername portal.example.com \
  -verify_return_error </dev/null
```

The certificate returned for the portal SNI name must contain that name in its SANs and chain to a
trusted issuer. Perform the analogous check against the **separate Classic hostname** with its
robot-facing certificate; do not use the portal host as a substitute.

For a direct account-service smoke test before nginx, use the upstream mode's local address and
port. A direct Node response differs from the public nginx error page: its unknown-route response
is JSON `404`, while the nginx vhost internally serves `404.html` as HTML.

## 9. Troubleshooting

### 404 or a page that looks like the wrong service

- A browser request to the portal `/` should be the landing page. A robot AWS-JSON `POST /` belongs
  to Classic; sending it to this portal vhost is the wrong surface and will not produce a robot API
  response.
- A portal REST request is `/api/...` and carries the same-origin `phx_session` cookie. Do not send
  portal API requests to the Classic hostname.
- If every static path is 404, check the nginx `root` points to the directory containing
  `index.html`, `app.html`, and `branding.json`, not to `packages/account` or the repository root.
- If only `/admin` is 403, the client address is outside the vhost's allow-list. Fix the network
  allow-list for the intended administrators.
- If `/app` is 200 but `/admin` shows an ordinary console page, use the exact `/admin` path or
  `#/admin`; the shell is shared, and the app derives the bare `/admin` route from the pathname.

### 502 Bad Gateway or an unreachable account upstream

- Confirm which mode is running. Hardened Compose uses `127.0.0.1:9011`; standalone is `7016`
  unless `PORT` overrides it. The colocated
  stack is `basePort + 11` (`19011` with its default base), not `7016`.
- In the colocated stack, a browser on another machine cannot reach the default loopback account
  bind directly. Use the nginx HTTPS hostname. Only opt into `PHOENIX_ROBOT_ACCOUNT_HOST=0.0.0.0`
  for a deliberately trusted LAN, and retain the firewall and admin restrictions.
- In standalone mode, the Node default is not loopback-only. If nginx works locally but the account
  port is exposed remotely, fix the host/container firewall or supervisor/network isolation; do not
  assume the upstream directive changes the Node bind.
- If nginx can resolve the upstream but returns 502, the process may be on a different port or may
  have stopped. Check the account service's own supervisor log and the nginx error log without
  printing the account store or environment.

### TLS mismatch, redirect loop, or ACME failure

- Confirm the DNS A and AAAA records, `server_name`, certificate SANs, and the SNI name are the same
  portal hostname. A certificate for the Classic hostname is not automatically a portal certificate.
- If first issuance fails, make sure port 80 reaches the temporary/full ACME location and that no
  other server owns the challenge path. The template intentionally redirects only after the ACME
  location match.
- If nginx refuses to start after installing the full template, check that both certificate files
  exist at the configured paths and that nginx can read them; do not weaken TLS or paste a private
  key into a report.
- If the Classic stack still owns `0.0.0.0:443`, nginx cannot also own that address/port. Move one
  surface to another address/port or provide the intended TLS/SNI front door.

### The console is stale after an upgrade

- Inspect `/app`, `/branding.json`, and `/app.js` for `Cache-Control: no-cache`, and verify CSP,
  HSTS, `X-Content-Type-Options`, and `X-Frame-Options` are present on those responses. Do not add
  `immutable` to these unhashed files.
- Hard-refresh or clear the browser's site cache only after confirming the response header; a CDN or
  second proxy can override the origin policy.
- If the Node service is serving static files directly, restart that account process after updating
  files because `static.js` caches each file on first read. nginx-only static delivery reads the
  filesystem, but the `root` must point at the updated checkout.
- Keep the nginx root and account service's portal checkout at the same revision. A new `app.js`
  with an old `app.html`, or a different `branding.json`, can look like a cache bug even when the
  browser is revalidating correctly.

## 10. Rollback

Keep the previous nginx file and previous portal checkout available until the new HTTPS and API
checks pass. A config rollback does not require exposing the account port or deleting certificates.

**On the target host — target-host rollback:**

```sh
sudo cp /etc/nginx/sites-available/phoenix /etc/nginx/sites-available/phoenix.failed
sudo cp /etc/nginx/sites-available/phoenix.previous /etc/nginx/sites-available/phoenix
sudo nginx -t
sudo systemctl reload nginx
```

If the previous file is held under another path, restore that path instead. If the failure is only
portal content, point `root` back at the previous checkout, run the same nginx test/reload, and
restart the account service only if it was serving the changed files from Node's in-memory cache.
Leave `/etc/letsencrypt/live/` and its private keys untouched during a portal rollback; certificate
cleanup is a separate, deliberate operation. If the new vhost was never enabled, remove only its
site symlink after validating the old vhost, not the certificate material.

## Verification scope

The local verification for this guide used a temporary account service with an isolated temporary
store and `PHOENIX_ENV_FILE=/dev/null`; it did not touch the running Phoenix stack. It enumerated
all 27 `staticRoutes()` keys and exercised the direct account HTTP responses for every canonical
static path, `/app` versus `/admin` shell identity, unauthenticated `/api/me`, and an unknown
route. The observed direct Node results were the source MIME values above, `200` for canonical
static paths, `401` for `/api/me`, and JSON `404` for an unknown route.

The admin-gate probes in this guide were taken at `f88566a`, when the admin face was still gated by
a shared `ADMIN_PASSWORD`. That contract changed at `19c1aec`: `/api/admin/login` no longer exists
(it answers `404`) and unauthenticated `/api/admin/me` answers `401` with
`sign in to use the admin surface`. Section 6 describes the current contract; the route table is
unchanged.

Not tested here: nginx syntax/runtime, a real reverse-proxy hop, public DNS, Certbot issuance or
renewal, a trusted certificate chain, the Classic TLS front door, a granted administrator account, or
an external client crossing the LAN/firewall boundary. Those are explicit target-host checks, not
assumptions.
