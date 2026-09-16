#!/usr/bin/env bash
# onboard-robot.sh — bring a factory (or any) Jibo to a Phoenix OOBE run,
# reproducibly, with ONE shared CA and ONE serving leaf.
#
# The whole risk of this procedure is ORDER: a robot refuses a server whose
# certificate its trust store does not verify, so trust must be installed
# BEFORE the server switches certificates. This tool sequences that:
#
#   1. converge the shared leaf (tls/ca.key signs ONE server.crt covering every
#      region every known robot needs — adding this robot's region to the set,
#      never replacing it),
#   2. back up the robot's /var/jibo and /etc/hosts to a timestamped private
#      directory,
#   3. repoint the robot through scripts/parity-robot/repoint-robot.sh using the
#      SHARED CA with --trust-first (hosts block + real OpenSSL trust store +
#      hash-guarded Node client patch),
#   4. verify what is true NOW (hosts map, CA in the persistent store, patch
#      receipt) and report whether TLS-with-verification already succeeds.
#
# The server switch is deliberately NOT part of a robot onboarding. It is its
# own verb, to be run only once every robot that must keep working (Moth)
# already trusts the shared CA:
#
#   onboard-robot.sh --switch-server        # stage env -> shared leaf, restart,
#                                            # prove the port now serves the leaf
#
# Usage:
#   scripts/parity-robot/onboard-robot.sh --robot <host> [options]
#   scripts/parity-robot/onboard-robot.sh --switch-server [options]
#
# Options:
#   --robot <host>     robot ssh target, e.g. root@aero-....jibo     (required)
#   --phoenix <ip>     Phoenix host IP as seen from the robot (default 192.168.1.182)
#   --regions a,b,c    force the region set (default: the union of the regions the
#                      shared leaf already covers plus this robot's live region)
#   --hub-port <n>    also repoint the conversation hub at <n> on the robot
#                     (default: leave the hub alone; port 29000 for a new robot)
#   --adopt           register the robot's EXISTING credentials in the Phoenix
#                     account store (default: off — an OOBE-bound robot receives
#                     fresh credentials from OOBE.setupRobot)
#   --server-env <f>   the server's EnvironmentFile (default ~/.config/phoenix/moth.env)
#   --switch-server    THE server verb: point the env at the shared leaf, restart
#                      the service, and prove the TLS port now serves the leaf
#   --revert           put the robot back from its backup and undo the repoint
#   --revert-server    restore the previous EnvironmentFile and restart the service
#   --dry-run          print the plan, change nothing
#   --yes              skip the confirmation prompt
#
# Secrets are never printed or written to Git: only digests and key NAMES.
# Every edited robot file is additionally backed up by repoint-robot.sh.

set -euo pipefail

ROBOT=""; PHOENIX="192.168.1.182"; REGIONS_ARG=""; HUB_PORT=""
ADOPT=0
SERVER_ENV="${XDG_CONFIG_HOME:-${HOME}/.config}/phoenix/moth.env"
SWITCH_SERVER=0; REVERT=0; REVERT_SERVER=0; DRY=0; ASSUME_YES=0

BACKUP_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/phoenix/onboard-backups"
TLS_DIR="${PHOENIX_TLS_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/phoenix/tls}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REPOINT="$REPO/scripts/parity-robot/repoint-robot.sh"
ENSURE_TLS="$REPO/scripts/ensure-tls-certs.mjs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

say()  { printf '\033[36m[onboard]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[onboard] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[onboard] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[onboard] OK:\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --robot) ROBOT="${2:-}"; shift 2 ;;
    --phoenix) PHOENIX="${2:-}"; shift 2 ;;
    --regions) REGIONS_ARG="${2:-}"; shift 2 ;;
    --hub-port) HUB_PORT="${2:-}"; shift 2 ;;
    --adopt) ADOPT=1; shift ;;
    --server-env) SERVER_ENV="${2:-}"; shift 2 ;;
    --switch-server) SWITCH_SERVER=1; shift ;;
    --revert) REVERT=1; shift ;;
    --revert-server) REVERT_SERVER=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
rsh() { timeout 90 "${SSH[@]}" "$ROBOT" "$@"; }

