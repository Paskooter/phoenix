#!/usr/bin/env bash
# R-02 install verification harness. Thin bash dispatcher so the runner is invoked exactly
# like the sibling parity lanes (./run.sh setup …). All logic lives in run.mjs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node run.mjs "$@"