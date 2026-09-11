# S-02 — Global results, speaker overrides and supplemental behaviors

**Verified 2026-09-11.** Pinned original `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
(`packages/baseskill/src/GraphSkill.ts`, `src/graph/nodes/SetLooperIDNode.ts`, `src/graph/nodes/*`,
`packages/interfaces/src/skill/behaviors.ts`, `jibo-command-requester` structural/perception
protocols), executed under the archived `node:8.9.4-slim`
(`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).
Phoenix at the commit carrying this file on branch `w15/s02` (base `30f2b46`).

## Method

Two receipts are produced and diffed cell-by-cell over **39 probe names** (`s02.*`):

| Artifact | What it does |
| --- | --- |
| `source-s02-contract.cjs` | Loads the **pinned original compiled `lib/`** under Node 8.9.4, builds real `Graph`/`Node`/`GraphSkill` objects, drives a concrete `GraphSkill` subclass — launch/update through the real `BaseSkill` express route wrapper — and records response envelopes, sessions, traces, analytics, speaker state and thrown errors. → `source-s02-contract.json` |
| `phoenix-s02-contract.mjs` | Runs the same probe names against the real Phoenix layer (`packages/skills/src/graph/*`, `createGraphSkill`, `skillRoute`). → `phoenix-s02-contract.json` |
| `compare.py` | Structural flatten + diff. Normalizes **only** generated session ids (uuid), generated JCP transaction ids (32 hex) and `msgID`/`ts`. Error strings are compared **byte-for-byte**, including the Node 8 wording of property-access errors. |

```
docker run --rm --network none -v "$PWD:/review" \
  -v /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro \
  node:8.9.4-slim node /review/source-s02-contract.cjs /runtime /review/source-s02-contract.json
node phoenix-s02-contract.mjs phoenix-s02-contract.json
python3 compare.py     # compared probes: 39  accepted: 0  DIFFS (0)  -> exit 0
```

Runtime demonstration of the same surfaces over a **live HTTP entrypoint** is in
`packages/skills/test/s02GlobalSupplemental.test.js`
(`S-02 live entrypoint: entry analytics, supplemental wrapping and global cancel over HTTP`):
a real `createSkillsService(...).listen(0)` host, real `fetch` calls to
`POST /v1/s02-skill/main`, multi-turn sessions and the error envelope.

## Verified (observed on both runtimes, `DIFFS (0)` over 39 probes)

### Acceptance 1a — ListenResult precedence

Reused, not re-derived: C-02 pinned the precedence from `hub/response.ts:89-100`
and falsified it 3/3 (`docs/parity/evidence/2026-09-10/c02-wire-schemas/review.md`).
Phoenix implements it at `packages/contracts/src/envelope.js:139-147`
(`match` when `nlu` has an intent or non-empty entities → `noInput` when ASR is absent/empty →
`noMatch` otherwise). Nothing in S-02 changes that surface.

### Acceptance 1b — global cancel/repeat/thanks reaching skills across updates

**VERIFIED — the framework applies no global-intent policy of its own.** On a `LISTEN_UPDATE`
carrying intent `cancel`, `repeat` or `thanks`, the raw `data.result` reaches the node unchanged
(`s02.global.*OnUpdate`: the node echoes `intent:cancel` / `intent:repeat` / `intent:thanks`) and
the only framework-level effect is the session/terminal bookkeeping. This is exactly
`GraphSkill.handle` (`GraphSkill.ts:68-87`): `LISTEN_LAUNCH|PROACTIVE_LAUNCH` → `GraphManager.start`,
`LISTEN_UPDATE` → `GraphManager.exitNode`, anything else throws — a global intent is dispatched by
whatever node is current, and by nothing else.

**VERIFIED — the one framework node that consumes a global is `SetLooperIDNode`.** Driven the way
the OptIn graph drives it (a node holds the turn; the answering update reaches the looper), all five
branches match cell-for-cell (`SetLooperIDNode.ts:24-64`):

| intent / payload | transition | speaker | supplemental |
| --- | --- | --- | --- |
| `cancel` | `Cancel` | untouched (`'original'`) | none |
| `loopmember` + referent | `Success` | → referent (`'bob'`) | `SET_PRESENT_PERSON{looperId,source:'USER_OVERRIDE',confidence:100}` in a `SEQUENCE` |
| `loopmember` no referent | `NotInLoop` (falls through) | → `null` | none |
| `loopmember` referent `''` | `NotInLoop` | → `null` | none |
| `notInLoop` / unknown / no `nlu` | `NotInLoop` | → `null` | none |

**VERIFIED — a global after the floor is closed is answered silently.**
`s02.global.thanksAfterTerminal`: `{type:'SKILL_ACTION', final:true, fireAndForget:true, action:null}`
with the terminal trace element set (`GraphSkill.ts:116-134`).

**VERIFIED — a global update never re-emits `Skill Entry`.** `analytics` is rebuilt per request
(`GraphSkill.ts:54-66`) and `s02.global.globalIntentDoesNotEmitEntryEvent` returns `{}`.

The hub half of this acceptance ("does a global intent get routed to the in-flight skill as an
update, or answered by the hub?") is `ListenTransactionHandler.ts:351-361` on the source side and
`packages/gateway/src/listenTransaction.js:414` on the Phoenix side; the update-decision itself is
already pinned by H-04 (`packages/gateway/test/listen.skillHandoff.test.js:168` asserts
`{skillID:'source', launch:false, onRobot:false}` for the non-launch path) and is not re-tested here.

### Acceptance 2a — speaker overrides

* `GraphSkill.ts:161-172` → `overrideSpeaker` assigns onto the **same runtime object the request
  carried** (`data.runtime.perception.speaker = id`, including when `id` is `null`/`''`; only the
  log line differs). Observed: `'looper-9'`, and `null` on the clearing path.
* Missing `runtime`/`perception` is a guarded no-op on both runtimes
  (`s02.speaker.overrideWithoutRuntimeContextIsNoop`: still `SKILL_ACTION`, no throw).
* The only wire-visible speaker side effect is the `SET_PRESENT_PERSON` supplemental behavior,
  which matches `requester.perception.SetPresentPerson.generateProtocol(looperId, source, confidence)`
  field-for-field.

### Acceptance 2b — sequence/parallel supplemental behaviors

`GraphSkill.ts:227-239` reproduced exactly (`s02.supplemental.*`):

* sequence list first, main behavior last: `SEQUENCE.children = [...sequence, main]`;
* parallel list first, then **either** the main behavior **or the just-built sequence**:
  `PARALLEL{children:[...parallel, SEQUENCE{children:[...sequence, main]}], succeedOnFirst:false}`;
* an action that is not a `JCPAction` is returned untouched (`GraphSkill.ts:107` guards on
  `isJCP`), the queued behaviors stay buffered;
* a JCP action with no queued behaviors is returned by identity;
* generated protocol ids are 32 lowercase hex
  (`jibo-command-requester/lib/…:1792-1817` → `UUID.generateTransactionID()` = md5 hex on Node;
  Phoenix `packages/skills/src/jcpId.js` = `randomBytes(16).toString('hex')` — same shape, opaque value);
* `behaviors` buffering is equivalent: source creates the pair only when `data.behaviors` is falsy,
  otherwise backfills the missing list; Phoenix does the same (`graphSkill.js:61-66`).

### Acceptance 2c — analytics names/fields

* `'Skill Entry'` (`skill/analytics.ts:5-7` `EVENTS.SKILL_ENTRY`) with
  `{initial_intent:'n/a', domain:'', was_hey_jibo_launch, user_initiated, last_skill:'n/a'}` —
  both flags `true` for `LISTEN_LAUNCH`, both `false` for `PROACTIVE_LAUNCH`.
* `track()` appends `{event, properties}` under `analytics[skillName]` in call order, with
  `properties` defaulting to `{}`.
* Analytics are per-request, never persisted into `session.data`.

### Acceptance 2d — failure handling

All matched verbatim (`s02.failure.*`, `s02.wire.errorEnvelopeThroughRoute`):
`Cannot read property 'general' of undefined|null`, `Skill request without general.accountID arrived`,
`… robotID arrived`, `Incoming skill name doesn't match. This: 's02-skill', incoming: 'other-skill'`,
`Unknown request type 'NOT_A_REQUEST'`, `Skill session is required`; a missing per-turn `result`
only warns and the node still runs; the express route returns the C-01 error envelope at HTTP 200.

## Archive (Jibo MCP) evidence

The archive MCP was reachable over JSON-RPC at `https://pvindex.org/mcp` and was used to
re-establish the contract independently of the local pinned tree.

| Source (read via MCP) | What it pins |
| --- | --- |
| `gitea_read_file jiboV2/pegasus packages/baseskill/src/GraphSkill.ts @ 5c0a7390539663ba749d360de348a428c088505c` | `track`/`overrideSpeaker`/`addParallelBehavior`/`addSequenceBehavior` + `injectSupplementalBehaviors`, and the launch/update/redirect/terminal dispatch. Returned **byte-identical** to `.parity/reference/5c0a739…` after the tool's one-line header (which shifts the returned text's line numbers by +1). |
| `gitea_read_file … packages/baseskill/src/graph/nodes/SetLooperIDNode.ts @ 5c0a739…` | line 37 is `const looper = data.result.nlu.entities.loopMemberReferent;` — the access whose Node 8 failure wording is the S-02a fix; lines 32-34 default only a missing `nlu`; lines 43-51 `overrideSpeaker` + `SetPresentPerson.generateProtocol(…, "USER_OVERRIDE", 100)` + `addSequenceBehavior`; lines 55-58 the `NotInLoop` fallthrough clearing the speaker. |
| `gitea_read_file … packages/interfaces/src/skill/behaviors.ts @ 5c0a739…` | `SupportedBehaviors = SLIM \| Sequence \| Parallel \| SetPresentPerson \| ImpactEmotion` and `SupplementalBehaviors {parallel, sequence}`. |
| confluence `/confluence/display/SDK/SDK+-+About+MIMS` | *"MIMs also provide global VUI controls that give the user an opportunity to cancel an interaction or ask Jibo to repeat a question"* — the product-level statement behind acceptance 1b (a global cancel/repeat arrives *inside* an ongoing skill interaction). |
| confluence `/confluence/display/SER/Pegasus+Hub+Messages` | Case B/C/E: the hub emits `LISTEN match` with `onRobot`, and a Cloud Skill's response is `SKILL_ACTION \| SKILL_DONE \| ERROR` with `final`; Case E is the same listen flow a Cloud Skill issues for itself — the wire shape the update path in acceptance 1b rides on. |

`gitea_list_repos(query="pegasus")` → `jiboV2/pegasus`, default branch `phoenix`.

## Divergence found and fixed

### S-02a — `SetLooperIDNode` leaked the modern V8 property-access message onto the wire

`SetLooperIDNode.ts:31-36` defaults only a missing `nlu`:

```ts
if (!data.result.nlu) { data.result.nlu = { entities: { loopMemberReferent: null } }; }
const looper = data.result.nlu.entities.loopMemberReferent;
```

An `nlu` that is present without `entities` therefore throws inside the original's own property
read, and that message is what the cloud error envelope carried. Under Node 8 the message was
`Cannot read property 'loopMemberReferent' of undefined`; Phoenix threw the modern spelling
`Cannot read properties of undefined (reading 'loopMemberReferent')` and shipped that to the robot.

Observed **before** the fix (probe `s02.looper.nluWithoutEntitiesThrows`, Phoenix at base `30f2b46`):
`{"error":{"message":"Cannot read properties of undefined (reading 'loopMemberReferent')","ctor":"TypeError"}}`
against the source's `{"error":{"message":"Cannot read property 'loopMemberReferent' of undefined",…}}`.

Fixed in `packages/skills/src/graph/nodes.js` with a localized precondition read
(`sourceLoopMemberReferent`), matching the existing convention for exactly this class of error
already used at `packages/skills/src/graph/graphSkill.js:25-30`,
`packages/gateway/src/skillConfigValidation.js:28` and `packages/account/src/settingsFace.js:205-210`.
Both the `undefined` and `null` receivers are localized. After the fix `compare.py` reports
`DIFFS (0)` **with error strings compared byte-for-byte**.

### Not fixed (recorded, not silently accepted)

* **Log-only difference.** `GraphSkill.ts:163-170` warns `Intended speaker override ID missing`
  when `overrideSpeaker` is called with a falsy id, and warns
  `Runtime Perception Context missing or incomplete, unable to update speaker.` when
  `runtime.perception` is absent. Phoenix performs the same assignment but emits no log. No request,
  response or session byte differs; the source logger is `@jibo/utils` structured logging, not a
  wire surface. Left as-is — INFERRED non-observable, listed here rather than hidden.

## Run notes (full `npm test`, branch `w15/s02`)

Three full `npm test` runs were needed; the first two each failed **one unrelated,
environmental test** and the third was clean. This box runs several other agent
worktrees concurrently, which is what the failures point at:

| run | result |
| --- | --- |
| 1 | `tests 1867 / pass 1858 / fail 1` — `packages/account/test/loopCreationTransport.test.js:138` (`keeps one header deadline across redirects`): only one POST observed; the test sets `ETCO_server_http_timeout=35` ms and asserts a second POST is dispatched inside that wall-clock window, so full-suite load shifts it. Passes 3/3 in isolation. |
| 2 | `tests 1867 / pass 1858 / fail 1` — a *different* test: `packages/data/test/credential-durable.test.js:699`, `EADDRINUSE :::7804` from a concurrent worktree's fixed port. |
| 3 | `tests 1867 / pass 1859 / fail 0 / cancelled 0 / skipped 8`, `parity:check` tracker valid (55/79), `parity:gate` `{"result":"match","cases":43,"differences":0,"invariants":0,"coverageGaps":0}`, **exit 0** — recorded in `npm-test-summary.txt`. |

Baseline before this work was 1856 tests; this branch adds 11 (`s02GlobalSupplemental.test.js`),
all passing.

## Falsification (performed, concrete)

Broke ONE full code line — the fix itself — in `packages/skills/src/graph/nodes.js:78`:

```js
const looper = sourceLoopMemberReferent(data.result.nlu);     // broken to:
const looper = data.result.nlu.entities.loopMemberReferent;
```

```text
not ok 9 - S-02 failure: SetLooperIDNode reproduces the source Node 8 property-access error for incomplete entities
  failureType: 'testCodeFailure'
  error: |-
    The validation function is expected to return "true". Received false

    Caught error:

    TypeError: Cannot read properties of undefined (reading 'loopMemberReferent')
not ok 11 - S-02 live entrypoint: entry analytics, supplemental wrapping and global cancel over HTTP
# tests 11
# pass 9
# fail 2
```

Restored the line → `# tests 11 / # pass 11 / # fail 0`, exit 0. The pre-fix failure of test 9 also
reproduces the exact divergence recorded above (S-02a), so the finding and the fix are falsifiable
in one step. See `falsification.json`.

## Open / not verified

* **UNKNOWN — the second `overrideSpeaker` log line** (`Runtime Perception Context missing or
  incomplete, unable to update speaker.`) is not verified against the deployed logging pipeline;
  the probe asserts only the behavioural no-op.
* **UNKNOWN — robot-side consumer behaviour for `SET_PRESENT_PERSON`.** The behavior shape is
  verified against the pinned requester builder and the original framework test
  (`baseskill/tests/OptInSkill.test.ts:196-218` asserts the same `SEQUENCE[SET_PRESENT_PERSON, SLIM]`
  with `looperId`), but no robot is driven here (root owns hardware).
* **INFERRED — `GraphSkill.ts:137-154` `track()` is a pure copy.** No behavior beyond
  `analytics[skillName].push({event, properties})` is observable; the log-free version in Phoenix
  is behaviourally identical.
* **NOT RE-DERIVED — ListenResult precedence** is cited from C-02 rather than re-falsified here.
* The 218 strict-smoke differences recorded under S-01 are unaffected: these 39 probes are a new,
  independent comparison of the S-02 surfaces, not a replacement for the strict smoke gate.
