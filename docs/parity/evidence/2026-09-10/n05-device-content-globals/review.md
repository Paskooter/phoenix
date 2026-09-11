# N-05 — Verify remaining device/content rules and global commands

Evidence date: 2026-09-11 · worktree `.parity/worktrees/w11-n05` (branch `w11/n05`)
Base revision: `b541630` · Node `v22.22.0` (linux) · profile: default AST
(`PHOENIX_NLU_*` unset).

Every claim is **VERIFIED** (observed in a command output in this evidence set),
**INFERRED** (reasoned from pinned source, not observed) or **UNKNOWN**.

---

## 1. Specification actually used

Re-derived from the `N-05` row of `docs/parity/tasks.json` (read, **not** modified):

1. *Use the rule inventory to cover all remaining named rules and explicit global
   stop/repeat/thanks/navigation behavior.*
2. *Exercise global interruption and local-rule precedence without false launches
   or over-triggering; no named rule is left without a fixture.*

Pinned reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`,
`packages/parser/robust-parser/rules_src` (the same revision pinned by
`packages/nlu/resources/rule-inventory.json`).

The four global graphs were re-fetched through the Jibo archive MCP
(`gitea_read_file repo=jiboV2/pegasus ref=5c0a739…`). After the tool's one-line
provenance header (`# jiboV2/pegasus:…@5c0a739…`) is removed, each archived body
is **line-for-line identical** to the vendored
`packages/nlu/resources/rules-src/globals/*.rule` (**VERIFIED**):

| rule | archive == local | local sha256 |
|---|---|---|
| `globals/global_commands_launch` | yes (301 lines) | `28578c35b0d0dce4cc6b7ff064c4761197a6e7199148f90e497cb21e388989c0` |
| `globals/gui_nav` | yes (108 lines) | `869d7a9a58a2fe0470660d330901b4990a78d3fb6e2aecf70a1ba7681952771d` |
| `globals/mim_repeat` | yes (17 lines) | `e8014239148fce111744728b0505dd9d9d997abc2017b70d7b0d599329a85492` |
| `globals/mim_thanks` | yes (21 lines) | `ffe9872730b73573a68e62b803c44d85b0293b0f3ad0110794e71a03e14b7bd9` |

The `yes_no` factory graph the device/content rules depend on is
`packages/nlu/resources/factory/yes_no.grm`
(sha256 `d3020d043f3a9b34af8ce74df5622d4031249569f548f4b871a566ff469ff5e4`); its
`TopRule = ($YESNO) {_nl=YESNO._yes_no}{%delete this.YESNO%}` and internal
`YES`/`NO` rules (lines 1, 7–47) are the contract exercised here.

## 2. The contract for the global commands (from pinned source)

`global_commands_launch.rule` is `{domain='global_commands'}{priority='HIGH'}` over
eight intents (**VERIFIED** against the source above):

| intent | source line | fixture |
|---|---|---|
| `stop` | :95-112 | `stop it` |
| `sleep` | :115-123 | `go to sleep` |
| `overHere` | :135-170 | `look over here` |
| `turnAway` | :173-179 | `turn away` |
| `turnAround` | :181-183 | `turn around` |
| `volumeUp` | :229-241 | `turn the volume up` → `volumeLevel:"null"` |
| `volumeDown` | :250-259 | `turn the volume down` → `volumeLevel:"null"` |
| `volumeToValue` | :262-267 | `set the volume to five` → `volumeLevel:"05"` |

`gui_nav.rule` (`{domain='gui_command'}{priority='HIGH'}`) → `left`/`right`/
`beginning`/`end`/`close`/`selectItem` (`{itemPosition=…}`); `mim_repeat.rule` →
`repeat`; `mim_thanks.rule` → `thanks`. All are matched today through the real
NLU request path (**VERIFIED**, `runtime-replay.json`).

## 3. Gaps found and closed

### G1 — factory-internal sub-rule names were shadowed by the requesting rule

The reference compiler emits every `$factory:NAME` as a **self-contained** FST;
its internal rule names are invisible outside it. Phoenix matches factory
grammars as ASTs sharing one merged rule map
(`requestParser.js` `Object.assign({}, state.factoryRules, entry.ast.rules)`),
so a public rule declaring a sub-rule with the same name as a factory-internal
rule silently replaced the factory's own definition.

**VERIFIED** collision: `yes_no.grm` declares `YES`/`NO`, and **15** vendored
public rules declare their own `YES`/`NO` while also calling `$factory:yes_no`
(`create/take_another_photo`, `friendly-tips/want_more_tdd`, `shared/no_id`,
`shared/verify_id`, `settings/shut_down_confirmation`, `greetings/day_quality`,
`who-am-i/confirm`, …). The factory's `YES_BASIC = yes | yeah | sure | yep | yup | ya`
was replaced by the requesting rule's local `YES`, so the literal words
`yes`/`no` no-matched even though `definitely` (a local arm) still did:

