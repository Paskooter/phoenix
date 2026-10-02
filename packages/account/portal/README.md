# Phoenix web portal — the public site and the household console

This directory is the **whole** web front end: a public marketing site, the legal pages, and
the signed-in console that does what the Jibo mobile app could do. It is served in place by
the account service — same process, same port, same origin, same session cookie — or as static
files behind a reverse proxy with `/api` (and, when photo storage is enabled, `/member-photos/`)
proxied back (see `deploy/nginx/`).

There is no front-end build step or framework. The browser UI is plain HTML, CSS and ES modules.

The signed-in console is also an installable PWA. Its service worker caches only
the static console shell for an offline-safe fallback; it never caches `/api`, a
session, branding, household data, or media. The ordinary mobile-browser console
continues to work whether or not it is installed.

## URLs

| URL | Serves | Notes |
|---|---|---|
| `/` | `index.html` | Public landing page |
| `/terms`, `/privacy`, `/security` | the legal pages | Static, no session needed |
| `/app` | `app.html` | The console. Hash routes beneath it (`#/loop`, `#/settings`, …) |
| `/verify-email` | `verify-email.html` | Explicit confirmation of the token in an emailed URL fragment |
| `/admin` | `app.html` | The admin surface, available to accounts with `isAdmin`. Sub-routes: `#/admin` (status), `#/admin/config`, `#/admin/robots`, `#/admin/admins` |
| `/branding.json` | branding, merged | See **Branding** below |
| `/api/*` | the REST face | Unchanged |

The console used to live at `/` with hash routes. Old links like `/#/loop` are forwarded to
`/app#/loop` by `site.js` before the landing page paints, so bookmarks keep working.

## How to start it

The following is the target-host launch command; it was not run in this documentation update.

```sh
node packages/account/src/index.js
```

The service's standalone default is `PORT=7016` (from `DefaultPort.account`). The repository root
currently does not define an `npm run start:account` script; use the Node entrypoint above or your
supervisor's equivalent. Then open `http://localhost:7016/`. The console needs the Classic
entrypoint for the surfaces it fronts (media, person, jot, push, notification, robot,
voicetraining, ifttt, update). Point it there with either env var, both optional:

**Example environment values; not executed in this documentation update.**
```sh
NET_classic=http://localhost:7017          # classic entrypoint base URL
ETCO_account_classicUrl=...                # alias (same meaning)
```

`NET_classic` is set in `docker-compose.yml` for the account service (`classic:8080`). When
unset it defaults to `http://localhost:7017` (DefaultPort.classic). The OTA/update view also
needs the OTA service reachable from Classic (`NET_ota`). Every surface degrades to an
explicit, visible error when its backend is down — nothing is faked.

## Branding

Every visible string on the public site, the logo and the accent colour live in
`branding.json`. Change that file and the whole site follows; there is nothing to rebuild.

```jsonc
{
  "name": "Phoenix",
  "tagline": "Hello, again.",
  "logo": "/assets/my-logo.svg",   // optional; replaces the built-in mark
  "accent": "#3b82f6",             // optional; one hex re-skins the product
  "hero": { "title": "…", "body": "…" },
  "features": { "items": [ … ] }
}
```

Keys map to `data-brand="hero.title"` attributes in the HTML, and repeating lists
(`features.items`, `faq.items`, `status.metrics`, `status.caveats`, `footer.columns`,
`install.steps`, `pipeline.stages`) are rendered from the same config with the markup in
`site-render.js`. An install step may set `"prompt": ""` and `"copy": false` for something to
say to the robot rather than type. Optional slots (`nav.guide`, `install.cta`) stay hidden
unless an instance sets them.

**The HTML carries every default inline, and the account service renders the instance's
branding into it before it is served** (`src/brandRender.js`): text slots, links, lists,
logo, accent colour, and the title, description and social tags. Link previews, crawlers
and visitors without JavaScript therefore see the instance's own page, and nothing flashes
from the project default to the instance copy. `brand.js` and `site.js` apply the same
config again in the browser — a no-op over a rendered page, and the whole mechanism when the
files are served statically by a reverse proxy instead.

The account service also answers a mistyped page address with `404.html` (a JSON error
envelope is kept for API clients and anything that does not ask for HTML), and generates
`sitemap.xml` with absolute locations from `PHOENIX_SITE_URL` plus the operator's own pages.

