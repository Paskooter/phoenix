# S-01 GraphSkill request dispatch candidate

Status: **bounded GraphSkill precondition repair; awaiting lead review**

Owner: Luna Max
Base: `0f4b856`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Audit date: 2026-09-06

This candidate repairs the immediate request dispatch and graph session
preconditions after the global request schema gate was removed. It follows the
source `GraphSkill` field order and skill fallback mutation, and brings
`GraphManager` session, node, and transition checks to the source contract.
Graph node behavior and later graph lifecycle differences remain outside this
bounded change.

This supersedes the earlier request-boundary comparison for the
`LISTEN_UPDATE`-without-session row: after this graph repair, Phoenix uses the
source `Skill session is required` path.

## Source contract

The authoritative frozen source is:

| source | SHA-256 |
| --- | --- |
| `packages/baseskill/src/GraphSkill.ts` | `5648740b29d386549747d673452a5ca834103e24b6858f77f710572a4b399b3e` |
| `packages/baseskill/src/graph/GraphManager.ts` | `d17d9a53339011ed1e4e7bea321e8552ac81831529f904089148bf1ecdbc87a1` |

`GraphSkill.handle` accesses `body.data.general` before any skill fallback,
requires truthy `accountID` and `robotID`, mutates a missing/falsy
`body.data.skill` to `{id:this.name}`, fills a falsy `skill.id`, validates the
name, warns on absent `result`, and only then dispatches launch/update. A
launch passes its existing session through to `GraphManager.start`; the source
manager rejects a truthy session with `Skill session should not exist here`,
while falsy sessions are replaced by the new session. An update delegates
missing-session handling to `GraphManager.exitNode`.

`GraphManager.enterNode` and `exitNode` first require a session, then resolve a
node and report `Node id '...' isn't a part of this graph`. Transition handling
sets `data.result`, checks the named transition, requires a trace, validates
the last trace element, and only then mutates its transition.

The source hashes above are recorded from the frozen reference tree. The
candidate keeps Phoenix's per-skill `GraphManager` ownership because the host
runs several skills in one process; this does not change the request or
session checks.

## Phoenix change

`packages/skills/src/graph/graphSkill.js` now:

- performs general/account/robot checks before skill fallback and before the
  request type branch;
- mutates the original `body.data.skill` for missing/falsy skill and ID
  values, matching source shallow-copy timing;
- preserves source debug and missing-result warning order through the route
  context logger; and
- preserves launch sessions until `GraphManager.start`, where truthy sessions
  are rejected and falsy sessions are replaced by the source guard/initializer;
- delegates update-without-session to `GraphManager`, which now emits the
  source `Skill session is required` message.

`packages/skills/src/graph/graphManager.js` now has the source session checks,
node wording, transition wording, trace existence check, and trace element
validation/order.

The affected chitchat intent fixture now includes source-shaped
`general.accountID` and `general.robotID`; it had previously bypassed the
GraphSkill preconditions with an incomplete direct body.

## Pinned differential

`packages/skills/tools/s01-skill-graph-source-boundaries.cjs` runs the pinned
Node 8.9.4 source HTTP service with real `ExampleSkill`, `Chitchat`, and
`PersonalReport` handlers. It covers null, array, scalar, missing, empty, and
mismatched general/skill fields; missing/null/scalar request types; and update
session variants. It also directly calls the source handlers to observe
fallback mutation that an HTTP error envelope cannot expose.

Command:

```text
docker run --rm --network none -w /ref/packages/chitchat-skill \
  -v packages/skills/tools/s01-skill-graph-source-boundaries.cjs:/fixture/probe.cjs:ro \
  -v .parity/reference/5c0a7390539663ba749d360de348a428c088505c:/ref:ro \
  node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /fixture/probe.cjs /ref
```

The earlier source/candidate HTTP probes produced 84 exact complete normalized
`ERROR` envelopes out of 87 (29 cases across each of three skills). Their only
three differences were the ordinary Node 8 versus Node 22 diagnostic wording
for `data:null`:

| fixture | Node 8 source | Node 22 candidate |
| --- | --- | --- |
| `{type:"NOT_A_REQUEST", data:null}` | `Cannot read property 'general' of null` | `Cannot read properties of null (reading 'general')` |

The follow-up localizes only the GraphSkill `body.data.general` intermediate
when `body.data` is null or missing. A fresh rerun of the same 87 cases then
matches 87/87 complete normalized status/body results. This wording conversion
does not inspect or rewrite errors raised by graph nodes, custom handlers, or
other property accesses.

The explicit source/candidate messages agree for the remaining field and
session cases:

| fixture family | result |
| --- | --- |
| missing/false/null/scalar/empty general or account | `Skill request without general.accountID arrived` |
| missing/empty account with robot present | `Skill request without general.accountID arrived` |
| missing/empty robot with account present | `Skill request without general.robotID arrived` |
| missing/null/false/empty skill, empty/zero skill ID, skill array | `Unknown request type 'NOT_A_REQUEST'` after fallback to the concrete skill ID |
| scalar string/number skill | source assignment TypeError wording agrees |
| mismatched skill ID | `Incoming skill name doesn't match. This: '<skill>', incoming: 'other-skill'` |
| missing/null/number request type | `Unknown request type 'undefined'`, `'null'`, or `'0'` |
| update without or with null session | `Skill session is required` |
| update with empty/number session | `Node id 'undefined' isn't a part of this graph` |

The direct source mutation checks show missing, null, false, empty object,
empty ID, and array skill values all end with `body.data.skill.id` equal to
the concrete skill name before the invalid-type dispatch error. The candidate
tests cover those same mutations. The launch/session witness covers both
`LISTEN_LAUNCH` and `PROACTIVE_LAUNCH` with truthy and falsy sessions: truthy
objects remain unchanged when `GraphManager.start` rejects, while falsy values
are replaced by a newly initialized session.

Raw captures for the earlier 84/87 run are:

- source Node 8: `/tmp/s01-skill-graph-source-node8-20260906.log`
- candidate Node 22: `/tmp/s01-skill-graph-candidate-node22-20260906.log`

Fresh 87/87 captures after the targeted conversion are:

- source Node 8: `/tmp/s01-skill-graph-source-node8-20260906-repaired.log`
- candidate Node 22: `/tmp/s01-skill-graph-candidate-node22-20260906-repaired.log`

## Tests and remaining scope

Focused graph/request tests cover precondition ordering, mutation, logger
ordering, session/node checks, transition trace checks, and real graph,
chitchat, and report invalid-type/update requests:

```text
node --test packages/skills/test/graphSkill.request.test.js \
  packages/skills/test/skillRequest.test.js \
  packages/skills/test/graph.test.js
# 12 passed, 0 failed
```

The full skills test glob also passes after the launch/session correction:

```text
node --test packages/skills/test/*.test.js
# 95 passed, 0 failed
```

The existing broader skill lifecycle remains outside this candidate, including
provider failures, graph node semantics after dispatch, continuation data
shape, and the source process-singleton versus Phoenix per-skill manager
architecture. Engine-generated TypeError wording is retained as runtime
behavior; this candidate does not add broad error-string translation.
