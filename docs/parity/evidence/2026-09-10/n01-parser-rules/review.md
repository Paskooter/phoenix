# N-01 — Honor complete parser requests and load every named rule

Evidence date: 2026-09-10 · worktree `.parity/worktrees/w3-n01` (branch `w3/n01`)
Base revision: `39c1cd8c33fce2c4e27288652bcbae1adb49f542` · Node `v22.22.0` (linux)

Every claim below is labelled **VERIFIED** (observed in a command output in this
evidence set), **INFERRED** (reasoned from pinned source, not observed) or
**UNKNOWN**.

---

## 1. Specification actually used

Re-derived from `docs/parity/tasks.json` (N-01 row, read from the repository;
the file was **not** modified) and from the pinned Pegasus source.

Pinned reference revision: `5c0a7390539663ba749d360de348a428c088505c`
(`referenceRevision` in `packages/nlu/resources/rule-inventory.json`, which is
itself hash-pinned by `packages/nlu/src/compiledFstProfile.js`).

| Pinned file | sha256 (this checkout, at the pinned revision) |
|---|---|
| `packages/parser/src/robustparser/RobustParserClient.ts` | `2c4b7c1544d82c4e42863cdacf06226fb31f5ba6745827bf165124e3a22b0906` |
| `packages/parser/src/utils/RulesRegistry.ts` | `7dbe093f3da33a05c6b8842f0f88ea102fbeb9bd210da56e3b2b3b1db8f1d664` |
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `dc577c81cf61ce0ecd19c74ada04f6a0fda2521a8834982aff0c2432730fe70e` |
| `packages/interfaces/src/nlu.ts` | `7d200ec0facb88a9a6a190931d918f980676e28209a54aa62c5348a1c67c2021` |
| `packages/parser/resources/default.json` | (read via `git show` at the same revision) |

`RobustParserClient.ts` and `RulesRegistry.ts` were re-fetched through the Jibo
archive MCP (`gitea_read_file repo=jiboV2/pegasus ref=5c0a739…`) and are
textually identical to the local pin — **VERIFIED**. `launch.fst` at the pin is
42 460 381 bytes, sha256 `2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a`
(**VERIFIED**); the archive browse reports the same size and the Phoenix approved
profile pins the same digest, so the local pinned tree and the archive agree on
the launch artifact.

### Acceptance criteria (from the task row)

1. Accept text/rules/loop/external as one request; select only requested known
   rules and return the winning rule name.
2. Inventory and import every required named rule and dependency with hashes; do
   not silently skip parse/load failures.
3. Cover empty/unknown/multiple rules and local turns that must never activate
   launch rules.

## 2. What a "complete parser request" is

**VERIFIED from source.** The parser's only public route is `POST /`
(`ParseRequestHandler.ts:22`) and the wire body is `nlu.NLURequest`:

```
{ type: 'NLU', msgID: <uuid>, ts: <epoch ms>, data: NLURequestData }
NLURequestData = { text: string; rules: string[]; loop?: { users: LooperBasicInfo[] };
                   external?: { [name: string]: ExternalAgentRequest } }   // nlu.ts:32-44
```

Handler order (`ParseRequestHandler.ts`):

| Step | Line | Behaviour |
|---|---|---|
| malformed guard | 28-30 | `!body.data` or `typeof data.text !== 'string'` → `HttpError(…, 400)` |
| trim | 42 | `data.text = data.text.trim()` |
| empty text | 43-47 | return `EMPTY_NLU = {intent:null, entities:null, rules:[]}` |
| robust parser | 51-55 | failures are caught and become `null` (not an HTTP error) |
| priority HIGH | 80-84 | return the parser result immediately |
| selection | 104-114 | LOW parser result loses to a valid Dialogflow result; otherwise parser wins |
| external | 67-70 | if `result && data.external`: `result.external = dialogflowResult.external` |
| loop | 32 | `LoopMemberDetector.detectLoopMembers(req.body.data, result)` |

