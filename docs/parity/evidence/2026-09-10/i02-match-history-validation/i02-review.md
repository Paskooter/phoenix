# I-02 — Match history validation and query semantics (w8 certification pass)

Review date: 2026-09-10 · Worktree `.parity/worktrees/w8-i02` (branch `w8/i02`, base `2c1f5c0`) ·
Task I-02 (P0, pegasus, implementation `partial`, dependsOn I-01).
Pinned source: Pegasus `5c0a7390539663ba749d360de348a428c088505c`, read from the archive MCP
(`https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a739…/…`) and from the local pinned
checkout `.parity/reference/5c0a739…` (byte-identical).

Every claim is labelled **VERIFIED** (observed at runtime), **INFERRED** (reasoned from pinned
source), or **UNKNOWN**. The I-01 harness (`docs/parity/evidence/2026-09-10/i01-history-routes/`)
was **extended, not rebuilt**: the probe signature, the case-row shape, the reference/runtime/diff
split, the stub model and the restart check are I-01's.

---

## 1. What the acceptance asks for, re-derived

`tasks.json` I-02:

> **finding**: Only partial validation exists; array equality, allowed operator/field combinations
> and conflicting query conditions need parity.
> **acceptance**: (a) Port the original event/query/rule validation matrix, timestamps, identifier
> constraints and failure payloads. (b) Verify sorted array EXACT/NOT, all payload operators,
> nested keys, empty arrays, missing fields, session exclusions and time boundaries against a
> database oracle.

Both halves are addressed below: (a) is the validation port in §3, (b) is the semantics matrix and
the reference HTTP oracle in §4–§5.

## 2. Method — the I-01 oracle, extended to validation

`i02-matrix.mjs` holds **one** 130-case matrix; `i02-ref-oracle.mjs` drives it against the REAL
compiled pinned classes and `i02-runtime-probe.mjs` drives the identical sequence against a REAL
spawned Phoenix process (twice, with a process restart between passes). `i02-diff.mjs` compares
them case-by-case. This removes the I-01 duplication (the case list lived in both drivers) and is
the only structural change to the harness.

The reference oracle runs real code end to end:

| layer | real? | source |
|---|---|---|
| Express app, body parsers, 404/error envelope | yes | `utils.service.BaseService` |
| route table + handler **validation call order** | yes | `SkillLaunchRequestsHandler.ts:20-55` |
| event/query/rule validators (real `joi@13.1.2`) | yes | `validators/{event,query,rule}.ts` |
| `$and` document construction | yes | `SkillLaunchQueryBuilder.ts:18-128` |
| `documentToJSON` / `saveSkillPayload` / `getLatest` / `getCount` | yes | `SkillLaunchCollection.ts` |
| mongoose `Model` | stub | no `mongod` binary in this environment |

Stated limits (unchanged from I-01, and the only places INFERRED/UNKNOWN appear):
record *selection/sorting* and BSON `Date`-vs-number casting need a live Mongo; the stub's
`findOneAndUpdate` returns the *first* matching record while Phoenix picks the *last*.

## 3. The contract, re-derived from pinned source

### 3.1 Failure envelope and status
`BaseService.addHttpErrorHandlers` → `res.status(err.statusCode || 500).json(buildErrorMessage(err))`
with `message = getErrorMessage(err)` = `err.message` (`@jibo/utils-common/lib/Utils.js:29-39`).
Every validation failure is therefore a **500** whose `data.message` is the thrown error's
message. Phoenix's `serviceError()` already produces that envelope, so only the *message* had to be
reproduced. **VERIFIED** (oracle statuses/messages vs live Phoenix: 125/125 identical).

### 3.2 Event validation (`validators/event.ts`)
`Joi.alternatives().try(SkillLaunchValidations, SkillPayloadValidations)`, `abortEarly: true`.
Branch A key order `timestamp, sessionID, robotID, skillID, intent, personIDs`; branch B replaces
`intent/personIDs` with `payload` (required). Both branches always run; if none passes the message
is **every** branch's leaf errors concatenated and joined with `', '`
(`language.alternatives.child === null` → `wrapArrays` slice, `errors.js:105-113`).
Unknown keys are reported *after* schema children and **all** of them are reported (the
`object.allowUnknown` loop does not honour `abortEarly`), joined with `', '` inside a branch and
`'. '` at the top level of a single object schema.