# ------------------------------------------------------------------ helpers
confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  printf 'Proceed? [y/N] ' >&2; read -r reply </dev/tty
  case "$reply" in y|Y|yes|YES) return 0 ;; *) say "aborted; nothing changed"; exit 1 ;; esac
}

live_region_of_robot() {
  local sm_port region
  sm_port="$(rsh "curl -s -m 5 http://127.0.0.1:8181/registry | tr ',' '\n' | grep -A2 'system-manager' | grep port | tr -dc '0-9'" 2>/dev/null || true)"
  [ -n "$sm_port" ] || sm_port=8585
  region="$(rsh "curl -s -m 5 -H 'Authentication: foobar' http://127.0.0.1:${sm_port}/credentials | sed -n 's/.*\"region\"[^\"]*\"\\([^\"]*\\)\".*/\\1/p'" 2>/dev/null || true)"
  printf '%s' "$region"
}

union_regions() {
  # existing regions: the shared leaf's own receipt is authoritative; fall back
  # to the repo default "api" when there is no receipt yet.
  local existing=""
  if [ -r "$TLS_DIR/receipt.json" ]; then
    existing="$(node -e 'const fs=require("fs");try{const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log((r.regions||[]).join(","))}catch(e){process.exit(0)}' "$TLS_DIR/receipt.json" 2>/dev/null || true)"
  fi
  existing="$( { echo "${existing:-api}"; echo "$REGIONS_ARG"; } | tr ',' '\n' | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//' )"
  # live region from the robot, if reachable
  if [ -n "$ROBOT" ] && "${SSH[@]}" "$ROBOT" true 2>/dev/null; then
    local live_region
    live_region="$(live_region_of_robot)"
    if [ -n "$live_region" ]; then
      existing="$( printf '%s\n%s\n' "$existing" "$live_region" | tr ',' '\n' | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//' )"
    fi
  fi
  printf '%s' "$existing"
}

server_serves_leaf() {
  # true when the live TLS entrypoint presents the shared leaf (verified chain).
  echo | openssl s_client -connect "127.0.0.1:443" -servername "localhost" \
    -CAfile "$TLS_DIR/ca.crt" 2>/dev/null | grep -q 'Verify return code: 0 (ok)'
}

# ------------------------------------------------------------- switch-server
if [ "$SWITCH_SERVER" -eq 1 ] || [ "$REVERT_SERVER" -eq 1 ]; then
  [ -f "$SERVER_ENV" ] || die "server EnvironmentFile not found: $SERVER_ENV"
  [ -f "$SERVER_ENV".phx-onboard-bak ] && BAK_SERVER="$SERVER_ENV".phx-onboard-bak || BAK_SERVER=""

  if [ "$DRY" -eq 1 ]; then
    say "plan (server):"
    if [ "$REVERT_SERVER" -eq 1 ]; then
      [ -z "$BAK_SERVER" ] && die "no server env backup to revert to"
      echo "  - restore ${SERVER_ENV} from $BAK_SERVER"
    else
      echo "  - back up $SERVER_ENV"
      echo "  - point PHOENIX_ROBOT_TLS_CERT/_KEY at $TLS_DIR/server.{crt,key}"
    fi
    echo "  - systemctl --user restart phoenix-robot@moth.service"
    echo "  - prove :443 serves the shared leaf (openssl s_client -CAfile $TLS_DIR/ca.crt)"
    say "--dry-run: nothing changed"; exit 0
  fi

  confirm

  if [ "$REVERT_SERVER" -eq 1 ]; then
    [ -n "$BAK_SERVER" ] || die "no server env backup to revert to"
    say "restoring $SERVER_ENV from $BAK_SERVER"
    cp -p "$BAK_SERVER" "$SERVER_ENV"
  else
    mkdir -p "$BACKUP_ROOT/server"
    cp -p "$SERVER_ENV" "$SERVER_ENV.phx-onboard-bak"
    cp -p "$SERVER_ENV" "$BACKUP_ROOT/server/moth.env.before-$STAMP"
    grep -q '^PHOENIX_ROBOT_TLS_CERT=' "$SERVER_ENV" \
      || printf 'PHOENIX_ROBOT_TLS_CERT=%s\nPHOENIX_ROBOT_TLS_KEY=%s\n' "$TLS_DIR/server.crt" "$TLS_DIR/server.key" >> "$SERVER_ENV"
    sed -i "s|^\(PHOENIX_ROBOT_TLS_CERT=\).*|\1$TLS_DIR/server.crt|; s|^\(PHOENIX_ROBOT_TLS_KEY=\).*|\1$TLS_DIR/server.key|" "$SERVER_ENV"
    chmod 600 "$SERVER_ENV"
    ok "env now points the server at the shared leaf (backup $BACKUP_ROOT/server/moth.env.before-$STAMP)"
  fi

  say "restarting phoenix-robot@moth.service"
  systemctl --user restart phoenix-robot@moth.service
  sleep 3
  for _ in $(seq 1 20); do
    systemctl --user is-active --quiet phoenix-robot@moth.service && echo | openssl s_client -connect 127.0.0.1:443 -servername localhost 2>/dev/null | grep -q 'BEGIN CERTIFICATE' && break
    sleep 1
  done
  systemctl --user is-active --quiet phoenix-robot@moth.service || die "server did not come back active after the switch"
  CERT_SUBJ="$(echo | openssl s_client -connect 127.0.0.1:443 -servername localhost 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null || true)"
  say "server now serves: ${CERT_SUBJ:-<no certificate on :443>}"
  if server_serves_leaf; then
    ok "the TLS entrypoint presents a certificate the SHARED CA verifies"
  else
    die "the TLS entrypoint does NOT verify against the shared CA — check the env and logs"
  fi
  exit 0
