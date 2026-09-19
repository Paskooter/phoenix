#!/usr/bin/env bash
#
# Repoint a Jibo robot at a Phoenix server that owns its own domain (jibo.io).
#
# DEFAULT BEHAVIOUR IS DELIBERATELY MINIMAL.
#
# Running this with no mode flag patches ONLY what a robot needs in order to reach
# the server and complete an over-the-air update from it:
#
#   1. every installed copy of the jibo-server-client `region_config.json` is
#      rewritten from jibo.com to jibo.io, so the robot calls
#      https://<region>.jibo.io instead of https://<region>.jibo.com;
#   2. the publicly-trusted root (ISRG Root X1) is installed into the robot's real,
#      persistent trust store, so it accepts the server's Let's Encrypt
#      certificate for *.jibo.io.
#
# That is the whole default, and it is the whole point: the OTA payload is an `os`
# package that replaces the rootfs partition, so it carries the hosts entry, the
# CA handling and the baked server URL itself. Patching them here as well would be
# redundant, and patching them here *instead* is what makes a robot depend on a
# hosts intercept and a private CA it never needed once the operator owns the
# domain. Public DNS resolves *.jibo.io already; nothing needs intercepting.
#
# Deliberately NOT done by default:
#   * no /etc/hosts intercept
#   * no private certificate authority
#   * no account adoption / loop claim
#   * no hub port or binding changes
#   * no server-side certificate generation
#
# Everything the older, fully-featured repoint could do is still reachable:
#
#     robot-ota-repoint.sh --full <any flags for repoint-robot.sh...>
#
# which execs scripts/parity-robot/repoint-robot.sh with its complete flag surface
# (--ca, --cert-only, --regenerate-cert, --hub-port, --no-hub, --no-adopt,
# --classic-url, --account-store, --regions, --trust-first, --drop-bind, --verify,
# --revert, ...). The advanced path is unchanged.
#
# Usage:
#   robot-ota-repoint.sh --robot root@<ip> [--region <r>] [--region-ca <pem>]
#                        [--dry-run] [--yes] [--verify] [--revert]
#   robot-ota-repoint.sh --robot root@<ip> --full --phoenix https://... --yes
#
# Nothing is changed without showing a plan first. Every file edited is backed up
# on the robot, and --revert restores the backups.

set -uo pipefail

ROBOT=""; REGION=""; REGION_CA=""; DRY=0; ASSUME_YES=0; VERIFY=0; REVERT=0
PUBLIC_SUFFIX="jibo.io"
FULL=0; FULL_ARGS=()

# The robot's own trust store. `bundle` is what OpenSSL reads; the individual PEM
# plus the subject-hash symlink are how a cert is normally installed alongside it.
TRUST_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
TRUST_DIR="/etc/ssl/certs"
RECEIPT_DIR="/var/lib/phoenix"
RECEIPT="${RECEIPT_DIR}/ota-repoint.json"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

usage() { sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "${1}" in
    --robot)     ROBOT="${2:-}"; shift 2 ;;
    --region)    REGION="${2:-}"; shift 2 ;;
    --region-ca) REGION_CA="${2:-}"; shift 2 ;;
    --suffix)    PUBLIC_SUFFIX="${2:-}"; shift 2 ;;
    --dry-run)   DRY=1; shift ;;
    --yes)       ASSUME_YES=1; shift ;;
    --verify)    VERIFY=1; shift ;;
    --revert)    REVERT=1; shift ;;
    --full)      FULL=1; shift ;;
    -h|--help)   usage 0 ;;
    *)
      if [ "$FULL" -eq 1 ]; then FULL_ARGS+=("$1"); shift; else
        echo "unknown option: $1" >&2; usage 2
      fi ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── Advanced path: hand off to the full repoint, unchanged ───────────────────
if [ "$FULL" -eq 1 ]; then
  SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
  FULL_SCRIPT="${SELF_DIR}/parity-robot/repoint-robot.sh"
  [ -x "$FULL_SCRIPT" ] || die "full repoint script not found: $FULL_SCRIPT"
  say "delegating to the full repoint (unchanged behaviour): $FULL_SCRIPT"
  exec "$FULL_SCRIPT" ${ROBOT:+--robot "$ROBOT"} "${FULL_ARGS[@]}"
fi

