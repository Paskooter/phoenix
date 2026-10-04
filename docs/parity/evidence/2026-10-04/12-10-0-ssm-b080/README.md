# Exact 12.10.0 SSM variant check, 2026-10-04

The supplied `~/skills-service-manager.js` has SHA-256
`b0809e59adb0e9b857f46de3eab6726501038cf02d6eff1731a832335e5ae32d`
and contains 740,855 bytes. The reported robot is
`Release-12.10.0-20180823`, with Node `v6.9.2`.

Comparison with the hash-pinned, fully downloaded production archive shows
exactly three hostname edits from the archived 740,886-byte SSM bundle
(`da785e908a79e1953547b79c7943f94d033a3b68bf988be1ae3841e6cdbdcd53`):
both Wi-Fi credential branches now assign the literal `api.openjibo.com`, and
the separate diagnostic ping list's API entry names that host as well.
The Wi-Fi HTTPS root request otherwise retains the stock shape.

## Finding

The old patcher from commit `c1027be` reproduces the exact reported error:
`patch-ssm-wifi-check: server url anchor 1 was not found exactly once`.
It requires the original region-plus-suffix expressions, which these literal
hostname assignments replaced.

The current structural patcher passes on the **full supplied bundle**. The
live public patcher and repoint script match this checkout and its pinned
hashes. A fresh public repoint download already supports this layout; no
production code or server deployment was needed.

Eight direct cases pass: checkout/public patchers × actual Node 4.1.2/6.9.2 ×
`api`/`stg-entrypoint`. Each case verifies:

- A successful read-only preflight without creating a backup.
- Successful apply with both Wi-Fi branches using the selected jibo.io host.
- Split public CA certificates without disabling certificate verification.
- Full patched-bundle syntax under Node 6.9.2.
- Byte-exact backup, preserved executable mode/ownership, and repeat without
  changing the output or backup.
- Preservation of the separate diagnostic ping entry outside the Wi-Fi class.

The complete shell script also passes unpaired and synthetically paired
dry-runs, followed by two unpaired applies in the offline archive-backed
harness. That fixture combines the supplied SSM with the other inspected
production 12.10.0 files; it is not a capture of the owner's entire robot.
SSH/login, mount operations, robot mode and free space are fixtures. It verifies
preserved keys, restored mount modes and exact CA contents. No robot, adoption,
live OTA, mount operation on the host or reboot is involved.

The repoint regression suite passes **52 tests, zero skipped**, with both legacy
Node runtimes. The synthetic regression now includes literal OpenJibo hosts in
both credential branches and a same-host diagnostic entry outside the Wi-Fi
class. The complete vendor bundle is kept outside Phoenix.

## Evidence and rerun

[results.json](results.json) records input/reference hashes, the legacy error,
public asset hashes, all eight direct cases and compact shell-harness results.
Local input copies and full logs remain under
`/tmp/phoenix-ssm-b080-20261004`; the supplied original was not modified.

To repeat the Wi-Fi check on a **copy** of the supplied file, use the verified
Node 6.9.2 runtime:

```bash
cp ~/skills-service-manager.js /tmp/ssm-b080-recheck.js
chmod 755 /tmp/ssm-b080-recheck.js
node6=/absolute/path/node-v6.9.2-linux-x64/bin/node
patcher=scripts/robot-client/patch-ssm-wifi-check.cjs
"$node6" "$patcher" --target /tmp/ssm-b080-recheck.js --region api --dry-run
"$node6" "$patcher" --target /tmp/ssm-b080-recheck.js --region api
"$node6" "$patcher" --target /tmp/ssm-b080-recheck.js --region api
```

Expected outputs are `patched`, `patched`, then `already-patched`.
For the robot, download a fresh complete script and rerun it with the normal
robot arguments; the script obtains and verifies its pinned helper assets:

```bash
curl -fL https://jibo.io/robot-ota-repoint.sh -o robot-ota-repoint-current.sh
```

These file checks close the missing-source regression/provenance follow-up.
They do not add a new hardware OTA claim; existing owner certification remains
documented separately.
