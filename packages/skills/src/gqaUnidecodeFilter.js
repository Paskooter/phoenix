import {
  SOURCE_UNIDECODE_EMPTY_RANGES,
  SOURCE_UNIDECODE_PREFIX_REPLACEMENTS,
} from './vendor/unidecode-1.0.22/gqaUnidecodeFilterData.js';

// Unidecode emits ``[?]`` for a mapped-but-unknown character.  A private
// control marker keeps that value non-prefix even when the source's legacy
// boilerplate list itself contains a literal question mark.
const NON_PREFIX_MARKER = '\u0001';

function isEmptyCodePoint(codePoint) {
  let low = 0;
  let high = SOURCE_UNIDECODE_EMPTY_RANGES.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const [start, end] = SOURCE_UNIDECODE_EMPTY_RANGES[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Reproduce the observable part of Unidecode 1.0.22 used by gqa/bing.py.
 *
 * The recovered Bing code does not use transliteration as output.  It only
 * checks whether ``unidecode(spokenText).strip('.')`` is empty or starts with
 * one of its fixed unhelpful prefixes.  The generated data therefore retains
 * source mappings that can affect those predicates, skips source-ignored
 * code points, and uses a non-prefix marker for every other non-empty mapped
 * value.  This keeps the original Unicode spoken text untouched.
 */
export function unidecodeForBingFilter(value) {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x80) {
      result += character;
      continue;
    }
    const mapped = SOURCE_UNIDECODE_PREFIX_REPLACEMENTS.get(codePoint);
    if (mapped !== undefined) {
      result += mapped;
      continue;
    }
    if (!isEmptyCodePoint(codePoint)) result += NON_PREFIX_MARKER;
  }
  return result;
}
