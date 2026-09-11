# N-03 — Verify clock, alarm, timer and settings/menu follow-up rules

Evidence date: 2026-09-11 · worktree `.parity/worktrees/w12-n03` (branch `w12/n03`,
base `e12ab0d`) · Node `v22.22.0` (linux) · profile: default AST
(`PHOENIX_NLU_*` unset).

Every claim is **VERIFIED** (observed in a command output in this evidence set or
through the Jibo archive MCP), **INFERRED** (reasoned from pinned source, not
observed) or **UNKNOWN**.

**Recommendation: N-03 is NOT fully certifiable — `recommend_verified=false`.**
18 of the 20 named rules are fully replayed (122 cases through `parseRequest`, a
live `POST /v1/parse` and a local-turn WebSocket). The two rules that declare the
`time` factory (`clock/alarm_set_value`, `clock/alarm_timer_ampm`) remain behind
the whole-rule refusal for **every** utterance, including the AM/PM envelope the
acceptance criteria name explicitly. §5 shows why narrowing the gate is not
sound; §6 falsifies the retained gate; §7 is the full clean run.

---

## 1. Specification actually used

Re-derived from the `N-03` row of `docs/parity/tasks.json` (read, **not**
modified):

1. *Replay every clock/settings/main-menu named rule with positive, negative and
   boundary utterances.*
2. *Verify alarm/timer values, AM/PM, cancellation, confirmation, volume and menu
   selections through local-turn WS sessions.*

