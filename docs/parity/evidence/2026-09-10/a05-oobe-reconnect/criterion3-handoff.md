# A-05 criterion 3 — hardware/firmware evidence: narrowing and root handoff

Criterion 3 as written: *"Retain hardware evidence by robot/firmware/date; prior notes are not a
fresh parity run."*

This wave does **not** claim criterion 3. No physical robot was touched. Below, criterion 3 is
split into what a worktree run proves (done here) and the sub-items that strictly require the
robot, with the exact procedure for root to collect them.

## 3a. Runtime-provable in a worktree — DONE (this wave)

| Sub-item | Evidence |
|---|---|
| Every normal/admin OOBE target dispatches under the archived `OOBE_20161026` prefix | `probe.json.targets`; `oobeTargetContract.test.js` |
| Token shapes match the archived `TokenContainer` / `StatusContainer` / `RobotCredentials` / `CommandResponse` | `oobeTargetContract.test.js`; runtime probe |
| Reconnect, used-token replay, expired token, suspended loop, robot replacement | `reconnectRobot.test.js`, `oobeSetupRevival.test.js`, `probe.json` |
| QR payload framing matches `config.bt` (frame regex, XOR key, token-last, static order) | `oobeQrFraming.test.js` |
| Issued credentials survive an abrupt (SIGKILL) restart | `probe.json.persistence`; `oobeRestartSIGKILL.test.js` |

These are the pieces of criterion 3 that are software-provable and they are now closed with
runtime evidence — but they are **not** a substitute for the robot run.

## 3b. Strictly requires the physical robot — NOT done

1. **Production-signed firmware / cert acceptance.** That a production-fused, PKC-signed robot
   (platform 13.0.0 "Last Dance", or a factory RTM3 3.3.4 bot) boots into OOBE, resolves the
   repointed endpoint, and completes the handshake against Phoenix. This needs the robot's secure
   boot and its installed `@jibo/jibo-server-client`; a worktree can only model the wire.
2. **Firmware-dated receipt.** A fresh OOBE run recorded against a named robot + firmware
   version + date, with the server-side log lines and the robot's resulting
   `/var/jibo/credentials.json` captured in the same window. Prior notes are explicitly not
   accepted.
3. **QR scan on hardware.** That the vendored `portal/qr.js` encoder's output is actually read by
   the robot's camera/`ReadBarcode` behaviour and drives `OOBE_20161026.SetupRobot`. This is the
   one item with real decode-risk (contrast, lighting, mask choice) and cannot be settled by
   jsQR round-trips alone.
4. **(Adjacent, only if root wants it in the same run)** WiFi join from the QR and the
   OOBE→OTA→`setmode normal` tail.

## Handoff procedure (for root / hardware owner)

Follow `HW-OOBE-TEST.md` (already in the repo) — it is the runbook. The minimum bar for a
criterion-3 record:

**Preconditions**
- Production-signed robot; record its serial + 4-word `friendlyId`.
- Record the exact firmware: `ssh root@<robot> 'cat /var/jibo/version* 2>/dev/null; jibo-get-version 2>/dev/null'`
  (or the flashed build label), and the **date** of the run.
- Phoenix at the revision committed on `w13/a05` (record `git rev-parse HEAD`).
- Start the stack per `HW-OOBE-TEST.md` §1; keep `/tmp/phx-compose-account.log`,
  `/tmp/phx-compose-ota.log`, `/tmp/phx-compose-classic.log`.

**Capture (one directory per run, e.g. `docs/parity/evidence/<date>/a05-oobe-hw/`)**
1. `robot.json` — `{serial, friendlyId, firmwareVersion, firmwareBuildDate, platform, runDate}`.
2. `credentials.json` — a **copy** of the robot's `/var/jibo/credentials.json` after OOBE, plus
   `sha256sum` of it. Do not paste the secret into a report; the hash + the account-service log
   line (`setupRobot complete {friendlyId, loop}`) prove issuance.
3. `account-log.txt` — the account-service excerpt showing `OOBE_20161026.SetupRobot` for that
   friendlyId (and `GetStatus`/`ReconnectRobot` if exercised).
4. `qr.txt` — the exact `payload`/`codes` the portal rendered, and a note that the robot's camera
   decoded the rendered QR (screen photo acceptable as supporting evidence).
5. `ota.txt` — the OTA check result (`UPDATE_NOT_FOUND` for a 13.0.0 bot, or the install log).
6. `result.json` — `{passed: bool, blockedOn, notes}`.

**Robot-side checks**
- After OOBE: `ssh root@<robot> 'cat /var/jibo/credentials.json'` is non-empty and its
  `accessKeyId` equals the value in `account-log.txt`.
- Optionally sign one `Loop_20160324.ListLoops` with those credentials and confirm the loop is
  returned (mirrors the orderly-restart probe in
  `docs/parity/evidence/2026-09-10/a05-oobe-live/live-probe.json`).
- Reconnect path: `jibo-setmode`/factory-reset the bot and confirm
  `OOBE_20161026.ReconnectRobot` returns `{result:"Command accepted"}` against the live server.

**Then** root records a `verification` entry for A-05 (`date`, `basis`, `result`, `artifact`,
`phoenixRevision`, `command`). Until that exists, criterion 3 stays open and this wave reports
`recommend_verified: false`.

## Why not fake it

The prior A-05 candidate refused to invent hardware evidence. That refusal is honoured here: the
worktree closes the software-provable half and hands off the robot half with a concrete,
reproducible procedure rather than an assertion.
