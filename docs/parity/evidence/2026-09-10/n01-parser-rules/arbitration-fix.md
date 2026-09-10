# N-01 arbitration fix — the 8/42 multi-rule winner discrepancy and the 2/98 rule boundary

Evidence date: 2026-09-10 · worktree `.parity/worktrees/w5-n01` (branch `w5/n01`)
Base revision: `aecb8644cd3ec0c4423607ddea8fbb2dd2d6433a`

Every claim is labelled **VERIFIED** (observed in a command output in this evidence
set), **INFERRED**, or **UNKNOWN**.

## 1. The specification actually used

Re-derived from `docs/parity/tasks.json` (N-01 row, read-only) and from the pinned
Pegasus / native source fetched through the Jibo archive MCP. The N-01 row's
`finding` scopes the accepted artifact to "the accepted compiled profile loads and
verifies all 98 public graphs and 16 factory files, honors requested rules and
matches 42 original multi-rule HTTP/routing cases", adding "Complete cross-profile
rule/dependency acceptance remains open".

| Pinned artifact | Where | sha256 |
|---|---|---|
| `packages/parser/src/robustparser/RobustParserClient.ts` | `jiboV2/pegasus@5c0a739…` | fetched via MCP |
| `packages/parser/src/utils/RulesRegistry.ts` | `jiboV2/pegasus@5c0a739…` | fetched via MCP |
| `packages/parser/src/handlers/ParseRequestHandler.ts` | `jiboV2/pegasus@5c0a739…` | fetched via MCP |
| 42-case original native HTTP suite | `.parity/reviews/n08-original-multirule-v2-20260906/suite.json` | `2c958166863314ef96e1b4d2f8a6b3eceb8728f1a6939af10c7418d0b6d60ac8` |
| 42-case original native capture | `…/attempt-host-netns-v2-reference.json.gz` | see vendored fixture provenance |
| Rules accepted as an oracle | `.parity/reviews/…/semantic-compare-v1-v2.json`, `docs/parity/evidence/2026-09-06/nlu-compiled-fst/multirule-http-review.json` | `comparison.pass: true`, 42 cases, 0 differences |

Documentary contract (**VERIFIED**, Confluence "NLU Service usage",
`https://pvindex.org/confluence/display/CONV/NLU+Service+usage`, retrieved via
`jibo_read`): the parser's `PARSE_FROM_URI` response returns the `Result` vector
"sorted by heuristic_score", each item carrying `heuristic_score` and the request
`index`. The response has **no** priority field — ranking is by `heuristic_score`
alone. This is the doc root warned about: the source alone was not sufficient.

## 2. The winning-rule contract (**VERIFIED**, pinned source)

`RobustParserClient.handleNLU` (`RobustParserClient.ts:59-99`):

1. `request.rules.filter(ruleName => this.rulesRegistry.has(ruleName))` — only
   requested *known* rules are used; `No rules known by Robust Parser` is thrown,
   never a silent drop.
2. one `getRuleResponse` per requested rule (`Promise.all`).
3. `getBestResult(responses)` (`RobustParserClient.ts:262-288`) walks every
   `Result` in response order and keeps the maximum **`result.heuristic_score`**;
   ties retain response order, then `LOW_PRIORITY_RULES = /^launch$|^globals\//`
   losers are removed **only when a non-loser also tied**.
4. *after* selection: `bestResult.NLParse.priority = bestResult.NLParse.priority
   || 'LOW'` (`:88-91`), and `getNLParseEntities` (`:253-260`) drops `intent` and
   `priority` before the HTTP body.

`RulesRegistry.findRules` (`RulesRegistry.ts:34-52`) globs `**/*.fst` under the
configured directories and registers **every** file as a named rule; `init()`
(`RobustParserClient.ts:40-50`) compiles all of them via
`loadAllFSTs()`/`Parallel.invoke` before `ClientState.RUNNING`, so a request is
never served from a partially loaded registry.

**Consequence:** the grammar `priority` tag is a *post-selection* annotation, so it
must never enter the arbitration score.

## 3. Defect — priority leaked into the multi-entry arbitration score

`packages/nlu/src/requestParser.js` scored each candidate with
`parseScore(..., { includePriority: requestedEntry.name !== 'launch' })`, i.e.
every non-`launch` entry received `priorityRank(priority) * 1e6`. Every rule in the
42-case suite that competes with `launch` (`globals/global_commands_launch`,
`globals/mim_repeat`, `globals/mim_thanks`, `globals/gui_nav`,
`clock/timer_set_value`, `clock/alarm_timer_okay`, `clock/stop_timer`) carries
`{priority='HIGH'}` (`resources/rules-src/…`), while the `launch` union entry does
not. So a matched `globals/*` graph beat a strictly higher-scoring `launch` union
member — contradicting `getBestResult`.

## 4. BEFORE / AFTER (VERIFIED, AST profile)

`node packages/nlu/tools/replayMultiruleHttp.mjs` against the vendored native
capture (in-process `parseRequest`, default AST profile):