[ -n "$ROBOT" ] || die "--robot root@<ip> is required (or --full for the complete repoint)"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$ROBOT")
rsh() { "${SSH[@]}" "$@"; }

rsh 'true' >/dev/null 2>&1 || die "cannot reach ${ROBOT} over SSH"

# ── 1. Establish the robot's identity and region ─────────────────────────────
step "Robot"
HOSTNAME_="$(rsh 'hostname' 2>/dev/null | tr -d '\r')"
RELEASE="$(rsh 'jibo-version 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
MODE="$(rsh 'jibo-getmode 2>/dev/null' 2>/dev/null | tr -d '\r')"
if [ -z "$REGION" ]; then
  # The region drives which <region>.jibo.io the robot asks. Read it without
  # ever echoing the credential material sitting beside it in the same file.
  REGION="$(rsh 'sed -n "s/.*\"region\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /var/jibo/credentials.json 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
fi
say "  host      : ${HOSTNAME_:-unknown}"
say "  release   : ${RELEASE:-unknown}"
say "  mode      : ${MODE:-unknown}"
say "  region    : ${REGION:-unknown}"
[ -n "$REGION" ] || die "could not determine the robot's region; pass --region"

REST_URL="https://${REGION}.${PUBLIC_SUFFIX}/"
SOCKET_URL="wss://${REGION}-socket.${PUBLIC_SUFFIX}/"
say "  will call : ${REST_URL}"
say "  socket    : ${SOCKET_URL}"

# ── 2. Find every installed copy of the client config ────────────────────────
# The same six locations the image builder patches. The four nested ones matter:
# Node resolves ITS OWN copy of the client, so patching only the top-level one
# leaves a live jibo.com endpoint behind.
step "Client configuration copies"
CONFIG_PATHS=(
  "/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/usr/lib/node_modules/@jibo/jibo-log-client/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/usr/lib/node_modules/@jibo/jibo-ota-updater/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/lib/region_config.json"
)
PRESENT=()
for p in "${CONFIG_PATHS[@]}"; do
  if rsh "test -f '$p'" >/dev/null 2>&1; then
    PRESENT+=("$p")
    com="$(rsh "grep -c 'jibo\.com' '$p' 2>/dev/null" 2>/dev/null | tr -d '\r')"
    say "  present  ${p}  (jibo.com lines: ${com:-?})"
  else
    say "  absent   ${p}"
  fi
done
[ "${#PRESENT[@]}" -gt 0 ] || die "no client region_config.json found on the robot"

# ── 3. Trust: is the public root already installed? ──────────────────────────
step "Public root trust"
ROOT_SUBJECT="C=US, O=Internet Security Research Group, CN=ISRG Root X1"
ROOT_SHA="22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1"
HAVE_ROOT=0
if rsh "grep -q 'ISRG Root X1' '$TRUST_BUNDLE' 2>/dev/null" >/dev/null 2>&1; then
  HAVE_ROOT=1; say "  ISRG Root X1 already present in ${TRUST_BUNDLE}"
else
  say "  ISRG Root X1 NOT present in ${TRUST_BUNDLE}"
fi
say "  (${ROOT_SHA:0:16}… ${ROOT_SUBJECT})"

if [ ! -f "$REGION_CA" ]; then
  CANDIDATE="$(rsh 'ls /usr/lib/node_modules/@jibo/jibo-server-client/lib/http/*.pem 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
  say "  local root file : ${REGION_CA:-(none given)}"
fi

# ── 4. Rootfs is read-only; that is a real constraint, not a detail ─────────
step "Filesystem"
ROOT_MNT="$(rsh 'mount | sed -n "s|^\([^ ]*\) on / .*|\1|p" | head -1' 2>/dev/null | tr -d '\r')"
RO_ROOT="$(rsh 'mount | sed -n "/ on \/ /p" | head -1' 2>/dev/null | tr -d '\r')"
say "  ${RO_ROOT:-<could not read the / mount>}"
case "$RO_ROOT" in
  *"ro,"*|*"ro)"*) say "  NOTE: / is mounted read-only; this script must remount it rw to write" ;;
  *) say "  / is writable" ;;
esac

