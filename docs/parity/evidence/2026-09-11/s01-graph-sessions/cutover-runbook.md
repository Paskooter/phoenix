# S-01 acceptance 3 — in-flight graph sessions across a cutover (deployment half)

Pinned original: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`.
Phoenix head for this closure: `6c94aac` (branch `w14/s01`), plus the artifacts below.

This closes the one clause S-01 was held open for — *"Specify whether in-flight reference
sessions must survive a cutover and verify the migration/reset policy before release."* — by
narrowing it, as the task authorises, to the **skill-side contract that is observable here**
(already closed by `README.md`) plus a **precise, runtime-tested deploy-time runbook** that root
executes on release.

---

## 1. Specification (what the original requires)

An in-flight graph session is an opaque blob that carries **only numeric node ids**
(`GraphManager.ts:55-60` writes `{id, nodeID, data, trace}`; `:73` and `:101` read
`data.skill.session.nodeID`). The manager that resolves that id is **per host** and allocates
ids sequentially from 0 **in graph construction order** (`GraphManager.ts:117-129`).

Therefore:

| Cutover | Must the session survive? | Why |
| --- | --- | --- |
| restart of the **same** deployment shape | **yes** | same process form + same graph construction order ⇒ identical id allocation ⇒ the blob resumes at the same node |
| **change** of deployment shape (standalone ⇄ cohosted, or a re-ordered registry) | **no — drop or re-launch** | ids shift; the blob would be silently reinterpreted in the target node-id space |

## 2. Why the cloud cannot enforce this (VERIFIED against pinned source + runtime)

The original never validates a session against the host that minted it:

* `GraphSkill.ts:81,84` — `handle` branches straight into
  `GraphManager.instance.start(this.graph, data)` / `.exitNode(data)`; there is no host-shape
  check anywhere on the request path.
* `GraphManager.ts:6-44` — one process-wide singleton, **no session registry**; the only session
  state is the blob itself.
* `GraphManager.ts:69-115` — `enterNode`/`exitNode` validate only that
  `this.getNode(session.nodeID)` resolves *inside the current manager*.
* `hub/src/skill/SkillRequestHelper.ts:36-63` — the hub builds a `LISTEN_UPDATE` from
  `input.context.skill.session` after checking only that a session exists (`:39`) and that
  `input.context.skill.id === skillID` (`:43`); it never inspects or rewrites the blob.
* `hub/src/listen/ListenTransactionHandler.ts:431-435` — the `CONTEXT` (which carries the
  session) arrives **from the robot** via `handleContextMessage`; a source-wide grep of
  `packages/hub/src` shows the hub only **reads** `skill.session` (the sole writer is the skill
  that created it) and extracts just the id for launch history
  (`hub/src/utils/TransactionHelper.ts:24-27`). The hub stores no session.

Consequently the **deployment**, not the cloud, owns the drop/re-launch decision. Observed at
runtime (`packages/skills/test/graph.cutover.test.js`):

```
standalone  PHOENIX_SKILL_ID=report-skill  -> report graph initial nodeID = 31
cohosted    combined builtin host          -> chitchat = 0, report = 35
same shape booted twice                    -> byte-identical fingerprint   (resume-safe)
standalone session offered to cohosted host-> HTTP 200 SKILL_ACTION, nodeID 35, NOT an ERROR
```

The last line is the gap: a cross-shape session is **not refused** — it is silently reinterpreted
in the target id space. `README.md` records the same for the live HTTP entrypoint
(`packages/skills/test/graph.lifecycle.test.js`, test 12).

## 3. The migration/reset policy (deployment procedure)

> **Policy.** On every release that changes the deployment shape, any in-flight graph-session
> blob minted under the previous shape MUST be dropped (the transaction ended) or re-launched
> from a fresh `LISTEN_LAUNCH` (which creates a new session; `GraphManager.ts:49-52` throws
> `Skill session should not exist here` if one is carried in). Sessions MAY be carried across a
> restart of the identical shape.

The policy is encoded as an executable gate so it is not a prose promise:
`scripts/parity-s01/cutover-gate.mjs` fingerprints the **live** node-id allocation by launching
each hosted graph skill over real HTTP and reading `session.nodeID`, then compares it to the
fingerprint persisted at the last cutover.

### Runbook (root, on release)

Run **before** the cutover, against the currently deployed shape, to record the live shape:

```bash
# per-skill (standalone) containers, one process per skill
node scripts/parity-s01/cutover-gate.mjs \
  --url http://127.0.0.1:9003 --skills report-skill --state .parity/s01-shape.json --accept

# combined host (no PHOENIX_SKILL_ID), every hosted graph skill
node scripts/parity-s01/cutover-gate.mjs \
  --url http://127.0.0.1:9000 --skills chitchat-skill,report-skill \
  --state .parity/s01-shape.json --accept
