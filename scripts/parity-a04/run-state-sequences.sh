#!/usr/bin/env bash
set -u
CANDIDATE_ROOT="${CANDIDATE_ROOT:-/home/shell/work/phoenix/.parity/worktrees/a04-auth-deployment-20260911}"
EVIDENCE="${EVIDENCE_ROOT:-$CANDIDATE_ROOT/.parity/reviews/a04-auth-deployment-20260911}"
HARNESS="${SOURCE_HARNESS:-/home/shell/work/phoenix/.parity/reviews/a04-loop-record-validation-node8-20260908/exact-source-harness}"
COMPILED="${COMPILED_ROOT:-$HARNESS/compiled}"
CLIENT="${CLIENT_ROOT:-/home/shell/work/phoenix/.parity/yarn-cache/v1/npm-@jibo/jibo-server-client-3.0.110-dc0962bd91de9392ecf2ef6f96c6d9f7642d23e8}"
DEPS="${NODE8_DEPS:-/home/shell/work/phoenix/.parity/reviews/a06-original-runtime/node_modules}"
BINARY_DEPS="${NODE8_BINARY_DEPS:-/home/shell/work/phoenix/.parity/reviews/a04-source-methods-20260907/node_modules}"
PINFILE="${PINFILE:-$CANDIDATE_ROOT/docs/parity/evidence/2026-09-05/compatibility-pins.json}"
IMAGE=$(python3 - "$PINFILE" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))['nodeDockerImage']['resolved']
if '@' not in value:
    value = 'node@' + value
print(value)
PY
)

mkdir -p "$EVIDENCE"
chmod 700 "$EVIDENCE"
rm -f "$EVIDENCE/server-ready.json" "$EVIDENCE/restart-ready.json" \
  "$EVIDENCE/sdk-results.json" "$EVIDENCE/sdk-post-restart.json" \
  "$EVIDENCE/pre-restart.json" "$EVIDENCE/post-restart.json" \
  "$EVIDENCE/server-captures.json" \
  "$EVIDENCE/account-store.json" "$EVIDENCE/classic-store.json" \
  "$EVIDENCE/classic-notifications.json" \
  "$EVIDENCE/account-invitation-events.json" "$EVIDENCE/classic-invitation-events.json"

echo "== source controller sequences (Node 8) =="
timeout 120s docker run --rm --name "a04-state-seq-source-$$" \
  -v "$HARNESS:/source:ro" \
  -v "$CANDIDATE_ROOT/scripts/parity-a04/state-sequences-source.cjs:/review/state-sequences-source.cjs:ro" \
  -v "$EVIDENCE:/out:rw" \
  -v "$DEPS:/deps:ro" \
  -v "$BINARY_DEPS:/binary:ro" \
  -e NODE_PATH=/deps:/binary \
  -e COMPILED_ROOT=/source/compiled \
  -e SEQUENCE_OUTPUT=/out/source-sequences.json \
  "$IMAGE" node /review/state-sequences-source.cjs \
  >"$EVIDENCE/source.stdout" 2>"$EVIDENCE/source.stderr"
source_status=$?
printf '%s\n' "$source_status" >"$EVIDENCE/source.exit"
if test "$source_status" -ne 0; then
  echo "source controller run failed: $source_status" >&2
  exit "$source_status"
fi

echo "== candidate Account/Classic server =="
export CANDIDATE_ROOT EVIDENCE_ROOT="$EVIDENCE"
node "$CANDIDATE_ROOT/scripts/parity-a04/state-sequences-server.mjs" \
  >"$EVIDENCE/server.stdout" 2>"$EVIDENCE/server.stderr" &
server_pid=$!
cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 120); do
  if test -s "$EVIDENCE/server-ready.json"; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if test "$ready" -ne 1; then
  echo 'server did not become ready' >&2
  exit 1
fi

run_client() {
  local phase="$1"
  local ready_file="$2"
  local output="$3"
  local log="$4"
  timeout 240s docker run --rm --name "a04-state-seq-client-${phase}-$$" --network host \
    -v "$EVIDENCE:/review:rw" \
    -v "$CLIENT:/client:ro" \
    -v "$DEPS:/deps:ro" \
    -v "$CANDIDATE_ROOT/scripts/parity-a04/state-sequences-client.cjs:/client-run/state-sequences-client.cjs:ro" \
    -e NODE_PATH=/deps \
    -e SEQUENCE_PHASE="$phase" \
    -e SEQUENCE_READY_FILE="$ready_file" \
    -e SEQUENCE_OUTPUT="$output" \
    "$IMAGE" node /client-run/state-sequences-client.cjs \
    >"$EVIDENCE/${log}.stdout" 2>"$EVIDENCE/${log}.stderr"
}

echo "== original generated client sequences (Node 8) =="
run_client pre /review/server-ready.json /review/sdk-results.json client
client_status=$?
printf '%s\n' "$client_status" >"$EVIDENCE/client.exit"
if test "$client_status" -ne 0; then
  echo "client pre-restart run failed: $client_status" >&2
  exit "$client_status"
fi

echo "== restart Account and Classic processes =="
kill -USR1 "$server_pid"
restarted=0
for _ in $(seq 1 120); do
  if test -s "$EVIDENCE/restart-ready.json"; then restarted=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if test "$restarted" -ne 1; then
  echo 'server did not restart' >&2
  exit 1
fi

echo "== original generated client post-restart sequences (Node 8) =="
run_client post /review/restart-ready.json /review/sdk-post-restart.json client-post
client_post_status=$?
printf '%s\n' "$client_post_status" >"$EVIDENCE/client-post.exit"
sleep 1
cleanup
trap - EXIT
if test "$client_post_status" -ne 0; then
  echo "client post-restart run failed: $client_post_status" >&2
  exit "$client_post_status"
fi

echo "source_status=$source_status client_status=$client_status client_post_status=$client_post_status image=$IMAGE"
exit 0
