#!/usr/bin/env bash
#
# Repoint a Jibo robot at a Phoenix server that owns its own domain (jibo.io).
#
# Running this with no mode flag detects whether the robot is already paired and
# patches the routes and TLS trust it needs to reach this server and take its OTA:
#
#   1. every installed copy of the jibo-server-client `region_config.json` is
#      normalized to the public server, including third-party rules; a
#      credential-level endpoint override (as installed by 5x1/OpenJibo)
#      is also replaced without changing the robot's keys;
#   2. the publicly-trusted root (ISRG Root X1), CA-verifying Node clients,
#      native downloader/backup TLS path, notification and Jetstream routes are
#      prepared for *.jibo.io. Existing robot identity is preserved.
#   3. on the paired/claimed OTA path, refresh all four published subsystems
#      (OS, services, OOBE, BE) through the stock system-manager, regardless of
#      the versions installed by another cloud. Only the OTA query briefly sees
#      0.0.1; installed-version files and the compiled manager are untouched.
#
# Deliberately NOT done:
#   * no /etc/hosts intercept
#   * no private certificate authority
#   * no account adoption / loop claim, unless a signed-in portal claim code is
#     explicitly supplied
#   * no server-side certificate generation
#
# A prior mod may have disabled TLS verification in an otherwise stock client.
# Only that exact, reversible one-line change is accepted and replaced with
# the CA-verifying client. Other unknown client modifications remain a stop.
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
#                        [--claim-code <portal-code>] [--start-ota]
#                        [--dry-run] [--yes] [--verify] [--revert]
#   robot-ota-repoint.sh --robot root@<ip> --ota-only [--dry-run] [--yes]
#   robot-ota-repoint.sh --robot root@<ip> --oobe --yes [--no-reboot]
#   robot-ota-repoint.sh --robot root@<ip> --auto [--claim-code <portal-code>] --yes
#   robot-ota-repoint.sh --robot root@<ip> --full --phoenix https://... --yes
#
# The console's one-line form runs the published copy directly and asks for the
# robot's address, since it has no --robot (a claim code implies --auto):
#   bash <(curl -fsSL https://jibo.io/repoint) --claim-code <portal-code>
#
# Nothing is changed without showing a plan first. Edited cloud configs receive
# timestamped backups; --revert restores region configs only, not credentials,
# client/CA/hub patches, or an identity issued after QR setup.

set -uo pipefail

ROBOT=""; REGION=""; REGION_CA=""; DRY=0; ASSUME_YES=0; VERIFY=0; REVERT=0
PUBLIC_SUFFIX="jibo.io"
FULL=0; FULL_ARGS=(); CLAIM_CODE=""; OOBE=0; OTA_ONLY=0; START_OTA=0; AUTO=0; REBOOT=1

# The robot's own trust store. `bundle` is what OpenSSL reads; the individual PEM
# plus the subject-hash symlink are how a cert is normally installed alongside it.
TRUST_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
TRUST_DIR="/etc/ssl/certs"
RECEIPT_DIR="/var/lib/phoenix"
RECEIPT="${RECEIPT_DIR}/ota-repoint.json"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# Run as `bash <(curl ...)`, $0 is a pipe that has already been read: point at
# the published copy instead, for help text and for the commands printed below.
if [ -f "$0" ]; then SELF_CMD="$0"; else SELF_CMD="bash <(curl -fsSL https://jibo.io/repoint)"; fi
usage() {
  if [ -f "$0" ]; then sed -n '2,56p' "$0" | sed 's/^# \{0,1\}//'
  else printf "Usage: see https://jibo.io/robot-ota-repoint.sh\n"; fi
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "${1}" in
    --robot)     ROBOT="${2:-}"; shift 2 ;;
    --region)    REGION="${2:-}"; shift 2 ;;
    --region-ca) REGION_CA="${2:-}"; shift 2 ;;
    --suffix)    PUBLIC_SUFFIX="${2:-}"; shift 2 ;;
    --claim-code) CLAIM_CODE="${2:-}"; shift 2 ;;
    --oobe)      OOBE=1; shift ;;
    --auto)      AUTO=1; shift ;;
    --ota-only)  OTA_ONLY=1; shift ;;
    --start-ota) START_OTA=1; shift ;;
    --dry-run)   DRY=1; shift ;;
    --yes)       ASSUME_YES=1; shift ;;
    --verify)    VERIFY=1; shift ;;
    --revert)    REVERT=1; shift ;;
    --no-reboot) REBOOT=0; shift ;;
    --full)      FULL=1; shift ;;
    -h|--help)   usage 0 ;;
    *)
      if [ "$FULL" -eq 1 ]; then FULL_ARGS+=("$1"); shift; else
        echo "unknown option: $1" >&2; usage 2
      fi ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# The portal publishes this script as a single download. A source checkout has
# robot-client/ beside it, but a downloaded script does not. Fetch only the four
# fixed support assets that the script needs, pin them by SHA-256, and keep them
# in a temporary local directory. They are pinned the same way when the script
# itself runs straight from `bash <(curl ...)`.
PUBLIC_ASSET_ORIGIN="${PHOENIX_REPOINT_ASSET_ORIGIN:-https://jibo.io}"
CLIENT_SOURCE="${SCRIPT_DIR}/robot-client/node.js"
# Factory RTM2/RTM3 images (platform 3.0.x/3.3.x) ship the 2.0-2.11 client, whose
# HTTP handler predates the one node.js is built from; it gets its own variant.
CLIENT_V2_SOURCE="${SCRIPT_DIR}/robot-client/node-v2.js"
ROOT_PEM_SRC="${REGION_CA}"
BACKUP_TLS_PATCHER="${SCRIPT_DIR}/robot-client/patch-system-backup-tls.cjs"
OTA_TLS_PATCHER="${SCRIPT_DIR}/robot-client/patch-ota-downloader-tls.cjs"
SSM_WIFI_PATCHER="${SCRIPT_DIR}/robot-client/patch-ssm-wifi-check.cjs"
SETUP_TEXT_PATCHER="${SCRIPT_DIR}/robot-client/patch-oobe-setup-text.cjs"
CONFIG_PATCHER="${SCRIPT_DIR}/robot-client/repoint-cloud-config.cjs"
OTA_TRIGGER="${SCRIPT_DIR}/robot-client/trigger-ota.cjs"
SUPPORT_DIR=""
CONFIG_PATCHER_REMOTE=""
CLIENT_SOURCE_SHA256="29686ca0aec6b93b8b716b94fca443ce25e6e7e55e01e798be56bce920c66bac"
CLIENT_V2_SOURCE_SHA256="22bb36bcc0c7ecedf64cca3c66b11c5d7959b3eba85990c739e77238c7b9c503"
# The two stock lib/http/node.js files across every archived jibo-server-client
# release: 2.0.0-2.11.x, and 2.12.0 through every 3.0.x.
STOCK_CLIENT_V2_SHA256="81533de391dfba88fc40bedfc63ea30a77f8d032f9a8c23196db4cb3a44fa89b"
STOCK_CLIENT_V3_SHA256="c3511dbc55c8a9ec3ac74a675a1245306b55c67fab65a3ecfe896ed01689997a"
ROOT_PEM_SOURCE_SHA256="22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1"
BACKUP_TLS_PATCHER_SHA256="0fee710b1dec524b8d4629deb19e8be9dc1013e161abed4180be3d2f2c28e2d8"
OTA_TLS_PATCHER_SHA256="51b71ff2e02569f203998b7d82c6e3f2743030a48bbc3abc149a66c6563061f1"
SSM_WIFI_PATCHER_SHA256="01e806871ed64736e4717856aed1be49c4898723d8bb253d68cab860c9f64947"
SETUP_TEXT_PATCHER_SHA256="edcc2971b932a41da80f9af286a74ce41cc213ccc90af429bfdf7e2a2c8989a1"
CONFIG_PATCHER_SHA256="dd1842f47a91afda7b675c8adff3770a4732fcade6f1c78acfe7d16db41b013c"
OTA_TRIGGER_SHA256="a2814b784c7027da26ae062b9f15c1b010839f48aada5a3f38264b8280269a45"

cleanup_support() {
  if [ -n "$CONFIG_PATCHER_REMOTE" ] && declare -F rsh >/dev/null 2>&1; then
    rsh "rm -f '$CONFIG_PATCHER_REMOTE'" >/dev/null 2>&1 || true
  fi
  [ -z "$SUPPORT_DIR" ] || rm -rf "$SUPPORT_DIR"
  [ -z "${SSH_DIR:-}" ] || close_ssh
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the public support files"
  fi
}

fetch_support_asset() {
  local path="$1" dest="$2" expected="$3" actual=""
  command -v curl >/dev/null 2>&1 || die "curl is required to fetch ${path}; download it beside this script instead"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 60 "${PUBLIC_ASSET_ORIGIN}${path}" -o "$dest" \
    || die "could not fetch ${PUBLIC_ASSET_ORIGIN}${path}"
  actual="$(sha256_of "$dest")"
  [ "$actual" = "$expected" ] || { rm -f "$dest"; die "downloaded ${path} failed its SHA-256 check"; }
}

