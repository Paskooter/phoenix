# R-01 second substitution lane — Phoenix's gateway into the original stack

Date: 2026-09-15
Status: **substitution result — R-01 is not claimed or verified by this file.**

The parser lane established that Phoenix's NLU is indistinguishable from the
original under identical conditions. This lane substitutes the **hub**: the
original `integration-tests-int` suite, its original clients, and the original
parser, with Phoenix's gateway in place of `hub.HubService`.

## How the substitution is wired

The hub is the one service the tests dial directly (`hostname: 'localhost'`,
`port: services.hubPort`), and the example skill runs *inside the test process*.
An out-of-process hub therefore has to share that process's loopback, which is
what `--network container:<test>` gives: the gateway container joins the test
container's network namespace, so `localhost:8098` and `127.0.0.1:8099` mean the
same thing on both sides. No test case, assertion, URL path or request shape was
changed; the seams are in the test **helper** only, with `.orig` kept:

```
R01_HUB_PORT     fix the hub port instead of allocating one (an external hub
                 cannot be told a port discovered after it started)
R01_SKILL_PORT   same, for the in-process example skill
R01_HUB_EXTERNAL do not construct hub.HubService here; it is supplied outside
```

Peers: the original parser out of process (`r01-orig-parser`), history pointed
at a dead port exactly as the baseline leaves it, settings at the dead
`settings.jibo.aws`.

The Phoenix skills registry is **generated from the suite's own exported
`TEST_SKILL_CONFIG`** (`r01-emit-phoenix-skills.js`) rather than transcribed, so
the substituted hub cannot end up testing a different skill definition than the
original hub sees.

## Scope reduction, recorded

The original hub is constructed fresh in every `describe`'s `beforeEach`, so
each file may hand it a *different* registry. A substituted hub is a separate
process configured once at startup and cannot follow that. Four of the eight
files bring their own config:

```
lasso.test.ts   listen-with-client-nlu.test.ts   personal-report.test.ts   proactive.test.ts
```

Running those against a hub configured from `TEST_SKILL_CONFIG` compares two
*differently configured* hubs, which is not a substitution result. The first
full-suite run did exactly that and produced a false failure:
`ClientNLU: ... memo PROSPER` expected `PROSPER` and got
`referenceLiveLongProsper`, purely because that file defines
`{ name: LIVE_AND_PROSPER, memo: "PROSPER" }` while `TEST_SKILL_CONFIG` defines
`memo: 'referenceLiveLongProsper'`.

So this lane runs only the four files that share `TEST_SKILL_CONFIG`
(`listen`, `listen-with-agents`, `listen-with-simulated-asr`, `hub-client-cli`)
via `tests/r01-shared.js`. **The excluded four are a scope reduction, not a
pass.** Covering them needs a hub that can be reconfigured per test.

## The generated registry is temporary, by necessity

Phoenix's gateway resolves its skills index from
`packages/gateway/resources/skills/`, and S-06 pins every file in that directory
to a source digest. The generated `skills-r01.json` / `example_manifest.json`
must therefore be written there for the run and **removed afterwards**, or
`S-06: every hub skill index and manifest file matches the pinned-source digest`
fails. Leaving them behind is what that test is for; it caught exactly this.

## Result

Both sides run the same four files with the same out-of-process original parser.

| run | passing | failing |
| --- | --- | --- |
| control — original hub | **9** | 2 |
| Phoenix gateway substituted | **8** | 3 |

The control's two failures are the external-agent cases already shown to be
unreachable out of process (see `../r01-external-agents/`). Phoenix reproduces
both, and adds exactly one:

```
Listen transaction > Early EOS and ASR hints (including templated ones)
  AssertionError: expected 4 to equal 3
```

## The one difference is a known divergence, now observed

`checkExpectations` expects three messages (SOS, EOS, final LISTEN) because the
expectation carries `intent: null`. Phoenix sent four — it routed to a skill.

The cause is the ASR backend, and both sides say so in their own logs. The
original, in the control run:

```
GoogleASRSession Incremental transcription contains a FastEOS trigger
word/phrase. Stopping ASR and returning.
```

Google STT streams interim results, so `earlyEOS: ['live']` truncates the
utterance at "live" and the parse yields no intent. Phoenix replaced dead Google
STT with Parakeet, a **batch** recognizer: it cannot interrupt an utterance
mid-stream, so "live long and prosper" is transcribed whole, parses to
`referenceLiveLongProsper`, matches the example skill, and produces a fourth
message.

This is divergence **H07b**, which until now read "intent-derived, not observed
in the reference". It is now observed, with a concrete original-client case, and
H07b has been updated to say so.

It is a real feature gap in the replacement rather than a harness artifact:
`earlyEOS` is a robot-visible behaviour, and a batch recognizer cannot provide
it. Closing it needs either a streaming replacement for Google STT or an
interim-emitting mode in Parakeet. **That is not done, and is not claimed.**

## Reproduce

```
docker network create r01net
docker run -d --name r01-orig-parser --network r01net -v <scratch>:/work -w /work \
  node:8.9.4-slim node r01-standalone-parser.js
docker run -d --name r01-test --network r01net -v <scratch>:/work \
  -w /work/packages/integration-tests-int node:8.9.4-slim sleep 3600
docker run -d --name r01-phoenix-hub --network container:r01-test -v <phoenix>:/phoenix -w /phoenix \
  -e PORT=8098 -e ETCO_server_hubTokenSecret=my-hard-kept-secret \
  -e NET_parser=r01-orig-parser:9999 -e NET_history=127.0.0.1:9 \
  -e ETCO_hub_skillsConfig=skills-r01.json \
  node:22.22.0-slim node packages/gateway/src/index.js

# control
docker run --rm --network r01net -v <scratch>:/work -w /work/packages/integration-tests-int \
  -e R01_PARSER_BASE_URL=http://r01-orig-parser:9999 \
  node:8.9.4-slim ../../node_modules/.bin/mocha -r ts-node/register ./tests/r01-shared.js
# substituted
docker exec -e R01_HUB_EXTERNAL=1 -e R01_HUB_PORT=8098 -e R01_SKILL_PORT=8099 r01-test \
  ../../node_modules/.bin/mocha -r ts-node/register ./tests/r01-shared.js
```

## Still outstanding for R-01

Skill substitution, the all-Phoenix run, per-case HTTP/WS/JCP and history/data
side-effect capture, adversarial controls over the comparison itself, and a
hub-reconfiguration seam that would let the excluded four files run.
**R-01 remains `todo`.**
