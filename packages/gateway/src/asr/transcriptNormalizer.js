// Transcript normalization: make another recognizer's text look exactly like
// the text the deployed Parakeet recognizer produces.
//
// WHAT PARAKEET PRODUCES (the target contract)
//
//   * The model is nvidia/parakeet-rnnt-0.6b (services/parakeet-asr/app/
//     recognizer.py NemoRecognizer.DEFAULT_MODEL). Its SentencePiece tokenizer
//     has 1024 pieces built only from the letters a-z, the apostrophe and the
//     word-boundary marker (plus <unk>): no digits, no capitals, no hyphen and
//     no punctuation can ever be decoded. Read from the published model archive
//     (tokenizer.vocab inside parakeet-rnnt-0.6b.nemo); see
//     docs/ASR-GOOGLE-FALLBACK.md for how it was checked.
//   * The 0.2.x server additionally applies to_asr_text to every interim and
//     final (services/parakeet-asr/app/server.py _payload,
//     app/normalize.py to_asr_text): punctuation becomes a space, whitespace
//     collapses, the result is lower-cased. Number rewriting is opt-in and
//     Phoenix never asks for it (parakeetSession.js sends normalize:false), so
//     spoken numbers stay words: "testing testing one two three".
//
//   So every Parakeet transcript matches PARAKEET_TEXT below: lower-case words
//   of a-z and apostrophes, single spaces, nothing else.
//
// WHAT GOOGLE PRODUCES
//
//   Google Cloud Speech-to-Text applies inverse text normalization: digits
//   ("testing testing 1 2 3" -- the original Jibo cloud's own transcript of the
//   same audio, docs/parity/evidence/2026-09-15/r01-side-effects/README.md),
//   times ("7:30"), ordinals ("4th"), currency ("$5"), percentages ("50%"),
//   capitals ("I", proper nouns) and, unless disabled, punctuation. Chirp 3
//   punctuates and capitalizes by default.
//
// normalizeGoogleTranscript() maps that onto the Parakeet contract: numbers and
// symbols become the words a speaker would have said, then the same
// punctuation/whitespace/lower-case rule as to_asr_text, then the RNNT alphabet
// (hyphens split words, accents are dropped, anything outside a-z and the
// apostrophe disappears).
//
// WHERE EXACT EQUIVALENCE IS IMPOSSIBLE
//
//   Inverse text normalization loses information, so the spoken form has to be
//   chosen. Each choice below is deterministic and documented, and the test
//   suite pins it (asr.transcriptNormalizer.test.js):
//     "100"   -> "one hundred"        (speaker may have said "a hundred")
//     "105"   -> "one hundred five"   (or "one hundred and five")
//     "1999"  -> "nineteen ninety nine"; "2026" -> "twenty twenty six"
//               (4-digit numbers from 1100 to 2099 read as years)
//     "0"     -> "zero" in digit strings, "oh" inside times/years ("7:05")
//     "7:00"  -> "seven o'clock"; "7:00 p.m." -> "seven pm"
//     "a.m."  -> "am" -- the RNNT could equally have written "a m"; "am" is the
//               one form both the clock grammar (alarm_timer_ampm.rule) and
//               homeAssistantRoute.js CLOCK_TIME accept.
//     "$5.50" -> "five dollars and fifty cents" (or "five fifty")
//   Abbreviations are NOT expanded: the RNNT vocabulary has the pieces "mr",
//   "dr" and "ok", i.e. its training text kept them as words, which is also
//   what to_asr_text makes of "Mr." and "OK".

/** Every Parakeet transcript matches this. */
export const PARAKEET_TEXT = /^(?:[a-z']+(?: [a-z']+)*)?$/;

// --- Parakeet's own server-side rule ----------------------------------------

// Python: re.compile(r"[^\w\s'\-]+") with Unicode \w = letters, numbers, _.
const PY_PUNCT = /[^\p{L}\p{N}_\s'-]+/gu;
const PY_WS = /\s+/gu;

/**
 * Exact port of services/parakeet-asr/app/normalize.py to_asr_text: punctuation
 * becomes a space, whitespace collapses, the result is lower-cased. Apostrophes
 * and hyphens are kept. Falsy input is returned unchanged, as in Python.
 */
export function toAsrText(text) {
  if (!text) return text;
  return String(text).replace(PY_PUNCT, ' ').replace(PY_WS, ' ').trim().toLowerCase();
}

// --- number words -------------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion'];
const ORDINAL_IRREGULAR = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};