ensure_support_assets() {
  # A checked-out copy has both support files already. A standalone download
  # receives only the missing file(s), never overwrites a supplied custom CA.
  if [ ! -r "$CLIENT_SOURCE" ] || [ ! -r "$CLIENT_V2_SOURCE" ] || [ ! -r "$BACKUP_TLS_PATCHER" ] || [ ! -r "$OTA_TLS_PATCHER" ] || [ ! -r "$SSM_WIFI_PATCHER" ] || [ ! -r "$SETUP_TEXT_PATCHER" ] || [ ! -r "$CONFIG_PATCHER" ] || { [ -z "$ROOT_PEM_SRC" ] && [ ! -r "${SCRIPT_DIR}/robot-client/isrg-root-x1.pem" ]; }; then
    SUPPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/phoenix-repoint.XXXXXX")" || die "could not create a temporary support directory"
  fi
  if [ ! -r "$CLIENT_SOURCE" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    CLIENT_SOURCE="$SUPPORT_DIR/robot-client/node.js"
    fetch_support_asset '/robot-client/node.js' "$CLIENT_SOURCE" "$CLIENT_SOURCE_SHA256"
  fi
  if [ ! -r "$CLIENT_V2_SOURCE" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    CLIENT_V2_SOURCE="$SUPPORT_DIR/robot-client/node-v2.js"
    fetch_support_asset '/robot-client/node-v2.js' "$CLIENT_V2_SOURCE" "$CLIENT_V2_SOURCE_SHA256"
  fi
  if [ ! -r "$ROOT_PEM_SRC" ]; then
    ROOT_PEM_SRC="${SCRIPT_DIR}/robot-client/isrg-root-x1.pem"
    if [ ! -r "$ROOT_PEM_SRC" ]; then
      mkdir -p "$SUPPORT_DIR/robot-client"
      ROOT_PEM_SRC="$SUPPORT_DIR/robot-client/isrg-root-x1.pem"
      fetch_support_asset '/robot-client/isrg-root-x1.pem' "$ROOT_PEM_SRC" "$ROOT_PEM_SOURCE_SHA256"
    fi
  fi
  if [ ! -r "$BACKUP_TLS_PATCHER" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    BACKUP_TLS_PATCHER="$SUPPORT_DIR/robot-client/patch-system-backup-tls.cjs"
    fetch_support_asset '/robot-client/patch-system-backup-tls.cjs' "$BACKUP_TLS_PATCHER" "$BACKUP_TLS_PATCHER_SHA256"
  fi
  if [ ! -r "$OTA_TLS_PATCHER" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    OTA_TLS_PATCHER="$SUPPORT_DIR/robot-client/patch-ota-downloader-tls.cjs"
    fetch_support_asset '/robot-client/patch-ota-downloader-tls.cjs' "$OTA_TLS_PATCHER" "$OTA_TLS_PATCHER_SHA256"
  fi
  if [ ! -r "$SSM_WIFI_PATCHER" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    SSM_WIFI_PATCHER="$SUPPORT_DIR/robot-client/patch-ssm-wifi-check.cjs"
    fetch_support_asset '/robot-client/patch-ssm-wifi-check.cjs' "$SSM_WIFI_PATCHER" "$SSM_WIFI_PATCHER_SHA256"
  fi
  if [ ! -r "$SETUP_TEXT_PATCHER" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    SETUP_TEXT_PATCHER="$SUPPORT_DIR/robot-client/patch-oobe-setup-text.cjs"
    fetch_support_asset '/robot-client/patch-oobe-setup-text.cjs' "$SETUP_TEXT_PATCHER" "$SETUP_TEXT_PATCHER_SHA256"
  fi
  if [ ! -r "$CONFIG_PATCHER" ]; then
    mkdir -p "$SUPPORT_DIR/robot-client"
    CONFIG_PATCHER="$SUPPORT_DIR/robot-client/repoint-cloud-config.cjs"
    fetch_support_asset '/robot-client/repoint-cloud-config.cjs' "$CONFIG_PATCHER" "$CONFIG_PATCHER_SHA256"
  fi
}

ensure_ota_trigger() {
  if [ ! -r "$OTA_TRIGGER" ]; then
    [ -n "$SUPPORT_DIR" ] || SUPPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/phoenix-repoint.XXXXXX")" \
      || die "could not create a temporary support directory"
    mkdir -p "$SUPPORT_DIR/robot-client"
    OTA_TRIGGER="$SUPPORT_DIR/robot-client/trigger-ota.cjs"
    fetch_support_asset '/robot-client/trigger-ota.cjs' "$OTA_TRIGGER" "$OTA_TRIGGER_SHA256"
  fi
}

trap cleanup_support EXIT
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── Advanced path: hand off to the full repoint, unchanged ───────────────────
if [ "$FULL" -eq 1 ]; then
  [ "$OTA_ONLY" -eq 0 ] && [ "$START_OTA" -eq 0 ] && [ "$AUTO" -eq 0 ] || die "OTA/auto flags cannot be combined with --full"
  SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
  FULL_SCRIPT="${SELF_DIR}/parity-robot/repoint-robot.sh"
  [ -x "$FULL_SCRIPT" ] || die "full repoint script not found: $FULL_SCRIPT"
  say "delegating to the full repoint (unchanged behaviour): $FULL_SCRIPT"
  exec "$FULL_SCRIPT" ${ROBOT:+--robot "$ROBOT"} "${FULL_ARGS[@]}"
fi

# The console's command carries a claim code and nothing else: that is the
# credential-detecting path it has always asked for.
if [ -n "$CLAIM_CODE" ] && [ "$AUTO" -eq 0 ] && [ "$OOBE" -eq 0 ] && [ "$OTA_ONLY" -eq 0 ] \
    && [ "$START_OTA" -eq 0 ] && [ "$REVERT" -eq 0 ]; then
  AUTO=1
fi
if [ -z "$ROBOT" ] && { : </dev/tty; } 2>/dev/null; then
  say "Jibo must be in int-developer mode and on this network."
  printf "Jibo's IP address or hostname (your router's device list shows it): " >/dev/tty
  read -r ROBOT </dev/tty || ROBOT=""
  ROBOT="$(printf '%s' "$ROBOT" | tr -d '[:space:]')"
fi
[ -n "$ROBOT" ] || die "--robot root@<ip> is required (or --full for the complete repoint)"
[ "$AUTO" -eq 0 ] || { [ "$OOBE" -eq 0 ] && [ "$OTA_ONLY" -eq 0 ] && [ "$START_OTA" -eq 0 ] && [ "$REVERT" -eq 0 ]; } \
  || die "--auto selects the credential path itself; do not combine it with --oobe, --ota-only, --start-ota, or --revert"
[ "$OTA_ONLY" -eq 0 ] || { [ "$START_OTA" -eq 0 ] && [ "$OOBE" -eq 0 ] && [ "$REVERT" -eq 0 ] \
  && [ -z "$CLAIM_CODE" ]; } || die "--ota-only cannot be combined with repoint, OOBE, revert, or claim flags"
[ "$START_OTA" -eq 0 ] || { [ "$OOBE" -eq 0 ] && [ "$REVERT" -eq 0 ]; } \
  || die "--start-ota requires an already-paired robot and cannot be combined with --revert"
if [ "$OOBE" -eq 1 ] && [ -n "$CLAIM_CODE" ]; then
  die "--oobe cannot use --claim-code; an unprovisioned robot links through QR setup"
fi
if [ -n "$CLAIM_CODE" ] && [[ ! "$CLAIM_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  die "--claim-code must be the exact one-time code shown by the portal"
fi
[[ "$PUBLIC_SUFFIX" =~ ^([a-z0-9][a-z0-9-]*\.)+[a-z0-9][a-z0-9-]*$ ]] \
  || die "--suffix must be a DNS domain such as jibo.io"

# A bare address means the robot's root account; that is the only login a
# stock Jibo has.
case "$ROBOT" in *@*) ;; *) ROBOT="root@${ROBOT}" ;; esac

# ── SSH: authenticate once, then share that connection ───────────────────────
# Do not assume a key is installed. A stock robot accepts root with the factory
# password `jibo`, and many owners have never changed it. Try, in order: any key
# or agent the user already has (never prompting), the factory login supplied
# automatically, and finally an interactive prompt for the root password. The
# first success opens one multiplexed master connection; every later command
# and upload reuses it, so a password is entered at most once.
DEFAULT_ROBOT_PASSWORD="jibo"
SSH_DIR="$(mktemp -d /tmp/phoenix-ssh.XXXXXX)" || die "could not create a private SSH control directory"
SSH_CONTROL="${SSH_DIR}/master"
# accept-new: a robot never seen before is trusted on first use. CheckHostIP=no:
# robots take DHCP addresses, so a stale key filed under an old IP is noise that
# would otherwise fail a key the hostname entry already matches.
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new
  -o CheckHostIP=no -o ControlPath="$SSH_CONTROL")
SSH=(ssh "${SSH_OPTS[@]}" "$ROBOT")
rsh() { "${SSH[@]}" "$@"; }
# Uploads go through the same connection as `cat`, not scp: newer clients run
# scp over SFTP, which not every firmware's sshd provides.
rput() { rsh "cat > '$2'" < "$1"; }

close_ssh() {
  [ -S "$SSH_CONTROL" ] && ssh -o ControlPath="$SSH_CONTROL" -O exit "$ROBOT" >/dev/null 2>&1
  rm -rf "$SSH_DIR"
}

open_master() {
  # Authenticates in the foreground (so a prompt can be answered), then keeps
  # the master in the background until close_ssh.
  ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o ControlPersist=yes -f -N "$@" "$ROBOT" 2>"${SSH_DIR}/err"
  local status=$?
  [ "$status" -eq 0 ] && [ -S "$SSH_CONTROL" ] && return 0
  if [ "$status" -eq 0 ]; then
    die "this SSH client cannot share connections (multiplexing); run this from Linux, macOS, or WSL"
  fi
  return 1
}

host_key_failed() {
  grep -qE 'REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed' "${SSH_DIR}/err" 2>/dev/null
}

# The names the robot's key is filed under in known_hosts: the real host name
# (after any ssh_config alias), "[host]:port" off port 22, and its current IP.
known_host_names() {
  local host port address
  host="$(ssh -G "$ROBOT" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')"
  port="$(ssh -G "$ROBOT" 2>/dev/null | awk '$1 == "port" { print $2; exit }')"
  [ -n "$host" ] || host="${ROBOT#*@}"
  address="$(getent hosts "$host" 2>/dev/null | awk '{ print $1; exit }')"
  local name
  for name in "$host" ${address:+"$address"}; do
    if [ -n "$port" ] && [ "$port" != 22 ]; then printf '[%s]:%s\n' "$name" "$port"; else printf '%s\n' "$name"; fi
  done | awk '!seen[$0]++'
}

# Reflashing gives the robot a new host key, so a changed key is the normal
# case here, but it is still the user's call: show the new fingerprint and ask
# (--yes does not answer this). Without a terminal, say exactly what to run.
forget_changed_host_key() {
  local names fingerprint answer name
  names="$(known_host_names)"
  fingerprint="$(grep -oE 'SHA256:[A-Za-z0-9+/=]+' "${SSH_DIR}/err" | head -1)"
  if ! { : </dev/tty; } 2>/dev/null; then
    die "the robot's SSH host key changed (normal after a reflash). If this is your Jibo, run: $(printf 'ssh-keygen -R %s; ' $names)then run this again"
  fi
  say "  ${ROBOT}'s SSH host key has changed. That is expected if it was reflashed or reset;"
  say "  otherwise another device may be answering at this address."
  [ -z "$fingerprint" ] || say "  New key fingerprint: ${fingerprint}"
  printf '  Forget the old key for %s and continue? [y/N] ' "$(echo $names)" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) ;; *) die "stopped: the robot's host key was not accepted" ;; esac
  for name in $names; do ssh-keygen -R "$name" >/dev/null 2>&1 || true; done
  say "  Old host key removed; the new one will be saved on this connection."
}

ssh_failure_hint() {
  if host_key_failed; then
    die "the robot's SSH host key changed (normal after a reflash). If this is your Jibo, run: $(printf 'ssh-keygen -R %s; ' $(known_host_names))then run this again"
  fi
  if grep -qiE 'timed out|no route|refused|could not resolve|unreachable' "${SSH_DIR}/err" 2>/dev/null; then
    die "cannot reach ${ROBOT} over SSH: $(tail -1 "${SSH_DIR}/err")"
  fi
}

connect_robot() {
  if open_master -o BatchMode=yes; then SSH_AUTH="key"; return 0; fi
  if host_key_failed; then
    forget_changed_host_key
    if open_master -o BatchMode=yes; then SSH_AUTH="key"; return 0; fi
  fi
  ssh_failure_hint

  # The factory password, answered by an askpass helper instead of a person.
  # SSH_ASKPASS_REQUIRE needs OpenSSH 8.4+; setsid covers older clients.
  local askpass="${SSH_DIR}/askpass" setsid_cmd=()
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$DEFAULT_ROBOT_PASSWORD" > "$askpass"
  chmod 700 "$askpass"
  # -w: wait for ssh, or setsid can return before the login has finished.
  setsid -w true >/dev/null 2>&1 && setsid_cmd=(setsid -w)
  if SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-phoenix:0}" \
      ${setsid_cmd[@]+"${setsid_cmd[@]}"} ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o ControlPersist=yes -f -N \
      -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
      -o NumberOfPasswordPrompts=1 "$ROBOT" </dev/null 2>"${SSH_DIR}/err" && [ -S "$SSH_CONTROL" ]; then
    SSH_AUTH="factory password"; return 0
  fi
  rm -f "$askpass"

  # Opening it is the only real test: [ -r /dev/tty ] passes without a terminal.
  { : </dev/tty; } 2>/dev/null \
    || die "the robot refused key and factory-password login, and there is no terminal to ask for its root password"
  say "  The robot did not accept an SSH key or the factory password."
  say "  Enter the root password for ${ROBOT} (it is not stored or sent anywhere else)."
  if open_master -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
      -o NumberOfPasswordPrompts=3 </dev/tty; then
    SSH_AUTH="password"; return 0
  fi
  ssh_failure_hint
  die "could not log in to ${ROBOT} as root: $(tail -1 "${SSH_DIR}/err" 2>/dev/null)"
}

set_paired_mode_normal_if_ready() {
  local current_mode
  if ! rsh 'test -s /opt/jibo/Jibo/Skills/@be/be/package.json' >/dev/null 2>&1; then
    say "  BE is not installed yet; preserving the current mode until its OTA download is verified."
    return 0
  fi
  current_mode="$(rsh 'jibo-getmode' 2>/dev/null | tr -d '\r')" \
    || die "could not read the robot's saved mode"
  [ "$current_mode" = normal ] && { say "  next-boot mode is already normal"; return 0; }
  rsh 'jibo-setmode normal && test "$(jibo-getmode)" = normal' >/dev/null 2>&1 \
    || die "could not set and verify normal mode for the next boot"
  say "  next-boot mode: ${current_mode} -> normal (no reboot triggered)"
}

run_native_ota() {
  ensure_ota_trigger
  local remote plan_output plan_hash count
  remote="$(rsh 'mktemp /tmp/phoenix-trigger-ota.XXXXXX' 2>/dev/null | tr -d '\r')"
  [[ "$remote" =~ ^/tmp/phoenix-trigger-ota\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote OTA helper path"
  rput "$OTA_TRIGGER" "$remote" || die "could not upload the OTA helper"
  if [ "$DRY" -eq 1 ]; then
    plan_output="$(rsh "node '$remote' --preview fcs" 2>&1 | tr -d '\r')" \
      || die "could not preview the full native OTA: $plan_output"
    printf '%s\n' "$plan_output"
    rsh "rm -f '$remote'" >/dev/null 2>&1 || true
    say "  dry run: no firmware or configuration files changed; no OTA download or installation started"
    return 0
  fi
  plan_output="$(rsh "node '$remote' --plan fcs" 2>&1 | tr -d '\r')" \
    || die "could not plan the native OTA: $plan_output"
  printf '%s\n' "$plan_output"
  plan_hash="$(printf '%s\n' "$plan_output" | sed -n 's/^PHOENIX_OTA_PLAN_HASH=\([a-f0-9]*\)$/\1/p')"
  [[ "$plan_hash" =~ ^[a-f0-9]{64}$ ]] || die "OTA helper returned no valid plan hash"
  count="$(printf '%s\n' "$plan_output" | sed -n 's/^PHOENIX_OTA_UPDATE_COUNT=\([0-9]*\)$/\1/p')"
  [ "$count" = 4 ] || die "full-refresh OTA must include all four published subsystems"
  OTA_UPDATE_COUNT="$count"
  # The full repoint already showed an OTA/reboot step and received approval at
  # the Apply prompt. Only standalone --ota-only needs its own confirmation.
  if [ "$OTA_ONLY" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
    printf 'Download and install these native OTA updates on %s (robot will reboot)? [y/N] ' "$ROBOT"
    read -r reply </dev/tty || reply=n
    case "$reply" in y|Y|yes|YES) ;; *) rsh "rm -f '$remote'" >/dev/null 2>&1 || true; say "OTA aborted; nothing downloaded"; return 0 ;; esac
  fi
  rsh "node '$remote' --apply '$plan_hash' fcs" 2>&1 | tr -d '\r' \
    || die "native OTA did not confirm completion; the robot may already be rebooting. Check its OTA state before retrying"
  rsh "rm -f '$remote'" >/dev/null 2>&1 || true
}

connect_robot
rsh 'true' >/dev/null 2>&1 || die "logged in to ${ROBOT}, but the shared SSH connection is not usable"

# ── 1. Establish the robot's identity and region ─────────────────────────────
step "Robot"
HOSTNAME_="$(rsh 'hostname' 2>/dev/null | tr -d '\r')"
RELEASE="$(rsh 'jibo-version 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
MODE="$(rsh 'jibo-getmode 2>/dev/null' 2>/dev/null | tr -d '\r')"
NODE_VERSION="$(rsh 'node -v 2>/dev/null' 2>/dev/null | tr -d '\r')"
# Factory RTM2/RTM3 images have no system backup/restore helpers to patch.
HAS_BACKUP_HELPERS=0
if rsh 'test -f /usr/local/bin/jibo-system-backup || test -f /usr/local/bin/jibo-system-restore' >/dev/null 2>&1; then
  HAS_BACKUP_HELPERS=1
fi
# Before the 12.x line audio turns are configured through the client configs
# above; only later firmware has a separate jetstream hub config.
HAS_JETSTREAM=0
if rsh 'test -f /usr/local/etc/jibo-jetstream-service.json' >/dev/null 2>&1; then HAS_JETSTREAM=1; fi
HAS_CREDS=0
if rsh 'test -s /var/jibo/credentials.json' >/dev/null 2>&1; then HAS_CREDS=1; fi
# A non-empty file is not necessarily a usable identity. Check its shape on the
# robot (the secret stays there until adoption needs it) against the formats the
# adoption endpoint accepts, so a damaged file stops here, before any change,
# instead of after the endpoints and trust store have already been rewritten.
CREDS_USABLE=0
if [ "$HAS_CREDS" -eq 1 ] && rsh 'f=/var/jibo/credentials.json
  grep -Eq "\"accessKeyId\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9]{20}\"" "$f" &&
  grep -Eq "\"secretAccessKey\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9]{40}\"" "$f"' >/dev/null 2>&1; then
  CREDS_USABLE=1
fi
if [ "$HAS_CREDS" -eq 1 ] && [ "$CREDS_USABLE" -eq 0 ]; then
  die "/var/jibo/credentials.json exists but does not hold a complete robot identity; nothing was changed. Inspect it before choosing adoption or QR setup"
fi
if [ "$AUTO" -eq 1 ]; then
  if [ "$HAS_CREDS" -eq 1 ]; then
    if [ -n "$CLAIM_CODE" ]; then
      START_OTA=1
      say "  detected  : credentials present; adopt/claim and start native OTA"
    else
      say "  detected  : credentials present; verify/register without changing account ownership"
      say "  OTA       : deferred until an account claim or an explicit --ota-only run"
    fi
  else
    OOBE=1
    say "  detected  : credentials absent; repoint for QR setup and its automatic OTA"
    if [ -n "$CLAIM_CODE" ]; then
      say "  claim code: not used on this path; QR setup will link the robot to the account"
      CLAIM_CODE=""
    fi
  fi
fi
if [ "$OOBE" -eq 1 ]; then
  [ "$HAS_CREDS" -eq 0 ] || die "--oobe requires no active robot credentials; use the already-set-up migration path"
else
  [ "$HAS_CREDS" -eq 1 ] || die "robot has no active credentials; use --oobe if it is on the setup screen"
fi
if [ -z "$REGION" ]; then
  if [ "$OOBE" -eq 1 ]; then
    # OOBE does not have robot credentials. Its skill carries the authoritative
    # serverRegion it will use during SetupRobot, so match that exact value.
    REGION="$(rsh 'sed -n "s/.*\"serverRegion\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /opt/jibo/Jibo/Skills/oobe-config/config.json 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
    # Factory RTM2/RTM3 (3.x) and 5.x setup skills name no region; their clients
    # fall back to the production region, which is what this server serves.
    if [ -z "$REGION" ]; then
      REGION="api"
      REGION_NOTE=" (default: this firmware's setup skill names no region)"
    fi
  else
    # Do not echo the credential material sitting beside the region field.
    REGION="$(rsh 'sed -n "s/.*\"region\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" /var/jibo/credentials.json 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')"
  fi
fi
[ -n "$REGION" ] || die "could not determine the robot's region; pass --region"
[[ "$REGION" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "invalid region name"
say "  host      : ${HOSTNAME_:-unknown}"
say "  login     : root via ${SSH_AUTH}"
if [ "$SSH_AUTH" = "factory password" ]; then
  say "  NOTE      : this Jibo still accepts the factory root password; anyone on your"
  say "              network can log in to it. Consider changing it with passwd on the robot."
fi
say "  release   : ${RELEASE:-unknown}"
say "  mode      : ${MODE:-unknown}"
say "  region    : ${REGION:-unknown}${REGION_NOTE:-}"
say "  node      : ${NODE_VERSION:-unknown}"
REST_URL="https://${REGION}.${PUBLIC_SUFFIX}/"
SOCKET_URL="wss://${REGION}-socket.${PUBLIC_SUFFIX}/"
HUB_PREFIX="${REGION%-entrypoint}"
HUB_HOST="${HUB_PREFIX}-hub.${PUBLIC_SUFFIX}"
[ "$REGION" = "api" ] && HUB_HOST="neo-hub.${PUBLIC_SUFFIX}"
say "  will call : ${REST_URL}"
say "  socket    : ${SOCKET_URL}"

if [ "$OTA_ONLY" -eq 1 ]; then
  step "Native OTA (BE is not required)"
  run_native_ota
  exit 0
fi

# ── 2. Find every installed copy of the client config ────────────────────────
# Check both shipped locations for jibo-ssm as well as the skill-local copies.
# Node resolves ITS OWN copy of the client, so patching only the top-level one
# leaves a live jibo.com endpoint behind.
step "Client configuration copies"
CONFIG_PATHS=(
  "/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/usr/lib/node_modules/@jibo/jibo-log-client/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/usr/lib/node_modules/@jibo/jibo-ota-updater/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/usr/local/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/@be/be/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/phoenix-be-11-0-2-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/phoenix-be-11-0-3-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/phoenix-be12-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
  "/opt/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/lib/region_config.json"
)
# Firmware bundles more copies than the fixed list names: 10.x nests nine more
# inside jibo-ssm's own dependencies. Search the trees that hold Node clients and
# keep the fixed list as a floor in case the robot's find cannot search.
FOUND_PATHS="$(rsh 'for d in /usr/lib/node_modules /bin/jibo-ssm /usr/local/bin/jibo-ssm /opt/jibo/Jibo/Skills; do
    [ -d "$d" ] && find "$d" -name region_config.json 2>/dev/null
  done | grep "/jibo-server-client/lib/region_config.json$"' 2>/dev/null | tr -d '\r')"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [[ "$p" =~ ^/[A-Za-z0-9_./@-]+$ ]] || die "unsafe client config path discovered on the robot"
  case " ${CONFIG_PATHS[*]} " in *" $p "*) ;; *) CONFIG_PATHS+=("$p") ;; esac
done <<< "$FOUND_PATHS"

# Each copy's HTTP handler decides which CA-accepting build it receives. Only the
# two stock handlers (or an earlier install of ours) are recognized; anything
# else stops here, before a single file has changed.
PRESENT=()
HANDLER_VARIANT=()
for p in "${CONFIG_PATHS[@]}"; do
  if rsh "test -f '$p'" >/dev/null 2>&1; then
    handler="${p%/region_config.json}/http/node.js"
    handler_hash="$(rsh "sha256sum '$handler' 2>/dev/null" 2>/dev/null | awk '{print $1}')"
    repaired=0
    case "$handler_hash" in
      "$STOCK_CLIENT_V3_SHA256"|"$CLIENT_SOURCE_SHA256") variant=3 ;;
      "$STOCK_CLIENT_V2_SHA256"|"$CLIENT_V2_SOURCE_SHA256") variant=2 ;;
      "") variant=none ;;
      *)
        # 5x1 changes only rejectUnauthorized: true -> false in an otherwise
        # stock client. Reverse that edit in memory and compare with the two
        # reviewed stock hashes; never accept an arbitrary unknown module.
        restored_hash="$(rsh "sed 's/rejectUnauthorized: false/rejectUnauthorized: true/g' '$handler' | sha256sum" 2>/dev/null | awk '{print $1}')"
        case "$restored_hash" in
          "$STOCK_CLIENT_V3_SHA256") variant=3; repaired=1 ;;
          "$STOCK_CLIENT_V2_SHA256") variant=2; repaired=1 ;;
          *) die "unrecognized HTTP client at ${handler} (sha256 ${handler_hash:0:16}…); nothing was changed" ;;
        esac ;;
    esac
    PRESENT+=("$p")
    HANDLER_VARIANT+=("$variant")
    com="$(rsh "grep -c 'jibo\.com' '$p' 2>/dev/null" 2>/dev/null | tr -d '\r')"
    case "$variant" in 2) label="2.x client" ;; 3) label="3.x client" ;; *) label="no HTTP handler" ;; esac
    [ "$repaired" -eq 0 ] || label="${label}; third-party TLS bypass will be repaired"
    say "  present  ${p}  (jibo.com lines: ${com:-?}; ${label})"
  fi
