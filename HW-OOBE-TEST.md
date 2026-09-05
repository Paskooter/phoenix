# Hardware OOBE + OTA Test Runbook (13.0.0 prod bot ↔ Phoenix)

> First on-hardware test of **Phase G** (account/loop/OOBE + portal) and the **OTA** path against a
> real robot. Until now these are wire-/portal-smoke tested only (see
> [`CLASSIC-SERVICES.md`](CLASSIC-SERVICES.md), [`OOBE-PORTAL-HANDOFF.md`](OOBE-PORTAL-HANDOFF.md)).
> Expect to debug the seam — that's the point of the run.
>
> **Bot:** production-signed, platform **13.0.0 "Last Dance"** — i.e. post-Jetstream, the exact
> version set Phoenix mates with. We do **not** want to change the platform.
> **Safety net:** full byte-for-byte NAND backup (known-good restore) + ShofEL2. Recovery is solid.

---

## 0. Goal & end state

Put the bot into **OOBE state pointed at Phoenix**, then walk a real out-of-box:
QR (WiFi + token) → `OOBE.setupRobot` → server-issued creds → OTA check → `normal`.

"OOBE state" = three facts on the bot before boot:
1. `/var/jibo/mode.json` = `{"mode":"oobe"}`  (master switch → only `oobe-config` runs)
2. `/var/jibo/credentials.json` **absent**     (unprovisioned → forces `setupRobot`)
3. every `region_config.json` `endpoint` → `http://<phoenix>:9012`  (so its cloud calls hit Phoenix)
   \+ `jibo-jetstream-service.json` `HubClient.override` → `<phoenix>:9000` (so "Hey Jibo" hits Phoenix)

WiFi is intentionally left to the QR (the real OOBE path).

Two ways to reach that state: **Path A — soft reset** (recommended, keeps 13.0.0) and
**Path B — full re-flash** (only if you also want to exercise a clean flash). Both documented.

---

## 1. Server prep (Phoenix host)

```bash
cd <phoenix>                      # this repo
cp .env.example .env              # optional; set ADMIN_PASSWORD to enable the admin page
npm install
```

Bring up the conversational stack **+** the three robot-revival services (OTA :9010, account+portal
:9011, classic entrypoint :9012):

```bash
bash scripts/run-compose-stack.sh
# robot front door: http://<phoenix-ip>:9012   ← the robot's region resolves here
# portal:           http://<phoenix-ip>:9011   ← you, in a browser
# logs:             /tmp/phx-compose-*.log
```

Leave `DISABLE_AUTH=true` for the first run (LAN trust) so robot JWTs aren't required.

Sanity-check the front door before touching the bot:

```bash
curl -s :9012/healthcheck
curl -s :9012/ -H 'x-amz-target: OOBE_20161026.SetupRobot' -d '{"token":"x","id":"y"}'   # expect a clean AWS-JSON error, not a crash
```

(OTA package build is in **§5** — do it before the run if you chose "serve a real OTA".)

---

## 2. Path A — soft reset to OOBE  *(recommended)*

No platform change, fast, repeatable, reversible. Two variants; **A1 is recommended.**

### A1 — offline mode-flip (ShofEL2) → SSH repoint  *(robust)*

A retail bot in `normal` mode keeps the firewall closed, so SSH is blocked. JiboAutoMod's one
native job — flipping `mode.json` to `int-developer` offline — is exactly the key that opens SSH.
Then the existing Phoenix tooling does the rest cleanly.

**1. Flip to int-developer offline (JiboAutoMod):**

```bash
git clone https://github.com/Jibo-Revival-Group/JiboAutoMod
cd JiboAutoMod
# Put the bot in RCM: hold the small RCM button under the base, tap reset, release on the red LED.
# Confirm:  lsusb  → "NVIDIA Corp. APX"   (vid 0955 pid 7740)
./jibo_automod.sh --mode-json-only        # fast path: GPT + /var only, patches normal→int-developer
```

Boot the bot. It comes up in `int-developer`: services run, firewall open, SSH = `root` / `jibo`.

**2. Repoint at Phoenix (one SSH pass — region_config for ALL classic services + jetstream hub):**

```bash
# RUN ON YOUR PC.  args: <robot-ip> <phoenix-ip> [classic-port=9010] [hub-port=9000]
# Pass 9012 for the full classic entrypoint (OOBE/update/log/robot/…), NOT 9010 (OTA-only).
scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> 9012 9000
```

**3. Verify the wiring while you still have SSH + creds:**

