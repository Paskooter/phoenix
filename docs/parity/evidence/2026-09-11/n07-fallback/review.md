# N-07 — Match fallback arbitration and external-agent behavior

Evidence date: 2026-09-11 · worktree `.parity/worktrees/w11-n07` (branch `w11/n07`)
Base revision: `b54163002d5a95e8e1677a2ddc0adcdff97ee1c5` (main)

Every claim is labelled **VERIFIED** (observed in a command output, a pinned source file, or a
runtime request in this evidence set), **INFERRED**, or **UNKNOWN**.

## 1. Specification actually used

Re-derived from the N-07 row of `docs/parity/tasks.json` (read-only) and from pinned Pegasus
source fetched **this session** through the Jibo archive MCP
(`https://pvindex.org/mcp`; tools `gitea_read_file`, `gitea_browse`, `jibo_search`, `jibo_read`).
Fetched copies are committed verbatim under `source/`.

| Pinned artifact | Revision | What it establishes |
|---|---|---|
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `5c0a7390539663ba749d360de348a428c088505c` | external-agent attachment, HIGH/LOW/SKIP, EMPTY_NLU, LoopMemberDetector |
| `packages/parser/src/dialogflow/DialogflowClient.ts` | `5c0a739…` | external result structure, DECOY_INTENT, per-agent error shape |
| `packages/parser/src/ParserService.ts` | `5c0a739…` | client enabled flags, `getDialogflowNLUResult` |
| `packages/parser/resources/default.json` | `5c0a739…` | `dialogflow.enabled`, `robustParser.enabled` |
| `packages/parser/dialogflow/main_agent/**` | `5c0a739…` | the archived Dialogflow intent (99) / entity (89) catalog |
| `packages/parser/src/llm/LLMClient.ts` | `715e0dd0719ecca5164959d713862a1402430623` | the restored fallback: catalog, config, state machine, timeout, decode |
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `715e0dd0…` | restored hybrid selection (`resolveHybridNLU`) |
| `packages/parser/src/ParserService.ts` | `715e0dd0…` | `getLLMNLUResult`, `llm.enabled` init flag |

Revision resolution (**VERIFIED**): `GET https://pvindex.org/gitea/api/v1/repos/jiboV2/pegasus/commits?path=packages/parser/src/llm/LLMClient.ts&sha=phoenix`
returns exactly one commit, `715e0dd0719ecca5164959d713862a1402430623`
("Add LLM fallback NLU client (LM Studio + Gemma) replacing dead Dialogflow"). The
`LLMClient.ts` / restored `ParseRequestHandler.ts` / restored `ParserService.ts` read from the
default branch are byte-identical to that commit (`diff` → IDENTICAL, **VERIFIED**).

Quoted contract lines (verbatim, pinned):

* `LLMClient.ts@715e0dd0:18` — `const DEFAULT_TIMEOUT_MS = 8000;`
* `LLMClient.ts@715e0dd0:10-16` — `LLMClientConfig { enabled; url; model; timeoutMs?; temperature? }`
* `LLMClient.ts@715e0dd0:59-72` — `init()`: `!enabled → DISABLED`; `!url || !model → NOT_READY`; else `READY`
* `LLMClient.ts@715e0dd0:118-119` — `tool_choice: 'auto'`, `temperature: … != null ? … : 0`
* `LLMClient.ts@715e0dd0:181-184` — `if (intent === 'unknown') { … return null; }`
* `LLMClient.ts@715e0dd0:186-195` — `entities = typeof args === 'string' ? JSON.parse(args) : args;`
* `LLMClient.ts@715e0dd0:196-200` — `{ intent, entities, rules: request.rules || [] }`
* `ParseRequestHandler.ts@715e0dd0:67-70` — `if (this.isParserResultValid(parserResult, log) && parserResult.priority === 'HIGH') { … return parserResult.nlu; }`
* `ParseRequestHandler.ts@715e0dd0:93-96` — both valid → `return fallbackResult;`
* `ParseRequestHandler.ts@715e0dd0:121-132` — `isFallbackResultValid`: `!intent → false`, `intent === DECOY_INTENT → false`
* `DialogflowClient.ts@5c0a739:13` — `export const DECOY_INTENT = 'decoyIntent';`
* `DialogflowClient.ts@5c0a739:39-57` — `handleNLU`: `if (this.state !== ClientState.READY) return null;` … `result.external = otherResults`
* `DialogflowClient.ts@5c0a739:68-75` — per-agent error record `{ rules, intent: '', entities: {}, error: error.message }`
* `DialogflowClient.ts@5c0a739:100-104` — success record `{ rules: agent.rules, intent: intentName, entities: parameters }`
* `ParseRequestHandler.ts@5c0a739:69-72` — `if (result && data.external) { const dialogflowResult = await dialogflowPromise; result.external = dialogflowResult.external; }`