done
[ "${#PRESENT[@]}" -gt 0 ] || die "no client region_config.json found on the robot"

# ── 3. Trust: is the public root already installed? ──────────────────────────
step "Public root trust"
ROOT_SUBJECT="C=US, O=Internet Security Research Group, CN=ISRG Root X1"
ROOT_SHA="22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1"
HAVE_ROOT=0
# Detect by the certificate's own base64 body, NOT by its subject name: a PEM
# bundle stores DER in base64, so the human-readable subject "ISRG Root X1" does
# not appear in the file at all and grepping for it always reports absent. The
# first line of the encoded body is a stable, unambiguous fingerprint of this
# exact certificate.
ROOT_MARKER='MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw'
if rsh "grep -q '$ROOT_MARKER' '$TRUST_BUNDLE' 2>/dev/null" >/dev/null 2>&1; then
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

# Stock 13.0.0 images can ship a 300 MB ext4 filesystem on a much larger
# /opt partition. The native update manager refuses a download unless /opt has
# at least 2.5 times the package length free; the first OS package alone needs
# about 600 MB. Check before OOBE or a script-triggered OTA so an undersized
# USB-flashed /opt cannot cause either path to loop without downloading.
OPT_MIN_FREE_KIB=2097152
OPT_RESIZE=0
if { [ "$OOBE" -eq 1 ] || [ "$START_OTA" -eq 1 ]; } && [ "$REVERT" -eq 0 ]; then
  OPT_MOUNT="$(rsh "mount | sed -n 's|^\([^ ]*\) on /opt type \([^ ]*\) .*|\1 \2|p' | head -1" 2>/dev/null | tr -d '\r')"
  read -r OPT_DEVICE OPT_FSTYPE <<< "$OPT_MOUNT"
  OPT_DF="$(rsh "df -k /opt | awk 'NR==2 {print \$2, \$4}'" 2>/dev/null | tr -d '\r')"
  read -r OPT_TOTAL_KIB OPT_FREE_KIB <<< "$OPT_DF"
  [[ "$OPT_TOTAL_KIB" =~ ^[0-9]+$ && "$OPT_FREE_KIB" =~ ^[0-9]+$ ]] || die "could not check /opt capacity"
  say "  /opt: ${OPT_TOTAL_KIB} KiB total, ${OPT_FREE_KIB} KiB free (${OPT_DEVICE:-unknown}, ${OPT_FSTYPE:-unknown})"
  if [ "$OPT_FREE_KIB" -lt "$OPT_MIN_FREE_KIB" ]; then
    [[ "$OPT_DEVICE" =~ ^/dev/mmcblk[0-9]+p[0-9]+$ && "$OPT_FSTYPE" = ext4 ]] \
      || die "/opt needs at least 2 GiB free for OTA; inspect this nonstandard mount before continuing"
    OPT_DEVICE_BYTES="$(rsh "blockdev --getsize64 '$OPT_DEVICE'" 2>/dev/null | tr -d '\r')"
    [[ "$OPT_DEVICE_BYTES" =~ ^[0-9]+$ ]] || die "could not measure /opt block device"
    if [ "$OPT_DEVICE_BYTES" -le "$((OPT_TOTAL_KIB * 1024 + 104857600))" ]; then
      die "/opt has too little free space and its block device has no room to grow; free space before OTA"
    fi
    rsh 'command -v resize2fs' >/dev/null 2>&1 || die "resize2fs is unavailable on the robot; expand /opt manually before OTA"
    OPT_RESIZE=1
    say "  /opt filesystem is smaller than its ${OPT_DEVICE_BYTES}-byte partition; it must be expanded"
  fi