fi

# ------------------------------------------------------------------- preflight
[ -n "$ROBOT" ] || die "--robot is required (or use --switch-server as the server verb)"
[ -x "$REPOINT" ] || die "repoint-robot.sh missing: $REPOINT"
[ -r "$ENSURE_TLS" ] || die "ensure-tls-certs.mjs missing: $ENSURE_TLS"

say "preflight: connecting to $ROBOT"
rsh true 2>/dev/null || die "cannot ssh to $ROBOT"
ARCH="$(rsh 'uname -m' 2>/dev/null || true)"
REGISTRY="$(rsh 'curl -s -m 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:8181/registry 2>/dev/null; true' 2>/dev/null)"
[ "$REGISTRY" = "200" ] || die "no Jibo service registry on 127.0.0.1:8181 (got HTTP $REGISTRY)"
HOSTS_TARGET="$(rsh 'readlink -f /etc/hosts' 2>/dev/null || true)"
[ -n "$HOSTS_TARGET" ] || die "cannot resolve /etc/hosts"
rsh "test -w '$HOSTS_TARGET'" 2>/dev/null || die "$HOSTS_TARGET is not writable"
FW="$(rsh 'cat /proc/version 2>/dev/null | head -1' 2>/dev/null || true)"
ok "reachable Jibo ($ARCH), registry answering, hosts writable ($HOSTS_TARGET)"
[ -n "$FW" ] && ok "firmware: $FW"

REGIONS="${REGIONS_ARG:-$(union_regions)}"
[ -n "$REGIONS" ] || die "no regions to converge"
say "region set for convergence: $(echo "$REGIONS" | tr ',' ' ')"

# The regions this ROBOT's hosts need are not necessarily the union (Moth must
# stay byte-identical apart from the CA). Default to this robot's own live
# region; an explicit --regions overrides that for a fresh robot.
if [ -n "$REGIONS_ARG" ]; then ROBOT_REGIONS="$REGIONS_ARG"; else ROBOT_REGIONS="$(live_region_of_robot)"; fi
[ -n "$ROBOT_REGIONS" ] || ROBOT_REGIONS="$(echo "$REGIONS" | tr ',' ' ' | awk '{print $1}')"
say "regions for $ROBOT's hosts: $(echo "$ROBOT_REGIONS" | tr ',' ' ')"

# ------------------------------------------------------ converge the shared leaf
mkdir -p -m 700 "$TLS_DIR"
if [ ! -r "$TLS_DIR/ca.crt" ] || [ ! -r "$TLS_DIR/ca.key" ]; then
  [ "$DRY" -eq 1 ] && say "would create the shared CA at $TLS_DIR/ca.crt (it does not exist yet)"
  [ "$DRY" -eq 0 ] && PHOENIX_TLS_REGIONS="$REGIONS" node "$ENSURE_TLS"
