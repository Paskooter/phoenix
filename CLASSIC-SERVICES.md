# Classic Services — inventory, status & agent handoff

> **Purpose.** Phoenix began as a reimplementation of the *Pegasus* conversational backend
> (hub / NLU / skills). Reviving a real robot to full cloud-era function needs more than that:
> it needs the **Classic Services** — the robot's cloud REST API surface. This doc inventories
> every classic service, marks what Phoenix has built vs. not, and leaves enough context for a
> fresh agent to continue without re-deriving the landscape.
>
> **TL;DR of current state:** **two** classic services are implemented — **`update`** (firmware
> OTA) as `packages/ota`, and **`account` + `loop` + `oobe`** (pairing/identity + the OOBE
> `setupRobot` handshake + per-robot hub-token issuance + the web portal) as `packages/account`
> (`@phoenix/account`). The rest below is unbuilt. The conversational stack (hub/parser/skills)
> is Phoenix's main body and is separate from these.

---

## 1. Orientation — two service families

The Jibo cloud was two distinct families:

| Family | Transport | What | Phoenix status |
|---|---|---|---|
| **Pegasus services** | WebSocket → the **hub**, which routes onward | Conversation: ASR → NLU → skills → multimodal response | **This is Phoenix.** `packages/{gateway,nlu,skills,history,data}` reimplement it (M1–M9). |
| **Classic services** | `jibo-server-client` (a fork of aws-sdk-js) → **AWS-JSON-1.1 REST RPC** | Accounts, loops, robot lifecycle, firmware, keys, notifications, media, logs… | Only **`update`** built so far (`packages/ota`). |

This doc is about the **classic** family.

### How a robot reaches a classic service

`jibo-server-client` resolves every service to a single **global endpoint** from the robot's
`region` (in `/var/jibo/credentials.json`):

```
region "stg1-entrypoint"  →  https://stg1-entrypoint.jibo.com      (REST, all services share this host)
                          →  wss://stg1-entrypoint-socket.jibo.com  (the WebSocket door)
```

Services are **multiplexed on one host** and dispatched by the `X-Amz-Target: <Prefix>.<Operation>`
header (AWS-JSON protocol, `targetPrefix` per service). So a single Phoenix process *can* host
many classic services by routing on the target prefix — `packages/ota` only answers
`Update_20160301.*`, but an entrypoint router could fan out by prefix.

**To point a robot at a Phoenix replacement** (no DNS/TLS needed): rewrite the `region_config.json`
endpoints on the robot — see **`scripts/point-robot-at-phoenix.sh`** (does this + the Jetstream hub
override in one SSH pass) and **`scripts/robot-repoint-server-client.sh`** (region_config only).
SigV4 signing on the robot's requests is **not verified** by our services (we trust the LAN, like
the hub's `DISABLE_AUTH`).

### The robot-facing API shapes are already vendored

Every classic service's wire contract lives in the archive at
`server/jibo-server-client/apis/<name>-<date>.normal.json` (operations, input/output shapes,
`targetPrefix`, `signatureVersion`). **Read the relevant `*.normal.json` first** when building a
new service — it is the authoritative request/response definition. The original server
implementations are the `srv-*-ws` repos under `jiborobot/` (and `server/`) in gitea.

### The implementation pattern (copy `@phoenix/ota`)

A classic-service shim in Phoenix is small:
1. HTTP service via `@phoenix/common` `createService`.
2. One route `POST /` that reads `X-Amz-Target`, dispatches by operation name, returns AWS-JSON
   (`application/x-amz-json-1.1`); errors as `{__type, message}` + `x-amzn-errortype` header.
3. Ignore the `Authorization` (SigV4) header.
4. Mirror the original controller's behavior (read its `srv-*-ws/src/controllers`).

`packages/ota/src/{service,catalog,awsJson}.js` is a complete worked example, including the
gotchas (see §4).

---

## 2. Full inventory & status

**Legend:** ✅ implemented · 🟡 covered elsewhere / partial · ⬜ not implemented · ➖ not needed for robot revival (internal/web/admin)

### Robot-facing (the robot's `jibo-server-client` calls these directly)

