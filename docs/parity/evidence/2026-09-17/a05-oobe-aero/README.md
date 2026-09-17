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