To customise without editing a file inside the checkout, point the account service at your own
JSON. The following is a configuration example; it was not executed in this documentation update.

```sh
PHOENIX_BRANDING_FILE=/etc/phoenix/branding.json
```

It is deep-merged over the defaults, so a partial file only has to name what it changes.
Serving statically instead? Alias `/branding.json` at your file (there is a commented example
in `deploy/nginx/phoenix.conf`).

### Community invitations

The public site and console invite visitors to the project's Discord community by default.
Set `links.discord` in `branding.json` (or your `PHOENIX_BRANDING_FILE`) to use your own server;
that one value updates the setup prompt, FAQ action, community section, footers, and console
help links. The copy lives under `community`, and the navigation label is `nav.community`.
The HTML also carries the default invite for visitors without JavaScript or a branding response.

A FAQ item can include a `cta` with `label` and `hrefFrom`, for example
`"cta": { "label": "Get help on Discord", "hrefFrom": "links.discord" }`. The shared list
renderer resolves the link from branding, escapes the label, and accepts only the same safe
URLs as other branded links. Existing FAQ items with just `q` and `a` continue to work.

## Files

| File | What it is |
|---|---|
| `theme.css` | Design tokens, reset, and the primitives both surfaces share |
| `site.css` / `site.js` | The public site and legal pages |
| `site-render.js` | Markup for the branded lists, shared by the browser and the account service |
| `../src/brandRender.js` | Renders the merged branding into each page the account service serves |
| `console.css` / `app.js` | The signed-in console |
| `brand.js` | Branding loader and the theme switch, shared by both |
| `../src/admin/configCatalog.js` | Every setting the console shows: whether it can change it, type, default, help, which services read it |
| `../src/admin/consoleSettings.js` | The file settings saved in the console live in, with their history |
| `../src/admin/envFile.js` | Reads the server's environment file to show where a value comes from; never writes it |
| `../src/admin/settingsRoutes.js` | `GET/PUT /api/admin/settings`, `GET /api/admin/services`, `POST /api/admin/services/restart` |
| `../src/admin/launcherControl.js` | The launcher's run state, service probes, and restart requests |
| `../src/admin/adminRoutes.js` | `/api/admin/overview`, `/api/admin/fleet`, `/api/admin/admins` |
| `branding.json` | Every configurable string, the logo and the accent |
| `qr.js` | Robot-pairing QR renderer — **carried over unchanged** |
| `map.js` | Commute location picker |
| `vendor/leaflet.*` | Vendored, not from a CDN — see below |

Dark is the product's own look; light follows the system and can be forced from the theme
switch (stored in `localStorage`, applied before first paint so there is no flash).

No webfont is loaded and no third-party script, style or font is fetched by any page. The
portal runs on a LAN beside the robot and must render with no outside host reachable, which is
also why Leaflet is vendored here rather than pulled from a CDN. Map **tiles** do come from
OpenStreetMap; the picker degrades to manual latitude/longitude entry when they cannot be
reached.

### Browser notifications

Browser notifications are opt-in per browser from **Account → Jibo app and notifications**.
They require HTTPS, a service worker, and VAPID keys configured only on the server. Generate the
keys on that server with:

```sh
node scripts/generate-web-push-vapid.mjs --subject mailto:ops@example.com
```

Place the generated `ETCO_account_webPushSubject`, `...PublicKey`, and `...PrivateKey` in the
deployment's private mode-0600 `.env` or secret manager, then restart Account. Do not commit the
private key. The server sends standard encrypted Web Push directly to the browser's provider—no
Firebase SDK or external analytics dependency is added. Endpoint URLs and their encryption keys
are stored only in the Account store and are never returned to the browser. To prevent a
subscription from becoming an SSRF input, Account accepts only Apple, Mozilla, and FCM endpoint
hosts unless an operator explicitly adds a reviewed public provider hostname.

New Jot messages sent through the console notify selected accepted loop members who opted in (or
all other accepted members when none are selected);
the notification does not contain the message text. A user can send a test or disable the current
browser. Signing out removes this browser's subscription. iPhone/iPad users must first add the
site to the Home Screen from Safari.

## How auth works

- Login/signup uses the **existing account store** — the same account the owner signs into on
  the mobile app. `POST /api/login` authenticates via `store.accountByEmail` + `verifyPassword`
  and issues the `phx_session` cookie (unchanged).
- Every `/api/*` route below checks that session. No second identity system, no parallel user
  store.
