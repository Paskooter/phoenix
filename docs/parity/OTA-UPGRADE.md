# The over-the-air upgrade path (R-06, R-07)

This is a release gate. The goal is not "a robot we already repointed by hand keeps
working" — it is **any** robot, on whatever firmware it arrives with, upgrading
itself to the version this server supports and reaching this server without a human
touching it over SSH.

Ledger: **R-06** (the journey, on hardware) and **R-07** (the payload it needs).
R-05, the release report, depends on both.

## The case to prove

A robot flashed to **stock 5.4.0 over USB** upgrades over the air to **13.0.0** —
the final Jibo firmware ("Last Dance", 2019-02-25 production) — carrying our own
configuration, and afterwards:

1. it is running the published version, confirmed from the robot itself;
2. it reaches this Phoenix server with **no manual repoint step**;
3. it completes a real spoken turn end to end;
4. its per-robot state survived, because `/var` is a separate partition the OS
   update never touches.

## The firmware workbench that already builds this

There is a whole separate workbench at `/home/shell/work/hermes-be/firmware`
(`PROJECT.md`, `README.md`, `AGENTS.md`, ~5.8 GB of inputs). It is not a plan — it
has built, composed, validated and flashed images. **Build the payload there, not
from scratch here.** Its own scope note is worth repeating: the first deliverable is
a validated **full-flash** release plus rollback, and *"An OTA variant follows only
when its real updater/signing/install path is validated; it must not hold the first
working flash release hostage or be mislabeled done."* R-06 is where that OTA
variant gets validated, and it must not be called done on the strength of a
full-flash success.

### The resource host

Large builds and release archives live off this machine, per
`firmware/production/storage-policy.md`. As of this writing it reaches:

```
ssh root@192.168.1.23          # hostname CT120, ~334 GB free
/srv/jibo-release/             # releases, work dirs, archived legacy images
/srv/jibo-workbench-20260905/  # the tool checkout used for the builds
/srv/jibo-buildroot-rootfs/home/ubuntu/   # buildroots and their outputs
```

This is the machine the owner described as "the WSL on my laptop". The workbench's
storage policy is explicit that the shell host is a shared 126 GiB root filesystem,
so **stream large artefacts over SSH rather than caching another copy here**.

### The pipeline, as it actually is

```
buildroot-patches/  ->  build-production.sh   (Buildroot, production key profile)
                          |-- rootfs.ext4, services.ext4, skills.ext4
                          |-- jibo.fit, DTBs, u-boot, tegrarcm signed msgs
                          v
                     stage-modern-userland.js  (Node 22 / Electron 43 under /opt/jibo-modern)
                          v
                     compose-legacy-modern.js  <-- THE ACTUAL RECIPE for the composed images
                          v
                     validate-modern-images.js (geometry, hashes, aliases, manifest agreement)
                          v
                     package-ota.js --image <img> --subsystem <os|services> --outfile <tar>
                          v
                     packages/ota/  (served to the robot)
```

Note `compose-legacy-modern.js` is the real recipe for the composed sizes; the
copied vendor `genimage.cfg` is a historical reference only, and the Buildroot
capacity change lives separately in
`buildroot-patches/0003-genimage-rootfs-capacity.patch` (rootfsA/B 1000 MiB,
services 2000 MiB, skills 10,400 MiB).

### Tool inventory worth reusing (`tools/jibo/`)

| Tool | What it is for |
| --- | --- |
| `package-ota.js` | Creates the exact nested tar the archived updater consumes. Plan-first. |
| `validate-ota.js` | Offline validator for that shape; reads the inner tar without installing it. |
| `compose-legacy-modern.js` | The composition recipe for the corrected images. |
| `validate-modern-images.js` | Image geometry, hashes, aliases, manifest agreement. |
| `move-modern-*` / `stage-modern-userland.js` | Stages the modern userland into the image, not after it. |
| `assemble-release.js` | Assembles and hashes the full bundle + archived flash helpers. |
| `inspect-artifact.js` | Dependency-free FIT/ext4/OTA/full-flash inspection. Never extracts. |
| `capture-baseline.js` | Allowlisted read-only SSH inventory of a robot. |
| `production/flash-jibo-preserve-var.sh` | The full-flash path that deliberately leaves `/var` intact. |

There is also a test suite beside the tools (`tools/jibo/test-*.js`), including
`test-preserve-var-helper.js`, which is the pattern to follow for R-06's
falsification: it asserts the helper **refuses** to run without the capacity and
GPT-acknowledgement arguments rather than trusting the happy path.

### Artefacts that already exist