fi

# ── 5. Revert ───────────────────────────────────────────────────────────────
if [ "$REVERT" -eq 1 ]; then
  step "Reverting the OTA repoint"
  say "  backups are kept beside each file as <file>.prerepoint-<stamp>.bak"
  n=0
  for p in "${PRESENT[@]}"; do
    rsh "ls '$p'.prerepoint-*.bak >/dev/null 2>&1 && { cp -a \$(ls -tr '$p'.prerepoint-*.bak | head -1) '$p'; echo '  restored '$p; }" 2>/dev/null || true
    n=$((n+1))
  done
  say "  restored up to ${n} endpoint config file(s); client/CA/hub patches remain in place"
  say "  (removing ISRG X1 is safe but rarely wanted: other names may rely on it)"
  exit 0
fi

# ── 6. Plan ─────────────────────────────────────────────────────────────────
step "Plan"
if [ "$OPT_RESIZE" -eq 1 ]; then
  say "  0. expand /opt ext4 in place on ${OPT_DEVICE} and verify at least 2 GiB free"
  say "     (filesystem growth is persistent and is not undone by --revert)"
fi
say "  1. back up and normalize ${#PRESENT[@]} client config file(s) to ${PUBLIC_SUFFIX},"
say "     including third-party endpoints and credential-level overrides (keys preserved)"
say "  2. install the public root into ${TRUST_BUNDLE} (+ ${TRUST_DIR}/isrg-root-x1.pem and its"
say "     subject-hash symlink), remounting / read-write for the write and back to read-only after"
say "  3. install the CA-accepting client (2.x or 3.x build, matching each copy) + its CA into"
say "     every client copy (this Node ignores the system trust store, so only this lets it verify TLS)"
say "  4. link /etc/ssl/cert.pem -> ${TRUST_BUNDLE} (OpenSSL's default CAfile, which the"
say "     stock image never shipped; without it the NATIVE hub client verifies nothing)"
if [ "$HAS_BACKUP_HELPERS" -eq 1 ]; then
  say "  5. patch system-manager backup and restore with that maintained public CA bundle"
  say "     (the stock Node helpers bypass the patched server client)"
