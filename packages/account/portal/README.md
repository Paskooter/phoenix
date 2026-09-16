# Phoenix web portal — the mobile app surface, served by the account service

This is the **single** web front end for the Jibo household. It replaces the old portal
(`app.js`/`index.html`/`styles.css` here were rewritten); `qr.js` (the robot-pairing QR
renderer) is untouched. It is served in place by the account service — same process, same
port, same origin, same session cookie — at exactly the URLs the old portal used (`/`, `/admin`,
`/app.js`, …). There is **no second service**.

It is built to do, from the browser, what the Jibo mobile app could do: account profile,
loop members and their account links, personal-report (settings) prefs, robot state and
pairing, the Gallery, people/person answers, Jot messaging, notifications, push
registrations, and the OTA/IFTTT/OAuth system views.

## How to start it

Start the account service exactly as before:

```sh
node packages/account/src/index.js        # or npm run start:account
```

Then open `http://localhost:7016/` (default `PORT` for account). The portal needs the
Classic entrypoint for the surfaces it fronts (media, person, jot, push, notification,
robot, voicetraining, ifttt, update). Point it there with either env var, both optional:

```sh
NET_classic=http://localhost:7017          # classic entrypoint base URL
ETCO_account_classicUrl=...                # alias (same meaning)
```

`NET_classic` is set in `docker-compose.yml` for the account service (`classic:8080`). When
unset it defaults to `http://localhost:7017` (DefaultPort.classic). The OTA/update view also
needs the OTA service reachable from Classic (`NET_ota`, like the rest of the repo). Every
surface degrades to an explicit, visible error when its backend is down — nothing is faked.

The UI is server-rendered static files (`index.html`, `app.js`, `styles.css`, `qr.js`) with
a hash router; there is no build step and no new npm dependency.

## How auth works

- Login/signup uses the **existing account store** — the same account the owner signs into
  on the mobile app. `POST /api/login` authenticates via `store.accountByEmail` +
  `verifyPassword` and issues the `phx_session` cookie (unchanged from the old portal).
- Every `/api/*` route below checks that session. No second identity system, no parallel
  user store.
- **Frozen contracts (must not change):**
  - `GET /api/verify` — unchanged; the gateway calls it to authorise every robot connection
    and the skills GQA attribution store calls it too.
  - `POST /api/token` — unchanged, original two-argument contract.
  - The pairing flow — `POST /api/robots/setup`, `GET /api/robots/setup/status`, and the
    multi-frame QR renderer in `qr.js` — is carried over verbatim.

## Surfaces

| # | Surface | State | Backend call |
|---|---------|-------|--------------|
| 1 | **Loop members** — list every member, edit nickname/phonetic name/status, **link/unlink a member to an account**, show enrolment | **Complete** | account store, in-process (`portal/loops.js`) |
| 2 | **Personal report settings** — weather (units), news sources/categories, commute (home/work/mode), calendar flags | **Complete** | account store (`GET/PUT /api/settings`, pre-existing) |
| 3 | **Account profile** — first/last name, birthday, gender, phone, `messagingAllowed`; change password; change email | **Complete** | account store, in-process (`portal/profile.js`) |
| 4 | **Robot** — loop robot record, `Robot_20160225` read state, add-a-robot QR pairing | **Complete** | account store + `Robot_20160225.GetRobot` via Classic |
| 5 | **Loop** — rename, suspend/unsuspend, ownership transfer, invite + remove members | **Complete** | account store via source loop helpers (`loopMembership.js`) |
| 6 | **Gallery** — list/view/delete media | **Complete** | `Media_20160725.List/Get/Remove` + blob proxy to Classic |
| 7 | **People** — person-catalog answers, account/loop properties, holidays, voice-training enrolment state | **Partial** (read-only) | `Person_20160801.*`, `VoiceTraining_20151020.ListVoiceTrainings` via Classic |
| 8 | **Messaging** — Jot messages, notification socket status, push registrations | **Partial** (Jot + push + status read) | `Jot_20160512.List/Create`, `Notification_20150505.GetStatus`, `Push_20160729.RemoveDevice` + `GET /push/devices` sidecar |
| 9 | **System** — OTA update catalog, IFTTT identity/applets, OAuth clients | **Partial** | `Update_20160301.ListUpdates` (Classic→OTA), `IFTTT_20170207.UserInfo/ListTriggers`, account `oauthClients` store |

