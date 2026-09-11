# N-07 (w14) — Match fallback arbitration and external-agent behavior

Worktree `.parity/worktrees/w14-n07`, branch `w14/n07`, base `6c94aac` (main, A-05 merged).
Every claim is **VERIFIED** (observed in a command output, a pinned source file, or a runtime
request in this evidence set), **INFERRED**, or **UNKNOWN**.

The prior candidate (evidence `2026-09-11/n07-fallback/review.md`, branch `w11/n07`) landed the
15-tool fallback catalog, the HIGH/LOW/SKIP arbitration, the provider-driven external seam and a
green suite, but held `recommend_verified=false` for three open sub-items plus N-07-D2. This pass
targets exactly those four.

## 0. The three open sub-items, before → after

| Open sub-item (w11) | This pass |
|---|---|
| Compiled-FST profile unprovisioned, so the "for each supported profile" clause was UNKNOWN | **CLOSED at runtime** — provisioned approved-binary home used; the full matrix replayed under `compiled-fst-approved` is byte-identical to `ast` (18/18 rows, zero differences). Conditional committed test + unconditional profile-load-abort test. |
| Archived intent/entity catalog recorded only as a hashed denominator | **CLOSED** — `fixtures/dialogflow-archived-agent.json` re-derives all 99 intents + 89 entities + 42 annotated entities (34 custom + 8 system) from the pinned export, and the tests push **every** archived intent name and entity through the preserved external envelope. |
| No archived Dialogflow responses | **NARROWED + partially closed** — the pinned export *does* carry archived response data (`responses[].parameters`, `affectedContexts`) that w11 missed; the fixture records it and derives, per intent, the response a live call would have produced (`intentName` + `parameters` map) for all 99 intents, then exercises it. A live `apiai` round-trip remains impossible (service dead) — UNKNOWN, stated below. |
| **N-07-D2** union of 5c0a739 vs 715e0dd0 on the external attachment | **RATIFIED + implementation made explicit** — pinned `ATTACH` (5c0a739); `OMIT` (715e0dd0) selectable per request. Justification in §4. |

## 1. Specification used

Re-derived from the N-07 row of `docs/parity/tasks.json` (read-only) and from pinned source fetched
this session through the Jibo archive MCP (`https://pvindex.org/mcp`). Full citations and quoted
lines: `w14-mcp-citations.md`. Repository identity (**VERIFIED**):
`GET /gitea/api/v1/repos/jiboV2/pegasus` → `default_branch: "phoenix"`.

| Pinned artifact | Revision | Establishes |
|---|---|---|
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `5c0a739…` | external attachment (`:67-72`), HIGH/LOW/SKIP, EMPTY_NLU |
| `packages/parser/src/dialogflow/DialogflowClient.ts` | `5c0a739…` | `DECOY_INTENT` (`:13`), `getOtherResults` (`:59-78`), `AgentResult` (`:100-104`) |
| `packages/parser/src/llm/LLMClient.ts` | `715e0dd0…` | fallback catalog, `DEFAULT_TIMEOUT_MS = 8000` (`:18`), `tool_choice: 'auto'` (`:118`), `intent === 'unknown'` (`:181`), `rules: request.rules \|\| []` (`:199`) |
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `715e0dd0…` | restored hybrid selection; **no external block at all** (`:82` is the return) |
| `packages/parser/src/ParserService.ts` | `715e0dd0…` | still constructs `DialogflowClient` (`:54`) and exposes `getDialogflowNLUResult` (`:121-123`) |
| `packages/parser/dialogflow/main_agent/**` | `5c0a739…` | the archived 99-intent / 89-entity agent export |

Revision resolution (**VERIFIED**):
`GET …/commits?path=packages/parser/src/llm/LLMClient.ts` returns exactly one commit,
`715e0dd0…` ("Add LLM fallback NLU client (LM Studio + Gemma) replacing dead Dialogflow").
`GET …/commits?path=packages/parser/src/dialogflow/DialogflowClient.ts` returns only live-era
2017-2018 commits — the external client was never touched by the 2026 restoration.

Documentation (**VERIFIED**, `jibo_read /confluence/display/SDK/How+to+use+Dialogflow+for+NLU+Rules`):

