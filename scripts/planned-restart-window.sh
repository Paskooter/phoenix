#!/usr/bin/env bash
# Mark a planned restart so the public /health check keeps answering while the
# service comes back (deploy/nginx/phoenix-health.conf).
#
#   planned-restart-window.sh open    # just before a planned restart
#   planned-restart-window.sh close   # once the restarted service is healthy
#
# `open` writes one small file per 10-second slot from now until the grace
# period ends. nginx serves the file named after the CURRENT slot only when the
# account service cannot answer, so the window expires by itself: if the
# restart never finishes, or this script is never asked to close it, the names
# stop matching within 60-70 seconds and /health reports the outage. Nothing has
# to run later to end the window. A crash outside a planned restart has no files
# at all and is reported straight away.
#
# This never blocks or fails a deployment: it prints nothing on success, any
# problem only prints a warning, and the restart goes ahead exactly as before.
set -uo pipefail

DIR="${PHOENIX_RESTART_WINDOW_DIR:-/run/phoenix-restart}"
GRACE="${PHOENIX_RESTART_WINDOW_SECONDS:-60}"
BODY='{"status":"ok","restarting":true}'

warn() { echo "planned restart window: $*" >&2; exit 0; }

[[ "$DIR" = /* ]] || warn "directory must be an absolute path; skipped"
# Bounded on purpose: the window may hide a planned restart, never an outage.
[[ "$GRACE" =~ ^[0-9]+$ && "$GRACE" -ge 10 && "$GRACE" -le 120 ]] \
  || warn "grace must be 10-120 seconds; skipped"

clear_window() { rm -f "$DIR"/window-*.json "$DIR"/.window-*.tmp 2>/dev/null || true; }

case "${1:-}" in
  open)
    # nginx workers only read these files; keep the directory world-readable.
    install -d -m 0755 "$DIR" 2>/dev/null || warn "cannot create $DIR; skipped"
    clear_window
    now="$(date +%s)"
    first=$(( now / 10 ))
    last=$(( (now + GRACE - 1) / 10 ))
    for (( slot = first; slot <= last; slot++ )); do
      tmp="$DIR/.window-$slot.tmp"
      printf '%s\n' "$BODY" > "$tmp" 2>/dev/null && chmod 0644 "$tmp" \
        && mv -f "$tmp" "$DIR/window-$slot.json" || { clear_window; warn "cannot write $DIR; skipped"; }
    done
    ;;
  close)
    if [[ -d "$DIR" ]]; then clear_window; fi
    ;;
  *)
    echo "usage: $0 open|close" >&2
    exit 2
    ;;
esac