else
  say "  5. (no system backup/restore helpers on this firmware; nothing to patch)"
fi
if [ "$HAS_JETSTREAM" -eq 1 ]; then
  say "  6. point the jetstream hub override at ${HUB_HOST}:443, so audio"
  say "     turns go to this server instead of wherever it was pointed before"
  say "     (and the notification socket at <region>-socket.${PUBLIC_SUFFIX} where the server service names one)"
else
  say "  6. (no jetstream hub config on this firmware; its audio path uses the client configs in step 1)"
fi
say "  7. ensure /var/jibo/keys exists as a private directory (mode 0700; preserve existing keys),"
say "     and point jibo-ssm's Wi-Fi server check at ${PUBLIC_SUFFIX} where it still names the old cloud;"
say "     the setup screens say \"Go to ${PUBLIC_SUFFIX}\" instead of sending people to the Jibo app"
if [ "$OOBE" -eq 1 ]; then
  say "  8. leave this unprovisioned robot unregistered; QR setup will create and link it later"
elif [ -n "$CLAIM_CODE" ]; then
  say "  8. prove possession with the robot's existing credentials and link it to the signed-in Phoenix account"
else
  say "  8. verify/register the robot's existing credentials without changing account ownership"
fi
say "  9. write a receipt to ${RECEIPT}"
if [ "$START_OTA" -eq 1 ]; then
  say "  10. temporarily report 0.0.1 only to OTA discovery, then download and install"
  say "      all four current OS, services, OOBE and BE packages (reboots)"
elif [ "$OOBE" -eq 1 ] && [ "$REBOOT" -eq 1 ]; then
  say "  10. reboot the robot into its setup screen once everything above has succeeded"
fi
say ""
if [ "$OOBE" -eq 1 ]; then
  say "  The robot's next boot will be set to OOBE. QR pairing creates credentials,"
  say "  then the stock OOBE flow starts the OTA. OTA cannot run before credentials exist."
else
  say "  Existing credentials are preserved."
  if [ "$AUTO" -eq 1 ] && [ -z "$CLAIM_CODE" ]; then
    say "  Without a claim code, OTA and boot-mode changes are deferred so SSH stays available."
  elif [ "$START_OTA" -eq 1 ]; then
    say "  A full OTA refresh replaces all four published subsystems, even at the same version."
    say "  The OTA query override is removed before installation; the actual installed"
    say "  versions stay truthful until their packages are replaced."
    say "  The saved next-boot mode changes only after OTA downloads verify."
  else
    say "  If BE is installed, the saved next-boot mode becomes normal."
    say "  Without BE, mode changes only after verified OTA downloads."
  fi
fi
say "  NOT touched: /etc/hosts, any private CA, server certs, existing robot keys."
say "  After this the robot can reach ${REST_URL}, stream audio to the hub, and take an OTA"
say "  update from it. A reboot is needed for the native services to reload their config."

# Do this after the plan is printed: downloaded public scripts must be complete
# before they touch a robot, and the digest check makes a broken publication a
# clean failure rather than a half-repointed machine.
ensure_support_assets
if [ "$START_OTA" -eq 1 ]; then ensure_ota_trigger; fi

# Stage one reviewed Node 4-compatible config normalizer for both preflight and
# apply. The public standalone script fetches this support file by SHA-256.
CONFIG_PATCHER_REMOTE="$(rsh 'mktemp /tmp/phoenix-cloud-config.XXXXXX' 2>/dev/null | tr -d '\r')"
[[ "$CONFIG_PATCHER_REMOTE" =~ ^/tmp/phoenix-cloud-config\.[A-Za-z0-9]+$ ]] \
  || die "could not allocate a safe remote config helper path"
rput "$CONFIG_PATCHER" "$CONFIG_PATCHER_REMOTE" || die "could not upload the cloud config helper"

cloud_config() {
  local kind="$1" file="$2" action="$3" out=""
  local stamp_arg=""
  [ "$action" = apply ] && stamp_arg="--stamp '$STAMP'"
  [ "$action" = dry-run ] && stamp_arg="--dry-run"
  out="$(rsh "node '$CONFIG_PATCHER_REMOTE' --kind '$kind' --file '$file' --region '$REGION' --suffix '$PUBLIC_SUFFIX' $stamp_arg" 2>&1 | tr -d '\r')" \
    || { printf 'could not normalize %s at %s: %s\n' "$kind" "$file" "$out" >&2; return 1; }
  printf '%s\n' "$out"
}

# Compatibility check: run both hash-guarded patchers in --dry-run against this
# robot's own files. An unreviewed firmware version stops here, before a single
# file has changed, instead of halfway through the apply below.
step "Compatibility check"
for p in "${PRESENT[@]}"; do
  out="$(cloud_config region-config "$p" dry-run)" || die "client config compatibility check failed"
  say "  cloud config ${p}: ${out}"
done
if [ "$HAS_CREDS" -eq 1 ]; then
  out="$(cloud_config credentials /var/jibo/credentials.json dry-run)" || die "credential endpoint compatibility check failed"
  say "  robot credential endpoint (keys hidden): ${out}"
fi
out="$(cloud_config notification /usr/local/etc/jibo-server-service.json dry-run)" || die "notification socket compatibility check failed"
say "  notification socket suffix: ${out}"
preflight_patcher() {
  local label="$1" source="$2"; shift 2
  local remote out
  remote="$(rsh 'mktemp /tmp/phoenix-preflight.XXXXXX' 2>/dev/null | tr -d '\r')"
  [[ "$remote" =~ ^/tmp/phoenix-preflight\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote preflight path"
  rput "$source" "$remote" || die "could not upload the ${label} check"
  out="$(rsh "node '$remote' --dry-run $*; status=\$?; rm -f '$remote'; exit \$status" 2>&1 | tr -d '\r')" \
    || die "this firmware's ${label} is not a reviewed version, so nothing was changed: ${out}"
  case "$out" in
    patched) out="reviewed stock version; ready to patch" ;;
    already-patched) out="already patched" ;;
    upgraded) out="carries an earlier patch; will be upgraded from its saved original" ;;
    mode-repaired) out="already patched; its executable mode will be restored" ;;
    *jibo-system-*)
      # One "<helper>: original|patched" line per helper.
      out="$(printf '%s\n' "$out" | sed -e 's/: original$/: reviewed stock version/' -e 's/: patched$/: already patched/' | paste -sd ';' - | sed 's/;/; /g')" ;;
  esac
  say "  ${label}: ${out}"
}
preflight_patcher "OTA downloader" "$OTA_TLS_PATCHER"
preflight_patcher "Wi-Fi server check" "$SSM_WIFI_PATCHER" --suffix "$PUBLIC_SUFFIX"
if [ "$HAS_BACKUP_HELPERS" -eq 1 ]; then
  preflight_patcher "backup/restore helpers" "$BACKUP_TLS_PATCHER" \
    --root /usr/local/bin --receipt /var/lib/phoenix/jibo-system-backup-tls.json
fi
# The setup screen's wording is cosmetic: an unreviewed skill keeps its stock
# screens instead of stopping the repoint.
SETUP_TEXT=0
setup_text_remote="$(rsh 'mktemp /tmp/phoenix-preflight.XXXXXX' 2>/dev/null | tr -d '\r')"
[[ "$setup_text_remote" =~ ^/tmp/phoenix-preflight\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote preflight path"
rput "$SETUP_TEXT_PATCHER" "$setup_text_remote" || die "could not upload the setup screen check"
if setup_text_out="$(rsh "node '$setup_text_remote' --dry-run --suffix '${PUBLIC_SUFFIX}'; status=\$?; rm -f '$setup_text_remote'; exit \$status" 2>&1 | tr -d '\r')"; then
  case "$setup_text_out" in
    patched) SETUP_TEXT=1; say "  setup screen text: reviewed stock version; will say \"Go to ${PUBLIC_SUFFIX}\"" ;;
    *) say "  setup screen text: ${setup_text_out/already-patched/already patched}" ;;
  esac
else
  say "  setup screen text: left as it is (${setup_text_out#patch-oobe-setup-text: })"
