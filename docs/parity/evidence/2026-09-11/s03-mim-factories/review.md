# S-03 — MIM factories, no-input/no-match escalation and opt-in

Revision: `w15/s03` (worktree `.parity/worktrees/w15-s03`, base `30f2b46`).
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c` (read over the Jibo
archive MCP `gitea_read_file`; local pinned copies under `source/`, hashes in
`source.sha256.json`).
Status: acceptance replayed at runtime; one wire divergence found and fixed; falsification
performed.

## Pinned source (read over the Jibo archive MCP)

| Source | Path @ ref |
| --- | --- |
| Factories | `packages/baseskill/src/graph/mims/factories/{MIMFactory,QNFactory,ANFactory,MANFactory,OptInFactory}.ts` |
| Nodes | `packages/baseskill/src/graph/mims/nodes/{MultiTurnNode,QNNode,ANNode,MANNode,NMNode,NINode,RouterNode}.ts` |
| Opt-in nodes | `packages/baseskill/src/graph/mims/nodes/optIn/{RouteNode,YesNoWrongIDNode}.ts` |
| Looper node | `packages/baseskill/src/graph/nodes/SetLooperIDNode.ts` |
| Source suites | `packages/baseskill/tests/{MIMSkill,OptInSkill}.test.ts` |
| Harness skills | `packages/baseskill/tests/skills/{ExampleMIMSkill,ExampleOptInSkill}.ts` |
| Analytics enum | `packages/interfaces/src/skill/analytics.ts` |
| Base MIMs | `packages/baseskill/mims/en-us/{ProposalVerifyID,ProposalNoID,WrongID,Decline}.mim` |

The vendored base MIMs in `packages/skills/resources/mims/base/en-us/` were diffed against
the pinned source copies: **content-identical** (the only differences are the MCP header
line and the source's missing trailing newline).

## Wire divergence found and fixed (VERIFIED)

`packages/skills/src/graph/mims/optIn.js` emitted the **constant name** as the analytics
event string. The pinned source defines

```
packages/interfaces/src/skill/analytics.ts:7-10
export const EVENTS = {
    SKILL_ENTRY: 'Skill Entry',
    SKILL_OFFER: 'Skill Offer'
};
```

and `YesNoWrongIDNode.ts:72` tracks `skill.analytics.EVENTS.SKILL_OFFER`, i.e. the wire
value `'Skill Offer'`. `GraphSkill.track` (`GraphSkill.ts:145-157`) pushes the argument
verbatim:

```
145:    public track(data: Data, event: string, properties: any={}): void {
...
152:        data.analytics[this.name].push({
153:            event,
```

Phoenix's own contracts module already documented the correct value
(`packages/contracts/src/messages.js:533` "`'Skill Offer'` from the opt-in MIM node"), so
the emitter was the only outlier.

* Change: `packages/skills/src/graph/mims/optIn.js:97` `'SKILL_OFFER'` → `'Skill Offer'`.
* Test updated: `packages/skills/test/mimGraph.test.js:196` (was asserting the wrong value).

## What was replayed at runtime (VERIFIED, observed)

`scripts/parity-s03/replay-mim-factories.mjs` hosts the reconstructed source harness
skills on the **real skills HTTP service** (`createSkillService` + `node:http`) and POSTs
frozen `LISTEN_LAUNCH` / `PROACTIVE_LAUNCH` / `LISTEN_UPDATE` turns. Result:
**14 scenarios / 39 checks, 39 pass, 0 fail, exit 0** (`replay.json`).

* **MIMSkill.test.ts four runs** — `Successful`, `NoMatch`, `NoInput`, `Degenerate` — assert
  the exact `session.nodeID` sequence **and** the full `session.trace` array for the
  ExampleMIMSkill graph (ANFactory → MANFactory → two QNFactory subgraphs, 16 nodes). All
  four match byte-for-byte against the source expectations, including the degenerate
  escalation chain `QN NoInput → NI → NM → NM → NM → FinalNoMatch → parent NoMatch →
  next QN → NM → FinalNoMatch`. Node identity matching confirms the factory construction
  order is source-exact.
* **OptInSkill.test.ts branches** — proposal No-ID vs Verify-ID MIM selection, fused
  prompts, `yes`, `no`, `wrongID`, `cancel`, `notInLoop`, and the `loopmember` identity fix
  (SEQUENCE `[SET_PRESENT_PERSON(looperId, USER_OVERRIDE, 100), SLIM]`, `final:true`).

## Focused unit tests (VERIFIED, observed)

`packages/skills/test/s03MimFactories.test.js` — **34 tests, 34 pass** — covers the branches
the existing `mimGraph.test.js` did not:

* the exit-transition tables of every factory/node;
* `MIMFactory` QN arm + NoMatch and NoInput ladders to their terminal exits;
* `QNFactory` **cross-escalation** NI→NM and NM→NI, and the parent-visible exit value
  (Success vs NoMatch vs NoInput) by hosting the factory as a subgraph;
* `RouterNode` error branches (zero MIMs, >1 MIM, unknown `mim_type`) and
  `optional-response` → Question arm;
* the frozen session `_mim` machine (QN entry resets; NM/NI increment their own ladder;
  `noMatchMax` latch);
* opt-in: proposal selection, `RouteNode` speaker snapshot, the **cached-speaker restore**
  (`yes` with a dropped `perception.speaker`), **unknown speaker** (no snapshot, nothing
  restored), `no`, one-step no-input / no-match → decline, `wrongID → cancel` → decline,
  `wrongID → notInLoop` → NotInLoop, **unknown intents (`repeat`, `thanks`) →
  NotInLoop**, an unknown intent at the yes/no node throwing `Unknown intent: '<x>'`,
  `loopmember` with/without a referent, and touch-vs-speech modality.

## Falsification (performed)

Broke one full line in `packages/skills/src/graph/mims/factories.js:103` (the NM ladder
index):

```
-    const index = ++data.skill.session.data._mim.noMatch;
+    const index = (data.skill.session.data._mim.noMatch = 0, 1);
```

`node --test packages/skills/test/s03MimFactories.test.js` then failed **5 named tests**,
including the primary **"S-03 QNFactory exits the parent on NoMatch only after the NM
ladder is exhausted"** with the assertion `'nm one' !== 'nm two'`. The independent runtime
harness also failed the source oracle: **"MIMSkill / Degenerate run ... FAIL"** (37/39,
exit 1) — the escalation chain no longer terminates where the source test says it must.
Restoring the line returned 34/34 tests and 39/39 replay checks (exit 0).

## Full suite and gate (observed)

```
npm test → EXIT 0
# tests 1890
# pass 1882
# fail 0
# cancelled 0
# skipped 8
Checklist: 55/79 verified (69.6%)
Strict production smoke gate (43 cases): {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

A first full run had one flake unrelated to this task —
`packages/account/test/oobeRestartSIGKILL.test.js` "stray temp file after SIGKILL"
(passes 3/3 standalone; no stray temp file present; it is a SIGKILL-timing test under
concurrent load). The re-run was green.

## Evidence classes

* **VERIFIED (observed)**: the pinned factory/node/opt-in source and its line numbers; the
  `EVENTS.SKILL_OFFER = 'Skill Offer'` divergence and its fix; the 4 MIMSkill nodeID/trace
  replays; the 10 OptIn branch replays; 34 focused tests; the falsification; the full
  `npm test` (1890/1882/0) and the gate JSON.
* **INFERRED**: the two `OptInSkill.test.ts` no-input / no-match scenarios assert the
  decline **branch** rather than the exact turn index, because the source's
  `res_test/mims/OptInVerify.mim` fixture (which determines the Errors ladder length) is
  not in the archive; with the pinned base `OptInProposalVerifyID.mim` (zero
  Errors-category prompts) the `FinalNoInput`/`FinalNoMatch` exit is reached on the first
  answer. The `AfterOptIn` fixture's accepted-vs-not-in-loop prompt split is likewise
  modelled on the base MIM `!speaker`/`!!speaker` condition style (marked INFERRED in the
  harness header).
* **UNKNOWN**: the exact bodies of `res_test/mims/{Uber,Uber2,Uber3,Uber4,NoNMNI,OptInVerify,
  OptInDecline,AfterOptIn}.mim` (gitignored in the source repo, not archived); the MIMSkill
  assertion therefore pins structure and node identity, while prompt text is fixture-defined.
  "Repeat"/"thanks" are verified only in the sense the pinned `SetLooperIDNode.ts:57-60`
  contract gives them (unknown intent → default → NotInLoop) — no archived transcript
  exercising them at the yes/no node was located.

## Divergence candidates (not changed; flagged)

* `RouteNode.ts:26,44` and `YesNoWrongIDNode.ts:43-45` access `data.log.createChild(...)`,
  `data.runtime.perception.speaker` and `data.skill.session.data._optIn.speaker` without
  the null guards Phoenix adds. Phoenix is strictly more defensive; identical for
  well-formed robot input, different (throw vs no-throw) for malformed requests.
* `RouteNode.ts:48` logs `Opt-In Type: <type>`; Phoenix omits the info log. Cosmetic.
* `overrideSpeaker` (`GraphSkill.ts:167-177`) logs a warning when the id is falsy; Phoenix
  sets it silently. Cosmetic.
