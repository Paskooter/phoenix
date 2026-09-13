#!/usr/bin/env bash
# S-14 evidence runner: pinned-original oracle (node 8.9.4, 3 fresh processes) + Phoenix
# contract harness + structural diff.
#
#   bash scripts/parity-s14/run.sh [outdir]     # default: docs/parity/evidence/2026-09-11/s14-example-template/source
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAIN="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)/.." && pwd)"
OUT="${1:-$ROOT/docs/parity/evidence/2026-09-11/s14-example-template/source}"
REF="$MAIN/.parity/reference/5c0a7390539663ba749d360de348a428c088505c"
mkdir -p "$OUT"
[ -d "$REF" ] || { echo "missing pinned reference tree: $REF" >&2; exit 2; }

for mode in example template host; do
  timeout 180 docker run --rm --network none -u "$(id -u):$(id -g)" -e NODE_PATH=/runtime/node_modules \
    -v "$ROOT/scripts/parity-s14:/probe" \
    -v "$REF:/runtime:ro" -w /runtime \
    node:8.9.4-slim node /probe/source-oracle.cjs "/probe/source-$mode.json" "$mode" \
    >"/dev/null" 2>&1
  mv "$ROOT/scripts/parity-s14/source-$mode.json" "$OUT/source-$mode.json"
  echo "oracle[$mode] -> $OUT/source-$mode.json"
done

node "$ROOT/scripts/parity-s14/phoenix-contract.mjs" "$OUT/phoenix.json" 2>/dev/null
echo "phoenix -> $OUT/phoenix.json"

python3 "$ROOT/scripts/parity-s14/compare.py" "$OUT/source-example.json" "$OUT/source-template.json" "$OUT/source-host.json" "$OUT/phoenix.json" | tee "$OUT/compare.txt"
