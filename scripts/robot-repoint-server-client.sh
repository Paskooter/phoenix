#!/bin/sh
# robot-repoint-server-client.sh — RUN THIS ON THE ROBOT (as root).
#
# Repoints a Jibo at a local Phoenix server COMPLETELY: every cloud connection
# target the robot uses, not just the OTA update check. In one run it changes:
#
#   1. REST `endpoint` — every @jibo/jibo-server-client `region_config.json` copy
#      on the robot (rules AND patterns) -> the Phoenix REST base URL you pass. The
#      complete target is the classic entrypoint (`:9012`), the single front door for
#      *all* Classic Services (OOBE, update, log, robot, notification, settings,
#      account, …); a bare `:9010` reaches only the OTA server. Several packages
#      bundle their own copy and you can't be sure which one a given service loads,
#      so this rewrites them ALL.
#   2. Socket `wsendpoint` — the same files' notification/websocket target -> Phoenix.
#      The native client mints `wss://<region>-socket.jibo.com/<token>` and verifies
#      the server certificate against that *name* (plus the `<region>` name from
#      `NotificationSubsystem.serverURLSuffix` in jibo-server-service.json), so the
#      socket host is forced to the region-derived TLS name the robot's pinned
#      certificate carries. Pass `--socket <url>` for a plain-HTTP lab where the
#      socket is served directly (e.g. `--socket ws://<phoenix>:9012`).
#   3. `globalEndpoint` — set true wherever the key is present, so the rewritten
#      endpoints are authoritative instead of pattern-fallback.
#   4. Conversation hub — /usr/local/etc/jibo-jetstream-service.json
#      `HubClient.override` -> the Phoenix hub. Default host is the one from the REST
#      URL and the default port is the port already in the config, else 9000; set
#      both with `--hub <host>[:<port>]`. Jetstream is restarted so it re-reads the
#      config. `--no-hub` leaves it alone.
#   5. DNS names — a managed block in /etc/hosts maps `<region>.jibo.com` and
#      `<region>-socket.jibo.com` to the Phoenix host. The native client verifies
#      the certificate against these names, so for the socket (and for a TLS REST
#      deployment) the *names* — not a bare IP — must resolve to Phoenix. This
#      strengthens/refreshes the existing block; unrelated entries are never removed.
#
# The robot's region is read from /var/jibo/credentials.json (here: `api`). It is
# never assumed to be `phx`; `--region` overrides only if that file is missing.
#
# Every file it edits is backed up ONCE to *.phx-bak, and `--revert` restores every
# one of them (region_config copies, Jetstream config, /etc/hosts).
#
# Usage (on the robot):
#   sh robot-repoint-server-client.sh https://<phoenix>            # complete repoint (TLS 443)
#   sh robot-repoint-server-client.sh http://<phoenix>:9012        # plain-HTTP classic entrypoint
#   sh robot-repoint-server-client.sh http://<phoenix>:9012 --socket ws://<phoenix>:9012
#   sh robot-repoint-server-client.sh http://<phoenix>:9012 --hub <phoenix>:29000
#   sh robot-repoint-server-client.sh http://<phoenix>:9012 --no-hub
#   sh robot-repoint-server-client.sh --dry-run [url]              # show the plan, change nothing
#   sh robot-repoint-server-client.sh --revert                     # restore every *.phx-bak
#
# Then verify:
#   jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4
#   (a matching "update query" line should appear in the Phoenix OTA log)
#   curl -sk https://<region>-socket.jibo.com/healthcheck   # socket name reaches Phoenix
#
# NOTE: scripts/point-robot-at-phoenix.sh (PC-side, over SSH) and
# scripts/parity-robot/repoint-robot.sh overlap parts of this (region_config
# endpoint, Jetstream hub, /etc/hosts). This is the robot-side, self-contained,
# complete repoint; keep the three from drifting.