- **Frozen contracts (must not change):**
  - `GET /api/verify` — unchanged; the gateway calls it to authorise every robot connection,
    and the skills GQA attribution store calls it too.
  - `POST /api/token` — unchanged, original two-argument contract.
  - The pairing flow — `POST /api/robots/setup`, `GET /api/robots/setup/status`, and the
    multi-frame QR renderer in `qr.js` — is carried over verbatim.

### Email verification

When SMTP is configured, new portal signups receive a verification email before
sign-in. Existing active accounts show a prominent warning until their current
address is verified. Account displays the verification status and a resend
button, shared with the warning's countdown. Resends are limited to one per
minute, five per hour, and twenty per day per account. The sign-in screen also
offers resend for people who have not confirmed their signup yet.

See [Email verification](../../../docs/EMAIL-VERIFICATION.md) for configuration,
link handling, legacy accounts, limits, and local tests.

## The admin surface

Reached at `/app#/admin` (or `/admin`) by an account whose `isAdmin` flag is set. It appears in
the sidebar only for such an account, but that is presentation: every `/api/admin/*` route
re-checks the flag server-side on each request, so a hand-edited client grants itself nothing,
and a revoke takes effect immediately with no stale session to wait out.

Six tabs:

| Tab | Route | What it does |
|---|---|---|
| **Overview** | `#/admin` | Whether everything is running, what needs attention (only one administrator, no speech recognition or email, a full disk, a service running without its saved settings), every service with its uptime and a restart button, the last hour of voice turns, and counts |
| **Settings** | `#/admin/settings` | The settings the console can change, grouped, with where each value comes from — see below |
| **Robots** | `#/admin/robots` | Every robot on this server with its loop, owner and whether it is online; removing a robot or loop, and adopting one by hand |
| **People** | `#/admin/people` | Every account, and who is an administrator; grant and revoke it |
| **Voice turns** | `#/admin/voice-turns` | Per-turn timing, step by step, never what was said ([VOICE-TURN-OBSERVABILITY.md](../../../docs/VOICE-TURN-OBSERVABILITY.md)) |
| **Logs** | `#/admin/logs` | This service's log as it is written, filtered by level, service and text |

The original shortcuts in the page table are retained: `#/admin/config` forwards to
Settings and `#/admin/admins` forwards to People.

### Settings

The catalogue lives in `src/admin/configCatalog.js` — one entry per setting, with its type,
real default, help text, which services read it, and whether the console may change it. Adding
a setting there is the only change needed; the page renders whatever the catalogue declares.

- **The console never writes the server's environment file.** What an administrator saves goes
  to its own file, `<data dir>/config/console-settings.json` (`src/admin/consoleSettings.js`),
  which the launcher layers over the environment file whenever it starts a service. Removing a
  saved value falls back to the server's. Addresses, security secrets, storage paths and the
  release are shown read-only, because they belong to how the server was installed.
- **A change applies when the services that read it restart, and the console restarts them.**
  After a save it names the services still running without the change and offers **Restart
  now**, which restarts only those (`POST /api/admin/services/restart`). The launcher records
  which settings revision each service started with (`<data dir>/run/services.json`), so the
  page knows exactly what is still waiting. Without the launcher (Docker, a service run by
  hand), the page is read-only and says why.
- **A bad value cannot lock anyone out.** Values are validated one by one and together (mail
  settings without a mail server would stop the account service starting), and a service that
  still fails right after starting with saved settings is started again without them.
- **Secrets never leave the server.** The page learns only whether a secret is set (and, for a
  long key the console manages, its last four characters); a new value can be pasted in, never
  read back. History records that a secret was replaced, never its value.

