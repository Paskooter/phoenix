#!/usr/bin/env bash
# Safe, non-evaluating dotenv loader used by the development launchers.
#
# This intentionally accepts only KEY=VALUE records. Values are assigned with
# `export` as data; command substitutions, backticks, and shell metacharacters
# are never evaluated. Existing non-empty environment values win, matching the
# service-side loader in packages/common/src/dotenv.js.

load_phoenix_env() {
  local file="${1:-}"
  local raw key value
  [ -n "$file" ] && [ -f "$file" ] || return 0

  while IFS= read -r raw || [ -n "$raw" ]; do
    raw=${raw%$'\r'}
    case "$raw" in
      '') continue ;;
      '# '*) continue ;; # fast path for the common spaced-comment form
      \#*) continue ;;
    esac
    local trimmed="${raw#"${raw%%[![:space:]]*}"}"
    [ -n "$trimmed" ] || continue
    case "$trimmed" in \#*) continue ;; esac
    if [[ ! "$raw" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      printf 'invalid dotenv entry in %s\n' "$file" >&2
      return 2
    fi
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    # Match the repository loader's surrounding-quote behavior without eval or
    # printf '%b': backslashes and substitutions remain literal data.
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key+x}" || -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

phoenix_canonical_port() {
  local ports_file="${1:?ports file is required}"
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).hubPort;
    if (!Number.isInteger(value) || value < 1 || value > 65535) process.exit(1);
    process.stdout.write(String(value));
  ' "$ports_file"
}
