# GQA answers "who is X" but not "how tall is X" — Wolfram Alpha is unconfigured

Date: 2026-09-16
Status: **CLOSED the same day.** The owner supplied an App ID; all three
questions now answer. Diagnosis and the fix are both below.

Reported live: "who is Ada Lovelace" answers; "how tall is Mount Everest" and
"how many calories in an apple" both come back as the no-answer MIM.

Reproduced against the running stack (skills service, port 29003):

```
how tall is mount everest      -> GQA_no_answer_generic_02  "Sorry, I checked for you, but I'm coming up empty."
how many calories in an apple  -> GQA_no_answer_generic_10  "I checked for you, but didn't find anything."
```

## All three providers, called directly

```
Bing slot (DuckDuckGo)  166ms  {} — no instant answer
Wikipedia               144ms  strict_query "tall is mount everest" — No match
Wolfram Alpha           361ms  message: "Unexpected exception: Error: HTTP 400"
```

Each for its own reason, and only one of them is a defect:

**DuckDuckGo** is an entity lookup, not a question-answering engine. Asked the
question form it returns an entirely empty document; asked `mount everest` it
returns the article abstract. Even then the abstract is the general description,
not the height, so it could not answer "how tall" regardless. This is the cost
of the Bing slot: Bing returned a typed answer card with a `conversation.spokenText`
written for exactly these questions, and the keyless replacement has no
equivalent.

**Wikipedia** is behaving as the source designed it. `removeInitialStopWords`
strips only *leading* stop and wh-words, so "how tall is mount everest" becomes
the search `tall is mount everest`, which matches no article. That is the
reference's own tokenizer, ported faithfully — it was never the provider that
handled question forms.

**Wolfram Alpha returns HTTP 400 because no `appid` is configured.** Confirmed
directly:

```
curl -o /dev/null -w '%{http_code}' \
  'https://api.wolframalpha.com/v2/query?input=how+tall+is+mount+everest&format=plaintext&output=JSON'
400
```

## Wolfram is the provider these questions belong to

In Jibo's pipeline Wolfram Alpha is the second group, reached when the
Bing+Wikipedia race produces nothing — which is exactly what happens here. The
adapter already sends the source's request shape, including `spokenresult=true`
and the answer `podindex` (`gqaWolframProvider.js:155-175`), so Wolfram returns
a short spoken answer rather than prose. That also means its answers arrive
already inside the robot's 500-character TTS ceiling.

So this is not a missing feature. The provider is implemented, wired, in the
right group with the right timeout, and reached at the right moment. It has no
credential.

## Why it is not defaulted

`readGqaMultiProviderProfileConfig` defaults the DuckDuckGo and Wikipedia
endpoints to their public keyless URLs, and deliberately does not default the
Wolfram app id:

```js
wolfram: {
  endpoint: env.ETCO_gqa_wolframApi || GQA_PUBLIC_ENDPOINTS.wolfram,
  // Deliberately NOT defaulted: an app id is a credential.
  apiKey: env.ETCO_gqa_wolframKey,
},
```

No Wolfram credential exists anywhere on this host — not in Phoenix's `.env`,
not in the Hermes configuration.

## What unblocks it

A Wolfram Alpha AppID from `developer.wolframalpha.com` (the Full Results API
has a free non-commercial tier). It goes in the robot stack's environment file,
`~/.config/phoenix/moth.env`, because that file sets `PHOENIX_ENV_FILE=/dev/null`
and so never reads the repository `.env`:

```
ETCO_gqa_wolframKey=<appid>
```

then `systemctl --user restart phoenix-robot@moth.service`.

Until then the honest statement of GQA's live coverage is: entity questions
("who is X", "what is X") are answered from DuckDuckGo and Wikipedia;
quantitative and computational questions ("how tall", "how many", conversions,
arithmetic) are not answered at all.


---

# Closed — the App ID was the whole gap

The owner supplied a Wolfram Alpha App ID. It was written to
`~/.config/phoenix/moth.env` as `ETCO_gqa_wolframKey` (mode 0600, outside the
repository and untracked — that file is the robot stack's environment and sets
`PHOENIX_ENV_FILE=/dev/null`, so the repository `.env` never reaches it), and
the stack was restarted. **The value is not recorded here or anywhere in Git.**

Same three questions, against the running stack on port 29003, immediately
after:

| question | source | chars | spoken |
| --- | --- | --- | --- |
| how tall is mount everest | **Wolfram Alpha** | 67 | "The elevation of Mount Everest is about 29032 feet above sea level." |
| how many calories in an apple | **Wolfram Alpha** | 48 | "There are about 91 dietary Calories in an apple." |
| who is ada lovelace | DuckDuckGo | 220 | "Augusta Ada King, Countess of Lovelace … the analytical engine." |

Nothing in Phoenix changed. The second provider group was already implemented,
already in the right place in the pipeline, and already reached at the right
moment; it had no credential and returned HTTP 400. With one it answers.

Two things worth keeping from this:

* `spokenresult=true` earns its place. Both Wolfram answers are 67 and 48
  characters — an order of magnitude inside the robot's 500-character TTS
  ceiling, with no trimming needed. The provider whose answers had to be
  sentence-bounded was the prose one.
* The division of labour is now the one Jibo had: entity questions from the
  Bing slot and Wikipedia, quantitative and computational questions from
  Wolfram.
