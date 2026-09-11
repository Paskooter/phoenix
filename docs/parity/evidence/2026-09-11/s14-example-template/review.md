# S-14 — Example/template skills and skill-host compatibility

Branch `w16/s14` (worktree `.parity/worktrees/w16-s14`, base `3dd1cfa`).
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`, read over the Jibo archive
MCP (`gitea_read_file` / `gitea_browse` / `jibo_read`); local pinned copies under `source/` with
hashes in `source.sha256.json`. The original was executed under the archived runtime
`node:8.9.4-slim` (`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).
Status: acceptance replayed at runtime against the pinned compiled original; three wire
divergences found and fixed; falsification performed.

## Pinned source (read over the Jibo archive MCP)

| Source | Path @ ref |
| --- | --- |
| Example skill | `packages/example-skill/src/{ExampleSkill,ExampleNode,IntentSplitNode,ExampleUtils,index}.ts` |
| Example suite | `packages/example-skill/tests/{ExampleSkill.test.js,index.js}`, `scripts/run-service.js` |
| Template skill | `packages/template-skill/src/{TemplateSkill,index}.ts`, `src/nodes/MemoSplitNode.ts` |
| Template suite | `packages/template-skill/tests/{TemplateSkill.test.ts,index.ts,main.ts}` |
| Template MIM | `packages/template-skill/mims/template-mim.mim` |
| Skill host | `packages/baseskill/src/SkillService.ts`, `packages/baseskill/src/BaseSkill.ts` |
| Test client | `packages/test-utils/src/skill-test/SkillConversation.ts`, `src/mockRuntimeData.ts` |
| Hub routing | `packages/hub/src/skill/SkillUtils.ts`, `src/skill/SkillRequestMaker.ts` |

## The skill package and the host contract (VERIFIED, quoted)

A skill package is a TypeScript npm package with `src/` (a `GraphSkill` subclass plus its graph
nodes), `tests/`, optional `mims/`, `scripts/run-service.js` and a `package.json` whose `start`
is `node scripts/run-service.js`. `run-service.js` is the whole deployment:

```
const exampleSkill = new main.ExampleSkill();
const service = new baseskill.SkillService(exampleSkill, { debug: true });
return service.init(port);
```

The host guaranteed exactly one route (`SkillService.ts`):

```
this.addHttpHandler('/v1/main', {
    handler: skillV1,
    authenticationRequired: false
});
```

and `BaseSkill` (the express handler behind it) wrapped the skill body in this envelope
(`BaseSkill.ts:21-31`):

```
const startTime = Date.now();
req.log.info(`Received a ${body.type} request`);
const response = await this.handle(req);
response.timings = { total: (Date.now() - startTime) };
return response;
...
} catch (error) {
req.log.error(error);
return this.buildErrorResponse(error);
```

`buildErrorResponse` produces `{type:'ERROR', msgID: getUUID(), ts: Date.now(),
data:{message: getErrorMessage(err), skill:{id: this.name}}}` at HTTP 200. The URL is never
skill-id-bearing: `SkillUtils.preprocessManifest` builds it as
`[cleanPathElement(baseURL), cleanPathElement(config.basePath), 'v1', 'main'].join('/')`, and the
pinned test client posts to `http://localhost:${port}/v1/main`
(`SkillConversation.ts:190-195`). The archive's own documentation says the same — *How to Write
Tests for Cloud Skills* asserts `response.data.skill.session.nodeID` / `session.trace` per turn,
and *How to Create a Cloud Skill* tells a new skill to `cp -r packages/template-skill
packages/hello-world-skill` and only then add a hub manifest entry, docker-compose port and launch
rule.

What the template/example skills exercised:

* **example-skill** — the graph-traversal exerciser. `IntentSplitNode` (a `NoOpNode`) routes on
  `memo` first and falls back on `nlu.intent`; `ExampleNode.enter` emits
  `SLIM: '<name>'` (+ ` MEMO: '<memo>'`); `ExampleNode.exit` walks a fixed transitioner. The
  pinned suite's four turns assert the exact `session.trace` arrays.
