# R-01 third lane — the all-Phoenix stack under the original suite

Date: 2026-09-15
Status: **substitution result — R-01 is not claimed or verified by this file.**

Acceptance criterion 2 asks for an all-Phoenix run on the same scenarios after
the one-at-a-time substitutions. This is that run: Phoenix's gateway, NLU and
skills service together, driven by the original `integration-tests-int` suite
and its original clients.

## Wiring

```
original mocha suite  ──ws──▶  Phoenix gateway :8098
                                   ├──http──▶ Phoenix NLU     :9999  (r01net)
                                   └──http──▶ Phoenix skills  :8099  (example)
```

The gateway and skills containers join the test container's network namespace,
so the clients' `localhost` and the registry's `127.0.0.1` mean the same thing
on both sides. Same helper-only seams as the hub lane, plus `R01_SKILL_EXTERNAL`
to withhold the suite's in-process example skill when it is served from outside.

Same scope reduction as the hub lane: only the four files that share
`TEST_SKILL_CONFIG`, because a substituted hub cannot be reconfigured per
`beforeEach`. See `../r01-hub-substitution/`.

## The generated registry is temporary, by necessity

Phoenix's gateway resolves its skills index from
`packages/gateway/resources/skills/`, and S-06 pins every file in that directory
to a source digest. The generated `skills-r01.json` / `example_manifest.json`
must therefore be written there for the run and **removed afterwards**, or
`S-06: every hub skill index and manifest file matches the pinned-source digest`
fails. Leaving them behind is what that test is for; it caught exactly this.

## Result

| stack | passing | failing |
| --- | --- | --- |
| all-original (control) | 9 | 2 |
| Phoenix gateway only | 8 | 3 |
| **all-Phoenix** | **8** | **3** |

The all-Phoenix stack is identical to the gateway-only lane — swapping the
parser and the skill for Phoenix's changed nothing — and differs from the
all-original control by exactly one case:

```
Listen transaction > Early EOS and ASR hints   (divergence H07b)
```

The two external-agent cases fail on both sides, and on the Phoenix side they
now fail *better*: `AssertionError: expected false to equal true` — the
unreachable in-process `isDone()` check — rather than the control's
`Request failed with status code 500`. Everything the suite asserts about the
response passed, because the NLU picked up `PHOENIX_NLU_EXTERNAL=llm` and the
live lane answered. See `../r01-external-agents/`.

## Two defects this lane found

Neither was visible until a real original client drove a full Phoenix stack.

**1. A throwing skill logged nothing.** `skillService.js` logged
`{ error: err }`. An `Error` has no enumerable own properties, so the structured
logger emitted `"error":{}` and every skill failure was silent — while the rest
of the codebase logs `error.message`. Now logs message and stack, keeping the
raw value's shape for a non-`Error` throw. Fixing it produced the next finding
in one line.

**2. The example skill could not take its registered id.**

```
Incoming skill name doesn't match. This: 'example-skill', incoming: 'example'
```

The reference constructs the fixture *with* an id —
`new example.ExampleSkill('example')`
(`integration-tests-int/src/utils/integration.ts:55`) — so it was never tied to
one name. Phoenix hardcoded `example-skill`, and `GraphSkill` rejects a request
whose skill id does not match its own, which made the fixture unusable against
the original suite's own registry. `createExampleSkill(name)` now parameterises
it, `createSelectedSkill` serves it under the registered id, and the
`PHOENIX_SKILL_ID` allow-list accepts `example`.

That is a genuine parity gap rather than a harness workaround: the original
parameterises the id and Phoenix did not.

## Reproduce

```
docker run -d --name r01-test --network r01net -v <scratch>:/work \
  -w /work/packages/integration-tests-int node:8.9.4-slim sleep 3600
docker run -d --name r01-phoenix-nlu --network r01net -v <phoenix>:/phoenix -w /phoenix \
  -e PORT=9999 node:22.22.0-slim node packages/nlu/src/index.js
docker run -d --name r01-phoenix-skills --network container:r01-test -v <phoenix>:/phoenix -w /phoenix \
  -e ETCO_server_port=8099 -e PHOENIX_SKILL_ID=example node:22.22.0-slim node packages/skills/src/index.js
docker run -d --name r01-phoenix-hub --network container:r01-test -v <phoenix>:/phoenix -w /phoenix \
  -e PORT=8098 -e ETCO_server_hubTokenSecret=my-hard-kept-secret \
  -e NET_parser=r01-phoenix-nlu:9999 -e NET_history=127.0.0.1:9 \
  -e ETCO_hub_skillsConfig=skills-r01.json node:22.22.0-slim node packages/gateway/src/index.js

docker exec -e R01_HUB_EXTERNAL=1 -e R01_SKILL_EXTERNAL=1 -e R01_HUB_PORT=8098 -e R01_SKILL_PORT=8099 \
  r01-test ../../node_modules/.bin/mocha -r ts-node/register ./tests/r01-shared.js
```

## Still outstanding for R-01

Per-case HTTP/WS/JCP and history/data side-effect capture, adversarial controls
over the comparison itself, a hub-reconfiguration seam for the excluded four
files, and closing H07b. **R-01 remains `todo`.**
