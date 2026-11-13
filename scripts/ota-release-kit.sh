#!/usr/bin/env bash
# ota-release-kit.sh — the publish-kit step for official OTA rows: integrity gate, sign, verify.
#
#   scripts/ota-release-kit.sh --manifest IN.json --data-dir DIR --out SIGNED.json \
#       --key <release private key> [--key-id phoenix-ota-YYYYMMDD] [--pubkey public.pem] \
#       [--official-base jibo-be-11.0.1.tar.gz] [--ids id1,id2]
#
# --key-id defaults to the pinned current release key (deploy/ota-release-keys) and --pubkey to
# the pinned public half of --key-id; a key id that is not pinned needs an explicit --pubkey.
# Signing under a pinned key id with any other private key is refused before anything is written.
#
# 1. Every selected BE row's (subsystem `@be/be` or `be`) package goes through scripts/be_ota_integrity.py against the
#    hash-pinned official 11.0.1 archive (--official-base is then required). Any failure stops
#    the kit before anything is signed.
# 2. scripts/sign-ota-release.mjs signs the selected rows into a NEW manifest (--out), binding
#    each be row to its gate receipt.
# 3. The new manifest is verified with the public key, as the robot will.
#
# Nothing here publishes: SIGNED.json is an input for the normal reviewed catalog change and
# scripts/deploy-native-release.sh. Keep the private key offline; never copy it to the server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="" DATA_DIR="" OUT="" KEY="" KEY_ID="" PUBKEY="" OFFICIAL_BASE="" IDS=""

die() { printf 'ota-release-kit: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --key-id) KEY_ID="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --official-base) OFFICIAL_BASE="$2"; shift 2 ;;
    --ids) IDS="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
for v in MANIFEST DATA_DIR OUT KEY; do
  [ -n "${!v}" ] || die "--$(echo "$v" | tr 'A-Z_' 'a-z-') is required"
done
[ ! -e "$OUT" ] || die "$OUT already exists"

SIGN=(node "$REPO_ROOT/scripts/sign-ota-release.mjs")

# Pinned defaults: the keys the official robot image trusts.
if [ -z "$KEY_ID" ] || [ -z "$PUBKEY" ]; then
  PINNED="$("${SIGN[@]}" pinned)" || die "cannot load the pinned release keys; nothing was signed"
  pinned_field() { printf '%s' "$PINNED" | node -e '
    const set = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [what, id] = process.argv.slice(1);
    if (what === "current") process.stdout.write(set.current);
    else { const k = set.keys.find((x) => x.keyId === id); if (k) process.stdout.write(k.path); }' "$@"; }
  if [ -z "$KEY_ID" ]; then
    KEY_ID="$(pinned_field current)"
    printf 'ota-release-kit: signing with the pinned current key %s\n' "$KEY_ID" >&2
  fi
  if [ -z "$PUBKEY" ]; then
    PUBKEY="$(pinned_field path "$KEY_ID")"
    [ -n "$PUBKEY" ] || die "--pubkey is required: key id $KEY_ID is not pinned in deploy/ota-release-keys"
  fi
fi

ID_ARGS=()
[ -z "$IDS" ] || ID_ARGS=(--ids "$IDS")

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ota-release-kit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. integrity gate for every be row
RECEIPT_ARGS=()
n=0
while IFS=$'\t' read -r id subsystem version file; do
  case "$subsystem" in be|@be/be) ;; *) continue ;; esac   # production BE rows are "@be/be"
  [ -n "$OFFICIAL_BASE" ] || die "row $id is a be package: --official-base (complete official 11.0.1 archive) is required"
  n=$((n + 1))
  receipt="$WORK/gate-$n.json"
  printf 'ota-release-kit: be_ota_integrity.py %s (%s)\n' "$id" "$version" >&2
  python3 "$REPO_ROOT/scripts/be_ota_integrity.py" --official-base "$OFFICIAL_BASE" \
    --candidate "$DATA_DIR/$file" --version "$version" > "$receipt" \
    || die "integrity gate failed for $id; nothing was signed"
  RECEIPT_ARGS+=(--gate-receipt "$receipt")
done < <("${SIGN[@]}" rows --manifest "$MANIFEST" "${ID_ARGS[@]}")

# 2. sign
"${SIGN[@]}" sign --manifest "$MANIFEST" --data-dir "$DATA_DIR" --out "$OUT" \
  --key "$KEY" --key-id "$KEY_ID" "${ID_ARGS[@]}" "${RECEIPT_ARGS[@]}"

# 3. verify what was written, with the public half only
if ! "${SIGN[@]}" verify --manifest "$OUT" --data-dir "$DATA_DIR" --pubkey "$KEY_ID=$PUBKEY" "${ID_ARGS[@]}"; then
  rm -f "$OUT"
  die "signed manifest did not verify with $PUBKEY; removed $OUT"
fi
printf 'ota-release-kit: signed and verified -> %s\n' "$OUT" >&2