| | BEFORE (`main`, `aecb864`) | AFTER (this branch) |
|---|---|---|
| cases | 42 | 42 |
| HTTP status matches | 42 | 42 |
| decoded `data` matches | **34** | **42** |
| differences | n08:000,001,002,003,029,030,031,032 | none |

The 8 regressed ids are exactly `launch-global-pair` 000-003 and
`order-and-tie-controls` 029-032. In every one the reference returns
`rules:["launch"]` with `domain:"timer"`, while Phoenix returned
`rules:["globals/global_commands_launch"]` with `domain:"global_commands"`.
n08:030 (`["globals/global_commands_launch","launch"]`) and n08:032
(`["globals/…","launch","globals/…"]`) prove order alone cannot decide it: the
native `launch` score is strictly higher, so no tie-break is involved.

Per-candidate scores observed via a temporary diagnostic (AST profile):

```
n08:000 cancel the timer  launch <- clock/launch  base=-1  priority=HIGH
                          globals/global_commands_launch base=-7 priority=HIGH
n08:030 pair-reverse      globals/global_commands_launch base=-7 (listed first)
                          launch <- clock/launch  base=-1
```

The fix removes the priority term from the arbitration score
(`includePriority: false`), so `-1 > -7` and `launch` wins regardless of order.
All non-launch candidates lose the same `+2e6` constant, so their mutual order is
unchanged; n08:004/005 (the timer rule does not match, `globals` is the sole
candidate) still return `globals/global_commands_launch` **VERIFIED**.

No over-reach: the `rules:['launch']` path already opted out of priority, and a
before/after dump of the live parser over the 89 attributed native launch-oracle
utterances (`resources/legacy-oracle/golden.jsonl`) is byte-identical and matches
89/89 on intent and entities. This is now pinned by a test.

## 5. The 96/98 rule boundary — precisely characterised, **UNFIXABLE in N-01 scope**

`node packages/nlu/tools/probeNamedRules.mjs` (default AST profile, one request per
named rule, text `five minutes`):

```
named rules   98
honored       96
refused        2
  clock/alarm_set_value: Unsupported NLU factory dependencies for public rule 'clock/alarm_set_value': time
  clock/alarm_timer_ampm: Unsupported NLU factory dependencies for public rule 'clock/alarm_timer_ampm': time
```

Why exactly these two:

* Their only source rules (`clock/alarm_set_value.rule`, `clock/alarm_timer_ampm.rule`)
  declare `$factory:time`; `rule-inventory.json` marks the `time` factory
  `status: "unsupported"` (reference FST
  `build/data/en-us/factory_rules/time.fst`, sha256 `ccc50d3c…`, present and
  hash-matching locally).
* The recovered source `resources/factory-sources/time.grm` **does not parse**:
  `Error: parser: unexpected COLON (:) at 5:23`. It uses the native literal-colon
  form `?(?: $minutes_number{…})` (lines 22 and 39), while `lexer.js` emits `:`
  as a COLON token and `matcher.js:222` compares a `lit` node against a whole
  whitespace-delimited token (`tokens[start] === node.word`). The engine is
  word-token based; the native FST is byte-based, so it can consume the `:` inside
  `5:30`. `timer.grm` fails identically (`unexpected COLON (:) at 2:19`) and is
  only usable because Phoenix ships its own bounded re-implementation
  (`resources/factory/timer.grm`, `status: bounded-compatibility`).

Making these two rules executable therefore requires a character-level matcher (or
a validated source re-implementation of a 392-line factory grammar) and an
independent oracle differential for the `time` factory — the subject of N-02's
grammar/factory track, not a change that can be made safely inside N-01. Executing
a mis-parsed `time` factory would *fabricate* a result, which acceptance criterion 2
("do not silently skip parse/load failures") forbids. So the refusal is kept
deliberately loud, and the boundary is **UNKNOWN** for the AST profile.

The accepted compiled profile is unaffected: prior accepted evidence records
`getExecutorOk: 98`, `http200: 98`, `loadFailures: []` and the root-accepted
42-case review records `COMPILE_COMPLETE: 98` — **INFERRED here** (no compiled home
is installed in this environment, so it was not re-run; `getCompiledFstRuntime()`
returns `null`).

## 6. Falsification (VERIFIED)

1. Arbitration fix. Broke the single full line
   `packages/nlu/src/requestParser.js:252`
   → `      includePriority: name !== 'clock/launch',`
   (a one-line analogue of the original launch-exclusion asymmetry).
   Test **`selects the native winner for all 42 original multi-rule parser requests`**
   failed with the same 8 ids (n08:000,001,002,003,029,030,031,032). Restored the
   line; the test is green.
2. No-silent-skip boundary. Broke the single full line
   `packages/nlu/src/requestParser.js:384`
   → `        return applyExternalCompatibility(request, emptyResult());`
   Test **`imports every named rule and refuses an unsupported dependency loudly`**
   failed with `every rule must answer: 98/98`. Restored the line; green.
