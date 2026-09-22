#!/usr/bin/env bash
# Native (no-docker) equivalent of docker-compose.yml. Production defaults are
# loopback-only so nginx (or another explicitly configured TLS edge) is the only
# internet-facing listener:
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
#   PHOENIX_DATA_DIR    private durable root outside an immutable release. When
#                       set, Account, Classic, OTA, History, and Lasso state
#                       live below it instead of the checkout.
#   CLASSIC_DATA_DIR    private durable root for Classic stores (defaults to
#                       PHOENIX_DATA_DIR/classic, or packages/account/data/classic)
#   PHOENIX_BIND_HOST   listener address (default 127.0.0.1; use a private/LAN
#                       address only with an explicit firewall/VPN policy)
#   PHOENIX_REQUIRE_PRODUCTION_CONFIG=true
#                       refuse startup unless a non-empty secret, auth enabled,
#                       and fixed HTTPS public origins are configured
#                       (set this in the production systemd unit)

NO_ENV=0
for arg in "$@"; do
  case "$arg" in
    --no-env) NO_ENV=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Environment variables supplied by a supervisor/command line must remain
# authoritative when the convenience .env file is sourced below. In
# particular, a production unit's loopback bind and fail-closed gate must not
# be weakened by a stale checkout-local value.
_PHOENIX_BIND_HOST_WAS_SET="${PHOENIX_BIND_HOST+x}"
_PHOENIX_BIND_HOST_VALUE="${PHOENIX_BIND_HOST-}"
_PHOENIX_REQUIRE_PRODUCTION_WAS_SET="${PHOENIX_REQUIRE_PRODUCTION_CONFIG+x}"
_PHOENIX_REQUIRE_PRODUCTION_VALUE="${PHOENIX_REQUIRE_PRODUCTION_CONFIG-}"
_HUB_TOKEN_SECRET_WAS_SET="${HUB_TOKEN_SECRET+x}"
_HUB_TOKEN_SECRET_VALUE="${HUB_TOKEN_SECRET-}"
_DISABLE_AUTH_WAS_SET="${DISABLE_AUTH+x}"
_DISABLE_AUTH_VALUE="${DISABLE_AUTH-}"
_OTA_PUBLIC_URL_WAS_SET="${OTA_PUBLIC_URL+x}"
_OTA_PUBLIC_URL_VALUE="${OTA_PUBLIC_URL-}"
_CLASSIC_PUBLIC_URL_WAS_SET="${CLASSIC_PUBLIC_URL+x}"
_CLASSIC_PUBLIC_URL_VALUE="${CLASSIC_PUBLIC_URL-}"

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

if [ "$_PHOENIX_BIND_HOST_WAS_SET" = x ]; then PHOENIX_BIND_HOST="$_PHOENIX_BIND_HOST_VALUE"; fi
if [ "$_PHOENIX_REQUIRE_PRODUCTION_WAS_SET" = x ]; then PHOENIX_REQUIRE_PRODUCTION_CONFIG="$_PHOENIX_REQUIRE_PRODUCTION_VALUE"; fi
if [ "$_HUB_TOKEN_SECRET_WAS_SET" = x ]; then HUB_TOKEN_SECRET="$_HUB_TOKEN_SECRET_VALUE"; fi
if [ "$_DISABLE_AUTH_WAS_SET" = x ]; then DISABLE_AUTH="$_DISABLE_AUTH_VALUE"; fi
if [ "$_OTA_PUBLIC_URL_WAS_SET" = x ]; then OTA_PUBLIC_URL="$_OTA_PUBLIC_URL_VALUE"; fi
if [ "$_CLASSIC_PUBLIC_URL_WAS_SET" = x ]; then CLASSIC_PUBLIC_URL="$_CLASSIC_PUBLIC_URL_VALUE"; fi

