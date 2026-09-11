# Plan: public Phoenix + one-shot RCM flash + self-repointing OTA

Status: **PLAN ONLY — nothing here is built yet.** Written 2026-09-11.
Nothing in this document has been implemented. Where a fact is grounded in the Jibo
archive or in the live Moth robot it is marked **[VERIFIED]**; guesses are marked
**[ASSUMPTION]** and must be checked before anyone writes code.

## The goal, in the user's words

> "a very easy to run script that you run on the robot in RCM mode with USB — you do it once,
> it uses the DFU tool, it backs up the var partition and then patches the robot to connect to
> a theoretical public Phoenix instance… and then when that robot turns on it will be able to
> pull an update over the air from the Phoenix server which updates everything in the system to
> point to the new Phoenix server like how the repoint script works. Maybe we can have an
> over-the-air image that has all that stuff done from the start so it doesn't even need to be
> run — we just install it from the over-the-air."

So: **two delivery paths that converge.**

- **Path A — USB/RCM one-shot.** For a robot in the box today, pointed at a dead cloud. It cannot
  reach any server, so something physical has to happen once.
- **Path B — OTA image.** For a robot that can already reach *a* Phoenix. Everything is baked in;
  no script, no USB, no cable. This is the end state we want people to use.

Path A's whole job is to get a robot far enough to take Path B. After that, Path A should never
be needed again on that robot.

---

## 1. What we already know is true

### Partition layout **[VERIFIED — /confluence/display/ENG/Embedded+Platform+Partition+and+File+System+Scheme, and confirmed on Moth]**

| # | Partition | Mount | OTA-able? | Notes |
|---|---|---|---|---|
| 0/1 | Boot0/Boot1 | — | No | U-Boot + env |
| 2/3 | Root0 / Root1 | `/` | **Yes** | **A/B pair.** Update writes the *other* one, flips U-Boot, reboots |
| 4 | Recovery | — | No | "Not currently used" |
| 5 | Services | `/usr/local` | **Yes** | binaries, libs, `/usr/local/etc/<service>` config |
| 6 | Temp | `/tmp` | No | ramfs |
| 7 | **Variable** | `/var` | **No** | per-robot identity, keys, calibration — **this is what we back up** |
| 8 | Logs | `/var/log` | No | ramfs |
| 9 | Local Storage | `/opt` | No | skills, photos, `/opt/ota` scratch |

