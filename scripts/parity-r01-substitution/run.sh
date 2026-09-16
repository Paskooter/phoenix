#!/usr/bin/env bash
# R-01 substitution runner: drive the ORIGINAL integration-tests-int suite
# against a stack with Phoenix services swapped in, one at a time or all at once.
#
# The procedure below is not incidental. Two traps cost real time and one wrong
# conclusion while building this lane, and both are guarded here:
#
#   1. A container that exits still "runs" the suite, and the failures look like
#      findings. An adversarial control was once read as a successful detection
#      when in fact the gateway had exited on startup and nothing was under test.
#      Every service is checked for a listening line before any suite runs, and
#      the script aborts rather than reporting a meaningless result.
#
#   2. The generated skills registry has to live in
#      packages/gateway/resources/skills/, which S-06 pins to source digests.
#      Leaving it behind fails that test; deleting it while a gateway still needs
#      it makes the gateway exit on its next restart (trap 1). It is written on
#      setup and removed on teardown, together.
#
# Usage:
#   run.sh setup            start peers, generate the registry
#   run.sh baseline         all-original control (parser out of process)
#   run.sh parser           Phoenix NLU only, original hub
#   run.sh skills           Phoenix skills only, original hub and parser
#   run.sh hub              Phoenix gateway only
#   run.sh all-phoenix      Phoenix gateway + NLU + skills
#   run.sh teardown         stop containers, remove the generated registry
set -euo pipefail

PHOENIX="${PHOENIX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRATCH="${R01_SCRATCH:-$HOME/.local/share/phoenix/r01/ref-with-devdeps}"
NET=r01net
HUB_PORT=8098
SKILL_PORT=8099
# Control route for per-test hub reconfiguration (hub-supervisor.mjs).
CONTROL_PORT=8097
NODE8=node:8.9.4-slim
NODE22=node:22.22.0-slim
SUITE="../../node_modules/.bin/mocha -r ts-node/register ./tests/r01-shared.js"

die() { echo "ABORT: $*" >&2; exit 1; }

# A service that is not listening cannot be under test. Never run the suite
# against one; a dead peer produces failures that read exactly like findings.
require_listening() {
  local name=$1 pattern=${2:-listening}
  # `grep -q` exits the moment it matches, which closes the pipe and kills the
  # producer with SIGPIPE. Under `set -o pipefail` that makes the pipeline fail
  # ON SUCCESS, so the guard fired hardest exactly when the service was healthy.
  # `grep -c` consumes all input, so the exit status means what it says.
  local running matches
  running=$(docker ps --filter "name=^${name}$" --format '{{.Names}}' | grep -c "$name" || true)
  [ "$running" -gt 0 ] \
    || { docker logs --tail 5 "$name" >&2 2>&1 || true; die "$name is not running"; }
  matches=$(docker logs "$name" 2>&1 | grep -c "$pattern" || true)
  [ "$matches" -gt 0 ] \
    || { docker logs --tail 5 "$name" >&2 2>&1 || true; die "$name never reported '$pattern'"; }
}