### What each surface calls

- **Surfaces owned by the account service** (loop, members, account, settings, oauth clients)
  operate directly on the account store and the source-shaped helpers in
  `loopMembership.js`/`settingsFace.js` — no HTTP round-trip.
- **Everything the Classic entrypoint owns** is called the way the app does: `POST /` with an
  `X-Amz-Target` header, SigV4-signed with the logged-in account’s `accessKeyId` /
  `secretAccessKey` (see `src/portal/classicClient.js`; pattern copied from
  `test/robotLookupSigv4.test.js`). For the handlers that read the gateway’s forwarded
  identity (`x-amz-credentials`: person, voicetraining, update, ifttt) the portal forwards
  `{id, email}` it already knows from the session — never a secret.
- Those Classic calls are wired through the account service via `NET_classic` /
  `ETCO_account_classicUrl` (default `localhost:7017`). The glue lives in `src/portal/*`:
  `classicClient.js`, `loops.js`, `profile.js`, `robots.js`, `media.js`, `people.js`,
  `messaging.js`, `system.js`, plus `session.js` for the shared auth helper. `portalApi.js`
  keeps the original routes and composes the new ones.

### The news bug and its fix

The motivating failure — *“Missing creds for Settings request. Got accountID: false |
loopID: true”* — is fixed by the **member→account link**. The report skill resolves a
speaker’s settings through `member.accountId`; of the loop’s 20 members only 4 had one. On
the **Loop & people** page the owner can search the account store and **Link** any member to
any account (and unlink). Verified in `test/portalMembers.test.js`: linking persists
`accountId` on the loop member record and the settings lookup path then has a real account.

## What was tested

Node’s built-in test runner, no live network, fixture accounts only:

```sh
node --test 'packages/account/test/*.test.js'   # 437 pass
node --test 'packages/classic/test/*.test.js'   # 318 pass
node scripts/parity-status.mjs --check          # 74/79 verified, gate passes
```

New tests:
- `test/portalMembers.test.js` — member list, link/unlink (the fix), nickname/phonetic/status,
  enrolment, account search.
- `test/portalLoop.test.js` — rename, suspend/unsuspend, invite, remove, ownership transfer,
  soft-remove.
- `test/portalProfile.test.js` — profile edit, password + email change.
- `test/portalClassic.test.js` — end-to-end through a real Classic entrypoint + OTA service:
  gallery list/blob/delete, robot read, jot create/list, people + voicetraining, push
  register/list/remove, notification status, OTA catalog, OAuth clients, IFTTT.

Existing suites stay green and the parity gate passes (no `docs/parity/tasks.json` change).

## What was intentionally not implemented, and why

- **Media upload / photo_booth.** Media `Create` is a streaming binary upload that carries the
  media bytes as the request entity; the app’s Gallery write path is robot/device-driven. The
  portal implements the read/delete side. (The underlying Classic op works — it just isn’t a
  browser form.)
- **Person catalogue** is read-only here (list answers, properties, holidays, voice-training
  state). Answering the “this or that” questions is a phone-side flow; no handler is stubbed —
  the calls are real, the UI is read.
- **Notifications** shows the socket status (`Notification_20150505.GetStatus`); the robot’s
  push socket and delivery are robot-side.
- **OTA** shows the update catalog the robot would be offered (`ListUpdates`); it does not
  push firmware from the browser (an admin/OTA-flow concern, out of the mobile-app surface).
- **IFTTT** shows the account’s identity and applet (trigger) rows and reports an explicit
  diagnostic when the IFTTT realtime API is dead (it is — recorded by the Classic handler).
- **OAuth clients** are listed read-only from the account store registry.
- Push **delivery** (APNs/FCM) has no live provider — registrations are shown and removable,
  exactly as they exist today.

Every unfinished/partial item above is labelled **partial** in the UI and this doc — none is
silently faked.