function underThousand(n) {
  const words = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(ONES[hundreds], 'hundred');
  if (rest >= 20) {
    words.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push(ONES[rest % 10]);
  } else if (rest) {
    words.push(ONES[rest]);
  }
  return words;
}

/** Each digit as a word: "0457" -> "zero four five seven". */
export function digitWords(digits) {
  return String(digits).split('').filter((d) => d >= '0' && d <= '9').map((d) => ONES[Number(d)]).join(' ');
}

/** "1234" -> "one thousand two hundred thirty four" (no "and", US style). */
export function cardinalWords(digits) {
  const clean = String(digits).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  if (!clean) return '';
  if (clean === '0') return 'zero';
  if (clean.length > SCALES.length * 3) return digitWords(clean);
  const groups = [];
  for (let end = clean.length; end > 0; end -= 3) groups.unshift(Number(clean.slice(Math.max(0, end - 3), end)));
  const words = [];
  groups.forEach((group, index) => {
    if (!group) return;
    words.push(...underThousand(group));
    const scale = SCALES[groups.length - 1 - index];
    if (scale) words.push(scale);
  });
  return words.join(' ');
}

/** "21" -> "twenty first", "100" -> "one hundredth". */
export function ordinalWords(digits) {
  const words = cardinalWords(digits).split(' ');
  const last = words.pop();
  let ordinal;
  if (ORDINAL_IRREGULAR[last]) ordinal = ORDINAL_IRREGULAR[last];
  else if (last.endsWith('y')) ordinal = `${last.slice(0, -1)}ieth`;
  else ordinal = `${last}th`;
  return [...words, ordinal].join(' ');
}

/** 1100-2099 the way years are said: "nineteen oh five", "twenty twenty six". */
export function yearWords(value) {
  const n = Number(value);
  if (n >= 2000 && n <= 2009) return cardinalWords(String(n));
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return `${cardinalWords(String(high))} hundred`;
  if (low < 10) return `${cardinalWords(String(high))} oh ${ONES[low]}`;
  return `${cardinalWords(String(high))} ${cardinalWords(String(low))}`;
}

/** Words for a plain integer token as Google prints it. */
export function integerWords(token) {
  const raw = String(token);
  if (raw.includes(',')) return cardinalWords(raw);           // "1,500" is a quantity
  if (raw.length > 1 && raw.startsWith('0')) return digitWords(raw); // "007", ZIP codes
  if (raw.length >= 5) return digitWords(raw);                // codes; Google groups big quantities with commas
  const n = Number(raw);
  if (raw.length === 4 && n >= 1100 && n <= 2099) return yearWords(n);
  return cardinalWords(raw);
}