```bash
ssh root@<robot-ip> 'jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 13.0.0'
#   → if you stocked a higher OTA (§5): prints the Update JSON for the new version
#   → if not: an UPDATE_NOT_FOUND error (expected, and that's the code OOBE tolerates)
# Either way a matching "update query" line appears in /tmp/phx-compose-ota.log on the host.
```

**4. Drop into OOBE state and reboot:**

```bash
ssh root@<robot-ip> '
  jibo-mount --rw
  cp -a /var/jibo /var/jibo.phx-bak                       # local snapshot (you also have the NAND backup)
  printf "{\"mode\":\"oobe\"}\n" > /var/jibo/mode.json
  rm -f /var/jibo/credentials.json
  sync
'
# OPTIONAL — pristine "WiFi from QR" experience (drops WiFi SSH; do nothing else after):
# ssh root@<robot-ip> 'rm -f /var/jibo/wpa_supplicant.conf /var/jibo/wifi* 2>/dev/null; sync'
ssh root@<robot-ip> reboot
```

→ continue at **§4 (OOBE walkthrough)**.

> If anything goes wrong you've lost nothing: re-run JiboAutoMod `--mode-json-only` to get back to
> `int-developer`+SSH, restore `/var/jibo.phx-bak`, run `point-robot-at-phoenix.sh <robot-ip> --reset`.

### A2 — fully offline (write region + mode + creds via ShofEL2, no runtime SSH)

