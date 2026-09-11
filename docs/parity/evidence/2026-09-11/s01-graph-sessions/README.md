# S-01 — GraphSkill sessions and graph execution

Pinned original: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
(`packages/baseskill/src/GraphSkill.ts`, `src/graph/Graph.ts`, `src/graph/GraphManager.ts`,
`src/graph/nodes/Node.ts`, `src/graph/Types.ts`, `tests/**`), executed under the archived
`node:8.9.4-slim` (`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).

## Method

Two receipts are produced and diffed cell-by-cell over 66 probe names:

* `source-graph-contract.cjs` — loads the **pinned original compiled `lib/`** under Node 8.9.4,
  builds real `Graph`/`Node`/`GraphSkill` objects, drives a concrete `GraphSkill` subclass
  through the real `BaseSkill` express route wrapper, and records every response, session blob,
  trace, node id and thrown error. → `source-graph-contract.json`
* `phoenix-graph-contract.mjs` — runs the same probe names against the real Phoenix graph layer
  (`packages/skills/src/graph/*`, `createGraphSkill`, `skillRoute`). → `phoenix-graph-contract.json`
* `compare.py` — structural flatten + diff. Normalizes only generated session ids, `msgID` and
  `ts`; everything else is compared verbatim. Exit 0 with `DIFFS (0)` is the current state.

```
docker run --rm --network none -v "$PWD:/review" \
  -v /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro \
  node:8.9.4-slim node /review/source-graph-contract.cjs /runtime /review/source-graph-contract.json
node phoenix-graph-contract.mjs phoenix-graph-contract.json
python3 compare.py     # compared probes: 63  accepted: 3  DIFFS (0)  -> exit 0
```

`source-graph-contract.cjs` must not `require('@jibo/utils')` (the umbrella index terminates the
Node 8 process silently with status 0); it loads `@jibo/utils/lib/logging` directly.

## Verified contract (all observed on both runtimes)

| Surface | Source | Phoenix |
| --- | --- | --- |
| Graph exits | duplicate name → `Graph 'G' has duplicate exit transition names`; empty list → `… needs to have at least one exit transition` | ✅ identical |
| `Graph.initial` | left `undefined` by the constructor until the first node/subgraph is added (Graph.ts:22, 74-76, 161-163) | ✅ identical |
| `addNode` mapping guards | non-unique / non-matching-length / missing-transition / invalid-destination messages | ✅ identical |
| Destination typing | `dest instanceof Node` (Graph.ts:96) — a duck-typed `{enter(){}}` is rejected | ✅ identical |
| Node registration | `GraphManager.addNode` — already-added vs already-in-a-graph messages | ✅ identical |
| Node-id allocation | sequential from 0 per manager, `getNode`/`hasNode`, `nodeIDCounter` | ✅ identical |
| `finalize()` | dangling transition, unknown exit name, foreign destination, unreachable node, unconnected exit | ✅ identical |
| Reachability | `forEachDescendent` BFS order `[B, C]`, early termination on a truthy handler, `[B, C, D]` otherwise | ✅ identical |
| `addSubGraph` | node registration/dupe checks, mapping length/coverage, already-assigned-exit override, initial inheritance, `node.graphs` order | ✅ identical |
| `start()` | session must not exist; creates `{id: uuid, nodeID: graph.initial.id, data: {}, trace: []}` then enters | ✅ identical |
| `enterNode` / `exitNode` | `Skill session is required`; `Node id 'N' isn't a part of this graph` | ✅ identical |
| Trace updates | `enter` pushes `{nodeID, transition: null}`; `exit` sets the last element's `transition`; terminal transition returns `null` | ✅ identical |
| Trace guards | `Trace should exist`, `Trace transition shouldn't exist`, `Unexpected trace node ID`, `State 'X' returned unregistered transition 'Y'` | ✅ identical |
| `data.result` | `result.result \|\| null`, overwritten every transition | ✅ identical |
| `writeDotFile` | non-finalized → `Can't render dot file of a non-finalized graph 'G'`; rendered dot text byte-identical | ✅ identical |
| GraphSkill launch | `Skill Entry` analytics with `was_hey_jibo_launch`/`user_initiated`; non-final action keeps the transaction open; no-action node → `final:true, fireAndForget:true, action:null` | ✅ identical |
| GraphSkill update | continues from `session.nodeID`; multi-turn chain `0→1→2` with the source trace; post-terminal update is silently terminal | ✅ identical |
| GraphSkill redirect | `SKILL_REDIRECT` with the node's redirect payload plus `skill` | ✅ identical |
| Unknown request type | `Unknown request type 'X'` | ✅ identical |
| Wire error envelope | `{type:'ERROR', msgID, ts, data:{message, skill:{id}}}` at HTTP 200, message from the thrown error | ✅ identical |

Corroborating original documentation: *How to Write Tests for Cloud Skills*
(`/confluence/display/SDK/How+to+Write+Tests+for+Cloud+Skills`, read via the archive MCP) asserts
`response.data.skill.session.nodeID` and `session.trace` per turn and shows exactly this shape —
`{nodeID: 0, transition: 'Success'}` for a consumed node followed by `{nodeID: 8, transition: null}`
for the freshly entered one.

## Golden lifecycle (observed on both runtimes)

```
launch   nodeID 0  final false  trace [{0,null}]
update 1 nodeID 1  final false  trace [{0,'Answered'},{1,null}]
update 2 nodeID 2  final true   trace [{0,'Answered'},{1,'Confirmed'},{2,null}]
update 3 nodeID 2  final true   fireAndForget true  action null  trace unchanged
```

`session.data` is `{}` unless a skill writes to it (the per-turn `result` is never persisted).
A byte-identical retry of the same pre-state session replays identically. A session whose last
trace element already carries a transition is refused (`Trace transition shouldn't exist`), a
session with a mismatched trace node is refused (`Unexpected trace node ID`), and a session whose
`nodeID` is outside the target graph is refused (`Node id 'N' isn't a part of this graph`).

## Divergences found and fixed

### 1. `Graph.addNode` accepted any duck-typed destination

`Graph.ts:96` uses `dest instanceof Node`; Phoenix accepted `dest && typeof dest.enter === 'function'`,
so a plain object with an `enter` method silently became a transition target. Fixed in
`packages/skills/src/graph/graph.js` to `dest instanceof Node`.

### 2. `Graph.finalize` foreign-destination message named the node

`Graph.ts:200-201` interpolates the **Node value**, which stringifies as `[object Object]`:

```
Graph 'G': Node 'A' has transition to Node '[object Object]' which isn't in graph
```

Phoenix substituted `.name` (`… to Node 'Foreign' …`). Fixed to interpolate the value itself.

### 3. `GraphManager.addNode` "already in a graph" message

`GraphManager.ts:123-125` reads `This node 'A' is already in a graph`; Phoenix said
`Node 'A' is already in a graph`. Fixed in `packages/skills/src/graph/graphManager.js`.

### 4. `Graph.initial` was `null` instead of `undefined`

Not observable on the wire, but observable to any JS caller and to the probe contract. Fixed to
leave the field unset like the source.

### 5. `Graph.writeDotFile` was missing entirely

`Graph.ts:234-325` is a public `Graph` API used by the original's graph tooling. Ported verbatim
into `packages/skills/src/graph/graph.js`, including the non-finalized guard, the recursive cluster
rendering and the exact emitted text (verified byte-for-byte against the original).

## Accepted deployment-shape divergences (not defects)

* The original keeps **one process-wide `GraphManager` singleton** with a locked constructor
  (`GraphManager.ts:8-46`). Phoenix exposes `sharedGraphManager` plus explicit per-skill managers so
  a cohosted host can opt into shared allocation while a separately deployed skill stays isolated.
  Recorded and reviewed under H-04/S-01 graph allocation; the probe is informational.
* Original skills are express routers inside `BaseHttpHandler`; Phoenix skills are plain async
  handlers behind `skillRoute`. The route-visible behaviour (status 200, envelope, `timings.total`)
  is identical.

## In-flight sessions and cutover (S-01 acceptance 3)

**Specification.** The skill session is an opaque blob owned by the robot: `GraphManager` keeps no
session registry, and every byte of a session round-trips through the request/response
(`start()` writes it, `enterNode`/`exitNode` read it). The blob carries only *numeric* node ids.
Therefore:

1. An in-flight session **survives a restart of the same deployment shape** — same process form and
   same graph construction order ⇒ same node-id allocation ⇒ the session resumes at the same node.
2. An in-flight session **must not be carried across a change of deployment shape** (standalone
   `PHOENIX_SKILL_ID` process ⇄ combined cohosted host, or a re-ordered skill registry). Allocation
   shifts, and because the cloud keeps no shape identity it *cannot detect* the change: the session is
   silently reinterpreted in the target node-id space. The cutover must therefore drop or re-launch
   sessions; the cloud cannot enforce it.

**Verified at runtime** (`packages/skills/test/graph.lifecycle.test.js`, test 12):

* standalone `report-skill` restart: the captured session resumes on the new process, same opaque
  `session.id`, same `session.data` (no error, `SKILL_ACTION`).
* standalone launch allocates `report-skill` at nodeID **31**; the combined host allocates it at
  **35**. Feeding the standalone-minted session to the combined host returns HTTP 200 `SKILL_ACTION`
  — **not** an `ERROR` — and continues at the combined node id. A cross-shape session is not refused.

The original has the same property: `GraphSkill.handle` never validates a session against the host
shape, and `GraphManager` only checks that the id resolves inside the current manager.

**Deployment half (w14 closure).** The cutover clause is closed by narrowing it to the observable
skill-side contract above plus a runtime-tested deploy-time runbook — see
[`cutover-runbook.md`](./cutover-runbook.md). In short: pinned source shows the hub only *reads*
`skill.session` (`hub/src/skill/SkillRequestHelper.ts:36-63`) and receives the blob from the robot
(`hub/src/listen/ListenTransactionHandler.ts:431-435`), so the deployment, not the cloud, owns the
drop/re-launch decision. `scripts/parity-s01/cutover-gate.mjs` fingerprints the live node-id
allocation and prints resume vs drop; `packages/skills/test/graph.cutover.test.js` exercises it at
runtime (standalone `report-skill` = nodeID 31, cohosted = 35). Robot-side execution of the drop
stays UNKNOWN below.

## Falsification (performed, concrete)

1. `packages/skills/src/graph/graphManager.js:63`

   ```js
   if (traceElement.transition !== null) throw new Error("Trace transition shouldn't exist");
   ```
   broken to `if (false) throw new Error("Trace transition shouldn't exist");` — the corrupted/replayed
   session detector. Three named tests fail; the first is:

   ```
   not ok 5 - S-01 GraphManager transition guards detect unregistered, corrupt and replayed traces
     failureType: 'testCodeFailure'
     error: 'expected a rejected promise'
   ```
   (`not ok 8 - S-01 GraphSkill retries, corrupted and replayed sessions behave like the source` and
   `not ok 10 - S-01 live entrypoint rejects corrupted, cross-skill and replayed-launch sessions` fail
   with it.) Restored → 12/12 pass.

2. `packages/skills/src/graph/graph.js` (the foreign-destination message, the line fixed above)

   ```js
   + `transition to Node '${transCont.destination}' which isn't in graph`);
   ```
   broken to `` + `transition to Node '${transCont.destination.name}' which isn't in graph`); ``:

   ```
   not ok 1 - S-01 Graph construction and finalization reproduce every source error
     AssertionError
     + actual   "Graph 'G': Node 'A' has transition to Node 'Foreign' which isn't in graph"
     - expected "Graph 'G': Node 'A' has transition to Node '[object Object]' which isn't in graph"
   ```
   Restored → 12/12 pass, `compare.py` → `DIFFS (0)` exit 0.

## Open / not verified

* **UNKNOWN — robot-side cutover action.** Whether the deployed hub/robot actually ends or
  re-launches in-flight sessions after the cutover gate reports a shape change is not observable
  from this worktree. The deployment side is now specified and runtime-tested
  (`cutover-runbook.md`, `scripts/parity-s01/cutover-gate.mjs`); the robot-side action remains an
  operator step. S-01 acceptance 3 is closed as *specified + skill-side verified + deploy-time
  procedure verified in-process*, not certified end-to-end on hardware.
* **UNKNOWN — deployed BE/native ASR session continuation on real hardware.** Out of scope here
  (root owns hardware); the live evidence is HTTP-level against the real skills host.
* **INFERRED — `Graph.ts:104-108` is dead code.** The post-install loop
  (`Adding Node 'X', missing transition 'T'`) cannot fire because the checks at `Graph.ts:79-90`
  already force `transMapSet === node.transitionNames`. Phoenix omits it deliberately; no reachable
  behaviour differs.
* **NOT IMPLEMENTED — `GraphFactory` / `Utils.ts` helpers** are outside the S-01 acceptance list and
  untouched; the MIM factories that use them were already accepted under prior S-01 candidates.
* The 218 strict-smoke differences (157 removed, none added) recorded in the prior S-01
  implementation review are unchanged by this work: the probes here are a new, independent
  graph-layer comparison, not a replacement for the strict smoke gate.