* **template-skill** — the skeleton. `MemoSplitNode` validates the launch memo
  (`{entry:'SomeThing'}`), then an `ANFactory` sub-graph plays `mims/template-mim.mim`
  (`prompt_id: template-skill_AN_01`, esml `This is a template skill`), then `DefaultNode('Complete')`
  ends the skill.

## Divergences found and fixed (VERIFIED, observed)

Exact request/response comparison (178 leaf checks, `source/compare.txt`) found three wire
divergences, all in the example/template skills' malformed-input path. Absolute node ids are
compared as offsets (see *Accepted divergences*).

### 1. `IntentSplitNode` did not read `data.result.memo` like the source

`IntentSplitNode.ts` reads the memo **unguarded**:

```
const memo = data.result.memo;
```

Phoenix guarded it (`data.result && data.result.memo`), so a launch with `result` missing/null
threw later at `data.result.nlu` instead of at `.memo`:

| Probe | Pinned original | Phoenix (before) |
| --- | --- | --- |
| `LISTEN_LAUNCH`, no `result` | `Cannot read property 'memo' of undefined` | `Cannot read properties of undefined (reading 'nlu')` |
| `LISTEN_LAUNCH`, `result: null` | `Cannot read property 'memo' of null` | `Cannot read properties of null (reading 'nlu')` |

The intent fallback arm also produced the modern V8 wording where the original emitted the Node 8
wording (`switch (nlu.intent)` → `Cannot read property 'intent' of undefined`).

* Change: `packages/skills/src/exampleSkill.js:91-111` — `sourceResultMemo(data)` /
  `sourceNluIntent(nlu)` localized precondition reads that throw the frozen Node 8 messages,
  matching the convention already used in `graph/graphSkill.js:25-30`, `graph/nodes.js:56-61` and
  `report/lassoClient.js:20-25`. The two source warning logs (`Unknown memo field, falling back on
  intent` / `No memo field in skill launch, falling back on intent`) were restored with a
  `childLog` guard (the Phoenix service logger has no `createChild`).

### 2. `MemoSplitNode` did not read `data.result.memo` like the source

`MemoSplitNode.ts:31-35`:

```
const memo: string = data.result.memo && data.result.memo.entry;
const intent: string = data.result.nlu.intent;
log.info(`Launching Template Skill with memo '${memo}' and intent '${intent}'`);
```

Same two-word divergence as (1):

| Probe | Pinned original | Phoenix (before) |
| --- | --- | --- |
| `LISTEN_LAUNCH`, no `result` | `Cannot read property 'memo' of undefined` | `Cannot read properties of undefined (reading 'memo')` |
| `LISTEN_LAUNCH`, `result: null` | `Cannot read property 'memo' of null` | `Cannot read properties of null (reading 'memo')` |

### 3. `MemoSplitNode` did not read `data.result.nlu.intent` at all

The source reads the intent for its log line **before** validating the memo, so a launch carrying a
valid memo but no `nlu` fails. Phoenix played the MIM instead — a behavioural (not cosmetic)
divergence with a different response type:

| Probe (`result = {memo:{entry:'SomeThing'}}`, no `nlu`) | Pinned original | Phoenix (before) |
| --- | --- | --- |
| `type` | `ERROR` | `SKILL_ACTION` |
| `data.message` | `Cannot read property 'intent' of undefined` | — |
| `data.action` / `data.final` / `data.skill.session` | absent | present |

* Change: `packages/skills/src/templateSkill.js:44-56` — the same two precondition helpers plus the
  source `log.info(...)` line (via the guarded `childLog`).

After the fixes `scripts/parity-s14/run.sh` reports `DIFFS (0)` over all three sections.

## What was replayed at runtime (VERIFIED, observed)