MODE=repoint
REST_URL=""
SOCKET_URL=""
HUB_ARG=""
REGION_ARG=""
DO_HUB=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dryrun ;;
    --revert)  MODE=revert ;;
    --socket)  SOCKET_URL="${2:-}"; shift ;;
    --hub)     HUB_ARG="${2:-}"; shift ;;
    --no-hub)  DO_HUB=0 ;;
    --region)  REGION_ARG="${2:-}"; shift ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    http://*|https://*) REST_URL="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = repoint ] && [ -z "$REST_URL" ]; then
  echo "usage: $0 <http(s)://phoenix-host[:port]> [--socket <ws-url>] [--hub <host[:port]>] [--no-hub] [--dry-run] [--revert]" >&2
  exit 2
fi

if [ "$MODE" = repoint ]; then
  case "$REST_URL" in
    http://*)  echo "note: plain-HTTP REST endpoint — the robot's native client upgrades some calls to TLS on :443; for a TLS deployment pass https://<name> instead." >&2 ;;
    https://*) : ;;
    *) echo "endpoint must start with http:// or https:// (got: $REST_URL)" >&2; exit 2 ;;
  esac
fi

NODE="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
if [ ! -x "$NODE" ] && ! command -v "$NODE" >/dev/null 2>&1; then
  echo "node not found (looked for 'node' and /usr/local/bin/node)" >&2; exit 1
fi

# ---- region: read it from the robot, never assume ------------------------------------
read_region() {
  if [ -r /var/jibo/credentials.json ]; then
    "$NODE" -e 'try{var r=JSON.parse(require("fs").readFileSync("/var/jibo/credentials.json","utf8")).region; if(r) process.stdout.write(r);}catch(e){}' 2>/dev/null
  fi
}
REGION="$(read_region)"
if [ -z "$REGION" ]; then
  if [ -n "$REGION_ARG" ]; then
    REGION="$REGION_ARG"
    echo "note: /var/jibo/credentials.json unreadable — using --region $REGION" >&2
  else
    echo "cannot read the robot's region from /var/jibo/credentials.json (pass --region to override)" >&2
    exit 1
  fi
fi

# ---- derive the Phoenix host and the default socket URL -----------------------------
host_of() { # strip scheme, path and port
  printf '%s' "$1" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||' -e 's|:.*$||'
}
is_ip() { # crude IPv4 test
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}
[ -n "$REST_URL" ] && PHX_HOST="$(host_of "$REST_URL")" || PHX_HOST=""
# Default socket target: the region-derived TLS name the robot's pinned cert carries.
[ -n "$SOCKET_URL" ] || SOCKET_URL="wss://${REGION}-socket.jibo.com"

# ---- conversation hub target ---------------------------------------------------------
JET=/usr/local/etc/jibo-jetstream-service.json
HUB_HOST=""; HUB_PORT=""
if [ -n "$HUB_ARG" ]; then
  HUB_HOST="$(host_of "$HUB_ARG")"
  case "$HUB_ARG" in *:*) HUB_PORT="$(printf '%s' "$HUB_ARG" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')" ;; esac
fi
[ -n "$HUB_HOST" ] || HUB_HOST="$PHX_HOST"
# Preserve an already-working hub port if one is configured; else 9000.
if [ -z "$HUB_PORT" ] && [ -r "$JET" ]; then
  HUB_PORT="$("$NODE" -e 'try{var c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));var o=(c.HubClient&&c.HubClient.override)||{};if(o.hub_port)process.stdout.write(String(o.hub_port));}catch(e){}' "$JET" 2>/dev/null)"
fi
[ -n "$HUB_PORT" ] || HUB_PORT=9000

# ---- writable mounts (best-effort) ---------------------------------------------------
if [ "$MODE" != dryrun ]; then
  if command -v jibo-mount >/dev/null 2>&1; then jibo-mount --rw 2>/dev/null || true
  else mount -o remount,rw /usr/local 2>/dev/null || true; mount -o remount,rw / 2>/dev/null || true
  fi