Robust parser side (`RobustParserClient.ts:57-106`): `rules` missing or empty →
throw `No rules have been provided` (62-64); `text` lowercased (67); request
rules filtered with `rulesRegistry.has(name)` (70); *no* known rule → throw
`No rules known by Robust Parser: …` (71-73); one `PARSE_FROM_URI {TXT_STRING,
URI:'handle:'+rule}` per surviving rule (77-79, 141-151, 202-211); a single
rule's transport failure is caught and becomes `null` (147-150); winner via
`getBestResult` (260-286): highest `heuristic_score`, ties keep request order,
and when a tie exists the designated losers `^launch$|^globals/` are dropped if
any non-loser tied (19, 281-283); `NLParse.priority` defaults to `LOW` (90) and
`entities` is `NLParse` minus `intent`/`priority` (251-258); the response is
`{ priority, nlu: { entities, intent, rules: [winningRuleName] } }` (95-102).

Both HTTP-level failure paths of the client (`No rules have been provided`,
`No rules known by Robust Parser`) are swallowed by the handler's `catch` and
surface as `EMPTY_NLU` with status 200 — **VERIFIED** by source and by the
observed Phoenix behaviour in §5.

## 3. Every named rule that must load — and the count

A named rule is whatever `RulesRegistry.findDirectoryRules` discovers:
`glob('**/*.fst')` under each `fstDirectories` entry, lowercased, `.fst`
stripped (`RulesRegistry.ts:41-52`). Production configures exactly one directory,
`robust-parser/rules_fst` (`resources/default.json:16-21`), with
`loadFSTs: true`, and `init()` then COMPILEs every discovered rule before the
client reports `RUNNING` (`RobustParserClient.ts:40-50`, `156-164`).

Artifact: `named-rule-inventory.json` (**VERIFIED**).

| Quantity | Pinned tree | Phoenix inventory | Match |
|---|---|---|---|
| named rules (`rules_fst/**/*.fst`) | 98 | `publicRules` = 98 | set equality, name-for-name |
| source rules (`rules_src/**/*.rule`) | 117 | `rules` = 117 | set equality (`<name>.rule`) |
| compiled factory files | 16 (`build/data/en-us/factory_rules`) | 16 (`factoryFiles`) | same file set and hashes |

Phoenix also carries 2 hand-authored source factories (`timer`, `yes_no`) and 6
inventory-declared word lists (`canada_province`, `country`, `first_name`,
`last_name`, `music_genre`, `state`) that stand in for native factory FSTs.

**The 98 named rules are enumerated in `named-rule-inventory.json`** together
with each rule's compiled path, compiled sha256, source list and any
unsupported factory dependency. Three named rules declare an unsupported
dependency: `clock/alarm_set_value` (`time`), `clock/alarm_timer_ampm` (`time`)
and `launch` (`canada_city_province`, `city_state`, `digits`, `time`,
`world_city_country`, `year`). `launch` is exempt from the AST dependency guard
by design (`requestParser.js:170-175`).

## 4. Runtime proof — every named rule actually loads

Runtime probes were run against the real listener; nothing here is inferred
from file counts.

**Environment** (hash-verified install built by `scripts/install-nlu-compiled-graphs.mjs`
from the pinned tree; receipt in `runtime-per-rule-compiled.json`):

```
graphCount 98 · factoryFileCount 16 · payloadBytes 46 438 634
fstSha256 2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a
ruleManifestSha256 7648a6449f62d7664c7f9a602ec50e9195daeb92e30aaefbf0ebd2d50a0a3142
factoryManifestSha256 4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e
```

| Probe | Profile | Result | Artifact |
|---|---|---|---|
| one real `POST /v1/parse` per named rule (98 requests) | compiled-fst (approved-binary) | **VERIFIED** 98/98 HTTP 200, 98/98 `getExecutor` present, 0 load failures, 14 rules matched the probe utterance, 84 returned the empty NLU result | `runtime-per-rule-compiled.json` |
| one `parseRequest` per named rule | default AST | **VERIFIED** 96/98 honoured, 2 raise the documented unsupported-dependency error | `runtime-per-rule-ast.json` |
| full original multi-rule suite, 42 cases | both | **VERIFIED** compiled 42/42 status+data; AST 34/42 | `runtime-multirule-42.json` |
| native launch oracle, 89 attributable results | both | **VERIFIED** 89/89 intent, entities and rule name in both profiles | `runtime-launch-oracle-89.json` |
| raw response bytes for 3 shapes | compiled | **VERIFIED** byte-identical after normalising the generated `msgID`/`ts` | `runtime-response-shape.json` |