| Artefact | Where | State |
| --- | --- | --- |
| Modern production Buildroot output (rootfs/services/skills ext4, jibo.fit, DTBs, u-boot) | `/srv/jibo-buildroot-rootfs/home/ubuntu/buildroot-modern-production-output/images/` | built 2026-09-02 |
| OTA packages cut from it (`rootfs.tar`, `services.tar`, `skills.tar`, `var.tar` + JSON manifests) | `/srv/jibo-release/ota-production/` | built 2026-09-02 |
| Composed modern candidate, offline-validated (rootfs 1,048,576,000 / services 2,097,152,000 / skills 10,905,190,400) | `/srv/jibo-release/jibo-modern-node22-electron43-candidate-20260905` (+ `.tar.bz2`, 861,255,203 B) | validated offline; the composed filesystem candidate had **not** been flashed as of 2026-09-05 |
| Signed legacy-runtime probe, full-flash only, deliberately with **no** OTA package | `/srv/jibo-release/jibo-legacy-runtime-probe-production-20260903` | 18 flash images |
| Archived 13.0.0 filesystems (`rootfs` 838,860,800 / `services` 954,631,168 / `skills` 326,343,680 / `var` 2,097,152) | `/srv/jibo-release/legacy-20190225-images/` | the stock 2019 images |
| Stock 13.0.0 flash buildroot (728,605,067 B) | `firmware/artifacts/reference/` | also the default input for `scripts/build-ota-packages.sh` |

The two tars in `packages/ota/data/` (`os-13.0.0.tar`, `services-13.0.0.tar`) are
built from that **stock** buildroot. They are not the modern build, so they are not
the payload R-07 wants to publish.

## The updater's own contract (this is what the payload must satisfy)

Read from `PlatformTeam/jibo-ota-updater` (the archived updater the robot actually
runs):

- **Subsystem names**: `os` (cut from `rootfs.ext4`) and `services` (from
  `services.ext4`). Skills packages are built from repo artefacts instead.
- **Package shape**: an **uncompressed** tar containing `./filesystem.tar.bz2`, plus
  **optional `./preinstall` and `./postinstall` scripts**. All three members are
  optional; a package that only extracts and declares success is legal.
- **Hooks**: both scripts run from the extraction directory. **An error from either
  is a fatal error — the update is redownloaded and retried.**
- **Hook order** (`apply_common.applyUpdate`): `preinstall` → write the filesystem
  to the device → `postinstall`. Both run while the robot is still on its **old**
  root: the incoming filesystem is mounted at `/tmp/other` and unmounted before the
  switch.
- **OS apply** (`apply_os.js`): determine the inactive `rootfsA`/`rootfsB` by
  comparing `/`'s device against the `by-partlabel` nodes, write the update there,
  then `fw_setenv activeroot <1|2> && upgrade_available 1 && bootcount 0 &&
  bootlimit 1`, write work state `verify`, and reboot. **Rollback is U-Boot's
  `bootcount`/`bootlimit`** — that is the mechanism R-06's falsification must
  actually exercise.
- **State**: work state at `/var/jibo/ota.json`, scratch at `/opt/ota`.
  `fail()` writes state `retry` and reboots.

**Consequence that decides the design:** `postinstall` runs on the old root after
the new filesystem has been written *and unmounted*. So the repoint configuration
must be **baked into the image** — the way `stage-modern-userland.js` already bakes
the modern userland into `skills.ext4` "rather than being added after image
creation" — and the package therefore carries **no hooks at all**. That is stronger
than "we chose not to use a hook": a hook that errors is fatal and produces a
redownload-and-retry loop, so a payload with no hook members cannot enter that loop,
and the absence of `./preinstall`/`./postinstall` is asserted against the built tar.

## Where the repoint configuration has to land

The repoint script's work spans four partitions, and only three of them are replaced
by an OS update:

| What the repoint sets | Partition | Carried by the OTA payload? |
| --- | --- | --- |
| Public CA bundle, `/etc/ssl/cert.pem`, the patched `@jibo/jibo-server-client` copies, and the OTA downloader's explicit CA | `rootfs` | yes — `os` package |
| `/usr/local/etc/jibo-jetstream-service.json` hub/entrypoint override, plus `jibo-system-backup` and `jibo-system-restore` using the rootfs public CA bundle explicitly | `services` | yes — `services` package |
| `@be/phoenix-parity-11-0-1` under `/opt/jibo/Jibo/Skills` | `skills` | yes — a skills package |
| the region / server URL in `/var/jibo/credentials.json` | `var` | **no — `/var` is preserved, deliberately** |

The last row is the one to think about, because it is exactly why a never-repointed
robot would upgrade cleanly and still not find the server. **Decided: bake the
default URL at payload-build time** from this server's configured public URL.

That makes the URL a **build-time input**: a payload built for a different public
URL is a different payload with a different hash. Changing the URL therefore means
building and publishing a new payload rather than editing anything on the robot —
accepted deliberately, because it is the only option that repoints a robot which has
never been provisioned against this server.

The build **refuses to run with no configured public URL**. Shipping one silently
would produce an update that cannot repoint the robots needing it most. An explicit
opt-out flag may produce the documented leave-as-is payload — one that carries no URL
and lets each robot keep whatever it already has — and in that case the manifest must
record that the package carries no URL, and nothing may present it as the repoint
payload.

