// @jibo/serial-names — the friendly-id generator the original srv-robots-read-ws
// `GetFriendlyIds` calls as `randomlyGenerateCombos('bla bla', '-', 25, 1)[0]`
// (pinned jiborobot/srv-serial-names@master src/query.handlers style).
//
// Source: jiborobot/srv-serial-names src/main.js
//   words = [colors.value, tech.value, food.value, fabrics.value]  (data/*.json, vendored
//   verbatim in serialNames.json), each word normalized to PascalCase; the first three
//   groups are chosen at random and the fourth (fabrics) is chosen by HMAC-MD5 over the
//   first three joined by the delimiter (`calcLastWord`, main.js). A sentence longer than
//   maxLength is discarded. `randomlyGenerateCombos(secret, delimiter, max_length, num)`.
//
// The word pools are vendored from the pinned data files (colors 218, tech 238, food 169,
// fabrics 71) so generated ids are drawn from the original vocabulary and carry the
// original 4-word `Colour-Tech-Food-Fabric` shape that srv-robots' `convertId` Pascal-cases.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./serialNames.json', import.meta.url), 'utf8'));

function normalize(list) {
  const seen = new Set();
  for (const value of list) {
    const word = String(value).trim().toLowerCase().split(' ')
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join('');
    if (word) seen.add(word);
  }
  return [...seen];
}

// Order matters: [colors, tech, food, fabrics]; the last group is the HMAC-chosen word.
const WORDS = [normalize(raw.colors), normalize(raw.tech), normalize(raw.food), normalize(raw.fabrics)];

function calcLastWord(sentence, lastWordGroup, secret) {
  const hash = createHmac('md5', secret).update(sentence).digest('hex');
  const index = parseInt(hash.slice(0, 5), 16);
  return lastWordGroup[index % lastWordGroup.length];
}

/** Port of srv-serial-names `randomlyGenerateCombos(secret, delimiter, maxLength, numCombos)`. */
export function randomlyGenerateCombos(secret, delimiter, maxLength, numCombos) {
  const out = new Set();
  while (out.size < numCombos) {
    let sentence = '';
    for (let i = 0; i < WORDS.length - 1; i += 1) {
      sentence += WORDS[i][Math.floor(Math.random() * WORDS[i].length)] + delimiter;
    }
    sentence += calcLastWord(sentence, WORDS[WORDS.length - 1], secret);
    if (sentence.length <= maxLength && !out.has(sentence)) out.add(sentence);
  }
  return [...out];
}

export const FRIENDLY_ID_SECRET = 'bla bla';
export const FRIENDLY_ID_DELIMITER = '-';
export const FRIENDLY_ID_MAX_LENGTH = 25;

/** One source-shaped friendly id (the first of `randomlyGenerateCombos(..., 1)`). */
export const generateFriendlyId = () => randomlyGenerateCombos(
  FRIENDLY_ID_SECRET, FRIENDLY_ID_DELIMITER, FRIENDLY_ID_MAX_LENGTH, 1,
)[0];

export const WORD_COUNTS = { colors: WORDS[0].length, tech: WORDS[1].length, food: WORDS[2].length, fabrics: WORDS[3].length };