function pluralWord(word) {
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** "90" -> "nineties", "1990" -> "nineteen nineties", "1800" -> "eighteen hundreds". */
function decadeWords(digits) {
  if (digits === '100') return 'hundreds';
  if (digits === '1000') return 'thousands';
  const words = (digits.length === 4 ? integerWords(digits) : cardinalWords(digits)).split(' ');
  words.push(pluralWord(words.pop()));
  return words.join(' ');
}

function decimalWords(intPart, fracPart) {
  const head = intPart === '' ? '' : `${integerOrCardinal(intPart)} `;
  return `${head}point ${digitWords(fracPart)}`;
}

// In a decimal, a percentage or a measurement the integer is a quantity, never
// a year or a code: "1500.5", "2025 km".
function integerOrCardinal(token) {
  return String(token).includes(',') ? cardinalWords(token) : cardinalWords(String(token));
}

const UNITS = {
  km: ['kilometer', 'kilometers'], kms: ['kilometer', 'kilometers'],
  cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'],
  kg: ['kilogram', 'kilograms'], kgs: ['kilogram', 'kilograms'],
  lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'], oz: ['ounce', 'ounces'],
  mph: ['miles per hour', 'miles per hour'], kph: ['kilometers per hour', 'kilometers per hour'],
  ft: ['foot', 'feet'], mi: ['mile', 'miles'], ml: ['milliliter', 'milliliters'],
  hr: ['hour', 'hours'], hrs: ['hour', 'hours'], min: ['minute', 'minutes'], mins: ['minute', 'minutes'],
  sec: ['second', 'seconds'], secs: ['second', 'seconds'],
};

const CURRENCY = {
  $: { one: 'dollar', many: 'dollars', cent: 'cent', cents: 'cents' },
  '€': { one: 'euro', many: 'euros', cent: 'cent', cents: 'cents' },
  '£': { one: 'pound', many: 'pounds', cent: 'penny', cents: 'pence' },
  '¥': { one: 'yen', many: 'yen', cent: 'sen', cents: 'sen' },
};

function currencyWords(symbol, intPart, decPart, scale) {
  const unit = CURRENCY[symbol];
  const whole = String(intPart).replace(/,/g, '');
  if (scale) {
    const amount = decPart ? decimalWords(whole, decPart) : cardinalWords(whole);
    return `${amount} ${scale.toLowerCase()} ${unit.many}`;
  }
  if (decPart && decPart.length !== 2) return `${decimalWords(whole, decPart)} ${unit.many}`;
  const wholeN = Number(whole);
  const cents = decPart ? Number(decPart) : 0;
  const parts = [];
  if (wholeN > 0 || !cents) parts.push(`${cardinalWords(whole)} ${wholeN === 1 ? unit.one : unit.many}`);
  if (cents) parts.push(`${cardinalWords(String(cents))} ${cents === 1 ? unit.cent : unit.cents}`);
  return parts.join(' and ');
}

function timeWords(hours, minutes, seconds, followedByMeridiem) {
  const words = [cardinalWords(hours)];
  const m = Number(minutes);
  if (m === 0 && !seconds) {
    if (!followedByMeridiem) words.push("o'clock");
  } else if (m < 10) {
    words.push('oh', ONES[m]);
  } else {
    words.push(cardinalWords(minutes));
  }
  if (seconds) words.push(cardinalWords(seconds));
  return words.join(' ');
}

function fractionWords(numerator, denominator) {
  if (numerator === '24' && denominator === '7') return 'twenty four seven';
  const n = Number(numerator);
  const d = Number(denominator);
  if (d >= 2 && d <= 10 && n > 0 && n < d) {
    if (d === 2) return `${cardinalWords(numerator)} half`;
    if (d === 4) return `${cardinalWords(numerator)} ${n === 1 ? 'quarter' : 'quarters'}`;
    const ord = ordinalWords(denominator);
    return `${cardinalWords(numerator)} ${n === 1 ? ord : `${ord}s`}`;
  }
  return `${integerWords(numerator)} slash ${integerWords(denominator)}`;
}

const OPERATORS = {
  '+': 'plus', '-': 'minus', x: 'times', X: 'times', '×': 'times', '*': 'times',
  '/': 'divided by', '÷': 'divided by', '=': 'equals', '^': 'to the power of',
};

const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
const UNIT_NAMES = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const MERIDIEM_AHEAD = /^\s*(?:[AaPp]\.\s?[Mm]\.?|[AaPp][Mm]\b)/;

// One left-to-right pass; at each position the first alternative that matches
// wins, so the order below is the precedence order.
const NUMERIC = new RegExp([
  // currency: $5, $5.50, $1,200, $1.5 million
  String.raw`(?<cur>[$€£¥])\s?(?<curInt>${NUM})(?:\.(?<curDec>\d+))?(?:\s?(?<curScale>thousand|million|billion|trillion)\b)?`,
  // telephone numbers stay digit by digit
  String.raw`(?<phone>(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)|(?<![\d-])\d{3}-\d{4}(?![\d-]))`,
  // clock times: 7:30, 12:05, 1:30:15
  String.raw`(?<![\d.,:])(?<hh>\d{1,2}):(?<mm>\d{2})(?::(?<ss>\d{2}))?(?![\d:])`,
  // ordinals: 1st, 22nd, 4th
  String.raw`(?<![\d.,])(?<ord>\d+)(?:st|nd|rd|th)\b`,
  // decades and plurals: 90s, '90s, 1990s, 100s
  String.raw`(?<![\d.,])'?(?<decade>\d{2,4})s\b`,
  // fractions: 1/2, 3/4, 24/7
  String.raw`(?<![\d.,/])(?<fn>\d+)\/(?<fd>\d+)(?![\d/])`,
  // ranges: 5-10, 9-5
  String.raw`(?<![\d.,-])(?<ra>\d+)-(?<rb>\d+)(?![\d-])`,
  // arithmetic operators between numbers: 2+2, 2 + 2, 5 - 3, 3 x 4, 10 / 2
  String.raw`(?<=\d)\s*(?<op>[+×*÷=^])\s*(?=-?\d)`,
  String.raw`(?<=\d)\s+(?<op2>[-xX/])\s+(?=-?\d)`,
  // "#1" is "number one"
  String.raw`(?<hash>#)(?=\d)`,
  // plain numbers, with an optional sign, decimals, percent, degrees or unit
  // (no look-behind: a digit run left over after "1,2" or "2.0.1" is still
  // its own number, never silently dropped)
  String.raw`(?<sign>(?<![\w)])-)?(?<int>${NUM})?(?:\.(?<frac>\d+))?(?<suffix>\s?%|\s?°\s?[FCfc]\b|\s?°|\s?(?:${UNIT_NAMES})\b)?`,
].join('|'), 'g');

function suffixWords(suffix, isOne) {
  const s = suffix.trim();
  if (s === '%') return 'percent';
  if (s.startsWith('°')) {
    const scale = s.slice(1).trim().toUpperCase();
    return `degrees${scale === 'F' ? ' fahrenheit' : scale === 'C' ? ' celsius' : ''}`;
  }
  const unit = UNITS[s.toLowerCase()];
  return unit ? (isOne ? unit[0] : unit[1]) : s;
}

/** Replace digits and numeric notation with the words a speaker would say. */
export function verbalizeNumbers(text) {
  return String(text).replace(NUMERIC, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    const offset = rest[rest.length - 3];
    const input = rest[rest.length - 2];
    const pad = (words) => ` ${words} `;
    if (groups.cur) return pad(currencyWords(groups.cur, groups.curInt, groups.curDec, groups.curScale));
    if (groups.phone) return pad(digitWords(groups.phone));
    if (groups.hh !== undefined) {
      const ahead = input.slice(offset + match.length);
      return pad(timeWords(groups.hh, groups.mm, groups.ss, MERIDIEM_AHEAD.test(ahead)));
    }
    if (groups.ord) return pad(ordinalWords(groups.ord));
    if (groups.decade) return pad(decadeWords(groups.decade));
    if (groups.fn) return pad(fractionWords(groups.fn, groups.fd));
    if (groups.ra) return pad(`${integerWords(groups.ra)} to ${integerWords(groups.rb)}`);
    if (groups.op) return pad(OPERATORS[groups.op]);
    if (groups.op2) return pad(OPERATORS[groups.op2]);
    if (groups.hash) return ' number ';
    if (groups.int === undefined && groups.frac === undefined) return match; // nothing numeric here
    const sign = groups.sign ? 'minus ' : '';
    let words;
    if (groups.frac !== undefined) words = decimalWords(groups.int ?? '', groups.frac);
    else if (groups.suffix) words = integerOrCardinal(groups.int);
    else words = integerWords(groups.int);
    const isOne = groups.frac === undefined && String(groups.int).replace(/,/g, '') === '1';
    const tail = groups.suffix ? ` ${suffixWords(groups.suffix, isOne)}` : '';
    return pad(`${sign}${words}${tail}`);
  });
}