| Service | API def (`jibo-server-client/apis/`) | Original repo | What it does | Status | Revival relevance |
|---|---|---|---|---|---|
| **update** | `update-2016-03-01` | `server/update-ws`, `jiborobot/srv-update-ws` | Firmware OTA: tells the robot which os/services/skill subsystems have updates; serves the packages | **✅ `packages/ota`** | **Done.** See §4. |
| **account** | `account-2015-11-11` | `srv-account-ws` (in `jiboV2/pegasus/.../cloud-services`) | Accounts; **issues the robot's `accessKeyId`/`secretAccessKey` during OOBE** (`setupRobot`); owns the Loop | **✅ `packages/account`** | **Done.** OOBE `setupRobot`/`prepareRobot`/`getStatus` over AWS-JSON, plus the web portal that mints setup tokens + QR, and per-robot hub-token issuance (`/api/token`, `/api/verify`). v1 = the new-robot + same-robot-reissue paths (reconnect/suspended-loop/managed-members deferred). |
| **loop** | `loop-2016-03-24` | (part of `srv-account-ws`) | The "Loop" = a Jibo household: members, ownership, which robot belongs to whom | **✅ `packages/account`** | **Done** (v1: one owner, N robots, one robot per loop; find-or-create robot account, getLoopName dedupe). |
| **robot** | `robot-2016-02-25` | `jiborobot/srv-robots-ws` | Robot manufacturing/lifecycle events (registration, RMA, fuse state) | ⬜ | Tier 2 — identity/registration. |
| **robotread** | — | `jiborobot/srv-robots-read-ws` | Read-side snapshot of robot state (CQRS pair of `robot`) | ⬜ | Tier 3. |
| **key** | `key-2016-02-01` | `jiborobot/srv-key-ws` | Manages the keys used to encrypt robot↔server↔mobile user data (UGC) | ⬜ | Tier 2 — needed for encrypted user content & some account flows. |
| **notification** | `notification-2015-05-05` | `jiborobot/srv-notification-ws` | Robot + mobile notifications in response to events (the thing Commander/PNs ride on) | ⬜ | **Tier 2 — Commander/remote.** |
| **push** | `push-2016-07-29` | `jiborobot/srv-push-ws` | Delivers mobile push notifications | ⬜ | Tier 2 — mobile app only. |
| **media** | `media-2016-07-25` | `jiborobot/srv-media-ws` | Upload/download photos & recordings to cloud (Snap, Jot) | ⬜ | Tier 3 — feature. |
| **log** | `log-2015-03-09` | `jiborobot/srv-log-ws` | Robot log upload to cloud | ⬜ | Tier 3 — telemetry; safe to stub/no-op. |
| **skill** | `skill-2015-11-03` | (locate — likely `srv-account-ws` or a skill-store repo) | Skill store / install metadata | ⬜ | Tier 3 — 3rd-party skill install. |
| **person** | `person-2016-08-01` | `jiborobot/srv-person-ws` | Person-specific properties (e.g. holidays) | ⬜ | Tier 3 — feature. |
| **voicetraining** | `voicetraining-2016-01-03` | (locate) | Sync voice-enrollment / speaker-ID models to cloud | ⬜ | Tier 3 — on-robot enrollment may work without it. |
| **jot** | `jot-2016-05-12` | (locate) | Cloud storage for the Jot skill (video messages) | ⬜ | Tier 3 — feature. |
| **backup** | — (system-manager `/system/backup`) | `jiborobot/srv-backup-ws` | Robot backup/wipe/restore to cloud | ⬜ | Tier 3 — nice for migration; not needed to run. |
| **entrypoint-socket** | — (the `wss://…-socket` door) | `jiborobot/srv-entrypoint-socket-ws` | Exposes the robot's WebSocket; works with `notification` to push events to the robot | ⬜ | **Tier 2 — transport for Commander/notifications.** Pairs with `notification`. |
| **rom** | `/docs/.../ROM.html` | `jiborobot/srv-rom-ws` | Remote Operation Mode backend = **Commander** (drive the robot from the app) | ⬜ | Tier 2 — Commander. |
| **gqa** | — (consumed by the hub, not the robot directly) | `jiborobot/srv-gqa-ws` (Python) | General Q&A ("who is X") | **🟡** | **Replaced** by `packages/skills` answer-skill (LLM-backed) via the hub. No classic shim needed. |
| **security** | — | `jiborobot/srv-security-gw` | Auth gateway fronting all the APIs | **➖** | Bypassed: we repoint `region_config` and our services ignore SigV4. |

### Not robot-facing (internal / web / admin / integrations — low priority for revival)

| Service | Repo | What | Status |
|---|---|---|---|
| app-toolkit-manager | `srv-app-toolkit-manager` | OAuth clientIds/ACOs for App Toolkit apps | ➖ |
| oauthclients | `srv-oauth-clients-ws` | OAuth client registry | ➖ |
| saml | `srv-saml-ws` | SAML SSO endpoint | ➖ |
| customer-portal | `srv-customer-portal` | Web: reset password, confirm email | ➖ |
| collision | `srv-collision-ws` | Resolve username collisions | ➖ (small dep of account flows) |
| ifttt | `srv-ifttt-ws` | IFTTT integration | ➖ (skill feature) |
| salesforce | `srv-salesforce-ws` | SalesForce CRM facade | ➖ |
| poll | `srv-poll-ws` | AP-News feed → Mongo for GQA | ➖ (obsolete post-Fajita; Phoenix `lasso` shims news) |
| logparser | `jiborobot/logparser` | Parse ASR/NLU logs (ES/S3) | ➖ (analytics) |
| redis | — | Event bus / cache for security-gw | ➖ (infra) |
| cleanup / lps / parser | (listed `?` on the Classic Services wiki) | uncertain — confirm before relying | ➖ |

