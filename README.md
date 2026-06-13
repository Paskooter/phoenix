# Phoenix

A **ground-up reimplementation** of *Pegasus* — the cloud backend that powered the Jibo social
robot's conversation (ASR → NLU → skills → multimodal response). Phoenix is a clean,
modern-JavaScript rewrite; the original is used only as a **behavioral reference**, never
copied, and **no Jibo binaries ship** — the NLU engine, MIM dialog engine and every service are
reimplemented, with only plain-text data vendored (grammars, MIMs, word lists, manifests).

- **Reference & specs:** [`jiboV2/pegasus@phoenix`](https://pvindex.org/gitea/jiboV2/pegasus) and
  its `docs/atlas/` (full system documentation + the rebuild plan this repo follows).
- **Stack:** Node.js ≥ 20, ESM JavaScript, npm workspaces, a single external dependency (`ws`).
  Tests use the built-in `node:test` runner.
- **Status: the conversational rebuild is complete** (atlas milestones M1–M9, phases A–F). See
  **[M9-REPORT.md](M9-REPORT.md)** for the parity report — headline numbers: **98.2 %** intent
  parity and **96.8 %** MIM-routing parity against the reference test corpus (10,035 utterances),
  full wire-protocol conformance against the robot's own `hub-client` framing. Two further phases
  extend it to a full robot-revival cloud: **phase G** — per-robot authentication + the OOBE web
  portal (`packages/account`); **phase H** — the remaining **Classic Services** behind one
  entrypoint (`packages/classic`). 228 tests green across all packages.

## What works

A robot (or the browser sim) connects over WebSocket, speaks — literally, over the microphone —
and the full pipeline runs: server-side ASR (energy VAD → Parakeet REST), the pure-JS
launch-rule grammar engine with FST weight semantics, intent routing, and the real skills:
the **personal report** (weather / news / commute / calendar with the original MIM condition
tables), **chitchat** (the full 4,424-MIM content library), **answer** (LLM-backed), plus the
proactive channel with the opt-in flow, multi-turn GraphSkill sessions, redirects and global
commands. Dead 2018 data vendors are shimmed live (Open-Meteo, RSS, OpenRouteService) behind
the original relay envelopes; every intentional deviation is logged in
[DIVERGENCES.md](DIVERGENCES.md).

## Layout

```
packages/
  contracts/   the frozen wire contracts — envelope, schemas, builders, validator
  common/      shared service scaffolding — env/service discovery, HTTP runner, JWT, logging
  harness/     verification — stream diff, corpus runner (D3/D4), SkillConversation + fixtures
  gateway/     hub — WS listen FSM, auth, server-side ASR (VAD+Parakeet), routing, proactive
  nlu/         parser — pure-JS grammar engine (FST semantics), eq_words, factory entities, LLM fallback
  data/        lasso — weather/news/maps/calendar relays (2026 shims) + credentials
  history/     skill-launch (IH query language) + speech history
  skills/      baseskill framework (GraphSkill, MIM factories, Slimmer, OptIn) + all skills
  ota/         OTA update server (extension) — serves firmware subsystems to a robot in place
  account/     account/loop/OOBE/settings Classic Service + web portal + per-robot hub-token auth
  classic/     the Classic-Service entrypoint — one front door for log/robot/notification/key/push/… (extension)
```

## Running it — without Docker

```bash
npm install        # links the workspaces (offline-friendly; only `ws` is external)
```

**Run the full server** — every service on the reference port layout, no containers:

```bash
bash scripts/run-compose-stack.sh
# conversational: hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005
#                 history 9006 · lasso 9007 · answer-skill 9009
# robot-revival:  ota 9010 · account+portal 9011 · classic entrypoint 9012   (Ctrl-C stops all)
```

Robots and clients connect to the hub at `ws://<host>:9000/listen` (HTTP API on the same
port: `GET /healthcheck`, `GET /v1/skills`); a robot's Classic Services (OOBE, update, log, …)
go to the classic entrypoint on `:9012`. Logs land in `/tmp/phx-compose-*.log`.

Useful env, all optional:

| Variable | Effect |
|---|---|
| `PARAKEET_URL` | Parakeet ASR host for server-side speech recognition (`POST /transcribe`) |
| `LLM_URL`, `LLM_MODEL` | OpenAI-compatible endpoint (e.g. LM Studio) for the answer-skill + parser fallback |
| `HUB_TOKEN_SECRET` | JWT secret robots must sign with (default `dev-hub-token-secret`) |
| `DISABLE_AUTH` | defaults `true` for local use — set `false` to require robot JWTs |
| `ADMIN_PASSWORD` | password for the portal's admin page (`/#/admin`); unset = admin disabled |
| `PREFS_FROM_CONFIG` | `true` = personal-report prefs from `resources/report-prefsConfig.json` |

The launcher also starts the **OTA** server (`:9010`), the **account service + web portal**
(`:9011`), and the **classic-service entrypoint** (`:9012`, the robot's single front door);
disable with `OTA=0` / `ACCOUNT=0` / `CLASSIC=0`. Copy `.env.example` → `.env` to set the above
(every variable is documented there). See **Classic services** and **Web portal + robot
adoption** below.

**Or run the sim stack** — the same services on dev ports **plus the browser simulator**
([jibo-web-sim](https://github.com/Paskooter/jibo-web-sim), expected as a sibling checkout),
the easiest way to actually talk to it:

```bash
bash scripts/run-sim-stack.sh
# then open http://localhost:8080  (or https://<host>:8443 for microphone access)
```

This launcher auto-detects the optional LAN services and degrades gracefully without them
(the ASR falls back to a mock that saves received audio to `/tmp/parakeet-rx`).

## Running it — with Docker

`docker-compose.yml` mirrors the reference deployment exactly — same service names, host
ports and `NET_*`/`ETCO_*` wiring, so each Phoenix service is a drop-in substitute for its
pegasus counterpart:

```bash
docker compose up
# conversational: hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005
#                 history 9006 · lasso 9007 · answer-skill 9009
# robot-revival:  ota 9010 · account+portal 9011 · classic entrypoint 9012   (all 8080 inside)
node scripts/verify-compose-contract.mjs   # same contract check as the native runner
```

Optional env (LAN ASR/LLM, like the reference override file):

```bash
PARAKEET_URL=http://<host>:6972 LLM_URL=http://<host>:1234/v1 docker compose up
```

## OTA update server (robot firmware revival)

A robot stuck on its 2017 factory platform (e.g. RTM3 OS/services **3.3.4**) predates the
Jetstream/Pegasus stack Phoenix talks to. The `ota` service (`packages/ota`) lets the robot
climb to a modern build **in place** — the OS update writes the *inactive* rootfs slot and
flips `activeroot`, never touching `/var`, so **per-robot calibration is preserved** (unlike a
wiping re-flash). It reimplements the Jibo cloud `Update` service (`update-2016-03-01`):

```
POST /                       AWS-JSON-1.1, dispatched by X-Amz-Target:
                               Update_20160301.ListUpdates       -> [Update,…]
                               Update_20160301.ListUpdatesFrom    -> [Update,…]
                               Update_20160301.GetUpdateFrom      -> Update | 404 NoUpdateAvailable
GET  /ota/package?id=<id>     the package tarball, streamed with Content-Length + verifiable SHA-1
GET  /healthcheck
```

The robot's `jibo-server-client` signs these (SigV4); like the hub's `DISABLE_AUTH`, the OTA
server does not verify the signature — it trusts the LAN.

**1. Build the packages** from a flash buildroot (defaults to **13.0.0 "Last Dance"**, the final
production firmware; pass `--buildroot`/`--version` for 12.10.0 or any other build):

```bash
scripts/build-ota-packages.sh                       # → packages/ota/data/{os,services}-13.0.0.tar
# earlier build instead:
scripts/build-ota-packages.sh \
  --buildroot https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.10.0-20180823-production.tar.bz2 \
  --version 12.10.0
```

Each `<subsystem>-<version>.tar` is the reference OTA format (an uncompressed tar wrapping
`filesystem.tar.bz2`). Needs `bzip2` and either root (loop mount) or `debugfs` (e2fsprogs).
`manifest.json` lists both `13.0.0` and `12.10.0` (os + services); the server computes each
package's real length + SHA-1 at startup, serves the highest available `toVersion`, and silently
skips any not yet built. Use only **production** (`-prod`/`-production`) buildroots for a
prod-fused robot — see the build repo `…/platformos/builds/sqa-testing/`.

**2. Run it** (started by `run-compose-stack.sh` on **:9010**, or standalone):

```bash
npm run start:ota        # PORT=7015 default; ETCO_ota_dataDir / ETCO_ota_manifest / ETCO_ota_publicUrl
```

**3. Point the robot at it.** The robot resolves its Update endpoint from `region` in
`/var/jibo/credentials.json` → `https://<region>.jibo.com` (a global endpoint shared by all
server-client services), so make that host resolve to this server (DNS or `/etc/hosts` on the
robot) and `credentials.json` exist. Then a normal `checkForUpdates` walks os→services→reboot,
calibration intact. `fromVersion: "*"` in the manifest matches any installed version (with a
loop-guard so it stops once the robot already runs the target).

> Scope: this serves whatever packages you build — `os`/`services` from the buildroot, and any
> skill subsystem (`be`, `oobe-config`, …) you add to `manifest.json`. It does **not** sign
> images; a production-fused robot still needs Jibo-signed bootloaders (use official signed
> builds, or the secure-boot flash). It is a Phoenix *extension*, excluded from the reference
> conversational-contract check.

`update` is one of the robot's **Classic Services** (its cloud REST API surface). For the full
inventory and how to add another, see **[CLASSIC-SERVICES.md](CLASSIC-SERVICES.md)**.

## Classic services (the robot's cloud API)

The robot resolves *every* server-client service to one host (`https://<region>.jibo.com`) and
distinguishes them by an `X-Amz-Target` prefix. `packages/classic` is that **single front door**:
one AWS-JSON endpoint (`:9012`) that dispatches by prefix — handling lightweight services
in-process and proxying the stateful ones to their dedicated process. Point the robot's region at
this one port (`scripts/point-robot-at-phoenix.sh`) and it reaches everything.

```bash
# started by run-compose-stack.sh on :9012 (CLASSIC=1), or `docker compose up`
curl -s :9012/ -H 'x-amz-target: Robot_20160225.GetRobot' -d '{"id":"…"}'   # in-process
curl -s :9012/ -H 'x-amz-target: OOBE_20161026.SetupRobot' -d '…'           # -> account svc
```

| Service | Prefix | Status | Notes |
|---|---|---|---|
| update (OTA) | `Update_*` | ✅ end-to-end | firmware revival; `packages/ota` |
| account / loop / oobe | `OOBE_*` `Account_*` | ✅ end-to-end | pairing + portal; `packages/account` |
| settings | `Settings_*` | ✅ end-to-end | the personal report's per-user prefs |
| log | `Log_*` | ✅ wire | robot telemetry upload (no-op sink) |
| robot | `Robot_*` | ✅ wire | boot-time read records (calibration stays local) |
| notification + socket | `Notification_*` | ✅ wire | the wss push door (`/socket/<token>`) |
| key | `Key_*` | ✅ wire | UGC encryption-key exchange |
| push | `Push_*` | ◑ stub | device register; delivery no-op (no APNs/FCM/app) |
| rom · media · person · backup · ifttt · nlp · collision | various | ◑ build-to-spec | wire-tested shapes; need the app/hardware to exercise |

"end-to-end" = verified working through the real consumer; "wire" = the robot protocol is
verified (the live robot seam is pending hardware); "build-to-spec / stub" = implemented to the
contract but unverified without the mobile app — see [DIVERGENCES.md](DIVERGENCES.md).

## Web portal + robot adoption

`packages/account` is the second Classic Service: the **account / loop / OOBE** service, with a
small **web portal** in front (responsive vanilla HTML/JS, no build step). It does two jobs:

**1. Pair a brand-new (or factory-reset) robot — the real OOBE handshake.**

```bash
# started by run-compose-stack.sh on :9011, or `docker compose up`
open http://localhost:9011        # or your public URL
```

Sign up → **Add a robot** → enter your home WiFi → the portal renders the setup **QR**. Hold it
up to Jibo's eye; he scans it (WiFi creds + a one-time token), joins the network, and calls
`OOBE.setupRobot` against this service, which mints his permanent `accessKeyId`/`secretAccessKey`,
attaches him to your loop, and returns them — the robot writes them to `/var/jibo/credentials.json`
itself. The portal polls until he's done and lists him. (The QR payload and encoder are a
from-scratch reimplementation of the robot's `oobe-config` format — see `packages/account/portal/qr.js`.)

**2. Adopt an existing robot — one that paired with the original Jibo cloud years ago.**

Its old credentials are worthless (that database is gone), so adoption *re-issues* them. Open the
admin page (`/#/admin`, gated by `ADMIN_PASSWORD`), enter the robot's 4-word name, and it returns
the exact `credentials.json` to write plus the repoint command:

```bash
ssh root@<robot> jibo-mount --rw
# write the credentials.json the admin page shows to /var/jibo/credentials.json
# repoint the robot (LAN): region_config -> classic entrypoint :9012, hub -> :9000
#   args: <robot-ip> <phoenix-ip> [classic-port=9010] [hub-port=9000]  — pass 9012 for the entrypoint
scripts/point-robot-at-phoenix.sh <robot-ip> <this-host> 9012 9000
```

The admin page also lists **every adopted robot** across all accounts (name, owner, loop, access
key, last-seen).

## Per-robot authentication

By default the hub trusts the LAN (`DISABLE_AUTH=true`) — fine at home. For a public deployment,
turn on real per-robot auth:

- Each robot has its own `accessKeyId`/`secretAccessKey` (issued at pairing/adoption, above).
- A robot exchanges them for a short-lived hub token: `POST /api/token {accessKeyId,
  secretAccessKey}` → an HS256 JWT signed with `HUB_TOKEN_SECRET`, carrying its identity (never
  the secret), 3-hour expiry. (The robot's own Jetstream client may instead sign a token locally
  with the shared secret — both modes work; the gateway only verifies the signature + identity.)
- The hub verifies that token's signature, checks its `exp`, and — when `ETCO_hub_accountUrl` is
  set — confirms the `accessKeyId` still maps to a live account (`GET /api/verify`), so you can
  **revoke** a robot by deactivating its account. The secret never leaves the server.

Set `DISABLE_AUTH=false` (and a strong `HUB_TOKEN_SECRET`) to require it.

## Running it publicly

Phoenix has no built-in TLS; put a reverse proxy in front and expose **only three** entry
points — everything else stays bound to localhost behind the proxy:

| Public host | → backend | Who connects | Why |
|---|---|---|---|
| `hub.example.com` (wss) | `:9000` | the robot's Jetstream / the sim | conversation (ASR→NLU→skills) |
| `your-region.jibo.com` (https) | `:9012` | the robot's `jibo-server-client` | **all** Classic Services (OOBE, update, log, robot, notification, …) — the entrypoint front door |
| `phx.example.com` (https) | `:9011` | you, in a browser | the web portal (pair/adopt robots, settings, admin) |

The robot resolves every server-client service to one host (`https://<region>.jibo.com`), so that
name must point at the **classic entrypoint (`:9012`)** — not the portal. The entrypoint proxies
OOBE/account/settings → account (`:9011`) and Update → ota (`:9010`) internally, so you don't
expose those directly. The internals (`:9003`–`:9010`) never face the internet.

A minimal **Caddy** config (automatic Let's Encrypt TLS; Caddy upgrades WebSockets transparently):

```caddyfile
hub.example.com        { reverse_proxy localhost:9000 }   # robot conversation (wss) + the sim
your-region.jibo.com   { reverse_proxy localhost:9012 }   # the robot's Classic-Service front door
phx.example.com        { reverse_proxy localhost:9011 }   # the human web portal

# Optional — push notifications to the robot. The robot's wss notification door is a separate
# host (<region>-socket.jibo.com); the entrypoint serves that socket on the same :9012.
your-region-socket.jibo.com { reverse_proxy localhost:9012 }
```

Then:

1. **`cp .env.example .env`** and set, at minimum:
   ```
   ADMIN_PASSWORD=<long random>            # gates the portal admin page
   HUB_TOKEN_SECRET=<long random>          # NOT the dev default
   DISABLE_AUTH=false                      # require per-robot hub auth
   ETCO_account_secureCookies=true         # session cookies only over HTTPS
   ETCO_account_region=your-region         # must match the robot's region
   ```
   (The hub's per-robot revocation check, `ETCO_hub_accountUrl`, is already wired by both bundled
   launchers — run-compose-stack points it at the account service and starts all three
   front-end services; with Docker the `account` env comes from `.env` via `env_file`.)
2. **Point the robot at you.** Set the robot's `region` (in `/var/jibo/credentials.json`) to
   `your-region`, and add **public DNS**: `your-region.jibo.com` → your proxy (the robot calls
   `https://<region>.jibo.com` natively, so DNS + TLS is all it needs), plus `hub.example.com`
   for Jetstream and the `-socket` host if you want notifications. For LAN/no-DNS testing instead,
   `scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> 9012 9000` rewrites `region_config`
   (→ `http://<phoenix>:9012`) and the Jetstream hub target over SSH. (That script repoints the
   REST `region_config`; the robot's notification **wsendpoint** must still be repointed by hand —
   see [DIVERGENCES.md](DIVERGENCES.md).)
3. **Firewall the internals.** Bind `:9003`–`:9010` to `127.0.0.1` (or block them at the host
   firewall). Only `:9000`, `:9011`, and `:9012` should be reachable — and only through TLS.

> **Security caveat — read before exposing this.** Phoenix does **not** verify the AWS SigV4
> signatures on the robot's Classic-Service requests (the original per-robot signing keys are
> unrecoverable) — it trusts the network. So anyone who can reach `:9012` can call the
> robot-facing OOBE/classic ops. The real access controls are: the `ADMIN_PASSWORD` gate on the
> portal admin page, per-robot hub auth (`DISABLE_AUTH=false` + a strong `HUB_TOKEN_SECRET`, with
> account-backed revocation via `ETCO_hub_accountUrl`), and TLS at the proxy. Treat a public
> deployment accordingly. Full ledger in [DIVERGENCES.md](DIVERGENCES.md).

## Verification

The rebuild was driven by measurement, not vibes:

```bash
npm test                                      # unit + integration (all packages)
node packages/harness/src/corpusRunner.js     # D3/D4 parity over the 10,035-utterance corpus (~15 min)
node scripts/verify-compose-contract.mjs      # runtime/wire contract
../jibo-web-sim/test/phoenix-be-skill.mjs     # full WS protocol harness (turns, audio, proactive)
../jibo-web-sim/test/phoenix-voice-browser.mjs # real-browser mic -> server ASR e2e
```

Plus a dev-only oracle harness that grades the grammar engine against the surviving `jibo-nlu`
binary (the binary is never shipped). History: [WORKLOG.md](WORKLOG.md); plan + status:
[PARITY.md](PARITY.md) / [ROADMAP.md](ROADMAP.md); deviations: [DIVERGENCES.md](DIVERGENCES.md);
final report: [M9-REPORT.md](M9-REPORT.md).