Operating details — the files, the restart protocol and the safe start — are in
[OPERATIONS.md](../../../docs/OPERATIONS.md#settings-and-restarts-from-the-admin-console).

Granting admin from the command line still works and is the way back in if nobody can sign in:

```sh
node scripts/portal-grant-admin.mjs --list
node scripts/portal-grant-admin.mjs --email you@example.com
```

## Console surfaces

| # | Surface | State | Backend call |
|---|---------|-------|--------------|
| 1 | **Loops** — every member, nickname/phonetic name/status, **link/unlink a member to an account**, enrolment | **Complete** | account store, in-process (`portal/loops.js`) |
| 2 | **Personal report** — weather (units), news categories, commute (home/work/mode/departure), calendar flags | **Complete** | account store (`GET/PUT /api/settings`) |
| 3 | **Account** — first/last name, birthday, gender, phone, `messagingAllowed`; change password; change email | **Complete** | account store, in-process (`portal/profile.js`) |
| 4 | **Robots** — loop robot record, `Robot_20160225` read state, add-a-robot QR pairing | **Complete** | account store + `Robot_20160225.GetRobot` via Classic |
| 5 | **Loop details** — rename, suspend/unsuspend, invite + remove members | **Complete** | account store via `loopMembership.js` |
| 6 | **Gallery** — list/view/delete media | **Complete** | `Media_20160725.List/Get/Remove` + blob proxy to Classic |
| 7 | **Loops** — people and account links are consolidated into the selected loop; legacy Person-service data is not presented as user profile data | **Complete** | account store, in-process (`portal/loops.js`) |
| 8 | **Jibo inbox** — Jot history and recipient-aware text compose; browser Push is opt-in from Account | **Partial** (no attachment composer, scheduling, or delivery status) | `Jot_20160512.List/Create`, Account Web Push |
| 9 | **System** — OTA update catalog, IFTTT identity/applets, OAuth clients | **Partial** | `Update_20160301.ListUpdates`, `IFTTT_20170207.*`, account `oauthClients` |

Every partial surface is labelled **partial in the UI**, not only here.

### Browser checks

The browser smoke tests use Playwright as a development dependency and disposable
local services and stores. They cover signup, QR pairing, report settings, admin
adoption, mobile and desktop layouts, profile editing, password changes, account
deletion across tabs, email verification, and encrypted gallery recovery.

```sh
npm ci
npx playwright install chromium
npm run test:portal
```

Set `CHROME_BIN` to use an already installed Chromium. Set `PORTAL_SMOKE_OUT` or
`EMAIL_VERIFICATION_SMOKE_OUT` to a local directory to save layout screenshots.
The tests need no sibling checkout, live server, mailbox, or robot. Backend peers
outside the fixtures are unavailable, so the console also exercises their visible
error states.

### What each surface calls

- **Surfaces owned by the account service** (household, members, account, settings, oauth
  clients) operate directly on the account store and the source-shaped helpers in
  `loopMembership.js`/`settingsFace.js` — no HTTP round-trip.
- **Everything the Classic entrypoint owns** is called the way the app does: `POST /` with an
  `X-Amz-Target` header, SigV4-signed with the logged-in account's `accessKeyId` /
  `secretAccessKey` (`src/portal/classicClient.js`). For handlers that read the gateway's
  forwarded identity (`x-amz-credentials`: person, voicetraining, update, ifttt) the portal
  forwards `{id, email}` it already knows from the session — never a secret.

### The news bug and its fix

The motivating failure — *"Missing creds for Settings request. Got accountID: false | loopID:
true"* — is fixed by the **member→account link**. The report skill resolves a speaker's settings
through `member.accountId`; of the loop's 20 members only 4 had one. On the **Loops** page
the owner can search the account store and **Link** any member to any account (and unlink).
Unlinked members sort first and are visibly flagged, and the Overview counts them. Verified in
`test/portalMembers.test.js`.

## Deployment

For a public deployment behind nginx, follow the focused [Phoenix portal nginx hosting guide](../../../docs/portal-nginx-hosting.md).
It covers the real static route inventory, standalone versus colocated account ports and binds,
TLS/ACME, the separate robot-facing Classic entrypoint, admin gating, rate limits, cache headers,
verification, troubleshooting, and rollback. The account service can serve the same portal files
directly, but nginx is the recommended public front door for static delivery.

## What was intentionally not implemented, and why

- **Media upload / photo_booth.** Media `Create` is a streaming binary upload; the app's Gallery
  write path is robot/device-driven. The console implements the read/delete side.
- **Jibo inbox** preserves Jot's loop-wide visibility: recipients are intended recipients and alert
  targets, not a private audience. Browser Push is a separate, opt-in console capability and does
  not claim to mirror every robot notification.
- **OTA** shows the catalog a robot would be offered; it does not push firmware from the browser.
- **IFTTT** shows identity and applet rows, and reports an explicit diagnostic when the IFTTT
  realtime API is dead (it is).
- **OAuth clients** are listed read-only from the account store registry.
- Legacy native push delivery (APNs/FCM) has no live provider — those registrations are shown and
  removable. Browser Web Push uses the browser's standard provider with the server's VAPID key.