fi

if [ "$DRY" -eq 1 ]; then
  say ""
  say "dry run — nothing was changed, and nothing will be. Re-run with --yes to apply."
  exit 0
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  say ""
  if [ "$START_OTA" -eq 1 ]; then
    printf 'Apply this to %s, then install the native OTA updates and reboot? [y/N] ' "$ROBOT"
  else
    printf 'Apply this to %s? [y/N] ' "$ROBOT"
  fi
  read -r reply </dev/tty || reply=n
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

if [ "$OPT_RESIZE" -eq 1 ]; then
  rsh "resize2fs '$OPT_DEVICE' >/dev/null && sync" || die "could not expand /opt filesystem"
  OPT_FREE_KIB="$(rsh "df -k /opt | awk 'NR==2 {print \$4}'" 2>/dev/null | tr -d '\r')"
  [[ "$OPT_FREE_KIB" =~ ^[0-9]+$ ]] && [ "$OPT_FREE_KIB" -ge "$OPT_MIN_FREE_KIB" ] \
    || die "/opt still has less than 2 GiB free after resize; stopping before repoint"
  say "  /opt expanded; ${OPT_FREE_KIB} KiB free"
fi

ORIG_ROOT_MOUNT="$(rsh 'mount | sed -n "/ on \/ /p" | head -1' 2>/dev/null | tr -d '\r')"
ORIG_LOCAL_MOUNT="$(rsh 'mount | sed -n "/ on \/usr\/local /p" | head -1' 2>/dev/null | tr -d '\r')"
ROOT_WAS_RO=0
LOCAL_WAS_RO=0
case "$ORIG_ROOT_MOUNT" in *"ro,"*|*"ro)"*) ROOT_WAS_RO=1 ;; esac
case "$ORIG_LOCAL_MOUNT" in *"ro,"*|*"ro)"*) LOCAL_WAS_RO=1 ;; esac

restore_root_ro() {
  [ "$ROOT_WAS_RO" -eq 1 ] || return 0
  rsh 'mount -o remount,ro / 2>/dev/null || true' >/dev/null 2>&1 || true
}
restore_local_ro() {
  [ "$LOCAL_WAS_RO" -eq 1 ] || return 0
  rsh 'mount -o remount,ro /usr/local 2>/dev/null || true' >/dev/null 2>&1 || true
}
trap 'restore_local_ro; restore_root_ro; cleanup_support' EXIT

if [ "$ROOT_WAS_RO" -eq 1 ]; then
  say "  remounting / read-write (it was read-only)"
  rsh 'mount -o remount,rw /' >/dev/null 2>&1 || die "could not remount / read-write"
fi
if [ "$LOCAL_WAS_RO" -eq 1 ]; then
  say "  remounting /usr/local read-write (it was read-only)"
  rsh 'mount -o remount,rw /usr/local' >/dev/null 2>&1 || die "could not remount /usr/local read-write"
fi

# 7a. STS creates its pair/loop key below this directory. A missing directory
# makes a correctly repointed robot fail its first cloud bootstrap/backup, so
# make the prerequisite explicit and idempotent. Refuse a symlink or non-
# directory instead of allowing a path redirect into another tree.
rsh 'set -eu
  if [ -L /var/jibo/keys ] || { [ -e /var/jibo/keys ] && [ ! -d /var/jibo/keys ]; }; then
    echo "refusing unsafe /var/jibo/keys (must be a real directory)" >&2
    exit 1
  fi
  umask 077
  mkdir -p -m 700 /var/jibo/keys
  chmod 700 /var/jibo/keys
  [ -d /var/jibo/keys ] && [ ! -L /var/jibo/keys ]
' >/dev/null 2>&1 || die "could not prepare /var/jibo/keys as a private directory"
say "  /var/jibo/keys ready (mode 0700; existing key material preserved)"

