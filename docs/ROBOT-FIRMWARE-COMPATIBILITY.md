# Robot firmware compatibility of `robot-ota-repoint.sh`

The repoint helper has to work on whatever firmware a robot arrives with, including a
robot that is new in its box. This page records what differs between firmware versions
in the places the helper touches, how the helper handles each difference, and what is
still unverified. It was compiled on 2026-09-28 from the archived flash builds, the
archived npm registry, and a dry run against the physical test robot (13.0.7).

## Which firmware robots actually run

| Where a robot comes from | Platform version | Evidence |
|---|---|---|
| New in box, early production | **3.0.8–3.0.10 (RTM2)** | Release notes list OTAs "RTM2 OS 3.0.10 → 8.5.1"; `release-production/jibo-pvt-flash-build-RTM2-3.0.9-20170303` |
| New in box, main production | **3.3.x (RTM3)** | "RTM3 OS 3.3.3 → 8.11.0"; `release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623` |
| New in box, late production | 8.13–8.19 | `release-production/jibo-pvt-flash-build-8.1{3,6,9}.0-*` |
| Updated by the original cloud | 8.x (EAU, autumn 2017) through 12.10 (Aug 2018) and 13.0.0 (Feb 2019) | buildroot release tags; FSRN release notes |
| USB-flashed by owners | 5.4.0 (EFT) and 13.0.0 | `docs/parity/OTA-UPGRADE.md` |

A robot that has never been set up is on RTM2 or RTM3 firmware, on a setup screen, with no
credentials. That is the path the helper's `--auto` mode takes when it finds no
`/var/jibo/credentials.json`.

## What differs, by version

Probed from the ext4 images of each archived flash build with
`tools/firmware-compat/fetch-probe.sh`.

| Platform | Node | Server client (copies found) | OTA downloader | Backup/restore helpers | Jetstream hub config | Socket suffix in server service | Setup skill region |
|---|---|---|---|---|---|---|---|
| 3.0.9 (RTM2 factory) | 4.1.2 | 2.x (3) | B | none | — | — | none |
| 3.3.3 (rtm3-dev) | 4.1.2 | 2.x (3) | A | none | — | — | none |
| 3.3.4 (RTM3 factory) | 4.1.2 | 2.x (3) | A | none | — | — | none |
| 5.4.0 (EFT) | 6.9.2 | 3.x (3) | B | B | — | — | none |
| 8.19.0 (production) | 6.9.2 | 3.x (5) | A | A | — | yes | stg-entrypoint |
| 9.8.8 | 6.9.2 | 3.x (6) | A | A | — | yes | stg-entrypoint |
| 10.5.7 | 6.9.2 | 3.x (14) | A | A | — | yes | stg-entrypoint |
| 11.7.0 | 6.9.2 | 3.x (14) | A | A | — | yes | stg-entrypoint |
| 12.9.0 | 6.9.2 | 3.x (5) | A | A | yes | yes | stg-entrypoint |
| 13.0.0 (Last Dance) | 6.9.2 | 3.x (5) | A | A | yes | yes | stg-entrypoint |

- **OTA downloader** (`@jibo/jibo-ota-updater/src/download-update.js`): **A** is the
  stock file from updater 1.3.0 in RTM3 through 1.4.1 in 13.0.x; **B** is the RTM2 and 5.4.0
  file. They differ only in progress reporting; the request the patch changes is identical.
- **Backup/restore** (`/usr/local/bin/jibo-system-{backup,restore}`): **A** is 8.x–13.0.x;
  **B** is 5.4.0 (restyled, with a renamed key call). The two patch anchors are present
  exactly once in both, around the same upload and download calls.
- **Server client**: every archived `@jibo/jibo-server-client` ships one of exactly two
  `lib/http/node.js` files: one for 2.0.0–2.11.x, one for 2.12.0 and every 3.0.x. The
  factory images use 2.10.31.
- **Copies found**: 10.x and 11.x nest nine extra copies inside `jibo-ssm`'s own
  dependencies. The physical test robot (13.0.7 plus BE parity skills) has 24, 14 of which
  the previous fixed path list missed and which still pointed at jibo.com.

### The same on every version probed

- OpenSSH 7.3p1 with ed25519 host keys, `PermitRootLogin yes`, password login enabled,
  `/usr/libexec/sftp-server`, and a root password hash that verifies as `jibo`.
  Host keys are generated on the robot, so a reflash gives it new ones (Aero, 2026-09-29).
  The helper trusts a never-seen robot on first use, ignores keys filed under a robot's old
  DHCP address (`CheckHostIP=no`), and for a changed key shows the new fingerprint and asks
  before removing the old entry with `ssh-keygen -R`; `--yes` does not answer that question.
- The firewall init script rejects inbound connections, SSH included, in `normal` and
  `oobe` modes, and leaves them open in `int-developer`, `identified` and `developer`
  (checked on RTM3 3.3.4, 5.4.0, 8.19.0, 10.5.7 and 13.0.0; not recorded for RTM2).
  The helper therefore assumes the owner has put the robot in `int-developer` mode.
- Partitions: `/usr/local` is `mmcblk0p4`, `/var` is `mmcblk0p5`, `/opt` is `mmcblk0p6`.
  `/usr/local` is mounted read-only from 8.x on and read-write before that.
- Tools: `curl`, `sha256sum`, busybox `find`, `mktemp`, `blockdev`, `resize2fs`,
  `jibo-getmode`, `jibo-setmode`, `jibo-version`. No `openssl`. `jibo-mount` exists from 8.x on.
