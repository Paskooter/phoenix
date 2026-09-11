# H-06 — Proactive context/history selection and payloads (w11 certification pass)

Review date: 2026-09-11 · Worktree `.parity/worktrees/w11-h06` (branch `w11/h06`, base `b541630`) ·
Task H-06 (P1, pegasus, implementation `partial`, dependsOn H-05, I-02).
Pinned source: Pegasus `5c0a7390539663ba749d360de348a428c088505c`, read from the archive MCP
(`gitea_read_file` against `jiboV2/pegasus`) and from the local pinned checkout
`.parity/reference/5c0a739…` (byte-identical: `diff` clean apart from a trailing newline).

Every claim is labelled **VERIFIED** (observed at runtime), **INFERRED** (reasoned from pinned
source), or **UNKNOWN**. The H-05 harness (real gateway + real settings service + real
`/v1/proactive` socket) was **extended, not rebuilt**; I-02's real-history validation is reused
as the DB oracle.

---

## 1. What the acceptance asks for, re-derived

`docs/parity/tasks.json` H-06:

> **finding**: Context/IH implementations and random selection exist; the complete filter
> pipeline and history side effects need differential verification.
> **acceptance**: (a) Replay NEW_ARRIVAL and SURPRISE with focused person, multiple/no
> candidates, every context/IH operator and date boundary. (b) Verify memo, speaker/referent,
> skipSurprises, no-action/final frames and seeded selection through actual history/settings
> services.

## 2. Method

`packages/gateway/test/proactiveSelection.test.js` (24 tests) drives two layers:

| layer | what is real |
|---|---|
| rule primitives | the ported `contextRules.js` / `ihRules.js`, values read off the source tables |
| IH operators | a **real** `createHistoryService` over HTTP + the real `HistoryClient` |
| socket path | a **real** gateway `/v1/proactive` WebSocket, real `account` settings service, real history service, real skill HTTP endpoint |

A gotcha worth recording: `@phoenix/*` in this workspace resolves through
`node_modules -> /home/shell/work/phoenix/node_modules`, i.e. to the **MAIN checkout**, not the
worktree. A first draft importing `@phoenix/gateway` silently executed the pre-H-06 code and
"passed" the wrong things. The test now imports `../src/index.js` and `../../history|account/…`
by relative path.

## 3. What differed (all closed)

| # | gap | pinned contract |
|---|---|---|
| G1 | `CONTAINS_ALL`/`CONTAINS_ANY`/`NOT_CONTAIN` never rejected non-collection values | `ContextTools.ts:59-98` throws unless both sides are object/string |
| G2 | a **string** rule value fell through to the object branch (`hasOwnProperty`) instead of iterating characters | `ContextTools.ts:62,76,90` `isStringOrArray`; lodash `some('abc', …)` walks chars |
| G3 | `includes(dataValue, el)` used `String#includes` (substring) instead of lodash element equality | `ContextTools.ts:196-198` |
| G4 | `CONTAINED_IN` added a substring branch and never threw for a non-string/array rule value | `ContextTools.ts:109-113` |
| G5 | `PART_OF_DAY` was a hand-rolled bucket table (17:00 → EVENING/EARLY) | `jibo-cai-utils` `PartOfDayTimes` (13 boundaries, 04:45/06:45/22:15 minute edges) |
| G6 | `IHQueryDefinition.personID` was ignored entirely | `IHRulesChecker.ts:140-174` `buildPersonIDRule` |
| G7 | `getTimeByOffset('SinceWaking')` returned `undefined` instead of throwing on a null `wakeUpTime` | `IHTools.ts:89-108`; `ProactiveTransactionHandler.ts:116` `wakeUpTime: null` |
| G8 | time units were `seconds/minutes/hours/days` instead of `msec/sec/min/minute(s)/hour(s)/day(s)` | `TimeUtils.ts:25-44`, `interfaces/src/time.ts` |
| G9 | `evaluateIHRule` special-cased `'ERROR'` → false and omitted the type-mismatch short-circuit | `IHTools.ts:42-44` |
| G10 | a missing named query was swallowed into `ERROR` | `IHRulesChecker.ts:54-55` calls `getQueryDefinition` **outside** the try |
| G11 | a malformed context rule was caught per-PR and dropped | `ProactiveTransactionHandler.ts:212-214` has no try/catch; the transaction fails |
| G12 | the launch record stored *everyone present* as `personIDs` | `TransactionHelper.ts:9-14` — speaker only, else `'UNKNOWN'` |
| G13 | the skill-result frame omitted `timings.skill` | `TransactionHandler.ts:99-111` `timings: {total, skill}` |
| G14 | the history record was written **after** the result frame | `ProactiveTransactionHandler.ts:298-302` records inside `getSkillResponse` |

## 4. Runtime results