fi
[ -r "$TLS_DIR/ca.crt" ] || die "shared CA not present at $TLS_DIR/ca.crt"
[ -r "$TLS_DIR/ca.key" ] || die "shared CA key not present at $TLS_DIR/ca.key"
[ -r "$TLS_DIR/server.crt" ] || [ "$DRY" -eq 1 ] || die "no serving leaf at $TLS_DIR/server.crt"

if [ "$DRY" -eq 1 ]; then
  [ -r "$TLS_DIR/server.crt" ] && say "would converge the serving leaf to cover: $(echo "$REGIONS" | tr ',' ' ')"
  [ -r "$TLS_DIR/server.crt" ] || say "would issue the serving leaf from the shared CA"
else
  PHOENIX_TLS_REGIONS="$REGIONS" node "$ENSURE_TLS" >/dev/null 2>&1 \
    || die "could not converge the serving leaf via ensure-tls-certs.mjs"
  openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt" >/dev/null 2>&1 \
    || die "the serving leaf is NOT signed by the shared CA"
  for r in $(echo "$REGIONS" | tr ',' ' '); do
    openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null \
      | grep -q "DNS:${r}.jibo.com" || die "leaf does not cover ${r}.jibo.com"
    openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null \
      | grep -q "DNS:${r}-socket.jibo.com" || die "leaf does not cover ${r}-socket.jibo.com"
  done
  ok "one shared CA + one leaf covers: $(echo "$REGIONS" | tr ',' ' ')"
fi

# ------------------------------------------------------------- robot backup
BACKUP_DIR="$BACKUP_ROOT/$(echo "$ROBOT" | tr '/@' '__')/$STAMP"
if [ "$DRY" -eq 1 ]; then
  say "would back up /var/jibo and $HOSTS_TARGET to $BACKUP_DIR (private, not in Git)"
else
  [ -z "${HUB_PORT:-}" ] && HUB_ARGS=(--no-hub) || HUB_ARGS=(--hub-port "$HUB_PORT")
  mkdir -p -m 700 "$BACKUP_DIR"
  rsh "tar -C / -cpf - var/jibo 2>/dev/null" > "$BACKUP_DIR/var-jibo.tar" 2>/dev/null || warn "tar of /var/jibo incomplete (continuing with what was captured)"
  rsh "cat '$HOSTS_TARGET'" > "$BACKUP_DIR/etc-hosts" 2>/dev/null || true
  chmod 600 "$BACKUP_DIR/var-jibo.tar" "$BACKUP_DIR/etc-hosts"
  {
    echo "# onboard-robot.sh backup $STAMP for $ROBOT";
    echo "hosts_target=$HOSTS_TARGET";
    echo "regions=$ROBOT_REGIONS";
    echo "leaf_regions=$REGIONS";
    echo "phoenix=$PHOENIX";
  } > "$BACKUP_DIR/manifest"
  {
    echo "sha256 /var/jibo/credentials.json: $(rsh "sha256sum /var/jibo/credentials.json 2>/dev/null" | awk '{print $1}')";
    echo "sha256 /var/jibo/identity.json:     $(rsh "sha256sum /var/jibo/identity.json 2>/dev/null" | awk '{print $1}')";
    echo "sha256 $HOSTS_TARGET:               $(sha256sum < "$BACKUP_DIR/etc-hosts" | awk '{print $1}')";
  } > "$BACKUP_DIR/digests.txt"
  chmod 600 "$BACKUP_DIR/manifest" "$BACKUP_DIR/digests.txt"
  ok "robot backed up to $BACKUP_DIR (digests in digests.txt, secret values never recorded)"
fi

# ------------------------------------------------------------------- repoint
REPOINT_ARGS=( --robot "$ROBOT" --phoenix "$PHOENIX" --cert-dir "$TLS_DIR" --ca "$TLS_DIR/ca.crt" )
REPOINT_ARGS+=( --trust-first --regions "$ROBOT_REGIONS" )
[ -n "${HUB_PORT:-}" ] && REPOINT_ARGS+=( --hub-port "$HUB_PORT" ) || REPOINT_ARGS+=( --no-hub )
[ "$ADOPT" -eq 1 ] || REPOINT_ARGS+=( --no-adopt )
[ "$DRY" -eq 1 ] && REPOINT_ARGS+=( --dry-run ) || REPOINT_ARGS+=( --yes )

