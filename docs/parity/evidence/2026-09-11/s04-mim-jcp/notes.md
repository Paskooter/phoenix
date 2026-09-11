# S-04 — MIM rendering, conditions, selection and JCP output

Owner: Hermes worker (subagent, wave 15) · Branch `w15/s04`
Base revision: `30f2b46` (main) · Worktree `.parity/worktrees/w15-s04`
Reference (approved) revision: `5c0a7390539663ba749d360de348a428c088505c`
Date: 2026-09-11

Scope: the four S-04 acceptance criteria only — loaded MIM merging, conditions, weighted variants,
dice/coin, template expansion, ESML escaping, prompt IDs and meta fields; the JCP action/listen/
display trees, GUI thresholds and cancellation; and variation testing that does not loosen exact
structural comparisons. `docs/parity/tasks.json` and `DIVERGENCES.md` were not touched.

## 1. Pinned sources used

Prepared reference tree (the frozen source the task hands to the worker):

- `packages/baseskill/src/graph/mims/utils/slimmer/Slimmer.ts` — `generateSlim` (:35-53),
  `generateSlimSequence` (:61-87), `loadAndPrep` (:99-118), `generatePlay` (:126-183),
  `generateListen` (:189-195), `generateDisplay` (:203-224), `resolveView` (:236-276).
  Verified byte-identical to `/home/shell/work/pegasus` at `5c0a739`: `Slimmer.ts`, `graph/Utils.ts`,
  `graph/mims/utils/Utils.ts`, `chitchat-skill/src/utils/FunAndGamesUtils.ts` all `diff` clean.
- `packages/baseskill/src/graph/mims/utils/slimmer/Utils.ts` (:12-15 `isBirthday`,
  :20-27 `makePronounceable`).
- `packages/baseskill/src/graph/mims/utils/unify/Unify.ts` (:29-51 `unifyMims`,
  :61-81 `injectPromptsIntoBase`, :88-107 `loadAndPrep`).
- `packages/baseskill/src/graph/mims/common/Types.ts:55-96` — `MimConfig`/`Prompt` field list
  (`no_matches_for_gui`, `no_inputs_for_gui`, `es_auto_tagging`, `weight`, `auto_rule_override`).
- `packages/baseskill/src/graph/Utils.ts:28-36` — `generateJCPAction(behavior)` returns
  `{ type: JCP, config: { version: '2.0', jcp: behavior } }`; the behavior itself is placed at
  `config.jcp` (no extra SEQUENCE layer).
- `packages/baseskill/src/graph/mims/nodes/{ANNode,QNNode,MANNode,NMNode,NINode,RouterNode}.ts` —
  which Slimmer entry point each node calls and the `prepareMim` ordering.
- `packages/chitchat-skill/src/utils/FunAndGamesUtils.ts` — `Dice` (:11-25), `Coin` (:30-46).
- `packages/chitchat-skill/src/nodes/ProcessQueryNode.ts:146-156` — `addPromptData` injects
  `{ dice: new Dice(), coin: new Coin() }`.
- `node_modules/jibo-command-requester/lib/jibo-command-requester.js` (package version
  `4.0.6-home`) — Display :1654-1667, Listen :1675-1687, Play :1692-1702, SLIM :1709-1717,
  Parallel :1792-1801, Sequence :1808-1815, `generateTransactionID` :356-364.
- `node_modules/jibo-cai-utils/lib/jibo-cai-utils.js:1183-1201` —
  `RandomUtils.weightedRandomSample`, the sampler `Slimmer.generatePlay` calls.
- `packages/answer-skill/server.js:186-200` (escape + JCP builder) — present in the restored tree
  only; **not** part of revision `5c0a739` (`git show 5c0a739:packages/answer-skill/server.js` is
  empty; the file arrives with `c9bf1992d`). Treated as `INFERRED` authority, not pinned cloud
  source — see divergence candidates.
- Captured reference bytes: `packages/harness/resources/goldens/production-smoke/reference.json.gz`
  (43 cases, `implementation: "original"`, `runtime: "v8.9.4"`).

### Jibo archive MCP sources