```
before:  yes  rules=[create/take_another_photo] -> {intent:null, entities:null, rules:[]}
after :  yes  rules=[create/take_another_photo] -> {intent:"yes", rules:["create/take_another_photo"]}
```

Fix: `compileRuleTree(node, rules)` (new export, `grammar/matcher.js:129-138`)
binds a graph's non-prefixed references to that graph's **own** rule map;
`requestParser.js:86-92` pre-compiles each factory top against its own
`ast.rules`, and the factory hook returns the bound top
(`requestParser.js:232-235`). This reproduces the reference's graph isolation
without changing the public rule's own namespace.

### G2 — conditional `{% if … %}` semantic actions were silently dropped

`parseActionBlock` (`grammar/parser.js:238`) splits an action body on `;` and
only understood `key='lit'` / `key=this._parsed` / `key=Sub._field`. A whole-block
control-flow action therefore matched nothing and was skipped. The pinned rules
use exactly one such form — `if (this._intent == 'a') {this._intent = 'b'} else if …`
— in **five** rules (**VERIFIED** by scanning every `{% … %}` body):

| rule | source | mapping |
|---|---|---|
| `clock/alarm_timer_change` | :12-18 | yes→`delete`, no→`keep` |
| `clock/alarm_timer_other_set` | :12-18 | yes→`replace`, no→`keep` |
| `word-of-the-day/right_word` | :19-24 | yes→`agreement`, no→`disagreement` |
| `greetings/proactive_general_question` | :26-31 | yes→`good`, no→`bad` |
| `greetings/proactive_playful_question` | :26-31 | yes→`good`, no→`bad` |

Before: the raw factory value (`yes`/`no`) leaked to the caller. After:
`clock/alarm_timer_change` `yes`→`delete`, `no`→`keep`;
`word-of-the-day/right_word` `yes`→`agreement`, `no`→`disagreement`.
Fix: `parseActionBlock` emits a `cond` tag per arm (`parser.js:243-252`);
`applyTags` evaluates it against the node's private/public fields after the
plain assignments (`matcher.js:183-189`). Purely additive — no pre-existing tag
had `kind: 'cond'`.

## 4. What was already correct

The 98 public graphs already load and the four global graphs already route
correctly when requested (`parseRequest({text:'stop it', rules:['globals/global_commands_launch']})`
→ `stop`). The 42-case original multi-rule capture (global-vs-launch and
global-vs-clock pairs) already replays 42/42; those cases are reused here as the
native anchors for interruption/precedence (§6).

## 5. Fixtures — every named rule, plus explicit globals

`packages/nlu/test/fixtures/device-content-globals.json` (**VERIFIED**):

* `namedRules` — **98** rows, exactly the 98 names in
  `rule-inventory.json.publicRules` (set-equality asserted). 57 are the
  N-05-owned "remaining device/content" graphs; 41 are cross-track smoke rows
  for the N-03/N-04 subsets so no named rule is left unfixtured. Each row has a
  positive fixture; a negative fixture where one can exist, otherwise a
  `negativeUnavailable` reason grounded in the source (7 rules carry an
  intentional `$ANYTHING`/`+$w`/wildcard catch-all arm).
* `globals` — 14 explicit rows covering every global intent in §2.
* `globalNegatives` — 5 non-command utterances that must not match a global.
* `interruption` / `overTriggers` — §6.
* 2 rules (`clock/alarm_set_value`, `clock/alarm_timer_ampm`) have an unsupported
  factory dependency (`time`) and are fixtured as a **loud refusal**, never a
  silent no-match.

## 6. Runtime proof

`packages/nlu/tools/replayDeviceContentHttp.mjs` drives **every** fixture through
both `parseRequest()` and a live `POST /v1/parse` service on an ephemeral port.
Artifact `runtime-replay.json` (**VERIFIED**):

```
profile                : ast
reference revision     : 5c0a7390539663ba749d360de348a428c088505c
fixture                : df6a40ca1b8a08f981452af95097307b97891e9f8d4aff83feab3e613576036a
named-rule coverage    : 98
cases                  : 219
direct parseRequest    : 219/219
live HTTP /v1/parse    : 219/219
direct differences     : none
http differences       : none
```

The 2 unsupported rules return HTTP 500 over the live service and are asserted as
the documented refusal. Focused tests: `packages/nlu/test/deviceContentGlobals.test.js`
(8 tests).

Interruption/precedence rows are anchored to the **native capture** of the same
revision (the pinned 42-case suite):

