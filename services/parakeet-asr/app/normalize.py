"""Spoken-number rewriting, OFF by default.

The owner asked for digits and words to be switched automatically. Measured
first, against the original parser rather than assumed:

    set a timer for five minutes   ->  start {minutes: '5'}
    set a timer for 5 minutes      ->  start {minutes: '5'}
    count to ten                   ->  requestCountToNumber {CountNumber: '10'}
    count to 10                    ->  requestCountToNumber {CountNumber: '10'}
    set the volume to five         ->  volumeToValue {volumeLevel: '05'}
    set the volume to 5            ->  volumeToValue {volumeLevel: '05'}

(jibo-nlu 2.8.3 over the pinned launch.fst.) The grammars already normalise
number words through their own factories, so both forms reach the same intent
with the same slot values. Rewriting text before the parser sees it therefore
buys no parity and risks harm -- "one" is a pronoun as often as a number ("one
of them", "the big one"), and a blind rewrite corrupts those.

So this exists, because it was asked for and the difference is real at the
transcript level, but it is opt-in per request (`?normalize=true`). Only
standalone number words are rewritten, and only in runs, which is the case that
motivated it: "testing testing one two three" against Google's "testing testing
1 2 3".
"""
from __future__ import annotations

import re

UNITS = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}

# "one" and "oh" carry non-numeric senses often enough that rewriting them in
# isolation does more harm than good. In a run of number words the sense is
# unambiguous, so they are rewritten there and nowhere else.
AMBIGUOUS_ALONE = {"one", "oh"}


def _word_value(word: str):
    if word in UNITS:
        return UNITS[word]
    if word in TENS:
        return TENS[word]
    return None


def normalize_text(text: str) -> str:
    """Rewrite spoken numbers as digits. Returns `text` unchanged if none apply."""
    if not text:
        return text
    tokens = text.split()
    out = []
    i = 0
    while i < len(tokens):
        bare = re.sub(r"[^a-z]", "", tokens[i].lower())
        value = _word_value(bare)
        if value is None:
            out.append(tokens[i])
            i += 1
            continue

        # Collect the whole run of number words.
        run = []
        j = i
        while j < len(tokens):
            candidate = re.sub(r"[^a-z]", "", tokens[j].lower())
            v = _word_value(candidate)
            if v is None:
                break
            run.append((candidate, v))
            j += 1

        if len(run) == 1 and run[0][0] in AMBIGUOUS_ALONE:
            out.append(tokens[i])
            i += 1
            continue

        # "twenty three" is one number; "one two three" is three digits.
        k = 0
        while k < len(run):
            word, value = run[k]
            if word in TENS and k + 1 < len(run) and run[k + 1][0] in UNITS and run[k + 1][1] < 10:
                out.append(str(value + run[k + 1][1]))
                k += 2
            else:
                out.append(str(value))
                k += 1
        i = j
    return " ".join(out)


# --- ASR output contract ---------------------------------------------------

# Trailing and embedded punctuation is not cosmetic here: it stops the parse
# dead. Measured against jibo-nlu 2.8.3 over the pinned launch.fst:
#
#     turn on the lights                  -> lightsOn
#     turn on the lights.                 -> NO PARSE
#     testing testing one two three       -> partialRecognition
#     testing, testing, one, two, three   -> NO PARSE
#
# The runtime lowercases before parsing (RobustParserClient.handleNLU) but never
# strips punctuation, so a model that emits punctuation and capitalisation --
# parakeet-tdt-0.6b-v2 does -- silently breaks intent recognition. The 0.1.0
# server returned bare lowercase text and so did Google, so this restores the
# contract both the grammars and the previous deployment assume.
_PUNCT = re.compile(r"[^\w\s'\-]+")
_REPEAT_WS = re.compile(r"\s+")


def to_asr_text(text: str) -> str:
    """Lowercase, drop punctuation, collapse whitespace.

    Apostrophes and hyphens are kept: the grammars carry forms like `don't` and
    `wake-up`, and stripping them would break those instead.
    """
    if not text:
        return text
    cleaned = _PUNCT.sub(" ", text)
    return _REPEAT_WS.sub(" ", cleaned).strip().lower()
