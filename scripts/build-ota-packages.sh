#!/usr/bin/env bash
# build-ota-packages.sh — turn a Jibo flash buildroot into OTA subsystem packages that
# packages/ota can serve, so a robot OTAs the firmware *in place* (A/B rootfs swap, /var
# calibration preserved) instead of a wiping re-flash.
#
# Reproduces the reference packaging (jibo-ota-updater src/package-update.js):
#   <subsystem>-<version>.tar  =  uncompressed tar containing ./filesystem.tar.bz2
#   filesystem.tar.bz2         =  bzip2 tar of the partition's filesystem contents
# The robot's apply_os.js writes that to the inactive rootfs slot and flips activeroot — it
# never touches /var, which is why this path keeps calibration.
#
# Usage:
#   scripts/build-ota-packages.sh [--buildroot <path|url>] [--version 12.10.0]
#                                 [--out packages/ota/data]
#                                 [--os-image FILE] [--services-image FILE]
#
# Default buildroot is the 13.0.0 "Last Dance" production flash build — the final Jibo firmware.
# For the earlier 12.10.0 build instead:
#   --buildroot https://pvindex.org/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-12.10.0-20180823-production.tar.bz2 --version 12.10.0
# Needs: tar+bzip2, and EITHER root (loop mount) OR debugfs (e2fsprogs) to read the ext4 images.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDROOT_URL_DEFAULT="http://data.jibo/repository/platformos/builds/sqa-testing/jibo-pvt-flash-build-13.0.0-lastdance-rc2-20190225-prod.tar.bz2"

BUILDROOT="$BUILDROOT_URL_DEFAULT"
VERSION="13.0.0"
OUT="$REPO_ROOT/packages/ota/data"
OS_IMAGE=""
SERVICES_IMAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --buildroot) BUILDROOT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --os-image) OS_IMAGE="$2"; shift 2 ;;
    --services-image) SERVICES_IMAGE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m[ota-build]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[ota-build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v bzip2 >/dev/null || die "bzip2 not found (needed for filesystem.tar.bz2)"
AS_ROOT=0; [ "$(id -u)" = "0" ] && AS_ROOT=1
HAVE_DEBUGFS=0; command -v debugfs >/dev/null && HAVE_DEBUGFS=1
if [ "$AS_ROOT" = 0 ] && [ "$HAVE_DEBUGFS" = 0 ]; then
  die "need root (for 'mount -o loop') or debugfs (apt-get install e2fsprogs) to read ext4 images"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ota-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# 1. obtain + extract the buildroot --------------------------------------------------
SRC="$BUILDROOT"
if printf '%s' "$BUILDROOT" | grep -qiE '^https?://'; then
  log "downloading buildroot: $BUILDROOT"
  SRC="$WORK/buildroot.tar.bz2"
  if command -v curl >/dev/null; then curl -fSL "$BUILDROOT" -o "$SRC"
  elif command -v wget >/dev/null; then wget -O "$SRC" "$BUILDROOT"
  else die "need curl or wget to fetch a URL buildroot"; fi
fi
[ -f "$SRC" ] || die "buildroot not found: $SRC"

EXTRACT="$WORK/extract"; mkdir -p "$EXTRACT"
log "extracting buildroot…"
tar -C "$EXTRACT" -xjf "$SRC"

# 2. locate the os (rootfs) + services ext4 images -----------------------------------
find_image() {  # $1 = regex of candidate basenames
  find "$EXTRACT" -type f -name '*.ext4' 2>/dev/null | grep -iE "$1" | head -n1
}
[ -n "$OS_IMAGE" ]       || OS_IMAGE="$(find_image '/(rootfs|system|os)[^/]*\.ext4$' || true)"
[ -n "$SERVICES_IMAGE" ] || SERVICES_IMAGE="$(find_image '/(services|usr[-_]?local)[^/]*\.ext4$' || true)"

if [ -z "$OS_IMAGE" ] || [ -z "$SERVICES_IMAGE" ]; then
  log "could not auto-locate both images. *.ext4 found in the buildroot:"
  find "$EXTRACT" -type f -name '*.ext4' -printf '    %p\n' >&2 || true
  die "pass --os-image / --services-image explicitly"
fi
log "os image:       $OS_IMAGE"
log "services image: $SERVICES_IMAGE"

# 3. pack one ext4 image into <subsystem>-<version>.tar ------------------------------
pack() {  # $1 subsystem  $2 image
  local subsystem="$1" image="$2"
  local pkg="$WORK/$subsystem.pkg"; rm -rf "$pkg"; mkdir -p "$pkg"
  log "packing $subsystem from $(basename "$image")…"
  if [ "$AS_ROOT" = 1 ]; then
    local mnt="$WORK/$subsystem.mnt"; mkdir -p "$mnt"
    mount -o loop,ro "$image" "$mnt"
    tar -C "$mnt" -cjf "$pkg/filesystem.tar.bz2" .
    umount "$mnt"; rmdir "$mnt"
  else
    # no-root path: dump the image's tree with debugfs, then tar it
    local dump="$WORK/$subsystem.root"; rm -rf "$dump"; mkdir -p "$dump"
    debugfs -R "rdump / $dump" "$image" >/dev/null 2>&1 || die "debugfs rdump failed on $image"
    tar -C "$dump" -cjf "$pkg/filesystem.tar.bz2" .
    rm -rf "$dump"
  fi
  local out="$OUT/$subsystem-$VERSION.tar"
  tar -C "$pkg" -cf "$out" .
  rm -rf "$pkg"
  local size sha
  size="$(stat -c%s "$out" 2>/dev/null || wc -c <"$out")"
  sha="$( (sha1sum "$out" 2>/dev/null || shasum -a1 "$out") | awk '{print $1}')"
  log "built $out  (length=$size  sha1=$sha)"
}

pack os "$OS_IMAGE"
pack services "$SERVICES_IMAGE"

log "done. Packages in $OUT — the OTA server computes length+sha1 from these at startup."
log "manifest.json already references os-$VERSION.tar / services-$VERSION.tar."