`scripts/parity-s14/run.sh` runs the **pinned compiled original** three times in fresh processes
(`node:8.9.4-slim`, `--network none`, `node /probe/source-oracle.cjs out.json <mode>`) and the
**real Phoenix skills HTTP service** (`createSkillService` / `createSkillsService` / `start`,
ephemeral `listen(0)` ports), then diffs the two structurally (`compare.py`). Result:
**3 sections / 178 leaf checks / 0 diffs** (`replay.json`, `source/compare.txt`).

* **example-skill** (82 checks) — the pinned `ExampleSkill.test.js` four-turn walk driven through
  the pinned `SkillConversation` (real `SkillService` on a free port): per-turn
  `session.trace`, esml, `final`, `fireAndForget`, `timings.total` type and `skill.id` are
  byte-identical, including the terminal turn's in-place transition
  `[{0,'doesJiboLikeThing'},{1,'A'},{2,'B'},{3,'A'}]`. Invalid intent (`'bla'`) returns
  `Unknown intent: 'bla'`. The `PROACTIVE_LAUNCH` memo arm and the unknown-memo-without-nlu arm
  match.
* **template-skill** (24 checks) — the pinned `TemplateSkill.test.ts` launches: `{entry:'SomeThing'}`
  → `This is a template skill` with `mim_id: template-mim`, `prompt_id: template-skill_AN_01`,
  `session.data` keys `['_mim']` and the source trace shape (memo-split node exits `Reactive` into
  the ANFactory sub-graph node, AN node registered first); `{entry:'SomeOtherThing'}` and `null` →
  `Template Skill launched with unknown memo: '<value>'`.
* **skill host** (72 checks, 15 probes) — `POST /v1/nope/main` → 404
  `URL not found: /v1/nope/main`; `GET /v1/main` → 404 `URL not found: /v1/main`; malformed /
  primitive / array JSON → HTTP 400 with the frozen Node 8 parser wording
  (`Unexpected end of JSON input`, `Unexpected token " in JSON at position 0`); empty body and
  `{}` → skill error `Cannot read property 'general' of undefined`; missing/null `result`,
  unknown memo-without-nlu, and template memo-without-nlu → the source precondition TypeErrors
  above; `NOT_A_TYPE` → `Unknown request type 'NOT_A_TYPE'`; `/healthcheck` → 200 `ok`.

## Acceptance 2 — independently deployed skills, all route forms (VERIFIED)

Each replacement was driven on its **own port** with the pinned client's requests, and both forms
are exercised (`packages/skills/test/s14ExampleTemplateSkillHost.test.js`):

* standalone `example-skill`: `POST /v1/main` and `POST /v1/example-skill/main` return identical
  stable fields (esml `SLIM: 'Node1'`, session shape, `final`);
* standalone `template-skill`: `POST /v1/main` and `POST /v1/template-skill/main` likewise;
* `start(0)` with `PHOENIX_SKILL_ID=example-skill` serves the selected skill at `/v1/main`;
* a co-hosted host (`createSkillsService({defaultId:'example-skill', …})`) serves both skills on
  `/v1/<id>/main` and routes the back-compat `/v1/main` to `defaultId`.

The standalone bodies also match the pinned original exactly, because a standalone deployment is a
fresh process whose `GraphManager` counter starts at 0 — the same base Phoenix uses.

## Focused unit tests (VERIFIED, observed)

`packages/skills/test/s14ExampleTemplateSkillHost.test.js` — **11 tests, 11 pass** — covers the
runtime replay above, the malformed-request matrix, the three fixed divergences, and all four
route-form facts.

## Falsification (performed, concrete)

Broke one full line in `packages/skills/src/exampleSkill.js`:

```
-    const node1 = new ExampleNode('Node1', () => ExampleTransition.A);
+    const node1 = new ExampleNode('Node1', () => ExampleTransition.B);
```