### 3.3 Query validation (`validators/query.ts`)
joi `QueryValidations` first, in schema key order `robotID, skillID, intent, personID,
notSessionID, rules, startTime, endTime`, unknown keys last (`object/index.js:196-215`); identity
regexes from `common/validation/index.ts:7-11`; `startTime` is
`Joi.date().timestamp().raw().max('now')`, `endTime` has no bound. **Only if `rules.length > 0`**
does it then validate every rule (in order) and finally run `checkNoConflictConditions`.
`Joi.date().timestamp()` accepts ms numbers and numeric strings via `Number()` coercion
(`date/index.js:64-96`) and rejects anything outside `±8.64e15`.

### 3.4 Rule validation + defaults (`validators/rule.ts`)
`ALLOWED_METHODS[fieldType:valueType]`; the FIRST entry is the default when `match` is omitted.
Value-type checks (`checkString`/`checkArray`) run before the allowed-method check; `typeof null`
is `'object'`, so a null value on a string field falls through to `Cannot process this rule:` while
a null value on `payload` is *accepted* (`payload:object`). Error texts are reproduced verbatim,
including `JSON.stringify(rule)` and `Array#toString` interpolation of the value.

### 3.5 Evaluation order (the I-01 lesson, applied)
1. `data.timestamp = data.timestamp || Date.now()` (both write routes) **before** validation.
2. `validators.event.validate(data)` **before** the collection (so an invalid write is never saved,
   and `Object.keys(data.payload)` in `SkillLaunchCollection.ts:51` is only reachable once the
   event is valid).
3. `validators.query.validate(query)` in the handler **before** `getLatest`/`getCount`.
4. Inside the builder: `Preformatter.preformatSkillLaunchQuery` (sorts an EXACT `personIDs` rule
   array in place) → `robotID` guard → per-rule conditions → `notSessionID` → `intent` → `skillID`
   → `personID` → `startTime` → `endTime`.
5. `SkillLaunchQueryBuilder.getPayloadCondition` takes `rule.value` raw and immediately calls
   `Object.keys(payload)` — so a **null** payload value passes joi but throws
   `Cannot convert undefined or null to object` (500) before any record is read.

## 4. What differed (all closed)

`i02-diff.json` `newlyClosedInI02` lists **32** cases whose Phoenix status was 200 (no validation at
all, no array equality) and is now the reference's 500/identical body. The substantive gaps:

| # | gap | evidence |
|---|---|---|
| G1 | No event validation at all: malformed launches were **persisted** and returned 200 | A01–A13: before 200 → after 500 |
| G2 | No query validation: `robotID`/identifier regexes, timestamps, unknown keys, `rules` type | C01–C21: before 200 → after 500 |
| G3 | No rule validation: allowed operator/field combinations, non-empty strings/arrays, defaults already matched but rejection did not | C09–C11, C27, D14, D17 |
| G4 | No conflict checks (`intent`/`skillID`/`personID` dual-specified) | C13–C15 |
| G5 | **Field rules compared arrays with `===`**, so `EXACT`/`NOT` on `personIDs` never matched | D12/D13/D15/D60: ref 3/3/4/3 vs phoenix 0/0/7/0 |
| G6 | **Payload comparisons compared arrays with `===`**, so any payload value that was an array could never match (`EXACT`, `CONTAINS_ALL`, `NOT`) | D35/D38/D47 |
| G7 | **No `Preformatter` query sort**: an unsorted EXACT `personIDs` rule value could not match the sorted stored array | D12/D60 |
| G8 | Payload rule with `value: null` used `rule.value \|\| {}` and returned 200 `null` instead of the reference's eager `Object.keys(null)` TypeError | C24: ref 500 / phoenix 200 |
| G9 | GET/POST query validation ran **inside** the store (`Robot ID is required`) instead of in the handler with joi's message | `history.http.test.js` I-01-era assertion corrected |

## 5. Runtime results

* **Reference vs live Phoenix, 130 cases: 125 verifiable cases, 0 status diffs, 0 body diffs.**
  (5 cases are the `X-` known-unverifiable section — see §6.)
* Restart determinism: `pass1`/`pass2` (real SIGKILL + respawn) — same labels, identical statuses,
  identical bodies.
* Reference model-call ledger: `findOneAndUpdate: 7`, `findOne: 6`, `count: 58` for **13** stored
  records — i.e. the 32 rejected cases never reached the model. **VERIFIED** that validation
  precedes the db call on both sides.
* Built-query oracle: `i02-ref-oracle.json` `builtQueries` records the REAL
  `SkillLaunchQueryBuilder.buildQuery` output for the operator matrix (`$eq`/`$ne`/`$in`/`$all`/
  `$not{$in}` + `$and`/`$or` payload shapes), so the in-memory predicate can be read against the
  exact document the reference emits.
