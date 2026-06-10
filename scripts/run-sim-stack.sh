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

# Gateway on 9000, wired to the others, auth secret matching the sim.
ETCO_server_hubTokenSecret="$SECRET" \
NET_parser=localhost:7011 \
NET_skills=localhost:7014 \
NET_history=localhost:7013 \
NET_data=localhost:7012 \
  PORT=9000 node packages/gateway/src/index.js   > /tmp/phx-gateway.log 2>&1 &

# The sim web server.
cd "$SIM"
HUB_AUTH_SECRET="$SECRET" PORT="$SIM_PORT" node server.js > /tmp/phx-sim.log 2>&1 &

echo "started: nlu:7011 data:7012 history:7013 skills:7014 gateway:9000 sim:$SIM_PORT"
echo "logs in /tmp/phx-*.log ; stop all with: pkill -f 'packages/(gateway|nlu|skills|history|data)/src/index.js'; pkill -f 'jibo-web-sim.*server.js'"
wait
