#!/usr/bin/env bash
# Create and activate an immutable native Phoenix release.
#
# The script is intentionally run from a clean repository clone on the server,
# not from the active `current` symlink.  It creates a detached Git worktree,
# installs exactly the lockfile's production dependencies, atomically replaces
# `current`, restarts the service, and rolls the symlink back if local health
# checks fail.  It never touches PHOENIX_DATA_DIR, the environment file, or old
# releases; those are durable operator-owned state.
#
# Typical production use:
#   cd /opt/phoenix
#   git pull --ff-only origin main
#   sudo PHOENIX_RELEASE_ROOT=/opt/phoenix/releases \
#     PHOENIX_CURRENT_LINK=/opt/phoenix/current \
#     PHOENIX_SERVICE=phoenix \
#     scripts/deploy-native-release.sh origin/main
#
# Set PHOENIX_DEPLOY_NO_RESTART=1 to stage and inspect a release without
# changing the live service.  The supplied revision must resolve to a commit;
# branch names are resolved once to their immutable SHA before a release is
# created.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY="${PHOENIX_RELEASE_REPOSITORY:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
RELEASE_ROOT="${PHOENIX_RELEASE_ROOT:-$REPOSITORY/releases}"
CURRENT_LINK="${PHOENIX_CURRENT_LINK:-$REPOSITORY/current}"
SERVICE="${PHOENIX_SERVICE:-phoenix}"
NO_RESTART="${PHOENIX_DEPLOY_NO_RESTART:-0}"
REVISION="${1:-HEAD}"
NPM_BIN="${PHOENIX_NPM_BIN:-$(command -v npm 2>/dev/null || true)}"

die() { echo "release deploy: $*" >&2; exit 2; }

[[ -d "$REPOSITORY/.git" || -f "$REPOSITORY/.git" ]] || die "not a Git checkout: $REPOSITORY"
[[ "$RELEASE_ROOT" = /* && "$CURRENT_LINK" = /* ]] || die "release root and current link must be absolute paths"
[[ "$NO_RESTART" = 0 || "$NO_RESTART" = 1 ]] || die "PHOENIX_DEPLOY_NO_RESTART must be 0 or 1"
[[ -n "$NPM_BIN" && -x "$NPM_BIN" ]] \
  || die "npm is not on PATH; set PHOENIX_NPM_BIN to the production Node installation's npm binary"
# NVM's npm launcher uses `#!/usr/bin/env node`.  Adding the selected npm
# directory to PATH keeps its Node interpreter paired with npm even when this
# script runs through sudo, whose secure_path intentionally omits user NVM dirs.
PATH="$(dirname "$NPM_BIN"):$PATH"
export PATH

COMMIT="$(git -C "$REPOSITORY" rev-parse --verify "${REVISION}^{commit}")" \
  || die "revision does not resolve to a commit: $REVISION"
RELEASE_DIR="$RELEASE_ROOT/$COMMIT"

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  die "refusing to replace a non-symlink current path: $CURRENT_LINK"
fi

mkdir -p "$RELEASE_ROOT"

if [[ -e "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/.git" || -d "$RELEASE_DIR/.git" ]] \
    || die "release path exists but is not a Git worktree: $RELEASE_DIR"
  EXISTING="$(git -C "$RELEASE_DIR" rev-parse HEAD)" || die "cannot read existing release: $RELEASE_DIR"
  [[ "$EXISTING" = "$COMMIT" ]] || die "release path belongs to another commit: $RELEASE_DIR"
else
  git -C "$REPOSITORY" worktree add --detach "$RELEASE_DIR" "$COMMIT"
fi

# `npm ci` is deliberately confined to the new, inactive worktree.  Lifecycle
# hooks are disabled because this repository's prepare hook edits Git hooks and
# does not contribute to a production runtime.
if [[ ! -d "$RELEASE_DIR/node_modules" ]]; then
  "$NPM_BIN" --prefix "$RELEASE_DIR" ci --omit=dev --ignore-scripts
fi

[[ -x "$RELEASE_DIR/scripts/run-compose-stack.sh" ]] \
  || die "release is missing its native launcher: $RELEASE_DIR"
bash -n "$RELEASE_DIR/scripts/run-compose-stack.sh"

PREVIOUS=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS="$(readlink -f "$CURRENT_LINK")"
  [[ -d "$PREVIOUS" ]] || die "current link target does not exist: $PREVIOUS"
fi

NEXT_LINK="${CURRENT_LINK}.next.$$"
cleanup_next() { [[ -L "$NEXT_LINK" ]] && unlink "$NEXT_LINK" || true; }
trap cleanup_next EXIT
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT_LINK"

rollback() {
  echo "release deploy: activation failed; restoring the previous release" >&2
  if [[ -n "$PREVIOUS" ]]; then
    ln -s "$PREVIOUS" "$NEXT_LINK"
    mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
    systemctl restart "$SERVICE" || true
  else
    unlink "$CURRENT_LINK" || true
  fi
}

if [[ "$NO_RESTART" = 1 ]]; then
  trap - EXIT
  echo "release deploy: staged and activated $COMMIT (restart skipped)"
  exit 0
fi

if ! systemctl restart "$SERVICE"; then
  rollback
  exit 1
fi

# All these listeners are loopback-only.  Requiring each one makes a release
# fail closed when the launcher is alive but a child process exited immediately.
HEALTH_URLS="${PHOENIX_HEALTHCHECK_URLS:-http://127.0.0.1:9000/healthcheck http://127.0.0.1:9010/healthcheck http://127.0.0.1:9011/healthcheck http://127.0.0.1:9012/healthcheck}"
healthy=0
for _attempt in $(seq 1 20); do
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
