# Phoenix web portal — the public site and the household console

This directory is the **whole** web front end: a public marketing site, the legal pages, and
the signed-in console that does what the Jibo mobile app could do. It is served in place by
the account service — same process, same port, same origin, same session cookie — or as static
files behind a reverse proxy with `/api` (and, when photo storage is enabled, `/member-photos/`)
proxied back (see `deploy/nginx/`).

There is no build step, no framework and no npm dependency. Plain HTML, CSS and ES modules.

## URLs

| URL | Serves | Notes |
|---|---|---|
| `/` | `index.html` | Public landing page |
| `/terms`, `/privacy`, `/security` | the legal pages | Static, no session needed |
| `/app` | `app.html` | The console. Hash routes beneath it (`#/loop`, `#/settings`, …) |
| `/admin` | `app.html` | The admin surface, available to accounts with `isAdmin` |
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
  "tagline": "The cloud Jibo can talk to again.",
  "logo": "/assets/my-logo.svg",   // optional; replaces the built-in mark
  "accent": "#3b82f6",             // optional; one hex re-skins the product
  "hero": { "title": "…", "body": "…" },
  "features": { "items": [ … ] }
}
```

Keys map to `data-brand="hero.title"` attributes in the HTML, and repeating lists
(`features.items`, `faq.items`, `status.metrics`, `footer.columns`, `install.steps`,
`pipeline.stages`) are rendered from the same config by `site.js`.

**The HTML carries every default inline.** `brand.js` only overwrites what an override
actually sets, so the pages are complete and readable before any script runs — and with
JavaScript off entirely.

To customise without editing a file inside the checkout, point the account service at your own
JSON. The following is a configuration example; it was not executed in this documentation update.

```sh
PHOENIX_BRANDING_FILE=/etc/phoenix/branding.json
```

It is deep-merged over the defaults, so a partial file only has to name what it changes.
Serving statically instead? Alias `/branding.json` at your file (there is a commented example
in `deploy/nginx/phoenix.conf`).

## Files

| File | What it is |
|---|---|
| `theme.css` | Design tokens, reset, and the primitives both surfaces share |
| `site.css` / `site.js` | The public site and legal pages |
| `console.css` / `app.js` | The signed-in console |
| `brand.js` | Branding loader and the theme switch, shared by both |
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

## Console surfaces

| # | Surface | State | Backend call |
|---|---------|-------|--------------|
| 1 | **Household** — every member, nickname/phonetic name/status, **link/unlink a member to an account**, enrolment | **Complete** | account store, in-process (`portal/loops.js`) |
| 2 | **Personal report** — weather (units), news categories, commute (home/work/mode/departure), calendar flags | **Complete** | account store (`GET/PUT /api/settings`) |
| 3 | **Account** — first/last name, birthday, gender, phone, `messagingAllowed`; change password; change email | **Complete** | account store, in-process (`portal/profile.js`) |
| 4 | **Robots** — loop robot record, `Robot_20160225` read state, add-a-robot QR pairing | **Complete** | account store + `Robot_20160225.GetRobot` via Classic |
| 5 | **Household record** — rename, suspend/unsuspend, invite + remove members | **Complete** | account store via `loopMembership.js` |
| 6 | **Gallery** — list/view/delete media | **Complete** | `Media_20160725.List/Get/Remove` + blob proxy to Classic |
| 7 | **People** — person-catalog answers, account/loop properties, holidays, voice-training state | **Partial** (read-only) | `Person_20160801.*`, `VoiceTraining_20151020.ListVoiceTrainings` |
| 8 | **Messages** — Jot messages, notification socket status, push registrations | **Partial** (Jot + push + status read) | `Jot_20160512.List/Create`, `Notification_20150505.GetStatus`, `Push_20160729.RemoveDevice` |
| 9 | **System** — OTA update catalog, IFTTT identity/applets, OAuth clients | **Partial** | `Update_20160301.ListUpdates`, `IFTTT_20170207.*`, account `oauthClients` |

Every partial surface is labelled **partial in the UI**, not only here.

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
through `member.accountId`; of the loop's 20 members only 4 had one. On the **Household** page
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
- **Person catalogue** is read-only (list answers, properties, holidays, voice-training state).
  Answering the "this or that" questions is a phone-side flow; no handler is stubbed.
- **Notifications** shows socket status; the robot's push socket and delivery are robot-side.
- **OTA** shows the catalog a robot would be offered; it does not push firmware from the browser.
- **IFTTT** shows identity and applet rows, and reports an explicit diagnostic when the IFTTT
  realtime API is dead (it is).
- **OAuth clients** are listed read-only from the account store registry.
- Push **delivery** (APNs/FCM) has no live provider — registrations are shown and removable.