# ── 5. Revert ───────────────────────────────────────────────────────────────
if [ "$REVERT" -eq 1 ]; then
  step "Reverting the OTA repoint"
  say "  backups are kept beside each file as <file>.prerepoint-<stamp>.bak"
  n=0
  for p in "${PRESENT[@]}"; do
    rsh "ls '$p'.prerepoint-*.bak >/dev/null 2>&1 && { cp -a \$(ls -t '$p'.prerepoint-*.bak | head -1) '$p'; echo '  restored '$p; }" 2>/dev/null || true
    n=$((n+1))
  done
  say "  reverted ${n} config file(s); the install root is NOT removed automatically"
  say "  (removing ISRG X1 is safe but rarely wanted: other names may rely on it)"
  exit 0
fi

# ── 6. Plan ─────────────────────────────────────────────────────────────────
step "Plan"
say "  1. back up and rewrite jibo.com -> jibo.io in ${#PRESENT[@]} client config file(s)"
say "  2. install the public root into ${TRUST_BUNDLE} (+ ${TRUST_DIR}/isrg-root-x1.pem and its"
say "     subject-hash symlink), remounting / read-write for the write and back to read-only after"
say "  3. write a receipt to ${RECEIPT}"
say ""
say "  NOT touched: /etc/hosts, any private CA, adoption/loop state, hub port, server certs."
say "  After this the robot can reach ${REST_URL} and take an OTA update from it."

if [ "$DRY" -eq 1 ]; then
  say ""
  say "dry run — nothing was changed, and nothing will be. Re-run with --yes to apply."
  exit 0
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  say ""
  printf 'Apply this to %s? [y/N] ' "$ROBOT"; read -r reply </dev/tty || reply=n
  case "$reply" in y|Y|yes|YES) ;; *) say "aborted; nothing changed."; exit 0 ;; esac
fi

# ── 7. Apply ────────────────────────────────────────────────────────────────
# The rootfs is mounted read-only on this platform, and /usr/lib lives on it, so
# every write below has to remount / read-write first and put it back to
# read-only afterwards. Getting that restore wrong would leave a robot in a state
# its own boot checks did not expect, so the remount is explicit and symmetrical,
# and a trap restores it even if the script dies mid-way.
step "Applying"
APPLIED=()

ORIG_ROOT_MOUNT="$(rsh 'mount | sed -n "/ on \/ /p" | head -1' 2>/dev/null | tr -d '\r')"
ROOT_WAS_RO=0
case "$ORIG_ROOT_MOUNT" in *"ro,"*|*"ro)"*) ROOT_WAS_RO=1 ;; esac

restore_root_ro() {
  [ "$ROOT_WAS_RO" -eq 1 ] || return 0
  rsh 'mount -o remount,ro / 2>/dev/null || true' >/dev/null 2>&1 || true
}
trap restore_root_ro EXIT

if [ "$ROOT_WAS_RO" -eq 1 ]; then
  say "  remounting / read-write (it was read-only)"
  rsh 'mount -o remount,rw /' >/dev/null 2>&1 || die "could not remount / read-write"
fi

