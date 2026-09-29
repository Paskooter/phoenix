#!/usr/bin/env bash
# Stream archived Jibo flash builds, probe their images, and discard them.
#
#   tools/firmware-compat/fetch-probe.sh <out-dir> <label> <archive-path> [<label> <archive-path> ...]
#
# <archive-path> is a path on the Jibo archive, for example
#   /repository/platformos/builds/release-production/jibo-pvt-flash-build-RTM3-3.3.4-20170623.tar.bz2
# Only the ext4 images are extracted (about 2.3 GB per build); each is deleted
# once probed. Needs curl, bzip2-capable tar, python3, debugfs and openssl.
set -euo pipefail
ARCHIVE="${JIBO_ARCHIVE_URL:-https://pvindex.org}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ $# -ge 3 ] || { sed -n '2,10p' "$0"; exit 2; }
OUT="$1"; shift
mkdir -p "$OUT"
while [ $# -ge 2 ]; do
  label="$1" path="$2"; shift 2
  work="$(mktemp -d "${TMPDIR:-/tmp}/jibo-fw-${label}.XXXXXX")"
  echo "[$(date +%T)] ${label}: fetching ${path}"
  curl -sSf "${ARCHIVE}${path}" | tar -xjf - -C "$work" --wildcards '*images/*'
  rootfs="$(find "$work" -name rootfs.ext4 | head -1)"
  if [ -n "$rootfs" ]; then
    python3 "$HERE/probe.py" "$(dirname "$rootfs")" "$label" "$OUT"
  else
    echo "${label}: no rootfs.ext4 in this build" >&2
  fi
  rm -rf "$work"
done
