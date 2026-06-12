#!/usr/bin/env bash
# Launch the full Phoenix stack + jibo-web-sim for manual browser testing.
# Gateway listens on 9000 (the sim's browser hard-codes the hub at <Server-field>:9000).
set -euo pipefail

PHX=/home/shell/work/phoenix
SIM=/home/shell/jibo-web-sim
SECRET="${HUB_AUTH_SECRET:-uHGhXhdXzBybGX7YHuEwAFZC}"   # sim's default; must match the gateway
SIM_PORT="${SIM_PORT:-8080}"

cd "$PHX"

# Backend services on their default ports (nlu 7011, data 7012, history 7013, skills 7014).
PORT=7011 node packages/nlu/src/index.js        > /tmp/phx-nlu.log     2>&1 &
PORT=7012 node packages/data/src/index.js        > /tmp/phx-data.log    2>&1 &
PORT=7013 node packages/history/src/index.js     > /tmp/phx-history.log 2>&1 &
# ETCO_answer_llmUrl: OpenAI-compatible endpoint for answer-skill (e.g. LM Studio
# serving Gemma: http://<host>:1234/v1). Passed through from the caller's env.
NET_data=localhost:7012 \
ETCO_answer_llmUrl="${ETCO_answer_llmUrl:-}" \
ETCO_answer_llmModel="${ETCO_answer_llmModel:-gemma-3}" \
  PORT=7014 node packages/skills/src/index.js    > /tmp/phx-skills.log  2>&1 &

# Server-side ASR (the sim's 🎤 button): the gateway POSTs captured speech to
# ${ETCO_server_parakeetUrl}/transcribe. Resolution order:
#   1. explicit ETCO_server_parakeetUrl from the caller's env
#   2. the real Parakeet host (REAL_PARAKEET, default the reference LAN box)
#      if it answers HTTP right now
#   3. the local mock (canned transcript; saves every WAV to /tmp/parakeet-rx
#      so you can audition the mic capture). MOCK_PARAKEET=0 disables it.
REAL_PARAKEET="${REAL_PARAKEET:-http://192.168.1.252:6972}"
if [[ -n "${ETCO_server_parakeetUrl:-}" ]]; then
  PARAKEET_URL="$ETCO_server_parakeetUrl"
elif curl -s -m 2 -o /dev/null "$REAL_PARAKEET/"; then
  PARAKEET_URL="$REAL_PARAKEET"
  echo "real Parakeet detected at $REAL_PARAKEET"
elif [[ "${MOCK_PARAKEET:-1}" != 0 ]]; then
  MOCK_TRANSCRIPT="${MOCK_TRANSCRIPT:-what time is it}" node scripts/mock-parakeet.js > /tmp/phx-parakeet.log 2>&1 &
  PARAKEET_URL="http://localhost:6972"
  echo "real Parakeet unreachable — using the mock (canned transcript)"
else
  PARAKEET_URL="http://localhost:6972"
fi

# Gateway on 9000, wired to the others, auth secret matching the sim.
ETCO_server_hubTokenSecret="$SECRET" \
ETCO_server_parakeetUrl="$PARAKEET_URL" \
NET_parser=localhost:7011 \
NET_skills=localhost:7014 \
NET_history=localhost:7013 \
NET_data=localhost:7012 \
  PORT=9000 node packages/gateway/src/index.js   > /tmp/phx-gateway.log 2>&1 &

# The sim web server. HTTPS=1 adds a self-signed listener on :8443 — the 🎤
# mic button needs a secure context, so use https://<this-host>:8443/ (accept
# the one-time cert warning) unless you're browsing via http://localhost.
cd "$SIM"
HUB_AUTH_SECRET="$SECRET" PORT="$SIM_PORT" HTTPS="${HTTPS:-1}" node server.js > /tmp/phx-sim.log 2>&1 &

echo "started: nlu:7011 data:7012 history:7013 skills:7014 gateway:9000 sim:$SIM_PORT (+https:8443)"
echo "ASR -> ${PARAKEET_URL}/transcribe"
echo "mic testing: open https://<this-host>:8443/ (self-signed; accept the warning) or http://localhost:$SIM_PORT/ — plain http://<ip>:$SIM_PORT has no mic API"
echo "logs in /tmp/phx-*.log ; stop all with: pkill -f 'packages/(gateway|nlu|skills|history|data)/src/index.js'; pkill -f 'jibo-web-sim.*server.js'; pkill -f mock-parakeet"
wait