# 7b. Normalize all robot-facing cloud routes, not just the stock jibo.com
# spelling. A third-party rule can otherwise outrank the wildcard region
# pattern and keep a repointed robot talking to its former server.
for p in "${PRESENT[@]}"; do
  out="$(cloud_config region-config "$p" apply)" || die "failed to normalize $p"
  say "  ${p}: ${out}"
  rsh "chmod a+rX '$(dirname "$p")'" >/dev/null 2>&1 || true
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
if [ -r "$CLIENT_SOURCE" ] && [ -r "$CLIENT_V2_SOURCE" ]; then
  # "<http dir>:<2|3>" per copy, from the handler recognized during discovery.
  CLIENT_HTTP_TARGETS=""
  for i in "${!PRESENT[@]}"; do
    [ "${HANDLER_VARIANT[$i]}" = none ] && continue
    CLIENT_HTTP_TARGETS="${CLIENT_HTTP_TARGETS} ${PRESENT[$i]%/region_config.json}/http:${HANDLER_VARIANT[$i]}"
  done
  out="$(rsh "
    set -e
    changed=0
    for t in ${CLIENT_HTTP_TARGETS}; do
      d=\"\${t%:*}\"
      [ -f \"\$d/node.js\" ] || continue
      [ -f \"\$d/node.js.prerepoint-${STAMP}.bak\" ] || cp -a \"\$d/node.js\" \"\$d/node.js.prerepoint-${STAMP}.bak\"
      printf '  client at %s -> CA-accepting build (%s.x)\n' \"\$d\" \"\${t##*:}\"
      changed=\$((changed+1))
    done
    echo \"  copies to update: \$changed\"
  " 2>&1 | tr -d '\r')" || die "failed to back up a client module: $out"
  printf '%s\n' "$out"
  # Ship both builds and the CA, then place the matching build in every copy.
  rsh "mkdir -p /tmp/robot-client" >/dev/null 2>&1 || die "could not prepare robot staging directory"
  rput "$CLIENT_SOURCE" /tmp/robot-client/node-v3.js || die "could not upload the client module"
  rput "$CLIENT_V2_SOURCE" /tmp/robot-client/node-v2.js || die "could not upload the 2.x client module"
  CA_SOURCE="${ROOT_PEM_SRC:-}"
  if [ -n "$CA_SOURCE" ] && [ -r "$CA_SOURCE" ]; then
    rput "$CA_SOURCE" /tmp/robot-client/phoenix-ca.pem || die "could not upload the CA"
  else
    say "  no CA file available to ship; the client will fall back to its built-in roots"
  fi
  out="$(rsh "
    set -e
    n=0
    for t in ${CLIENT_HTTP_TARGETS}; do
      d=\"\${t%:*}\"
      [ -d \"\$d\" ] || continue
      cp -f \"/tmp/robot-client/node-v\${t##*:}.js\" \"\$d/node.js\"
      chmod 644 \"\$d/node.js\"
      if [ -f /tmp/robot-client/phoenix-ca.pem ]; then
        cp -f /tmp/robot-client/phoenix-ca.pem \"\$d/phoenix-ca.pem\"
        chmod 644 \"\$d/phoenix-ca.pem\"
      fi
      n=\$((n+1))
    done
    rm -rf /tmp/robot-client
    printf '  installed the CA-accepting client + CA into %s copies\n' \"\$n\"
  " 2>&1 | tr -d '\r')" || die "failed to install a client module: $out"
  printf '%s\n' "$out"
  APPLIED+=("${CLIENT_DIRS_NOTE:-client node.js + phoenix-ca.pem (all copies)}")
else
  die "the CA-accepting client support file is unavailable"
fi

# 7c. Trust root.
# openssl does NOT exist on the robot, so the subject-hash symlink name is computed
# here, from the certificate, and shipped with the file.
if [ "$HAVE_ROOT" -eq 0 ]; then
  if [ ! -f "$ROOT_PEM_SRC" ]; then
    say "  no ISRG Root X1 available locally (pass --region-ca <pem>); trust step SKIPPED."
  else
    HASH="$(openssl x509 -in "$ROOT_PEM_SRC" -noout -subject_hash_old 2>/dev/null | tr -d '\r')"
    [ -n "$HASH" ] || die "could not compute the subject hash from $ROOT_PEM_SRC"
    TMP_REMOTE="/tmp/.phoenix-isrg-root-${STAMP}-$$.pem"
    rput "$ROOT_PEM_SRC" "$TMP_REMOTE" || die "could not upload the root certificate"
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
    " 2>&1 | tr -d '\r')" || die "failed to install the public root: $out"
    printf '%s\n' "$out"
    APPLIED+=("${TRUST_BUNDLE}")
  fi
fi

# 7c-bis. OpenSSL's DEFAULT CAfile.
#
# This is deliberately OUTSIDE the `HAVE_ROOT` guard above: a robot can already
# carry ISRG Root X1 in its bundle and STILL fail every verification, which is
# exactly the state that made a fully repointed robot look like a dead server.
#
# OpenSSL resolves its default trust material from OPENSSLDIR, compiled in as
# /etc/ssl -- so the default CAfile is /etc/ssl/cert.pem. The Jibo image never
# shipped that file. The consequence is subtle and easy to misread: anything
# handed an EXPLICIT ca succeeds (the Node client with phoenix-ca.pem, wget
# --ca-certificate=...), while anything relying on the DEFAULT store has no roots
# at all and fails with "certificate verify failed". The native Poco client in
# jibo-jetstream-service -- the one that streams every audio turn to the hub --
# is in the second group, so without this the robot connects to Classic happily
# and cannot open a single hub socket:
#
#   CloudConnection::open (poco exception): SSL Exception:
#   error:14090086:SSL routines:ssl3_get_server_certificate:certificate verify failed
#
# Point the default at the bundle, which by now carries the public root.
out="$(rsh "
  if [ -e '/etc/ssl/cert.pem' ] && [ ! -L '/etc/ssl/cert.pem' ]; then
    printf '  /etc/ssl/cert.pem exists and is a real file; left alone\n'
  else
    ln -sf '$TRUST_BUNDLE' '/etc/ssl/cert.pem'
    printf '  /etc/ssl/cert.pem -> %s (OpenSSL default CAfile)\n' \"\$(readlink /etc/ssl/cert.pem)\"
  fi
" 2>&1 | tr -d '\r')" || die "could not configure the default CA file: $out"
printf '%s\n' "$out"
APPLIED+=("/etc/ssl/cert.pem")

# 7c-ter. The rootfs OTA downloader is a separate direct executable. Node 6 does
# not load the system store for this raw https request, and SystemManager execs
# the helper rather than invoking node itself, so preserve 0755 as well as
# supplying the explicit CA. This makes the first OTA after repoint reliable.
[ -r "$OTA_TLS_PATCHER" ] || die "the OTA downloader TLS support file is unavailable"
OTA_TLS_REMOTE="$(rsh 'mktemp /tmp/phoenix-ota-downloader-tls.XXXXXX' 2>/dev/null | tr -d '\r')"
[[ "$OTA_TLS_REMOTE" =~ ^/tmp/phoenix-ota-downloader-tls\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote OTA downloader patch path"
rput "$OTA_TLS_PATCHER" "$OTA_TLS_REMOTE" || die "could not upload the reviewed OTA downloader TLS patcher"
out="$(rsh "
  set -eu
  PATCH='$OTA_TLS_REMOTE'
  cleanup() {
    status=\$?
    trap - EXIT HUP INT TERM
    rm -f \"\$PATCH\"
    exit \$status
  }
  trap cleanup EXIT HUP INT TERM
  node \"\$PATCH\" --json
" 2>&1 | tr -d '\r')" || die "could not apply the hash-guarded OTA downloader TLS patch"
printf '%s\n' "$out"
APPLIED+=("/usr/bin/jibo-download-update explicit public CA + mode 0755")

# 7c-ter-bis. The Wi-Fi server check. When Jibo joins a network (during setup
# too) jibo-ssm confirms it can reach "Jibo's servers". On the factory RTM2/RTM3
# images that check targets <region>.jibo.com, which the region configs above do
# not cover, over Node 4's built-in roots, which cannot verify this server. Setup
# then stops at "Can't connect to Jibo's server" (error 4) before it ever asks
# for credentials. Later firmware checks google.com and is left alone.
SSM_WIFI_REMOTE="$(rsh 'mktemp /tmp/phoenix-ssm-wifi-check.XXXXXX' 2>/dev/null | tr -d '\r')"
[[ "$SSM_WIFI_REMOTE" =~ ^/tmp/phoenix-ssm-wifi-check\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote Wi-Fi check patch path"
rput "$SSM_WIFI_PATCHER" "$SSM_WIFI_REMOTE" || die "could not upload the Wi-Fi server check patcher"
out="$(rsh "
  set -eu
  PATCH='$SSM_WIFI_REMOTE'
  cleanup() {
    status=\$?
    trap - EXIT HUP INT TERM
    rm -f \"\$PATCH\"
    [ ${LOCAL_WAS_RO} -eq 0 ] || mount -o remount,ro /usr/local 2>/dev/null || true
    exit \$status
  }
  trap cleanup EXIT HUP INT TERM
  mount -o remount,rw /usr/local
  node \"\$PATCH\" --suffix '${PUBLIC_SUFFIX}'
" 2>&1 | tr -d '\r')" || die "could not apply the Wi-Fi server check patch: $out"
say "  Wi-Fi server check: ${out}"
case "$out" in patched|already-patched) APPLIED+=("jibo-ssm Wi-Fi server check -> ${PUBLIC_SUFFIX}") ;; esac

# 7c-ter-ter. The setup skill's first screen says "Go to the Jibo app on your
# phone to get started", and its error screens send people to the same app.
# Point them at this server instead (skills live on /opt, which is writable).
if [ "$SETUP_TEXT" -eq 1 ]; then
  SETUP_TEXT_REMOTE="$(rsh 'mktemp /tmp/phoenix-oobe-setup-text.XXXXXX' 2>/dev/null | tr -d '\r')"
  [[ "$SETUP_TEXT_REMOTE" =~ ^/tmp/phoenix-oobe-setup-text\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote setup screen patch path"
  rput "$SETUP_TEXT_PATCHER" "$SETUP_TEXT_REMOTE" || die "could not upload the setup screen patcher"
  out="$(rsh "node '$SETUP_TEXT_REMOTE' --suffix '${PUBLIC_SUFFIX}'; status=\$?; rm -f '$SETUP_TEXT_REMOTE'; exit \$status" 2>&1 | tr -d '\r')" \
    || die "could not apply the setup screen text: $out"
  say "  setup screen text: ${out}"
  APPLIED+=("setup screens say \"Go to ${PUBLIC_SUFFIX}\" instead of naming the Jibo app")
fi

# 7c-quater. System-manager backup/restore. The established public CA bundle has
# just been installed above. These are separate Node 6 scripts, not consumers of
# @jibo/jibo-server-client, so the client patch does not make their raw upload
# (`request`) or download (`https`) paths trust the modern chain. The support
# patcher pins the exact upstream sources and preserves rollback copies.
[ -r "$BACKUP_TLS_PATCHER" ] || die "the system backup TLS support file is unavailable"
# Factory RTM2/RTM3 images (platform 3.x) have no backup/restore helpers at all.
if [ "$HAS_BACKUP_HELPERS" -eq 0 ]; then
  say "  no system backup/restore helpers on this firmware; nothing to patch"
else
BACKUP_TLS_REMOTE="$(rsh 'mktemp /tmp/phoenix-system-backup-tls.XXXXXX' 2>/dev/null | tr -d '\r')"
[[ "$BACKUP_TLS_REMOTE" =~ ^/tmp/phoenix-system-backup-tls\.[A-Za-z0-9]+$ ]] || die "could not allocate a safe remote backup TLS patch path"
rput "$BACKUP_TLS_PATCHER" "$BACKUP_TLS_REMOTE" || die "could not upload the reviewed system backup TLS patcher"
out="$(rsh "
  set -eu
  PATCH='$BACKUP_TLS_REMOTE'
  cleanup() {
    status=\$?
    trap - EXIT HUP INT TERM
    rm -f \"\$PATCH\"
    [ ${LOCAL_WAS_RO} -eq 0 ] || mount -o remount,ro /usr/local 2>/dev/null || true
    exit \$status
  }
  trap cleanup EXIT HUP INT TERM
  if ! jibo-mount --rw >/dev/null 2>&1; then
    mount -o remount,rw /usr/local
  fi
  node \"\$PATCH\" --root /usr/local/bin --receipt /var/lib/phoenix/jibo-system-backup-tls.json --json
" 2>&1 | tr -d '\r')" || die "could not apply the hash-guarded system backup/restore TLS patch"
printf '%s\n' "$out"
APPLIED+=("/usr/local/bin/jibo-system-{backup,restore} explicit public CA")
fi

# 7c-quater. The hub.
#
# The audio path is configured SEPARATELY from the Classic path, in
# /usr/local/etc/jibo-jetstream-service.json, and `HubClient.override` WINS over
# `HubClient.region-settings`. A robot that was previously pointed at a LAN
# Phoenix carries that server's address here and will keep streaming every turn
# to it no matter how correct the rest of the repoint is -- the public hub log
# stays empty while the robot answers "the hub reported an error" out loud.
#
# NOTE /usr/local is its OWN partition, and remounting / rw does not make it
# writable. There is also no python3 on the robot: use its node binary.
# The hub hostname is NOT "<region>-hub": the region is `stg-entrypoint` while its
# hub is `stg-hub`, i.e. the "-entrypoint" suffix is dropped. The `api` region is
# the odd one out and uses `neo-hub`. These names come from
# HubClient.region-settings in the stock jibo-jetstream-service.json.
out="$(rsh "
  set -e
  F=/usr/local/etc/jibo-jetstream-service.json
  [ -f \"\$F\" ] || { printf '  no jetstream config; hub left alone\n'; exit 0; }
  mount -o remount,rw /usr/local
  [ -f \"\$F.prerepoint-${STAMP}.bak\" ] || cp -a \"\$F\" \"\$F.prerepoint-${STAMP}.bak\"
  node -e \"
    var fs=require('fs'), p='\$F';
    var d=JSON.parse(fs.readFileSync(p,'utf8'));
    var hc=d.HubClient||{}, rs=hc['region-settings']||{};
    Object.keys(rs).forEach(function(n){
      ['hub_hostname','entrypoint_hostname'].forEach(function(k){
        if (rs[n][k]) rs[n][k]=String(rs[n][k]).replace(/\\\\.jibo\\\\.com\$/, '.${PUBLIC_SUFFIX}');
      });
      rs[n].hub_port=443;
    });
    hc.override={hub_port:443,hub_hostname:'${HUB_HOST}',entrypoint_hostname:'${REGION}.${PUBLIC_SUFFIX}'};
    d.HubClient=hc;
    fs.writeFileSync(p, JSON.stringify(d,null,2));
  \"
  chmod 644 \"\$F\"
  [ ${LOCAL_WAS_RO} -eq 0 ] || mount -o remount,ro /usr/local
  printf '  hub -> %s:443 (jetstream override)\n' '${HUB_HOST}'
" 2>&1 | tr -d '\r')" || die "could not configure the jetstream hub: $out"
printf '%s\n' "$out"
[ "$HAS_JETSTREAM" -eq 0 ] || APPLIED+=("/usr/local/etc/jibo-jetstream-service.json")

# 7c-quinquies. The notification socket may have an old-cloud OR a third-party
# suffix. On older firmware the key is absent and the client configs above win.
# The hub step restores /usr/local to its original read-only state. Remount it
# for this separate write too; otherwise a present notification config fails
# here after the rest of the robot has already been repointed.
if [ "$LOCAL_WAS_RO" -eq 1 ]; then
  rsh 'mount -o remount,rw /usr/local' >/dev/null 2>&1 \
    || die "could not remount /usr/local read-write for the notification socket"
fi
out="$(cloud_config notification /usr/local/etc/jibo-server-service.json apply)" \
  || die "could not point the notification socket at ${PUBLIC_SUFFIX}"
say "  notification socket suffix: ${out}"
[ "$out" = not-needed ] || APPLIED+=("/usr/local/etc/jibo-server-service.json notification socket")
restore_local_ro

# 7c-sexies. Credential-level endpoint overrides outrank region_config.json.
# Keep the access/secret keys and every unrelated field unchanged; the helper
# makes the backup private and only updates routing/region/TLS options.
if [ "$HAS_CREDS" -eq 1 ]; then
  out="$(cloud_config credentials /var/jibo/credentials.json apply)" \
    || die "could not replace the credential endpoint override"
  say "  credential endpoint: ${out} (keys preserved and never printed)"
  APPLIED+=("/var/jibo/credentials.json routing")
fi

# 7c-quater. Adoption.
#
# A robot that paired with the original cloud years ago still signs every request
# with the credentials in /var/jibo/credentials.json. Those cannot be reissued
# without a factory reset, so a server that has never heard of them rejects the
# robot even though everything above is correct. Hand them to the server's
# adoption endpoint, which is idempotent: re-running this reports the existing
# ids rather than forking the household.
if [ "$OOBE" -eq 1 ]; then
  say "  OOBE: no credentials were read or registered; QR setup will create and link them."
else
  # Adoption is an Account API route on the apex site, not a Classic API route
  # on the robot's region entrypoint.  The region host intentionally returns
  # 404 for /api/adopt-robot even while OTA and other robot calls work there.
  ADOPT_URL="https://${PUBLIC_SUFFIX}/api/adopt-robot"
  CREDS="$(rsh 'cat /var/jibo/credentials.json 2>/dev/null' 2>/dev/null | tr -d '\r')"
  FRIENDLY="$(rsh 'hostname 2>/dev/null' 2>/dev/null | tr -d '\r')"
  AKID="$(printf '%s' "$CREDS" | sed -n 's/.*"accessKeyId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  ASEC="$(printf '%s' "$CREDS" | sed -n 's/.*"secretAccessKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$AKID" ] && [ -n "$ASEC" ] || die "robot credentials are incomplete; no account adoption was attempted"
  # The secret is passed on stdin, never on a command line or in the log.
  if [ -n "$CLAIM_CODE" ]; then
    ADOPT_BODY="$(printf '{"accessKeyId":"%s","secretAccessKey":"%s","friendlyId":"%s","claimCode":"%s"}' "$AKID" "$ASEC" "$FRIENDLY" "$CLAIM_CODE")"
  else
    ADOPT_BODY="$(printf '{"accessKeyId":"%s","secretAccessKey":"%s","friendlyId":"%s"}' "$AKID" "$ASEC" "$FRIENDLY")"
  fi
  ADOPT_OUT="$(printf '%s' "$ADOPT_BODY" | curl -sS --max-time 30 -X POST "$ADOPT_URL" \
      -H 'content-type: application/json' -H 'x-phoenix-api-client: robot-ota-repoint' --data-binary @- 2>&1)" || true
  case "$ADOPT_OUT" in
    *'"adopted":true'*)
      if [ -n "$CLAIM_CODE" ]; then
        case "$ADOPT_OUT" in
          *'"linked":true'*|*'"alreadyLinked":true'*) say "  adoption: robot claimed for the signed-in Phoenix account" ;;
          *) die "robot identity registered, but account claim did not complete; get a fresh portal code and re-run this command" ;;
        esac
      else
        case "$ADOPT_OUT" in
          *'"alreadyAdopted":true'*) say "  adoption: already known to the server (no change)" ;;
          *) say "  adoption: registered as an unclaimed bootstrap" ;;
        esac
      fi
      APPLIED+=("server adoption for ${AKID}")
      ;;
    *)
      say "  adoption did NOT succeed against ${ADOPT_URL}"
      say "    server said: $(printf '%s' "$ADOPT_OUT" | head -c 200)"
      die "robot adoption/account linking failed; get a fresh portal code if the previous one expired, then re-run this command"
      ;;
  esac
fi

# An SSH mod often boots a still-unprovisioned robot in int-developer mode.
# Set its *next boot* to the real setup mode only after the repoint is complete.
if [ "$OOBE" -eq 1 ]; then
  rsh 'jibo-setmode oobe' >/dev/null 2>&1 || die "could not set the next boot to OOBE"
  if [ "$REBOOT" -eq 1 ]; then say "  next boot mode set to OOBE (Jibo restarts once the remaining steps succeed)"
  else say "  next boot mode set to OOBE (no reboot was triggered)"; fi
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
  \"mode\": \"$(if [ "$OOBE" -eq 1 ]; then printf oobe; else printf paired; fi)\",
  \"patched\": \"$(printf '%s ' "${APPLIED[@]}")\",
  \"trust_root\": \"${ROOT_SHA}\",
  \"hosts_intercept\": false,
  \"private_ca\": false
}
JSON
  echo \"  receipt written to ${RECEIPT}\"
" 2>&1 | tr -d '\r' || die "could not write the robot repoint receipt"

# ── 8. Verify ───────────────────────────────────────────────────────────────
step "Verify"
say "  cloud endpoint configuration:"
for p in "${PRESENT[@]}"; do
  out="$(cloud_config region-config "$p" dry-run)" || die "could not verify $p"
  [ "$out" = already-patched ] || die "client config still contains another cloud endpoint: $p"
  say "    Phoenix  ${p}"
done
if [ "$HAS_CREDS" -eq 1 ]; then
  out="$(cloud_config credentials /var/jibo/credentials.json dry-run)" || die "could not verify credential routing"
  [ "$out" = already-patched ] || die "the robot still has a third-party credential endpoint"
  say "    Phoenix  /var/jibo/credentials.json routing (keys hidden)"
fi
out="$(cloud_config notification /usr/local/etc/jibo-server-service.json dry-run)" || die "could not verify notification routing"
[ "$out" = already-patched ] || [ "$out" = not-needed ] || die "the notification socket still targets another cloud"
CLIENT_HASH_V3="$(sha256_of "$CLIENT_SOURCE")"
CLIENT_HASH_V2="$(sha256_of "$CLIENT_V2_SOURCE")"
for i in "${!PRESENT[@]}"; do
  [ "${HANDLER_VARIANT[$i]}" = none ] && continue
  client="${PRESENT[$i]%/lib/region_config.json}/lib/http/node.js"
  expected="$CLIENT_HASH_V3"; [ "${HANDLER_VARIANT[$i]}" = 2 ] && expected="$CLIENT_HASH_V2"
  installed_hash="$(rsh "sha256sum '$client' 2>/dev/null" 2>/dev/null | awk '{print $1}')"
  [ "$installed_hash" = "$expected" ] || die "the CA-accepting client was not installed at $client"
done

if [ "$VERIFY" -eq 1 ]; then
  say "  asking the robot itself to validate TLS to ${REST_URL}:"
  # Stock firmware has curl but no openssl CLI. Do not use -k: a 404 from the
  # Classic front door still proves DNS, TLS chain, and hostname verification.
  out="$(rsh "curl --silent --show-error --max-time 15 --cacert '$TRUST_BUNDLE' -o /dev/null -w '%{http_code}' '$REST_URL'" 2>&1 | tr -d '\r')" \
    || die "the robot could not validate the public server TLS connection: $out"
  say "  validated TLS; HTTP status ${out}"
fi

step "Done"
if [ "$OOBE" -eq 1 ]; then
  rsh 'test "$(jibo-getmode 2>/dev/null)" = oobe && test ! -s /var/jibo/credentials.json' \
    || die "OOBE state changed unexpectedly; do not continue to QR setup yet"
  say "  OOBE mode and absent credentials verified. No account claim was made."
  if [ "$REBOOT" -eq 1 ]; then
    say "  Jibo is restarting now. When he shows his setup screen, use this site's QR"
    say "  setup flow to create and link a fresh robot account."
  else
    say "  Reboot when ready, then use this site's QR setup flow to create and link"
    say "  a fresh robot account."
  fi
  say "  OOBE automatically requests the published OTA after receiving credentials;"
  say "  wait for the update and BE installation to finish."
else
  if [ "$START_OTA" -eq 1 ]; then
    say "  saved boot mode preserved until the OTA downloads verify"
  elif [ "$AUTO" -eq 1 ] && [ -z "$CLAIM_CODE" ]; then
    say "  saved boot mode preserved until an account claim or explicit OTA"
  else
    set_paired_mode_normal_if_ready
  fi
  if [ "$START_OTA" -eq 1 ]; then
    step "Native OTA (BE is not required)"
    run_native_ota
  else
    if [ "$AUTO" -eq 1 ] && [ -z "$CLAIM_CODE" ]; then
      say "  Account ownership was not changed. If not yet linked, sign in and rerun"
      say "  with a one-time --claim-code. If already linked, run --ota-only --yes"
      say "  when ready. OTA was not started, so SSH remains available."
    else
      say "  Next: reboot or let the robot check for the currently published jibo.io OTA"
      say "  packages. If BE is absent after a USB flash, run this script again with"
      say "  --ota-only --yes to install the published updates without entering OOBE."
    fi
  fi
fi
say ""
if [ "$OOBE" -eq 1 ]; then
  say "  Restore endpoint configs only with: $SELF_CMD --robot $ROBOT --oobe --revert"
  # Last, so every step above has succeeded (any failure has already exited).
  # The already-set-up path needs no reboot here: its OTA reboots the robot.
  # Scheduled in the background so this SSH session ends cleanly first.
  if [ "$REBOOT" -eq 1 ]; then
    rsh 'nohup sh -c "sleep 2; sync; reboot" >/dev/null 2>&1 </dev/null &' >/dev/null 2>&1 \
      || say "  WARNING: could not restart Jibo; restart him yourself to reach the setup screen."
  fi
else
  say "  Restore endpoint configs only with: $SELF_CMD --robot $ROBOT --revert"
fi
