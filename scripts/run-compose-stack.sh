#!/usr/bin/env bash
# Native (no-docker) equivalent of docker-compose.yml — SAME host-port + env contract:
#   hub 9000 · report-skill 9003 · chitchat-skill 9004 · parser 9005 · history 9006 ·
#   lasso 9007 · color-skill 9008 · answer-skill 9009 · example-skill 9013 · template-skill 9014
# The hub resolves cloud skills via skills-native.json (localhost:<port> per skill).
# Verify the contract with: node scripts/verify-compose-contract.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

# Opt-out seams (all additive — with every variable unset this script behaves exactly as
# before). Used by the R-02 install harness to run the stack hermetically:
#   --no-env            skip the .env source step entirely
#   PHOENIX_ENV_FILE    source this file instead of ./.env (PHOENIX_ENV_FILE=/dev/null = none)
#   PHOENIX_PORT_OFFSET shift every reference host port and localhost peer by N
#   PHOENIX_LOG_DIR     write the per-service logs here instead of /tmp

NO_ENV=0
for arg in "$@"; do
  case "$arg" in
    --no-env) NO_ENV=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Source .env so friendly names (PARAKEET_URL, LLM_URL, LLM_MODEL, …) are populated for the
# ETCO_*/NET_* mappings below. The node services already read .env via @phoenix/common's dotenv
# loader, but this bash launcher does NOT — without this, `${PARAKEET_URL:-}` etc. resolve empty
# and the hub silently falls back to mock ASR even though .env has a real PARAKEET_URL.
# `--no-env` and `PHOENIX_ENV_FILE=/dev/null` opt out so a verification run never depends on
# this machine's private .env (R-02 criterion 3).
if [ "$NO_ENV" -eq 0 ]; then
  ENV_FILE="${PHOENIX_ENV_FILE:-}"
  if [ -z "$ENV_FILE" ] && [ -f .env ]; then ENV_FILE=.env; fi
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
fi

OFFSET="${PHOENIX_PORT_OFFSET:-0}"
case "$OFFSET" in
  ''|*[!0-9]*) echo "invalid PHOENIX_PORT_OFFSET: $OFFSET" >&2; exit 2 ;;
esac
# Reference host port plus the offset (ref 9000-9014, spacing preserved). Container-side ports
# never leave 8080, so only the host-facing values and their localhost links shift.
p() { echo "$(( $1 + OFFSET ))"; }
LOG_DIR="${PHOENIX_LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"
# Every backgrounded service pid is registered so the final wait can report each process's real
# exit status (used by the R-02 shutdown check). Declared before use to satisfy `set -u`.
declare -A JOB_PIDS=()

# When the stack runs at an offset the hub's registry of per-skill localhost baseURLs has to
# follow. Generate the offset mirror of skills-native.json next to it, point ETCO_hub_skillsConfig
# at it, and remove it on exit (S-06 pins this directory to its committed file list, exactly as
# the R-01 runner does for its generated registry).
SKILLS_CONFIG=skills-native.json
if [ "$OFFSET" -ne 0 ]; then
  SKILLS_CONFIG="skills-native-offset-$OFFSET.json"
  SKILLS_RES="$PWD/packages/gateway/resources/skills"
  [ -f "$SKILLS_RES/skills-native.json" ] || { echo "ABORT: $SKILLS_RES/skills-native.json missing" >&2; exit 1; }
  node - "$SKILLS_RES/skills-native.json" "$SKILLS_RES/$SKILLS_CONFIG" "$OFFSET" >/dev/null <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const [src, dst, offset] = process.argv.slice(2);
const index = JSON.parse(readFileSync(src, 'utf8'));
for (const entry of index.skills) {
  if (typeof entry.baseURL === 'string') {
    entry.baseURL = entry.baseURL.replace(/:\d+$/, (m) => `:${Number(m.slice(1)) + Number(offset)}`);
  }
}
writeFileSync(dst, `${JSON.stringify(index, null, 2)}\n`);
EOF
  trap 'rm -f "$SKILLS_RES/$SKILLS_CONFIG"' EXIT
fi