* Validator differential oracle: `i02-validator-differential.mjs` compares Phoenix's ported
  validators against the pinned compiled validators (real joi) over **770 generated inputs**
  (every field × value-type × match-method combination plus query/event batteries):
  **770 identical, 0 different**, comparing both the thrown error *name* and the byte-for-byte
  *message*.

## 6. UNKNOWN / INFERRED — stated, not hidden

* **I-02a (UNKNOWN, divergence candidate).** `SkillLaunchCollection.saveSkillPayload` calls
  `findOneAndUpdate({sessionID, robotID, skillID}, …)` with **no sort**. When the triple is
  ambiguous, real Mongo returns the first document in natural (insertion) order; Phoenix's store
  picks the **most recent**. Matrix cases `X01–X04` measure exactly this: with two identical
  triples, the reference/stub updates the older record (returned `timestamp` = 1789084000000) and
  Phoenix the newer (`1789084001000`), and the `marker` payload lands on a different record.
  Resolving oldest-vs-newest requires a `mongod`; **UNKNOWN**. Outside the `X-` section every
  PUT case targets a unique triple precisely so this cannot contaminate the parity claim.
* **I-02b (UNKNOWN, divergence candidate).** A `payload` *key* rule with a **string** value and
  `match: NOT_CONTAIN` is allowed by `ALLOWED_METHODS['payload:string']` but builds
  `{'payload.key': {'$not': {'$in': 'value1'}}}` — a **scalar** `$in` (`SkillLaunchQueryBuilder.ts:89`).
  Whether Mongo errors out (→ 500), or coerces to a one-element list (→ Phoenix's current count 6),
  is unverified. The oracle's interpreter treats a non-array `$in` as never-matching, which makes
  `$not` match everything (count 7) — an artefact of the interpreter, not of reference code.
  Recorded as matrix case `X05`.
* **BSON casting (INFERRED).** `timestamp` is a `Date` in the mongoose schema; the emitted
  `{'timestamp': {'$gte': <number|numeric string>}}` is cast by mongoose for a real connection and
  compared numerically by Phoenix. `GET` leaves the raw string because of `.raw()`, and Phoenix
  relies on `<`/`>` numeric coercion. Not observable without mongod.
* **Write-side `personIDs` sort (INFERRED).** `SkillLaunchCollection.addSkillLaunch` constructs
  `new this.model(data)` *before* `Preformatter.preformatSkillLaunchData(data)` sorts
  `data.personIDs`; the stub shares the array reference (sorted), whereas real mongoose may have
  cast a copy. I-01 already covered this; Phoenix sorts and returns sorted either way.
* **JSON key order** is not compared (the diff canonicalises object keys); JSON object member order
  is not a wire contract.

## 7. Falsification (required, concrete)

* File: `packages/history/src/query.js`
* Line 87, exactly as it exists in this worktree:
  `      && stored.length === wanted.length && stored.every((v, i) => v === wanted[i]);`
* Broken to: `      && stored.length === wanted.length;`
* Failing tests (3), first one quoted:

  ```
  not ok 55 - semantics: EXACT personIDs compares arrays order-independently (Preformatter sorts both sides)
      error: s1, s5, s7
             4 !== 3
  not ok 56 - semantics: NOT / CONTAINS / CONTAINS_ANY / CONTAINS_ALL / NOT_CONTAIN on personIDs
      error: s2, s3b, s3, s6
             3 !== 4
  not ok 58 - semantics: payload operators, empty rule objects and array ordering
  # tests 62 / # pass 59 / # fail 3
  ```
* Restored; re-run: `# tests 62 / # pass 62 / # fail 0`.

## 8. Files changed

| file | change |
|---|---|
| `packages/history/src/validators.js` | **new** — port of `validators/{event,query,rule}.ts` + `common/validation/index.ts` with joi's message templates |
| `packages/history/src/query.js` | Mongo array equality (`$eq`/`$ne`/`$in`/`$all`), payload `Object.keys(rule.value)` semantics, `Preformatter` EXACT `personIDs` rule sort, full `RuleField` |
| `packages/history/src/index.js` | validation in the handler layer in the reference's order |
| `packages/history/test/history.validation.test.js` | **new** — 23 focused tests |
| `packages/history/test/history.http.test.js` | corrected the I-01-era message assertion to the reference's joi message |
| `docs/parity/evidence/2026-09-10/i02-match-history-validation/*` | matrix, oracle, probe, diff, differential + JSON artefacts |

No `docs/parity/tasks.json` or `DIVERGENCES.md` edits.
