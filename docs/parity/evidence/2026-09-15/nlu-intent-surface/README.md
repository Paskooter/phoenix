# Where Jibo's intents actually lived

Reference tree: `5c0a7390539663ba749d360de348a428c088505c`

## The question

Phoenix's LLM NLU fallback shipped a hand-written 15-tool catalog. The owner
asked whether it "can be expanded to meet full coverage compared to what
Dialogflow originally did". Answering that first required establishing what
full coverage *is*, because two earlier assumptions were both wrong.

## What was wrong

**The hand-written 15 are mostly invented.** Only five of the fifteen names
exist anywhere in the reference tree:

| in the catalog | real Jibo intent |
| --- | --- |
| `whatsUp`, `thanks`, `cancel`, `yes`, `no` | same — these five are real |
| `whatTimeIsIt` | `askForTime` |
| `whoAmI` | `launchWhoAmI` |
| `goodbye` | `goodBye` |
| `tellAJoke` | three intents: `jokeKnockKnock`, `jokeChickenCrossRoad`, `jokeDentistTime` |
| `tellMeAboutYourself` | `requestTellAboutYourself` |
| `doYouLike` | `doesJiboLikeThing` |
| `tellMeATip` | the `friendly-tips` rule set |
| `launchSkill` | no such intent; skills are launched by their own intents |
| `chitchat` | a whole rule set (438 intents), not an intent |

A router that emits `whatTimeIsIt` has not recognised anything: no Jibo handler
answers to that name. So the catalog's apparent hit rate was never a hit rate.

**Dialogflow is not the whole surface either.** An earlier attempt regenerated
the catalog from `packages/parser/dialogflow/main_agent` (99 intents) and
measured *worse* than the hand-written 15. The reason is structural, not a
tuning problem: the Dialogflow agent is the ML backstop for the open-domain
chitchat space only. Its 99 intents contain no timer, alarm, clock, light,
radio, camera, gallery or settings intent, because none of those ever went
through Dialogflow.

## What the surface actually is

Two cooperating parsers:

| source | intents | what it covers |
| --- | --- | --- |
| `packages/parser/robust-parser/rules_src/` | 611 over 21 rule sets | everything, including every utility |
| `packages/parser/dialogflow/main_agent/` | 99 | chitchat only; 74 overlap the rules, 25 are Dialogflow-only |

Union: **631 distinct intents**.

The utilities the earlier evaluation reported as missing are all present in the
rules, under their real names:

```
askForTime askForDate timerValue alarmValue       clock
volumeUp volumeDown volumeToValue stop help ...   globals
lightsOn lightsOff lightsWarm lightsDown ...      hue-control
get_track stations showStations play              radio
createOnePhoto createSomePhotos createVideo       create
requestCommute requestCalendar requestNews        report
launchWhoAmI                                      who-am-i
goodBye goodMorning heyJibo hello                 greetings
galleryOpen                                       gallery
battery wifiStatus storageStatus updates          settings
```

## How the runtime scoped them

Intents were never all live at once.

* `rules_src/globals/` — 21 intents, always available (stop, help, volume,
  mainMenu, repeat, selectItem).
* `rules_src/<domain>/launch.rule` — the grammar that routes *into* a skill from
  idle. The runtime compiles the union of all twenty of these into a single
  `rules_fst/launch.fst` (42 MB, 811,778 states), which is what Jibo could hear
  with nothing running: **531 intents — 93 utility plus 438 chitchat**.
* The rest of a domain's rule set loads only while that skill is running, which
  is why `clock/` can define a bare `yes`, `no`, `change` and `keep`.

The rules also carry a priority tier (`HIGH` / `LOW` / `STRICT`), and inside
chitchat the file splits itself into a general-question-answer domain (the
low-priority catch-all that routes to general QA) and a scripted-response domain
(high priority). Utility beats chitchat; chitchat falls back to general QA.

## What this implies for the catalog

A flat 631-tool prompt is neither faithful nor good practice. The catalog is
generated with the scoping metadata the runtime used — `scope`
(global / skill / chitchat), `domains`, `emits`, and `launch` — so the router
can assemble the same working sets the original did, and the cascade can mirror
the original's priority order.

Slots come from the rules too, scoped to the semantic-action cluster that
carries the intent, so they stay attached to the right one:

```
askForTime      country, state, city, day_of_week
timerValue      hours, minutes, seconds
set (alarm)     time, ampm
volumeToValue   volumeLevel
lightsColorGroup group, color
selectItem      itemType, itemPosition
```

228 of 622 tools carry at least one real slot; 608 carry at least one example
utterance, taken verbatim from Dialogflow training phrases where the intent has
them and rendered from the rule grammar otherwise.

## Reproducing

```
node scripts/parity-nlu-catalog/build.mjs --report   # the surface, no write
node scripts/parity-nlu-catalog/build.mjs            # regenerate the catalog
node scripts/parity-nlu-catalog/evaluate.mjs         # measure the arms
```

## Measurement

See `measurement.md`.
