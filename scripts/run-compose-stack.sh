#!/usr/bin/env bash
# Native (no-docker) equivalent of docker-compose.yml — SAME host-port + env contract:
#   hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005 · history 9006 ·
#   lasso 9007 · color-skill 9008 · answer-skill 9009 · example-skill 9013 · template-skill 9014
# The hub resolves cloud skills via skills-native.json (localhost:<port> per skill).
# Verify the contract with: node scripts/verify-compose-contract.mjs
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/load-dotenv.sh
source "$SCRIPT_DIR/load-dotenv.sh"
cd "$SCRIPT_DIR/.."

say() { printf '[phoenix] %s\n' "$*" >&2; }
die() { printf '[phoenix] ERROR: %s\n' "$*" >&2; exit 1; }

# Load KEY=VALUE data without executing the file as shell code. An explicit
# file can be selected with PHOENIX_ENV_FILE; the normal developer workflow is
# still `cp .env.example .env` followed by this launcher.
load_phoenix_env "${PHOENIX_ENV_FILE:-.env}" || die "could not parse dotenv file"
PORTS_FILE="$SCRIPT_DIR/parity-robot/ports.json"
HUB_PORT="$(phoenix_canonical_port "$PORTS_FILE")" || die "invalid canonical hub-port configuration"

PHOENIX_DEV_MODE="${PHOENIX_DEV_MODE:-0}"
case "$PHOENIX_DEV_MODE" in 0|1) ;; *) die "PHOENIX_DEV_MODE must be 0 or 1" ;; esac
DISABLE_AUTH="${DISABLE_AUTH:-false}"
case "${DISABLE_AUTH,,}" in
  true|1|yes)
    [ "$PHOENIX_DEV_MODE" = 1 ] || die "auth may be disabled only with explicit PHOENIX_DEV_MODE=1"
    ;;
esac
if [ -z "${HUB_TOKEN_SECRET:-}" ]; then
  if [ "$PHOENIX_DEV_MODE" = 1 ]; then
    HUB_TOKEN_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')" || die "could not generate an ephemeral development secret"
    say "PHOENIX_DEV_MODE=1: using an ephemeral hub secret for this process"
  else
    die "HUB_TOKEN_SECRET must be set (or select PHOENIX_DEV_MODE=1 for local development)"
  fi
fi

LLM_URL="${LLM_URL:-}"
LLM_MODEL="${LLM_MODEL:-google/gemma-4-e4b}"
PARAKEET_URL="${PARAKEET_URL:-}"
REPORT_PREFS_FROM_CONFIG="${prefsFromConfig:-${PREFS_FROM_CONFIG:-false}}"
REPORT_LASSO="${NET_lasso:-localhost:9007}"
REPORT_SETTINGS="${NET_settings:-${NET_SETTINGS:-settings.jibo.aws}}"
CLASSIC_PUBLIC_URL="${CLASSIC_PUBLIC_URL:-${ETCO_classic_publicUrl:-}}"
PHOTO_PUBLIC_URL="${PHOTO_PUBLIC_URL:-${ETCO_account_photoBaseUrl:-$CLASSIC_PUBLIC_URL}}"
PHOTO_DIRECTORY="${PHOTO_DIRECTORY:-${ETCO_account_photoDirectory:-$PWD/packages/account/data/member-photos}}"

PORT=9005 ETCO_parser_llmUrl="$LLM_URL" ETCO_parser_llmModel="$LLM_MODEL" \
  node packages/nlu/src/index.js      > /tmp/phx-compose-parser.log  2>&1 &
PORT=9006 node packages/history/src/index.js  > /tmp/phx-compose-history.log 2>&1 &
PORT=9007 node packages/data/src/index.js     > /tmp/phx-compose-lasso.log   2>&1 &

# Skill services select one skill at /v1/main. The shared NET_skills profile still uses the
# combined host when no PHOENIX_SKILL_ID is supplied.
PORT=9009 ETCO_server_port=9009 PHOENIX_SKILL_ID=answer-skill NET_data=localhost:9007 ETCO_answer_llmUrl="$LLM_URL" ETCO_answer_llmModel="$LLM_MODEL" \
  node packages/skills/src/index.js   > /tmp/phx-compose-answer.log  2>&1 &
PORT=9003 ETCO_server_port=9003 PHOENIX_SKILL_ID=report-skill NET_lasso="$REPORT_LASSO" NET_settings="$REPORT_SETTINGS" prefsFromConfig="$REPORT_PREFS_FROM_CONFIG" \
  node packages/skills/src/index.js   > /tmp/phx-compose-report.log  2>&1 &
PORT=9004 ETCO_server_port=9004 PHOENIX_SKILL_ID=chitchat-skill NET_data=localhost:9007 \
  node packages/skills/src/index.js   > /tmp/phx-compose-chitchat.log 2>&1 &
PORT=9008 ETCO_server_port=9008 PHOENIX_SKILL_ID=color-skill \
  node packages/skills/src/index.js   > /tmp/phx-compose-color.log 2>&1 &
# Phoenix deployment adapters (acceptance H-09): the example/template replacement skills are
# independently deployable at the reference /v1/main URL but are not index-routed, so they get
# no registry entry. 9013/9014 are the next free reference-shaped host ports after classic:9012.
PORT=9013 ETCO_server_port=9013 PHOENIX_SKILL_ID=example-skill \
  node packages/skills/src/index.js   > /tmp/phx-compose-example.log 2>&1 &
PORT=9014 ETCO_server_port=9014 PHOENIX_SKILL_ID=template-skill \
  node packages/skills/src/index.js   > /tmp/phx-compose-template.log 2>&1 &

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
  # The same explicit secret is supplied to account and hub. There is no
  # built-in authentication secret.
  PORT=9011 \
  HUB_TOKEN_SECRET="$HUB_TOKEN_SECRET" \
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  ETCO_account_region="${ETCO_account_region:-}" \
  ETCO_account_secureCookies="${ETCO_account_secureCookies:-}" \
  ETCO_account_photoBaseUrl="$PHOTO_PUBLIC_URL" \
  ETCO_account_photoDirectory="$PHOTO_DIRECTORY" \
  NET_ota=localhost:9010 \
    node packages/account/src/index.js > /tmp/phx-compose-account.log 2>&1 &
  ACCOUNT_URL="http://localhost:9011"
fi

PORT="$HUB_PORT" \
ETCO_hub_skillsConfig=skills-native.json \
ETCO_hub_disableAuth="$DISABLE_AUTH" \
ETCO_hub_accountUrl="${ETCO_hub_accountUrl:-$ACCOUNT_URL}" \
ETCO_server_hubTokenSecret="$HUB_TOKEN_SECRET" \
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
  ETCO_classic_publicUrl="$CLASSIC_PUBLIC_URL" \
    node packages/classic/src/index.js > /tmp/phx-compose-classic.log 2>&1 &
  CLASSIC_NOTE=" · classic-entrypoint:9012"
fi

echo "compose-contract stack: hub:${HUB_PORT} report:9003 chitchat:9004 parser:9005 history:9006 lasso:9007 color:9008 answer:9009 example:9013 template:9014"
echo "ext: ota:9010 (OTA update server)${ACCOUNT_URL:+ · account+portal:9011}${CLASSIC_NOTE}"
[ -n "$ACCOUNT_URL" ] && echo "portal: http://localhost:9011  (admin at /#/admin — needs ADMIN_PASSWORD)"
[ -n "$CLASSIC_NOTE" ] && echo "robot front door: http://localhost:9012  (point the robot region here)"
echo "logs: /tmp/phx-compose-*.log"
wait
