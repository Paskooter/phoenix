#!/usr/bin/env bash
# Internal activation phase. Use deploy-native-release.sh, which stages the
# release, holds the deployment lock and obtains the quiet-window lease first.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RELEASE_DIR="${1:?release directory required}"
CURRENT_LINK="${2:?current link required}"
SERVICE="${3:?service required}"
PREVIOUS="${4:-}"
COMMIT="$(git -C "$RELEASE_DIR" rev-parse HEAD)"
LEASE_ARGS=(--verify)
[[ "${PHOENIX_DEPLOY_LEGACY:-0}" = 1 ]] && LEASE_ARGS+=(--legacy)
node "$SCRIPT_DIR/deployment-quiescence.mjs" "${LEASE_ARGS[@]}"
[[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" = "$PREVIOUS" ]] || {
  echo "release deploy: current release changed while waiting; refusing activation" >&2
  exit 1
}
HEALTH_ATTEMPTS="${PHOENIX_HEALTHCHECK_ATTEMPTS:-90}"
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid healthcheck attempts" >&2; exit 2; }

NEXT_LINK="${CURRENT_LINK}.next.$$"
cleanup_next() { [[ -L "$NEXT_LINK" ]] && unlink "$NEXT_LINK" || true; }
trap cleanup_next EXIT
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT_LINK"

rollback() {
  # If the guard died, admission may already have resumed. Never perform a
  # second restart without it; leave the current release for a guarded retry.
  if ! node "$SCRIPT_DIR/deployment-quiescence.mjs" --verify-owner; then
    echo "release deploy: guard lease lost; automatic rollback restart refused" >&2
    return 1
  fi
  echo "release deploy: activation failed; restoring the previous release" >&2
  if [[ -n "$PREVIOUS" ]]; then
    ln -s "$PREVIOUS" "$NEXT_LINK"
    mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
    systemctl restart "$SERVICE" || true
  else
    unlink "$CURRENT_LINK" || true
  fi
}

if ! systemctl restart "$SERVICE"; then
  rollback
  exit 1
fi

# All these listeners are loopback-only.  Requiring each one makes a release
# fail closed when the launcher is alive but a child process exited immediately.
HEALTH_URLS="${PHOENIX_HEALTHCHECK_URLS:-http://127.0.0.1:9000/healthcheck http://127.0.0.1:9010/healthcheck http://127.0.0.1:9011/healthcheck http://127.0.0.1:9012/healthcheck}"
healthy=0
# A populated OTA catalog hashes large OS/services/skill archives before it
# starts listening. Give that bounded startup work enough time to finish; a
# too-short window falsely rolls back an otherwise healthy release.
for _attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if systemctl is-active --quiet "$SERVICE"; then
    all_ok=1
    for url in $HEALTH_URLS; do
      # A brief connection refusal is normal while systemd is replacing the
      # process tree. Keep retries quiet; only the final rollback message is
      # actionable to an operator.
      curl --fail --silent --connect-timeout 2 --max-time 5 "$url" >/dev/null || all_ok=0
    done
    if [[ "$all_ok" = 1 ]]; then healthy=1; break; fi
  fi
  sleep 1
done

if [[ "$healthy" != 1 ]]; then
  rollback
  exit 1
fi

trap - EXIT
echo "release deploy: active $COMMIT"
echo "release deploy: previous ${PREVIOUS:-none}"