Pinned reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`,
`packages/parser/robust-parser/rules_src/{clock,settings,main-menu}` (the
revision pinned by `packages/nlu/resources/rule-inventory.json.referenceRevision`,
which the fixture also pins — asserted in the fixture test).

The three groups hold exactly **20** public rules (12 `clock/`, 5 `settings/`,
3 `main-menu/`; `packages/nlu/resources/rule-inventory.json.publicRules`). The
group `launch` union is the `launch` rule, owned by N-01/N-05, not by this task.

## 2. What the wave-11 N-05 fixes already cover for N-03

| rule set | fixture rows | cases | runtime through `parseRequest` | notes |
|---|---|---|---|---|
| 10 `clock/*` non-time rules | 10 | 61 | **VERIFIED** pass | positive + negative + boundary each |
| 5 `settings/*` rules | 5 | 37 | **VERIFIED** pass | |
| 3 `main-menu/*` rules | 3 | 24 | **VERIFIED** pass | |
| `clock/alarm_set_value` | refusal × 12 | 12 | **VERIFIED** loud refusal | `$factory:time` |
| `clock/alarm_timer_ampm` | refusal × 12 | 12 | **VERIFIED** loud refusal | `$factory:time` |

The N-05 fixes are load-bearing for four N-03 rules and are re-pinned here:

* **factory namespace isolation** — `clock/alarm_timer_change`,
  `clock/alarm_timer_other_set`, `clock/alarm_timer_none_set` and
  `settings/download_now_later` call `$factory:yes_no` while declaring their own
  `YES`/`NO` sub-rules (`clock/alarm_timer_change.rule:17,27`). Before the fix
  literal `yes`/`no` no-matched. **VERIFIED** green now.
* **conditional `{% if %}` actions** — `clock/alarm_timer_change.rule:12-13`
  (`yes`→`delete`, `no`→`keep`) and `clock/alarm_timer_other_set.rule:12-13`
  (`yes`→`replace`, `no`→`keep`). **VERIFIED** green now.

## 3. Contract from the Jibo archive MCP

Fetched with the archive portal's `gitea_read_file` tool
(`https://pvindex.org/mcp`). After removing the portal's `# <repo>:<path>`
attribution line, its blank line and its one trailing newline, each archived body
is **line-for-line identical to the vendored pin** (**VERIFIED**; report in
`archive-verification.json`, script `archive-verify.py`):

| archive source | vendored path | bytes | vendored sha256 |
|---|---|---|---|
| `jiboV2/pegasus@5c0a739:packages/parser/robust-parser/rules_src/clock/alarm_timer_ampm.rule` | `packages/nlu/resources/rules-src/clock/alarm_timer_ampm.rule` | 471 | `4abd795bc17d86363cc41199d0678cd19e4c1200a8b98f78258de82f229a125f` |
| `…/clock/alarm_set_value.rule` | `…/rules-src/clock/alarm_set_value.rule` | 1829 | `70f1fd871a30620a2b78b6000eb97a1571238c8a9e37e34c3d3f0a5bcffa8fb3` |
| `…/clock/alarm_timer_change.rule` | `…/rules-src/clock/alarm_timer_change.rule` | 847 | `be20ccd0fa926c92fa57d748f8fe77c763827448768c7c1fa782d19f7319f2fd` |
| `…/clock/timer_set_value.rule` | `…/rules-src/clock/timer_set_value.rule` | 2339 | `8a4f705677656b83a80059d7e1e67ecee47b15721bee58c8b5f681b42ac10a17` |
| `…/settings/volume_control.rule` | `…/rules-src/settings/volume_control.rule` | 3606 | `cdbad8d92b92f429b911c1b46e9379f032d16acf3b7c1a887aa8cf8677b7e7fe` |
| `…/main-menu/execute_main_menu.rule` | `…/rules-src/main-menu/execute_main_menu.rule` | 1528 | `d4f634b75602be9cd43b0e97dba076c2742c5a5225592a5503d6f06688ca3314` |
| `ConvTech/jibo-nlu-data@master:en-us/factory_rules/time.grm` | `packages/nlu/resources/factory-sources/time.grm` | 14172 | `b4a528c8c36177b55142a9c40f8cbf341013b83c906b24b80371835cf1fba02b` |

`gitea_browse` on the pinned `clock/` directory reports 13 files, matching the
13 vendored `clock/*.rule` sources. The archive confirms the two decisive source
lines quoted below.

## 4. Runtime proof

`packages/nlu/test/fixtures/clock-settings-menu.json` (sha256
`14ff0379d9d4d85fdd8d523e9baf0db9fd1b2a34fb9d9cbb4492c515d6ba39f4`): 18 rule rows,
122 cases (positive + negative + boundary; every case cites the `source` line it
exercises) plus 24 refusal utterances for the two gated rules.

`packages/nlu/tools/replayClockSettingsHttp.mjs` (artifact
`runtime-replay.json`) drives every row through `parseRequest()` **and** a live
`POST /v1/parse` on an ephemeral port (**VERIFIED**):

```
profile                 : ast
reference revision      : 5c0a7390539663ba749d360de348a428c088505c
fixture                 : 14ff0379d9d4d85fdd8d523e9baf0db9fd1b2a34fb9d9cbb4492c515d6ba39f4
named-rule coverage     : 20
match cases             : 122
direct parseRequest     : 122/122
live HTTP /v1/parse     : 122/122
refusal cases (thrown)  : 24/24
refusal cases (HTTP 500): 24/24
time.grm parse          : parser: unexpected COLON (:) at 5:23
```

Local-turn WebSocket (`packages/gateway/test/localTurnClockSettingsMenu.test.js`,
ephemeral ports) drives the real robot path — `LISTEN(mode:'CLIENT_ASR')` +
`CONTEXT` + `CLIENT_ASR{text}` into the gateway, the gateway's own
`_performNLU()` → `parserClient` → `POST /v1/parse`
(`packages/gateway/src/listenTransaction.js:378-406`,
`packages/gateway/src/parserClient.js:19`) — and asserts on the final frame
(**VERIFIED**):

* eight rule/intent pairs return the parsed intent/entities on the final `LISTEN`
  (`clock/clock_menu` `askForTime/{domain:clock}`,
  `clock/timer_set_value` `timerValue/{hours:null,minutes:5,seconds:null,domain:timer}`,
  `clock/stop_timer` `stop`, `clock/alarm_timer_change` `delete`,
  `settings/execute_settings_menu` `battery`,
  `settings/volume_control` `volumeUp/{volumeLevel:null,domain:gui_command}`,
  `main-menu/execute_main_menu` `loadMenu/{destination:settings}`,
  `main-menu/execute_personal_report` `loadMenu/{destination:weather}`);
* both time-factory rules return a final `ERROR` frame `{code:'PARSER',
  message:'parser 500'}` for `am`, `seven thirty am` and `set an alarm`.

Entity values are source-exact, e.g. `clock/timer_set_value.rule:51`
`(one|1 [day?s]){_hours='24'…}` → `one day` ⇒ `hours:"24"`;
`settings/volume_control.rule:45` `{_volumeLevel='10'}` ⇒ `maximum volume` ⇒
`volumeLevel:"10"`; `main-menu/execute_fun_stuff.rule:19`
`([surprise?s] ?(me)) {_destination='surprise'}` ⇒ `surprise me` ⇒
`destination:"surprise"`.

## 5. The `time` gate: what is still blocked, and whether it can be narrowed

### 5.1 Where the gate is

`packages/nlu/src/requestParser.js:212-217` collects a public rule's unsupported
factory dependencies; `:322-333` throws before any matching when one is present in
the AST profile:

```
$ parseRequest({text:'am', rules:['clock/alarm_timer_ampm']})
Error: Unsupported NLU factory dependencies for public rule 'clock/alarm_timer_ampm': time
```

`rule-inventory.json.factoryDependencies.time.status === 'unsupported'`
(`referencePath build/data/en-us/factory_rules/time.fst`,
`referenceSha256 ccc50d3c…`). The gate is **whole-rule**: it fires for every
utterance, including ones the rule's own non-time arm can match. **VERIFIED**:
all 24 refusal utterances throw, and all 24 return HTTP 500.

### 5.2 Why the non-time arm exists — and is source-equivalent for bare AM/PM

`clock/alarm_timer_ampm.rule:10` (archive-verified) declares two arms:

```
D_ALARM_TIME_VALUE = $factory:time {_ampm=time._time_ampm}{_intent='set'} | $AM_PM{_ampm=AM_PM._ampm}{_intent='set'};
AM_PM = (a.m.|am|(a m)|(a. m.)) {_ampm='AM'} | (p.m.|pm|(p m)|(p. m.)) {_ampm='PM'};
```

For the eight spellings, the absent factory arm and the present `$AM_PM` arm
cannot disagree: `time.grm:237-242` declares the same spellings with the same
`_nl` values, and `time.grm:166` `AM_ALONE` covers the spaced/dotted forms
(**VERIFIED** against the archived body). Both arms also tag `_intent='set'`, and
`TopRule` copies `ampm`/`intent`/`domain='alarm'` identically. Measured with a
gate-free matcher context that mirrors `requestParser.js:226-238`
(`runtime-replay.json.narrowingProbe`):

```
clock/alarm_timer_ampm  "am"   -> match=true  intent="set" ampm="AM"
                        "pm"   -> match=true  intent="set" ampm="PM"
                        "a.m." -> match=true  intent="set" ampm="AM"
                        "p.m." -> match=true  intent="set" ampm="PM"
```

So the AM/PM envelope **is** arm-for-arm reproducible (**VERIFIED** at the matcher
level; the *reference's* choice between the two arms is **INFERRED** to be
observationally identical because both yield the same tags).

### 5.3 …but narrowing the whole-rule gate is not sound — gate retained

Removing the gate converts the loud refusal into a **silent no-match** for
everything the absent `time` factory would have matched. Measured on the same
gate-free matcher (`runtime-replay.json.narrowingProbe`):

```
clock/alarm_timer_ampm  "noon"           -> match=false   (time.grm:65-66 noon -> ampm PM)
                        "morning"        -> match=false   (time.grm:130 morning -> ampm AM)
                        "seven thirty"   -> match=false
clock/alarm_set_value   "seven thirty am"-> match=false   (reference matches via $factory:time)
                        "set an alarm for 7:30" -> match=false
```

`clock/alarm_set_value` is worse: its two non-time arms sit behind wildcards the
factory arm could also absorb —
`alarm_set_value.rule:47` `$* ?$factory:time $* $D_ALARM_V_INVALID_TIMESCALE $*
?$factory:time $* ~0.1` and `:51` `1|one [day?s] ?(from now)` (narrowed `one day
from now` ⇒ `time:"24h0m0s"`). Because `TopRule` wraps the value rule in `$*`
(`:1-19`), the reference's `$factory:time` arm can match a *prefix* of the same
utterance and its lowest-cost path may differ, so a narrowed match is **not**
provably the reference's arm. **INFERRED**, and the reason a match-anywhere
narrowing cannot be certified.

**Determination — `time_gate_narrowed=false`.** The coarse whole-rule refusal is
retained deliberately: the alternative (a) introduces silent wrong answers where
the reference matches (a regression against N-05's "never a silent no-match"
acceptance), and (b) cannot be certified arm-for-arm for `alarm_set_value`. A
sound narrowing would first require the `time` factory to be served. Its only
bundled source does not parse — `time.grm:22,40` `?(?: $minutes_number…)` lexes
`:` as `COLON` (`packages/nlu/src/grammar/lexer.js:177`), while the native scanner
treats `:` as a word character — so `parseRules(time.grm)` fails
(`parser: unexpected COLON (:) at 5:23`, **VERIFIED**) and no factory graph can be
built. With the colon form replaced by `(` only as a probe, the source parses into
38 rules, so the literal-colon form is the sole blocker. Wiring the factory (and
certifying it against the compiled `time.fst`, whose bytes are **not** present in
this worktree) is N-02 territory, not N-03 verification.

The refusal is pinned by tests so a future narrowing is a conscious change:
`clockSettingsMenu.test.js` tests 3, 4, 5, 6 and the gateway local-turn test 2.

## 6. Falsification (required, concrete)

One full code line, `packages/nlu/src/requestParser.js:325`:

```diff
-      if (unsupported.length) {
+      if (false && unsupported.length) {
```

`node --test packages/nlu/test/clockSettingsMenu.test.js` (**VERIFIED**, log
`falsification.log`):

```
not ok 3 - N-03 every fixture matches through a live POST /v1/parse and the time rules refuse
not ok 4 - N-03 the time-factory rules refuse loudly for every utterance, never a silent no-match
not ok 6 - N-03 the non-time AM/PM arm is source-equivalent for bare am/pm but unreachable without the time factory
# tests 8   # pass 5   # fail 3
```

`node --test packages/gateway/test/localTurnClockSettingsMenu.test.js`
(**VERIFIED**):

```
not ok 2 - N-03 local turn: the time-factory rules surface a loud PARSER error, never a silent no-match
  error: |-   expected: 'ERROR'   actual: 'LISTEN'
# tests 2   # pass 1   # fail 1
```

Line restored (`requestParser.js:325` reads `if (unsupported.length) {`;
`git diff` empty). Restored run (**VERIFIED**):

```
nlu   packages/nlu/test/clockSettingsMenu.test.js          # pass 8  # fail 0  # cancelled 0
gw    packages/gateway/test/localTurnClockSettingsMenu.test.js  # pass 2  # fail 0  # cancelled 0
```

## 7. Full test run and parity gate

One full `npm test` on the committed tree with a clean environment
(`PHOENIX_NLU_*` unset), exit status **0** (log `npm-test.log`, **VERIFIED**):

```
# tests 1814   # suites 7
# pass 1807     # fail 0
# cancelled 0    # skipped 7   # todo 0
Checklist: 51/79 verified (64.6%)
Tracker structure, dependencies, evidence links and generated checklist are valid.
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

`cancelled 0` confirms no concurrent-run corruption; the 7 skipped are the
artifact-gated compiled profiles. 1814 = the base 1804 + the 10 N-03 tests added
here.

## 8. Divergence candidates (reported, not written to DIVERGENCES.md)

* **D-N03a — worktree `@phoenix/*` imports resolve to the MAIN checkout.**
  `.parity/worktrees/w12-n03/node_modules` is a symlink to
  `/home/shell/work/phoenix/node_modules`, whose `@phoenix/nlu` entry is
  `../../packages/nlu` — resolved **under the main repo**. Any worktree test that
  imports a service by package name therefore exercises the main tree's code, not
  the worktree's. **VERIFIED**: with the gate line broken in the worktree, a
  package-name import still returned the refusal; the same test failed as soon as
  the import was made relative. `packages/*/test/*.js` that import `@phoenix/*`
  (e.g. `packages/gateway/test/listen.e2e.test.js:36-39`) share this hazard and
  can only be trusted while main == worktree HEAD. Not a product divergence — a
  verification-integrity hazard for the whole parity effort.
* **D-N03b — `clock/alarm_timer_info` and `clock/alarm_timer_query_menu` have
  identical contracts.** Their `CHANGE`/`CANCEL` arms are textually identical
  (`alarm_timer_info.rule:10-22` == `alarm_timer_query_menu.rule:10-22`), so a
  request naming both rules ties. `selectBestNative` would keep request order.
  **UNKNOWN** — no observed multi-rule case for this pair.
* **D-N03c — profile-dependent contract for the two gated rules.** The AST profile
  refuses (`HTTP 500`); N-01 measured the compiled profile serving both
  (`runtime-per-rule-compiled.json`). **VERIFIED** for AST here;
  **INFERRED** for the compiled side (its 42 MB artifact is absent in this
  worktree).
* **D-N03d — pre-existing N-02 items unchanged**: `digit`/`year` tag composition
  (N-02 §4) and AST-vs-compiled scoring (N-01 D1) still apply; no N-03 fixture
  depends on either.

## 9. Limits and unknowns

* **UNKNOWN** — the archived 42-case native capture carries no clock/settings/
  main-menu local-turn body, so no N-03 expectation is anchored to a *recorded
  native response*; every expectation is source-derived and confirmed against
  Phoenix. Nothing here is a native-body differential.
* **UNKNOWN** — whether the AST or compiled profile is deployed on Moth. All
  runtime facts in §4/§5 are the AST profile; the compiled profile would serve the
  two gated rules instead of refusing.
* **INFERRED** — 13 of the 20 rule sources were not re-fetched from the archive
  (only the 7 decisive ones in §3 were); their expectations follow the same
  arm structure and the same vendored inventory hashes.
* **INFERRED** — the reference's arm choice for the AM/PM envelope (§5.2) is
  observationally identical, not observed (the dead cloud cannot be replayed).
* **UNKNOWN** — whether root accepts the retained refusal as the correct N-03
  outcome; this worker reports the measured behaviour and recommends against
  narrowing (`time_gate_narrowed=false`) rather than claiming a completion it
  could not certify.
