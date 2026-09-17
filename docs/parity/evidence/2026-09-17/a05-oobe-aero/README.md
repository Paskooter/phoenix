# A-05 — a real robot performs OOBE against Phoenix, over verified TLS

Date: 2026-09-17
Robot: **Aero-Root-Okra-Knit** (`root@aero-root-okra-knit.jibo`), serial
`BOJW-1000-0016-1209-0003`, region `stg-entrypoint`.
Moth was not used and was not disturbed.

The owner released a second, freshly reflashed robot for this and authorised
whatever was needed on it. That is what made this possible: every earlier A-05
run drove Phoenix from a host-side client, because re-pairing the owner's daily
robot was not something to do on a whim.

## What is now proven that was not before

The OOBE call was made **by the robot**, from its own filesystem, through its
own installed `@jibo/jibo-server-client` CA bundle, to `api.jibo.com` — which
its own `/etc/hosts` maps to Phoenix — with `rejectUnauthorized: true`:

```
HTTP 200
keys: accessKeyId,secretAccessKey
CREDENTIALS ISSUED: accessKeyId SjaDRwPg… 
```

Server side, in the live account store:

| | |
| --- | --- |
| robot account created | `friendlyId=BOJW-1000-0016-1209-0003`, active, with keys |
| loop created for it | `ed67a2c320455fb1bd59d3f7`, robot set, not suspended |
| setup token | **consumed** — 0 tokens remain |
| Moth's loop | `5a0b20f5ddee0000197e2881`, untouched, robot unchanged |

### The one-time property, falsified rather than asserted

Replaying the same token from the same robot, and then an unknown token:

```
replay of the consumed token: HTTP 404  TOKEN_NOT_FOUND
an unknown token:             HTTP 404  TOKEN_NOT_FOUND
```

A consumed token is indistinguishable from one that never existed, which is the
source behaviour (`oobe.ctrl.ts` deletes the token inside setupRobot).

## The TLS path this rode on

Getting here required converging the host onto ONE certificate authority. It had
drifted into two: a per-instance `Phoenix Moth development CA` that the running
server actually served, and the shared `Phoenix development CA` that
`repoint-robot.sh` reaches for. `openssl verify` across them failed, and the
served leaf covered only `api.*` while Aero reports `stg-entrypoint`.

Converged to one CA and one leaf covering both regions. The order is the entire
risk — a robot refuses a server whose certificate its trust store cannot verify —
so trust was added to both robots *before* the server switched:

1. issue one leaf covering `api.*` and `stg-entrypoint.*`, server untouched;
2. Aero: shared CA installed, repointed;
3. **Moth: shared CA added BESIDE the CA it already trusted**, server still
   serving the old leaf, so Moth never lost its connection;
4. only then switch the server (`onboard-robot.sh --switch-server`).

Verified after the switch rather than assumed:

```
Moth  — still connected, Notification_20150505.NewRobotToken flowing
Aero  — tls.connect rejectUnauthorized:true through the robot's own bundle:
        authorized: true, issuer "Phoenix development CA"
```

## What this does NOT cover — stated plainly

**The camera QR scan and the on-screen OOBE UI.** Aero has three skills
installed (`fin-goods-test`, `jibo-diagnostics`, `oobe-config`) and no BE, and no
skill host process was running: it has the native service stack but no
experience. Driving the visual pairing flow needs an OOBE-capable skill deployed
AND a person holding the QR code in front of the robot's camera. Neither is
something this run could do, and neither is claimed.

So the honest split is: the OOBE **protocol**, performed by the real robot over
its real repointed TLS connection, is verified end to end. The OOBE **UI** — the
camera scan, the screen, the spoken prompts — is not.

**The robot's own `/var/jibo/credentials.json` was deliberately not rewritten.**
setupRobot returned credentials; nothing wrote them to the robot, because with no
BE installed there is nothing to run with them and leaving the robot's disk
untouched keeps the run reversible. Aero therefore holds its pre-existing
credentials while Phoenix holds a new robot account for it. That asymmetry is
intentional and recorded here rather than hidden.

## Backups

`~/.local/share/phoenix/aero-backup/20260916T061731Z/` (before any change) and
`20260917T031219Z-pre-oobe/` — each `var-jibo.tar` (credentials, identity, keys,
mode), `etc-hosts.orig`, digests. Private, mode 600, outside Git. No secret value
appears in this file or in any commit.

## Reproduction

```bash
# 1. mint a one-time setup token into the live store (stack stopped so the
#    running service cannot clobber the write, then restarted)
systemctl --user stop phoenix-robot@moth.service
node -e '…mintSetupToken(store, "<accountId>", null)…'
systemctl --user start phoenix-robot@moth.service

# 2. from the ROBOT, unsigned (SetupRobot is in the gateway's unauthorizedMethods)
ssh root@aero-root-okra-knit.jibo 'node -e "
  https.request({host:\"api.jibo.com\",port:443,path:\"/\",method:\"POST\",
    ca: <the robot's own phoenix-ca.pem>, rejectUnauthorized:true,
    headers:{\"X-Amz-Target\":\"OOBE_20161026.SetupRobot\"}},…)
  .end(JSON.stringify({id: <serial>, token: <token>}))"'
```