fi

echo "region:   $REGION   (from /var/jibo/credentials.json)"
echo "rest:     ${REST_URL:-<none>}"
echo "socket:   $SOCKET_URL"
if [ "$DO_HUB" = 1 ]; then echo "hub:      ${HUB_HOST:-<none>}:${HUB_PORT}"; else echo "hub:      (left alone)"; fi
echo

# ---- 1+2+3: rewrite every region_config.json -----------------------------------------
# Collect the file list first so the loop runs in THIS shell (a `find | while` pipeline
# would run in a subshell and lose the counters).
LIST=/tmp/.phx-region-config-list.$$
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
       -name region_config.json -print 2>/dev/null > "$LIST"
found=0; changed=0; reverted=0; missing=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -q globalSSL "$f" 2>/dev/null || continue
  found=$((found + 1))

  if [ "$MODE" = dryrun ]; then
    echo "would edit: $f"
    echo "      endpoint  -> $REST_URL"
    echo "      wsendpoint-> $SOCKET_URL"
    continue
  fi

  if [ "$MODE" = revert ]; then
    if [ -f "$f.phx-bak" ]; then cp "$f.phx-bak" "$f" && echo "reverted: $f"; reverted=$((reverted + 1))
    else echo "no backup: $f"; missing=$((missing + 1)); fi
    continue
  fi

  # repoint: back up once, then rewrite endpoint + wsendpoint (+ globalEndpoint) via Node
  [ -f "$f.phx-bak" ] || cp "$f" "$f.phx-bak"
  if "$NODE" -e '
      var fs = require("fs");
      var file = process.argv[1], ep = process.argv[2], ws = process.argv[3];
      var j = JSON.parse(fs.readFileSync(file, "utf8"));
      function fix(o){
        if (o && typeof o === "object") {
          if (typeof o.endpoint === "string") { o.endpoint = ep; if ("globalEndpoint" in o) o.globalEndpoint = true; }
          if (typeof o.wsendpoint === "string") { o.wsendpoint = ws; }
        }
      }
      if (j.rules)    Object.keys(j.rules).forEach(function(k){ fix(j.rules[k]); });
      if (j.patterns) Object.keys(j.patterns).forEach(function(k){ fix(j.patterns[k]); });
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    ' "$f" "$REST_URL" "$SOCKET_URL"; then
    echo "repointed: $f"
    echo "      endpoint  -> $REST_URL"
    echo "      wsendpoint-> $SOCKET_URL"
    changed=$((changed + 1))
  else
    echo "FAILED:    $f  (restoring backup)"; cp "$f.phx-bak" "$f" 2>/dev/null || true
  fi
done < "$LIST"
rm -f "$LIST"

# ---- 4: conversation hub (Jetstream HubClient.override) ------------------------------
if [ "$DO_HUB" = 1 ]; then
  echo
  if [ ! -f "$JET" ]; then
    echo "jetstream config not found ($JET) — skipped hub override"
  elif [ "$MODE" = dryrun ]; then
    echo "would edit: $JET"
    echo "      HubClient.override -> ${HUB_HOST}:${HUB_PORT} (entrypoint ${REGION}.jibo.com)"
  elif [ "$MODE" = revert ]; then
    if [ -f "$JET.phx-bak" ]; then
      cp "$JET.phx-bak" "$JET" && echo "reverted: $JET"
    else
      "$NODE" -e 'var fs=require("fs"),p=process.argv[1];var c=JSON.parse(fs.readFileSync(p,"utf8"));if(c.HubClient)delete c.HubClient.override;fs.writeFileSync(p,JSON.stringify(c,null,"\t"));' "$JET" \
        && echo "cleared: $JET (HubClient.override removed; no backup existed)"
    fi
    pkill -9 -f jibo-jetstream-service 2>/dev/null && echo "restarted jetstream" || true
  else
    [ -f "$JET.phx-bak" ] || cp "$JET" "$JET.phx-bak"
    if "$NODE" -e '
        var fs=require("fs"), p=process.argv[1], host=process.argv[2], port=parseInt(process.argv[3],10), region=process.argv[4];
        var c=JSON.parse(fs.readFileSync(p,"utf8")); c.HubClient=c.HubClient||{};
        c.HubClient.override={ hub_port:port, hub_hostname:host, entrypoint_hostname:region+".jibo.com" };
        fs.writeFileSync(p, JSON.stringify(c,null,"\t"));
      ' "$JET" "$HUB_HOST" "$HUB_PORT" "$REGION"; then
      echo "repointed: $JET"
      echo "      HubClient.override -> ${HUB_HOST}:${HUB_PORT} (entrypoint ${REGION}.jibo.com)"
      pkill -9 -f jibo-jetstream-service 2>/dev/null && echo "restarted jetstream" || true
    else
      echo "FAILED:    $JET  (restoring backup)"; cp "$JET.phx-bak" "$JET" 2>/dev/null || true
    fi
  fi