- Trust store: 180 certificates, no ISRG Root X1, no `/etc/ssl/cert.pem`.
- `region_config.json`: the same `rules`/`patterns` shape with five `jibo.com` names.
- System manager on port 8585 with the `/update/<filter>` route the OTA trigger uses
  (the 3.x pattern accepts only alphanumeric filters, which `fcs` is).
- Every image's `jibo-asr-service.json` names `speech-logging.jibo.com`; that is ASR logging
  only and is left alone.

## How the helper handles each difference

| Difference | Versions | Previous behaviour | Now |
|---|---|---|---|
| Robot has no SSH key installed | all, out of the box | stopped: "cannot reach robot" | logs in with a key if there is one, then the factory password, then prompts once; one shared connection for every step |
| Newer SSH clients run `scp` over SFTP | client-side | relied on scp | uploads with `cat` over the shared connection |
| Node 4.1.2 lacks `Buffer.from(string)` | 3.x | both patchers crashed | fallback to `new Buffer`; every robot-side helper checked on a real Node 4.1.2 |
| 2.x server client | 3.x | the 3.x build was installed and **crashed on load**, taking every Node client offline while the hash check still passed | `node-v2.js`, chosen per copy by the stock handler's hash; an unrecognized handler stops before any change |
| Extra nested client copies | 10.x+, BE skills | missed, left on jibo.com | searched with `find`, merged with the fixed list |
| OTA downloader B | RTM2, 5.4.0 | stopped halfway through the apply | reviewed pin added |
| No backup/restore helpers | 3.x | stopped halfway through the apply | skipped |
| Backup/restore B | 5.4.0 | stopped halfway through the apply | reviewed pins added |
| Setup skill names no region | 3.x, 5.x | stopped before any change | defaults to `api`, and says so |
| Notification socket suffix | 8.x+ | never changed; only the jibo.io services OTA fixed it | rewritten, with a backup |
| `/usr/local` read-write by default | 3.x–5.x | left read-only until reboot | restored to how it was found |
| Any unreviewed patch target | future/unknown | discovered mid-apply | both patchers run in `--dry-run` as a compatibility check before any change |
| Wi-Fi check names the old cloud | 3.x | setup stopped at "Can't connect to Jibo's server" (error 4) before asking for credentials | `patch-ssm-wifi-check.cjs` points it at this server and gives it the CA bundle; firmware that checks google.com is left alone |
| Node 4 reads only the first certificate of a PEM bundle | 3.x | the OTA downloader (and the Wi-Fi check) could not verify this server even with the root installed | both split the bundle into certificates; robots with the earlier downloader patch are upgraded from the saved original |

## Found on the first factory robot (Aero, RTM3 3.3.4, 2026-09-29)

The first setup of a repointed RTM3 robot failed with "Can't connect to Jibo's server", and no
request ever reached the server. On the robot:

- `jibo-ssm` verifies a new Wi-Fi connection in three steps; the third, `_checkJiboServers` in
  `/usr/local/bin/jibo-ssm/lib/skills-service-manager.js`, does
  `https.get({ host: <region> + ".jibo.com", path: '/' })`. The suffix is a literal in that file,
  not in any `region_config.json`, so it kept testing the dead original cloud. It logs
  `ssm-wifi-service: error: ErrorCode { code: 4, description: 'Cannot Ping Jibo Servers' }`, and
  the setup skill maps code 4 to error `wifi4`. 13.0 checks `google.com` instead.
- Node 4.1.2 with the whole CA bundle as `ca` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; the
  same bundle split into certificates, or the single ISRG root file, connects. Node 4 reads only
  the first certificate of a PEM string, and the repoint appends the ISRG root at the end.
- The setup skill (`oobe-config` 4.x) hard-codes region `api` and asks for updates with the filter
  `rtm2Jinx`. The robot's clock, DNS and the repointed client copies were all correct.
- `/var/log` is a RAM disk on this firmware: logs do not survive a reboot. Capture them over SSH
  (`tail -f /var/log/messages`) while reproducing.

## Still unverified

1. **A complete setup on factory firmware.** Aero (RTM3) has been repointed and the two faults
   above fixed by hand on it; a clean run of the updated helper on a freshly flashed robot, through
   QR setup and its OTA, is the next test.
2. **The OTA from a 3.x base.** After QR setup the old setup skill asks for updates. The
   jibo.io catalog must offer packages to `fromVersion` 3.0.x/3.3.x, and updater 1.3.0 must
   accept them. The original cloud did ship direct RTM3 → 8.x and RTM3 → Hashbrown OTAs,
   which suggests the path exists, but it has not been exercised against Phoenix.
3. **The 3.x setup skill against Phoenix's setup API.** `oobe-config` 4.2.2 (RTM2) predates
   the version Phoenix was built against.
4. **Builds not probed individually** (3.0.8, 3.0.10, 6.x, 7.x and point releases). They are
   covered by the hash checks: anything that differs stops at the compatibility check with
   nothing changed. Probe such a build and add its pins if it turns up.

## Re-running the survey

```bash
tools/firmware-compat/fetch-probe.sh /tmp/fw-survey \
  rtm3-3.3.4 /repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2
# or, for images already on disk:
python3 tools/firmware-compat/probe.py <dir with rootfs.ext4 etc.> <label> /tmp/fw-survey
```

Each run writes `probe-<label>.json` and copies the stock files the helper patches into
`files-<label>/`. To accept a new stock file, check that the patch anchors appear exactly once
around the same code, then add its hash and the hash of the patcher's output to the
patcher's `REVIEWED` table, and update the patcher's pin in `scripts/robot-ota-repoint.sh`.