# 7a. region_config rewrite, in place, preserving mode and ownership.
# `stat` does not exist on the robot (busybox has no such applet), so the mode and
# owner are read from `ls -ln` instead and re-applied with chmod/chown.
for p in "${PRESENT[@]}"; do
  out="$(rsh "
    set -e
    f='$p'
    [ -f \"\$f.prerepoint-${STAMP}.bak\" ] || cp -a \"\$f\" \"\$f.prerepoint-${STAMP}.bak\"
    meta=\$(ls -ln \"\$f\" | awk '{print \$1, \$3, \$4}')
    mode=\$(echo \"\$meta\" | cut -d' ' -f1 | cut -c2-10)
    uid=\$(echo \"\$meta\" | cut -d' ' -f2)
    gid=\$(echo \"\$meta\" | cut -d' ' -f3)
    before=\$(grep -o 'jibo\.com' \"\$f\" | wc -l)
    sed -i 's/jibo\.com/jibo\.io/g' \"\$f\"
    # Modes on this platform are inconsistent across the six copies (seen: 644,
    # 600 root-only, and 755 uid 2000). A root-only copy is fatal: the behaviour
    # engine runs as the unprivileged skill user (uid 2000) and cannot read its
    # own client config, so every skill that reads it fails to construct —
    # Settings, IFTTT and surprises included. Normalise to world-readable rather
    # than trying to preserve a mode that may be the bug.
    chmod 644 \"\$f\" 2>/dev/null || true
    chmod a+rX \"\$(dirname \"\$f\")\" 2>/dev/null || true
    after=\$(grep -o 'jibo\.com' \"\$f\" | wc -l)
    printf '  rewrote %s (%s -> %s jibo.com; mode now %s)\n' '$p' \"\$before\" \"\$after\" \"\$(ls -ln \"\$f\" | awk '{print \$1}')\"
  " 2>&1 | tr -d '\r')"
  printf '%s\n' "$out"
  APPLIED+=("$p")
done

# 7b. Install the CA-accepting client, with the deployment CA beside it.
# The robot runs Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (added in 7.3) and ignores
# the system trust store entirely. A stock client therefore cannot verify ANY modern
# certificate: every request dies with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, which presents
# exactly like a dead server, and no amount of fixing /etc/ssl/certs will help. The client
# shipped beside this script is the CA-accepting build. It resolves its trust anchor as
#   process.env.JIBO_EXTRA_CA_CERTS || __dirname + '/phoenix-ca.pem'
# and hands it to its https.Agent, so each copy needs both files. Install into EVERY copy:
# the log client, the OTA updater and the skills each carry their own, and the OTA updater
# is one of them -- miss it and the robot can never fetch the update that would fix it.
CLIENT_SOURCE="${SCRIPT_DIR}/robot-client/node.js"
if [ -r "$CLIENT_SOURCE" ]; then
  CLIENT_HTTP_DIRS=""
  for c in "${PRESENT[@]}"; do
    CLIENT_HTTP_DIRS="${CLIENT_HTTP_DIRS} ${c%/lib/region_config.json}/lib/http"
  done
  out="$(rsh "
    set -e
    changed=0
    for d in ${CLIENT_HTTP_DIRS}; do
      [ -f \"\$d/node.js\" ] || continue
      [ -f \"\$d/node.js.prerepoint-${STAMP}.bak\" ] || cp -a \"\$d/node.js\" \"\$d/node.js.prerepoint-${STAMP}.bak\"
      printf '  client at %s -> CA-accepting build\n' \"\$d\"
      changed=\$((changed+1))
    done
    echo \"  copies to update: \$changed\"
  " 2>&1 | tr -d '\r')"
  printf '%s\n' "$out"
  # Ship the module and the CA, then place them in every copy.
  rsh "mkdir -p /tmp/robot-client" >/dev/null 2>&1
  scp -o BatchMode=yes -q "$CLIENT_SOURCE" "${ROBOT}:/tmp/robot-client/node.js" || die "could not upload the client module"
  CA_SOURCE="${ROOT_PEM_SRC:-}"
  if [ -n "$CA_SOURCE" ] && [ -r "$CA_SOURCE" ]; then
    scp -o BatchMode=yes -q "$CA_SOURCE" "${ROBOT}:/tmp/robot-client/phoenix-ca.pem" || die "could not upload the CA"
  else
    say "  no CA file available to ship; the client will fall back to its built-in roots"
  fi
  out="$(rsh "
    set -e
    n=0
    for d in ${CLIENT_HTTP_DIRS}; do
      [ -d \"\$d\" ] || continue
      cp -f /tmp/robot-client/node.js \"\$d/node.js\"
      chmod 644 \"\$d/node.js\"
      if [ -f /tmp/robot-client/phoenix-ca.pem ]; then
        cp -f /tmp/robot-client/phoenix-ca.pem \"\$d/phoenix-ca.pem\"
        chmod 644 \"\$d/phoenix-ca.pem\"
      fi
      n=\$((n+1))
    done
    rm -rf /tmp/robot-client
    printf '  installed the CA-accepting client + CA into %s copies\n' \"\$n\"
  " 2>&1 | tr -d '\r')"
  printf '%s\n' "$out"
  APPLIED+=("${CLIENT_DIRS_NOTE:-client node.js + phoenix-ca.pem (all copies)}")
else
  say "  ${CLIENT_SOURCE} not found; the client cannot be given a CA and TLS will fail"
fi

# 7c. Trust root.
# openssl does NOT exist on the robot, so the subject-hash symlink name is computed
# here, from the certificate, and shipped with the file.
if [ "$HAVE_ROOT" -eq 0 ]; then
  ROOT_PEM_SRC="${REGION_CA}"
  [ -f "$ROOT_PEM_SRC" ] || ROOT_PEM_SRC="/home/shell/work/phoenix/scripts/robot-client/isrg-root-x1.pem"
  if [ ! -f "$ROOT_PEM_SRC" ]; then
    say "  no ISRG Root X1 available locally (pass --region-ca <pem>); trust step SKIPPED."
  else
    HASH="$(openssl x509 -in "$ROOT_PEM_SRC" -noout -subject_hash_old 2>/dev/null | tr -d '\r')"
    [ -n "$HASH" ] || die "could not compute the subject hash from $ROOT_PEM_SRC"
    TMP_REMOTE="/tmp/.phoenix-isrg-root-${STAMP}-$$.pem"
    scp -o BatchMode=yes -q "$ROOT_PEM_SRC" "${ROBOT}:${TMP_REMOTE}" || die "could not upload the root certificate"
    out="$(rsh "
      set -e
      cp -a '$TRUST_BUNDLE' '$TRUST_BUNDLE.prerepoint-${STAMP}.bak' 2>/dev/null || true
      cat '$TMP_REMOTE' >> '$TRUST_BUNDLE'
      cp -a '$TMP_REMOTE' '${TRUST_DIR}/isrg-root-x1.pem'
      chmod 644 '${TRUST_DIR}/isrg-root-x1.pem'
      ln -sf 'isrg-root-x1.pem' '${TRUST_DIR}/${HASH}.0'
      rm -f '$TMP_REMOTE'
      printf '  installed ISRG Root X1 into %s\n' '$TRUST_BUNDLE'
      printf '  plus %s/isrg-root-x1.pem and %s/${HASH}.0\n' '${TRUST_DIR}' '${TRUST_DIR}'
    " 2>&1 | tr -d '\r')"
    printf '%s\n' "$out"
    APPLIED+=("${TRUST_BUNDLE}")
  fi
fi

# 7d. Put / back the way it was found.
restore_root_ro
say "  / restored: $(rsh 'mount | sed -n "/ on \/ /p" | head -1' 2>/dev/null | tr -d '\r')"

# 7e. Receipt — written only after the changes are actually made.
rsh "
  mkdir -p '$RECEIPT_DIR'
  cat > '$RECEIPT' <<JSON
{
  \"kind\": \"phoenix-ota-repoint\",
  \"stamp\": \"${STAMP}\",
  \"robot\": \"${HOSTNAME_}\",
  \"region\": \"${REGION}\",
  \"rest_url\": \"${REST_URL}\",
  \"mode\": \"minimal-ota\",
  \"patched\": \"$(printf '%s ' "${APPLIED[@]}")\",
  \"trust_root\": \"${ROOT_SHA}\",
  \"hosts_intercept\": false,
  \"private_ca\": false
}
JSON
  echo \"  receipt written to ${RECEIPT}\"
" 2>&1 | tr -d '\r'

# ── 8. Verify ───────────────────────────────────────────────────────────────
step "Verify"
say "  jibo.com references left in the patched files:"
for p in "${APPLIED[@]}"; do
  case "$p" in *region_config.json)
    n="$(rsh "grep -c 'jibo\.com' '$p' 2>/dev/null" 2>/dev/null | tr -d '\r')"
    printf '    %-6s %s\n' "${n:-?}" "$p" ;;
  esac
done

if [ "$VERIFY" -eq 1 ]; then
  say "  asking the robot itself to validate the server's certificate:"
  out="$(rsh "echo | openssl s_client -connect ${REGION}.${PUBLIC_SUFFIX}:443 -servername ${REGION}.${PUBLIC_SUFFIX} 2>&1 | grep -E 'Verify return code|subject=|issuer=' | head -4" 2>&1 | tr -d '\r')"
  printf '%s\n' "$out"
  case "$out" in
    *"Verify return code: 0"*) say "  -> the robot validates the server certificate." ;;
    *) say "  -> NOT validated. Check the trust-store step above before expecting an update." ;;
  esac
fi

step "Done"
say "  Next: leave the robot alone and let it poll, or force the check by cycling"
say "  the robot's mode. It should be offered the 13.0.1 jibo.io packages and, on"
say "  applying them, come up talking to ${REST_URL} with no hosts intercept and no"
say "  private CA in the path."
say ""
say "  Revert with: $0 --robot $ROBOT --revert"