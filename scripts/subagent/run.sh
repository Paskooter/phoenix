#!/usr/bin/env bash
# Drive an OpenCode CLI subagent so a transient upstream fault does not lose the work.
#
# THE FAILURE THIS EXISTS FOR
# OpenRouter is an aggregator. It commits HTTP 200 and starts streaming, and one
# of its upstream hosts can then die mid-body. The failure rides INSIDE the
# stream as a 502 chunk naming the host:
#
#   Upstream error from Together: Stream error: h2 protocol error:
#   error reading a body from connection
#
# So it is not an HTTP error the client can catch, and it is not the agent
# failing. Two runs were lost to this with their work already on disk: one had
# made 62 archive tool calls, the other had written the code and captured its
# test output and died while assembling the report.
#
# THREE THINGS FIX IT, IN ORDER OF IMPORTANCE
#
#  1. RESUME, don't restart. `--continue` picks the session back up with its
#     context intact, so a mid-stream death costs one turn, not the whole task.
#     Restarting from the prompt throws away everything the agent already did.
#  2. Pin provider routing. ~/.config/opencode/opencode.json now sets
#     options.provider.ignore = ["Together"] per model. OpenRouter re-routes to
#     another host rather than the one cutting streams.
#  3. Detect properly. `--format json` emits machine-readable events, so the
#     supervisor tests for the error instead of grepping ANSI-coloured prose.
#
# Also: --auto, because a permission prompt in a non-interactive run is a
# silent stall. Two subagents were auto-rejected on their first MCP and /tmp
# calls before the config allowed them.
#
# Usage:
#   run.sh <name> <prompt-file> [model] [max-attempts]
#
# Writes /tmp/<name>/{run.log,events.jsonl,status}. Exit 0 only if the agent
# finished a turn without a fatal upstream error.
set -uo pipefail

NAME="${1:?usage: run.sh <name> <prompt-file> [model] [max-attempts]}"
PROMPT_FILE="${2:?prompt file required}"
MODEL="${3:-openrouter/deepseek/deepseek-v4-flash-0731}"
MAX_ATTEMPTS="${4:-5}"
WORKDIR="${SUBAGENT_DIR:-/home/shell/work/phoenix}"
OUT="/tmp/${NAME}"

mkdir -p "$OUT"
: > "$OUT/events.jsonl"
echo "running" > "$OUT/status"

# Errors worth resuming for: the upstream cut the stream, or the aggregator is
# shedding load. NOT worth resuming: a bad prompt or an auth failure, which will
# fail identically forever.
TRANSIENT='h2 protocol error|Stream error|Upstream error|provider_unavailable|502|503|429|overloaded|ECONNRESET|socket hang up'

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "=== attempt $attempt/$MAX_ATTEMPTS ($(date -Is)) ===" >> "$OUT/run.log"

  if [ "$attempt" -eq 1 ]; then
    timeout 3000 opencode run --auto --format json --model "$MODEL" \
      "$(cat "$PROMPT_FILE")" >> "$OUT/events.jsonl" 2>> "$OUT/run.log"
  else
    # Resume: the session keeps everything the previous attempt established.
    timeout 3000 opencode run --auto --format json --model "$MODEL" --continue \
      "Your previous turn was cut off by an upstream transport error, not by anything you did. Continue exactly where you left off. Do not restart the task or redo completed work." \
      >> "$OUT/events.jsonl" 2>> "$OUT/run.log"
  fi
  rc=$?

  # The fault appears in the event stream, not the exit code, so check both.
  if grep -qiE "$TRANSIENT" "$OUT/events.jsonl" "$OUT/run.log" 2>/dev/null \
     && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    backoff=$(( attempt * 15 ))
    echo "transient upstream fault; resuming in ${backoff}s" >> "$OUT/run.log"
    # Consume the marker so the next pass tests only new output.
    : > "$OUT/events.jsonl"
    sleep "$backoff"
    attempt=$(( attempt + 1 ))
    continue
  fi

  if [ "$rc" -eq 0 ]; then
    echo "ok" > "$OUT/status"
    echo "=== finished cleanly on attempt $attempt ===" >> "$OUT/run.log"
    exit 0
  fi

  echo "exit $rc, not a transient fault" >> "$OUT/run.log"
  break
done

echo "failed" > "$OUT/status"
exit 1
