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

# Phoenix extension (not in the reference contract): the OTA update server. A robot points
# its Update endpoint here to pull firmware in place. Serves packages/ota/data (build them
# with scripts/build-ota-packages.sh). Disable with OTA=0.
if [ "${OTA:-1}" != "0" ]; then
  PORT=9010 ETCO_ota_publicUrl="${OTA_PUBLIC_URL:-}" \
    node packages/ota/src/index.js    > /tmp/phx-compose-ota.log     2>&1 &
fi

# Phoenix extension: the account service — web portal + OOBE pairing + per-robot hub-token
# issuance (CLASSIC-SERVICES.md / OOBE-PORTAL-HANDOFF.md). Disable with ACCOUNT=0.
ACCOUNT_URL=""
if [ "${ACCOUNT:-1}" != "0" ]; then
  # Empty pass-throughs fall back to .env (the account service loads it via @phoenix/common; the
  # dotenv loader fills unset OR empty-string keys). HUB_TOKEN_SECRET keeps its dev default so the
  # hub + account agree out of the box. A non-empty value exported in the shell still wins.
  PORT=9011 \
  HUB_TOKEN_SECRET="${HUB_TOKEN_SECRET:-dev-hub-token-secret}" \
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  ETCO_account_region="${ETCO_account_region:-}" \
  ETCO_account_secureCookies="${ETCO_account_secureCookies:-}" \
  NET_ota=localhost:9010 \
    node packages/account/src/index.js > /tmp/phx-compose-account.log 2>&1 &
  ACCOUNT_URL="http://localhost:9011"
fi

PORT=9000 \
ETCO_hub_skillsConfig=skills-native.json \
ETCO_hub_disableAuth="${DISABLE_AUTH:-true}" \
ETCO_hub_accountUrl="${ETCO_hub_accountUrl:-$ACCOUNT_URL}" \
ETCO_server_hubTokenSecret="${HUB_TOKEN_SECRET:-dev-hub-token-secret}" \
ETCO_server_parakeetUrl="$PARAKEET_URL" \
NET_parser=localhost:9005 \
NET_history=localhost:9006 \
NET_data=localhost:9007 \
  node packages/gateway/src/index.js  > /tmp/phx-compose-hub.log     2>&1 &

# Phoenix extension: the classic-service entrypoint — the robot's SINGLE front door for every
# Classic Service (dispatch by X-Amz-Target prefix; in-process log/robot/notification/key/push +
# tier-3 stubs, proxying OOBE/account/settings -> account and Update -> ota). Disable with
# CLASSIC=0. Point the robot's region (https://<region>.jibo.com) at this one port.
CLASSIC_NOTE=""
if [ "${CLASSIC:-1}" != "0" ]; then
  PORT=9012 \
  NET_account=localhost:9011 \
  NET_ota=localhost:9010 \
    node packages/classic/src/index.js > /tmp/phx-compose-classic.log 2>&1 &
  CLASSIC_NOTE=" · classic-entrypoint:9012"
fi

echo "compose-contract stack: hub:9000 report:9003 chitchat:9004 parser:9005 history:9006 lasso:9007 answer:9009"
echo "ext: ota:9010 (OTA update server)${ACCOUNT_URL:+ · account+portal:9011}${CLASSIC_NOTE}"
[ -n "$ACCOUNT_URL" ] && echo "portal: http://localhost:9011  (admin at /#/admin — needs ADMIN_PASSWORD)"
[ -n "$CLASSIC_NOTE" ] && echo "robot front door: http://localhost:9012  (point the robot region here)"
echo "logs: /tmp/phx-compose-*.log"
wait
