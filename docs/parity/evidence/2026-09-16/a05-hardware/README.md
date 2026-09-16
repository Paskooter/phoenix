# A-05 — fresh hardware evidence by robot, firmware and date

Date: 2026-09-16
Robot: Moth-Radius-Breazeal-Felt (`root@moth-radius-breazeal-felt.jibo`, 192.168.1.217)
Capture: read-only over SSH. **Nothing on the robot was changed to produce this
file, and no secret value was read or copied — only digests and key names.**

A-05 acceptance clause 3 asks that hardware evidence be retained *by robot,
firmware and date*, and says plainly that prior notes are not a fresh parity
run. This is that fresh capture.

## Robot identity

| field | value |
| --- | --- |
| hostname / robot name | `Moth-Radius-Breazeal-Felt` |
| `sha256(/var/jibo/identity.json)` | `e7734604d226a2e02fa41d693cb5d82cb1792daefadb2d636f899b311bf12424` |
| identity keys | `cpuid, name, serial_number, wifi_mac` |
| `sha256(/var/jibo/credentials.json)` | `2c8fdf39bf084a3a11c20719864a3bbd5a6b06d18ca7a131c1828cd4732cb654` |
| credential keys | `accessKeyId, region, secretAccessKey` |

## Firmware and platform

| field | value |
| --- | --- |
| L4T / Tegra release | `R21 (release), REVISION: 5.0, GCID: 7273100, BOARD: ardbeg, EABI: hard, DATE: Wed Jun 8 04:19:09 UTC 2016` |
| kernel | `Linux 3.10.104 #1 SMP PREEMPT Sun Feb 24 16:59:01 EST 2019` (`jon@highst-buildroot`, gcc 4.9.3) |
| userland | Buildroot 2015.11 |
| skills service manager | `skills-service-manager 16.0.0` (`/usr/local/bin/jibo-ssm`) |

Native services running at capture: `jibo-asr-service`, `jibo-audio-service`,
`jibo-body-service`, `jibo-identity-service`, `jibo-jetstream-service`,
`jibo-lps-service`, `jibo-server-service`, plus `jibo-ssm` and `jibo-sts` under
Node, and the Electron skill host.

Installed skill slots include `phoenix-be-11-0-1-parity` (the supported BE
reference release, see `docs/parity/BE-RELEASES.md`), `phoenix-be-11-0-2-parity`,
`phoenix-be-11-0-3-parity`, `phoenix-be12-parity` and `oobe-config`.

## Date and restart state

| field | value |
| --- | --- |
| robot clock at capture (UTC) | `2026-09-16T04:23:01Z` |
| `/proc/sys/kernel/random/boot_id` | `0c0610c0-bcdc-4437-8231-e18c5f52ff12` |
| uptime | 90424 s (≈ 25 h 07 m), so boot was ≈ `2026-09-15T03:16Z` |
| load average | 8.27 / 8.39 / 8.50 |

## Independent re-confirmation of the restart witness

`docs/parity/evidence/2026-09-15/a05-restart/README.md` discharged the
"preserve issued credentials across service/**robot** restart" clause with a
before/after pair. This capture, taken about 25 hours later by a different
agent, re-reads both halves of that witness and finds them unchanged:

| | recorded 2026-09-15 (after) | re-read 2026-09-16 |
| --- | --- | --- |
| boot id | `0c0610c0-bcdc-4437-8231-e18c5f52ff12` | `0c0610c0-bcdc-4437-8231-e18c5f52ff12` |
| credentials digest | `2c8fdf39…2cb654` | `2c8fdf39…2cb654` |

The boot id is still the post-reboot one, so the robot has not restarted again
and the two captures describe the same boot; the credential digest is byte-identical
across both, so the credentials issued before that reboot are still the ones in
place. The restart evidence is not a one-off reading.

It is worth repeating what that earlier file recorded about its own method,
because it is the reason the witness is trustworthy: the first reboot attempt
(`nohup sh -c 'sleep 2; reboot'`) returned success and did **not** reboot the
robot, and the boot-id check caught it. A weaker witness — "SSH answered again"
— would have recorded a false pass.

## What this file does and does not close

Closes: acceptance clause 3's fresh robot/firmware/date evidence, and a second
independent reading of the clause-2 robot-restart witness.

Does **not** close: native out-of-box pairing against this robot, TLS ingress,
and camera/microphone/screen/notification behaviour. Those change or exercise
live household state and are tracked in
`docs/parity/evidence/2026-09-14/a05-hardware-gap/README.md` as Tier 3.

## Reproduction

```bash
ssh root@moth-radius-breazeal-felt.jibo '
  hostname
  date -u +%Y-%m-%dT%H:%M:%SZ
  cat /proc/sys/kernel/random/boot_id
  cut -d" " -f1 /proc/uptime
  sha256sum /var/jibo/identity.json /var/jibo/credentials.json
  cat /etc/nv_tegra_release | head -1
  cat /proc/version
  node -e "var p=require(\"/usr/local/bin/jibo-ssm/package.json\");console.log(p.name,p.version)"
'
```

---

# The robot does not run the SDK version A-05 was verified against

