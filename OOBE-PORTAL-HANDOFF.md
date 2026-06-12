# OOBE Web Portal — Agent Handoff

> **Mission for the next session.** Build **Path A** of Jibo OOBE: a minimal **web portal**
> (sign up / log in, "set up a new robot" → QR, see attached robots, log out — responsive for
> PC *and* mobile) **plus the server** behind it (the `account` + `oobe` + `loop` Classic
> Service), so a real robot can complete its out-of-box first-boot handshake against Phoenix and
> receive server-issued credentials. This doc carries all the context; you should not need to
> re-research the protocol.
>
> **Prereqs already done in this repo:** the firmware-OTA Classic Service (`packages/ota`), and
> the robot-repoint tooling (`scripts/point-robot-at-phoenix.sh`). Read **`CLASSIC-SERVICES.md`**
> first for the family overview, then this.

---

## 0. TL;DR — what to build

1. **`packages/account`** — one Node service, **two faces over one store** (accounts / loops / tokens):
   - **Robot face** = AWS-JSON-1.1 (`POST /`, dispatched by `X-Amz-Target`). The firmware calls
     **`OOBE.setupRobot{token,id}` → `{accessKeyId, secretAccessKey, serviceMode}`** here. This is
     the *only* robot→server OOBE call. Non-negotiable wire contract.
   - **Portal face** = clean REST/JSON (`/api/*`) that *we* design, used by the web portal. Also
     serves the static portal at `/`.
2. **The web portal** (plain HTML/CSS/JS, no build step, responsive): signup, login, dashboard
   (robot list + "Add a robot" → renders the WiFi+token **QR**), logout.
3. Wire it so the robot reaches the robot-face via the existing `region_config` repoint, and the
   portal drives the same store the robot face reads.

The robot already knows how to do its half (scan QR → `setupRobot` → `setCredentials` → OTA →
normal). We're building the **app's half** (as a web portal) and the **server**.

---

## 1. The OOBE handshake (full sequence, portal playing the app's role)

| # | Actor | Action | Call |
|---|---|---|---|
| 1 | Portal user | sign up / log in | REST `POST /api/signup` or `/api/login` → session |
| 2 | Portal user | "Add a robot": enter home **WiFi SSID + password** | REST `POST /api/robots/setup` → server mints a **token** + returns the **QR payload/codes** |
| 3 | Portal | render QR on screen (PC or phone) | (client-side QR draw) |
| 4 | Robot | camera-scans the QR (`oobe-config/config.bt`) | — decode wifi + token, join WiFi |
| 5 | **Robot** | **register** (`oobe-config/cloud-init.bt`) | **AWS-JSON `OOBE.setupRobot{token, id:<4-word-name>}`** (unauth) → `{accessKeyId, secretAccessKey, serviceMode}`; robot stores via `setCredentials` → `/var/jibo/credentials.json` |
| 6 | Portal | poll until the token is consumed | REST `GET /api/robots/setup/:token/status` → `{complete:true}` |
| 7 | Robot | OTA + `setMode normal` + reboot → alive | `Update.*` (✅ `packages/ota`) |
| 8 | Portal user | sees the new robot in the dashboard | REST `GET /api/robots` |

The token is the pivot: **the portal mints it, the robot redeems it.** It binds the robot to the
user's account/loop.

---

## 2. What `OOBE.setupRobot` must do (server logic — authoritative)

Reverse-engineered from `jiborobot/srv-account-ws/src/controllers/oobe.ctrl.ts`:

```
setupRobot({ token, id }):                       # id = robot's 4-word friendlyId, e.g. "castle-cylinder-fig-quilt"
  tokenObj = tokens.findById(token)              # must exist AND be < 15 min old, else error
  account  = accounts.get(tokenObj.accountId)    # the owner who minted it
  if tokenObj.loopId:                            # re-setup / reconnect path (skip for MVP v1; see §9)
      loop = loops.get(tokenObj.loopId) ...ownership/suspended checks...
  else:                                          # NEW setup (the MVP path)
      loop = loops.create({ owner: account, robotId: id, name: "<Owner>'s Jibo" })
  robot = loop.getRobot()                        # the dedicated *robot account* (its own keys)
  tokens.delete(token)                           # ONE-TIME use
  return {
    accessKeyId:     robot.accessKeyId,
    secretAccessKey: robot.secretAccessKey,
    serviceMode:     account.email.startsWith("service-mode-") ? true : undefined,   # normal accounts → undefined
  }
```

