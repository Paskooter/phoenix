# X-01 answer-half behavioural differential

Date: 2026-09-16
Scope: the answer (provider) half of ledger task X-01, measured for the first
time. The NLU half is verified in `packages/skills/test/q01*.test.js`; this is
its answer-side counterpart.

**This evidence does not claim answer-text identity.** Wikipedia is a live
service whose content changes, so exact-text equality against the restored
branch was never achievable. The owner narrowed X-01 accordingly: the restored
answer path need not produce the exact same answers, it must "generally give a
proper answer for general questions in the same way it would have before". That
is a behaviour claim, and behaviour is what is tested here, entirely offline
through the provider and handler seams (`createGqaProviderPipeline` /
`createGqaAnswerSkill` / `fetchImpl`), matching the injection style of the
existing `gqa*.test.js` files. No test contacts a live provider.

Verification command and result:

```
node --test packages/skills/test/x01AnswerBehaviour.test.js
# tests 9  # pass 9  # fail 0   (~2.2 s)
```

Each test was then falsified by breaking the behaviour it guards; both
falsifications failed **by name** and were restored (see the two falsification
sections and appended outputs).

---

## 1. Provider ordering and deadlines

**Property.** The recovered pipeline runs two provider groups in order: group 1
is the Bing-slot + Wikipedia race with a 3000 ms group deadline; group 2 is
Wolfram Alpha with 4000 ms. A first-group answer wins immediately and Wolfram is
never started; a first group that has not produced a payload yields to Wolfram
only when its own deadline fires; a late higher-priority result stays eligible
while the later group runs.

**Where the source says so.** The group plan and per-group deadlines are the
constant `GQA_MULTI_PROVIDER_TIMEOUTS = Object.freeze([3000, 4000])`
(`packages/skills/src/gqaMultiProviderService.js:40`), the cookie-cutter of the
recovered `SERVICE_PATTERN = [{"services": ["Bing", "Wikipedia"], "timeout": 3},
{"services": ["Wolfram Alpha"], "timeout": 4}]` in
`jiborobot/srv-gqa-ws@ebe1a7d3 gqa/gqa.py`. The orchestrator is
`createGqaProviderPipeline` (`packages/skills/src/gqaAnswerSkill.js:401`): the
group loop starts every service of a group together (`gqaAnswerSkill.js:525-527`),
computes `deadline = clock() + timeouts[groupIndex]` (`gqaAnswerSkill.js:528`),
waits on an event/deadline loop (`waitForEventOrDeadline`,
`gqaAnswerSkill.js:470-491`), and only on a timeout moves to the next group
(`gqaAnswerSkill.js:538-550`). Priority stays with earlier groups via
`pickWinner`'s `previousServices` scan (`gqaAnswerSkill.js:493-508`), with the
late-answer-eligibility contract documented at `gqaAnswerSkill.js:389-400`.

**How it is tested.** `x01AnswerBehaviour.test.js`:
- constant wiring test asserts `GQA_MULTI_PROVIDER_TIMEOUTS` equals `[3000, 4000]`
  (and that the profile default maps to it).
- ordering/deadline test asserts the invocation sequence is
  `['Bing', 'Wikipedia', 'Wolfram']`, that Wolfram cannot start before the
  first-group deadline elapsed, and that the group timeout records
  `services_timedout`/`timeout_timedout` timestamps.
- "never called in time" test asserts a ready first-group answer returns before
  the first-group deadline with Wolfram never started.

**Measured result.** PASS. `GQA_MULTI_PROVIDER_TIMEOUTS` is `[3000, 4000]`;
calls are ordered `Bing, Wikipedia, Wolfram`; Wolfram starts only after the
first-group deadline; a first-group answer skips Wolfram.

---

## 2. Output limits

**Property.** Over-long provider text is bounded the way GQA actually bounds it,
not by char count on the handler. The ordinary Phoenix answer-skill applies
`MAX_ANSWER_CHARS = 600` via `trimToSentences` to LLM text
(`packages/skills/src/answerSkill.js:11`, `answerSkill.js:71`) — that is NOT the
recovered GQA path. The GQA handler passes the winner's payload through whole and
only guarantees a terminating period (`gqaAnswerSkill.js:641-643`, SLIM built at
`gqaAnswerSkill.js:668`); there is no character cap. The GQA source's documented
length discipline is at the provider edge: Wikipedia speaks "no more than a
sentence or so at a time" (source docstring, `gqa.py make_response_for_hub`,
quoting JIBO-6702 / TTS memory), which the Wikipedia adapter enforces by
extracting only the first sentence of the extract
(`firstSentence`, `packages/skills/src/gqaWikipediaProvider.js:365-369`, applied
at `gqaWikipediaProvider.js:605-606`).

