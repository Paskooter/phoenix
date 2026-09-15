# Measuring the intent catalogs

`node scripts/parity-nlu-catalog/evaluate.mjs`, model
`deepseek/deepseek-v4.1-flash`, 40 labelled utterances. Raw per-utterance
output in `scripts/parity-nlu-catalog/results.json`.

## The bar

Not "did the classifier pick something" but "did it emit a name a Jibo handler
answers to". By that bar a catalog of invented names scores near zero no matter
how confident it looks.

## Labels carry their context

The same words resolve to different intents depending on what is loaded. From
idle, with no skill running:

* "set a timer for five minutes" is the clock skill's `start`, not `timerValue`
  — `timerValue` lives in `clock/timer_set_value.rule`, which loads only once
  clock is running.
* "go to the main menu" is `launchMainMenu`, not the globals `mainMenu`.
* "record a video" is chitchat's `requestRecordVideo`, not the create skill's
  `createVideo`.
* "what song is this" should match nothing: `get_track` is in-skill only.

An earlier version of this measurement labelled the in-skill intent and so
scored every arm against an answer none of them could correctly give. Where two
intents are genuinely both live at idle — globals and chitchat each define a
form of thanks, repeat and weather — the label accepts either, because which one
wins is the rule engine's priority arbitration rather than a fact about the
utterance.

## Arms

| arm | what it offers the model |
| --- | --- |
| `grammar` | Phoenix's existing rule engine, offline, no model call |
| `hand15` | the 15-tool catalog Phoenix shipped |
| `flat` | all 551 idle-reachable intents in one call (~140 KB) |
| `tiered` | 94 utility/global tools first (~16 KB), falling through to 458 chitchat tools |

`tiered` mirrors the runtime's own cascade: the rules resolve device and skill
commands at HIGH priority and leave the open-domain remainder to the
low-priority stage, which is the job Dialogflow's ML did behind the rules.

## Result

| arm | correct |
| --- | --- |
| grammar | 33/40 |
| hand15 | **3/40** |
| flat | **39/40** |
| tiered | **39/40** |

`hand15` scores 3 because ten of its fifteen names are invented. It answers
"what time is it" with `whatTimeIsIt`, "who am i" with `whoAmI`, "tell me a
knock knock joke" with `tellAJoke` — none of which exist. Its remaining failures
are silent: `unknown` for lights, volume, commute, calendar, news, battery,
wifi, weather, stories and songs, because no tool for any of them exists to be
chosen.

`tiered` matches `flat` at a ninth of the first-stage payload, and only pays for
the large chitchat catalog when the utility stage defers. Its single miss is
"do you like pizza" (deferred correctly, then `unknown` from the chitchat
stage); `flat`'s single miss is "who am i" → `describeUser`.

## Two defects in the measurement itself

Both found and fixed before these numbers were reported.

1. **Wrong dialog context in the labels**, as above. It made the rule engine
   look wrong for being right.
2. **The idle filter silently dropped globals.** `tool.launch` alone excludes
   `volumeUp`, `volumeDown`, `volumeToValue`, `thanks`, `repeat`, `sleep` and
   `mainMenu`, because `globals/` has no `launch.rule` — it is never launched
   into, it is simply always loaded. Every arm was scored without them. The
   idle set is `launch ∪ globals`.

## What this does and does not license

It licenses replacing the restored 15-tool catalog: it is not Jibo's, and it
cannot name most of what Jibo could do.

It does not license claiming the LLM is the answer. The grammar scores 33/40
offline, for free, and runs first; the LLM only ever sees what the grammar
misses. The catalog matters for that residue.

The measurement is 40 utterances against one model. It separates a catalog that
can name Jibo's intents from one that cannot — a 36-point gap — but it is not a
precision instrument, and nothing here is a claim about accuracy in the field.
