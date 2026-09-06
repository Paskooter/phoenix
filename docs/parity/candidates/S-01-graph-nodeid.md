# S-01 GraphSkill session node identity repair

Status: **candidate, awaiting lead review**

Base: `20bbfaad61a9360c5bd09906b068e7b181424ddf`

Reference: `5c0a7390539663ba749d360de348a428c088505c`

## Source cause

The pinned Pegasus source uses one `GraphManager` singleton for a co-hosted
skill process. `Graph.addNode` registers every node through
`GraphManager.instance.addNode` (`packages/baseskill/src/graph/Graph.ts:59-74`),
and `GraphSkill` starts and continues through that same singleton
(`packages/baseskill/src/GraphSkill.ts:21-25,81-84`). `GraphManager.addNode`
assigns the next process-wide integer (`packages/baseskill/src/graph/GraphManager.ts:117-131`).

The frozen original production adapter constructs `new Chitchat()` before
`new PersonalReport()` (`scripts/parity-production/original.cjs:43-45,98-99`).
Chitchat registers four nodes before its report graph is constructed. The
report graph then registers the rest of its nodes in the factory/subgraph order
from `packages/report-skill/src/PersonalReport.ts:37-147`. Its active response
session and trace therefore carry the globally allocated IDs.

Phoenix had created a private `GraphManager` inside every `createGraphSkill`,
and the combined host imported/constructed report before chitchat. The report
graph consequently started four IDs early: source case `skill:report-known`
and the report corpus rows expected `nodeID` 35/36 and later IDs, while the
candidate emitted 31/32 and corresponding values. This is the 129 trace-node
and 11 session-node mismatch family in the preserved strict comparison
`.parity/reviews/n08-integration-root/production/comparison.json`.

## Bounded repair

`createGraphSkill` now accepts an optional `graphManager`. Its default remains
a fresh manager so independently deployed/custom skills retain their own
allocation scope. The built-in co-hosted Chitchat and PersonalReport handlers
explicitly use `sharedGraphManager`, and the skills index evaluates Chitchat
before PersonalReport to match the source adapter's construction order. Their
node maps are still shared for lookup, as in Pegasus; no response-side ID
offset or comparator normalization is added.

Other Phoenix-only built-ins retain isolated managers because they are not
constructed by the pinned two-skill Pegasus production adapter. A deployment
that co-hosts additional source GraphSkills must explicitly provide the same
shared host manager and source construction order.

## Controls

The source-only witness is
`packages/skills/tools/s01-graph-nodeid-source.cjs`. It resets the source
singleton, constructs Chitchat then PersonalReport, and records the actual
Node 8 graph initial IDs, node counts, and full node allocation. The candidate
test `packages/skills/test/graphNodeIdentity.test.js` verifies shared global
allocation, trace/node lookup, and the isolated default path.

The pinned source witness completed with Node `v8.9.4` and exit 0. Its raw
stdout is retained at
`.parity/reviews/s01-graph-nodeid/source-node8.stdout` (SHA-256
`57247c7401d7aa4a94a6fd2cbc41a32d5fd20af64d80ad01c971bcbb40f9d81f`); the
container command and exact image pin are in
`source-node8-command.json`. The candidate counterpart is
`candidate-node22.json`, and the derived comparison is `comparison.json`.
Both sides report a 45-node global allocation, Chitchat initial ID 1, report
initial ID 36, and report `Send All Mims` ID 35. The only name difference is
the pre-existing `CalendarOutro` versus `Calendar Outro` label; the complete
numeric ID sequence is equal. This control validates allocation and lookup,
not the broader graph node behavior.

The preserved source production capture already supplies the HTTP-level oracle;
the candidate's fresh 43-case recapture and strict comparison remain a lead
verification step. No old capture or golden is retagged here.

## Validation

```text
node --test packages/skills/test/graphNodeIdentity.test.js \
  packages/skills/test/graphSkill.request.test.js \
  packages/skills/test/graph.test.js
# 11 passed, 0 failed

node --test packages/skills/test/*.test.js
# 109 passed, 0 failed
```

The original source witness must be run in the pinned Node 8 container using
the frozen reference tree; its output is intentionally retained separately
from Phoenix captures. This candidate does not claim full graph lifecycle or
session migration parity; those remain outside the bounded identity repair.
