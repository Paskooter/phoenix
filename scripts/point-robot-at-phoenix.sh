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
# Auth: tries SSH key first, then root:jibo (needs `sshpass`), then prompts for username/password.
#
# Usage:
#   scripts/point-robot-at-phoenix.sh <robot-ip> <phoenix-ip> [classic-port] [hub-port]
#   scripts/point-robot-at-phoenix.sh <robot-ip> --reset            # undo: restore backups + clear override
#
# Examples:
#   scripts/point-robot-at-phoenix.sh 192.168.1.42 192.168.1.50 9012 9000   # full classic entrypoint
#   scripts/point-robot-at-phoenix.sh 192.168.1.42 192.168.1.50             # OTA only (port 9010)
set -euo pipefail

ROBOT="${1:-}"
SECOND="${2:-}"
OTA_PORT="${3:-9010}"
HUB_PORT="${4:-9000}"

if [ -z "$ROBOT" ] || [ -z "$SECOND" ]; then
  sed -n '2,18p' "$0" >&2; exit 2
fi

MODE=apply
PHOENIX=""
if [ "$SECOND" = "--reset" ]; then
  MODE=reset
else
  PHOENIX="$SECOND"
fi
OTA_ENDPOINT="http://$PHOENIX:$OTA_PORT"

SSH_USER=root
SSH_PASS=jibo
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8)
AUTH=""              # key | sshpass | interactive
HAVE_SSHPASS=0; command -v sshpass >/dev/null 2>&1 && HAVE_SSHPASS=1

say() { printf '\033[36m[phoenix]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[phoenix] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Quietly test whether the current SSH_USER/SSH_PASS/AUTH can log in.
test_login() {
  case "$AUTH" in
    key)         ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$SSH_USER@$ROBOT" true 2>/dev/null ;;
    sshpass)     sshpass -p "$SSH_PASS" ssh "${SSH_OPTS[@]}" "$SSH_USER@$ROBOT" true 2>/dev/null ;;
    *)           return 1 ;;
  esac
}

# Resolve an auth method.
resolve_auth() {
  AUTH=key
  if test_login; then say "auth: SSH key (root@$ROBOT)"; return; fi
  if [ "$HAVE_SSHPASS" = 1 ]; then
    AUTH=sshpass; SSH_USER=root; SSH_PASS=jibo
    if test_login; then say "auth: default root:jibo"; return; fi
    say "default root:jibo didn't work — enter the robot's login."
    local tries=0
    while [ "$tries" -lt 4 ]; do
      tries=$((tries + 1))
      printf 'username [root]: ' >&2; read -r u || true; SSH_USER="${u:-root}"
      printf 'password: ' >&2; read -rs SSH_PASS || true; printf '\n' >&2
      if test_login; then say "auth: $SSH_USER (password)"; return; fi
      say "login failed, try again ($tries/4)"
    done
    die "could not authenticate to $ROBOT"
  else
    # No sshpass: can't auto-test a password. Fall back to one interactive ssh (it will prompt).
    AUTH=interactive
    say "no 'sshpass' found — ssh will prompt for the password (default is: jibo)."
    say "(install sshpass to auto-try root:jibo: apt-get install sshpass / brew install hudochenkov/sshpass/sshpass)"
  fi
}

# Run the piped remote script over the resolved auth. Remote args: $1=MODE $2=OTA_ENDPOINT $3=HUB_HOST $4=HUB_PORT
run_remote() {
  local remote_cmd="sh -s '$MODE' '$OTA_ENDPOINT' '$PHOENIX' '$HUB_PORT'"
  if [ "$AUTH" = sshpass ]; then
    sshpass -p "$SSH_PASS" ssh "${SSH_OPTS[@]}" "$SSH_USER@$ROBOT" "$remote_cmd"
  else
    ssh "${SSH_OPTS[@]}" "$SSH_USER@$ROBOT" "$remote_cmd"
  fi
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
resolve_auth
say "applying on robot…"
printf '%s' "$REMOTE_SCRIPT" | run_remote

cat >&2 <<EOF

[phoenix] verify (on the robot, or via ssh):
  jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4
  -> should print the os-13.0.0 Update JSON, and a matching "update query" line should appear
     in the Phoenix OTA log (/tmp/phx-compose-ota.log).
  Conversation: say "Hey Jibo …" — Jetstream now points at $PHOENIX:$HUB_PORT.
EOF