| Query | Result | Use |
| --- | --- | --- |
| `jibo_npm_view { pkg: "jibo-command-requester" }` | versions include `4.0.6-home`; latest `6.0.0-d1cb358` | confirms the pinned requester version is an archived publication, so the local bundle is the real contract, not a reconstruction |
| `jibo_search { q: "MIM prompts weight auto_rule_override" }` | `/confluence/display/SDK/SDK+-+About+MIMS`, `/confluence/display/SDK/SDK+-+MIM+Editor` | documents the `.mim` authoring surface |
| `jibo_read { url: "/confluence/display/SDK/SDK+-+About+MIMS" }` | quoted below | condition/weight/prompt_id semantics |

Quoted from the SDK MIM doc (12,580 chars read):

> "When the MIM Behavior executes, it picks one of the available prompts from the appropriate
> category. The prompt can be chosen randomly or using logic supplied in the *Condition* field."

> ```
> "mim_type": "question", "rule_name": "rules/en-us/lights/YesNo.fst",
> "sample_utterances": "yes,no", "timeout": 6, "num_tries_for_gui": 1,
> "es_auto_tagging": true, "prompts": [ { "prompt_category": "Entry-Core",
> "prompt_sub_category": "Q", "index": 1, "condition": "",
> "prompt": "The lights in the ${rooms} are on. Would you like me to turn them off?",
> "media": "TTS", "prompt_id": "Entry-1" }, ... ]
> ```

`gitea_list_repos`/`gitea_read_file` do **not** contain the pegasus cloud repo (searches for
`generateJCPAction`, `Slimmer.ts`, `weightedRandomSample` over `gitea-repos,repository,npm` return
0 hits), so the pinned pegasus lines above are cited from the approved local revision
`5c0a739…` that the worker was given. Marked `VERIFIED (observed on disk)` rather than
`VERIFIED (MCP)`.

## 2. Divergences found and repaired

1. **Weighted selection did not match `RandomUtils.weightedRandomSample`.**
   `packages/skills/src/graph/mims/slimmer.js` used `r -= weight; if (r <= 0) return w.data;` with
   `w.weight || 1`. The pinned sampler sums `element.weight` raw, **skips** elements with
   `weight <= 0` in the selection loop, compares strictly (`rand < ongoingWeight`) and returns the
   empty object literal `{}` when nothing is selected. Measured against the real pinned sampler with
   `Math.random` pinned: `weights=[1,3] r=1` → `{}` (Phoenix returned `d1`), `weights=[0,0]` → `{}`
   (Phoenix `d0`), `weights=[-1,-1]` → `{}` (Phoenix `d0`), `weights=[5] r=1` → `{}`,
   `weights=[0.25,0.25,0.5] r=0.25` → `d1` (Phoenix `d0`). Now a line-for-line port.
   Reach: the `{}` regime needs a non-positive weight or `rng()===1`, which `Math.random` cannot
   produce; `weight: p.weight || 1` upstream turns a `0` weight into `1`, so only a negative weight
   reaches it. The exact-tie regime is reachable in principle for weights whose running total is hit
   exactly by `rng()*total`. With real `Math.random` and non-negative weights the *distribution* is
   unchanged — this is spec/boundary fidelity, not a live-traffic defect.
2. **PLAY/SLIM/LISTEN/DISPLAY in-memory key sets were incomplete.** The pinned requester always
   emits `speakOptions` (Play), `intents` (Listen), `options` (SLIM) and `overlay` (Display), with
   `undefined` values that JSON drops. Phoenix omitted the keys entirely, so a structural comparison
   against requester output could not be exact. New `packages/skills/src/graph/mims/protocol.js` holds
   the requester port and is now used by `slimmer.js` (PLAY/LISTEN/DISPLAY/SLIM/SEQUENCE) and
   `graph/nodes.js` (SEQUENCE/PARALLEL, re-exported so existing callers are unchanged).
3. **Uninitialized MIM state surfaced the wrong error.** `Slimmer.generatePlay` wraps its
   max-out bookkeeping in `try { … } catch { throw new Error('Skill data MIM state tracking has not
   been initialized; cannot track state.') }` (Slimmer.ts:185-200). Phoenix read `_mim` eagerly in
   `generateSlim` and then silently skipped the bookkeeping when it was undefined. Phoenix now
   mirrors the source try/catch and the source message.