Gateway budget (**VERIFIED**, local): `packages/contracts/src/constants.js:86` — `parser: 10_000`.

## 2. Already correct vs missing

Kept unchanged (already matched the pinned source, **VERIFIED** by the existing suite):

* the 5c0a739 external boundary order — empty text returns before the external attachment
  (`ParseRequestHandler.ts:45-49`), SKIP is discarded, `LoopMemberDetector` runs after the attach;
* `selectBestNative` arbitration (N-01) — untouched; the 42-case multi-rule replay still 42/42.

Gaps closed in this candidate:

| N-07 finding | Before | After (source line) |
|---|---|---|
| fallback has eight generic tools | 8 answer-skill intents | 15-tool source catalog (`LLMClient.ts:36-52`) |
| ignores enabled flags | env-URL presence only | `enabled/url/model → DISABLED/NOT_READY/READY` (`LLMClient.ts:59-72`) |
| 12-second timeout vs 10-second budget | `12000` | `8000` default, asserted `< Timeouts.parser` (`LLMClient.ts:18`) |
| (also wrong in the old scaffold) | `tool_choice:'required'` | `'auto'` (`:118`) |
| | `JSON.parse(arguments).entities` | arguments are the entity object (`:186-195`) |
| | `rules:['launch']` hard-coded | `request.rules \|\| []` (`:196-200`) |
| ignores external agents | hard-coded throw | provider-driven, default disabled reproduces the boundary |

New modules: `packages/nlu/src/externalAgents.js` (Dialogflow contract + replaceable provider),
`packages/nlu/src/fallbackArbitration.js` (`isParserResultValid`, `isFallbackResultValid`,
`selectValidResult`, `resolveHybridNLU`), rewritten `packages/nlu/src/llmFallback.js`.
Wired: `requestParser.js` (`parseRequest(request, { externalProvider })`), `index.js`
(`resolveHybridNLU` + `/state`).

## 3. Runtime demonstration (**VERIFIED**)

`node packages/nlu/tools/replayFallbackHttp.mjs --out docs/parity/evidence/2026-09-11/n07-fallback/replay.json`

```
fixture          : 6aee5d25b524ce6e92cb8afe38e6423b024a8ec1cfacf463be1ec5365cbca8bd
provider requests: 3
cases            : 14
matches          : 14
mismatches       : none
EXIT=0
```

The 14 cases are real requests: 9 arbitration cases through the live LLM client against a local
OpenAI-compatible `/chat/completions` mock provider, 3 HTTP cases against the started `nlu`
service, and 2 in-process external-agent cases. The service really logged and returned the
boundary (`{"msg":"handler threw","error":"Cannot read property 'external' of null"}`, HTTP 500)
and the normal case returned `timerValue` (HTTP 200). N-01 regression check:
`node packages/nlu/tools/replayMultiruleHttp.mjs` → `cases 42, decoded-data matches 42, differences none`, exit 0.

## 4. Focused tests (**VERIFIED**)

`packages/nlu/test/llmFallback.test.js` (7), `fallbackArbitration.test.js` (6),
`externalAgents.test.js` (6) — 18 tests, all green. They cover the HIGH/LOW/SKIP matrix,
absent/invalid/decoy/unknown fallback, per-agent success and failure, cancelled timeout,
unavailable provider, non-200, and the archived 99/89 catalog.

## 5. Falsification (**VERIFIED**, performed)

Broke exactly one full code line in `packages/nlu/src/llmFallback.js:32`:

```js
export const LLM_DEFAULT_TIMEOUT_MS = 8000;
```
→
```js
export const LLM_DEFAULT_TIMEOUT_MS = 12000;
```

`node --test packages/nlu/test/llmFallback.test.js`:

