// Chitchat MIM library — the real reference content (vendored from
// chitchat-skill/mims + res/semi_specific_categories) and the lookup structures
// the reference Chitchat class builds over it (Chitchat.ts:44-53):
//   - per-directory MIM id sets (scripted / emotion / fallback)
//   - semiSpecificStemMapping: `X_SS_<Category>` mim ids grouped by stem `X_SS`
//   - semiSpecificCategoryMapping: category CSV basename -> member Values
// Loaded once, lazily.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'mims', 'chitchat');

export const MIM_DIRS = {
  SCRIPTED: join(ROOT, 'scripted-responses'),
  EMOTION: join(ROOT, 'emotion-responses'),
  FALLBACK: join(ROOT, 'core-responses'),
};
const SEMI_SPECIFIC_DIR = join(ROOT, 'semi_specific_categories');

let lib = null;

function mimSet(dir) {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.mim')).map((f) => f.slice(0, -4)));
}

// Chitchat.generateSemiSpecificStemMapping: catalog `_SS_` mims by stem.
function stemMapping(scripted) {
  const out = {};
  for (const mimID of scripted) {
    if (!/_SS_/.test(mimID)) continue;
    const parts = mimID.split('_');
    const stem = parts.slice(0, -1).join('_');
    const category = parts[parts.length - 1];
    if (!stem || !category) continue;
    (out[stem] = out[stem] || []).push(category);
  }
  return out;
}

// Chitchat.generateSemiSpecificCategoryMapping: category (csv basename) -> Value column.
function categoryMapping() {
  const out = {};
  if (!existsSync(SEMI_SPECIFIC_DIR)) return out;
  for (const f of readdirSync(SEMI_SPECIFIC_DIR)) {
    if (!f.endsWith('.csv')) continue;
    const category = f.slice(0, -4);
    const lines = readFileSync(join(SEMI_SPECIFIC_DIR, f), 'utf8').split(/\r?\n/);
    const values = [];
    for (let i = 1; i < lines.length; i += 1) {       // skip the `Value,Synonyms` header
      const line = lines[i].trim();
      if (!line) continue;
      const value = line.split(',')[0].trim().replace(/^"|"$/g, '');
      if (value) values.push(value);
    }
    out[category] = values;
  }
  return out;
}

export function getLibrary() {
  if (lib) return lib;
  const scripted = mimSet(MIM_DIRS.SCRIPTED);
  lib = {
    scripted,
    emotion: mimSet(MIM_DIRS.EMOTION),
    fallback: mimSet(MIM_DIRS.FALLBACK),
    semiSpecificStems: stemMapping(scripted),
    semiSpecificCategories: categoryMapping(),
  };
  return lib;
}