4. **Fidelity cleanups.** `unifyMims` uses `log.createChild('Unifier')` (Unify.ts:30) when the
   deployment logger supports it; condition/template evaluation failures log at `error` level with
   the source's wording (Slimmer.ts:139-141, :153-155).

Nothing in `packages/harness`, the goldens, the compiler, the NLU inventory or `responders` was
changed, so the strict production gate inputs are byte-identical.

## 3. Runtime evidence (observed)

### 3a. Differential against the actual pinned dependencies — `ok`, exit 0

`node scripts/parity-s04/mim-contract-diff.mjs` loads
`jibo-command-requester@4.0.6-home` and `jibo-cai-utils` from the prepared reference tree and
compares them with Phoenix's builders (id-masked, `Reflect.ownKeys` + JSON):

```
ok   PLAY shape matches the pinned requester
ok   LISTEN shape matches the pinned requester
ok   DISPLAY shape matches the pinned requester (Slimmer call signature)
ok   SLIM / SEQUENCE / PARALLEL shapes match the pinned requester
ok   command IDs match the requester transaction-ID format
ok   weightedSample sampled points compared: 1313
ok   weightedSample matches RandomUtils.weightedRandomSample with Math.random pinned
{"result":"match","checks":7,"referenceTree":"/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c"}
```

### 3b. Strict production smoke over the live entrypoints — `match`, 0 differences

Baseline before the change (`30f2b46`, gate run captured first):

```
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

After the change (final `npm test`, see §7) the same gate reports `match`, 43 cases, 0 differences,
0 invariants, 0 coverage gaps, exit 0. The corpus independently exercises the S-04 surfaces
(inside case turns: 26 JCP actions, 65 PLAY, 65 SLIM, 9 SEQUENCE, **22 DISPLAY + 22 HIDE_DISPLAY**
— case 23 and case 26 report SEQUENCE children with `config.display` — and 2 LISTEN). Every
chitchat/report action is therefore compared byte-for-byte with the real cloud capture, including
the display/cancellation and listen trees.

### 3c. Focused test — 15/15

`node --test packages/skills/test/s04MimContracts.test.js` → `# tests 15 # pass 15 # fail 0`.
It asserts, among others:

- requester key sets/order/ID format for PLAY, LISTEN, DISPLAY, SLIM, SEQUENCE, PARALLEL;
- `generateJCPAction` places the behavior *directly* at `config.jcp` (SLIM for `generateSlim`,
  SEQUENCE for `generateSlimSequence`);
- the captured reference case `boundary:launch` PLAY node (id-masked) equals Phoenix's builder
  output plus `meta {prompt_id, prompt_sub_category, mim_id, mim_type}`;
- the first captured `DISPLAY` and `LISTEN` nodes rebuild exactly from the pinned builders, including
  `onCancel: [{ type: HIDE_DISPLAY, name: HIDE_MIM_VIEW }]`;
- the nine pinned `weightedRandomSample` boundary vectors and a 101-point sweep;
- `unifyMims` merge/transform/throw/missing-base behaviour plus the `loadMims` path/extension/parse
  error contract and the filename→`mim_id` fallback; condition filtering inside the `node:vm`
  PromptData sandbox; `''` on a throwing template; ESML passed through raw by the MIM path
  (the answer-skill builder is the escaping path); GUI thresholds; the tracking error; Dice/Coin.

## 4. Falsification

One full code line broken in `packages/skills/src/graph/mims/slimmer.js`:

```diff
-      if (rand < ongoingWeight) { result = weighted[i].data; break; }
+      if (rand <= ongoingWeight) { result = weighted[i].data; break; }
```

Observed while broken:

