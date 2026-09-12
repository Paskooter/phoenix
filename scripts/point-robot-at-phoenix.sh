#!/usr/bin/env bash
# point-robot-at-phoenix.sh — RUN THIS ON YOUR PC. SSHes into the Jibo and points BOTH
# subsystems at the same Phoenix box:
#   • Classic Services / server-client — every region_config.json -> http://<phoenix>:<classic-port>
#       Pass 9012 for the classic ENTRYPOINT (the single front door: OOBE, update, log, robot,
#       notification, …). The default 9010 reaches a standalone OTA server only (firmware updates).
#   • Conversation hub  — jibo-jetstream-service.json HubClient.override -> <phoenix>:<hub-port> (default 9000)
# so the robot's cloud calls AND "Hey Jibo" both reach Phoenix. Every file it changes is backed up
# (*.phx-bak), and the Jetstream service is restarted so it re-reads its config.
#
# NOTE: scripts/robot-repoint-server-client.sh is the robot-side equivalent — run it ON the robot
# (no SSH) to do the same complete repoint: every region_config `endpoint` AND `wsendpoint`,
# the Jetstream hub, and the /etc/hosts names the cert is verified against. This PC-side script
# still leaves each region_config `wsendpoint` alone (the robot-side one does not). Prefer that
# script when you already have a shell on the robot, and keep the two from drifting.
#
# Authentication is delegated to OpenSSH. Use a configured key or answer the
# normal SSH prompt; this launcher never stores or supplies a password.
# Host keys must already be present in the known-hosts file.
#
# Usage:
#   scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> [classic-port] [hub-port]
#   scripts/point-robot-at-phoenix.sh <robot-ip> --reset            # undo: restore backups + clear override
#
# Examples:
#   scripts/point-robot-at-phoenix.sh 192.168.1.42 192.168.1.50 9012 9000   # full classic entrypoint
#   scripts/point-robot-at-phoenix.sh 192.168.1.42 192.168.1.50             # OTA only (port 9010)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/load-dotenv.sh
source "$SCRIPT_DIR/load-dotenv.sh"

say() { printf '\033[36m[phoenix]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[phoenix] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

PORTS_FILE="$SCRIPT_DIR/parity-robot/ports.json"
DEFAULT_HUB_PORT="$(phoenix_canonical_port "$PORTS_FILE")" || die "invalid canonical hub-port configuration"
ROBOT="${1:-}"
SECOND="${2:-}"

if [ -z "$ROBOT" ] || [ -z "$SECOND" ]; then
  sed -n '2,20p' "$0" >&2; exit 2
fi

MODE=apply
PHOENIX=""
OTA_PORT=9010
HUB_PORT="$DEFAULT_HUB_PORT"
if [ "$SECOND" = "--reset" ]; then
  [ "$#" -eq 2 ] || { say "usage: $0 <robot-ip> --reset"; exit 2; }
  MODE=reset
else
  case "$#" in
    2|3|4) ;;
    *) say "usage: $0 <robot-ip> <phoenix-ip> [classic-port] [hub-port]"; exit 2 ;;
  esac
  PHOENIX="$SECOND"
  OTA_PORT="${3:-9010}"
  HUB_PORT="${4:-$DEFAULT_HUB_PORT}"
fi

validate_host() {
  local value="${1:-}"
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1
  [[ "$value" != *..* ]]
}
validate_port() {
  local value="${1:-}"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#$value >= 1 && 10#$value <= 65535 ))
}

validate_host "$ROBOT" || { say "invalid robot host"; exit 2; }
validate_port "$HUB_PORT" || { say "invalid hub port"; exit 2; }
if [ "$MODE" = apply ]; then
  validate_host "$PHOENIX" || { say "invalid Phoenix host"; exit 2; }
  validate_port "$OTA_PORT" || { say "invalid classic port"; exit 2; }
fi

OTA_ENDPOINT=""
[ "$MODE" = apply ] && OTA_ENDPOINT="http://$PHOENIX:$OTA_PORT"

