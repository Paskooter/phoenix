// Word-list factories — the finite `$factory:NAME` vocabularies, extracted as
// plain text from the reference jibo-nlu factory FSTs (resources/factory-words/*:
// first_name 6,008 · last_name 20,027 · music_genre 96 · country 269 · state 84 ·
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

/** @returns {Map<string, Map<string, string[][]>>} factory name -> first-token index */
export function loadFactoryWords(dir = DIR) {
  if (cached && dir === DIR) return cached;
  const out = new Map();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue;
      const name = f.slice(0, -4);
      const byFirst = new Map();
      for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
        const tokens = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) continue;
        if (!byFirst.has(tokens[0])) byFirst.set(tokens[0], []);
        byFirst.get(tokens[0]).push(tokens);
      }
      for (const arr of byFirst.values()) arr.sort((a, b) => b.length - a.length);
      out.set(name, byFirst);
    }
  }
  if (dir === DIR) cached = out;
  return out;
}