LLM_URL="${LLM_URL:-}"
LLM_MODEL="${LLM_MODEL:-google/gemma-4-e4b}"
PARAKEET_URL="${PARAKEET_URL:-}"
REPORT_PREFS_FROM_CONFIG="${prefsFromConfig:-${PREFS_FROM_CONFIG:-false}}"
REPORT_LASSO="${NET_lasso:-localhost:$(p 9007)}"
REPORT_SETTINGS="${NET_settings:-${NET_SETTINGS:-settings.jibo.aws}}"
CLASSIC_PUBLIC_URL="${CLASSIC_PUBLIC_URL:-${ETCO_classic_publicUrl:-}}"
PHOTO_PUBLIC_URL="${PHOTO_PUBLIC_URL:-${ETCO_account_photoBaseUrl:-$CLASSIC_PUBLIC_URL}}"
PHOTO_DIRECTORY="${PHOTO_DIRECTORY:-${ETCO_account_photoDirectory:-$PWD/packages/account/data/member-photos}}"
GQA_ATTRIBUTION_FILE="${GQA_ATTRIBUTION_FILE:-${ETCO_gqa_attributionFile:-$PWD/packages/account/data/gqa-attribution.json}}"

PORT=$(p 9005) ETCO_parser_llmUrl="$LLM_URL" ETCO_parser_llmModel="$LLM_MODEL" \
  node packages/nlu/src/index.js      > "$LOG_DIR/phx-compose-parser.log"   2>&1 & JOB_PIDS[parser]=$!
PORT=$(p 9006) node packages/history/src/index.js  > "$LOG_DIR/phx-compose-history.log"  2>&1 & JOB_PIDS[history]=$!
PORT=$(p 9007) node packages/data/src/index.js     > "$LOG_DIR/phx-compose-lasso.log"    2>&1 & JOB_PIDS[lasso]=$!

# Skill services select one skill at /v1/main. The shared NET_skills profile still uses the
# combined host when no PHOENIX_SKILL_ID is supplied.
PORT=$(p 9009) ETCO_server_port=$(p 9009) PHOENIX_SKILL_ID=answer-skill NET_data=localhost:$(p 9007) ETCO_answer_llmUrl="$LLM_URL" ETCO_answer_llmModel="$LLM_MODEL" \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-answer.log"    2>&1 & JOB_PIDS[answer-skill]=$!
PORT=$(p 9003) ETCO_server_port=$(p 9003) PHOENIX_SKILL_ID=report-skill NET_lasso="$REPORT_LASSO" NET_settings="$REPORT_SETTINGS" prefsFromConfig="$REPORT_PREFS_FROM_CONFIG" \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-report.log"    2>&1 & JOB_PIDS[report-skill]=$!
PORT=$(p 9004) ETCO_server_port=$(p 9004) PHOENIX_SKILL_ID=chitchat-skill NET_data=localhost:$(p 9007) \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-chitchat.log"  2>&1 & JOB_PIDS[chitchat-skill]=$!
PORT=$(p 9008) ETCO_server_port=$(p 9008) PHOENIX_SKILL_ID=color-skill \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-color.log"     2>&1 & JOB_PIDS[color-skill]=$!
# Phoenix deployment adapters (acceptance H-09): the example/template replacement skills are
# independently deployable at the reference /v1/main URL but are not index-routed, so they get
# no registry entry. 9013/9014 are the next free reference-shaped host ports after classic:9012.
PORT=$(p 9013) ETCO_server_port=$(p 9013) PHOENIX_SKILL_ID=example-skill \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-example.log"    2>&1 & JOB_PIDS[example-skill]=$!
PORT=$(p 9014) ETCO_server_port=$(p 9014) PHOENIX_SKILL_ID=template-skill \
  node packages/skills/src/index.js   > "$LOG_DIR/phx-compose-template.log"   2>&1 & JOB_PIDS[template-skill]=$!

# Phoenix extension (not in the reference contract): the OTA update server. A robot points
# its Update endpoint here to pull firmware in place. Serves packages/ota/data (build them
# with scripts/build-ota-packages.sh). Disable with OTA=0.
if [ "${OTA:-1}" != "0" ]; then
  PORT=$(p 9010) ETCO_ota_publicUrl="${OTA_PUBLIC_URL:-}" \
    node packages/ota/src/index.js    > "$LOG_DIR/phx-compose-ota.log"        2>&1 & JOB_PIDS[ota]=$!
fi

