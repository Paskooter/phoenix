# Production firmware repoint audit, 2026-10-03

Every production-designated flash archive found in the public archive was
downloaded completely and checked individually: **36 archives**, plus the EFT
owner baseline and two explicitly supplemental development variants. All file,
client and offline shell checks passed. No change to the production repoint
script or its helpers was necessary.

The 39 unique archives contain **29,078,101,022 compressed bytes** and **238
client module copies**. Every image received two complete shell dry-runs and
two isolated unpaired applies. Downloads were sequential, with only one
partition image retained for inspection at a time.

Work was isolated in `codex/stock-firmware-repoint-audit-20261003`, based on commit
`bf2733f`. No robot was contacted, claimed, updated or rebooted, and no server was
deployed. Firmware partitions and original dependency trees were deleted as
each inspection finished. Retained vendor inputs remain outside Phoenix;
this evidence directory contains only metadata, hashes and test results.

## Coverage and results

The inventory walks every directory under
[the platform build archive](https://pvindex.org/repository/platformos/builds/).
It includes all six files in `release-production`, all eight in
`ota-production-release`, and all 22 production/prod-named flash archives in
`sqa-testing`. Five early beta archives reside in `ota-production-release`;
they are deliberately included in this production-designated superset, without
asserting that those beta images shipped on production robots.

`stable-builds/5.4.0-EFT` is the documented owner USB baseline. Production images
for 3.0.10 and 3.3.3 were not listed; their `release-dev` images were checked as
development variants. The version label alone does not make those production
images. The inventory saves directory link lists and listing hashes, including
directories with no qualifying firmware.

For **each** archive, the audit:

- Streams the entire compressed HTTP response and records its size and SHA-256.
  All 33 available published checksums match. Six archives have no matching
  published checksum; their independently computed hashes are recorded, with
  `published_checksum_verified: false`. Those six are 8.13.0, 8.16.0, 8.19.0,
  12.7.0, 12.10.0 and 13.0.0. The 5.4.0 production checksum is published under its
  historical `EFT-production` filename; that alias is recorded explicitly.
- Reads and hashes rootfs, services, skills and var ext4 images without mounting
  them, records the paths/hashes/modes of relevant original files, and checks
  required shell tools, the runtime, native OTA route and manager configuration.
- Runs the exact config and patch helper CLIs with **real Node 4.1.2 or 6.9.2**,
  matching the archived rootfs runtime. Preflight must preserve source bytes;
  apply must succeed; repeating must preserve the resulting primary files.
  Downloader and backup/restore outputs are syntax-checked. The Wi-Fi patcher
  runs with the rootfs Node, and its full SSM bundle is parsed with Node 6 because
  early SSM uses Electron and already contains syntax absent from plain Node 4.
- Replaces each archived client handler in its original extracted dependency
  tree, loads that actual module, and verifies the exact public CA and
  `rejectUnauthorized: true`. Scoped OTA clients must expose `Update`, select
  HTTPS on `api.jibo.io`/`stg-entrypoint.jibo.io`, and expose `getUpdateFrom`.
  Legacy unscoped dependencies are tested for their available client interface;
  they do not expose the scoped OTA API.
- Runs the complete shell script through an isolated local SSH adapter for
  both an unpaired and a synthetically paired **dry-run**. All staged file bytes
  and modes must remain unchanged.
- Applies the complete **unpaired** shell path twice with `--auto --yes
  --no-reboot`. Both runs must finish the script's verification, preserve
  synthetic key material and private-directory mode, restore the initial mount
  modes, preserve the original CA bundle while adding ISRG Root X1 exactly once,
  and create the correct `/etc/ssl/cert.pem` link.

The archived client handlers all match the existing reviewed 2.x/3.x hashes;
the actual nested dependency copies are included. The three different stock CA
bundle hashes all contain 180 certificates; each original bundle is used in the
full apply checks. Each native manager binary exposes its OTA route and query
helper, and each manager configuration names `os`, `services`, `oobe-config` and
`@be/be`. Stock flash skill trees are recorded separately; a configured skill
need not already be installed.

In the archived
[native manager source](https://pvindex.org/gitea/PlatformTeam/system-manager/raw/commit/3f1b11ebba5f2ab334145235d5837afaefbed54f/src/UpdateManager.cpp),
update discovery iterates configured subsystems and queries missing skills with
version `0.0.0`. Together with the inspected configurations, that supports the
OTA query path for an absent BE skill. The native ARM manager was not executed,
and this source review does not prove that every compiled binary behaves
identically or that a BE installation succeeds on hardware.

The public repoint script and all nine downloaded helper assets matched the
checkout and its pins. Real Node 4 and 6 HTTPS requests to both API front doors
validated the public certificate chain with ISRG Root X1 and certificate
verification enabled; an HTTP 404 confirms TLS reached the endpoint, without
exercising authenticated APIs. The existing repoint suite passed **52 tests,
zero skipped**, with both legacy runtimes. The new audit's **six safety tests**
also passed, including checksum, truncated-response, missing/duplicate-image,
low-space and verifier-failure cases.

## Per-image matrix

“Files/client” covers the original-files and dependency-load checks.
“Shell” covers both dry-runs and the two unpaired applies. Every PASS is an
offline result; it does not mean hardware OTA completion.

| Archived build | Scope | Node | Client copies (package versions) | Files/client | Shell |
|---|---|---|---|---|---|
| [RTM2-3.0.8-20170220](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM2-3.0.8-20170220.tar.bz2) | Production-designated | 4.1.2 | 3 (2.10.31) | PASS | PASS |
| [RTM2-3.0.9-20170303](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM2-3.0.9-20170303.tar.bz2) | Production-designated | 4.1.2 | 3 (2.10.31) | PASS | PASS |
| [rtm2-dev-3.0.10](https://pvindex.org/repository/platformos/builds/release-dev/jibo-pvt-flash-rtm2-dev-3.0.10.tar.bz2) | Development variant | 4.1.2 | 3 (2.10.31) | PASS | PASS |
| [3.3.3-rtm3-dev](https://pvindex.org/repository/platformos/builds/release-dev/jibo-pvt-flash-build-3.3.3-rtm3-dev.tar.bz2) | Development variant | 4.1.2 | 3 (2.10.31) | PASS | PASS |
| [RTM3-3.3.4-20170623](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2) | Production-designated | 4.1.2 | 3 (2.10.31) | PASS | PASS |
| [5.0.1-production](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-build-5.0.1-production.tar.bz2) | Production-designated | 6.9.2 | 3 (2.12.17) | PASS | PASS |
| [5.4.0-EFT](https://pvindex.org/repository/platformos/builds/stable-builds/jibo-pvt-flash-build-5.4.0-EFT.tar.bz2) | EFT baseline | 6.9.2 | 3 (3.0.24, 3.0.26) | PASS | PASS |
| [5.4.0-production](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-build-5.4.0-production.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.24, 3.0.30) | PASS | PASS |
| [5.4.2-production](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-build-5.4.2-production.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.24, 3.0.26) | PASS | PASS |
| [8.1.0-20170531-BETA-3](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-8.1.0-20170531-BETA-3.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.35, 3.0.37) | PASS | PASS |
| [8.1.1-20170531-BETA-3](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-8.1.1-20170531-BETA-3.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.35, 3.0.37) | PASS | PASS |
| [8.1.2-20170601-BETA-3](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-8.1.2-20170601-BETA-3.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.35, 3.0.37) | PASS | PASS |
| [8.1.3-20170601-BETA-3](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-8.1.3-20170601-BETA-3.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.35, 3.0.37) | PASS | PASS |
| [8.2.0-20170620-BETA-3.1](https://pvindex.org/repository/platformos/builds/ota-production-release/jibo-pvt-flash-8.2.0-20170620-BETA-3.1.tar.bz2) | Production-designated | 6.9.2 | 3 (3.0.35, 3.0.37) | PASS | PASS |
| [8.13.0-20170913](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-8.13.0-20170913.tar.bz2) | Production-designated | 6.9.2 | 9 (3.0.41, 3.0.45, 3.0.56) | PASS | PASS |
| [8.16.0-20171004](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-8.16.0-20171004.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.56) | PASS | PASS |
| [8.19.0-20171018](https://pvindex.org/repository/platformos/builds/release-production/jibo-pvt-flash-build-8.19.0-20171018.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.56) | PASS | PASS |
| [9.5.0-20171024-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.5.0-20171024-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.56) | PASS | PASS |
| [9.8.0-20171127-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.8.0-20171127-production.tar.bz2) | Production-designated | 6.9.2 | 6 (3.0.41, 3.0.45, 3.0.56, 3.0.71, 3.0.76) | PASS | PASS |
| [9.8.4-20171129-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.8.4-20171129-production.tar.bz2) | Production-designated | 6.9.2 | 6 (3.0.41, 3.0.45, 3.0.56, 3.0.71, 3.0.76) | PASS | PASS |
| [9.8.6-20171212-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.8.6-20171212-production.tar.bz2) | Production-designated | 6.9.2 | 6 (3.0.41, 3.0.45, 3.0.56, 3.0.71, 3.0.76) | PASS | PASS |
| [9.8.8-20171217-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.8.8-20171217-production.tar.bz2) | Production-designated | 6.9.2 | 6 (3.0.41, 3.0.45, 3.0.56, 3.0.71, 3.0.76) | PASS | PASS |
| [9.12.0-20180103-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-9.12.0-20180103-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.1.0-20171228-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.1.0-20171228-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.2.0-201801010-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.2.0-201801010-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.3.0-20180116-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.3.0-20180116-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.4.0-20180122-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.4.0-20180122-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.5.7-20180208-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.5.7-20180208-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.105, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.5.8-20180216-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.5.8-20180216-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.106, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [10.5.9-20180218-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-10.5.9-20180218-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.106, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [11.1.0-20180222-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-11.1.0-20180222-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.107, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [11.1.1-20180227-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-11.1.1-20180227-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.109, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [11.7.0-20180312-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-11.7.0-20180312-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.110, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [11.7.1-20180314-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-11.7.1-20180314-production.tar.bz2) | Production-designated | 6.9.2 | 14 (3.0.110, 3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [12.0.6-20180330-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.0.6-20180330-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [12.0.8-20180403-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.0.8-20180403-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.41, 3.0.45, 3.0.76, 3.0.79) | PASS | PASS |
| [12.7.0-20180517-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.7.0-20180517-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.105, 3.0.117, 3.0.41, 3.0.45) | PASS | PASS |
| [12.10.0-20180823-production](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.10.0-20180823-production.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.105, 3.0.117, 3.0.41, 3.0.45) | PASS | PASS |
| [13.0.0-lastdance-rc2-20190225-prod](https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-13.0.0-lastdance-rc2-20190225-prod.tar.bz2) | Production-designated | 6.9.2 | 5 (3.0.105, 3.0.117, 3.0.41, 3.0.45) | PASS | PASS |

## What remains unverified

This covers every qualifying archive available in the captured directory
inventory. It cannot certify every image ever shipped: production 3.0.10 and
3.3.3 were unavailable, no 6.x/7.x production flash archives were listed, and
other releases may exist only as historical OTAs. For example, 12.9.0 is listed
only as a development flash archive, and no 13.0.7 flash archive is listed.
The separately reported 12.10.0 SSM hash is a different input from the inspected
20180823 production image and remains unverified.

The shell harness uses fixtures for SSH/login, mount operations, robot mode and
free `/opt` space. It runs host Linux tools and the exact legacy Node versions
against archived files; it does not run ARM executables. Paired adoption and
OTA triggering have regression coverage, but the per-image complete apply here
uses the unpaired path. Physical partition expansion, factory QR setup, live
native OTA planning/application, service startup and reboot still need hardware
tests. This audit does not close those gaps in the compatibility document.

## Evidence and reproduction

- [inventory.json](inventory.json): archive URLs, expected checksums and captured
  directory listings.
- [results.json](results.json): source and tool hashes, runtime provenance,
  complete archive/partition/file hashes, original client versions and paths,
  parsed checks, explicit shell fixtures, timings, TLS checks and test counts.
- [public-assets.json](public-assets.json): observed hashes of the live public
  script and each pinned helper.
- [Audit tools and commands](../../../../../tools/firmware-compat/README.md):
  sequential downloads, individual selection, resume and recheck instructions.

Full local transcripts and retained original objects are under
`/tmp/phoenix-stock-firmware-audit`, outside the repository. Large archive and
partition files were not retained. `--recheck` repeats file checks from the
retained objects; repeating original dependency-load checks requires another
download. Evidence must be refreshed if the repoint script or its pinned
assets change.
