#!/usr/bin/env bash
# Native (no-docker) equivalent of docker-compose.yml — SAME host-port + env contract:
#   hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005 · history 9006 ·
#   lasso 9007 · answer-skill 9009
# The hub resolves cloud skills via skills-native.json (localhost:<port> per skill).
# Verify the contract with: node scripts/verify-compose-contract.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

LLM_URL="${LLM_URL:-}"
LLM_MODEL="${LLM_MODEL:-google/gemma-4-e4b}"
PARAKEET_URL="${PARAKEET_URL:-}"

PORT=9005 ETCO_parser_llmUrl="$LLM_URL" ETCO_parser_llmModel="$LLM_MODEL" \
  node packages/nlu/src/index.js      > /tmp/phx-compose-parser.log  2>&1 &
PORT=9006 node packages/history/src/index.js  > /tmp/phx-compose-history.log 2>&1 &
PORT=9007 node packages/data/src/index.js     > /tmp/phx-compose-lasso.log   2>&1 &

# Skill services (each hosts every skill at /v1/<id>/main; the hub routes by port).
PORT=9009 NET_data=localhost:9007 ETCO_answer_llmUrl="$LLM_URL" ETCO_answer_llmModel="$LLM_MODEL" \
  node packages/skills/src/index.js   > /tmp/phx-compose-answer.log  2>&1 &
PORT=9003 NET_data=localhost:9007 ETCO_report_prefsFromConfig="${PREFS_FROM_CONFIG:-}" \
  node packages/skills/src/index.js   > /tmp/phx-compose-report.log  2>&1 &
PORT=9004 NET_data=localhost:9007 \
  node packages/skills/src/index.js   > /tmp/phx-compose-chitchat.log 2>&1 &

PORT=9000 \
ETCO_hub_skillsConfig=skills-native.json \
ETCO_hub_disableAuth="${DISABLE_AUTH:-true}" \
ETCO_server_hubTokenSecret="${HUB_TOKEN_SECRET:-dev-hub-token-secret}" \
ETCO_server_parakeetUrl="$PARAKEET_URL" \
NET_parser=localhost:9005 \
NET_history=localhost:9006 \
NET_data=localhost:9007 \
  node packages/gateway/src/index.js  > /tmp/phx-compose-hub.log     2>&1 &

echo "compose-contract stack: hub:9000 report:9003 chitchat:9004 parser:9005 history:9006 lasso:9007 answer:9009"
echo "logs: /tmp/phx-compose-*.log"
wait