Notes that matter:

* The compiled profile reached the full registry at construction:
  `compiledFstRuntimeConfig()` returns `ruleCount: 98 · loadedRuleCount: 98 ·
  allNamedRulesLoaded: true`, and `runtime.getExecutor(name)` succeeds for every
  one of the 98 names — **VERIFIED**.
* The AST profile's two failures are **not** silent: they raise
  `Unsupported NLU factory dependencies for public rule 'clock/alarm_set_value': time`
  and `… 'clock/alarm_timer_ampm': time` (`requestParser.js:335-347`), which the
  HTTP route surfaces as status 500. The compiled profile serves both rules
  (`five minutes` → `alarmValue` / `set`) — **VERIFIED**; this is a real
  cross-profile difference (divergence candidate D2).
* `n08:011:gui-overlap` and `n08:020:timer-thanks` are the two native no-result
  cases; both Phoenix profiles return exactly the native empty shape.

## 5. Request/response shape, field by field

The generated AWS-SDK client strips undeclared response fields, so only fields
a consumer can parse are compared.

| Field | Pinned source | Phoenix | Observable difference |
|---|---|---|---|
| envelope keys | `{type,msgID,ts,data}` (`ParseRequestHandler.ts:33-38`) | `message()` → same 4 keys (`packages/contracts/src/envelope.js:31-33`) | none — **VERIFIED** by the 42-case replay envelope capture |
| `type` | literal `'NLU'` | `ResponseType.NLU` = `'NLU'` | none |
| `msgID` / `ts` | `getUUID()` / `Date.now()` | `randomUUID()` / `Date.now()` | regenerated per response, as in the original |
| `data` keys | `{entities, intent, rules}` | `{entities, intent, rules}` | none; key order also matches the native raw bodies |
| empty result | `{intent:null, entities:null, rules:[]}` | identical, byte-identical raw body | none |
| `rules` | `[winningRuleName]`, the **requested** rule name (95-102, 145) | `[requestedName]` | none observed |
| `entities` | `NLParse` minus `intent`/`priority` (251-258) | same removal (`requestParser.js:197-203`, `compiledFstRuntime.js:756-762`) | none |
| `union_original_fst_name` | present in the native capture and in the native oracle `golden.jsonl` | present in both profiles | none — this is a native field, not a Phoenix invention |
| `loopMemberReferent` / `given-name` / `last-name` | `LoopMemberDetector.ts:29-…` adds them | `requestParser.js:259-310` | none observed (no archived case carries `loop`) |
| `external` | attaches `dialogflowResult.external` (67-70) | throws the disabled-Dialogflow boundary error (`requestParser.js:312-318`) | **yes** — divergence candidate D4 |

Additions: none found that the native capture lacks.
Omissions: none found.
`priority` is deliberately absent from the wire result in both (`ParseRequestHandler`
returns `parserResult.nlu`, never the wrapper) — **VERIFIED**.

## 6. Gaps found and closed

### G1 — "load every named rule" was not actually a load (AC 2)

`RobustParserClient.init()` COMPILEs **every** registered rule before the client
reaches `RUNNING` (`RobustParserClient.ts:46-48`, `156-164`; the accepted
42-case capture records `COMPILE_COMPLETE: 98`). Phoenix's approved-binary and
portable-snapshot profiles verified all 98 graph hashes at startup but
constructed an executor for `launch` only, deferring the rest to the first
request that named them, where a load failure is caught
(`requestParser.js:236-244`) and the rule silently drops out of arbitration
into a 200 no-match. **INFERRED** — this cannot be observed with the pinned
artifacts, whose bytes are hash-verified valid, so a structural failure there
implies a Phoenix interpreter bug rather than bad input.

Fix: `preloadRuleExecutors()` (`packages/nlu/src/compiledFstRuntime.js`) is
called by the approved-binary and portable-snapshot constructors; it loads one
executor per named rule and throws a single aggregated error listing every
failure. The directory profile already preloads (`compileDiscoveredGraphs`,
`loadFSTs: true`) and now reports `loadedRuleCount` too. The runtime reports
`ruleNames`, `loadedRuleCount`; `compiledFstRuntimeConfig()` adds
`loadedRuleCount` and `allNamedRulesLoaded`.