// --- symbols, meridiem, alphabet ------------------------------------------------

const SYMBOLS = [
  [/&/g, ' and '], [/@/g, ' at '], [/\+/g, ' plus '], [/=/g, ' equals '], [/%/g, ' percent '],
  [/°/g, ' degrees '], [/[×]/g, ' times '], [/÷/g, ' divided by '],
  [/\$/g, ' dollars '], [/€/g, ' euros '], [/£/g, ' pounds '],
];

// Google writes "7 a.m." (or "7 AM", which lower-casing already turns into
// "am"); the dotted form becomes "am"/"pm" rather than to_asr_text's "a m".
const MERIDIEM = /(^|[^A-Za-z])([AaPp])\.\s?[Mm]\.?(?=$|[^A-Za-z])/g;

const LETTER_FOLDS = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd', ı: 'i' };

function foldLetters(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ßæœøđłþðı]/g, (ch) => LETTER_FOLDS[ch]);
}

/**
 * Google Speech-to-Text transcript (interim or final) -> the Parakeet format.
 * Total: any input yields a string matching PARAKEET_TEXT ('' for none).
 */
export function normalizeGoogleTranscript(raw) {
  if (raw === null || raw === undefined) return '';
  let text = String(raw).normalize('NFKC')
    .replace(/[‘’‛′`´]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/⁄/g, '/')
    .replace(/…/g, ' ');
  text = verbalizeNumbers(text);
  text = text.replace(MERIDIEM, (m, before, letter) => `${before} ${letter.toLowerCase()}m `);
  for (const [pattern, words] of SYMBOLS) text = text.replace(pattern, words);
  text = foldLetters(text.toLowerCase());
  // to_asr_text's rule (punctuation -> space) restricted to the RNNT alphabet:
  // hyphens, leftover digits, underscores and non-Latin letters also go.
  text = text.replace(/[^a-z'\s]+/g, ' ');
  // An apostrophe that touches no letter is a quote mark, not part of a word.
  text = text.replace(/(^|[^a-z])'+(?=[^a-z]|$)/g, '$1').replace(/'{2,}/g, "'");
  return text.replace(/\s+/g, ' ').trim();
}
