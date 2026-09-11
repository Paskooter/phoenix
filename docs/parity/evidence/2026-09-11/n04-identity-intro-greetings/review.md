# N-04 — Verify identity, introduction and greeting follow-up rules

Evidence date: 2026-09-11 · worktree `.parity/worktrees/w15-n04` · branch `w15/n04`
Base revision: `30f2b46` · Node `v22.22.0` (linux) · profile: default AST
(`PHOENIX_NLU_*` unset; no provisioned compiled home in this worktree).

Every claim is **VERIFIED** (observed in a command output in this evidence set),
**INFERRED** (reasoned from pinned source, not observed) or **UNKNOWN**.

Task row read from `docs/parity/tasks.json` (read, **not** modified):

> **acceptance**
> 1. Cover each named introduction/who-am-i/greeting rule, including
>    no-input/no-match and ambiguous name responses.
> 2. Compare entities/referents and rule names in multi-turn robot transcripts
>    using known and unknown loop members.

Pinned reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
(the revision `packages/nlu/resources/rule-inventory.json` pins), path
`packages/parser/robust-parser/rules_src`.

---

## 1. Pinned source (read over the Jibo archive MCP, `gitea_read_file`)

Every rule file in the three N-04 subtrees was fetched at the pinned ref and is
**line-for-line identical** to the vendored `packages/nlu/resources/rules-src/*`
copy once the tool's one-line provenance header is removed (**VERIFIED**):

| subtree | files | local path |
| --- | --- | --- |
| `introductions` (7) | `any_more_intros`, `face_capture_ready`, `intro_looper`, `is_name_right`, `launch`, `recognition_any_more`, `recognition_type_menu` | `rules-src/introductions/` |
| `who-am-i` (5) | `collect_looper`, `confirm`, `launch`, `name_is_right`, `want_to_enroll` | `rules-src/who-am-i/` |
| `greetings` (12) | `bedtime_reminder`, `day_quality`, `greetings_hello`, `launch`, `proactive_general_question`, `proactive_general_statement`, `proactive_morning_question`, `proactive_morning_statement`, `proactive_playful_question`, `proactive_playful_statement`, `sleep_quality`, `you_too` | `rules-src/greetings/` |

MCP calls (24 `gitea_read_file repo=jiboV2/pegasus ref=5c0a739…`), e.g.
`packages/parser/robust-parser/rules_src/greetings/launch.rule` returns a body
whose first line is
`# jiboV2/pegasus:packages/parser/robust-parser/rules_src/greetings/launch.rule@5c0a7390539663ba749d360de348a428c088505c`;
after stripping it, body == vendored file. `gitea_browse` also confirms the
sizes (e.g. `greetings/launch.rule` 10352 bytes, `introductions/intro_looper.rule`
777 bytes) match the vendored copies byte-for-byte.

The launch union that selects these graphs is the `launch` public rule
(`rule-inventory.json`), sources `chitchat/launch … greetings/launch …
introductions/launch … who-am-i/launch …`, with per-source handles
`handle:<skill>/launch`.

Native anchors reused from `resources/legacy-oracle/golden.jsonl`
(`nativeSourceRevision 91b1bb6`): 10 of its 89 cases are N-04 launch rows
(8 greetings + 2 who-am-i).

## 2. The contract (from pinned source)

* **greetings/launch** `TopRule` (lines 1-15, `{domain='greetings'}{skill='@be/greetings'}{priority='HIGH'}`)
  emits `intent` ∈ {`hello`, `goodMorning`, `goodAfternoon`, `goodEvening`,
  `goodNight`, `goodBye`, `imHome`, `imBack`, `heyJibo`, `whatsUp`, `happyHoliday`}
  and, on the `D_GREETINGS_WITH_SELFID` arm (lines 39-46, wired at lines 5-8),
  the extra `selfid` / `inLoop` entities.
* **introductions/launch** `TopRule` (lines 2-11) emits `intent='enrollment'`
  with `style` (`RequestToMeet` line 22), `recipient` (line 6, `'null'` on the
  unknown-member arm line 16) and `enrollmentType`
  (`D_INTRODUCTIONS_ENROLLMENT_TYPE` line 80: voice/face/name/all).
* **who-am-i/launch** (lines 1-10) emits `intent='launchWhoAmI'`, `skill='@be/who-am-i'`.
* The 21 **named** follow-up rules (the sub-rules the skills request on the next
  turn) each translate a yes/no/close/cancel/catch-all arm into an intent, e.g.
  `introductions/recognition_type_menu` is a type menu only (face/voice/name — it
  has **no** yes/no arm), while `who-am-i/confirm` accepts yes/no plus a
  bare-`jibo` `loopmember` arm.
* **Loop member resolution** is `LoopMemberDetector` (N-06; `requestParser.js:359`),
  unchanged here: a resolved member adds `loopMemberReferent`/`given-name`/
  `last-name`; an unknown or absent member adds nothing. Ambiguous first names
  keep the **first** member (`Array.find`).

## 3. What was missing vs implemented

The graphs and the follow-up rules already loaded and routed (N-02). What did
**not** exist was any N-04 verification: no fixture, no multi-turn transcript
comparison, no per-rule coverage, no replay. That is the N-04 implementation.

New artifacts:

* `packages/nlu/test/fixtures/identity-intro-greetings.json` — the fixture.
  `namedRules` (21 rows, one per N-04 public rule, 96 positives + 15 negatives),
  `launchIntents` (21 rows, 10 native-anchored), `noInput` (4), `ambiguous` (3),
  `transcripts` (7 transcripts / 20 turns), and a `divergenceCandidates` block
  (recorded, not asserted — §7).
* `packages/nlu/tools/genIdentityIntroFixture.mjs` — regenerates the fixture
  deterministically from the live runtime (sha256 below is stable across runs).