# Phoenix extension: the account service — web portal + OOBE pairing + per-robot hub-token
# issuance (CLASSIC-SERVICES.md / OOBE-PORTAL-HANDOFF.md). Disable with ACCOUNT=0.
ACCOUNT_URL=""
if [ "${ACCOUNT:-1}" != "0" ]; then
  # Empty pass-throughs fall back to .env (the account service loads it via @phoenix/common; the
  # dotenv loader fills unset OR empty-string keys). HUB_TOKEN_SECRET keeps its dev default so the
  # hub + account agree out of the box. A non-empty value exported in the shell still wins.
  PORT=$(p 9011) \
  HUB_TOKEN_SECRET="${HUB_TOKEN_SECRET:-dev-hub-token-secret}" \
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  ETCO_account_region="${ETCO_account_region:-}" \
  ETCO_account_secureCookies="${ETCO_account_secureCookies:-}" \
  ETCO_account_photoBaseUrl="$PHOTO_PUBLIC_URL" \
  ETCO_account_photoDirectory="$PHOTO_DIRECTORY" \
  NET_ota=localhost:$(p 9010) \
    node packages/account/src/index.js > "$LOG_DIR/phx-compose-account.log"   2>&1 & JOB_PIDS[account]=$!
  ACCOUNT_URL="http://localhost:$(p 9011)"
fi

PORT=$(p 9000) \
ETCO_hub_skillsConfig="$SKILLS_CONFIG" \
ETCO_hub_disableAuth="${DISABLE_AUTH:-true}" \
ETCO_hub_accountUrl="${ETCO_hub_accountUrl:-$ACCOUNT_URL}" \
ETCO_server_hubTokenSecret="${HUB_TOKEN_SECRET:-dev-hub-token-secret}" \
ETCO_server_parakeetUrl="$PARAKEET_URL" \
NET_parser=localhost:$(p 9005) \
NET_history=localhost:$(p 9006) \
NET_data=localhost:$(p 9007) \
  node packages/gateway/src/index.js  > "$LOG_DIR/phx-compose-hub.log"        2>&1 & JOB_PIDS[hub]=$!

# Phoenix extension: the classic-service entrypoint — the robot's SINGLE front door for every
# Classic Service (dispatch by X-Amz-Target prefix; in-process log/robot/notification/key/push +
# tier-3 stubs, proxying OOBE/account/settings -> account and Update -> ota). Disable with
# CLASSIC=0. Point the robot's region (https://<region>.jibo.com) at this one port.
CLASSIC_NOTE=""
if [ "${CLASSIC:-1}" != "0" ]; then
  PORT=$(p 9012) \
  NET_account=localhost:$(p 9011) \
  NET_ota=localhost:$(p 9010) \
  ETCO_gqa_attributionFile="$GQA_ATTRIBUTION_FILE" \
  ETCO_classic_publicUrl="$CLASSIC_PUBLIC_URL" \
    node packages/classic/src/index.js > "$LOG_DIR/phx-compose-classic.log"    2>&1 & JOB_PIDS[classic]=$!
  CLASSIC_NOTE=" · classic-entrypoint:$(p 9012)"
fi

echo "compose-contract stack: hub:$(p 9000) report:$(p 9003) chitchat:$(p 9004) parser:$(p 9005) history:$(p 9006) lasso:$(p 9007) color:$(p 9008) answer:$(p 9009) example:$(p 9013) template:$(p 9014)"
echo "ext: ota:$(p 9010) (OTA update server)${ACCOUNT_URL:+ · account+portal:$(p 9011)}${CLASSIC_NOTE}"
[ -n "$ACCOUNT_URL" ] && echo "portal: http://localhost:$(p 9011)  (admin at /#/admin — needs ADMIN_PASSWORD)"
[ -n "$CLASSIC_NOTE" ] && echo "robot front door: http://localhost:$(p 9012)  (point the robot region here)"
echo "logs: $LOG_DIR/phx-compose-*.log"

# Wait on every registered service and report each process's real exit status. `wait $pid`
# returns the job's status (128+N for a signal death), which the R-02 shutdown lane records.
# Guarded against `set -e`: a non-zero wait must not abort the run.
for svc in "${!JOB_PIDS[@]}"; do
  rc=0; wait "${JOB_PIDS[$svc]}" || rc=$?
  echo "compose-contract exit $svc $rc"
done