Where the URL actually lives when baked: the `override` block of
`/usr/local/etc/jibo-jetstream-service.json` on the **services** partition supplies the
hub host and port; the rewritten client region configs retain the robot's region but
resolve the public `*.jibo.io` names through DNS; and the public CA bundle plus explicit
Node-6 CA handling in **rootfs** makes TLS work. The backup and restore helpers in
**services** are separate raw `request`/`https` programs, so they explicitly read the
same bundle rather than relying on the patched server client. `/var/jibo/credentials.json`'s
region is preserved and is not the mechanism.

Recorded in DIVERGENCES, because the reference had no such step: a reference robot was
provisioned by the factory/cloud, not repointed by its own update.

## What is genuinely unproven here

- **No robot has ever walked an upgrade.** The standing `ECONNREFUSED
  127.0.0.1:7015` symptom is the development launcher
  (`scripts/parity-robot/authenticated-stack.mjs`) starting only account, classic and
  gateway — never OTA — so the service a robot would call is not even running in the
  configuration we test with.
- `packages/ota` itself is implemented and unit-tested: all eight operations, version
  ordering, wildcard `fromVersion`, target overrides, and the loop guard that never
  re-offers a version the robot already runs.
- The workbench's own gates that remain open, which the payload inherits: public
  trust stores are **not** release-validated; Electron's SUID sandbox fails at zygote
  startup with `EINVAL` and has been run with `--no-sandbox`; legacy services are
  still Node 6.9.2 / Electron 1.4.3.
- The owner reports having built and flashed bootable images. The written record lags
  that — it still describes the composed candidate as unflashed as of 2026-09-05 — so
  the **first step of R-06 is to read the current state off the robot** and reconcile
  it with the record rather than trusting either one.

## Procedure to follow when this is picked up

1. Read the robot's actual current state (version, boot state, partitions) and
   reconcile it against the workbench record.
2. Build the payload in the workbench: image → `compose-legacy-modern.js` →
   `validate-modern-images.js` → `package-ota.js`, with the repoint configuration
   baked in, then `validate-ota.js` on the result.
3. Publish it in `packages/ota` with real length + SHA-1 in the manifest, and bring
   the OTA service up in the deployed stack where the robot can reach it.
4. Confirm `Update_20160301.GetUpdateFrom` / `ListUpdatesFrom` offer it to that
   robot's `fromVersion`.
5. Let the robot upgrade; capture robot-side logs and timings.
6. Verify the four outcomes in "The case to prove".
7. Falsify: corrupt a package so its bytes no longer match the advertised SHA-1 and
   confirm the updater refuses it **and** the robot still boots — and separately
   exercise the `bootcount`/`bootlimit` fallback, since that is the mechanism that
   makes a bad OS slot survivable. An update path never seen to refuse a bad package
   is not a verified update path.

## Two delivery paths, one repoint (R-07, R-08)

The repoint content is the same either way — public CA trust, explicit TLS handling for
every Node-6 network client (including backup/restore), BE 11.0.1, and a baked server
URL. What differs is how it reaches the robot:

| | OTA (R-06, R-07) | Flash (R-08) |
| --- | --- | --- |
| Delivery | the Update service, an `os`/`services` package pair | a full image written over USB with `flash-jibo-preserve-var.sh` |
| Starting point | whatever firmware the robot already runs, including 5.4.0 | a robot being provisioned or recovered |
| `/var` | preserved by the A/B slot swap | preserved because the helper never writes that partition |
| Rollback | U-Boot `bootcount`/`bootlimit` after the slot flip | the same mechanism, plus the old slot still on disk |

Both were open as of 2026-09-18. The Phoenix image baker now owns the repoint payload:
it rewrites every client config, installs the public trust material, gives the OTA
downloader and both system-manager backup helpers an explicit CA bundle, and records
their source and output hashes in `repoint-manifest.json`. A release still requires the
workbench build/package/physical-update gates above; this source change alone is not a
published or hardware-validated OTA release.

R-08 additionally owns the certificate question, because it is the path where it
bites hardest: the robot's public bundle holds 180 certificates of which **58 have
already passed their `notAfter` date**, and the workbench's own gate requires pinning
a maintained CA source and testing chains that must succeed *and* chains that must be
rejected — explicitly not deleting expired roots.



## Risks worth naming before starting

- An OTA that rewrites the hosts file and the server URL is a remote configuration
  change; it must be idempotent and must not strand a robot with no reachable server.
- A **hook error is fatal and triggers a redownload-and-retry loop.** A hook that
  fails deterministically turns an update into a reboot loop, so any hook must be
  narrow, idempotent, and tested against the failure path first.
- The images are large (the modern candidate's archive is 861 MB); the workbench's
  storage policy exists because a local `ENOSPC` already produced silently empty
  helper copies once.
- Destructive trials (factory reset, wiping) need the owner's explicit authorisation,
  as A-05 established.