The accepted A-05 SDK matrix drives `@jibo/jibo-server-client` **3.0.110**.
That version is not installed anywhere on Moth. A read-only sweep of the robot
found these, which are what its own code actually calls Phoenix with:

| version | consumer on the robot |
| --- | --- |
| **3.0.41** | `/opt/jibo/Jibo/Skills/oobe-config` — **the native out-of-box pairing skill** |
| **3.0.117** | `/usr/local/bin/jibo-ssm` (skills-service-manager 16.0.0) and the `phoenix-be-11-0-1-parity` slot |
| 3.0.79 | `@be/be`, `phoenix-be-11-0-2/3-parity`, `phoenix-be12-parity` |

Verifying against 3.0.110 and asserting "the original consumer passes" was
therefore an unchecked assumption. It is now checked, two ways.

## 1. The OOBE surface is byte-identical across all three versions

```
file                              3.0.110    3.0.117    3.0.41
clients/oobe.js                   98cf9a7b   98cf9a7b   98cf9a7b
clients/oobeadmin.js              b18c8995   b18c8995   b18c8995
clients/account.js                aafd7906   aafd7906   aafd7906
clients/loop.js                   0ed26fd8   0ed26fd8   0ed26fd8
apis/oobe-2016-10-26.min.json     29122e8a   29122e8a   29122e8a
```

The versions do differ elsewhere — 3.0.41 has no `settings`, `lps`, `rom`,
`oauthclientsadmin` or `updateadmin` API models and does carry `jot`; 3.0.117
differs in `account`, `settings` and `oauthclientsadmin` models and in
`dist/aws-sdk-all.js`. None of that is the OOBE path.

## 2. Both robot clients were lifted off the robot and run against Phoenix

The client trees were copied read-only to
`~/.local/share/phoenix/a05-robot-clients/` (kept private, outside Git) and the
full A-05 matrix was run against Phoenix with each in place of 3.0.110:

| client | initial | restart | result |
| --- | --- | --- | --- |
| 3.0.110 (accepted baseline), at HEAD `d9938fd` | 38 | 46 | pass |
| **3.0.117** (jibo-ssm, BE 11.0.1) | 38 | 46 | **pass** |
| **3.0.41** (native OOBE skill) | 38 | 46 | **pass** |

All five normal/admin OOBE operations across both the Account and Classic
faces, ordinary setup, used-token replay, expiry, live-loop replacement
refusal, suspended-loop replacement, reconnect and reconnect replay, non-admin
rejection, service-mode setup, and issued-credential survival across a real
service-process restart — driven by the robot's own client binaries.

### Falsified with the robot's own OOBE client

Disarming the admin gate on `GetServiceToken`
(`packages/account/src/robotFace.js:588`, `if (!caller || !caller.isAdmin)` →
`if (false)`) and re-running with the **3.0.41** client:

```
AssertionError: account FALSIFY non-admin GetServiceToken unexpectedly succeeded
  at expectError (scripts/parity-a05/sdkMatrixClient.cjs:96)
EXIT=1
```

Restored byte-exact (`git status --porcelain packages/account/src/` empty);
38/46 pass returns. The same break fails the same named assertion under 3.0.110.

One harness change was needed and is recorded: the report step hashed
`.yarn-tarball.tgz`, which exists only in the yarn-cache copy. A tree lifted off
the robot has no tarball, so that digest is now recorded as `null` when absent
rather than aborting the run. The per-file digests above are what identify the
client either way.

## TLS ingress, from the robot's own client

The robot's live 3.0.117 tree carries the `repoint-robot.sh` patch plus its
pre-patch backup, so the change is directly readable:

```diff
-      AWS.NodeHttpClient.sslAgent = new https.Agent({rejectUnauthorized: true});
+      var agentOptions = {rejectUnauthorized: true};
+      var caPath = process.env.JIBO_EXTRA_CA_CERTS || __dirname + '/phoenix-ca.pem';
+      if (process.env.JIBO_EXTRA_CA_CERTS || fs.existsSync(caPath)) {
+        agentOptions.ca = fs.readFileSync(caPath);
+      }
+      AWS.NodeHttpClient.sslAgent = new https.Agent(agentOptions);
```

`rejectUnauthorized: true` is preserved; the patch adds the Phoenix CA rather
than disabling verification. `lib/region_config.json` still resolves `*/*` to
`globalSSL` → `https://{region}.jibo.com`, which the managed `/etc/hosts` block
points at the Phoenix host. So the robot reaches Phoenix over TLS with real
certificate verification against a trusted CA, not with verification turned off.

## What is still not covered

Running the native out-of-box pairing flow through the robot's own UI. That
issues new robot credentials and can detach Moth from the user's household, so
it is a decision for the owner and not something to take unilaterally — see
`docs/parity/evidence/2026-09-14/a05-hardware-gap/README.md` Tier 3. What the
evidence above establishes is narrower and worth stating exactly: **the client
code the native pairing skill would run passes every A-05 assertion against
Phoenix**, and that code is byte-identical on the OOBE path to the version
already accepted. It does not establish that the pairing UI, camera, microphone,
screen or notification behaviour work end to end on the hardware.