> "In Pegasus, NLU is handled by the Parser Service, which uses a hybrid of two NLU strategies: a
> rule based Robust Parser and a statistical based Dialogflow agent."
> "the user utterance \"do you like penguins\" becomes the intent *doesJiboLikeThing*, the entity
> category *GeneralLikes*, and the entity value *Penguin*."

Gateway budget (**VERIFIED**): `packages/contracts/src/constants.js:86` — `parser: 10_000`.

## 2. Runtime demonstration (**VERIFIED**)

`packages/nlu/tools/replayFallbackHttp.mjs` extended with the revision matrix, the archived-catalog
coverage and the active-profile label. Run for both supported profiles:

```
node packages/nlu/tools/replayFallbackHttp.mjs --out …/w14-replay-ast.json
  profile          : ast
  archived agent   : aba7d8e9440ca8e0688b6d5c7ec72caa0ccf0d52c3ec0b70bd37d3af22c78ac6
  cases            : 18      matches : 18      mismatches : none      EXIT=0

PHOENIX_NLU_RUNTIME=compiled-fst PHOENIX_NLU_COMPILED_HOME=<provisioned home> \
  node packages/nlu/tools/replayFallbackHttp.mjs --out …/w14-replay-compiled.json
  profile          : compiled-fst-approved          (ruleCount 98, loadedRuleCount 98)
  cases            : 18      matches : 18      mismatches : none      EXIT=0
```

Diff of the two row sets: **zero differences** — the arbitration, external boundary, revision
cases and archived-catalog cases are identical under both profiles. The compiled run really
served `timerValue` for "five minutes" through the archived binary profile and really logged
`handler threw … Cannot read property 'external' of null` for the external boundary.

N-01 regression (**VERIFIED**): `node packages/nlu/tools/replayMultiruleHttp.mjs` →
`cases 42, status matches 42, decoded-data matches 42, differences none`.

## 3. Focused tests (**VERIFIED**)

New / changed test files, all green:

* `packages/nlu/test/dialogflowArchivedCatalog.test.js` (3) — catalog re-derivation, cross-check
  against the independently hashed `fixtures/dialogflow-agent-catalog.json` (name sets *and* every
  per-file sha256 agree), all 99 intents through the provider envelope in one call, 42 annotated
  entities (34 custom + 8 system), decoyIntent rejected by arbitration while 98 survive.
* `packages/nlu/test/externalAgents.test.js` (6 → 9) — the D2 pin, the OMIT reading, and
  `parseRequest` revision selection.
* `packages/nlu/test/n07CompiledProfile.test.js` (2, one conditional) — profile-load abort on a
  malformed graph; the full matrix under the provisioned compiled profile.

New tooling: `packages/nlu/tools/deriveDialogflowArchivedAgent.mjs` (`--write` / `--check`
re-derives the fixture from the pinned export and fails on drift).

Falsification of the fixture's two-build agreement is real: the archived fixture is regenerated
from the reference tree and compared byte-for-byte to the committed copy, and its per-file hashes
are compared to the pre-existing catalog fixture.

### The compiled profile is provisioned, not shipped

`PHOENIX_NLU_RUNTIME=compiled-fst` requires one of four acquisition contracts
(`compiledFstRuntime.js:1-13`); the repo ships none of the binary graphs. This pass used a
provisioned approved-binary home whose receipt matches the in-repo approval anchor
(`resources/compiled-fst-approval.json inventorySha256 = 7dddc985…` == receipt
`approvedInventorySha256`) — **VERIFIED**. `n07CompiledProfile.test.js` discovers
`PHOENIX_NLU_COMPILED_HOME` or `runtime/nlu-compiled/receipt.json` and **skips with a precise
reason** when neither exists, so the default suite does not silently pretend to have run it.
The unconditional profile-load-abort test needs no binaries.

## 4. N-07-D2 ratification (**VERIFIED** decision, INFERRED equivalence)