Supporting ops the original exposes on the same `OOBE` service (implement the first three for MVP):
- `prepareRobot({ loopId? })` → `{ token, expires }` — **mint** a token (authed as the owner). The
  portal's `/api/robots/setup` calls this internally. `loopId` omitted = brand-new robot.
- `getStatus({ token })` → `{ complete: !tokenExists }` — the original app polled this; our portal
  can poll its own REST instead, but expose it too (harmless, robot/app may use it).
- `setupRobot` (above) — the robot call.
- `reconnectRobot`, `getServiceToken` — later/optional.

---

## 3. Data model (3 collections; a JSON-file store is fine — keep it persistent so robot creds survive restarts)

```
Account {
  _id            string (e.g. random hex)
  email          string|null        # owners have it; robot accounts don't
  password       string|null        # hashed (bcrypt/scrypt); owners only
  friendlyId     string|null        # robot accounts: the 4-word name (unique). owners: null
  firstName, lastName, nickName, photoUrl, ...
  accessKeyId    string             # random 20-char alnum   (account.ts fillAccessKeys)
  secretAccessKey string            # random 40-char alnum
  isActive       bool
  created        ts
}

Loop {
  _id       string
  name      string                  # "<Owner>'s Jibo"  (getLoopName de-dupes with " 2 Jibo", etc.)
  owner     accountId               # the human owner
  robot     accountId               # the robot account (1 robot per loop in v1)
  members   [{ accountId, status }] # owner + robot + managed members; status: ACCEPTED/INVITED
  isSuspended bool
}

Token {
  _id        string                 # the access code itself; original = bs58(crypto.randomBytes(5)) ~7 chars
  accountId  accountId              # owner who minted it
  loopId     accountId|null        # null for new-robot setup
  created    ts                     # 15-min TTL (ACCESS_TOKEN_LIFETIME)
}
```

Key facts (from `account.ts` / `token.ctrl.ts`):
- **A robot is just an `Account` with a `friendlyId`** and its own `accessKeyId`/`secretAccessKey`.
  `fillAccessKeys()` = `accessKeyId` = 20 random alnum chars, `secretAccessKey` = 40 random alnum chars.
