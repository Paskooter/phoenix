#!/bin/sh
# robot-repoint-server-client.sh — RUN THIS ON THE ROBOT (as root).
#
# Points every @jibo/jibo-server-client `region_config.json` on the robot at a local Phoenix
# server, so the OTA update check (jibo-get-update → server-client) — and any other REST
# server-client call — resolves there instead of the dead `https://<region>.jibo.com`.
#
# Several packages bundle their own copy of region_config.json, and you can't be sure which one
# the OTA CLI loads, so this rewrites them ALL. It edits the `endpoint` of every rule/pattern in
# each file (leaving the `wsendpoint`/socket entries alone) and backs each file up to *.phx-bak.
#
# NOTE: this redirects ALL server-client REST traffic to Phoenix. Phoenix only answers the OTA
# (Update) API, so other server-client calls will just 404 — harmless for the firmware-update
# step. Jetstream/conversation is configured separately (jibo-jetstream-service.json) and is
# untouched.
#
# Usage (on the robot):
#   sh robot-repoint-server-client.sh http://<phoenix-ip>:9010      # repoint
#   sh robot-repoint-server-client.sh --dry-run                      # just list the files
#   sh robot-repoint-server-client.sh --revert                       # restore *.phx-bak
#
# Then verify:  jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4
# (a matching "update query" line should appear in the Phoenix OTA log)

MODE=repoint
ENDPOINT=""
case "${1:-}" in
  "")        echo "usage: $0 http://<phoenix-ip>:<port> | --dry-run | --revert" >&2; exit 2 ;;
  --dry-run) MODE=dryrun ;;
  --revert)  MODE=revert ;;
  http://*|https://*) ENDPOINT="$1" ;;
  *)         echo "endpoint must start with http:// or https:// (got: $1)" >&2; exit 2 ;;
esac

case "$ENDPOINT" in
  https://*) echo "WARN: Phoenix OTA serves plain HTTP — an https:// endpoint will fail unless you terminate TLS." >&2 ;;
esac

NODE="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
if [ ! -x "$NODE" ] && ! command -v "$NODE" >/dev/null 2>&1; then
  echo "node not found (looked for 'node' and /usr/local/bin/node)" >&2; exit 1
fi

# Make the platform partitions writable (/usr/local is read-only in normal mode). Best-effort.
if [ "$MODE" != dryrun ]; then
  if command -v jibo-mount >/dev/null 2>&1; then jibo-mount --rw 2>/dev/null || true
  else mount -o remount,rw /usr/local 2>/dev/null || true; mount -o remount,rw / 2>/dev/null || true
  fi
fi

# Find every region_config.json (prune virtual filesystems). Only act on jibo-server-client's
# copies — identified by the `globalSSL` pattern they all contain.
found=0; changed=0
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
       -name region_config.json -print 2>/dev/null | while IFS= read -r f; do
  grep -q globalSSL "$f" 2>/dev/null || continue
  found=$((found + 1))

  if [ "$MODE" = dryrun ]; then
    echo "would edit: $f"
    continue
  fi

  if [ "$MODE" = revert ]; then
    if [ -f "$f.phx-bak" ]; then cp "$f.phx-bak" "$f" && echo "reverted: $f"; else echo "no backup: $f"; fi
    continue
  fi

  # repoint: back up once, then rewrite every endpoint via Node (safe JSON round-trip)
  [ -f "$f.phx-bak" ] || cp "$f" "$f.phx-bak"
  if "$NODE" -e '
      var fs = require("fs");
      var file = process.argv[1], ep = process.argv[2];
      var j = JSON.parse(fs.readFileSync(file, "utf8"));
      function setEp(o){ if (o && typeof o === "object" && typeof o.endpoint === "string"){ o.endpoint = ep; if ("globalEndpoint" in o) o.globalEndpoint = true; } }
      if (j.rules)    Object.keys(j.rules).forEach(function(k){ setEp(j.rules[k]); });
      if (j.patterns) Object.keys(j.patterns).forEach(function(k){ setEp(j.patterns[k]); });
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    ' "$f" "$ENDPOINT"; then
    echo "repointed: $f  ->  $ENDPOINT"
    changed=$((changed + 1))
  else
    echo "FAILED:    $f  (restoring backup)"; cp "$f.phx-bak" "$f" 2>/dev/null || true
  fi
done

echo "done."
echo "verify: jibo-get-update --credentials /var/jibo/credentials.json --subsystem os --version 3.3.4"