```

Run **after** the cutover, without `--accept`:

```bash
node scripts/parity-s01/cutover-gate.mjs \
  --url <new-url> --skills <hosted-graph-skills> --state .parity/s01-shape.json
```

* **exit 0** — shape unchanged. In-flight sessions may resume; nothing to do.
* **exit 2** — shape changed. **Drop or re-launch every in-flight graph session** (end the
  transaction on the robot, or trigger a fresh launch), then re-run with `--accept` to record the
  new shape. The gate prints the two fingerprints and the affected `{skill, nodeID}` rows.
* **exit 3** (first run, no state) — treat as *changed*: nothing may resume until a shape is
  recorded.

The same decision rule is the exported `decideCutover(prevFingerprint, nextFingerprint)`.
`.parity/` is runtime state and is not committed.

## 4. Verification receipts

| Claim | Basis |
| --- | --- |
| session carries numeric node ids only; no shape identity in the blob | VERIFIED — `GraphManager.ts:55-60,73,101`; `phoenix-graph-contract.json` |
| skill never validates host shape | VERIFIED — `GraphSkill.ts:81,84`; runtime test 3 |
| hub never persists/validates the session | VERIFIED — grep of `packages/hub/src` (reads only); `SkillRequestHelper.ts:36-63`, `ListenTransactionHandler.ts:431-435`, `TransactionHelper.ts:24-27` |
| same shape ⇒ identical allocation ⇒ resume | VERIFIED (runtime) — cutover test 1, two combined boots fingerprint-equal |
| shape change ⇒ different allocation | VERIFIED (runtime) — 31 vs 35 |
| cutover gate decides resume vs drop correctly | VERIFIED (runtime) — cutover tests 2; CLI exit 0/2 exercised end-to-end |
| operator actually runs the gate on the release | UNKNOWN — release-time process, not observable from a worktree |
| deployed hub/robot firmware actually drops/re-launches after the gate says drop | UNKNOWN — robot-side behaviour, out of worktree scope (root owns hardware) |

## 5. Falsification (performed, concrete)

`scripts/parity-s01/cutover-gate.mjs:117` — the cutover rule's terminal line

```js
return prevFingerprint === nextFingerprint
```

broken to `return prevFingerprint !== nextFingerprint`. The named test
**`S-01 the cutover gate resumes only an unchanged shape and drops on a shape change`** fails:

```
not ok 2 - S-01 the cutover gate resumes only an unchanged shape and drops on a shape change
  failureType: 'testCodeFailure'
  error: |-
    an unchanged shape may resume in-flight sessions
    + actual - expected
      { + changed: true, + decision: 'drop-or-relaunch'
        - changed: false, - decision: 'resume' }
```

Restored → 3/3 pass.

## 6. Retained gaps (not closed here)

* **UNKNOWN — robot-side cutover behaviour.** Whether the deployed robot actually ends or
  re-launches in-flight sessions after the gate reports a shape change is not observable from a
  worktree. This runbook makes the *cloud/deployment* side precise and runtime-tested; the
  robot-side action remains an operator step.
* **UNKNOWN — release-time execution.** The gate is verified in-process and over real HTTP in
  tests; whether root runs it on the actual release is a process fact, not a code fact.
* The 218 strict-smoke differences (157 removed, none added) recorded in the prior S-01
  implementation review are unchanged by this work.

## 7. Source corroboration (archive MCP)

The citations above were read from the local pinned checkout
(`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`) and then **re-read through the Jibo
archive MCP** (`https://pvindex.org/mcp`, `gitea_read_file`, `repo=jiboV2/pegasus`,
`ref=5c0a7390539663ba749d360de348a428c088505c`); the MCP bytes are byte-identical to the local
checkout for all five files (diff clean apart from the MCP header line and a trailing newline), so
the `file:line` citations are MCP-corroborated.

Corroborating archive documents (read via `jibo_read`):

* `/confluence/display/SER/Pegasus+Hub+Messages` — the protocol table says the
  `CONTEXT` message is *"Various runtime context from robot. Can arrive in between audio packets."*
  and defines

  ```
  export type ContextMessage = BaseMessage<'CONTEXT', {
      general: GeneralData;
      runtime: RuntimeContext;
      skill: SkillData;
  }>;
  ```

  with `SkillData` documented as *"Keeps track of which skill we are in and what node within the
  skill / Also keeps the session data for that particular skill session and history"* and
  `session: { id: string; nodeID: number; data: any; trace: {...} }`. This confirms the session blob
  with a **numeric** `nodeID` travels in a robot-supplied `CONTEXT` message — the cloud is not the
  session store.
* `/confluence/display/SDK/How+to+Write+Tests+for+Cloud+Skills` — the framework's own tests assert
  `response.data.skill.session.nodeID` and `session.trace` per turn, e.g.
  `{nodeID: 0, transition: 'Success'}` then `{nodeID: 8, transition: null}`; the ids are plain
  numbers with no shape/host identity.