* `node --test packages/gateway/test/proactiveSelection.test.js` → **24 tests, 24 pass, 0 fail**.
* Socket scenarios observed on the wire: seeded selection (Math.random 0 / 0.5 / 0.999999 →
  `sel-a` / `sel-b` / `sel-c`), no-action frame (`{final:true, data:{}}`), SURPRISE
  `skipSurprises:true` vs NEW_ARRIVAL `false`, cloud match `final:false` followed by the skill
  frame `final:true` with numeric `timings.{total,skill}`, the trigger `looperID` overwriting the
  context speaker in the launched payload, `memo` round-tripping to the skill, and a malformed
  context rule producing a single `ERROR` frame. **VERIFIED**
* The launch record read back from the real history service carried
  `personIDs: ['person-1']` with two people present. **VERIFIED**
* The real `report_skill` manifest ran the whole pipeline (CONTEXT → IH → Settings) on a live
  gateway: preference on → matched; preference off → no-action; `NEW_ARRIVAL` rejected by its
  `TRIGGER_SOURCE EXACT SURPRISE` rule; a NIGHT `iso` rejected by `PART_OF_DAY CONTAINED_IN
  [MORNING …]`. **VERIFIED**

## 5. Falsification (required, concrete)

**Round 1** — file `packages/gateway/src/proactive/contextRules.js`, the boundary comparison
inside `getPartOfDay`, exactly as it exists in this worktree:

```
    if (boundary.hour < hours || (boundary.hour === hours && boundary.minute <= minutes)) break;
```

broken to `… && boundary.minute < minutes) break;` (minute edges become exclusive). Failing test
(3 failed, the named date-boundary one quoted):

```
not ok 7 - part-of-day: the 13 source boundaries resolve to the source pods
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      + 'NIGHT/MID'
      - 'NIGHT/LATE'
  (proactiveSelection.test.js:168 — podStr(wall('02:00')))
# tests 24 / # pass 21 / # fail 3
```

**Round 2** — file `packages/gateway/src/proactive/proactiveTransaction.js`, the context filter
line (`_getEligible`), exactly as it exists in this worktree:

```
      prs = prs.filter((pr) => checkContextRules(pr, context, reqData));
```

broken to `prs = prs.filter((pr) => { try { return checkContextRules(pr, context, reqData); } catch { return false; } });`
(the pre-H-06 swallow). Failing test (exactly one):

```
not ok 24 - runtime: a malformed context rule fails the whole transaction with an ERROR frame
    error: |-
      Expected values to be strictly deep-equal:
      + actual - expected
        [ + 'PROACTIVE' - 'ERROR' ]
# tests 24 / # pass 23 / # fail 1
```

Both restored; re-run → **# tests 24 / # pass 24 / # fail 0**.

## 6. UNKNOWN / INFERRED — stated, not hidden

* **INFERRED (getTimezonedDate).** `ContextTools.getTimezonedDate` builds
  `new Date(DateTime.utc + timezone.offsetUTC)` and reads it with **local** accessors, so
  `PART_OF_DAY`/`DAY_OF_WEEK` depend on the hub process TZ. Reproduced literally; the test process
  is UTC, where it equals the robot's wall clock. **UNKNOWN** how the production hub's TZ was set.
* **INFERRED (skill-config validation covers the runtime validators).** `validateIHQuery` at
  config load makes the same call inside `buildHistoryServiceQuery` unobservable through a loaded
  config; it is still performed for fidelity.
* **Divergence candidate (config-order vs parallel collection).** The source collects skill
  configs with `Promise.all` (`ProactiveTransactionHandler.ts:202-239`), so `results` order is
  completion order; the port iterates sequentially (deterministic config order). Unobservable in
  a single outcome because the pick is uniform, and the fake-skill hosts are not a real timing
  oracle. Not changed.
* **Divergence candidate (no-settings / missing-key branches).** Inherited from H-05's note: those
  branches are read from the pinned control flow, not from a captured reference proactive stream.
* **UNKNOWN.** No differential capture of a live Jibo hub proactive transaction exists in the
  archive, so every comparison here is port-vs-pinned-source, not port-vs-replayed-original.

## 7. Files changed

| file | change |
|---|---|
| `packages/gateway/src/proactive/contextRules.js` | exact `evaluateMatchRule` (throw contract, string/array/object iteration, lodash `isEqual`/`includes`), `getPartOfDay` + `getTimezonedDate` from the source tables |
| `packages/gateway/src/proactive/ihRules.js` | `getQueryDefinition` outside the try, `buildPersonIDRule`, `buildHistoryQuery` with `validateIHQuery`, `getTimeByOffset` throw contract + real TimePeriod units, `evaluateIHRule` type short-circuit |
| `packages/gateway/src/proactive/proactiveTransaction.js` | context-rule failure propagates, `wakeUpTime`/personID transaction data, speaker-only history `personIDs`, record-before-emit, `timings.skill` |
| `packages/gateway/src/skillConfigValidation.js` | `validateIHQuery` exported so the runtime path calls the same validator |
| `packages/gateway/test/proactiveSelection.test.js` | **new** — 24 focused + socket tests |

No `docs/parity/tasks.json` or `DIVERGENCES.md` edits.