SSH_USER="${PHOENIX_SSH_USER:-root}"
[[ "$SSH_USER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { say "invalid SSH user"; exit 2; }
SSH_KNOWN_HOSTS="${PHOENIX_SSH_KNOWN_HOSTS:-${HOME:-}/.ssh/known_hosts}"
[ -n "$SSH_KNOWN_HOSTS" ] && [ -r "$SSH_KNOWN_HOSTS" ] || die "SSH known-hosts file is not readable: $SSH_KNOWN_HOSTS"
SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" -o ConnectTimeout=8)

# Pass a fixed remote program and validated data arguments. Do not build a
# shell command string from caller-provided values.
run_remote() {
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ROBOT" sh -s -- "$MODE" "$OTA_ENDPOINT" "$PHOENIX" "$HUB_PORT"
}

# ---- the script that runs ON THE ROBOT (POSIX sh / busybox; the robot has node) -------------
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
MODE="$1"; OTA_ENDPOINT="$2"; HUB_HOST="$3"; HUB_PORT="$4"
NODE="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
echo "[robot] mode=$MODE ota=$OTA_ENDPOINT hub=$HUB_HOST:$HUB_PORT node=$NODE"

# make platform partitions writable
if command -v jibo-mount >/dev/null 2>&1; then jibo-mount --rw >/dev/null 2>&1 || true
else mount -o remount,rw /usr/local 2>/dev/null || true; mount -o remount,rw / 2>/dev/null || true; fi

# 1) every region_config.json (the OTA / server-client endpoint) ------------------------------
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
       -name region_config.json -print 2>/dev/null | while IFS= read -r f; do
  grep -q globalSSL "$f" 2>/dev/null || continue
  if [ "$MODE" = reset ]; then
    [ -f "$f.phx-bak" ] && cp "$f.phx-bak" "$f" && echo "[robot] reverted $f"
    continue
  fi
  [ -f "$f.phx-bak" ] || cp "$f" "$f.phx-bak"
  "$NODE" -e '
    var fs=require("fs"), file=process.argv[1], ep=process.argv[2];
    var j=JSON.parse(fs.readFileSync(file,"utf8"));
    function setEp(o){ if(o&&typeof o==="object"&&typeof o.endpoint==="string"){o.endpoint=ep; if("globalEndpoint" in o)o.globalEndpoint=true;} }
    if(j.rules)Object.keys(j.rules).forEach(function(k){setEp(j.rules[k]);});
    if(j.patterns)Object.keys(j.patterns).forEach(function(k){setEp(j.patterns[k]);});
    fs.writeFileSync(file, JSON.stringify(j,null,2));
  ' "$f" "$OTA_ENDPOINT" && echo "[robot] region_config -> $OTA_ENDPOINT : $f"
done

# 2) jetstream HubClient.override (the conversation hub) ---------------------------------------
JET=/usr/local/etc/jibo-jetstream-service.json
if [ -f "$JET" ]; then
  if [ "$MODE" = reset ]; then
    if [ -f "$JET.phx-bak" ]; then cp "$JET.phx-bak" "$JET" && echo "[robot] reverted $JET";
    else "$NODE" -e 'var fs=require("fs"),p=process.argv[1];var c=JSON.parse(fs.readFileSync(p,"utf8"));if(c.HubClient)delete c.HubClient.override;fs.writeFileSync(p,JSON.stringify(c,null,"\t"));' "$JET" && echo "[robot] cleared HubClient.override"; fi
  else
    [ -f "$JET.phx-bak" ] || cp "$JET" "$JET.phx-bak"
    "$NODE" -e '
      var fs=require("fs"), p=process.argv[1], host=process.argv[2], port=parseInt(process.argv[3],10);
      var region="api"; try{ region=(JSON.parse(fs.readFileSync("/var/jibo/credentials.json","utf8")).region)||"api"; }catch(e){}
      var c=JSON.parse(fs.readFileSync(p,"utf8")); c.HubClient=c.HubClient||{};
      c.HubClient.override={ hub_port:port, hub_hostname:host, entrypoint_hostname:region+".jibo.com" };
      fs.writeFileSync(p, JSON.stringify(c,null,"\t"));
      console.log("[robot] jetstream override -> "+host+":"+port+" (region "+region+")");
    ' "$JET" "$HUB_HOST" "$HUB_PORT"
  fi
  # restart jetstream so it re-reads config (it is supervised and respawns)
  pkill -9 -f jibo-jetstream-service 2>/dev/null && echo "[robot] restarted jetstream" || true
else
  echo "[robot] note: $JET not found (Jetstream not installed?) — skipped hub override"
fi

echo "[robot] done."
REMOTE
# ---------------------------------------------------------------------------------------------

say "robot=$ROBOT  phoenix=$PHOENIX  ota=$OTA_ENDPOINT  hub=$PHOENIX:$HUB_PORT  mode=$MODE"
say "applying on robot…"
printf '%s' "$REMOTE_SCRIPT" | run_remote

cat >&2 <<EOF

[phoenix] verify (on the robot, or via ssh):
  jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4
  -> should print the os-13.0.0 Update JSON, and a matching "update query" line should appear
     in the Phoenix OTA log (/tmp/phx-compose-ota.log).
  Conversation: say "Hey Jibo …" — Jetstream now points at $PHOENIX:$HUB_PORT.
EOF
