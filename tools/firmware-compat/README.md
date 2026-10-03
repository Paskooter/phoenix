# Archive-backed repoint verification

`stock-audit.py` downloads each archived production-designated flash build in
sequence. It hashes the complete compressed HTTP response, checks published
SHA-256 values when available, hashes each ext4 partition, and inspects it with
`debugfs`. It removes each partition and its extracted module trees before
reading the next partition. Keep the scratch directory **outside Phoenix**;
retained objects are original vendor files and must not be committed.

`verify-stock.cjs` runs the actual helper CLIs with filesystem paths redirected
to reconstructed archive files. It checks dry-run, apply and repeat behavior,
file modes, runtime syntax, native manager configuration/routes and required
tools. Before extracted dependencies are removed, it loads the replacement
HTTP client against each original module tree and checks its CA and OTA endpoint
configuration. Scoped OTA clients and legacy unscoped dependencies are recorded
separately.

`shell-audit.py` runs the entire repoint shell script through a local SSH adapter.
Its paired and unpaired dry-runs must leave all staged files unchanged.
`--apply-oobe` additionally applies the unpaired path twice and checks CA contents,
the default CA link, preserved synthetic keys and restored mount modes. SSH
authentication, mount operations, robot mode and free space are fixtures. It
blocks remote curl/wget and reboot commands; it never contacts or claims a robot.
This does not verify physical partition resizing or a hardware OTA.

## Reproduce

Use Python 3.9+, `debugfs`, Bash and ordinary Linux utilities. Provide official
Linux x64 Node **4.1.2** and **6.9.2** binaries with their downloads checked against
Node's official `SHASUMS256.txt`. These emulate the archived Node runtimes; ARM
robot executables are never run. The early SSM bundle itself uses Electron and
contains pre-existing syntax absent from plain Node 4; its complete patched
bundle is syntax-checked with Node 6, while its patcher runs with Node 4.

From the repository root:

```bash
audit_dir=/tmp/phoenix-stock-firmware-audit
node4=/absolute/path/node-v4.1.2-linux-x64/bin/node
node6=/absolute/path/node-v6.9.2-linux-x64/bin/node

python3 tools/firmware-compat/stock-audit.py \
  --inventory "$audit_dir/inventory.json" --refresh-inventory

python3 tools/firmware-compat/stock-audit.py \
  --inventory "$audit_dir/inventory.json" \
  --output "$audit_dir/reports" --scratch "$audit_dir/scratch" \
  --node4 "$node4" --node6 "$node6"

python3 tools/firmware-compat/shell-audit.py \
  --reports "$audit_dir/reports" --objects "$audit_dir/scratch/objects" \
  --output "$audit_dir/shell-reports" \
  --node4 "$node4" --node6 "$node6" --apply-oobe

PHOENIX_TEST_NODE4="$node4" PHOENIX_TEST_NODE6="$node6" \
  npm run test:robot-repoint
python3 -m unittest discover -s tools/firmware-compat -p 'test_*.py'
```

Allow at least 3 GiB of free scratch space; the tool stops if the next partition
plus its reserve would not fit. The complete audit transfers roughly 29 GB, but
does not retain the compressed archives. Optional `--decompressor /path/to/lbzip2`
uses two lower-priority decompression workers without concurrent downloads.

Use repeatable `--label LABEL` to select individual images. A completed download
is skipped on resume; `--force-download` fetches it again. `--recheck` reruns
file checks using retained objects, but cannot repeat module-load checks once
the original dependency trees have been deleted. A failed checksum or earlier
module-load check cannot become a pass merely through a successful file recheck.
Shell reports skip successful runs; remove the relevant shell report to repeat
them after changing the harness or repoint script.

The inventory includes everything in the two production build directories and
production/prod-named archives elsewhere under `platformos/builds`. Early beta
files within `ota-production-release` remain in this conservative superset.
The EFT owner baseline and the only available 3.0.10/3.3.3 development builds are
explicitly supplemental. Directory coverage does not prove that every firmware
ever distributed by the original cloud is archived.

The completed 2026-10-03 audit is recorded in
[the evidence report](../../docs/parity/evidence/2026-10-03/stock-firmware-repoint-audit/README.md).
