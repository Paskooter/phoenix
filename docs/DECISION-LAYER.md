# NLU decision layer

Jibo's grammar understands the phrasings it was written for. Anything else
misses, comes back as a LOW parse, or lands in a catch-all question rule. So
"what's today's date" gets the date while "what day is it today" goes to the
knowledge search, and "turn it up" closes the screen. The original cloud asked
Dialogflow after a non-HIGH parse; that service is gone.

The decision layer reviews the grammar's parse of a global turn ("Hey Jibo, …")
with a fast typed decision model, and collapses other ways of saying a command
onto the command itself. Questions about the world still go to the knowledge
search, and chitchat stays chitchat.

## Status of the intent layers

| Layer | State | Notes |
|---|---|---|
| Grammar (robust-parser rules) | **On**, always | Decides every turn on its own unless the decision layer is enabled. |
| Decision layer (Jev) | **Built, off by default** | Enable with the settings below. Evaluated: 72.8% → 97.8% (dev) and 70.8% → 100% (held out), nothing broken. |
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
knowledge question, chitchat and none. Chitchat, none, a low probability, a
timeout or an error keeps the grammar's parse, so the worst case is the
behaviour without the layer.

The engine is [Jev](https://openrouter.ai/blog/insights/what-is-jev/), TypeSafe's
typed decision model, called through OpenRouter's decisions endpoint
(`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`). It
returns one of the listed options with calibrated probabilities and cannot
answer outside the list.

## Evaluation

`packages/nlu/test/fixtures/decision-eval-cases.txt` holds 201 invented
utterances: paraphrases of every command, 30 knowledge questions, 30 chitchat
lines and 15 requests Jibo cannot do. They include traps: "what time zone is
Tokyo in" is knowledge, "do you like the weather" is chitchat. Every third case
of each label is held out. Routing counts as correct when the hub would launch
the right command; for chitchat and "none", when it does not launch a command.

| Split | Grammar alone | With the layer | Fixed | Broken | Latency p50 / p90 / max |
|---|---|---|---|---|---|
| Dev (136) | 72.8% | 97.8% | 34 | 0 | 217 / 350 / 557 ms |
| Held out (65) | 70.8% | 100% | 19 | 0 | 191 / 304 / 447 ms |

DeepSeek v4.1 Flash, asked the same question as a chat model with reasoning off,
made the same choices but answered in p90 533–854 ms with spikes past 4 s, and
gives no probability to gate the second-opinion overrides with. Jev cost about
$0.00004 per decision (886 input tokens; output is free). Reproduce with:

```bash
ETCO_parser_decisionEngine=jev ETCO_parser_decisionApiKey=<openrouter key> \
  node scripts/decision-layer-eval.mjs --split dev --show
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
evaluation set 60–66% of turns were reviewed; the share in real use depends on
how people talk to Jibo. A public server's privacy policy must say so before
the layer is turned on.

## Adding a command

Add an entry to `DECISION_COMMANDS` with a canonical phrase that the grammar
parses at HIGH, the intent that parse produces, and a one-line description;
the tests check the phrase still parses that way. Add paraphrases to the case
set, then evaluate dev and held-out as above.
