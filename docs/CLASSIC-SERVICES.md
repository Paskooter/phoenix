# Classic Services — the robot's cloud API

Phoenix began as a reimplementation of the *Pegasus* conversational backend (hub / NLU / skills).
Reviving a real robot to full cloud-era function needs more than that: it needs the **Classic
Services** — the robot's cloud REST API surface. This document inventories every classic service,
records what Phoenix implements, and explains how the pieces fit together.

**Current state:** most classic services are implemented behind a single **entrypoint front door**
(`packages/classic`, `@phoenix/classic`) that the robot's region resolves to and that dispatches by
`X-Amz-Target` prefix. Built: `update` (OTA, `packages/ota`), `account` + `loop` + `oobe` +
`settings` + portal + per-robot auth (`packages/account`), and `log`, `robot`, `notification` +
entrypoint-socket, `key`, `push`, `backup` (the UI wipe's "Backing up…" step, self-hosted blob
store), `media` (the app's Gallery store, self-hosted objects), and functional
`rom`/`person`/`ifttt`/`nlp`/`collision`/`voicetraining`/`jot` handlers
(`packages/classic`). Their accepted contracts and provider/hardware limitations
are recorded in [TASKS.md](parity/TASKS.md) and the
[verification review](parity/VERIFICATION-GAPS.md). Normal repoint/OTA, including
factory RTM setup and migration reruns, is owner-certified on hardware as of
2026-10-03. The conversational stack is a separate service family.

**The single front door** (`packages/classic`, default `:9012`): one AWS-JSON `POST /` endpoint
the robot's region (`https://<region>.jibo.com`) resolves to, dispatching by target prefix —
Classic handlers (log/robot/notification/key/push and the other local stores) in-process, separate stateful services
(OOBE/account/settings → account, Update → ota) proxied. Point the robot here with
the public `scripts/robot-ota-repoint.sh` helper or the documented self-hosted
`scripts/point-robot-at-phoenix.sh` procedure.

---

## 1. Orientation — two service families

The Jibo cloud was two distinct families:

| Family | Transport | What | Phoenix status |
|---|---|---|---|
| **Pegasus services** | WebSocket → the **hub**, which routes onward | Conversation: ASR → NLU → skills → multimodal response | **This is Phoenix.** `packages/{gateway,nlu,skills,history,data}` reimplement it. |
| **Classic services** | `jibo-server-client` (a fork of aws-sdk-js) → **AWS-JSON-1.1 REST RPC** | Accounts, loops, robot lifecycle, firmware, keys, notifications, media, logs… | `packages/ota`, `packages/account` and `packages/classic`. |

This document is about the **classic** family.

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

**To point a robot at Phoenix:** follow [RUNBOOK.md](RUNBOOK.md). The public
helper rewrites REST/socket/hub routing and installs verified TLS trust;
self-hosted private-CA deployments use the documented redirect procedure.
Production Classic and OTA entrypoints verify SigV4 against Account identity.
Hub sockets verify issued tokens; LAN location is not an authentication bypass.

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
3. Preserve the verified Classic identity and enforce the operation's
   source-derived authentication, ownership and administrator policy.
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
| **account** | `account-2015-11-11` | `srv-account-ws` (in `jiboV2/pegasus/.../cloud-services`) | Accounts; **issues the robot's `accessKeyId`/`secretAccessKey` during OOBE** (`setupRobot`); owns the Loop | **✅ `packages/account`** | Accepted Account lifecycle, OOBE setup/reconnect/admin/token persistence, portal QR and existing-identity migration. Retired Facebook operations are explicitly excluded. |
| **loop** | `loop-2016-03-24` | (part of `srv-account-ws`) | The "Loop" = a Jibo household: members, ownership, which robot belongs to whom | **✅ `packages/account`** | All 23 operations have accepted runtime/client evidence, including membership, invitations, suspension and durable lifecycle. `SuspendLoop` remains the native wipe gate. |
| **robot** | `robot-2016-02-25` | `jiborobot/srv-robots-ws` | Robot manufacturing/lifecycle events | **✅ `packages/classic`** | Boot-time reads (GetRobot/GetCalibrationData return valid empty records; calibration stays on the robot /var). |
| **robotread** | — | `jiborobot/srv-robots-read-ws` | Read-side snapshot of robot state | **✅** | Folded into the `robot` handler. |
| **key** | `key-2016-02-01` | `jiborobot/srv-key-ws` | UGC encryption-key exchange | **✅ `packages/classic`** | Nine verified operations, durable key/binary state and RSA-OAEP/AES round trip; SNS event delivery is a documented limitation. |
| **notification** | `notification-2015-05-05` | `jiborobot/srv-notification-ws` | Robot notifications transport | **✅ `packages/classic`** | NewRobotToken/GetStatus + the entrypoint-socket (wss `/socket/<token>`, live + pending delivery). |
| **push** | `push-2016-07-29` | `jiborobot/srv-push-ws` | Mobile push | **🟡 `packages/classic`** | Durable device CRUD, ownership and tested provider delivery/failure/invalidation seam; physical APNs/FCM delivery needs a live provider/mobile client. |
| **media** | `media-2016-07-25` | `jiborobot/srv-media-ws` | Cloud photo/recording store — the **app's Gallery tab** | **✅ `packages/classic/src/media.js`** | Real store: `Create` (streaming binary + `x-loop-id`/`x-path`/`x-type`/`x-reference`/`x-encrypted`/`x-meta*` headers), `List` (loopIds/after/before, membership gate, 50-row page capped at 200, ascending), `Get`, `Remove` (soft delete), `RemoveAllMediaFromLoop`. Thumbs are expanded as their own rows with `reference` = parent path — the row the Gallery grid selects. No S3: object `url` points back at this entrypoint (`GET /media/blob/:path`) and the bytes + index live under the private run dir. **App-side gate:** `MediaFragment` also needs the loop's UGC key (see `key`) — with none it shows its `viewNoKey` screen ("Uh oh, can't reach Jibo right now.") and never renders rows at all, so media data alone is not sufficient. |
| **log** | `log-2015-03-09` | `jiborobot/srv-log-ws` | Robot log/telemetry upload | **✅ `packages/classic`** | Verified event ingestion, binary upload and log-level validation; configured private storage and source error behavior. |
| **skill** | `skill-2015-11-03` | (locate — likely `srv-account-ws` or a skill-store repo) | Skill store / install metadata | ⬜ | Third-party skill install; not needed to revive a robot. |
| **person** | `person-2016-08-01` | `jiborobot/srv-person-ws` | Person/loop/account properties | **✅ `packages/classic`** | Ten functional, authenticated operations with process-restart durability. |
| **voicetraining** | versioned VoiceTraining/file models | `jiborobot/srv-voice-ws` | Sync voice-enrollment models | **✅ `packages/classic`** | Upload/list and durable binary state verified; older file-operation pairs correctly return the source 404. Physical original-app enrollment is a separate qualification. |
| **jot** | versioned Jot models | `jiborobot/srv-jot-ws-archived` | Cloud storage for the Jot skill | **✅ `packages/classic`** | Loop-era contract verified through the real SDK over TLS; removed party-era operations retain the source 404. |
| **backup** | `backup-2017-02-22` | `jiborobot/srv-backup-ws` | Robot backup-to-cloud (the UI wipe's "Backing up…" step) | **✅ `packages/classic`** | **Working** — `Backup.New`→self-hosted upload URL, `PUT /backup/blob`→ETag, `Backup.List`→matching etag + download URL, `GET /backup/blob`→restore. No S3 (blobs/index are durable on disk when `ETCO_classic_backupDir` is configured). Public ownership is enforced through the verified Classic caller; only an explicit loopback opt-in bypasses it. `List.max`, when supplied, is an integer from 1–1000 and invalid values return the source 422 rather than being clamped. Audited against `srv-backup-ws` + the robot's `jibo-system-{backup,restore}.js`; verified end-to-end. See DIVERGENCES H-backup. |
| **entrypoint-socket** | — (the `wss://…-socket` door) | `jiborobot/srv-entrypoint-socket-ws` | Exposes the robot's WebSocket; works with `notification` to push events to the robot | **✅ `packages/classic`** | The robot's notification socket: `wss /socket/<token>`, with live and pending delivery. |
| **rom** | `rom-2017-10-11` | `jiborobot/srv-rom-ws` | Commander (Remote Operation Mode) | **🟡 `packages/classic`** | Three SDK-verified operations with genuine certificate/PKCS#12 material; the physical Commander session and SNS path remain unavailable. |
| **gqa** | Question/ListAttribution contracts | `jiborobot/srv-gqa-ws` (Python) | General Q&A ("who is X") | **🟡** | Classic and skill-provider paths are verified at Q-01's bounded scope; live vendor/corpus qualifications remain explicit. |
| **nlp** | `nlp-2016-10-31` | `jiborobot/srv-nlp-ws` | Cloud NLP (POS/NER) | **🟡 `packages/classic/src/nlp.js`** | Full wire contract + source `clean_input` and the NER `'s`-strip; tag content needs the dead spaCy 1.2.0 backend, served through an explicit provider seam (`ETCO_nlp_upstream`), never faked. |
| **collision** | `collision-2016-11-26` | `jiborobot/srv-collision-ws` | Username-collision check | **🟡 `packages/classic`** | Functional threshold matching with a documented grapheme approximation for the unavailable original phonetic model. |
| **security** | — | `jiborobot/srv-security-gw` | Auth gateway fronting all the APIs | **✅ boundary** | Production SigV4, issued identity, allow-lists and operation permissions; accepted under A-02. |

### Not robot-facing (internal / web / admin / integrations — low priority for revival)

| Service | Repo | What | Status |
|---|---|---|---|
| app-toolkit-manager | `srv-app-toolkit-manager` | OAuth clientIds/ACOs for App Toolkit apps | ➖ |
| oauthclients | `srv-oauth-clients-ws` | OAuth client registry | ✅ four admin operations, source-derived policy/defaults |
| saml | `srv-saml-ws` | SAML SSO endpoint | ➖ |
| customer-portal | `srv-customer-portal` | Web: reset password, confirm email | ➖ |
| collision | `srv-collision-ws` | Resolve username collisions | ➖ (small dep of account flows) |
| ifttt | `srv-ifttt-ws` | IFTTT integration | **🟡 `packages/classic/src/ifttt.js`** (all 7 ops, source controller semantics) | Mongo-backed Identity/Trigger/Action/Media are a durable JSON store (`ETCO_classic_iftttFile`); third-party IFTTT notify is dead, recorded as an explicit UNAVAILABLE outcome, never faked. |
| salesforce | `srv-salesforce-ws` | SalesForce CRM facade | ➖ |
| poll | `srv-poll-ws` | AP-News feed → Mongo for GQA | ➖ (obsolete post-Fajita; Phoenix `lasso` shims news) |
| logparser | `jiborobot/logparser` | Parse ASR/NLU logs (ES/S3) | ➖ (analytics) |
| redis | — | Event bus / cache for security-gw | ➖ (infra) |
| lps | `srv-lps-ws` | LPS credentials | ✅ `NewCredentials`, robot policy and source defaults |
| cleanup / parser | (listed `?` on the Classic Services wiki) | historical non-SDK surfaces | discovery scope; confirm before relying |

---

## 3. What's left, by priority (for "make a robot work like the cloud did")

- **Pairing and identity**: ✅ **done** — `account` + `loop` + `oobe` in `packages/account`,
  with the web portal (signup/login, add-a-robot QR, robot list, admin adopt) and per-robot hub
  auth. Factory camera QR/Wi-Fi setup is owner-certified. Already-paired robots
  use the portal claim plus their existing credentials through the supported
  helper; do not hand-write replacement keys. See
  [OPERATIONS → Web portal + robot adoption](OPERATIONS.md#web-portal--robot-adoption).
- **Remote control and notifications** (Commander, push, the phone app's live features):
  `entrypoint-socket` + `notification` + `key` + `robot` have accepted contracts
  and native notification corroboration. Push provider behavior and ROM
  certificate exchange are verified; physical mobile push/Commander journeys
  need a live provider or replacement client.
- **Features**: `media`, `backup`, `log` and `ifttt` are built; `person` and `collision` keep
  functional behavior; `voicetraining` and `jot` have accepted source/SDK
  contracts. The third-party `skill` store remains separate discovery scope.
  Specific original-app/provider qualifications are collected in
  [VERIFICATION-GAPS.md](parity/VERIFICATION-GAPS.md).

A robot can be **alive, conversational, self-updating, and app-pairable today** with: Phoenix
hub + `update` + `account`/`loop`/`oobe` + portal. The remaining classic services cover the parts
of the old cloud that only the (now unavailable) mobile app ever used.

---

## 4. The `update` service — `packages/ota`

How it works:

- **What it is:** AWS-JSON `Update` service + a package file server. Audited against the original
  `server/update-ws` (`src/controllers/update.ctrl.js`) — faithful on protocol, fields, version
  sort, and the no-update error code.
- **Pieces:** `src/service.js` (wire), `src/catalog.js` (matching + Update shape), `src/awsJson.js`
  (helpers), `manifest.json` (the catalog), `scripts/build-ota-packages.sh` (turns a flash
  buildroot into `os`/`services` OTA packages). The committed manifest is a
  stock 13.0.0/12.10.0 example. The supported public release adds baked
  configuration and independent OOBE/BE updates; see [RUNBOOK.md](RUNBOOK.md).
- **Robot side:** `system-manager/src/UpdateManager.cpp` drives `checkForUpdates` → `jibo-get-update`
  per subsystem → `downloadUpdates` → `applyUpdates` (orders by dependency; os+services co-apply).
- **Design notes worth knowing:**
  1. **`UPDATE_NOT_FOUND` is mandatory.** `UpdateManager` aborts the *entire* multi-subsystem check
     on any "no update" error code that isn't exactly `UPDATE_NOT_FOUND`. Subsystems iterate
     alphabetically, so `@be/be` is checked first — returning the wrong code
     there silently kills the os/services check. Matches the original's `Boom.notFound`.
  2. **Filter is a deliberate divergence.** The original only serves an update whose stored `filter`
     prefix-matches the robot's filter; an untagged update would *not* reach a filtered robot. We
     use the unfiltered release as a fallback for a channel the catalog does
     not carry, including old factory filters. Explicit production entries in
     filterless, `fcs` and `eau` must have aligned versions/dependencies.
  3. **`fromVersion: "*"`** — one manifest entry serves any installed version (loop-guarded by
     version compare), vs. the original's one-record-per-from-version model.
  4. **Self-hosted packages** — `url` points back at this server (`GET /ota/package?id=…`), derived
     from the request Host / `ETCO_ota_publicUrl`, instead of the original's S3 URLs.
  5. **`toVersion` must be clean numeric** (`13.0.0`, not `13.0.0-lastdance-rc2`) — the original's
     `versionCompare` returns NaN on non-numeric parts.

---

## 5. References (archive)

Everything below is background from the original Jibo cloud, kept for anyone extending Phoenix:

- Robot API contracts: `server/jibo-server-client/apis/*.normal.json` (read these first).
- Original servers: `jiborobot/srv-*-ws` and `server/update-ws` in gitea.
- Service map / descriptions: Confluence **"Classic Services"** (space `SER`).
- Per-service API docs: `/docs/latest/AWS/<Service>.html` (e.g. `Account.html`, `Notification.html`).
- Endpoint resolution: `jibo-server-client/lib/region_config.{js,json}`.
- Robot consumers: `PlatformTeam/jibo-ota-updater` (CLIs), `PlatformTeam/system-manager`
  (`UpdateManager.cpp`, `CredentialsManager.cpp`, etc.).
- Phoenix tooling already built: `scripts/point-robot-at-phoenix.sh`,
  `scripts/robot-repoint-server-client.sh`, `scripts/build-ota-packages.sh`, `packages/ota/`.