fi

# ---- 5: /etc/hosts names the native client verifies the certificate against -----------
# Only meaningful when the Phoenix target is a bare IP (otherwise DNS already names it).
echo
HOSTS=/etc/hosts
# Edit the file the symlink points at: `sed -i`/`cp` on the symlink itself would replace
# /etc/hosts (a link to /var/etc/hosts here) with a regular file and lose it on reboot.
HOSTS_REAL="$(readlink -f "$HOSTS" 2>/dev/null || true)"
[ -n "$HOSTS_REAL" ] || HOSTS_REAL="$HOSTS"
MARK_BEGIN="# >>> phoenix-repoint >>>"
MARK_END="# <<< phoenix-repoint <<<"
if [ "$MODE" = revert ]; then
  if [ -f "$HOSTS_REAL.phx-bak" ]; then cp "$HOSTS_REAL.phx-bak" "$HOSTS_REAL" && echo "reverted: $HOSTS_REAL"; else echo "no backup: $HOSTS_REAL"; fi
elif [ "$MODE" = dryrun ]; then
  echo "would update: $HOSTS_REAL"
  echo "      $PHX_HOST ${REGION}.jibo.com"
  echo "      $PHX_HOST ${REGION}-socket.jibo.com"
elif [ -z "$PHX_HOST" ] || ! is_ip "$PHX_HOST"; then
  echo "hosts: skipped (target '${PHX_HOST:-<none>}' is not an IP — public DNS must map ${REGION}.jibo.com / ${REGION}-socket.jibo.com)"
elif [ ! -w "$HOSTS_REAL" ]; then
  echo "hosts: $HOSTS_REAL not writable — skipped"
else
  [ -f "$HOSTS_REAL.phx-bak" ] || cp "$HOSTS_REAL" "$HOSTS_REAL.phx-bak"
  # Strip any previous managed block, then append a fresh one. Other entries are untouched.
  sed -i "/^${MARK_BEGIN}$/,/^${MARK_END}$/d" "$HOSTS_REAL" 2>/dev/null || true
  {
    echo "$MARK_BEGIN"
    echo "# written by robot-repoint-server-client.sh -> Phoenix $PHX_HOST"
    echo "$PHX_HOST ${REGION}.jibo.com"
    echo "$PHX_HOST ${REGION}-socket.jibo.com"
    echo "$MARK_END"
  } >> "$HOSTS_REAL"
  echo "hosts: updated $HOSTS_REAL ($PHX_HOST ${REGION}.jibo.com, ${REGION}-socket.jibo.com)"
fi

echo
case "$MODE" in
  dryrun) echo "dry run complete — nothing changed. $found server-client region_config.json file(s) found." ;;
  revert) echo "revert complete — $reverted region_config file(s) restored, $missing had no backup." ;;
  *)      echo "done — $changed/$found server-client region_config.json file(s) repointed to $REST_URL" ;;
esac
echo "verify: jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4"
