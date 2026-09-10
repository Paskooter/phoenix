# C-02 — Complete the wire schemas and message builders

**Verified 2026-09-10.** Reference `jiboV2/pegasus@5c0a739` (`packages/interfaces/src`),
Phoenix at the commit carrying this file.

---

## Criterion 1 — field/enum/nullability/requiredness matrix, including ListenResult precedence

The matrix is encoded as executable schemas in `packages/contracts/src/messages.js`
rather than as prose, and exercised by `packages/contracts/test/wire-messages.test.js`.
Fixtures are lifted verbatim from the pinned emitters and consumers, with **13 source
citations** naming the file and line each shape comes from.

`ListenResult` precedence matches `hub/response.ts:89-100` line for line:

1. `nlu` present **and** (`intent` or non-empty `entities`) → `match`
2. no `asr` or empty `asr.text` → `noInput`
3. otherwise → `noMatch`

Phoenix's `listenResultState` (`envelope.js:139-147`) reproduces that order, including
the null-safe `entities` default. Root falsification, **3/3 caught**:

| injected defect | result |
|---|---|
| check `noInput` before `match` | caught |
| treat only `intent` as a match, ignoring `entities` | caught |
| return `noMatch` instead of `noInput` on empty ASR | caught |

## Criterion 2 — accept every valid reference message, reproduce invalid-input behavior

The suite uses explicit `ok()` / `bad()` helpers: **58 acceptance assertions and 17
rejection assertions**. The stated rule is that a captured valid reference message must
be accepted and the reference's behavior on invalid input reproduced, never "improved".

The candidate's own falsification of the highest-risk assertion is retained: `IHRule`
`value` accepts `number`/`boolean`/`null`/`array` and rejects `string`, which contradicts
the TypeScript type but matches the runtime validator at `SkillConfigValidator.ts:153-163`.
The schema follows the **runtime**, since that is what actually rejected traffic.

A real defect was found and fixed during this work rather than papered over: the schema
typed `skillSessionSchema.trace[].transition` as a non-null `string`, but reference
`GraphManager.ts:84-91` pushes `{nodeID, transition: null}` on `enterNode` and returns
before the transition resolves. Launch responses legitimately carry a null transition.
`packages/skills/test/graph.test.js` was failing for this reason and was initially
mistaken for a flake; it was a genuine defect. Relaxed to `['string','null']`.

## Criterion 3 — proactive, redirects/actions, JCP/display, MIMs, manifests, analytics

Every named surface is covered. Mention counts in the wire suite: proactive 30,
redirect 25, action 36, jcp 23, display 13, manifest 18, analytics 12.

**MIMs needed investigation, and my first reading was wrong.** MIM appeared only once,
incidentally, inside an analytics test, which looked like a coverage gap against a
criterion that names MIMs explicitly. It is not:

- `mimID` lives on `DialogTurn` in `jibo/dialog.ts`.
- **No hub or skill wire message imports it.** `skill/response.ts` imports `jibo/data`,
  not `jibo/dialog` — an earlier `grep -l` matched that import and misled me.
- The chitchat skill reads it from skill memo (`ProcessQueryNode.ts:36`,
  `let mimID = memo.mim`), and swaps it mid-turn via `resolveSemiSpecificMim`.

So MIM is **skill-internal memo state, not a distinct wire schema**. The correct reading
of criterion 3 for MIMs is that `memo` must stay open and carry MIM state through
untouched, which Phoenix does (`memo: {}` in both the redirect and response schemas).

Added `MIM state rides in skill memo and is never rejected` to pin this so it is not
re-litigated: a chitchat redirect carrying `memo.mim`, the post-`resolveSemiSpecificMim`
value, and unknown MIM-adjacent keys. Falsified by closing `memo` to
`additionalProperties: false` — **3 failures**, restored to green.

---

## Divergences

Three rows recorded in `DIVERGENCES.md`, all **open and not fixed here**:

- **C02a** — `HubErrorCode` does not match `interfaces/src/hub/HubErrorCode.ts`. Missing
  from Phoenix: `SKILL_NOT_FOUND`, `TIMEOUT_TRANSACTION`, `PARSER`, `GENERAL`.
  Phoenix-only: `TOO_MANY_REDIRECTS`, `NOT_IMPLEMENTED`, `NOT_FOUND`, `INTERNAL`, `AUTH`.
  These codes go on the wire to the robot on `ERROR` responses, and the gateway already
  consumes the Phoenix values, so closing this needs a coordinated gateway+contracts
  change rather than an edit to the enum. **This is a known, deliberate hole in C-02's
  parity, accepted because fixing it unilaterally would break the gateway.**
- **C02b** — `ResponseType` omits `ASR` and `COMMAND`.
- **C02c** — manifest-rule schemas do not set `additionalProperties: false` though
  `SkillConfigValidator.checkUnexpectedProperties` rejects unknown keys. Phoenix is
  deliberately more permissive, honoring criterion 3's "without rejecting valid optional
  fields" over a literal reproduction.

## Honest limits

- The full `jibo-command-protocol` v2 behavior-tree schema is not in the pinned tree, so
  `jcp` stays an open object; nothing valid is rejected, but nothing invalid is caught.
- Whether the reference ever emits `LISTEN_LAUNCH` without `nlu`/`asr` was not exercised
  against a reference emitter; the schema is deliberately permissive there.
- The reference skill runtime's exact terminal-node emission (`action: null`) is inferred
  from Phoenix consumer behavior, not re-derived from source.