* `packages/nlu/tools/replayIdentityIntroHttp.mjs` — three-phase replay.
* `packages/nlu/test/identityIntroGreetings.test.js` — 8 focused tests
  (fixture shape, named-rule runtime, launch intents vs native oracle,
  no-input/no-match, ambiguous names, multi-turn transcripts, entity
  provenance, live HTTP).

No production code was changed: no defect in the N-04 rule behaviour was proven.
Two candidate fidelity gaps were observed and are reported in §7 rather than
fixed (they live in the shared AST matcher's arm arbitration, which N-01's
native-verified contract constrains).

## 4. Runtime proof

`node packages/nlu/tools/replayIdentityIntroHttp.mjs` (`runtime-replay.json`,
fixture sha256 `026d4011ab5a4aaa7ee4634b27e87b11408c18d9da14909f781c52550a80af15`) —
exit 0:

```
profile                : ast
reference revision     : 5c0a7390539663ba749d360de348a428c088505c
named-rule coverage    : 21
transcripts            : 7
cases                  : 159
direct parseRequest    : 159/159
live HTTP /v1/parse    : 159/159
native oracle          : 10/10
direct differences     : none
http differences       : none
```

Focused tests: `node --test packages/nlu/test/identityIntroGreetings.test.js`
→ `# tests 8  # pass 8  # fail 0  # cancelled 0`.

The multi-turn transcripts compare entities, referents **and** rule names per
turn, and assert the referent is present only when the named person is a known
loop member (`known-member-identity-enrollment`, `known-member-introduction`
expect a referent; `unknown-member-*` and `no-members` expect none).

## 5. Falsification (required, concrete)

Broke **one full line** — the referent write —
`packages/nlu/src/loopMemberDetector.js:71`:

```js
-      result.entities['loopMemberReferent'] = loopMember.id;
+      result.entities['loopMemberReferent'] = `${loopMember.id}__falsified__`;
```

`node --test packages/nlu/test/identityIntroGreetings.test.js` then failed three
named tests (`falsification.log`), exit 1:

```
not ok 5 - N-04 an ambiguous first name resolves deterministically to the first member
not ok 6 - N-04 multi-turn transcripts replay exactly, with referents only for known members
not ok 8 - N-04 the identity/introduction/greeting contract holds over live POST /v1/parse
# pass 5   # fail 3   # cancelled 0
```

Restoring the line (`loopMemberDetector.js:71` reads `… = loopMember.id;`)
returned `# pass 8  # fail 0`, exit 0.

## 6. Full test run and parity gate

One full `npm test` at this revision with a clean environment (`PHOENIX_NLU_*`
unset), exit status **0** (`npm-test.log`):

```
# tests 1864   # suites 7
# pass 1856     # fail 0
# cancelled 0    # skipped 8   # todo 0
Checklist: 55/79 verified (69.6%)
Tracker structure, dependencies, evidence links and generated checklist are valid.
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Baseline was 1856 tests; the 8 new tests are N-04's, so `1856 + 8 = 1864`.
`cancelled 0` confirms no concurrent-run corruption; the 8 skipped are the
artifact-gated compiled profiles. A first run hit a transient
`EADDRINUSE :::7810` in an unrelated D-04 calendar test (a fixed-port collision
with a concurrent worktree run); with the port free the same suite is green.

## 7. Divergence candidates (reported, not written to DIVERGENCES.md)

Recorded in the fixture's `divergenceCandidates` block; **not** asserted, because
there is no native capture to fix against.

* **N04a — the greetings self-identification arm never wins the launch union.**
  `greetings/launch.rule:39-46` (`D_GREETINGS_WITH_SELFID`) carries `selfid` +
  `inLoop`, but `introductions/launch.rule` also matches every self-identifying
  phrase and scores higher, so via `rules:['launch']` the `selfid`/`inLoop`
  entities are unreachable and `it's me Mary` returns
  `intent:'enrollment'` (`handle:introductions/launch`). Whether native picked
  greetings is **UNKNOWN** (no capture).
* **N04b — the full copula drops the parsed name.** Through
  `rules:['launch']`, `it's me Mary` → `GivenName:'mary'` but `it is me Mary` →
  `GivenName:''`. The vendored `introductions/launch.rule` is byte-identical to
  the pinned source, so this is AST arm-selection of `$LOOPMEMBER` (the wildcard
  alternative at line 88 beats `$GIVEN_NAME`), not a source edit. Native
  behaviour is **UNKNOWN**.

Both are in the shared weighted-FST arbitration the AST matcher approximates;
N-01 pinned that arbitration against the 42-case native capture, so neither is
touched here.

## 8. Evidence classes

* **VERIFIED (observed):** the 24 vendored rule files equal the pinned archive
  bodies; 159/159 cases through `parseRequest` and live `/v1/parse`; 10/10
  native oracle rows; 8/8 focused tests; the falsification on
  `loopMemberDetector.js:71`; the full `npm test` (1864/0/0) and gate.
* **INFERRED:** the source-derived intents/entity keys for rows with no native
  capture — every expected entity key is re-checked as declared by the pinned
  rule source, and every launch intent carries the source graph handle.
* **UNKNOWN:** native behaviour for `N04a`/`N04b`; the compiled-fst profile
  (no provisioned home in this worktree — same limitation N-05 recorded).

## 9. Reproduce

```
node packages/nlu/tools/genIdentityIntroFixture.mjs           # deterministic fixture
node packages/nlu/tools/replayIdentityIntroHttp.mjs           # 159/159, exit 0
node --test packages/nlu/test/identityIntroGreetings.test.js  # 8/8, exit 0
npm test                                                      # 1864 / 0 fail, exit 0
```
