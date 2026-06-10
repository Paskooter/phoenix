// ASR text normalization — port of hub/src/utils/StringNormalizer.ts with the
// vendored resources/stringNormalizationMap.json (smart quotes, unicode dashes,
// exotic whitespace → plain ASCII). Applied to ASR transcripts before NLU,
// exactly where the reference applies it (performASR, after the session result).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'stringNormalizationMap.json');
const normMap = JSON.parse(readFileSync(MAP_PATH, 'utf8'));

// Keys are "uXXXX" escape names; build [regex, substitution] pairs like the
// reference ("[\\uXXXX]" with i+g flags).
const substitutions = Object.keys(normMap).map((key) => [new RegExp('[\\' + key + ']', 'ig'), normMap[key]]);

/** Replace known bad characters with safe substitutions; non-strings -> ''. */
export function normalizeString(inputStr) {
  if (typeof inputStr !== 'string') return '';
  if (!inputStr) return inputStr;
  return substitutions
    .reduce((str, [regex, substitution]) => str.replace(regex, substitution), inputStr)
    .replace(/  +/g, ' ')
    .trim();
}