```
not ok 4 - weightedSample reproduces RandomUtils.weightedRandomSample at its boundaries
# tests 14
# pass 13
# fail 1

# scripts/parity-s04/mim-contract-diff.mjs
  - weightedSample weights=[5] r=1: ours="d0" theirs={}
  - weightedSample weights=[0.25,0.25,0.5] r=0.25: ours="d0" theirs="d1"
  - weightedSample weights=[0.25,0.25,0.5] r=0.5: ours="d1" theirs="d2"
  - weightedSample weights=[0.25,0.25,0.5] r=1: ours="d2" theirs={}
  - weightedSample matches RandomUtils.weightedRandomSample with Math.random pinned: 16/1313 sampled points differ
```

Restored and re-verified:

```
# tests 14
# pass 14
# fail 0
node scripts/parity-s04/mim-contract-diff.mjs → 7/7 ok, DIFF_EXIT=0
```

`falsification_performed: true`.

## 5. VERIFIED / INFERRED / UNKNOWN

VERIFIED (observed)

- `weightedSample` reproduces the pinned `RandomUtils.weightedRandomSample` at 1313 pinned sampled
  points and at the nine boundary vectors used by the committed test
  (`scripts/parity-s04/mim-contract-diff.mjs`, `s04MimContracts.test.js`).
- PLAY/LISTEN/DISPLAY/SLIM/SEQUENCE/PARALLEL objects equal the pinned requester's objects, in-memory
  (`Reflect.ownKeys`) and on the wire (id-masked), for the Slimmer call signatures
  (`generateSlim` :52, `generateListen` :192, `generateDisplay` :212, `generateSlimSequence` :79).
- `generateJCPAction` places the behavior directly at `config.jcp` — checked against the captured
  reference action for `boundary:launch` (SLIM at the top) and `skill:report-known` (SEQUENCE at the
  top).
- Command IDs are 32 lowercase hex characters and are not reused across 64 draws (requester
  `generateTransactionID` Node branch; `packages/skills/src/jcpId.js`).
- Prompt selection precedence and `meta` fields (`prompt_id`, `prompt_sub_category`, `mim_id`,
  `mim_type`) and the `auto_rule_override: null` vs omitted distinction are asserted against the
  captured `boundary:launch` node and the existing S-04 test.
- GUI thresholds and cancellation: `DISPLAY` only at `noMatch >= no_matches_for_gui` or
  `noInput >= no_inputs_for_gui`, shape equal to the captured reference `DISPLAY` node including
  `onCancel: [{ HIDE_DISPLAY, HIDE_MIM_VIEW }]`; the whole corpus matches on the wire
  (`match`, 43 cases, 0 differences, exit 0).
- MIM ESML is not escaped on the MIM path, matching `Slimmer.ts:159-166` and the captured esml
  strings that carry raw `<break size='0.7'/>` / `<phoneme …>`.
- The uninitialized-state error contract throws
  `Skill data MIM state tracking has not been initialized; cannot track state.`
- Every shipped MIM that reads skill prompt data qualifies it with `skill.` (60 `.mim` files match
  `skill\.`; `skill.dice.a` in `RA_JBO_RollOneDie.mim:29`, `RA_JBO_RollTwoDice.mim:20-39`), so the
  extra prompt-data root spread in Phoenix is inert for the shipped corpus (see divergence candidate 3).
- Dice/Coin constructors reproduce the source (`floor(rng()*sides)+1`, heads iff `round(rng())`).

INFERRED

- `answer-skill/server.js:186-200` (ESML escaping order `& < > "` then strip `[<>{}]`) is from the
  restored tree, not revision `5c0a739`; Phoenix's `escapeForEsml` matches that file and the existing
  `answer.test.js` vector, but the file is not pinned cloud source.
- `data.local.promptData` for chitchat carries `{ dice, coin, entities, intent }` in Phoenix while
  `ProcessQueryNode.ts:146-156` sets only `{ dice, coin }`; the extra members are required by
  Phoenix's PromptData build and are not excluded by any captured case.
- MIM `timeout` / `num_tries_for_gui` never appear in any cloud code path consulted (no hits in
  `baseskill`, `chitchat-skill`, `report-skill` except the GUI threshold fields), so "timing" has no
  wire representation on this path — the requester's v2 `Listen` takes no timeout arguments and
  `Slimmer.generateListen` passes only the rule name.

UNKNOWN