`externalAgents.js` now exports `EXTERNAL_ATTACHMENT_REVISION = { ATTACH, OMIT }`,
`DEFAULT_EXTERNAL_ATTACHMENT_REVISION = ATTACH`, and `resolveExternalAttachmentRevision`;
`attachExternalResult(request, result, provider, revision)` returns the result untouched for OMIT
and preserves the current 5c0a739 behaviour for ATTACH; `parseRequest` threads
`options.externalAttachmentRevision`.

**Pin: ATTACH (5c0a739).**

1. The external-agent request/response shape is a live-era client contract
   (`ParseRequestHandler.ts@5c0a739:67-72`, `DialogflowClient.ts@5c0a739:39-57,100-104`) and the
   documentation describes the Dialogflow agent as one of the two first-class NLU strategies.
2. 715e0dd0's omission is an **incomplete restoration**, not a deliberate redaction: its own
   `ParserService.ts@715e0dd0:54` still constructs the `DialogflowClient` and `:121-123` still
   exposes `getDialogflowNLUResult` — but the rewritten handler never calls it. Nothing in the
   restoration commit says the external contract was retired.
3. Behaviourally, OMIT silently drops `result.external` for a client that sent `external`
   (HTTP 200, no `external` key) where ATTACH preserves the map (or reproduces the archived Node 8
   boundary when the client is unavailable). Keeping ATTACH preserves the last live handler's
   observable contract while adopting 715e0dd0's fallback (N-07-D3).
4. OMIT remains selectable, so root can flip the pin without a code change if the omission is ever
   ratified instead. Both readings are covered by named tests and both appear in the runtime replay.

## 5. Falsification (**VERIFIED**, performed)

One full code line broken in `packages/nlu/src/externalAgents.js:50`:

```js
export const DEFAULT_EXTERNAL_ATTACHMENT_REVISION = EXTERNAL_ATTACHMENT_REVISION.ATTACH;
→
export const DEFAULT_EXTERNAL_ATTACHMENT_REVISION = EXTERNAL_ATTACHMENT_REVISION.OMIT;
```

`grep -n "^export const DEFAULT_EXTERNAL_ATTACHMENT_REVISION"` proved the CODE line changed (not the
comment above it). `node --test packages/nlu/test/externalAgents.test.js`:

```
not ok 1 - the disabled Dialogflow provider reproduces the original external boundary
not ok 7 - the external-agent attachment revision is pinned to 5c0a739 and selectable
    error: expected: 'attach'  actual: 'omit'
not ok 8 - OMIT reproduces the 715e0dd0 handler, whose getNLUResult has no external block
not ok 9 - parseRequest selects the attachment revision per request
# pass 3   # fail 6   # skipped 0
```

Restored the byte-identical line (sha256 `f5a18084…` before and after); the same file is green again
(`# pass 9 / # fail 0`). The broken line IS the D2 pin, so the test is load-bearing for the change.
Raw transcripts: `w14-falsification.txt`.

## 6. Full `npm test` (**VERIFIED**)

`w14-npm-test.txt`:

```
# tests 1844
# pass 1836
# fail 0
# cancelled 0
# skipped 8
```

`parity:check`: `Checklist: 51/79 verified (64.6%)` … `Tracker structure, dependencies, evidence
links and generated checklist are valid.`

`parity:gate` (`w14-gate.json`):

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

`NPM_TEST_EXIT=0`. Delta vs the 1836-test baseline: +8 tests (3 catalog + 3 externalAgents +
2 profile), skips 7 → 8 (the conditional compiled-profile skip).

**Pre-existing flake, not a regression:** the first full run on this worktree failed on
`packages/account/test/oobeRestartSIGKILL.test.js` ("SIGKILL mid-write leaves a complete snapshot").
It is `packages/account`, has no relationship to these `packages/nlu` changes, and reproduces on a
**clean tree with this worktree's changes stashed** (2 of 4 isolated runs failed: `pass 2 / fail 1`).
The test kills the child after a fixed `await sleep(25)` (`:47`) and then asserts no `.tmp` file
survives (`:66-69`), so the kill can land inside a flush window. Evidence: `w14-preexisting-flake.txt`.

## 7. Evidence labels

