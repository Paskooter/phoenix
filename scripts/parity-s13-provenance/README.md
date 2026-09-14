# S-13 same-session provenance collector

`collect.mjs` records the native runtime inputs needed to review an S-13
physical capture. It opens one SSH session as `root`, runs a read-only Node
probe on the robot, and writes a private JSON receipt. The probe records the
UTC and local clock readings plus their timezone source, the active Electron
process and CDP page for the selected skill slot, BE/package/client/Nimbus/SSM
hashes, bounded sorted manifests, the observed firmware release, and hashed
robot identity. Raw SSH stdout and stderr and every remote command/file read
are represented by SHA-256 records; command output itself is never copied into
the receipt.

The slot is a directory name under `/opt/jibo/Jibo/Skills`; the remote SSM
package is `/usr/local/bin/jibo-ssm` and must report version `16.0.0`. The
collector rejects missing or ambiguous processes, pages, package files,
manifests, timezone sources, and firmware releases. It does not stop, start,
deploy, remount, or modify a robot.

```sh
npm run parity:s13:provenance -- \
  --host 192.0.2.10 \
  --slot phoenix-be-11-0-1-parity \
  --out /private/s13/before.json
```

The output is published through a temporary file, `fsync`, and rename, with
mode `0600`. A later capture can enforce that the immutable package and asset
hashes still match a baseline:

```sh
npm run parity:s13:provenance -- \
  --host 192.0.2.10 \
  --slot phoenix-be-11-0-1-parity \
  --before /private/s13/before.json \
  --out /private/s13/after.json
```

Two existing receipts can be compared without contacting a robot. A mismatch
returns exit status 1 and is written as a mode-0600 comparison receipt:

```sh
npm run parity:s13:provenance -- \
  --before /private/s13/before.json \
  --after /private/s13/after.json \
  --out /private/s13/comparison.json
```

Focused fixture tests use a temporary fake `ssh` executable and make no
network calls:

```sh
node --test scripts/parity-s13-provenance/collect.test.mjs
```

The receipt schema is `phoenix-s13-provenance-v1`. Its immutable comparison
set is `immutable.files` plus `immutable.sha256`, derived from the BE package,
BE index and bounded source/package manifest, Jetstream package/main, Nimbus
package/index/runtime assets, and SSM package/main/skill-main. The `raw` block
contains SHA-256 records for the complete SSH stdout/stderr streams and each
remote command/file read; it does not contain command output or credential
contents. Identity is retained as hashes only.

For a live probe, the host must permit non-interactive root SSH and provide
the selected slot under `/opt/jibo/Jibo/Skills`, a Node runtime capable of
running the Node-6-compatible remote probe, `id`, `date`, `ps`, and `curl`,
plus the Electron CDP page endpoint at `127.0.0.1:9222`. The collector also
requires `/usr/local/bin/jibo-ssm/package.json` to report `16.0.0`, exactly one
Electron process/page for the slot, a readable timezone source, and exactly
one unambiguous firmware release source. It makes no live network call in
the fixture tests.