- **Token TTL = 15 minutes, one-time** (deleted on successful `setupRobot`).
- `loops.create({owner, robotId, name})` must **find-or-create the robot account** (`friendlyId == robotId`)
  and attach it; `loop.getRobot()` returns that account. (Full detail in `loop.ctrl.ts` —
  `findOrCreateRobotAccount`, `getRobot`, `create` — read it when implementing; it's 32 KB, only those fns matter.)
- `serviceMode` true only when the owner email starts with the service-center prefix → ignore for MVP (always `undefined`).

---

## 4. Robot-facing AWS-JSON interface (the wire contract)

Build it **exactly like `packages/ota`** (`src/awsJson.js` + `POST /` dispatch). The robot's
`@jibo/jibo-server-client` sends:

```
POST /                       (the robot resolves this from `region` → https://<region>.jibo.com)
Content-Type: application/x-amz-json-1.1
X-Amz-Target: <OOBE-prefix>.SetupRobot         ← ⚠ CONFIRM PREFIX (see §10)
Authorization: AWS4-HMAC-SHA256 …              ← do NOT verify (we trust the LAN, like the hub's DISABLE_AUTH)
body: {"token":"<code>","id":"<four-word-name>"}
```

Response (success): `200`, AWS-JSON body
`{"accessKeyId":"…","secretAccessKey":"…","serviceMode":null}`.
Errors: `{__type, message}` + `x-amzn-errortype` header (reuse `ota/src/awsJson.js sendAmzError`).
**Mirror the OTA `UPDATE_NOT_FOUND` lesson:** if the robot's firmware checks error codes, match the
exact code the original used (read what `Boom.createWithCode` produces in `srv-account-ws/src/errors`).

**Auth nuance (differs from OTA):** OTA ignored auth entirely. Here, `setupRobot` is **unauthenticated**
(the token carries identity, no header needed). But the *portal-minting* op `prepareRobot` is authed —
since we skip SigV4 *verification*, identify the caller by **parsing the `accessKeyId` out of the
`Authorization: …Credential=<accessKeyId>/…` header** and looking up the account. (The portal's own
REST face uses sessions instead — see §6 — so you may only need the header-parse if you also expose
`prepareRobot` on the AWS-JSON face.)

Which robots use `OOBE.setupRobot` vs. the older `Account.GetAccountByAccessToken`? Our robot
(oobe-config 9.0.0) uses `OOBE.setupRobot` (confirmed in `cloud-init.bt`). Implement that; optionally
also implement `Account.GetAccountByAccessToken` (`Account_20151111`, confirmed prefix) for older units.

---

## 5. Portal REST interface (we design this — keep it boring/clean)

Same-origin JSON, session cookie auth. Suggested surface:

```
POST /api/signup     {email, password, firstName?}        -> 200 {account}  + Set-Cookie session
POST /api/login      {email, password}                    -> 200 {account}  + Set-Cookie session
POST /api/logout                                           -> 200
GET  /api/me                                               -> {account} | 401
GET  /api/robots                                           -> [{ name, loopId, status, lastSeen? }]   (owner's loops → loop.robot)
POST /api/robots/setup  {ssid, password, static?{ip,netmask,gateway,dns1,dns2}}
                                                           -> { token, expires, qr:{ payload, codes:[...] } }
GET  /api/robots/setup/:token/status                      -> { complete: bool, expires }
```

`/api/robots/setup` internally: mint a token (`prepareRobot` logic, `loopId:null`), build the QR
payload (§7), return it. The browser renders the QR. Poll `…/status` until `complete` (the robot
consumed the token via `setupRobot`), then refresh `/api/robots`.

---

## 6. The QR code format (EXACT — from `oobe-config/src/behaviors/oobe/config.bt`)

The robot decodes each scanned QR as `"<codeId>/<totalCodes>\n<chunk>"`, concatenates chunks in
`codeId` order, then **XOR-decrypts the whole** and splits on `\n`. To **produce** a QR:

1. **Plaintext payload** (fields joined by `\n`, `accessToken` LAST; trailing static fields optional):
   ```
   <ssid>\n<password>\n<staticIP>\n<netmask>\n<gateway>\n<dns1>\n<dns2>\n<accessToken>
   ```
   DHCP (the common case) → just `"<ssid>\n<password>\n<accessToken>"` (3 lines; robot `.pop()`s the
   token and positionally assigns the rest).
2. **XOR-scramble** every char with this key (cycled): 
   `Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.`
   ```js
   const key = "Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.";
   const scrambled = [...payload].map((c,i)=>String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i%key.length))).join('');
   ```
   (XOR is symmetric — same routine the robot uses to decrypt.)
3. **Chunk + frame.** Usually one QR fits (token ~7 chars). For N codes, split `scrambled` into N
   parts and render each as a QR encoding the string `"<i>/<N>\n<part_i>"` (i = 1..N). For a single
   code: `"1/1\n" + scrambled`.
4. Render with a small **pure-JS QR generator** vendored into the portal (consistent with Phoenix's
   "vendor plain data, single external dep" ethos — don't pull a framework). The XOR scrambling is
   light obfuscation, not security; that's fine.

> ⚠ Validate this against a *real* app-generated QR if you can get one — there's a second XOR helper
> in the old client (`account.js encryptQr`, key `"jibokey"`) that is a *different* path; the
> `config.bt` key above is the one our oobe-config 9.0.0 actually uses. Trust `config.bt`.

---

## 7. The web portal (frontend)

- **Tech:** plain HTML + CSS + vanilla JS, **no build step** (match Phoenix: zero-config, served as
  static files by `packages/account`). One small vendored QR lib. Optionally a tiny CSS for layout.
- **Responsive:** single column, mobile-first; works on a phone (so the user can hold the phone up to
  Jibo to show the QR) *and* desktop. Flexbox/grid, no fixed widths, `<meta viewport>`.
- **Pages / states** (SPA or a few static pages, your call):
  1. **Auth** — sign up (email, password, first name) / log in toggle. On success → dashboard.
  2. **Dashboard** — greet the user; **list attached robots** (`GET /api/robots`: name + status);
     **"Add a robot"** button; **log out**.
  3. **Add-a-robot** — form: WiFi SSID + password (+ optional advanced static IP). Submit →
     `POST /api/robots/setup` → render the **QR** big and centered with instructions ("Open Jibo's
     setup screen and hold this up to his eye"). Poll status; when `complete`, show success and return
     to the dashboard with the new robot listed.
  4. **Log out** — clears session, back to auth.
- Keep it genuinely minimal — this is plumbing to complete OOBE, not a product.

---

## 8. Auth model

- **Portal users:** session cookie (signed JWT or an opaque session id in the store). Password hashed
  (`scrypt` via `node:crypto`, zero-dep). `/api/*` (except signup/login) require a valid session.
- **AWS keys** (`accessKeyId`/`secretAccessKey`) are the robot-facing credentials and the AWS-JSON
  identity; they're *issued/stored*, not used to log the human into the portal. Keep the two separate.
- **No SigV4 verification anywhere** (LAN trust). For any authed AWS-JSON op, identify the caller by
  parsing `accessKeyId` from the `Authorization` header.

---

## 9. Build order (milestones)

- **M1 — auth spine.** Store (accounts/loops/tokens, JSON-file persisted) + `signup/login/logout/me`
  + the portal's auth page & empty dashboard. Sessions working.
- **M2 — the OOBE core.** `POST /api/robots/setup` (mint token + build QR §6) + QR render in portal +
  the **robot-facing AWS-JSON `OOBE.setupRobot`** (store loop+robot account, return creds). This is
  the milestone that makes a real robot complete OOBE. Validate: portal shows QR → robot scans →
  robot gets creds → token consumed.
- **M3 — visibility.** `GET /api/robots` (owner's loops → robot accounts) + status polling on the
  add-robot screen + dashboard list. Log out polish.
- **M4 — end-to-end on hardware.** Point the real robot's `region_config` at this service
  (`scripts/point-robot-at-phoenix.sh` already does region_config; confirm the OOBE host/port routing),
  run a clean OOBE, confirm `/var/jibo/credentials.json` gets the issued keys, then OTA + normal mode.
- Mobile/responsive polish throughout.

> v1 simplification: support **only the new-robot path** (`token.loopId == null`). Skip
> reconnect/suspended-loop/managed-members/Facebook/activation-email. One owner, N robots, one robot
> per loop. Add the rest later.

---

## 10. Confirm before/while coding (small, high-value)

1. **The OOBE service `targetPrefix` + `oobe-*.normal.json`.** Not in the archived client forks
   (they predate the `OOBE` class). Read it off the **robot's installed client**:
   ```bash
   ssh root@<robot> "find / -path '*jibo-server-client*' -name 'oobe-*.normal.json' 2>/dev/null"
   # then cat it for metadata.targetPrefix + the SetupRobot/PrepareRobot/GetStatus operation names + shapes
   ```
   Everything else (operation behavior, shapes) is specified above from `srv-account-ws`.
2. **The exact `setupRobot` error codes** the firmware tolerates — peek `srv-account-ws/src/errors/*`
   and apply the OTA `UPDATE_NOT_FOUND` lesson (match codes exactly).
3. **`loop.ctrl.ts`** `create` / `getRobot` / `findOrCreateRobotAccount` (robot-account creation detail).
4. **Endpoint routing on the robot:** the robot resolves *all* server-client services to one host
   (`region` → `https://<region>.jibo.com`) and routes by target prefix. Decide whether `packages/account`
   shares that host with OTA behind a prefix-router, or the repoint points the relevant prefixes at its
   own port. (For MVP, easiest: run `packages/account` on its own port and point the robot's
   `region_config` endpoint at it — but then OTA + account can't both be the single endpoint unless you
   add a tiny prefix-dispatcher. Note this and pick one.)

---

## 11. References

- **Robot side (what calls us):** `skills/oobe-config/src/behaviors/oobe/{config,cloud-init}.bt`
  (QR parse + `OOBE.setupRobot`); `@jibo/jibo-server-client` on the robot (the `OOBE` class).
- **Server original (mirror this):** `jiborobot/srv-account-ws/src/` — `handlers/oobe.handler.ts`,
  `controllers/{oobe,token,loop,account}.ctrl.ts`, `schemes/{account,loop,token}.ts`.
- **Wire contracts:** `*/jibo-server-client/apis/{account-2015-11-11,loop-2016-03-24}.normal.json`
  (Account=`Account_20151111`, Loop=`Loop_20160324`).
- **AWS-JSON pattern + auth-skip + error envelope:** `packages/ota/src/{service,awsJson,catalog}.js`.
- **Robot repoint tooling:** `scripts/point-robot-at-phoenix.sh`, `scripts/robot-repoint-server-client.sh`.
- **Family overview:** `CLASSIC-SERVICES.md`. OOBE flow background: the OOBE robot-side analysis in
  the Phoenix session history (oobe-config behavior trees).