**VERIFIED** — the 15-tool catalog, 8000 ms default, DISABLED/NOT_READY/READY, `tool_choice:'auto'`,
entities from raw arguments, `rules: request.rules || []`, `unknown`→null; the external envelope and
per-agent error record; the disabled-provider boundary; 99 intents / 89 entities / 42 annotated
entities re-derived and exercised through the provider; the 18/18 replay under **both** `ast` and
`compiled-fst-approved` with zero row differences; the compiled profile's 98/98 named rules loaded;
profile construction aborting on a malformed graph; the D2 pin + OMIT path; the falsification; the
full `npm test` exit 0 and the 43-case gate.

**INFERRED** — the synchronous provider seam is equivalent to the source's already-settled
`dialogflowPromise` (`ParseRequestHandler.ts@5c0a739:70`); `derivedResponse`/`parameters` from the
archived export correspond to what a live `apiai` call would have returned for that utterance; the
semantic correspondence of a restored LLM tool name to an archived Dialogflow intent.

**UNKNOWN** — a live Dialogflow/API.ai round-trip and a live LM Studio/Gemma round-trip (both
services dead / unavailable; only wire-shape contracts are exercised against local mocks);
behaviour of the restored fallback and the external attachment on a real robot; whether root
ratifies ATTACH (this pass pins it and makes OMIT selectable, but the pin is a documented judgement,
not an observable fact).

## 8. Precise narrowing statements (what would be needed)

1. **Live external responses.** A real recorded `apiai` response for each of the 99 intents would
   close "no archived Dialogflow responses" completely. It cannot be produced — the service is dead
   and the archived export contains only the intent/parameter/response *configuration*, no
   transcript. What is closed: the archived configuration is fully re-derived, all 99 archived
   intent names are driven through the preserved envelope, and the pre-existing
   `dialogflow-agent-catalog.json` (name + per-file hash) is cross-checked.
2. **Per-rule request-time failure.** `chooseBest` (`requestParser.js:277-285`) catches a single
   failed compiled rule so the rest arbitrate, mirroring `RobustParserClient.getRuleResponse`. Under
   all three compiled acquisition contracts **every** named graph is materialised before the runtime
   is handed out (`preloadRuleExecutors`, `compiledFstRuntime.js:610-634`) and a load failure aborts
   profile construction — proven at runtime by the malformed-graph test. A request-time single-rule
   failure is therefore **unreachable** at the pinned profile and cannot be triggered by a
   deterministic corrupt-but-loadable graph; exercising it would need fault injection into the
   executor (a test-only seam), which this pass did not add.
3. **Per-profile provisioning.** The compiled run is real but depends on an out-of-band home
   (`scripts/install-nlu-compiled-graphs.mjs` / `runtime/nlu-compiled`). On a machine without it the
   committed compiled test skips with the named reason; a fully self-contained compiled run would
   require shipping the ~45 MB binary graphs in git, which the profile design explicitly forbids.

## 9. Divergence candidates (do **not** edit `DIVERGENCES.md` from this worktree)

* **N-07-D1** — the restored 15-name LLM catalog is not derived from the archived 99-intent
  Dialogflow agent (only `yes`/`no` collide). Still open; the new fixture now records the full
  archived name/entity surface, so the divergence is measurable rather than hashed.
* **N-07-D2** — **now explicit and selectable** (`attach` default) instead of an implicit union.
  Root still has to ratify `attach` as the pin, or flip to `omit`.
* **N-07-D3** — `packages/parser/src/llm/**` does not exist at 5c0a739; the union couples a
  dead-era external contract with a post-death fallback. Unchanged.
* **N-07-D4 (new)** — 8 of the 42 entities the archived training data annotates are Dialogflow
  system entities (`@sys.age`, `@sys.date`, `@sys.given-name`, `@sys.ignore`, `@sys.last-name`,
  `@sys.number`, and the bare `@given-name` / `@last-name` aliases) with no file under
  `entities/`. Nothing in phoenix resolves system entities, so an archived response that fills one
  would carry an unconsumed entity name. Recorded, not fixed.
* **N-07-D5 (new)** — the pre-existing A-05 `oobeRestartSIGKILL` test is load/scheduling-flaky
  (see §6). It is not N-07's defect but it can turn a green full run red; flagged for A-05's owner.