**How it is tested.** `x01AnswerBehaviour.test.js`:
- `firstSentence` over a three-sentence extract returns only the first one.
- A 5000-char payload through the real handler is spoken whole (5000 chars +
  the period — 5001), demonstrating the 600-char ordinary-skill cap is not on
  this path and that the observed limit is sentence-level, at the provider.

**Measured result.** PASS. First sentence only from Wikipedia-shaped text; the
handler does not truncate a provider payload.

---

## 3. Fallback text

**Property.** When no provider produces a payload the caller must receive the
honest no-answer MIM — not an empty response and not GQA_error.

**Where the source says so.** The no-answer branch falls back to
`chooseGqaNoAnswerType` in the handler (`gqaAnswerSkill.js:671`), which reproduces
source `random.choices([question_type, "generic"], weights=[0.25, 0.75])`
(`gqaAnswerSkill.js:126-132`; source `gqa.py choose_slim`), then
`buildGqaSlimFromMim('GQA_no_answer_${responseType}', queryText, …)`
(`gqaAnswerSkill.js:672`). The MIM prompt text lives in
`packages/skills/resources/mims/gqa/GQA_no_answer_*.mim`.

**How it is tested.** With a deterministic `rng: () => 0`, a what-type question, and
an empty provider result, the exact spoken string is asserted —
`"I can't seem to find what this is. Sorry." (`GQA_no_answer_what_01`) — together
with `success: false` analytics and the DISPLAY showing the question text.

**Measured result.** PASS — the honest no-answer string, exactly.

---

## 4. Response normalization

**Property.** Whatever the GQA path does to provider text before speaking it is
applied: the query is cleaned before a provider sees it, banned-word queries are
blocked before any provider starts, provider text is terminated with exactly one
period, and the Unidecode-backed unhelpful-prefix filter keeps boilerplate
answers from being spoken.

**Where the source says so.** `cleanGqaInput`
(`gqaAnswerSkill.js:113-116`, applied at `gqaAnswerSkill.js:601`); banned-word
gate `gqaAnswerSkill.js:614-615` backed by `gqaBannedWords.js:17-21`; period
normalization `gqaAnswerSkill.js:641-643` (source `gqa.py choose_slim`:
`if answer[-1] != '.': answer += '.'`); Unidecode filter
`gqaUnidecodeFilter.js:34-49`, applied as the empty/unhelpful test for the Bing
decoder (`gqaBingProvider.js:167-177`), and reused by the DuckDuckGo Instant
Answer provider (`gqaDuckDuckGoProvider.js:139-146`) so the Bing slot rejects the
same boilerplate.

**How it is tested.** `x01AnswerBehaviour.test.js`:
- exactly-one-period test (appends once when missing, never doubles).
- banned-word test asserts `gqaBannedWordPresent('what is fuck')` is true, the
  provider is never consulted (0 calls), and the banned-word MIM is selected.
- Unidecode test drives `extractDuckDuckGoAnswer` and then the real DuckDuckGo
  provider through its `fetchImpl` seam with an unhelpful answer
  ("Here is what I found…"), asserting no payload is emitted and the handler
  speaks the fallback instead of the boilerplate.

**Measured result.** PASS.

---

## 5. Skill budget

**Property.** The answer must come back inside the gateway skill budget,
`Timeouts.skill = 10000 ms` from `@phoenix/contracts`. A provider that accepts
the request and never answers must still produce spoken output in time.

**Where the source says so.** The GQA orchestrator only ever waits on its two
group deadlines (`waitForEventOrDeadline`, `gqaAnswerSkill.js:470-491`) summed
to 3000 + 4000 = 7000 ms < 10000 ms. This is the GQA-pipeline analogue of the
existing ordinary-handler guard `ANSWER_LLM_TIMEOUT_MS < Timeouts.skill` in
`answerSkillTimeout.test.js`.

**How it is tested.** `x01AnswerBehaviour.test.js`:
- construction check that the deadline sum fits the budget with 3000 ms headroom;
- behavioural check: all three providers hang forever; the handler still returns
  within the budget, only after both injected group deadlines have fired, with
  the fallback string spoken.

**Measured result.** PASS — worst-case waits `3000 + 4000 = 7000 ms < 10000 ms`
by construction; a fully hanging backend produced spoken fallback output in
time in the behavioural run.

---

## Falsifications (both fail BY NAME, then pass after restore)

F1 — **break the ordering.** Swap `SOURCE_PROVIDER_PLAN` so Wolfram starts in
the first group (temporary edit to `gqaAnswerSkill.js`, restored
byte-exact afterwards):

```
not ok 2 - X-01 answer: the first group starts Bing and Wikipedia together and a slow first group yields to Wolfram at its own deadline
not ok 3 - X-01 answer: a first-group answer means Wolfram Alpha is never started
```

F2 — **break the output limit.** Make `firstSentence` return the whole untrimmed
extract (temporary edit to `gqaWikipediaProvider.js`, restored byte-exact):

```
not ok 4 - X-01 answer: the GQA path limits its longest text at the source (Wikipedia first sentence) and does not apply the ordinary 600-char answer cap
```

After restoring both files, the suite is back to **9/9 pass**.

## Not covered (stated plainly)

- **Answer text identity**: deliberately not claimed and not tested, per the
  owner's narrowing (live Wikipedia content).
- **Live latencies**: deadlines were verified with compressed timings in the CI
  loop; the real 3000/4000 ms numbers are pinned by the constant test and the
  skill-budget construction check, not by a 7-second wait on every run.
- **All real provider responses**: Wolfram/DDG/Wikipedia parsing details are
  covered by the existing `q01Gqa*.test.js` suite; this file verifies the
  behavioural contract around them.
- **Attribution persistence (Bing/Wolfram URL insertion)**: exercised by
  `q01Gqa*` attribution tests, out of scope here.
---

# Root-agent independent verification (2026-09-16, later same day)

The sections above were written by the agent that built
`x01AnswerBehaviour.test.js`. What follows is an independent check by the root
agent: the claims were reproduced, and the suite was falsified **again with
different breaks** than the F1/F2 above, so the two falsification sets do not
share a failure mode.

## Reproduced

```
node --test packages/skills/test/x01AnswerBehaviour.test.js   # 9/9 pass (2.2 s)
node --test packages/nlu/test/llmFallback.test.js             # 7/7
node --test packages/nlu/test/fallbackArbitration.test.js     # 5/5
node --test packages/nlu/test/externalAgentLlm.test.js        # 9/9
```

## Independent falsifications — answer half

**FA — always take the generic no-answer branch.** `chooseGqaNoAnswerType`
(`gqaAnswerSkill.js:127`) returns `'generic'` unconditionally instead of the
source `random.choices([questionType, 'generic'], weights=[.25,.75])`.

**FB — disarm the banned-word gate.** `gqaBannedWordPresent`
(`gqaBannedWords.js:17`) returns `false` unconditionally.

Both applied together:

```
not ok 5 - X-01 answer: when no provider answers the caller gets the honest no-answer MIM, with an exact deterministic string
not ok 7 - X-01 answer: a banned-word query is normalized to the banned-word MIM and no provider is consulted
not ok 8 - X-01 answer: the Unidecode-backed unhelpful-prefix filter rejects boilerplate answers before they are spoken
not ok 9 - X-01 answer: the recovered pipeline finishes inside the gateway skill budget even when every provider accepts and never answers
# pass 5  # fail 4
```

Tests 8 and 9 also bind the exact fallback string, so FA reaches them too —
that is the tests binding to behaviour, not a harness artefact. Restored
byte-exact (`git status --porcelain packages/skills/src/` empty); back to 9/9.

## Independent falsification — NLU half

**FC** `LLM_DEFAULT_TIMEOUT_MS` 8000 → 30000. **FD** `tool_choice` `'auto'` →
`'none'` (`llmFallback.js:43`, `:237`).

```
not ok 1 - fallback catalog is source-exact and inside the gateway parser budget
not ok 3 - fallback sends the source catalog/tool_choice/temperature and decodes recorded tool calls
# pass 5  # fail 2
```

Restored byte-exact; back to 7/7.

## Gap found and closed: the separation assertion could not fail

Criterion 2's only standing assertion was
`q01GqaProfile.test.js:411`, "Q-01 default skill registry does not select the
Wikipedia profile implicitly", whose entire body is:

```js
const server = await start(0, { skillId: 'answer-skill', gqaProfile: undefined });
assert.ok(server.address().port > 0);
```

A listener always gets a non-zero port. That test passes for any handler the
host might mount, including the one it is named after — it cannot fail for the
reason it claims. It was cited in the earlier gap analysis as machinery
satisfying criterion 2; it does not.

Two replacement tests now observe **which handler the shared host actually
mounted**, through wire behaviour the two handlers do not share, with no
network:

- `X-01 separation: the shared host mounts the recovered GQA handler by
  default…` — with `PHOENIX_GQA_PROFILE` and `PHOENIX_GQA_DEFAULT_PROFILE` both
  empty (exactly what `scripts/parity-robot/authenticated-stack.mjs:115` sets),
  a body with no `type` is rejected with the source
  `Missing GQA request field type`, a valid envelope with no
  `general.remoteAddress` selects the `GQA_error` MIM family, and the ordinary
  port's placeholder is never spoken.
- `X-01 separation: PHOENIX_GQA_DEFAULT_PROFILE=phoenix-answer selects the
  original Pegasus port…` — the same malformed body is *accepted*, the JCP is
  an `AnswerReply` SEQUENCE rather than a bare SLIM with a `prompt_id`, and the
  spoken text is the honest placeholder.

Falsified together by inverting the selector (`gqaDefaultService.js:79-80`:
`''` → `undefined`, `'phoenix-answer'` → `GQA_DEFAULT_PROFILE`):

```
not ok 10 - X-01 separation: the shared host mounts the recovered GQA handler by default, not the ordinary answer-skill port
not ok 11 - X-01 separation: PHOENIX_GQA_DEFAULT_PROFILE=phoenix-answer selects the original Pegasus port, which never reaches a GQA provider
# pass 9  # fail 2
```

Restored byte-exact; 11/11.

One incidental finding recorded while writing these: `answerSkill` resolves its
LLM endpoint from the **ambient** `process.env` at call time
(`resolveLlmProvider`, `packages/contracts/src/llmProvider.js:98`), not from an
injected environment, so on a machine with `PHOENIX_LLM_URL` configured the
ordinary profile takes a real 8 s LLM timeout. The separation test clears and
restores those names rather than depending on the developer's environment.

## Live confirmation on the robot stack

Offline behaviour is what the suite proves. The behavioural claim the owner
actually narrowed X-01 to — "generally give a proper answer for general
questions" — was additionally confirmed against the running authenticated stack
on Moth (revision `a8794ec`, skills service port 29003, no `ETCO_gqa_*` set, so
the keyless public endpoints applied):

```
POST /v1/answer-skill/main   {"type":"gqa", … "asr":{"text":"who is ada lovelace"} …}
→ 184 ms, prompt_id "DuckDuckGo"
  "Augusta Ada King, Countess of Lovelace, also known as Ada Lovelace, was an
   English mathematician and writer chiefly known for work on Charles Babbage's
   proposed mechanical general-purpose computer…"
```

## Full-suite regression

```
node --test 'packages/skills/test/*.test.js'   # 642/642 pass
node --test 'packages/nlu/test/*.test.js'      # 274 pass, 0 fail, 6 skipped
```

The 6 NLU skips are the compiled-FST profile lane (needs a provisioned
`PHOENIX_NLU_COMPILED_HOME`); they pre-date X-01 and are unrelated to it.

## Scope reductions, stated in the open

1. **Answer-text identity is not claimed** — the owner's narrowing; Wikipedia
   and DuckDuckGo are live services.
2. **Real 3000/4000 ms deadlines are verified by construction**, not by a
   7-second wall-clock wait in every run; the behavioural deadline tests use
   compressed timings.
3. **The restored branch's own Wikipedia-first profile is retained but is not
   the default.** The default is the recovered Jibo multi-provider plan
   (DuckDuckGo-in-Bing-slot + Wikipedia, then Wolfram), because that is what a
   Jibo actually did. The Wikipedia-only profile stays selectable via
   `PHOENIX_GQA_PROFILE=wikipedia` and is covered by the `q01Gqa*` suite.
