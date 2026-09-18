#!/usr/bin/env bash
# R-03 full-stack restart/isolation harness. All measurements live in a temp run directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node run.mjs "$@"
