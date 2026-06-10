// Equivalent-words (homophone) support — the engine half of the reference's
// `!use_equivalent_words = true;` grammar directive. The vendored
// resources/data/eq_words.txt (from the jibo-nlu build data) holds one
// equivalence set per line ("2 two too to", "there their they're", …): words
// the ASR confuses are treated as equal during literal matching. Every word
// belongs to at most one set (verified), so each maps to a canonical
// representative (the first word of its line) and equality is canon(a) === canon(b).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'data', 'eq_words.txt');

let cached = null;

/** @returns {Map<string,string>} word -> canonical representative */
export function loadEqWords(path = DEFAULT_PATH) {
  if (cached && path === DEFAULT_PATH) return cached;
  const map = new Map();
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* missing file -> empty map */ }
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    for (const w of words) map.set(w, words[0]);
  }
  if (path === DEFAULT_PATH) cached = map;
  return map;
}

/** Are two (already normalized) tokens equal under the equivalence sets? */
export function eqEquals(map, a, b) {
  if (a === b) return true;
  if (!map) return false;
  const ca = map.get(a);
  return ca !== undefined && ca === map.get(b);
}