- Whether the real robot reads JCP `speakOptions`/`intents`/`options`/`overlay` keys when present as
  `undefined` (they are dropped on the wire; hardware behaviour is root-owned).
- `[1]` divergence risk in `buildJcpAction`/`buildJcpFromSlim` (single-turn answer-skill path) key
  sets: the restored `answer-skill/server.js` builds plain literals without `speakOptions`, so that
  path was deliberately left matching the restored file rather than the requester. Root should decide
  which authority wins for the answer-skill service.
- Full S-04 acceptance is bounded: no hardware run exists (no robot access from this worker), and
  S-03/S-05/report-view scope stays outside this change.

## 6. Divergence candidates for the ledger

1. `packages/skills/src/jcp.js` (answer-skill / single-turn path) builds PLAY/SLIM/LISTEN literals
   without the requester's `speakOptions`/`options`/`intents` keys. Faithful to the *restored*
   `answer-skill/server.js`, not to the requester. Not changed here.
2. `packages/skills/src/gqaAnswerSkill.js:205-262` builds DISPLAY/PLAY/SLIM from a different source
   with `onCancel` as an object (not an array) and a PLAY without `autoRuleConfig`. That file's own
   source-vector tests pin it; it is not the requester path. Not changed here.
3. `Slimmer.loadAndPrep` in Phoenix passes `{ ...skillPromptData, skill: skillPromptData }` into
   `buildPromptData`, so skill prompt data is visible both at the prompt-data root and under `skill`.
   The pinned `PromptData` constructor exposes skill data only as `this.skill`
   (`PromptData.ts:78-96`). The root spread can only *widen* which conditions/templates resolve, so a
   reference condition that would throw (and be filtered out) can succeed in Phoenix. Content scan of
   the shipped corpus (`rg -l 'skill\.' packages/skills/resources/mims --glob '*.mim'` → 60 files,
   e.g. `RA_JBO_RollOneDie.mim:29 "condition": "skill.dice.a === 1"`,
   `RA_JBO_RollTwoDice.mim:20 "<anim … roll-dice-${skill.dice.a}-${skill.dice.b}"/>"`) shows every
   skill-data reference is qualified with `skill.`; no shipped MIM reads a bare root name, so the
   spread is inert for the current corpus. It stays a divergence candidate because a future MIM could
   rely on it. Flagged for root.
4. Condition/template error logging is now at `error` level with the source wording; the source's
   logger child (`Slimmer`) is not reproduced, only the message text.

## 7. Full `npm test` result (final, one run)

```
$ npm test
> npm run test:unit && npm run parity:check && npm run parity:gate

# tests 1871
# pass 1863
# fail 0
# cancelled 0
# skipped 8
# todo 0

Tracker structure, dependencies, evidence links and generated checklist are valid.

Strict production smoke gate (43 cases; full corpus remains separately tracked).
Evidence: .parity/runs/ci-production-0278c4cb-0504-4e99-a10a-8182df22cc12
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}

NPM_TEST_EXIT=0
```

Gate `run.json` for that run (`candidate: phoenix`, run inside
`node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94` with only
`packages/` and the harness mounted):

```json
{"referenceRevision": "5c0a7390539663ba749d360de348a428c088505c",
 "result": "match", "cases": 43, "differences": 0, "invariants": 0,
 "coverageGaps": 0, "selection": {"name": "smoke", "corpus": null, "offset": 0, "limit": 0},
 "phoenixSourceTreeSha256": "43891efa8beb97f6e3cafab00063c1a4fc31ef675eaeff028488a5662cd79287"}
```

Baseline count before this change was 1856 unit tests; the 15 added focused tests bring the suite
to 1871 with the same 0 failures. Two earlier attempts of the same command on this shared host
failed on `packages/account/test/loopCreationTransport.test.js` (real-socket deadline assertions:
one `ETIMEDOUT` on `RobotReadClient.getRobot`, one truncated redirect `POST` list) and one on
`packages/data/test/calendar-relay.test.js` (`EADDRINUSE :::7810`, a leaked listener from the
failed run). Both files pass in isolation (`23/23`) and neither touches `packages/skills`; the
retry above is green. No test was modified to accommodate a change.