Measured cost (**VERIFIED**): +0 MB RSS and ~9 ms for the approved profile;
+12 MB RSS and ~61 ms for the portable snapshot profile (all 98 executors).

### G2 — an undeclared factory word list could join the matcher (AC 2)

`requestParser.load()` hash-verified the six entries declared as
`factory-words/*` in `rule-inventory.json`, then called `loadFactoryWords()`,
which indexes **every** `*.txt` in the bundled directory — so any extra or
renamed file joined the `$factory:` vocabulary with no hash anchor at all.

Fix: `buildFactoryWords()` builds the index from the verified entry texts only,
and `undeclaredFactoryWordFile()` refuses a bundled `*.txt` the inventory does
not declare (`requestParser.js:105-124`). `ruleInventory()` now reports
`factoryWordCount`.

## 7. Falsification (required)

Highest-risk assertion: *"the approved compiled profile loads all 98 named
rules at construction, and a rule that cannot be loaded aborts startup."*

**Break 1 — behaviour, not reporting.** Corrupted the full line (approved-binary
constructor, `packages/nlu/src/compiledFstRuntime.js:733`):

```js
-  const loadedRuleCount = preloadRuleExecutors(ruleNames, getExecutor);
+  const loadedRuleCount = preloadRuleExecutors(ruleNames.slice(0, 1), getExecutor);
```

Command (with the hash-verified compiled home configured):

```
PHOENIX_NLU_RUNTIME=compiled-fst \
PHOENIX_NLU_COMPILED_FST=/tmp/n01-nlu-compiled/rules_fst/launch.fst \
PHOENIX_NLU_COMPILED_FACTORY_DIR=/tmp/n01-nlu-compiled/factories \
PHOENIX_NLU_COMPILED_RULES_DIR=/tmp/n01-nlu-compiled \
PHOENIX_NLU_COMPILED_FST_SHA256=2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a \
node --test packages/nlu/test/compiledFstRuntime.test.js
```

Result: `not ok 3 - explicit compiled-FST profile connects the real /v1/parse
path` — `loadedRuleCount: 1` instead of `98`, `allNamedRulesLoaded: false`
instead of `true`. Exactly 1 of the 98 named rules was materialised.

**Break 2 — silent skipping.** Corrupted the full line at
`compiledFstRuntime.js:632`:

```js
-  if (failures.length) {
+  if (failures.length > ruleNames.length) {
```

Result: `not ok 2 - one unloadable named rule reports every failure instead of
skipping it` → `error: 'Missing expected exception.'`

Both lines were restored from the original text; the restored file passes:
`node --test packages/nlu/test/namedRuleLoading.test.js` → `# pass 2 # fail 0`,
and the configured run of `compiledFstRuntime.test.js` → `ok 3 - explicit
compiled-FST profile connects the real /v1/parse path` (**VERIFIED**, green).

Anchor note: every corruption was applied to complete code lines, never to a
bare substring, so a comment quoting the code cannot produce a false "caught".

## 8. Full test run and parity gate

One full `npm test` at the committed revision `03c3779` with a clean environment
(`PHOENIX_NLU_*` unset), exit status 0 (**VERIFIED**, log preserved as
`/tmp/n01-npm-test-clean.log`). No source or test file changed after the run.

```
$ env | grep PHOENIX_NLU      # (no output)
$ npm test
[test:unit]  1..1138
             # tests 1200   # suites 7
             # pass 1193     # fail 0
             # cancelled 0   # skipped 7   # todo 0
             # duration_ms ~24.6s
[parity:check] Checklist: 16/79 verified (20.3%)
               Tracker structure, dependencies, evidence links and generated
               checklist are valid.
[parity:gate]  Strict production smoke gate (43 cases) →
               {"result": "match", "cases": 43, "differences": 0,
                "invariants": 0, "coverageGaps": 0}
```

`cancelled 0` confirms no concurrent-run corruption. The 7 skipped tests are the
artifact-gated compiled profiles; they were run separately with the compiled
home configured (19/19 pass, including the new 98-rule load assertions).