setup() {
  docker network create "$NET" >/dev/null 2>&1 || true
  docker rm -f r01-orig-parser r01-test r01-phoenix-hub r01-phoenix-nlu r01-phoenix-skills >/dev/null 2>&1 || true

  # The skills registry is generated from the suite's OWN exported
  # TEST_SKILL_CONFIG, never transcribed: a substituted hub must not be tested
  # against a different skill definition than the original hub sees.
  docker run --rm -v "$SCRATCH":/work -w /work -e R01_SKILL_PORT=$SKILL_PORT "$NODE8" \
    node r01-emit-phoenix-skills.js /work/r01-skills >/dev/null
  cp "$SCRATCH"/r01-skills/*.json "$PHOENIX/packages/gateway/resources/skills/"

  docker run -d --name r01-orig-parser --network "$NET" -v "$SCRATCH":/work -w /work \
    "$NODE8" node r01-standalone-parser.js >/dev/null
  docker run -d --name r01-test --network "$NET" -v "$SCRATCH":/work \
    -w /work/packages/integration-tests-int "$NODE8" sleep 7200 >/dev/null

  echo "waiting for the original parser..."
  for _ in $(seq 1 40); do docker logs r01-orig-parser 2>&1 | grep -q '"ready":true' && break; sleep 5; done
  require_listening r01-orig-parser '"ready":true'
  echo "setup complete"
}

start_phoenix_hub() {
  local parser=$1
  docker rm -f r01-phoenix-hub >/dev/null 2>&1 || true
  # The hub runs under hub-supervisor.mjs, not directly. The supervisor owns the
  # unmodified gateway process and exposes one control route so a test file can
  # hand it that file's own skill registry before its describe runs (see the
  # header of hub-supervisor.mjs). Lanes that never reconfigure are unaffected:
  # the supervisor starts the gateway once from the registry setup generated.
  docker run -d --name r01-phoenix-hub --network "container:r01-test" -v "$PHOENIX":/phoenix -w /phoenix \
    -e PORT=$HUB_PORT -e ETCO_server_hubTokenSecret=my-hard-kept-secret \
    -e NET_parser="$parser" -e NET_history=127.0.0.1:9 \
    -e R01_CONTROL_PORT=$CONTROL_PORT -e R01_SKILL_PORT=$SKILL_PORT \
    -e ETCO_hub_skillsConfig=skills-r01.json \
    "$NODE22" node scripts/parity-r01-substitution/hub-supervisor.mjs >/dev/null
  sleep 7
  require_listening r01-phoenix-hub
}

case "${1:-}" in
  setup) setup ;;

  baseline)
    require_listening r01-orig-parser '"ready":true'
    docker run --rm --network "$NET" -v "$SCRATCH":/work -w /work/packages/integration-tests-int \
      -e R01_PARSER_BASE_URL=http://r01-orig-parser:9999 -e R01_TRACE_DIR="${R01_TRACE_DIR:-}" "$NODE8" $SUITE
    ;;

  parser)
    # One service at a time, part 1: the ORIGINAL hub, in process as the suite
    # builds it, talking to Phoenix's NLU instead of the original parser. Only
    # the parser base URL changes; no caller, URL shape or test case does.
    docker rm -f r01-phoenix-nlu >/dev/null 2>&1 || true
    docker run -d --name r01-phoenix-nlu --network "$NET" -v "$PHOENIX":/phoenix -w /phoenix \
      -e PORT=9999 "$NODE22" node packages/nlu/src/index.js >/dev/null
    sleep 8
    require_listening r01-phoenix-nlu
    docker exec -e R01_PARSER_BASE_URL=http://r01-phoenix-nlu:9999 \
      -e R01_TRACE_DIR="${R01_TRACE_DIR:-}" r01-test $SUITE
    ;;

  skills)
    # One service at a time, part 2: the ORIGINAL hub and the ORIGINAL parser,
    # with the example skill served by Phoenix's skills host on the port the
    # hub's own registry already points at. R01_SKILL_EXTERNAL withholds the
    # suite's in-process skill so the two do not contend for it.
    require_listening r01-orig-parser '"ready":true'
    docker rm -f r01-phoenix-skills >/dev/null 2>&1 || true
    docker run -d --name r01-phoenix-skills --network "container:r01-test" -v "$PHOENIX":/phoenix -w /phoenix \
      -e ETCO_server_port=$SKILL_PORT -e PHOENIX_SKILL_ID=example "$NODE22" node packages/skills/src/index.js >/dev/null
    sleep 8
    require_listening r01-phoenix-skills
    docker exec -e R01_SKILL_EXTERNAL=1 -e R01_SKILL_PORT=$SKILL_PORT \
      -e R01_PARSER_BASE_URL=http://r01-orig-parser:9999 \
      -e R01_TRACE_DIR="${R01_TRACE_DIR:-}" r01-test $SUITE
    ;;

  hub)
    require_listening r01-orig-parser '"ready":true'
    start_phoenix_hub r01-orig-parser:9999
    docker exec -e R01_HUB_EXTERNAL=1 -e R01_HUB_PORT=$HUB_PORT -e R01_SKILL_PORT=$SKILL_PORT \
      -e R01_HUB_CONTROL=http://127.0.0.1:$CONTROL_PORT \
      -e R01_TRACE_DIR="${R01_TRACE_DIR:-}" r01-test $SUITE
    ;;

  all-phoenix)
    docker rm -f r01-phoenix-nlu r01-phoenix-skills >/dev/null 2>&1 || true
    docker run -d --name r01-phoenix-nlu --network "$NET" -v "$PHOENIX":/phoenix -w /phoenix \
      -e PORT=9999 "$NODE22" node packages/nlu/src/index.js >/dev/null
    docker run -d --name r01-phoenix-skills --network "container:r01-test" -v "$PHOENIX":/phoenix -w /phoenix \
      -e ETCO_server_port=$SKILL_PORT -e PHOENIX_SKILL_ID=example "$NODE22" node packages/skills/src/index.js >/dev/null
    sleep 8
    require_listening r01-phoenix-nlu
    require_listening r01-phoenix-skills
    start_phoenix_hub r01-phoenix-nlu:9999
    docker exec -e R01_HUB_EXTERNAL=1 -e R01_SKILL_EXTERNAL=1 \
      -e R01_HUB_PORT=$HUB_PORT -e R01_SKILL_PORT=$SKILL_PORT \
      -e R01_HUB_CONTROL=http://127.0.0.1:$CONTROL_PORT \
      -e R01_TRACE_DIR="${R01_TRACE_DIR:-}" r01-test $SUITE
    ;;

  teardown)
    docker rm -f r01-orig-parser r01-test r01-phoenix-hub r01-phoenix-nlu r01-phoenix-skills >/dev/null 2>&1 || true
    # Must accompany the container teardown: S-06 pins this directory.
    #
    # Named removal was enough while the registry was generated once from
    # TEST_SKILL_CONFIG. The supervisor now writes one manifest per skill id in
    # whichever registry a test file supplies, so a file naming a skill other
    # than `example` would leave a manifest behind and fail S-06 on the next
    # run. Return the pinned directory to its committed state instead of
    # guessing the filenames: restore tracked files, remove untracked ones, and
    # scope both to that one path.
    #
    # `git clean -fq` alone is NOT enough and this bit once already: the
    # generated files are gitignored, so plain clean skips them and S-06 fails
    # with "skills dir file count 35 !== 33". `-x` is what makes clean consider
    # ignored files, and nothing ignored belongs in a directory S-06 pins to an
    # exact file list anyway.
    git -C "$PHOENIX" checkout -- packages/gateway/resources/skills/ 2>/dev/null || true
    git -C "$PHOENIX" clean -fqx -- packages/gateway/resources/skills/ 2>/dev/null || true
    # Say so here rather than leaving it for the next unrelated test run.
    if ! (cd "$PHOENIX" && node --test packages/gateway/test/manifestProvenance.test.js >/dev/null 2>&1); then
      echo "WARNING: S-06 still fails after teardown; the pinned skills directory is dirty" >&2
      (cd "$PHOENIX" && git status --porcelain --ignored packages/gateway/resources/skills/) >&2
    fi
    echo "torn down; generated registry removed"
    ;;

  *) sed -n '1,30p' "$0"; exit 2 ;;
esac