---

# The camera and UI half, closed: a real phone app paired a real robot

Same day, later. The section above deliberately did **not** claim the camera QR
scan or the on-screen OOBE flow, because they need a person and an OOBE-capable
skill. The owner supplied both — their phone app, configured against this same
Phoenix server. This records what happened, including the things that broke.

## The flow, end to end

**Robot** (`oobe-config`, the out-of-box skill — see "BE is not an OOBE build"
below):

```
OOBE-CONFIG: Server set to stg-entrypoint
OOBE-CONFIG: Display Logo, then QR Prompt
OOBE-CONFIG: Number of QR Codes scanned: 1
OOBE-CONFIG: QR codes scanned in 22.09 seconds
OOBE-CONFIG: Successfully retrieved account by access token
OOBE-CONFIG: Successfully retrieved and saved robot credentials
OOBE-CONFIG: Fully connected after 7.85 seconds
```

**Server**, in order: `OOBE_20161026.PrepareRobot` (the app minting the setup
token), ~20 × `OOBE_20161026.GetStatus` polling over about 40 seconds, then
`OOBE_20161026.SetupRobot` the moment the robot's camera read the code.

**Result**: robot account `Aero-Root-Okra-Knit` active with keys, a new loop
`dfb820876a7f6e99c6e60c1f` with 2 members, the one-time token consumed, and
Moth's loop untouched. The robot's credential digest changed from `4c38c90e…`
to `354f9cec…`, so they were genuinely reissued.

**Credentials survive a restart.** Forced reboot, boot id
`5fbce08e…` → `c499f7d3…`, credential digest `354f9cec…` unchanged. That is
A-05's "preserve issued credentials across robot restart" clause, on a robot
paired minutes earlier by the app rather than by a script.

**And the robot works.** After the reboot it drives the Classic surface on its
own: `Backup_20170222.List`, `Key_20160201.ShouldCreate`, `Loop_20160324.ListLoops`,
`Notification_20150505.NewRobotToken`, `Person_20160801.ListHolidays`,
`Media_20160725.List`, `Account_20151111.Get`.

## Four defects this found, none of which a host-side test could

**1. The robot stack never started the OTA service.** The classic entrypoint
proxies every `Update_*` target to it; with nothing listening, a robot that has
just finished setup runs its update check against a dead proxy and sits on
"updating operating system" indefinitely. That is exactly what happened. Fixed
in `authenticated-stack.mjs`.

Two corrections were needed along the way, both worth recording because each was
briefly *worse* than the original bug:
 * adding `ota` to the service loop broke stack startup — its `start()` takes an
   options object, not a port, and resolves to `{svc, catalog}` rather than a
   server, so it landed on its own default port with no `NET_ota` and the stack
   came up `ready:false`;
 * resolving `dataDir` relative to the launcher found the **deploy worktree's**
   empty `packages/ota/data` (the tars are gitignored and exist only in the main
   checkout), giving `available: 0` — which would have served `UPDATE_NOT_FOUND`
   to every robot including ones that genuinely needed updating, and would have
   looked correct for the robot under test. Now an explicit `ETCO_ota_dataDir`.

Verified after: `available: 2`; a robot at 12.0.0 is offered `os-13.0.0`, and one
at 13.0.0 gets `UPDATE_NOT_FOUND`.

**2. `GQA_20160930s.ListAttribution` was unroutable.** The shipping app sends a
trailing `s` the pinned client's own `targetPrefix` does not have. GQA was
registered `/^gqa_20160930$/i` — the only anchored entry in a table where every
other service uses an unanchored prefix, so the only one that could miss a
version suffix. Phoenix answered `no service for target`, and answer history
never loaded in the app. Unanchored; falsified by restoring the `$`.

**3. BE 11.0.1 is not an OOBE-capable build.** Started on an unprovisioned robot
it loops on `Skills config load error … first time: true, has backup data: null`
and never leaves the logo screen. `oobe-config` is the skill that runs the
out-of-box flow. After pairing, BE loads fully (`Jibo is ready... awaiting launch
command`). The order for a factory robot is: repoint → unprovision → run
`oobe-config` → pair from the app → reboot → run BE.

**4. The dev shell's `POST /reboot` does not reboot.** It answers "Rebooting…"
and the robot stays up — `uptime` was 22:34 afterwards. Same trap the 2026-09-15
Moth restart recorded: busybox `reboot` signals init and init ignores it. Use
`sync; sync; /sbin/reboot -f` and verify with `/proc/sys/kernel/random/boot_id`,
never with "did SSH come back".

## One more thing the reboot fixed

Between pairing and rebooting, BE looped on
`error when checking if backup data exists … {"status":"error","message":"LoopID is not cached"}`.
That is the robot's own local cache, populated at service start — and its
services had started before it had any credentials, so the cache was empty and
never refilled. The reboot repopulated it and `Backup_20170222.List` has
succeeded since. Worth knowing: a robot needs a restart after OOBE before its
local caches reflect the new identity.