Environment note (**VERIFIED**): an earlier full run of the same committed tree
inherited exported `PHOENIX_NLU_*` variables and produced `pass 1195 · fail 1 ·
skipped 4`, failing `packages/nlu/test/punctuationBoundary.test.js:23`
(expected `GeneralDescriptor: 'Depressed'`, got `Emotion: 'Sad'`). The same
failure reproduces identically when the three source files are reverted to the
base revision `39c1cd8c`, so it is pre-existing environment sensitivity in that
test (it asserts AST-profile values while the environment selects the compiled
profile), not a regression from this work. See D5.

## 9. Divergence candidates (reported, not written to DIVERGENCES.md)

* **D1 — AST profile picks the wrong winner for local clock turns.** For
  `cancel the timer` / `stop the timer` with `rules:[launch, globals/global_commands_launch]`
  the original returns the launch union winner (`intent stop`, `entities.domain
  timer`, `skill @be/clock`, `union_original_fst_name handle:clock/launch`) while
  the default AST profile returns `globals/global_commands_launch` with
  `entities {domain: global_commands}`. 8 of the 42 original multi-rule cases
  differ this way; the compiled profile matches all 42. Order-independent, so it
  is a score-scale difference, not the source's tie rule. **VERIFIED**.
* **D2 — AST profile cannot serve two named rules.** `clock/alarm_set_value` and
  `clock/alarm_timer_ampm` raise `Unsupported NLU factory dependencies … 'time'`
  → HTTP 500. The compiled profile serves both from the archived `time` factory.
  **VERIFIED**.
* **D3 — launch-union arbitration identity.** The source tags every rule
  response with the *requested* name (`Rule: ruleName`, `RobustParserClient.ts:145`)
  and the designated-loser filter tests that name (19, 281-283). Phoenix's AST
  branch tags each candidate with the matched *source graph* name and only sets
  `requestedName` when the two differ (`requestParser.js:155-166`, `217-228`),
  while `selectBestNative` tests `.rule` (`arbitration.js:29-30`). A tie between a
  launch-union member and another requested rule would therefore keep `launch`
  where the original drops it. **INFERRED** — no runtime case producing such a
  tie was found, so the difference is unobserved here.
* **D4 — `external` requests.** A truthy `external` on a matched non-empty text
  throws the synthesised Node 8 message `Cannot read property 'external' of
  null` (`requestParser.js:24-28`, `312-318`) where the original attaches the
  Dialogflow external result. Dialogflow is dead-era; **INFERRED** boundary,
  observed as a 500 in tests.
* **D5 — profile-dependent test expectations.** `packages/nlu/test/punctuationBoundary.test.js:23`
  asserts AST-profile values but does not clear `PHOENIX_NLU_RUNTIME`, so a full
  `npm test` with the compiled profile exported fails (`fail 1 · skipped 4`
  instead of `fail 0 · skipped 7`). The gated compiled tests in the same suite
  deliberately delete the variable (`compiledFstRuntime.test.js`) or restore it
  (`requestParser.test.js:14-22`), so this one test is the outlier.
  Reproduces at the base revision — **VERIFIED**, pre-existing.

## 10. Limits and unknowns

* **UNKNOWN** — the archived 42-case suite only sends `text` and `rules`
  (`external`/`loop` absent in all 42 request bodies), so loop and external
  behaviour on original multi-rule traffic is not covered by any archived
  capture; only the in-repo source-derived tests cover them.
* **UNKNOWN** — 10 of the 99 entries in `legacy-oracle/golden.jsonl` are empty
  arrays (`[]`) and carry no `Input`, so 10 native results cannot be attributed
  to an utterance and were excluded from the 89-case replay.
* **UNKNOWN** — the original 42-case capture was produced earlier on a pinned
  Node 8.9.4 host and is reused as-is; this evidence replays the recorded
  requests against Phoenix and compares with the recorded responses. It does not
  re-establish the original capture's provenance.
* **INFERRED** — the eager preload cost is measured on this host only.
* **UNKNOWN** — whether an operator deploys the AST or compiled profile on Moth;
  the AST-specific differences (D1, D2) are only observable there if the AST
  profile is the deployed one.