This is the "write the server address offline, then just boot into OOBE" approach. It reaches the
same end state without an `int-developer` boot, **but** `region_config.json` is **not** on `/var`
(JiboAutoMod's fast path), it's duplicated across the read-only rootfs/`/usr/local`(services) and
`/opt` trees — so you must edit those partitions by hand. More steps, more ways to typo. Use A1
unless you specifically need zero runtime boot.

```bash
# 1. Full dump (keep it; it doubles as a working copy)
./jibo_automod.sh --dump-only -o jibo_work/full.bin

# 2. For EACH partition that carries region_config.json (rootfs, services/usr-local, and /opt if separate)
#    — read its start-sector/size from the GPT the tool prints — carve it out and edit with debugfs:
#      debugfs -w part.img
#        debugfs: ls -l <path-to>/region_config.json     # locate every copy (they all contain "globalSSL")
#        debugfs: dump <path> /tmp/rc.json               # extract
#        # edit /tmp/rc.json: set every rules.*/patterns.* .endpoint = "http://<phoenix>:9012"
#        #                    and .globalEndpoint = true   (same transform point-robot-at-phoenix.sh applies)
#        debugfs: rm <path> ; write /tmp/rc.json <path>   # write back
#    Also edit jibo-jetstream-service.json: set HubClient.override = {hub_hostname:"<phoenix>",hub_port:9000,
#      entrypoint_hostname:"<region>.jibo.com"}.
# 3. /var partition: mode.json → {"mode":"oobe"} ; delete credentials.json (debugfs as above).
# 4. Write the modified partitions back:
./jibo_automod.sh --write-partition var_partition.img    --start-sector 0x<var-start>
./jibo_automod.sh --write-partition services_partition.img --start-sector 0x<svc-start>
# (repeat --write-partition for each edited partition)
```

Boot → straight into OOBE, already pointed at Phoenix → **§4**.

> Honest take: there are many `region_config.json` copies and `debugfs` file-replace is awkward;
> A1's runtime `find`+rewrite is what the tooling is built for. I'd only hand-do this offline if
> you have a reason to avoid the transient `int-developer` boot.

---

## 3. Path B — full re-flash (13.0.0 same-platform, or the genuine factory RTM image)

Only if you want to **also** exercise a clean flash. It's strictly *more* work than Path A for the
same OOBE test, **wipes the Top-of-Stack** (Be/SSM/skills live in `/opt`, delivered separately —
gone after a flash until re-synced or OTA'd), and **resets `region_config` to the dead
`*.jibo.com` defaults** — so you still have to repoint afterward exactly as in Path A.

Two image choices below: **option 1** re-flashes the *same* 13.0.0 platform (clean flash, no version
change); **option 2** is the **genuine factory image retail bots shipped with** (RTM) — a true
factory OOBE, but a deliberate downgrade whose base is thin by design. Both drive the bits onto the
bot with the same tool — **`flash_jibo`**, documented next.

### The flasher: `flash_jibo` (the official recovery-mode tool both options use)

The `flash-jibo.sh` line in both options is **`flash_jibo`**, Jibo's NVIDIA-Tegra recovery-mode
flasher (source: `PlatformTeam/buildroot.jibo` → `board/nvidia/avionic/flash-jibo.sh`, a thin wrapper
around `flash-dfu.sh`). Two ways to get it:

- **Bundled — use this; nothing extra to fetch.** A `jibo-pvt-flash-build-*` tarball (option 1's
  13.0.0-`prod`, option 2's RTM3) **is already a complete flasher** — it untars to a top-level
  `flash_jibo/` directory with the partition images under `output/`. Untar the build *into an empty
  dir* and run it in place:
  ```bash
  mkdir -p ~/flash-work && cd ~/flash-work
  tar xjf <prod-buildroot>.tar.bz2 -C .     # → creates ./flash_jibo/  (NOT a bare rootfs)
  cd flash_jibo/
  ls output/images/                         # sanity: rootfs.ext4, var/services/skills.ext4, meerkat_rev02.bct
  # ⚠️ prod-fused bot → MUST sign with -p (a bare -o hangs at BR_CID); see "Prod-fused bots" below:
  sudo ./flash-jibo.sh -o output/ -p ~/secure_boot/jibo-rsa_priv.der
  ```
- **Standalone source — legacy / source-of-truth only; not for the builds above.** The tool's own
  repo is `blair/flash_jibo` (`https://pvindex.org/gitea/blair/flash_jibo`). ⚠️ Its README's
  `tar xjf <RELEASE> -C Linux_for_Jibo/rootfs` expects a **bare rootfs** image (one that expands to
  `etc/ boot/ usr/ …`, yielding `rootfs/etc/hosts` + `rootfs/boot/zImage`). A `jibo-pvt-flash-build-*`
  tarball is **not** that — drop one into `Linux_for_Jibo/rootfs` and you just nest a flasher inside a
  flasher; `flash_jibo.sh` then aborts with **exit 2 ("root file system is not populated")**. Only use
  this route if you genuinely have a bare rootfs:
  ```bash
  git clone https://pvindex.org/gitea/blair/flash_jibo
  cd flash_jibo
  sudo tar xjf <BARE-ROOTFS>.tar.bz2 -C Linux_for_Jibo/rootfs   # must yield rootfs/etc/hosts + rootfs/boot/zImage
  sudo ./flash_jibo.sh                                          # NB: underscore in the repo script
  ```
  Under the hood it copies `rootfs/boot/{zImage,tegra124-tobor.dtb}` into place, then drives the Tegra
  flasher `Linux_for_Jibo/jibo-flash.sh jibo-ad mmcblk0p1` (config `jibo-ad`, target partition
  `mmcblk0p1` — leave both as-is).

> **Which do I have?** `tar tjf <build>.tar.bz2 | head` — if the top entries are `flash_jibo/` /
> `output/` it's the bundled flasher (use route 1); if they're `etc/ boot/ usr/ …` it's a bare rootfs
> (route 2). The `jibo-pvt-flash-build-*` builds in this runbook are all the former.

**Bundled `flash-jibo.sh` flags** (straight from source — the set its usage text prints):

| Flag | Meaning |
|---|---|
| `-o <dir>` | **Required.** Buildroot output dir (`output/`); autoselects the partition images + the bundled host tools. Missing / not-a-dir → exits `Buildroot output dir has to be specified` (the error you hit). |
| `-p <key>` | PKC private key for **signed RCM communication**. **Default none = non-secure.** A **fused** bot requires it — see below. |
| `-b <bct>` | BCT (boot-config table). Default `<output>/images/meerkat_rev02.bct`; leave as-is unless your SOM rev differs. |
| `-m <base>` | Basename for tegrarcm **pre-signed** message files (the key-less secure route from `flash_jibo_secure.tar.bz2`); alternative to `-p`. |
| `-u <path>` | Flash a specific USB device path (used by the `flash-auto.sh` autoflasher). |

It hands off to `flash-dfu.sh` and writes **both rootfs slots + the data partitions**: `rootfsA` and
`rootfsB` ← `rootfs.ext4`, `var` ← `var.ext4`, `services` ← `services.ext4`, `skills` ← `skills.ext4`.
(It also warns + prompts if host RAM < 2 GB.)

> **⚠️ Prod-fused bots MUST sign, or the flash hangs.** Our bot is production-fused (`odm_production_mode`
> + a burned `public_key` fuse). Per *Step-by-Step Guide to Secure-Boot Flashing on Jibo*, once fuses
> are blown a **non-secure flash stalls** at a line like `BR_CID: 0x64001001…` — so
> `sudo ./flash-jibo.sh -o output/` **alone will hang**. You must pass `-p` with **Jibo's production
> PKC private key**, which is in the archive:
> ```bash
> mkdir -p ~/secure_boot && cd ~/secure_boot
> wget http://pvindex.org/repository/platformos/NVIDIA/secure_boot/jibo-rsa_priv.pem   # 1.6 KB
> openssl rsa -in jibo-rsa_priv.pem -outform DER -out jibo-rsa_priv.der   # Crypto++ tegrarcm wants DER, not PEM
> ```
> then add `-p ~/secure_boot/jibo-rsa_priv.der`. Two more things: the **image** must also be a real
> **prod** build (its on-disk u-boot is signed with the same key — the `-prod`/RTM tarballs are; a
> `-dev` build will *flash* but won't *boot*), and because this is a raw partition write (not an OTA)
> it **bypasses OTA-layer anti-rollback** — which is what lets option 2's 13.0.0→3.3.4 downgrade
> through. When you have SSH (Path A) confirm the bot is fused with *this* key:
> `egrep -r . /sys/devices/platform/tegra-fuse` → `public_key:0x440a4a60…47459e` and
> `odm_production_mode:0x00000001`. **Never** add `--write-fuses` / touch the fuses — they're already
> burned; `-p` only *signs the comms*. (Key-less alternative: the method-2 env
> `flash_jibo_secure.tar.bz2` in the same archive dir, fed via `-m`.)

**Host prerequisites:** Ubuntu **14.04**, a free **USB 2.0** port, packages `libusb-1.0.0-dev`,
`libcrypto++`, `dfu-util`. The bundled flasher uses buildroot's own host tools/libs from
`output/host/`, so there's nothing to compile.

**Run it:**
1. **Force Recovery (RCM)** first — head-board button combo, solid red LED (same RCM as JiboAutoMod in
   §2).
2. Confirm the host sees the board: `lsusb | grep -i nvidia` → `ID 0955:7740 NVidia Corp.`. No such
   line ⇒ not in recovery.
3. Run the bundled command (fused bot ⇒ include `-p`). A full write is **~10 min**.
4. On success, **reset the board**; it boots the freshly-flashed OS. Then `jibo-setidentity` /
   `jibo-setmode` per each option.

> **Two scripts — don't confuse them.** The **bundled** `flash-jibo.sh` (hyphen, what you have) takes
> `-o/-p/-b/-m/-u`, wraps `flash-dfu.sh`, and is the one to use. The **repo** `blair/flash_jibo`'s
> `flash_jibo.sh` (underscore) is the older nvflash variant with *no flags* — it self-checks
> `Linux_for_Jibo/rootfs/etc/hosts` and exits `2`/`3`/`5` (rootfs-not-populated / not-in-recovery /
> flash-failed). They are not interchangeable.

> **Troubleshooting — `tegrarcm: error while loading shared libraries: libcryptopp.so`.** The bot was
> detected fine; this is a *host* dependency. The flasher (`output/host/usr/bin/tegrarcm`) is linked
> against Crypto++ and the loader can't find it — the current `flash-jibo.sh` exports
> `LD_LIBRARY_PATH=./output/host/usr/lib`, but the RTM-era bundled script predates that and instead
> expects `libcrypto++` installed on the host (a repo-README prereq). Put the lib on the
> always-searched system path:
> ```bash
> find output/host -iname 'libcryptopp*'                                 # locate the bundled copy
> sudo cp -a output/host/usr/lib/libcryptopp.so* /usr/local/lib/ && sudo ldconfig   # exact-ABI fix
> # versioned-only? add the bare soname: (cd /usr/local/lib && sudo ln -sf libcryptopp.so.* libcryptopp.so) && sudo ldconfig
> ```
> If the build doesn't bundle it, install it instead: `sudo apt-get install libcrypto++9 libcrypto++-dev`
> (Ubuntu 14.04/16.04). Re-run the flasher afterward.
>
> **On a modern distro (e.g. 24.04): do NOT `apt install` crypto++.** `tegrarcm` was built against
> **Crypto++ 5.6.x**; 22.04/24.04 ship **8.x** (`libcrypto++8`) — the soname resolves but C++ symbols
> mismatch, so you'd then get `undefined symbol: …`. Use the **bundled** `output/host/usr/lib/libcryptopp.so*`
> (5.6.x, exact ABI) via the copy above, and `ldd output/host/usr/bin/tegrarcm` to confirm nothing
> else is unresolved. If more 2017-era libs cascade, run the flasher in an **Ubuntu 16.04 Docker
> container** (`docker run --rm -it --privileged -v /dev/bus/usb:/dev/bus/usb -v <flash_jibo>:/work
> -v ~/secure_boot:/secure_boot ubuntu:16.04 bash`; inside: `apt-get install -y libcrypto++9
> libusb-1.0-0`) — 16.04's Crypto++ matches the ABI, and `--privileged -v /dev/bus/usb` follows the
> recovery→DFU re-enumeration (`0955:7740`→`0955:701a`) that VM USB-passthrough handles poorly.

> **Troubleshooting — `BER decode error` then `RCM query version: USB transfer failure`.** You're past
> the lib stage and into signed RCM: `tegrarcm` read the chip `device id`/`uid` (unsigned), then failed
> on the first *signed* exchange. Work it in this order:
> 1. **Key format.** Crypto++ BER/DER-decodes the key and does **not** parse PEM; convert and pass the
>    `.der` (already wired into the commands above):
>    `openssl rsa -in ~/secure_boot/jibo-rsa_priv.pem -outform DER -out ~/secure_boot/jibo-rsa_priv.der`
>    (PKCS#8 fallback: `openssl pkcs8 -topk8 -nocrypt -in jibo-rsa_priv.pem -outform DER -out jibo-rsa_priv.der`).
> 2. **If PEM and DER give *byte-identical* output, format isn't the cause** — verify the key file
>    itself: `openssl rsa -in ~/secure_boot/jibo-rsa_priv.pem -noout -check` (want `RSA key ok`). If it
>    says "unable to load key" or `file` shows HTML/text, the download was bad — re-fetch from the
>    **live** mirror `http://pvindex.org/repository/...` (the original `repository.jibo.media.mit.edu`
>    host is dead and won't resolve off-VPN).
> 3. **Still `Resource temporarily unavailable` (EAGAIN) though the uid read fine → it's USB.** Tegra K1
>    RCM needs a **USB 2.0** link; modern laptops are USB-3-only and the xHCI path is flaky for RCM. Put
>    a **USB 2.0 hub** between host and bot (the canonical fix), use a known-good **data** cable,
>    re-enter Force Recovery just before retrying, and watch `sudo dmesg -wH` for `reset`/`-71`/`-110`
>    USB errors to confirm.
> 4. **Key-less alternative (pre-signed msgs).** If `ls output/images/` shows `tegrarcm-msgs.qry`, the
>    build ships pre-signed RCM messages. ⚠️ The bundled `flash-jibo.sh` **can't take `-m`** — its
>    `getopts` string (`":b::o::p::u::h"`) omits `m`, so the `m)` case is dead code and `-m` →
>    "Invalid option". Call the inner `flash-dfu.sh` directly instead (it supports `-m`, and even
>    auto-detects `tegrarcm-msgs.qry`); use `-m` *without* `-p`:
>    ```bash
>    sudo env LD_LIBRARY_PATH="$PWD/output/host/usr/lib" ./flash-dfu.sh -o output/ \
>      -m output/images/tegrarcm-msgs \
>      rootfsA:images/rootfs.ext4 rootfsB:images/rootfs.ext4 \
>      var:images/var.ext4 services:images/services.ext4 skills:images/skills.ext4
>    ```
>    If `tegrarcm-msgs.qry` is absent, this route doesn't exist for the build — fall back to the
>    `-p`/key/USB steps above.
> 5. If USB is clean and the key is valid but it still rejects, the bot may be fused with a *different*
>    key — verify over SSH (Path A): `tegra-fuse/public_key` must equal `0x440a4a60…47459e`.

### Image option 1 — same-platform re-flash (13.0.0, keeps the bot where it is)

The platform buildroot that matches this bot lives in the engineering archive
(`repository.jibo.media.mit.edu`, mirrored on the portal, VPN-only):

| | File | Size | Date |
|---|---|---|---|
| **prod — use this** | `jibo-pvt-flash-build-13.0.0-lastdance-rc2-20190225-prod.tar.bz2` | 695 MB | 2019-02-25 |
| dev — do **not** use on this bot | `jibo-pvt-flash-build-13.0.0-lastdance-rc2-20190222-dev.tar.bz2` | 694 MB | 2019-02-22 |

```
/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-13.0.0-lastdance-rc2-20190225-prod.tar.bz2
```

**Why the `-prod` one.** This is `13.0.0 "Last Dance" rc2` — the exact platform the bot already runs
(§0) — in its **production-signed** form. Our bot is production-fused, so secure boot (PKC) will
**reject** the `-dev` build; the dev tarball is only for un-fused / dev-fused bots. For this run it's
the `-prod` tarball, full stop. (It's also the only 13.0.0 build in the archive — the only other
"Last Dance" tarballs are `12.11.0-lastdance-rc1` and an unversioned `last-dance-rc1`, both older
RC1 *dev* builds.)

**"OOBE" is a *mode*, not a separate image.** Flashing this buildroot does **not** by itself land
the bot in OOBE — it boots to whatever `jibo-setmode` last wrote, and the factory sets `oobe`
*after* the flash (per the platform *Robot Mode Configurations* doc: "Jibos leave the factory in
this mode … starts the oobe-config skill on boot"). So the order is: flash this tarball →
`jibo-setidentity` → set mode `oobe` (the `mode.json` write in the step below) → reboot into the
factory out-of-box experience. Heads-up from the platform guide: once in `oobe` you can't develop on
the bot and **must flash again from scratch to leave that mode** — fine here, that's the point of the
run.

**No published checksum.** Unlike most earlier builds, the two `13.0.0-lastdance-rc2` tarballs ship
**without** a companion `.sha256` (the directory's `sha256.txt` is from 2018-04-03, long before
these). Verify integrity against your own known-good copy / the NAND backup, not an archive hash.

```bash
# Either: ShofEL2 raw write of the flash image's partitions
./jibo_automod.sh --write-partition <slot>.img --start-sector 0x<start>     # per partition from the -prod build above
# Or: the official recovery-mode flasher unpacked from the -prod buildroot tarball above
#   (untar it → flash_jibo/; RCM, USB; ~10 min). -p is REQUIRED on our fused bot (see flasher §).
cd flash_jibo/ && sudo ./flash-jibo.sh -o output/ -p ~/secure_boot/jibo-rsa_priv.der

# Then over the hardline (172.24.84.101) or after a JiboAutoMod int-developer flip:
ssh root@172.24.84.101 jibo-setidentity                 # paste  Name-Name-Name-Name,SERIAL
scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> 9012 9000   # region + jetstream
ssh root@<robot-ip> 'jibo-mount --rw; printf "{\"mode\":\"oobe\"}\n" > /var/jibo/mode.json; rm -f /var/jibo/credentials.json; sync; reboot'
```

Your byte-for-byte NAND image is the clean way back from anything here.

### Image option 2 — the genuine factory image (RTM): what retail bots actually shipped with

**This is the one you asked for.** Retail Jibos did *not* leave the line on 13.0.0 — they shipped on
the **RTM ("Release To Manufacturing")** platform, a deliberately *thin* base. The factory burned
RTM, set `oobe`, and the bot pulled the real OS/services **and the whole Top-of-Stack (Be + skills)
at first boot over OTA** during the customer's OOBE. So a bare RTM flash *is* "missing skills" — **by
design**; the skills arrive in the OOBE→OTA step, not in the image. (Every platform does ship
`oobe-config` itself, so OOBE runs immediately — per *How to Run OOBE Config on Robot*: "ALL ROBOT
PLATFORMS COME WITH OOBE-CONFIG ALREADY INSTALLED".)

Two production (PKC-signed) factory runs exist, both under `release-production/`:

| Run | os/services base | Prod-signed flash tarball | Size | SHA-256 |
|---|---|---|---|---|
| **RTM3** — later run, **use this** | 3.3.x | `jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2` | 719 MB | `225bc6…228d8` |
| RTM2 — original Mark-I run | 3.0.10 | `jibo-pvt-flash-build-RTM2-3.0.9-20170303.tar.bz2` | 720 MB | `0cfe3f…23a9` |
| RTM2 — earlier RC | 3.0.10 | `jibo-pvt-flash-build-RTM2-3.0.8-20170220.tar.bz2` | 720 MB | `abaffc…b542` |

```
/repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2
  sha256  225bc6721808d907a3acbc5c17b3d9ad6a8e5b5ed444a85ccee5cb7a50d228d8
```

**Why RTM3 3.3.4 for our bot.** *How to Flash a Robot – Advanced* names it explicitly: "To flash to
a **production** build … flash to **RTM3 prod: 3.3.4**. Only available for prod-fused or unfused
robots." Our bot is production-fused and this tarball is prod-signed, so secure boot accepts it. RTM3
is the newer of the two factory loads; RTM2 was the original mass-production base (3.0.10 — its
prod-signed flash artifacts top out at 3.0.9), use it only to reproduce the *first* production run.
**Do not** use the `-dev` RTM tarballs (under `release-dev/`) on a prod-fused bot — secure boot
rejects them. (These three `release-production/` tarballs *do* carry published checksums — verify them,
unlike the 13.0.0 builds above.)

**⚠️ This is a big downgrade: 13.0.0 → 3.3.4.** It's the opposite of §0's "don't change the platform"
— an intentional drop back to the shipping base. The official flasher does a full raw partition
overwrite (not an OTA), and every RTM / Last-Dance build is signed by the same prod PKC key, so the
*signature* is fine; the only theoretical blocker is Tegra monotonic anti-rollback fuses. RTM3
flashed onto prod bots routinely in 2017, and your **byte-for-byte NAND backup is exactly the safety
net for this** — confirm you have it before you start.

**Flash it (prod bot, from here):**

```bash
# 1. Fetch + verify the prod RTM3 image (VPN to the archive host)
wget http://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2
echo '225bc6721808d907a3acbc5c17b3d9ad6a8e5b5ed444a85ccee5cb7a50d228d8  jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2' | sha256sum -c

# 2. Flash — same mechanism as option 1: RCM/recovery, USB, ~10 min. -p REQUIRED (fused bot; see flasher §)
tar xjf jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2 -C .
cd flash_jibo/ && sudo ./flash-jibo.sh -o output/ -p ~/secure_boot/jibo-rsa_priv.der

# 3. Identity + factory OOBE mode, then repoint at Phoenix (hardline 172.24.84.101)
ssh root@172.24.84.101 jibo-setidentity                 # paste  Name-Name-Name-Name,SERIAL
ssh root@172.24.84.101 jibo-setmode oobe                # genuine factory mode (an RTM bot OTAs automatically in oobe)
scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> 9012 9000   # region + jetstream
ssh root@<robot-ip> reboot
```

A freshly-flashed RTM bot, like any flash, comes up on the dead `*.jibo.com` region defaults, **and**
its `oobe-config` has the shipping entrypoint/filter baked in (`rtm2Jinx` etc. in
`/opt/jibo/Jibo/Skills/oobe-config/oobe-config.js`). `point-robot-at-phoenix.sh` rewrites
`region_config`; if OOBE still won't resolve to Phoenix, that hardcoded oobe-config entrypoint is the
next thing to repoint (see *How to Flash a Robot – Advanced* → "Set Filters" for the exact `sed`).

**Getting from thin RTM to a fully-populated bot — two ways, mirroring how it worked in 2017:**
- **Factory-faithful:** flash RTM3 → `oobe` → run OOBE against Phoenix and let it OTA up. Works only
  if **Phoenix stocks the upgrade OTAs** (os/services 3.3.x→target, plus `@be/be`, the skills, and
  `oobe-config`); otherwise the bot completes OOBE but stays on the bare base = still missing skills.
  Note this inverts §5: a 13.0.0 bot gets `UPDATE_NOT_FOUND` (no-op), but a 3.3.4 bot genuinely
  *wants* the whole upgrade chain — that's a much bigger OTA to stock.
- **Shortcut:** flash RTM3 → `int-developer` → hardline-`sync` the Top-of-Stack (Be/SSM/skills) per
  *How to Flash a Robot – Simple/Advanced* "Sync TOS", then `jibo-setmode oobe` and reboot.

---

## 4. OOBE walkthrough (both paths converge here)

1. Bot boots in `oobe` mode → screen shows the OOBE/viewfinder; only `oobe-config` runs.
   (If it doesn't auto-launch, hit **Launch** for `oobe-config` at `http://172.24.84.101:8779`.)
2. Browser → **`http://<phoenix-ip>:9011`** → sign up / log in → **Add a robot** → enter your home
   **WiFi SSID + password** → the portal renders the **QR** (WiFi creds + one-time setup token).
3. Tap Jibo's screen for the viewfinder; hold the QR up so the whole code is in frame.
4. Watch it happen (host logs):
   - **WiFi join**, then `OOBE_20161026.SetupRobot` → `/tmp/phx-compose-account.log`
     (mints `accessKeyId`/`secretAccessKey`, creates the loop, returns creds; bot writes
     `/var/jibo/credentials.json` itself). Portal poll flips the robot to "complete".
   - **OTA check** → `/tmp/phx-compose-ota.log` (`ListUpdatesFrom`/`GetUpdateFrom` per subsystem).
     `@be/be` is queried first alphabetically and **must** get `UPDATE_NOT_FOUND` (the tolerated
     code) or the whole check aborts — that handling is already in `packages/ota`; this run proves
     it on metal. If you stocked a real update (§5), the "Updating…" screen appears and it installs.
   - `setMode normal` → reboot → "Skills Service Manager is Ready".

**What to watch for (first hardware test of Phase G):**
- OOBE `targetPrefix` is `OOBE_20161026` (confirmed). If the bot's installed client uses a
  different prefix it'll 400 — grab it off the bot:
  `find / -path '*jibo-server-client*' -name 'oobe-*.normal.json'` then check `metadata.targetPrefix`.
- The QR encoder is a from-scratch reimpl (`packages/account/portal/qr.js`). If the camera won't
  decode it, that's the first suspect — compare against a known-good app QR if you have one.
- Notification `wsendpoint` (`<region>-socket.jibo.com`) is **not** repointed by the script — fine
  for OOBE+OTA, only matters for push/Commander (see `DIVERGENCES.md`).

---

## 5. OTA: what "serve a real OTA" should actually be

The bot is **already 13.0.0**, so by default Phoenix answers `UPDATE_NOT_FOUND` for every subsystem
and OOBE's OTA step just completes — which already exercises the endpoint + the mandatory
error-code handling. To see an actual **download + install**, stock a higher version. Two options:

**(a) Skill-subsystem OTA — recommended for the first real install.**
Installs into `/opt` (untar), **no rootfs swap, no secure-boot exposure, version actually sticks.**
Pick a skill the bot has (e.g. `oobe-config`/`jibo-diagnostics`), bump its `package.json` version,
pack it in the reference format and add a manifest entry:

```bash
# build one <subsystem>-<ver>.tar  =  uncompressed tar containing ./filesystem.tar.bz2 of the skill's files
mkdir -p pkg && (cd <skill-dir> && tar -cjf - .) > pkg/filesystem.tar.bz2
tar -C pkg -cf packages/ota/data/oobe-config-9.0.1.tar .
# manifest.json → add: {id:"oobe-config-9.0.1",subsystem:"oobe-config",fromVersion:"*",toVersion:"9.0.1",
#                       filter:"",dependencies:{},file:"oobe-config-9.0.1.tar"}
```

**(b) os/services firmware OTA — the headline path, but read this caveat.**
`build-ota-packages.sh` can repack your 13.0.0 buildroot under a higher label:

```bash
scripts/build-ota-packages.sh --buildroot <your 13.0.0 prod build> --version 13.0.1
# then add os-13.0.1 / services-13.0.1 entries to manifest.json (services deps {os:13.0.1})
```

⚠️ **Caveat (verify before relying on it):** the builder repacks the rootfs **bytes unchanged** and
only renames the tar — it does **not** edit the in-image version file. So after "applying 13.0.1"
the bot may still report 13.0.0 and get offered 13.0.1 again → **update loop**; and if the rootfs is
dm-verity/signature-checked, an edited version file would fail the check instead. Net: the os/services
relabel is **not** a clean "install once and settle" test. If you want the firmware A/B path, the
honest test is a genuine version step (e.g. offline-downgrade to 12.10.0, then OTA up to 13.0.0) —
bigger exercise. **I can dig into `system-manager/UpdateManager.cpp` to settle exactly how installed
version is recorded** before you commit to (b).

**Suggested sequence:** run OOBE once with the **no-op** path (de-risk the account/QR/OTA seam),
then add the **skill OTA (a)** and re-run to watch a real download+install.

---

## 6. Recovery cheat-sheet

| Situation | Recovery |
|---|---|
| Need SSH back | JiboAutoMod `--mode-json-only` → `int-developer`, SSH `root`/`jibo` |
| Undo the repoint | `scripts/point-robot-at-phoenix.sh <robot-ip> --reset` (restores `*.phx-bak`, clears hub override) |
| Restore provisioning | copy back `/var/jibo.phx-bak` → `/var/jibo` |
| Anything worse | write back the **byte-for-byte NAND backup** (known-good) |

---

## 7. Decisions locked for this run
- **Reset method:** soft reset (Path A) primary; full re-flash (Path B) documented. (No platform change — bot stays 13.0.0.)
- **OTA depth:** serve a real OTA — recommended as a **skill-subsystem** install (§5a); os/services relabel carries the §5b caveat.
- **Transport / repoint:** offline `mode.json` flip via ShofEL2 (JiboAutoMod), region/jetstream repoint via `point-robot-at-phoenix.sh`; QR supplies WiFi.