---

## 3. What's left, by priority (for "make a robot work like the cloud did")

- **Tier 1 — pairing/identity**: ✅ **done** — `account` + `loop` + `oobe` in `packages/account`,
  with the web portal (signup/login, add-a-robot QR, robot list, admin adopt) and per-robot hub
  auth. Real app-driven OOBE works; hand-writing `/var/jibo/credentials.json` (or the admin
  adopt page) remains the path for an already-paired robot. See **README → Web portal + robot
  adoption** and the build notes in [`OOBE-PORTAL-HANDOFF.md`](OOBE-PORTAL-HANDOFF.md).
- **Tier 2 — remote control & notifications** (Commander, push, the phone app live features):
  `entrypoint-socket` (the `wss` door) + `notification` + `push` + `rom` + supporting `key`, `robot`.
  This is the biggest unbuilt cluster and the next obvious milestone after OTA.
- **Tier 3 — features**: `media`, `person`, `voicetraining`, `jot`, `backup`, `log`, `skill`, `ifttt`.
  Most can be stubbed (return empty/no-op) without breaking the robot.

A robot can be **alive, conversational, self-updating, and app-pairable today** with: Phoenix
hub (✅) + `update` (✅) + `account`/`loop`/`oobe` + portal (✅). Tiers 2–3 add the remaining
cloud parity (Commander, notifications, media, …).

---

## 4. State of the one we built — `update` / `packages/ota`

Context so the next agent doesn't relearn it:

- **What it is:** AWS-JSON `Update` service + a package file server. Audited against the original
  `server/update-ws` (`src/controllers/update.ctrl.js`) — faithful on protocol, fields, version
  sort, and the no-update error code; see `DIVERGENCES`-style notes in §below.
- **Pieces:** `src/service.js` (wire), `src/catalog.js` (matching + Update shape), `src/awsJson.js`
  (helpers), `manifest.json` (the catalog), `scripts/build-ota-packages.sh` (turns a flash
  buildroot into `os`/`services` OTA packages). Default target build: **13.0.0 "Last Dance"** (the
  final production firmware); `12.10.0` also in the manifest.
- **Robot side:** `system-manager/src/UpdateManager.cpp` drives `checkForUpdates` → `jibo-get-update`
  per subsystem → `downloadUpdates` → `applyUpdates` (orders by dependency; os+services co-apply).
- **Hard-won gotchas (all handled, keep them):**
  1. **`UPDATE_NOT_FOUND` is mandatory.** `UpdateManager` aborts the *entire* multi-subsystem check
     on any "no update" error code that isn't exactly `UPDATE_NOT_FOUND`. Subsystems iterate
     alphabetically, so `@be/be` (which we don't stock) is checked first — returning the wrong code
     there silently kills the os/services check. Matches the original's `Boom.notFound`.
  2. **Filter is a deliberate divergence.** The original only serves an update whose stored `filter`
     prefix-matches the robot's filter; an untagged update would *not* reach a filtered robot. We
     treat an empty entry filter as a **wildcard** so our untagged packages reach a robot on any
     filter (e.g. `fcs`) without us knowing it in advance. This is what makes it work.
  3. **`fromVersion: "*"`** — one manifest entry serves any installed version (loop-guarded by
     version compare), vs. the original's one-record-per-from-version model.
  4. **Self-hosted packages** — `url` points back at this server (`GET /ota/package?id=…`), derived
     from the request Host / `ETCO_ota_publicUrl`, instead of the original's S3 URLs.
  5. **`toVersion` must be clean numeric** (`13.0.0`, not `13.0.0-lastdance-rc2`) — the original's
     `versionCompare` returns NaN on non-numeric parts.

---

## 5. References (archive)

- Robot API contracts: `server/jibo-server-client/apis/*.normal.json` (read these first).
- Original servers: `jiborobot/srv-*-ws` and `server/update-ws` in gitea.
- Service map / descriptions: Confluence **"Classic Services"** (space `SER`).
- Per-service API docs: `/docs/latest/AWS/<Service>.html` (e.g. `Account.html`, `Notification.html`).
- Endpoint resolution: `jibo-server-client/lib/region_config.{js,json}`.
- Robot consumers: `PlatformTeam/jibo-ota-updater` (CLIs), `PlatformTeam/system-manager`
  (`UpdateManager.cpp`, `CredentialsManager.cpp`, etc.).
- Phoenix tooling already built: `scripts/point-robot-at-phoenix.sh`,
  `scripts/robot-repoint-server-client.sh`, `scripts/build-ota-packages.sh`, `packages/ota/`.