```
not ok 1 - fallback catalog is source-exact and inside the gateway parser budget
  expected: 8000
  actual:   12000
  operator: 'strictEqual'
# pass 6
# fail 1
```

Restored the line; the same file is green again (`7 pass / 0 fail`). The broken line is exactly the
N-07 finding's "12-second timeout" defect, so the test is load-bearing for the fix.

## 6. Full `npm test` (**VERIFIED**)

See `npm-test.txt` in this directory.

```
# tests 1754
# suites 7
# pass 1747
# fail 0
# cancelled 0
# skipped 7
```

`parity:check`: `Checklist: 49/79 verified (62.0%)` … `Tracker structure, dependencies, evidence links and generated checklist are valid.`

`parity:gate` (strict production smoke, 43 cases):

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

`NPM_TEST_EXIT=0`.

## 7. Evidence labels

**VERIFIED** — the 15-tool catalog, 8000 ms default, DISABLED/NOT_READY/READY state machine,
`tool_choice:'auto'`, entities decoded from raw arguments, `rules: request.rules || []`,
`unknown`→null; the external envelope `{rules,intent,entities}` and per-agent error record;
the disabled-provider boundary message; 99 intents / 89 entities archived catalog; N-01 42/42
unchanged; falsification; full `npm test` exit 0.

**INFERRED** — the synchronous provider seam is equivalent to the source's already-settled
`dialogflowPromise` (`ParseRequestHandler.ts:70`); the semantic correspondence of any restored
LLM tool name to an archived Dialogflow intent.

**UNKNOWN** — a live Dialogflow/API.ai round-trip (service dead); a live LM Studio/Gemma round-trip
(not available in this sandbox, so only the HTTP wire contract is exercised against a local mock);
behaviour of the restored fallback on the real robot.

**Not closed by this candidate** (why `recommend_verified=false`):

1. **Per-profile external/fallback matrix.** The three acceptance criteria end with "for each
   supported profile". The fallback and external matrices were exercised on the default AST
   profile (and the external seam is profile-independent), but the compiled FST profile is not
   provisioned in this worktree (`getCompiledFstRuntime()` throws
   `requires PHOENIX_NLU_COMPILED_HOME, PHOENIX_NLU_COMPILED_FST_DIRECTORIES, …`), so the
   compiled-profile run is UNKNOWN here.
2. **"Cover the archived intent/entity catalog".** The archived 99-intent / 89-entity Dialogflow
   agent is recorded with per-file hashes and asserted as a denominator, but the restored LLM
   catalog is a different 15-name list (only `yes`/`no` collide, N-07-D1) and none of its other
   names are registered anywhere in phoenix. Recording the catalog is not covering its intents.
3. **Per-rule failure.** The compiled `chooseBest` already converts one failed native request to
   null and lets the rest arbitrate (`requestParser.js:277-285`; source
   `RobustParserClient.getRuleResponse`), but no NEW focused test was added for it this pass and it
   cannot be run here without the compiled graphs.
4. **Real external agents.** The Dialogflow service is dead, so the external *success* path is only
   replayed through a replaceable provider constructed in this candidate; there are no archived
   real external-agent responses to compare against.


## 8. Divergence candidates (do **not** edit `DIVERGENCES.md` from this worktree)

* **N-07-D1** — the restored LLM catalog is *not* derived from the archived Dialogflow agent: only
  `yes`/`no` names collide (asserted in `fallbackArbitration.test.js`). A grep of `packages/**` shows
  `doYouLike`, `whoAmI`, `tellAJoke`, `whatTimeIsIt`, `launchSkill`, … are registered nowhere in
  phoenix, so source-exact fallback intents are not routable by the current hub/skill manifests.
* **N-07-D2** — the restored 715e0dd0 `ParseRequestHandler.getNLUResult` **deletes** the
  external-agent attachment that the pinned 5c0a739 handler performs. Phoenix keeps the 5c0a739
  external boundary (provider-driven) rather than the restored omission; this is a deliberate
  union of the two source revisions and should be ratified or split.
* **N-07-D3** — `packages/parser/src/llm/**` does not exist at the pinned 5c0a739 revision; it is a
  `phoenix`-branch restoration. N-07 therefore couples a dead-era external contract (5c0a739) with a
  post-death fallback (715e0dd0).
