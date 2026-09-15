# Global commands did not reach the robot

Date: 2026-09-15
Reference: `5c0a7390539663ba749d360de348a428c088505c`

## Symptom

"turn up the volume" resolved to the settings skill's `volumeQuery`. "stop" and
"go to sleep" resolved to nothing. Neither was a scoring problem.

## Cause 1 — the gateway asked for a rule that does not exist

`launch` is the union of the twenty domain `launch.rule` grammars. The
global-command grammars are **not** in that union; the parser exposes them as
four separate public rules:

```
globals/global_commands_launch   volume, stop, sleep, help, main menu, turn around
globals/gui_nav                  go back, next, previous, select an item, close
globals/mim_repeat               say that again
globals/mim_thanks               thank you
```

The gateway's global-turn default asked for `['launch', 'global']`. There is no
rule named `global` — not in `packages/nlu/resources/rule-inventory.json`, not
in the reference server, not in the robot firmware. `requestedEntries` filters
requested names down to ones the registry knows, so it was dropped in silence
and the global-command grammars were never consulted.

The correct names are the robot's own. `be-12.0.0`
`jibo/src/bt/behaviors/Mim.ts:210-212` declares them, and `Mim.ts:1242-1252`
appends them to the MIM config's `ruleNames` on every turn:

```ts
const rules = mimConfig.ruleNames.slice();
rules.push(GUI_RULE);                                       // globals/gui_nav
if (this.entryPrompt.text) rules.push(REPEAT_RULE);          // globals/mim_repeat
if (mimConfig.thanksHandling !== ThanksOptions.IGNORE) rules.push(THANKS_RULE);
```

Those three are confirmed robot-sent. `globals/global_commands_launch` is a
public rule the parser exposes, but no recovered artifact shows the robot
requesting it: it would come from a top-level MIM config, and no `.mim` files
survive in the captured firmware. It is included because a global turn is
precisely the no-skill-running case those commands exist for. **Confirming it
against Moth is an outstanding check.**

## Cause 2 — the grammar stage never matched the globals TopRules

`fullGrammar.load()` merged the globals grammars as helper sub-rules but did not
load their TopRules as matchable grammars, with this note:

> their HIGH-priority `$w03 X $w03` arms over-trigger without the reference's
> strict-arm weighting, regressing e.g. "what year is it". Tuning + loading them
> is a follow-up iteration.

Re-measured: loading them scores 37/41 against 34/41 on a 41-utterance set, and
"what year is it" does not regress. A global command now carries its `domain`
and is deliberately **not** given a fabricated `@be/<id>` skill entity, because
it is a hub command rather than a skill launch.

## Why adding them is safe

The original arbitration already makes them lose ties.
`RobustParserClient.ts:19`:

```ts
const LOW_PRIORITY_RULES = /^launch$|^globals\//;
```

and `getBestResult` drops those from a tied top score whenever any other rule
tied. Phoenix ports this in `packages/nlu/src/arbitration.js`. So "thank you"
still resolves to chitchat's `thankJiboForAction` rather than the globals
`thanks`, and every launch-only parse is unchanged.

## Verification against the original parser

The recovered 2.8.3 package ships the original `parse` executable and the
reference tree ships the compiled FSTs it reads, so the question could be put to
Jibo's own parser rather than to a reimplementation's judgement.

```
node scripts/parity-nlu-oracle/capture.mjs --write   # re-capture
node scripts/parity-nlu-oracle/capture.mjs           # diff
```

| rule list | agreement with jibo-nlu 2.8.3 |
| --- | --- |
| `['launch', 'global']` (before) | 29/49 |
| `['launch', 'globals/*']` (after) | **49/49** |

The twenty disagreements under the old list were not only volume:

```
volume up / volume down / louder / quieter / too loud / too soft
set the volume to five / stop / go to sleep
turn around / look over here
go back / next / previous / the first one / the second one / close that
```

Every GUI navigation command was dead, and so was every way of telling Jibo to
stop.

## The oracle also corrected this project

Four labels in the earlier catalog measurement were wrong, and the original
settles them:

| utterance | real jibo-nlu | what had been assumed |
| --- | --- | --- |
| what's the date today | `generalWhatQuestions` | `askForDate` |
| what stations do you have | `generalWhatQuestions` | `showStations` |
| what song is this | `generalWhatQuestions` | no match |
| turn it down a bit | **no parse at all** | `volumeDown` |

Phoenix already matched the original on all four, so three of the seven
"grammar misses" reported in that measurement were not misses.

## What the cloud does and does not do

Nothing in the reference server handles `volumeUp`: global commands are
robot-local actions. The cloud's obligation is to return the correct intent, and
the final LISTEN already carries the NLU result alongside a null match
(`listenTransaction.js:621`), so the robot receives `volumeUp` and acts on it.

## Tests

* `packages/gateway/test/globalTurnRules.test.js` — every global-turn rule is a
  rule the parser exposes; the globals are not already inside the launch union;
  the commands reach their own intents; adding them does not let them win ties
  they should lose.
* `packages/nlu/test/oracleGlobalsDifferential.test.js` — replays the committed
  oracle capture, and asserts the capture is not vacuous (it must carry
  `global_commands` rows, `gui_command` rows and real no-matches).
* `packages/nlu/test/grammarProvenance.test.js` — every launch and global
  grammar is loaded; a global command parses through the real HTTP service and
  carries no skill entity.

Falsification: restoring `['launch', 'global']` fails `globalTurnRules` with
"global is not a public rule; it would be silently dropped" and "turn up the
volume -> volumeUp", and drops the oracle differential to 29/49.

Full suite at the time of writing: 2361 tests, 2352 pass, 0 fail, 9 skipped.
