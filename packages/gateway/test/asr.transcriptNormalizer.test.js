// Google -> Parakeet transcript normalization.
//
// The contract under test: whatever Google Speech-to-Text returns, the text
// handed to the session is in the exact format the deployed Parakeet RNNT
// produces -- lower-case words of a-z and apostrophes, single spaces, numbers
// as words, no punctuation -- so FAST_EOS matching, NLU and Phoenix's own
// regex routes (homeAssistantRoute.js) see what they see today.
//
// Every Google-style input below is an invented, generic utterance.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAKEET_TEXT,
  cardinalWords,
  digitWords,
  integerWords,
  normalizeGoogleTranscript,
  ordinalWords,
  toAsrText,
  yearWords,
} from '../src/asr/transcriptNormalizer.js';

const norm = normalizeGoogleTranscript;

function table(t, rows) {
  for (const [input, expected] of rows) {
    const actual = norm(input);
    assert.equal(actual, expected, `${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
    assert.match(actual, PARAKEET_TEXT, `${JSON.stringify(input)} leaves the Parakeet alphabet`);
  }
}

// --- the Parakeet side of the contract -----------------------------------------

test('toAsrText is a faithful port of the Parakeet server rule (normalize.py to_asr_text)', () => {
  // The Python service's own cases (services/parakeet-asr/tests/test_server.py).
  assert.equal(toAsrText('Testing, testing, one, two, three.'), 'testing testing one two three');
  assert.equal(toAsrText("Don't wake me up."), "don't wake me up");
  // Hyphens and apostrophes survive; whitespace collapses; falsy is returned as-is.
  assert.equal(toAsrText('  Wake-up   call!! '), 'wake-up call');
  assert.equal(toAsrText(''), '');
  assert.equal(toAsrText(null), null);
  // Python's \w is Unicode-aware: letters and digits of any script are kept.
  assert.equal(toAsrText('Café 3:30'), 'café 3 30');
});

test('the target alphabet is exactly what the RNNT can emit', () => {
  for (const ok of ['', 'testing testing one two three', "what's the time", "o'clock", 'mr smith']) {
    assert.match(ok, PARAKEET_TEXT, ok);
  }
  for (const bad of ['Testing', 'one, two', 'wake-up', '1 2 3', ' leading', 'double  space', 'trailing ', 'café']) {
    assert.doesNotMatch(bad, PARAKEET_TEXT, bad);
  }
});

// --- number words -----------------------------------------------------------------

test('cardinal, ordinal, year and digit words', () => {
  assert.equal(cardinalWords('0'), 'zero');
  assert.equal(cardinalWords('7'), 'seven');
  assert.equal(cardinalWords('13'), 'thirteen');
  assert.equal(cardinalWords('40'), 'forty');
  assert.equal(cardinalWords('99'), 'ninety nine');
  assert.equal(cardinalWords('100'), 'one hundred');
  assert.equal(cardinalWords('105'), 'one hundred five');
  assert.equal(cardinalWords('1000'), 'one thousand');
  assert.equal(cardinalWords('1,234,567'), 'one million two hundred thirty four thousand five hundred sixty seven');
  assert.equal(cardinalWords('1000000000'), 'one billion');
  assert.equal(ordinalWords('1'), 'first');
  assert.equal(ordinalWords('2'), 'second');
  assert.equal(ordinalWords('3'), 'third');
  assert.equal(ordinalWords('4'), 'fourth');
  assert.equal(ordinalWords('5'), 'fifth');
  assert.equal(ordinalWords('8'), 'eighth');
  assert.equal(ordinalWords('9'), 'ninth');
  assert.equal(ordinalWords('12'), 'twelfth');
  assert.equal(ordinalWords('20'), 'twentieth');
  assert.equal(ordinalWords('21'), 'twenty first');
  assert.equal(ordinalWords('100'), 'one hundredth');
  assert.equal(yearWords(1905), 'nineteen oh five');
  assert.equal(yearWords(1900), 'nineteen hundred');
  assert.equal(yearWords(1999), 'nineteen ninety nine');
  assert.equal(yearWords(2000), 'two thousand');
  assert.equal(yearWords(2007), 'two thousand seven');
  assert.equal(yearWords(2026), 'twenty twenty six');
  assert.equal(digitWords('0457'), 'zero four five seven');
  assert.equal(integerWords('2026'), 'twenty twenty six', 'a 4-digit number in the year range reads as a year');
  assert.equal(integerWords('3456'), 'three thousand four hundred fifty six');
  assert.equal(integerWords('1,500'), 'one thousand five hundred', 'a comma-grouped number is a quantity');
  assert.equal(integerWords('02139'), 'zero two one three nine', 'a leading zero reads digit by digit');
  assert.equal(integerWords('12345'), 'one two three four five', 'five ungrouped digits are a code');
});

// --- Google's formatting -> Parakeet's ------------------------------------------------

test('the original Jibo cloud transcript of test_audio.raw becomes the Parakeet one', () => {
  // docs/parity/evidence/2026-09-15/r01-side-effects/README.md: the same audio
  // came back as "testing testing 1 2 3" from Google and "testing testing one
  // two three" from Parakeet.
  assert.equal(norm('testing testing 1 2 3'), 'testing testing one two three');
});

test('case, punctuation and whitespace follow the Parakeet rule', (t) => table(t, [
  ['What time is it?', 'what time is it'],
  ['Hey, Jibo. Tell me a joke!', 'hey jibo tell me a joke'],
  ["What's the weather like?", "what's the weather like"],
  ["I'm fine; thanks.", "i'm fine thanks"],
  ['  spaced   out  ', 'spaced out'],
  ['"quoted" words', 'quoted words'],
  ['Turn on the lights...', 'turn on the lights'],
  ['Dance — now', 'dance now'],
]));

test('cardinal numbers become words', (t) => table(t, [
  ['Set a timer for 5 minutes.', 'set a timer for five minutes'],
  ['Count to 10', 'count to ten'],
  ['count to 100', 'count to one hundred'],
  ['turn the volume to 10', 'turn the volume to ten'],
  ['1,500 people', 'one thousand five hundred people'],
  ['there are 0 left', 'there are zero left'],
  ['1, 2, 3', 'one two three'],
  ['1,2,3', 'one two three'],
]));

test('years, decades and digit strings', (t) => table(t, [
  ['I was born in 1999', 'i was born in nineteen ninety nine'],
  ['what happened in 1969', 'what happened in nineteen sixty nine'],
  ['in 2026', 'in twenty twenty six'],
  ['2005', 'two thousand five'],
  ['songs from the 90s', 'songs from the nineties'],
  ["'90s music", 'nineties music'],
  ['the 1990s', 'the nineteen nineties'],
  ['100s of birds', 'hundreds of birds'],
  ['zip code 02139', 'zip code zero two one three nine'],
  ['code 007', 'code zero zero seven'],
]));

test('ordinals and dates', (t) => table(t, [
  ['July 4th, 2026', 'july fourth twenty twenty six'],
  ['the 21st century', 'the twenty first century'],
  ['my 2nd favorite', 'my second favorite'],
  ['the 3rd time', 'the third time'],
]));

test('clock times and am/pm', (t) => table(t, [
  ['Set an alarm for 7:30 a.m.', 'set an alarm for seven thirty am'],
  ['Wake me at 7 AM', 'wake me at seven am'],
  ['remind me at 6 p.m.', 'remind me at six pm'],
  ['7:00 p.m.', 'seven pm'],
  ['at 7:00', "at seven o'clock"],
  ['7 o’clock', "seven o'clock"],
  ['7:05', 'seven oh five'],
  ['12:45', 'twelve forty five'],
  ['7:30pm', 'seven thirty pm'],
  ['1:30:15', 'one thirty fifteen'],
  ['I am happy', 'i am happy'],
]));

test('am/pm output is accepted by both downstream consumers', () => {
  // packages/gateway/src/homeAssistantRoute.js CLOCK_TIME accepts am|pm|a.m.|p.m.
  // but not "a m"; the clock grammar accepts am and a m. "am" satisfies both.
  const homeClock = /at (?:(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::\d{2})? ?(?:am|pm|a\.m\.|p\.m\.|o'clock)|\d{1,2}:\d{2}|noon|midnight)/i;
  assert.match(norm('Turn off the lights at 7 p.m.'), homeClock);
  assert.match(norm('Turn off the lights at 7:00'), homeClock);
});

test('money, percentages, temperatures and units', (t) => table(t, [
  ['$5', 'five dollars'],
  ['$1', 'one dollar'],
  ['$5.50', 'five dollars and fifty cents'],
  ['$0.25', 'twenty five cents'],
  ['$1,200', 'one thousand two hundred dollars'],
  ['$1.5 million', 'one point five million dollars'],
  ['€20', 'twenty euros'],
  ['£3', 'three pounds'],
  ['50%', 'fifty percent'],
  ['set it to 50 percent', 'set it to fifty percent'],
  ['2.5%', 'two point five percent'],
  ['It is 72°F outside', 'it is seventy two degrees fahrenheit outside'],
  ['-5°C', 'minus five degrees celsius'],
  ['it is 30°', 'it is thirty degrees'],
  ['1 km', 'one kilometer'],
  ['5 km', 'five kilometers'],
  ['65 mph', 'sixty five miles per hour'],
  ['2 hrs', 'two hours'],
  ['1 min', 'one minute'],
]));

test('decimals, fractions, ranges, arithmetic and signs', (t) => table(t, [
  ['3.14', 'three point one four'],
  ['0.5', 'zero point five'],
  ['version 2.0.1', 'version two point zero point one'],
  ['1/2 cup', 'one half cup'],
  ['3/4', 'three quarters'],
  ['2/3', 'two thirds'],
  ['1/8', 'one eighth'],
  ['open 24/7', 'open twenty four seven'],
  ['12/25', 'twelve slash twenty five'],
  ['5-10 minutes', 'five to ten minutes'],
  ['9-5', 'nine to five'],
  ['what is 2+2?', 'what is two plus two'],
  ['2 + 2 = 4', 'two plus two equals four'],
  ['5 - 3', 'five minus three'],
  ['3 x 4', 'three times four'],
  ['6 * 7', 'six times seven'],
  ['10 / 2', 'ten divided by two'],
  ['10 ÷ 2', 'ten divided by two'],
  ['2^8', 'two to the power of eight'],
  ['-5 degrees', 'minus five degrees'],
  ['negative 5', 'negative five'],
]));

test('telephone numbers, hash numbers and words with digits', (t) => table(t, [
  ['call 555-1234', 'call five five five one two three four'],
  ['(617) 555-1234', 'six one seven five five five one two three four'],
  ['+1 617-555-1234', 'one six one seven five five five one two three four'],
  ['#1 song', 'number one song'],
  ['COVID-19', 'covid nineteen'],
  ['an MP3 file', 'an mp three file'],
  ['5G network', 'five g network'],
]));

test('symbols, hyphens, accents and other scripts', (t) => table(t, [
  ['AT&T', 'at and t'],
  ['rock & roll', 'rock and roll'],
  ['email me @ home', 'email me at home'],
  ['Disney+', 'disney plus'],
  ['T-shirt', 't shirt'],
  ['wi-fi', 'wi fi'],
  ['well-known', 'well known'],
  ['café au lait', 'cafe au lait'],
  ['Beyoncé', 'beyonce'],
  ['São Paulo', 'sao paulo'],
  ['Straße', 'strasse'],
  ['naïve résumé', 'naive resume'],
  ['hello 世界', 'hello'],
  ['½', 'one half'],
]));

test('apostrophes: contractions and possessives stay, quote marks go', (t) => table(t, [
  ["Jibo's eyes", "jibo's eyes"],
  ['The Beatles’ song', "the beatles' song"],
  ["don't", "don't"],
  ["say 'hello'", "say 'hello'"],
  ["' alone '", 'alone'],
  ["it''s", "it's"],
]));

test('abbreviations stay as the RNNT writes them (its vocabulary has mr, dr, ok)', (t) => table(t, [
  ['Mr. Smith', 'mr smith'],
  ['Dr. Jones', 'dr jones'],
  ['OK Jibo', 'ok jibo'],
  ['okay', 'okay'],
]));

test('empty, missing and whitespace-only transcripts become the empty string', () => {
  assert.equal(norm(''), '');
  assert.equal(norm('   '), '');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm('?!.'), '');
});

test('interim (partial) transcripts normalize the same way, prefix by prefix', () => {
  // Google re-sends the whole hypothesis with each interim result.
  const interims = ['set', 'set a', 'set a timer', 'set a timer for 5', 'set a timer for 5 minutes'];
  assert.deepEqual(interims.map(norm), [
    'set', 'set a', 'set a timer', 'set a timer for five', 'set a timer for five minutes',
  ]);
});

test('normalization is idempotent: Parakeet-format text passes through unchanged', () => {
  const samples = [
    'testing testing one two three', "what's the weather", "seven o'clock", 'set an alarm for seven thirty am',
    'number one song', 'mr smith', '',
  ];
  for (const text of samples) assert.equal(norm(text), text);
  for (const google of ['Set an alarm for 7:30 a.m.', '$5.50', 'July 4th, 2026', 'AT&T', '72°F']) {
    assert.equal(norm(norm(google)), norm(google), google);
  }
});

test('every output stays inside the Parakeet alphabet, for arbitrary input', () => {
  // A deterministic pseudo-random sweep over characters Google could plausibly emit.
  const alphabet = 'aAbBzZ0123456789 .,;:!?\'"-–—/\\$€£¥%°&@#+=*×÷^()[]{}<>_~`|éßØ½²’“”…\t\n';
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let i = 0; i < 2000; i += 1) {
    const length = next() % 24;
    let input = '';
    for (let j = 0; j < length; j += 1) input += alphabet[next() % alphabet.length];
    const output = norm(input);
    assert.match(output, PARAKEET_TEXT, `${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
  }
});