Live confirmation on Moth **[VERIFIED]**:
```
/dev/mmcblk0p1 on /          ext4 rw
/dev/mmcblk0p4 on /usr/local ext4 rw
/dev/mmcblk0p5 on /var       ext4 rw   491.7M total, 67.2M used
/dev/mmcblk0p6 on /opt       ext4 rw
```
Note the live device numbering does **not** line up with the doc's logical table
(doc says Services = #5, Moth mounts `/usr/local` from `p4`). **Resolve the real GPT
mapping before writing any flashing tool** — `dfu_alt_info` in the U-Boot env is the
authority, per the partition doc.

**Why `/var` is the thing to back up:** it is the only partition marked *not* OTA-able that
holds irreplaceable per-robot data — `identity.json`, `mode.json`, `credentials.json`,
`/var/jibo/keys/` (the loop key, dated Nov 14 2017 on Moth), calibration, voice/face models.
Everything else can be re-flashed from an image. **[VERIFIED]**

### The OTA mechanism **[VERIFIED — /confluence/display/ENG/OTA+Updater, /confluence/display/RM/Creating+OTA+Packages]**

- A package is **"essentially just a tarball. There's nothing intelligent or active about it."**
  Outer plain `tar`, containing up to three things:
  - `preinstall` (optional executable)
  - `filesystem.tar.bz2` (**must** be named exactly that)
  - `postinstall` (optional executable)
- Subsystems: `os`, `services`, `oobe-config`, `jibo-diagnostics`, `jibo-tbd`, `be`.
- **Matching rule:** a robot takes an update only if the update's **`from_version` matches the
  robot's currently-installed version for that subsystem** *and* the robot's **OTA target
  (a.k.a. "filter")** matches the update's target.
- **Targets:** can be set on-robot *or* server-side. **Server-side takes precedence.**
- Work state lives at `/var/jibo/ota.json`. Not present on Moth right now **[VERIFIED]**.
- `apply-update` runs from `/etc/init.d/S72jibo-apply-update`, i.e. **before** platform services
  and **after** networking/X11 **[VERIFIED on Moth]**.
- **OS update procedure:** extract to `/opt/ota` → `preinstall` → mount the *other* root, erase,
  extract `filesystem.tar.bz2` → `postinstall` → flip U-Boot flags → reboot → on success mark the
  partition good → copy new partition back over the old one.
- **Services update procedure:** extract → `preinstall` → remount `/usr/local` rw, erase, extract
  → remount ro → `postinstall` → update bodyboard firmware.

**The `postinstall` hook is the whole trick.** It is an arbitrary executable that runs after the
filesystem lands. That is the sanctioned, documented place to do the repointing — no patching of
someone else's binary required.

> ⚠️ **Error handling is brutal and must shape our design.** Straight from the doc:
> *"The apply-updates process has exactly one way to handle update failures or unexpected errors:
> to retry the update that failed… it is possible to push a fix and the robots will take it.
> However, until that fix is pushed, robots that attempted the bad update will be stuck in an
> infinite retry loop. **There is no mechanism to roll back to a previous update.**"*
>
> A bad OTA bricks the robot into a retry loop. This is the single biggest risk in the plan.

### Phoenix's OTA service already exists **[VERIFIED — packages/ota/src/service.js]**

Serves `Update_20160301` with: `ListUpdates`, `ListUpdatesFrom`, `GetUpdateFrom`, `CreateUpdate`,
`RemoveUpdate`, `ListUniqueFilters`, **`SetTarget`**, **`ListTargets`**.

That is exactly the surface the archive describes (`SetOTATarget` / `ClearOTATarget` server-side,
filters on packages). A-08 is already verified, including descending `toVersion` ordering.
**We are not starting from zero — the server half is largely built.**

### How repointing currently works **[VERIFIED — scripts/robot-repoint-server-client.sh, 282 lines]**

Touches exactly: `/etc/hosts` → `/var/etc/hosts` (symlink), `/etc/jibo-jetstream-service.json`,
`/var/jibo/credentials.json` (the `region` field), and 5 `wsendpoint` references.

`credentials.json` holds only `{accessKeyId, secretAccessKey, region}` **[VERIFIED on Moth]** —
so **`region` + DNS override is the entire repointing surface.** Services compose
`<region>.jibo.com` / `<region>-socket.jibo.com` from it. That is why the DNS-override approach
works and why it is cheap to bake into an image.

Known gotcha **[VERIFIED, already hit once]**: `/etc/hosts` is a symlink to `/var/etc/hosts`; if
that file's mode is 700 the renderer (uid 2000) can't read it and silently falls through to DNS.
Must be 644. Any image or postinstall must set this explicitly.

---

## 2. Path A — the one-shot USB/RCM tool

**Audience:** someone with a Jibo and a USB cable, who has never heard of any of this.
**Success:** robot reboots, joins wifi, reaches public Phoenix, and from then on self-updates.

### Sequence

1. **Detect RCM.** Robot held in recovery, connected over USB. Tegra RCM — `tegrarcm` is named in
   the partition doc as the Buildroot flashing tool **[VERIFIED that it's the right family]**;
   exact invocation **[ASSUMPTION — must be confirmed]**.
2. **Back up `/var` FIRST, before touching anything.** Non-negotiable. ~67 MB used on Moth, so a
   compressed image is small. Write it to the operator's machine with the robot serial and a
   timestamp in the filename. **Verify the archive reads back before continuing.** If the backup
   fails, abort — do not proceed to any write.
3. **Also back up the U-Boot env** (`dfu_alt_info`, boot flags). Recovering a robot whose boot
   selection is scrambled is much harder than recovering one whose rootfs is stale.
4. **Patch, minimally.** Two candidate strategies:
   - **A1 (preferred): touch only `/var`.** Write the DNS override and `region` into the variable
     partition. Smallest possible change, no rootfs write, nothing to roll back. The robot boots
     its stock OS and simply resolves `api.jibo.com` to the public Phoenix.
   - **A2: flash a prepared rootfs.** Heavier, riskier, needed only if something outside `/var`
     must change. Prefer A1 until proven insufficient.
5. **Restore `/var`** if we wrote a fresh one, preserving identity/keys from step 2.
6. **Reboot and verify** — ideally the tool waits and confirms the robot checked in with Phoenix,
   rather than declaring success on "the write returned 0."

### Design rules for this tool

- **Backup before mutate, always.** Already the standing rule for robot work in this project.
- **Idempotent.** Running it twice must be safe and must not stack changes.
- **`--dry-run`** that prints every intended write.
- **Refuse to run on an unknown partition layout.** Read and validate `dfu_alt_info` first.
- **One file out, one file in.** The backup should be a single archive the user can hand back to
  us if something breaks.

### Open questions for Path A

- Exact `tegrarcm`/DFU invocation and whether a signed bootloader blocks it **[UNKNOWN]**.
- Whether RCM entry needs a hardware jig/pin short or is key-combo reachable **[UNKNOWN]**.
- Whether the public Phoenix's CA must be injected at this stage too (see §4).

---

## 3. Path B — the self-repointing OTA image

**This is the real prize.** "An over-the-air image that has all that stuff done from the start so
it doesn't even need to be run."

### How it works

Build a **`services` OTA package** (and possibly an `os` one) whose `filesystem.tar.bz2` already
contains the repointed config, plus a `postinstall` that does the parts a tarball can't:

`postinstall` responsibilities:
- Write `/var/etc/hosts` entries for `<region>.jibo.com`, `<region>-socket.jibo.com`, and any
  other service hostnames — **and `chmod 644`**, per the known gotcha.
- Set `region` in `/var/jibo/credentials.json` **without disturbing `accessKeyId`/`secretAccessKey`**.
- Install the public Phoenix CA into the system trust store.
- Be **idempotent** — the doc's retry-on-failure behaviour means `postinstall` may run more than once.

Because `/var` is *not* OTA-able, per-robot identity survives untouched. That is exactly what we
want: the image carries policy, `/var` carries identity.

### Versioning and targets

- Pick a **Phoenix-specific `to_version`** namespace so a Phoenix-updated robot is never confused
  with a Jibo-Inc-updated one.
- Use an **OTA target/filter** like `phoenix-public` so only opted-in robots receive it.
- Phoenix already serves `SetTarget`/`ListTargets`, and server-side targets beat on-robot ones
  **[VERIFIED]** — so the public instance can steer a robot without touching it.

### The chicken-and-egg problem

A robot must *already* reach a Phoenix to receive the repointing OTA. So:
- Path A gets the first hop (DNS override → some Phoenix).
- Path B then hardens and completes it.

There is no way around this without the original cloud. **[ASSUMPTION: worth checking whether a
robot with no server-side target falls back to a DNS name we can hijack purely with a router-level
override — that would make a no-USB path possible for users who can configure their own DNS.]**

---

## 4. Public Phoenix instance — what changes vs. the LAN one

Today's Moth setup is a private CA with SANs for `api.jibo.com` and a LAN IP, and a LAN-trust
posture in several services. A public instance changes the threat model substantially.

Things that must be thought through before exposing anything:

- **Certificates.** Robots pin/trust the system store. A public instance needs either a real CA
  chain the robot already trusts, or CA injection during Path A. **[UNKNOWN which is feasible —
  the robot's Node does *not* trust the Phoenix CA today; that's handled by
  `NODE_EXTRA_CA_CERTS`/a patch script.]**
- **LAN-trust seams become real security boundaries.** Multiple services currently skip
  membership/ownership checks when no account client is injected (documented as LAN trust for
  Media, Person, Backup, Jot). On a public instance these must be closed. **This is a blocker,
  not a nicety.**
- **The `anon` bypass.** Recorded divergence: `Key.Backup`/`Key.Restore` fall back to
  `accountId = caller || 'anon'`, skipping the owner check when the caller can't be resolved.
  Must be fixed before public exposure.
- **SMTP.** Still unconfigured — account activation mail is generated but never sent, so
  activation is manual today. A public instance needs a real sender.
- **Loop keys stay server-blind.** Non-negotiable and already enforced (minting purged, guard test
  in place). A public instance must never regress this.
- **Rate limiting / abuse / storage quotas** — none of this exists.

## 5. Risks, ranked

1. **Infinite OTA retry loop.** No rollback mechanism exists. A bad package bricks robots into
   retrying forever. *Mitigation:* stage on Moth only; keep the target filter narrow; have a fix
   package ready to publish; never publish an `os` update until a `services` one has proven out.
2. **Bricking during RCM flash.** *Mitigation:* prefer the `/var`-only strategy (A1); back up
   U-Boot env; refuse unknown layouts.
3. **Losing per-robot identity/keys.** The 2017 loop key is irreplaceable. *Mitigation:* the `/var`
   backup is step 2 and gates everything after it.
4. **Public exposure of LAN-trust seams.** *Mitigation:* treat §4 as a hard checklist.
5. **Partition numbering mismatch** between doc and live device. *Mitigation:* read `dfu_alt_info`.

## 6. Suggested order of work (when we start)

1. Resolve the real partition/`dfu_alt_info` mapping on Moth. Read-only.
2. Prove a **`services` OTA end-to-end on Moth** using the existing Phoenix OTA service: publish,
   have the robot fetch, apply, verify. No repointing content yet — just prove the pipe.
3. Add the repointing `postinstall`, still Moth-only, still targeted.
4. Only then design the RCM tool, with `/var` backup first.
5. Public-instance hardening (§4) — independent track, can run in parallel.

## 7. Deliberately not decided yet

- Hosting/domain for the public instance.
- Whether to ship an `os` package at all, or stay `services`-only (much safer).
- Whether the RCM tool is a shell script, a small Go/Rust binary, or a Docker image.
- How users opt in / how targets get assigned at scale.
