# N-06 — LoopMemberDetector and contextual entity resolution

Revision: `65e8aa2` (worktree `.parity/worktrees/w10-n06`, branch `w10/n06`).
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`.
Status: implementation ported; source fixtures replayed; falsification performed.

## Pinned source (read over the Jibo archive MCP, `gitea_read_file`)

| Source | Path @ ref |
| --- | --- |
| Detector | `jiboV2/pegasus:packages/parser/src/utils/LoopMemberDetector.ts` |
| Fixtures | `jiboV2/pegasus:packages/parser/tests/utils/LoopMemberDetector.test.ts` |
| Call site | `jiboV2/pegasus:packages/parser/src/handlers/ParseRequestHandler.ts` |
| Types | `jiboV2/pegasus:packages/interfaces/src/nlu.ts` |

Local copies: `LoopMemberDetector.ts.txt`
(sha256 `462f5f093448d5b12fa24eeeb8d09a9176fe8c8adc2699d9b8ef526e0b6d67f8`),
`LoopMemberDetector.test.ts.txt`
(sha256 `b351c88ceafa5de02594f717d3d53e2e9aa22a6e22cec94d249fb803ed0c1bdf`).

## Real contract (verified by reading the pinned source)

- `detectLoopMembers(request, result): result` — `LoopMemberDetector.ts:30-38`.
  Mutates `result.entities`, setting `loopMemberReferent = loopUser.id`,
  `given-name = loopUser.firstName`, `last-name = loopUser.lastName` only when a
  member is found. The handler (`ParseRequestHandler.ts:33`) ignores the return
  value, so the mutation is the observable contract.
- `findLoopMember(request, result)` — `LoopMemberDetector.ts:47-93`. Guard at
  `:48` requires `request.loop.users`, `result` and `result.intent` all truthy.
  Ordered, first-match-wins:
  1. `:57-63` non-empty `given-name`/`GivenName` **and** non-empty
     `last-name`/`LastName` → `isEqual` firstName+lastName.
  2. `:65-68` non-empty given name only → `isEqual` firstName. A failed lookup
     returns `undefined` and does **not** fall through to a text search.
  3. `:70-79` no given-name value → first member whose `firstName lastName`
     appears in `request.text`, via an **unescaped** `\b<first> <last>\b` `i`
     RegExp.
  4. `:81-90` `given-name`/`GivenName` key present (even empty) → first member
     whose `firstName` appears in the text, via an **unescaped** `\b<first>\b`
     `i` RegExp.
- `isEqual` (`:5-7`) lowercases both sides without a type check; a malformed
  member next to a given-name entity throws.
- `getStringEntityValue` (`:9-16`) accepts only a non-empty string.
- Request/result shapes: `LoopMemberDetector.ts` uses `nlu.NLURequestData`
  (`loop?: { users: LooperBasicInfo[] }`) and `nlu.LooperBasicInfo`
  (`{ id, firstName, lastName }`) from `packages/interfaces/src/nlu.ts:33-55`.

## What was missing vs already correct

Already correct (functionally) in the previous inline `addLoopMember`:
guard shape, alias preference, ordered steps 1-4, `loopMemberReferent` /
`given-name` / `last-name` output.

Missing:
- No module matching the source API; the logic was a private, unexported function
  so the source fixtures could not be run.
- The text patterns were **escaped** (`escapeRegExp`) and **guarded**
  (`named()`), which diverges from `LoopMemberDetector.ts:73,84`. Under the
  source, a member name is a regex pattern and a missing name interpolates the
  literal `undefined`.

## Changes

- `packages/nlu/src/loopMemberDetector.js` (new) — faithful port of
  `LoopMemberDetector.ts:5-94`, exporting `LoopMemberDetector.detectLoopMembers`
  and `LoopMemberDetector.findLoopMember`.
- `packages/nlu/src/requestParser.js` — imports the module, drops the inline
  `addLoopMember`/`equalName`, and calls
  `LoopMemberDetector.detectLoopMembers({...request, text}, ...)` at the same
  point the handler does (after the external-agent boundary; trimmed text).
- `packages/nlu/test/loopMemberDetector.test.js` (new) — 28 tests: the 12 pinned
  source fixtures verbatim, 11 source-code-derived matrix cases (aliases,
  duplicates, ambiguity, missing members, punctuation/regex, guards, two error
  boundaries), and 5 live HTTP cases.
- `packages/nlu/test/requestParser.test.js` — one assertion updated to the
  source-verified behavior (see Divergence below).
- `packages/nlu/tools/replayLoopMemberHttp.mjs` (new) — runtime replay of the 12
  source fixtures through the detector plus real HTTP `loop` requests.

## Runtime evidence

- `node packages/nlu/tools/replayLoopMemberHttp.mjs` → `matches 16/16`,
  `differences: none`, exit 0 (`replay.json`).
- `node packages/nlu/tools/replayMultiruleHttp.mjs` (N-01, unchanged) → 42/42,
  `differences: none`, exit 0.
- `node --test packages/nlu/test/*.test.js` → 196 tests / 191 pass / 0 fail /
  5 skipped.

## Falsification (performed)

Broke one full line in `packages/nlu/src/loopMemberDetector.js:110`, removing
the case-insensitive flag from the step-3 full-name pattern:

```
-  const fullNameRegEx = new RegExp(`\\b${loopUser.firstName} ${loopUser.lastName}\\b`, 'i');
+  const fullNameRegEx = new RegExp(`\\b${loopUser.firstName} ${loopUser.lastName}\\b`);
```

`node --test packages/nlu/test/loopMemberDetector.test.js` then failed 3 named
tests: `source fixture: full-name text match is case-insensitive and writes
canonical names`, `punctuation: member names are interpolated as a regex, not
escaped (LoopMemberDetector.ts:73)`, and `error boundary: a null entities map
with a text match throws on write (LoopMemberDetector.ts:32-35)`. Restoring the
line returned 28/28.

## Divergence resolved (behavior change — flagged)

`packages/nlu/test/requestParser.test.js` previously asserted that a loop member
with no `firstName`/`lastName` (`{ id: 'u-malformed' }`) was **not** resolved for
text `who is undefined undefined`. That guard was a Phoenix addition; the source
builds the literal pattern `\bundefined undefined\b` (`LoopMemberDetector.ts:73`),
which that text contains, so the member **is** resolved and the `undefined`
names are written onto the entities. The assertion now matches the source. This
is the only pre-existing assertion that changed.

## Evidence classes

- VERIFIED (observed): source contract and line numbers (pinned ref above);
  16/16 runtime replay; 12 source fixtures through the port; one falsification.
- INFERRED: the alias / duplicate / ambiguity / punctuation / missing-member
  cases are derived from the source code, not from source fixtures (the source
  test file contains only the 12 fixtures above); their expectations follow the
  code but have no pinned oracle.
- UNKNOWN: "speaker/referent interactions" from the N-06 acceptance wording —
  `LoopMemberDetector` has no speaker concept in the pinned source, and no
  original transcript exercising it was located, so it is not claimed.

## Residual notes

- If `result.intent` is truthy but `result.entities` is null and a text match
  succeeds, the source throws on the entity write (`LoopMemberDetector.ts:32-35`);
  the port preserves this (asserted).
- A member with a missing `firstName` plus a given-name entity throws inside
  `isEqual` (`LoopMemberDetector.ts:5-7`); the port preserves this (asserted).
- The empty-return branches of `parseRequest` return `intent: null`, so running
  the detector there is a provable no-op (`LoopMemberDetector.ts:48`).