`node --test packages/skills/test/s14ExampleTemplateSkillHost.test.js` failed the named test
**"S-14 example-skill: pinned four-turn walk over the live /v1/main host"**:

```
not ok 1 - S-14 example-skill: pinned four-turn walk over the live /v1/main host
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + "SLIM: 'Node3'"
    - "SLIM: 'Node2'"
  expected: "SLIM: 'Node2'"
  actual: "SLIM: 'Node3'"
```

and the independent runtime harness failed the source oracle: `DIFFS (18)` across
`exampleSkill.turns[1..3]` (esml, nodeIDs, transitions, final, fireAndForget, `type`). Restoring
the line returned **11/11 tests** and **DIFFS (0)** (`falsification.log`).

## Full suite and gate (observed)

```
npm test → EXIT 0
# tests 1941
# suites 7
# pass 1933
# fail 0
# cancelled 0
# skipped 8
# todo 0
Checklist: 59/79 verified (74.7%)
Tracker structure, dependencies, evidence links and generated checklist are valid.
Strict production smoke gate (43 cases): {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

A first full run failed one unrelated test, `packages/account/test/loopProjectionEdges.test.js`
(`hookFailed: EACCES … mkdir '<worktree>/.parity/reviews/a04-projection-edges-20260910'`): a helper
docker mount had materialised a root-owned `.parity/` inside the worktree before its reference-path
guard was added. The directory was removed and the re-run was green (`npm-test-summary.txt`).

## Evidence classes

* **VERIFIED (observed)**: the pinned example/template/baseskill/test-utils source and its exact
  quoted lines; the skill package and host contract; the three divergences and their fixes; the
  178-check / 0-diff replay of the pinned suites and malformed-request surface on the live Phoenix
  skills HTTP service; the four route-form facts; 11 focused tests; the falsification; the full
  `npm test` (1941/1933/0) and the gate JSON.
* **INFERRED**: nothing in the compared surface. The pinned example-skill/template-skill node
  *names* (`AN:SL:Do MIM`, `Intent Split`, `Complete`) come from the compiled reference
  (`graph-source.cjs` probe, not archived verbatim), but the compared contract is ids/transitions,
  not names.
* **UNKNOWN**: whether the deployed Pegasus hub ever pointed a skill at a URL containing a skill id
  (every archived manifest and the pinned client use `<baseURL>/<basePath>/v1/main` only);
  robot-side deployment of the standalone launchers on real hardware is out of scope here.

## Divergence candidates (not changed; flagged)

* **Template graph base offset.** In the pinned original `Graph.addNode` allocates ids from the
  process-wide `GraphManager.instance`, so the template session's absolute node ids depend on how
  many graphs the process built first (a fresh process yields `initial=1`, AN node `0`; the
  comparison pins the *offset* shape). Phoenix isolates a standalone skill's manager at 0 and only
  opts into a shared manager for a co-hosted host. Already recorded and accepted under
  H-04/S-01 (`docs/parity/evidence/2026-09-11/s01-graph-sessions/README.md`).
* **Extra explicit routes.** The pinned `SkillService` registers `/v1/main` only; Phoenix's
  `createSkillsService` additionally serves `POST /v1/<skillId>/main` per skill. It is a superset
  for a co-hosted host and is unreachable unless a manifest registers that URL; the two forms were
  verified to return identical bodies.
* **Example/template skills in the combined registry.** `packages/skills/src/index.js`'s `SKILLS`
  lists `example-skill` and `template-skill`, while the archived hub manifests
  (`packages/hub/resources/skills/skills-{local,pegasus1,pegasus2}.json`) register neither (they are
  development examples, not deployed skills). Harmless — they are never the default and are only
  reachable on their explicit route.
* **`data.log.createChild`.** Source nodes call `data.log.createChild('<Node>')`; the Phoenix service
  logger has no `createChild`, so the port uses the logger itself. Log output only, not wire —
  the same class of cosmetic divergence S-03 accepted for `RouteNode`/`overrideSpeaker`.