if [ "$REVERT" -eq 1 ]; then
  say "reverting the repoint (hosts block, CA, Node client patch) first"
  if [ "$DRY" -eq 0 ]; then
    "$REPOINT" --robot "$ROBOT" --revert --yes || die "repoint revert failed"
    LATEST_BACKUP="$(ls -1dt "$BACKUP_ROOT/$(echo "$ROBOT" | tr '/@' '__')"/*/ 2>/dev/null | head -1 || true)"
    if [ -z "${LATEST_BACKUP:-}" ]; then
      warn "no onboard backup found to restore /var/jibo and $HOSTS_TARGET from"
    else
      say "restoring /var/jibo and $HOSTS_TARGET from $LATEST_BACKUP"
      rsh "cat > '$HOSTS_TARGET'" < "$LATEST_BACKUP/etc-hosts"
      rsh "tar -C / -xpf -" < "$LATEST_BACKUP/var-jibo.tar"
      ok "robot deployment restored to the backed-up state"
    fi
  else
    say "plan: run repoint --revert, then restore /var/jibo and $HOSTS_TARGET from $BACKUP_ROOT/..."
  fi
  exit 0
fi

say "repointing $ROBOT through repoint-robot.sh (dry-run first), shared CA, trust-first"
if [ "$DRY" -eq 1 ]; then
  "$REPOINT" "${REPOINT_ARGS[@]}"
else
  "$REPOINT" "${REPOINT_ARGS[@]}" --dry-run || true   # show the plan; apply below
  confirm
  "$REPOINT" "${REPOINT_ARGS[@]}" || die "repoint-robot.sh failed"
fi

# ------------------------------------------------------------------- verify
if [ "$DRY" -eq 1 ]; then
  say "--dry-run: none of the robot changes were applied"
  exit 0
fi

say "verifying $ROBOT"
for r in $(echo "$ROBOT_REGIONS" | tr ',' ' '); do
  resolved="$(rsh "ping -c1 -W1 '$r.jibo.com' 2>&1 | head -1 | sed -n 's/^[^(]*(\\([0-9.]*\\)).*/\\1/p'" 2>/dev/null || true)"
  if [ "$resolved" = "$PHOENIX" ]; then ok "$r.jibo.com -> $PHOENIX (resolved on the robot)"
  else warn "$r.jibo.com resolved to '${resolved:-nothing}' on the robot (expected $PHOENIX)"; fi
done
rsh "test -f /etc/ssl/certs/phoenix-ca.crt" 2>/dev/null \
  && ok "shared CA visible in the ACTIVE OpenSSL store (/etc/ssl/certs/phoenix-ca.crt)" \
  || warn "shared CA not visible in the active store — a bind mount may be masking it"
rsh "test -f /var/lib/phoenix/jibo-server-client-ca.json" 2>/dev/null \
  && ok "Node client patch receipt present" \
  || warn "Node client patch receipt missing (/var/lib/phoenix/jibo-server-client-ca.json)"

# TLS with verification ON: ask the robot to connect to the region hostname and
# verify against exactly the CA we installed. Before --switch-server this is
# expected to fail; afterwards it must pass.
if server_serves_leaf; then
  say "the server already serves the shared leaf — running the strict TLS check"
  TLS_FAIL=0
  for r in $(echo "$ROBOT_REGIONS" | tr ',' ' '); do
    REPL="$(rsh "curl -sS --max-time 8 --cacert /etc/ssl/certs/phoenix-ca.crt -o /dev/null -w '%{http_code}' https://$r.jibo.com/healthcheck 2>&1" 2>/dev/null || true)"
    case "$REPL" in 200) ok "robot reached https://$r.jibo.com/healthcheck with verification on (HTTP 200)" ;;
      *) warn "robot could not reach https://$r.jibo.com/healthcheck with verification on: $REPL"; TLS_FAIL=1 ;;
    esac
  done
  [ "$TLS_FAIL" -eq 0 ] || warn "strict TLS verification did not fully pass"
else
  warn "server still serves another certificate. $ROBOT now trusts the shared CA, but TLS with"
  warn "verification on lands only after: onboard-robot.sh --switch-server (run it once both"
  warn "robots that must stay up — Moth — trust the shared CA)."
fi

say "done. The native client retries every 15s; a reboot is the real test of persistence."