| journey | rules | text | winner | native anchor |
|---|---|---|---|---|
| global interrupts launch | `launch, globals/global_commands_launch` | `stop it` | `globals/global_commands_launch` `stop` | n08:005 |
| global interrupts launch | `launch, globals/global_commands_launch` | `cancel` | `globals/global_commands_launch` `stop` | n08:004 |
| global interrupts a skill | `clock/timer_set_value, globals/gui_nav, globals/mim_repeat, globals/global_commands_launch` | `repeat that` | `globals/mim_repeat` `repeat` | n08:019 |
| global interrupts a skill | `clock/alarm_timer_okay, …globals…` | `thanks` | `globals/mim_thanks` `thanks` | n08:028 |
| local precedence | `launch, globals/global_commands_launch` | `what time is it` | `launch` `askForTime` | n08:006 |
| local precedence | `launch, globals/global_commands_launch` | `repeat that` | `launch` `requestRepeat` | n08:012 |
| local precedence | `launch, globals/global_commands_launch` | `thanks` | `launch` `thankJiboForAction` | n08:013 |
| local precedence | `clock/timer_set_value, clock/alarm_timer_okay, globals/global_commands_launch` | `cancel` | `clock/timer_set_value` `cancel` | n08:033 |

Over-trigger guards (no false launches): `what year is it` (`launch` wins, the
global `$w03 X $w03` arm must not fire), `go back` (no winner at all — native
n08:011), and `hello`/`check the weather` against the global graphs alone.

## 7. Falsification (required, concrete)

Two independent breaks, each on ONE full code line, each restored afterwards.

**Break A — conditional semantic action** (`packages/nlu/src/grammar/matcher.js:188`):

```js
-      if (String(condTarget[tag.key]) === tag.when) condTarget[tag.key] = tag.then;
+      if (String(condTarget[tag.key]) !== tag.when) condTarget[tag.key] = tag.then;
```

`node --test packages/nlu/test/deviceContentGlobals.test.js` →

```
not ok 2 - N-05 every device/content and global fixture matches at runtime through parseRequest
not ok 8 - N-05 conditional {% if %} semantic actions remap the private intent field
# tests 8   # pass 6   # fail 2
```

**Break B — factory namespace isolation** (`packages/nlu/src/requestParser.js:234`):

```js
-      return factory ? factory.compiledTop : null;
+      return factory ? factory.top : null;
```

→

```
not ok 2 - N-05 every device/content and global fixture matches at runtime through parseRequest
not ok 7 - N-05 factory-internal sub-rule names cannot be shadowed by the requesting rule
# tests 8   # pass 6   # fail 2
```

Both lines restored (matcher.js:188 reads `…=== tag.when…`; requestParser.js:234
reads `…factory.compiledTop : null`); the restored file passes:

```
# tests 8   # pass 8   # fail 0   # cancelled 0
```

## 8. Full test run and parity gate

One full `npm test` at the committed revision with a clean environment
(`PHOENIX_NLU_*` unset), exit status **0**:

```
# tests 1744   # suites 7
# pass 1737     # fail 0
# cancelled 0    # skipped 7   # todo 0
Checklist: 49/79 verified (62.0%)
Tracker structure, dependencies, evidence links and generated checklist are valid.
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

`cancelled 0` confirms no concurrent-run corruption; the 7 skipped are the
artifact-gated compiled profiles.

## 9. Divergence candidates (reported, not written to DIVERGENCES.md)

* **D-N05b — `digit`/`year`-style tag composition (N-02's N02a) still affects
  device/content rules that consume those factories.** No N-05 fixture depends on
  it; not re-tested here.
* **D-N05c — AST-vs-compiled profile differences from N-01 (D1/D2).** The N-05
  fixtures ran on the default AST profile; `clock/alarm_set_value` and
  `clock/alarm_timer_ampm` are unsupported only in AST. The compiled profile was
  not exercised here (its 42 MB artifact is not present in this worktree).

## 10. Limits and unknowns

* **UNKNOWN** — the 42-case native capture does not carry a global-command
  positive for every intent, so `overHere`/`turnAway`/`turnAround`/`volume*`/`sleep`
  have a source-derived contract but no native HTTP capture to compare against;
  their fixtures assert the source-declared intent, not a recorded native body.
* **INFERRED** — expected `entities` for non-native tags were taken from the
  rules' own `{tag}` declarations; the test cross-checks that every expected
  entity key is declared by the rule source (only the native
  `union_original_fst_name` is exempt), and every conditional remap target is
  declared by the source's own `{% if %}` block.
* **UNKNOWN** — whether the AST or compiled profile is deployed on Moth; the two
  fixes apply to the AST matcher only (the compiled path serves whole FSTs and is
  unaffected).
