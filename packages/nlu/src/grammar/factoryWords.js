// Word-list factories — the finite `$factory:NAME` vocabularies, extracted as
// plain text from the reference jibo-nlu factory FSTs (resources/factory-words/*:
// first_name 6,007 · last_name 20,027 · music_genre 96 · country 269 · state 84 ·
// canada_province 16). A `$factory:first_name` slot now matches ONLY real names —
// previously the wildcard fallback let any 1-3 words through, so "i'm hungry"
// could read "hungry" as a name. Combinatorial factories (date/time/timer/digits/
// year/city_state/…) are loops, not lists; they keep the wildcard fallback.
//
// Index shape: name -> Map(firstToken -> Array<tokenArray>), longest phrases
// first so multi-word entries ("acid jazz") win over their prefixes.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'factory-words');

let cached = null;

function indexWords(text) {
  const byFirst = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const tokens = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    if (!byFirst.has(tokens[0])) byFirst.set(tokens[0], []);
    byFirst.get(tokens[0]).push(tokens);
  }
  for (const arr of byFirst.values()) arr.sort((a, b) => b.length - a.length);
  return byFirst;
}

/**
 * Build the index from already-verified word-list content.
 *
 * The request parser passes exactly the `factory-words/*` entries declared by
 * rule-inventory.json (whose bytes it hash-checked) instead of re-reading the
 * bundled directory, so a file that no inventory entry anchors cannot join the
 * matcher's vocabulary.
 *
 * @param {Array<{name: string, text: string}>} entries
 * @returns {Map<string, Map<string, string[][]>>}
 */
export function buildFactoryWords(entries) {
  const out = new Map();
  for (const entry of entries || []) out.set(entry.name, indexWords(entry.text));
  return out;
}

/**
 * Name of the first bundled `*.txt` word list that the inventory does not
 * declare, or null when the directory is fully covered. An undeclared file is a
 * matcher dependency with no hash anchor, so callers must refuse it instead of
 * importing it silently.
 *
 * @param {readonly string[]} declaredNames factory names, e.g. ['country']
 * @param {readonly string[]} actualFiles directory listing, e.g. ['country.txt']
 * @returns {string|null}
 */
export function undeclaredFactoryWordFile(declaredNames, actualFiles) {
  const declared = new Set((declaredNames || []).map(name => `${name}.txt`));
  const undeclared = [...(actualFiles || [])]
    .filter(file => file.endsWith('.txt') && !file.startsWith('.') && !declared.has(file))
    .sort();
  return undeclared[0] || null;
}

/** @returns {Map<string, Map<string, string[][]>>} factory name -> first-token index */
export function loadFactoryWords(dir = DIR) {
  if (cached && dir === DIR) return cached;
  const out = new Map();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue;
      out.set(f.slice(0, -4), indexWords(readFileSync(join(dir, f), 'utf8')));
    }
  }
  if (dir === DIR) cached = out;
  return out;
}