# Safe defaults: an unset secret cannot mint or validate a token, and an unset
# auth flag is still authenticated. The test harness may intentionally run this
# with no secret to exercise the disabled-token-issuance path; production systemd
# sets PHOENIX_REQUIRE_PRODUCTION_CONFIG=true below to turn that into a hard stop.
HUB_TOKEN_SECRET="${HUB_TOKEN_SECRET:-}"
DISABLE_AUTH="${DISABLE_AUTH:-false}"
OTA_PUBLIC_URL="${OTA_PUBLIC_URL:-${ETCO_ota_publicUrl:-}}"
CLASSIC_PUBLIC_URL="${CLASSIC_PUBLIC_URL:-${ETCO_classic_publicUrl:-}}"
ACCOUNT_INTERNAL_PEER_TOKEN="${ETCO_account_internalPeerToken:-}"
OTA_INTERNAL_PEER_TOKEN="${ETCO_ota_internalPeerToken:-}"
if [ "${PHOENIX_REQUIRE_PRODUCTION_CONFIG:-false}" = "true" ]; then
  [ -n "$HUB_TOKEN_SECRET" ] || { echo "refusing production start: HUB_TOKEN_SECRET is empty" >&2; exit 2; }
  [ "$DISABLE_AUTH" = "false" ] || { echo "refusing production start: DISABLE_AUTH must be false" >&2; exit 2; }
  case "$OTA_PUBLIC_URL" in
    https://?*) ;;
    *) echo "refusing production start: OTA_PUBLIC_URL must be a fixed HTTPS origin" >&2; exit 2 ;;
  esac
  case "$CLASSIC_PUBLIC_URL" in
    https://?*) ;;
    *) echo "refusing production start: CLASSIC_PUBLIC_URL must be a fixed HTTPS origin" >&2; exit 2 ;;
  esac
  [ -n "$ACCOUNT_INTERNAL_PEER_TOKEN" ] || { echo "refusing production start: ETCO_account_internalPeerToken is empty" >&2; exit 2; }
  [ -n "$OTA_INTERNAL_PEER_TOKEN" ] || { echo "refusing production start: ETCO_ota_internalPeerToken is empty" >&2; exit 2; }
fi

OFFSET="${PHOENIX_PORT_OFFSET:-0}"
case "$OFFSET" in
  ''|*[!0-9]*) echo "invalid PHOENIX_PORT_OFFSET: $OFFSET" >&2; exit 2 ;;
esac
# Reference host port plus the offset (ref 9000-9014, spacing preserved). Container-side ports
# never leave 8080, so only the host-facing values and their localhost links shift.
p() { echo "$(( $1 + OFFSET ))"; }
BIND_HOST="${PHOENIX_BIND_HOST:-127.0.0.1}"
case "$BIND_HOST" in
  *[!A-Za-z0-9_.:\[\]-]*|"")
    echo "invalid PHOENIX_BIND_HOST: $BIND_HOST" >&2
    exit 2
    ;;
esac
if [ "${PHOENIX_REQUIRE_PRODUCTION_CONFIG:-false}" = "true" ]; then
  case "$BIND_HOST" in
    0.0.0.0|::|\[::\])
      echo "refusing production start: PHOENIX_BIND_HOST must not be a wildcard" >&2
      exit 2
      ;;
  esac
fi
# @phoenix/common reads this for every HTTP service. Keep it exported so the
# native launcher cannot accidentally leave one service on a wildcard bind.
export PHOENIX_BIND_HOST="$BIND_HOST"
LOG_DIR="${PHOENIX_LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"

