#!/usr/bin/env bash
set -u
CANDIDATE_ROOT="${CANDIDATE_ROOT:-/home/shell/work/phoenix/.parity/worktrees/a04-state-sequences-20260910}"
EVIDENCE="${EVIDENCE_ROOT:-$CANDIDATE_ROOT/.parity/reviews/a04-state-sequences-20260910}"
COMPILED="${COMPILED_ROOT:-/home/shell/work/phoenix/.parity/reviews/a04-loop-record-validation-node8-20260908/exact-source-harness/compiled}"
CLIENT="${CLIENT_ROOT:-/home/shell/work/phoenix/.parity/yarn-cache/v1/npm-@jibo/jibo-server-client-3.0.110-dc0962bd91de9392ecf2ef6f96c6d9f7642d23e8}"
DEPS="${NODE8_DEPS:-/home/shell/work/phoenix/.parity/reviews/a06-original-runtime/node_modules}"
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

echo "== source controller sequences (Node 8) =="
timeout 120s docker run --rm --name "a04-state-seq-source-$$" \
  -v "$COMPILED:/source/compiled:ro" \
  -v "$CANDIDATE_ROOT/scripts/parity-a04/state-sequences-source.cjs:/review/state-sequences-source.cjs:ro" \
  -v "$EVIDENCE:/out:rw" \
  -v "$DEPS:/deps:ro" \
  -e NODE_PATH=/deps \
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

echo "== original generated client sequences (Node 8) =="
timeout 180s docker run --rm --name "a04-state-seq-client-$$" --network host \
  -v "$EVIDENCE:/review:rw" \
  -v "$CLIENT:/client:ro" \
  -v "$DEPS:/deps:ro" \
  -v "$CANDIDATE_ROOT/scripts/parity-a04/state-sequences-client.cjs:/review/state-sequences-client.cjs:ro" \
  -e NODE_PATH=/deps \
  "$IMAGE" node /review/state-sequences-client.cjs \
  >"$EVIDENCE/client.stdout" 2>"$EVIDENCE/client.stderr"
client_status=$?
printf '%s\n' "$client_status" >"$EVIDENCE/client.exit"
sleep 1
cleanup
trap - EXIT
if test "$client_status" -ne 0; then
  echo "client run failed: $client_status" >&2
  exit "$client_status"
fi

echo "source_status=$source_status client_status=$client_status image=$IMAGE"
exit 0
