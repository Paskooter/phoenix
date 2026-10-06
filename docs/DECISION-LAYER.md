# NLU decision layer

Jibo's grammar understands the phrasings it was written for. Anything else
misses, comes back as a LOW parse, or lands in a catch-all question rule. So
"what's today's date" gets the date while "what day is it today" goes to the
knowledge search, and "turn it up" closes the screen. The original cloud asked
Dialogflow after a non-HIGH parse; that service is gone.

The decision layer reviews the grammar's parse of a global turn ("Hey Jibo, …")
with a fast typed decision model, and collapses other ways of saying a command
onto the command itself. Questions about the world still go to the knowledge
search, and chitchat stays chitchat. On a robot with Home Assistant, a request
to control or check something in the home goes to Home Assistant
([smart home](#smart-home)).

## Status of the intent layers

| Layer | State | Notes |
|---|---|---|
| Grammar (robust-parser rules) | **On**, always | Decides every turn on its own unless the decision layer is enabled. |
| Decision layer (Jev) | **Built, off by default** | Enable with the settings below. Evaluated: 76.2% → 97.2% (dev) and 77.4% → 100% (held out), nothing broken; with Home Assistant, 44 of 44 smart-home requests reach it. |
| Laya | Off | Failed its held-out evaluation: 12% recall, 50% precision ([LAYA-INTENT.md](LAYA-INTENT.md)). |
| LLM intent fallback | Off | The client can be configured, but the parser's HTTP route only reaches it through `ETCO_parser_layaSecondaryFallback=llm`. Its default catalog is the restoration's 15 generic intents (`PHOENIX_LLM_CATALOG` selects a source-derived one). |
| OpenAI Decisions API | Not used | Announced as a preview; no official reference was available to evaluate against. |

## How it works

The layer asks one question of the engine: which of a short list of options the
person wants (`DECISION_COMMANDS` in `packages/nlu/src/decisionLayer.js`). Each
command names a canonical phrase, and a chosen command is answered with the
grammar's own parse of that phrase. A paraphrase therefore reaches its skill
exactly as the phrase the grammar was written for does: no intent, entity or
skill is invented.

| The grammar's parse | What happens |
|---|---|
| Not a global turn (a skill waiting for its own answer) | Nothing. |
| A command on the list, or a question about a named person | Nothing. |
| A miss, a non-HIGH parse, or a catch-all question rule | **Review:** a command or a knowledge question at `minProbability` (0.5) or above replaces it. |
| Any other HIGH parse (chitchat, a screen command, a misheard fragment) | **Second opinion:** only a command at `overrideProbability` (0.9) or above replaces it. |

The options are: time, date, weather today, weather tomorrow, news, personal
report, calendar, commute, take a photo, open the gallery, who am I, what can
you do, play a game, dance, sing, joke, fun fact, volume up, volume down, plus
smart home, knowledge question, chitchat and none. Chitchat, none, a low
probability, a timeout or an error keeps the grammar's parse, so the worst case
is the behaviour without the layer.

## Smart home

The grammar has no rule for most home requests. "Turn on the basement AC" was a
miss, "turn off the basement AC" parsed as how to turn Jibo off, and "start the
vacuum" as the screen command "beginning"; only "ask Home Assistant to…" reached
Home Assistant. The "none" option also listed smart-home control as something
Jibo cannot do.

The gateway now marks a turn as a home turn (`home: true` on the parse request)
when the robot is paired with Home Assistant locally or its owner linked the
cloud connector, and the turn is one Home Assistant may take (not a native
command such as time or volume, and not an answer inside an active skill). On a
home turn:

| What happens | |
|---|---|
| The engine chooses `smart_home` | At the same thresholds as a command, the parse becomes `phoenixHomeCommand`, and the gateway hands the person's own words to Home Assistant, whose agent resolves the device. A question takes the read-only state-query route. |
| A Hue light rule | Not asked about: the gateway sends it to Home Assistant, and the Hue skill never takes a turn from a robot with Home Assistant. |
| The grammar's thermostat rule | Reviewed rather than second-guessed, since it also takes "how does a thermostat work"; if the engine keeps it, Home Assistant gets it. |

Without the mark, `smart_home` keeps the grammar's parse, exactly like "none",
so robots without Home Assistant behave as before. The gateway also sends common
devices ("turn off the basement AC", "turn the bedroom fan off") straight to
Home Assistant before any parse, so they work with the layer off. A delay, a
clock time or a sequence ("in eleven minutes", "at seven pm", "tomorrow", "then")
is never sent, including through explicit invocation, because Home Assistant
would act at once. Jibo's own light and fan remain native requests; TV-show and
movie playback requests do not qualify as home-device control. Explicit state
questions also require the connector's read-only query capability. See
[Home Assistant routing](HOME-ASSISTANT.md#routing-and-voice-behavior).

Directly paired robots apply their native wake gate and sentence rules before
dispatch. Their firmware must include the expanded device vocabulary and
Phoenix-classification fallback. The fallback accepts only a Home Assistant
match for the exact transcript of an already admitted native turn, and repeats
the native command, delay and capability checks. A cloud route hint cannot
create or extend a wake.

The engine is [Jev](https://openrouter.ai/blog/insights/what-is-jev/), TypeSafe's
typed decision model, called through OpenRouter's decisions endpoint
(`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`). It
returns one of the listed options with calibrated probabilities and cannot
answer outside the list.

## Evaluation

`packages/nlu/test/fixtures/decision-eval-cases.txt` holds 265 invented
utterances: paraphrases of every command, 36 knowledge questions, 36 chitchat
lines, 19 requests Jibo cannot do and 44 smart-home requests. They include
traps: "what time zone is Tokyo in" is knowledge, "do you like the weather" is
chitchat, "how does a thermostat work" is knowledge and "buy a smart plug" is
shopping. Every third case of each label is held out. Routing counts as correct
when the hub would launch the right command; for chitchat and "none", when it
launches neither a command nor a home command. Without Home Assistant a
smart-home request only needs not to launch a command; with `--home` it must
reach Home Assistant through the gateway's own route.

| Split | Grammar alone | With the layer | Fixed | Broken | Latency p50 / p90 / max |
|---|---|---|---|---|---|
| Dev (181) | 76.2% | 97.2% | 38 | 0 | 176 / 274 / 402 ms |
| Held out (84) | 77.4% | 100% | 19 | 0 | 204 / 308 / 770 ms |
| Dev, with Home Assistant | 67.4% | 98.3% | 56 | 0 | 185 / 298 / 514 ms |
| Held out, with Home Assistant | 69.0% | 100% | 26 | 0 | 193 / 358 / 483 ms |

With Home Assistant, all 44 smart-home requests reached it (21 without the
layer, through the gateway's direct device phrases and the thermostat rule);
before this change 11 did, with or without the layer, and 86.0% of all cases
routed correctly. The 2026-10-06 continuation excludes TV-show playback from
home routing and corrects explicit-query and delayed-request checks. Its live
home evaluation routed 262/265 cases correctly (98.9%), including 44/44 home
requests, with no newly wrong commands. The remaining dev misses are knowledge
questions the grammar places elsewhere ("what time zone is Tokyo in"). The
non-home rows above retain the earlier evaluation results.

DeepSeek v4.1 Flash, asked the same question as a chat model with reasoning off,
made the same choices but answered in p90 533–854 ms with spikes past 4 s, and
gives no probability to gate the second-opinion overrides with. Jev cost about
$0.00004 per decision (886 input tokens; output is free). Reproduce with:

```bash
ETCO_parser_decisionEngine=jev ETCO_parser_decisionApiKey=<openrouter key> \
  node scripts/decision-layer-eval.mjs --split dev --show [--home]
```

Change the option wording, the list or the thresholds against the dev split
only, then run the held-out split once.

## Configuration

| Setting | Default | |
|---|---|---|
| `ETCO_parser_decisionEngine` | off | `jev` turns the layer on (with a key). |
| `ETCO_parser_decisionApiKey` | `OPENROUTER_API_KEY` | An OpenRouter key. |
| `ETCO_parser_decisionUrl` | OpenRouter's decisions endpoint | |
| `ETCO_parser_decisionModel` | `typesafe/jev-1.13` | Pinned; re-evaluate before changing. |
| `ETCO_parser_decisionTimeoutMs` | 800 | A slower answer keeps the grammar's parse. |
| `ETCO_parser_decisionMinProbability` | 0.5 | For reviewed parses. |
| `ETCO_parser_decisionOverrideProbability` | 0.9 | For second opinions on a HIGH parse. |

The parser reports `decisionClient: READY` or `DISABLED` on `GET /state`. Each
change is logged by `nlu.decision` with the intents, choice, probability and
time; the utterance itself is never logged. Turning the layer off is unsetting
`ETCO_parser_decisionEngine` and restarting the parser.

## Privacy

With the layer on, the text of each reviewed turn (not audio, and no account,
robot or person identifier) is sent to OpenRouter and TypeSafe. In the
evaluation set 65–74% of turns were reviewed; the share in real use depends on
how people talk to Jibo. A public server's privacy policy must say so before
the layer is turned on.

## Adding a command

Add an entry to `DECISION_COMMANDS` with a canonical phrase that the grammar
parses at HIGH, the intent that parse produces, and a one-line description;
the tests check the phrase still parses that way. Add paraphrases to the case
set, then evaluate dev and held-out, with and without `--home`, as above.
