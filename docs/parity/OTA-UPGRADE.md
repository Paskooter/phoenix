# The verified over-the-air upgrade path (R-06, R-07)

**Owner-certified on hardware, 2026-10-03.** The normal robot repoint and native
OTA flow works, including stock robots. The owner has verified the helper on
**ten firmware combinations** and confirms factory RTM QR/Wi-Fi setup and the
reported firmware/migration reruns. Explicitly recalled coverage includes all
RTM releases, 13.0.0 and a robot previously repointed to `5x1`.

The [owner acceptance record](evidence/2026-10-03/ota-owner-certification/README.md)
is the evidence for **R-06** (the supported journey) and **R-07** (delivery of
the Phoenix configuration). It supersedes the September claims that no robot
had completed OTA and that a clean stock-to-OTA run still awaited sign-off.

The owner explicitly has **not tested interrupted/corrupt-update recovery or
A/B boot rollback**. These and the former payload negative controls are
tracked under **R-10**, with the full review list in
[VERIFICATION-GAPS.md](VERIFICATION-GAPS.md). R-04 owns the wider hardware user
journeys; R-08 owns USB flash acceptance; R-09 owns comprehensive trust refresh.

## The supported flow

Follow [RUNBOOK.md](../RUNBOOK.md) and use the current public
`scripts/robot-ota-repoint.sh` helper. A robot pointed at the retired cloud needs
this initial bootstrap before it can contact Phoenix's Update service.

1. Put the robot in the documented SSH-capable mode and run the helper from the
   portal/public guide. It checks the robot's firmware, patch targets, routing,
   trust, keys, mounts and update capacity before applying its plan.
2. For a credentialed robot, prove ownership with the portal claim when needed,
   then discover and download all four compatible native updates. A previously
   claimed robot can repair routing/start OTA without another claim code.
3. For a robot without credentials, repoint it and enter OOBE. Camera QR setup
   issues its credentials; the setup skill then runs the native OTA. Factory
   RTM Wi-Fi/QR/OTA is covered by the owner's follow-up acceptance.
4. The robot's own system manager/updater installs the packages, switches the
   inactive OS slot and reboots. The new payloads retain the Phoenix connection;
   no additional manual repoint is needed after installation.
5. Check the installed version reporters, running BE and a fresh voice turn as
   the runbook describes. Keep the robot's `/var` state and record the result.

The currently documented jibo.io release is OS/services **13.0.7**, OOBE
**9.0.2**, and custom `@be/be` **13.0.2**, based on complete official BE 11.0.1.
The helper selects compatible server offers rather than pinning these numbers.
The committed `packages/ota/manifest.json` is a stock example catalog; the
production release catalog and large package files are deployment artifacts.

The archive survey in [ROBOT-FIRMWARE-COMPATIBILITY.md](../ROBOT-FIRMWARE-COMPATIBILITY.md)
records source variants. It is separate from the owner's ten hardware trials.
Known successful firmware families are signed off; itemizing every starting
OS/services/OOBE/BE tuple is a documentation follow-up.

## Payload and updater contract

The archived `PlatformTeam/jibo-ota-updater` consumes an uncompressed outer tar
with `./filesystem.tar.bz2` and optional `./preinstall`/`./postinstall` scripts.
Phoenix's OS/services design carries **no hooks**: routing and trust are baked
into the filesystem before packaging. Hooks run on the old root, and a hook
failure triggers retry/reboot, so configuration delivery must not depend on a
post-update SSH patch or a successful repoint hook.

| Configuration | Delivery |
|---|---|
| Public CA material, explicit legacy Node TLS handling, rewritten server-client endpoints and native OTA downloader | OS/rootfs package |
| Jetstream hub/entrypoint routing, notification socket routing, backup/restore CA handling and service version reporter | Services package |
| Setup client, setup text/artwork and OOBE version | Independent `oobe-config` skill package |
| Complete-source custom BE and its client/runtime configuration | Independent `@be/be` skill package |
| Identity, Wi-Fi, keys, calibration, household state and credentials in `/var` | Preserved; not replaced by OS/services OTA |

OS apply writes the **inactive** rootfsA/rootfsB slot, sets `activeroot`,
`upgrade_available`, `bootcount` and `bootlimit`, records verification state and
reboots. Work state is `/var/jibo/ota.json`; scratch is `/opt/ota`.
U-Boot's boot-count fallback is the rollback mechanism. Its deliberately bad-slot
trial remains R-10 even though successful updates are certified.

Skill packages update the individual skills; they do not wipe the skills
partition. BE must come from the complete, committed `be/` tree in the separate
local `../jibo-be` project. Read [BE-RELEASES.md](BE-RELEASES.md) and the runbook,
and pass `scripts/be_ota_integrity.py` against the hash-pinned complete official
11.0.1 archive before publishing. The incomplete 2026-09-27 BE 11.0.2 incident
is a payload integrity failure; an SSM `running` flag cannot establish BE boot.

## Build and release checks

The native image baker is
`deploy/robot-patches/bake_jibo_io_native_image.py`. Stock package extraction is
supported by `scripts/build-ota-packages.sh`; the legacy versioned builder is
`scripts/build-jibo-io-ota-13-0-6.py`. Keep full BE source and built archives out
of Phoenix and GitHub. A previously extracted parity/installed tree cannot be
the BE release base.

For every changed release:

- Inspect the actual package members, endpoint/trust configuration and original
  numeric ownership, permissions, symlinks and setuid bits. Keep OS/services
  hook-free and validate the nested payload before serving it.
- Make each installed `jibo-version`/`jibo-service-version` agree with the offered
  `toVersion`; compute length and SHA-1 from the real bytes.
- Assign new IDs to changed offered entries because system manager caches by
  ID. Align exact dependencies and selection in filterless, `fcs`, `eau` and
  supported legacy-filter requests.
- Retain repeat-run/query-lease recovery and unknown-target preflight refusal.
  Use the real Node 4.1.2/6.9.2 helper regression gate.
- Verify the new payload boots and completes a voice turn on hardware; retain
  its versions, IDs/hashes, state witness and outcome.
- Deploy server changes through `scripts/deploy-native-release.sh <commit>`
  with fresh Hub and OTA activity and the full resettable 60-second idle
  interval. Staging without restart does not publish a running release.

## Remaining acceptance

R-10 retains checksum/truncation rejection, interrupted-update recovery,
deliberately unbootable-slot fallback and wrong-endpoint/artifact/metadata
negative controls. Detailed state-preservation witnesses and unusual capacity
layouts can be attached to the existing certification as they are identified.
See the itemized [verification review](VERIFICATION-GAPS.md).

USB/RCM full flash is a separate delivery method. The image baker exists and
can carry the same native routing/trust configuration; R-08 still needs its
own confirmed no-repoint flash, `/var` preservation and recovery record.
Comprehensive maintained public CA refresh and rejected-chain tests remain
R-09; working public jibo.io TLS is already part of the certified flow.

## Historical firmware workbench

The September build/flash workbench is
`/home/shell/work/hermes-be/firmware`, with large release inputs stored on the
resource host per its storage policy. Its `package-ota.js`, `validate-ota.js`,
`validate-modern-images.js`, `assemble-release.js`, `inspect-artifact.js` and
`production/flash-jibo-preserve-var.sh` remain useful tools.

The September modern Node 22/Electron 43 composed candidate and the older
5.4.0-to-stock-13.0.0 proposal were historical build/acceptance plans. Modern
runtime, sandbox and geometry results need their own current hardware evidence;
they do not describe the supported native OTA flow certified above. Stream
large artifacts to the designated resource host instead of duplicating them
in Phoenix worktrees.