# A release checkout must be disposable: changing it atomically must not move
# account records, photos, robot media, OTA packages, or calendar state with it.
# Local development remains convenient because an unset PHOENIX_DATA_DIR keeps
# the historical checkout-relative locations.
if [ -n "${PHOENIX_DATA_DIR:-}" ]; then
  case "$PHOENIX_DATA_DIR" in
    /*) DATA_ROOT="${PHOENIX_DATA_DIR%/}" ;;
    *) echo "PHOENIX_DATA_DIR must be an absolute path" >&2; exit 2 ;;
  esac
  DEFAULT_ACCOUNT_DATA_FILE="$DATA_ROOT/account/store.json"
  DEFAULT_CLASSIC_DATA_DIR="$DATA_ROOT/classic"
  DEFAULT_PHOTO_DIRECTORY="$DATA_ROOT/account/member-photos"
  DEFAULT_OTA_MANIFEST="$DATA_ROOT/ota/manifest.json"
  DEFAULT_OTA_DATA_DIR="$DATA_ROOT/ota/packages"
  DEFAULT_HISTORY_DATA_FILE="$DATA_ROOT/history/store.json"
  DEFAULT_LASSO_CREDENTIALS_FILE="$DATA_ROOT/data/credentials.json"
else
  DEFAULT_ACCOUNT_DATA_FILE="$PWD/packages/account/data/store.json"
  DEFAULT_CLASSIC_DATA_DIR="$PWD/packages/account/data/classic"
  DEFAULT_PHOTO_DIRECTORY="$PWD/packages/account/data/member-photos"
  DEFAULT_OTA_MANIFEST="$PWD/packages/ota/manifest.json"
  DEFAULT_OTA_DATA_DIR="$PWD/packages/ota/data"
  DEFAULT_HISTORY_DATA_FILE="$PWD/packages/history/data/store.json"
  DEFAULT_LASSO_CREDENTIALS_FILE="$PWD/packages/data/data/credentials.json"
fi

ACCOUNT_DATA_FILE="${ETCO_account_dataFile:-$DEFAULT_ACCOUNT_DATA_FILE}"
CLASSIC_DATA_DIR="${CLASSIC_DATA_DIR:-$DEFAULT_CLASSIC_DATA_DIR}"
PHOTO_DIRECTORY="${PHOTO_DIRECTORY:-${ETCO_account_photoDirectory:-$DEFAULT_PHOTO_DIRECTORY}}"
OTA_MANIFEST="${ETCO_ota_manifest:-$DEFAULT_OTA_MANIFEST}"
OTA_DATA_DIR="${ETCO_ota_dataDir:-$DEFAULT_OTA_DATA_DIR}"
HISTORY_DATA_FILE="${ETCO_history_dataFile:-$DEFAULT_HISTORY_DATA_FILE}"
LASSO_CREDENTIALS_FILE="${ETCO_data_credentialsFile:-$DEFAULT_LASSO_CREDENTIALS_FILE}"

mkdir -p "$(dirname "$ACCOUNT_DATA_FILE")" "$CLASSIC_DATA_DIR" "$PHOTO_DIRECTORY" \
  "$(dirname "$OTA_MANIFEST")" "$OTA_DATA_DIR" "$(dirname "$HISTORY_DATA_FILE")" \
  "$(dirname "$LASSO_CREDENTIALS_FILE")"
chmod 700 "$CLASSIC_DATA_DIR"
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
# Laya is a private, bounded intent fallback.  It is separate from the answer
# skill's LLM and must remain explicitly disabled unless a tokenized LAN/VPN
# endpoint has passed replay validation.
PARSER_LAYA_ENABLED="${ETCO_parser_layaEnabled:-${LAYA_ENABLED:-false}}"
PARSER_LAYA_URL="${ETCO_parser_layaUrl:-${LAYA_URL:-}}"
PARSER_LAYA_TOKEN="${ETCO_parser_layaToken:-${LAYA_TOKEN:-}}"
PARSER_LAYA_PROFILE="${ETCO_parser_layaProfile:-${LAYA_PROFILE:-phoenix-core}}"
PARSER_LAYA_TIMEOUT_MS="${ETCO_parser_layaTimeoutMs:-${LAYA_TIMEOUT_MS:-700}}"
PARSER_LAYA_MIN_CONFIDENCE="${ETCO_parser_layaMinConfidence:-${LAYA_MIN_CONFIDENCE:-0.85}}"
PARSER_LAYA_SECONDARY_FALLBACK="${ETCO_parser_layaSecondaryFallback:-${LAYA_SECONDARY_FALLBACK:-none}}"
REPORT_PREFS_FROM_CONFIG="${prefsFromConfig:-${PREFS_FROM_CONFIG:-false}}"
REPORT_LASSO="${NET_lasso:-localhost:$(p 9007)}"
REPORT_SETTINGS="${NET_settings:-${NET_SETTINGS:-settings.jibo.aws}}"
PHOTO_PUBLIC_URL="${PHOTO_PUBLIC_URL:-${ETCO_account_photoBaseUrl:-$CLASSIC_PUBLIC_URL}}"
GQA_ATTRIBUTION_FILE="${GQA_ATTRIBUTION_FILE:-${ETCO_gqa_attributionFile:-$CLASSIC_DATA_DIR/gqa-attribution.json}}"
CLASSIC_NOTIFICATION_FILE="${CLASSIC_NOTIFICATION_FILE:-${ETCO_classic_notificationFile:-$CLASSIC_DATA_DIR/notifications.json}}"
CLASSIC_BACKUP_DIR="${CLASSIC_BACKUP_DIR:-${ETCO_classic_backupDir:-$CLASSIC_DATA_DIR/backups}}"
CLASSIC_LOG_DIR="${CLASSIC_LOG_DIR:-${ETCO_classic_logDir:-$CLASSIC_DATA_DIR/logs}}"
CLASSIC_MEDIA_DIR="${CLASSIC_MEDIA_DIR:-${ETCO_classic_mediaDir:-$CLASSIC_DATA_DIR/media}}"
CLASSIC_MEDIA_FILE="${CLASSIC_MEDIA_FILE:-${ETCO_classic_mediaFile:-$CLASSIC_DATA_DIR/media.json}}"
CLASSIC_IFTTT_FILE="${CLASSIC_IFTTT_FILE:-${ETCO_classic_iftttFile:-$CLASSIC_DATA_DIR/ifttt.json}}"
CLASSIC_PERSON_FILE="${CLASSIC_PERSON_FILE:-${ETCO_classic_personFile:-$CLASSIC_DATA_DIR/person.json}}"
CLASSIC_JOT_FILE="${CLASSIC_JOT_FILE:-${ETCO_classic_jotFile:-$CLASSIC_DATA_DIR/jot.json}}"
CLASSIC_VOICE_TRAINING_FILE="${CLASSIC_VOICE_TRAINING_FILE:-${ETCO_classic_voiceTrainingFile:-$CLASSIC_DATA_DIR/voice-training.json}}"
CLASSIC_KEY_FILE="${CLASSIC_KEY_FILE:-${ETCO_classic_keyFile:-$CLASSIC_DATA_DIR/keys.json}}"
CLASSIC_ROBOT_DIR="${CLASSIC_ROBOT_DIR:-${ETCO_classic_robotDir:-$CLASSIC_DATA_DIR/robots}}"
CLASSIC_KEY_BINARY_DIR="${CLASSIC_KEY_BINARY_DIR:-${ETCO_classic_keyBinaryDir:-$CLASSIC_DATA_DIR/key-binaries}}"
CLASSIC_PUSH_FILE="${CLASSIC_PUSH_FILE:-${ETCO_classic_pushFile:-$CLASSIC_DATA_DIR/push.json}}"

PORT=$(p 9005) ETCO_parser_llmUrl="$LLM_URL" ETCO_parser_llmModel="$LLM_MODEL" \
  ETCO_parser_layaEnabled="$PARSER_LAYA_ENABLED" ETCO_parser_layaUrl="$PARSER_LAYA_URL" \
  ETCO_parser_layaToken="$PARSER_LAYA_TOKEN" ETCO_parser_layaProfile="$PARSER_LAYA_PROFILE" \
  ETCO_parser_layaTimeoutMs="$PARSER_LAYA_TIMEOUT_MS" ETCO_parser_layaMinConfidence="$PARSER_LAYA_MIN_CONFIDENCE" \
  ETCO_parser_layaSecondaryFallback="$PARSER_LAYA_SECONDARY_FALLBACK" \
  node packages/nlu/src/index.js      > "$LOG_DIR/phx-compose-parser.log"   2>&1 & JOB_PIDS[parser]=$!
PORT=$(p 9006) ETCO_history_dataFile="$HISTORY_DATA_FILE" \
  node packages/history/src/index.js  > "$LOG_DIR/phx-compose-history.log" 2>&1 & JOB_PIDS[history]=$!
PORT=$(p 9007) ETCO_data_credentialsFile="$LASSO_CREDENTIALS_FILE" \
  node packages/data/src/index.js     > "$LOG_DIR/phx-compose-lasso.log"   2>&1 & JOB_PIDS[lasso]=$!

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
  PORT=$(p 9010) ETCO_ota_publicUrl="${OTA_PUBLIC_URL:-}" ETCO_ota_internalPeerToken="$OTA_INTERNAL_PEER_TOKEN" \
  ETCO_ota_packageBearerSecret="${ETCO_ota_packageBearerSecret:-$HUB_TOKEN_SECRET}" \
  ETCO_ota_manifest="$OTA_MANIFEST" ETCO_ota_dataDir="$OTA_DATA_DIR" \
  ETCO_ota_accountDataFile="$ACCOUNT_DATA_FILE" \
    node packages/ota/src/index.js    > "$LOG_DIR/phx-compose-ota.log"        2>&1 & JOB_PIDS[ota]=$!
fi

# Phoenix extension: the account service — web portal + OOBE pairing + per-robot hub-token
# issuance (CLASSIC-SERVICES.md / OOBE-PORTAL-HANDOFF.md). Disable with ACCOUNT=0.
ACCOUNT_URL=""
if [ "${ACCOUNT:-1}" != "0" ]; then
  # Empty pass-throughs remain empty: account token issuance must stay disabled
  # until an operator supplies a real secret. A non-empty value from the shell or
  # .env is passed through unchanged.
  # The portal forwards gallery, update catalog, and classic-account calls to
  # Classic. Keep that internal hop on the same port map as every other native
  # service; otherwise the client falls back to the development port 7017.
  PORT=$(p 9011) \
  HUB_TOKEN_SECRET="$HUB_TOKEN_SECRET" \
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  ETCO_account_dataFile="$ACCOUNT_DATA_FILE" \
  ETCO_account_region="${ETCO_account_region:-}" \
  ETCO_account_secureCookies="${ETCO_account_secureCookies:-true}" \
  ETCO_account_photoBaseUrl="$PHOTO_PUBLIC_URL" \
  ETCO_account_photoDirectory="$PHOTO_DIRECTORY" \
  NET_classic=localhost:$(p 9012) \
  NET_ota=localhost:$(p 9010) \
  NET_hub=localhost:$(p 9000) \
    node packages/account/src/index.js > "$LOG_DIR/phx-compose-account.log"   2>&1 & JOB_PIDS[account]=$!
  ACCOUNT_URL="http://localhost:$(p 9011)"
fi

PORT=$(p 9000) \
ETCO_hub_skillsConfig="$SKILLS_CONFIG" \
ETCO_hub_disableAuth="$DISABLE_AUTH" \
ETCO_hub_accountUrl="${ETCO_hub_accountUrl:-$ACCOUNT_URL}" \
ETCO_server_hubTokenSecret="$HUB_TOKEN_SECRET" \
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
  ETCO_ota_internalPeerToken="$OTA_INTERNAL_PEER_TOKEN" \
  ETCO_gqa_attributionFile="$GQA_ATTRIBUTION_FILE" \
  ETCO_classic_accountDataFile="$ACCOUNT_DATA_FILE" \
  ETCO_classic_publicUrl="$CLASSIC_PUBLIC_URL" \
  ETCO_classic_notificationFile="$CLASSIC_NOTIFICATION_FILE" \
  ETCO_classic_backupDir="$CLASSIC_BACKUP_DIR" \
  ETCO_classic_logDir="$CLASSIC_LOG_DIR" \
  ETCO_classic_mediaDir="$CLASSIC_MEDIA_DIR" \
  ETCO_classic_mediaFile="$CLASSIC_MEDIA_FILE" \
  ETCO_classic_iftttFile="$CLASSIC_IFTTT_FILE" \
  ETCO_classic_personFile="$CLASSIC_PERSON_FILE" \
  ETCO_classic_jotFile="$CLASSIC_JOT_FILE" \
  ETCO_classic_voiceTrainingFile="$CLASSIC_VOICE_TRAINING_FILE" \
  ETCO_classic_keyFile="$CLASSIC_KEY_FILE" \
  ETCO_classic_robotDir="$CLASSIC_ROBOT_DIR" \
  ETCO_classic_keyBinaryDir="$CLASSIC_KEY_BINARY_DIR" \
  ETCO_classic_pushFile="$CLASSIC_PUSH_FILE" \
    node packages/classic/src/index.js > "$LOG_DIR/phx-compose-classic.log"    2>&1 & JOB_PIDS[classic]=$!
  CLASSIC_NOTE=" · classic-entrypoint:$(p 9012)"
fi

echo "compose-contract stack: bind=${BIND_HOST} hub:$(p 9000) report:$(p 9003) chitchat:$(p 9004) parser:$(p 9005) history:$(p 9006) lasso:$(p 9007) color:$(p 9008) answer:$(p 9009) example:$(p 9013) template:$(p 9014)"
echo "ext: ota:$(p 9010) (OTA update server)${ACCOUNT_URL:+ · account+portal:$(p 9011)}${CLASSIC_NOTE}"
[ -n "$ACCOUNT_URL" ] && echo "portal: http://localhost:$(p 9011)  (admin at /#/admin — needs ADMIN_PASSWORD)"
[ -n "$CLASSIC_NOTE" ] && echo "robot front door: http://localhost:$(p 9012)  (point the robot region here)"
echo "logs: $LOG_DIR/phx-compose-*.log"
# The harness needs each service's pid to signal it on shutdown; announce them.
for svc in "${!JOB_PIDS[@]}"; do echo "compose-contract pid $svc ${JOB_PIDS[$svc]}"; done

# Wait on every registered service and report each process's real exit status. `wait $pid`
# returns the job's status (128+N for a signal death), which the R-02 shutdown lane records.
# Guarded against `set -e`: a non-zero wait must not abort the run.
for svc in "${!JOB_PIDS[@]}"; do
  rc=0; wait "${JOB_PIDS[$svc]}" || rc=$?
  echo "compose-contract exit $svc $rc"
done
