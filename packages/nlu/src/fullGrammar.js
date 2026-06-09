// Full real-grammar NLU stage.
//
// Loads the COMPLETE set of real Jibo launch grammars vendored under
// resources/grammar/ (the actual rules_src from the reference parser: chitchat,
// clock, hue-control, report, every be-skill, plus the shared/global sub-rules),
// and parses an utterance against all of them with the real engine's priority
// arbitration (HIGH > unset > LOW, then heuristic score). This is what lets
// Jibo respond to the long tail of requests the hand-vendored stubs never
// covered — "sing me a song", "can you dance", "i love you", "turn on the
// lights", "tell me a joke", emotion/loop/personality intents, etc.
//
// Used as a FALLBACK stage in the NLU pipeline (after the legacy be-skill launch
// grammars and the question grammar), so it only ever ADDS matches where the
// earlier stages found nothing — it can't change existing routing.
//
// No binaries, no archive dependency: the grammars are plain text in the repo
// and the matcher is pure JS. The reference `jibo-nlu` binary is used only
// offline as a grading oracle (test/oracle/), never at runtime.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseRules } from './grammar/parser.js';
import { matchRule, tokenize, parseScore } from './grammar/matcher.js';

const GRAMMAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'grammar');

let loaded = null;

function load() {
  if (loaded) return loaded;
  // Shared + global sub-rules are visible to every skill grammar (they reference
  // e.g. $KU_PREFIXES, wildcard/yes_no helpers). Merge them as a base namespace.
  const shared = {};
  for (const dir of ['globals', 'shared']) {
    const d = join(GRAMMAR_ROOT, dir);
    if (!existsSync(d)) continue;
    for (const g of readdirSync(d)) {
      try { Object.assign(shared, parseRules(readFileSync(join(d, g), 'utf8')).rules); }
      catch { /* skip an unparseable helper rather than break the whole stage */ }
    }
  }
  // NOTE: the global-command TopRules (stop / set volume / go to sleep / GUI nav)
  // are intentionally NOT matched as skills yet — their HIGH-priority `$w03 X $w03`
  // arms over-trigger without the reference's strict-arm weighting, regressing
  // e.g. "what year is it". Tuning + loading them is a follow-up iteration.
  const skills = [];
  const skillsDir = join(GRAMMAR_ROOT, 'skills');
  if (existsSync(skillsDir)) {
    for (const s of readdirSync(skillsDir)) {
      const f = join(skillsDir, s, 'launch.rule');
      if (!existsSync(f)) continue;
      try {
        const ast = parseRules(readFileSync(f, 'utf8'));
        const top = ast.rules.TopRule || ast.rules[Object.keys(ast.rules)[0]];
        if (top) skills.push({ id: s, rules: { ...shared, ...ast.rules }, top });
      } catch { /* skip a grammar that fails to parse */ }
    }
  }
  loaded = { skills };
  return loaded;
}

/**
 * Parse an utterance against every real grammar; return the priority-arbitrated
 * best as a reference-shaped NLUResult, or null on no match.
 * @param {string} text
 * @returns {null|{rules:string[], intent:string, entities:object}}
 */
export function fullParse(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const { skills } = load();
  let best = null; let bestScore = -1;
  for (const sk of skills) {
    let m = null;
    try { m = matchRule(sk.top, tokens, { rules: sk.rules }); } catch { /* skip */ }
    if (!m) continue;
    const score = parseScore(m.entities, m.specificity);
    if (!best || score > bestScore) { best = { id: sk.id, m }; bestScore = score; }
  }
  if (!best) return null;
  const ent = best.m.entities || {};
  if (!ent.intent && !ent.skill) return null; // a bare wildcard match is not usable
  // Default the skill entity to the matched grammar's skill id so the gateway
  // can route on-robot skills that set only an intent.
  if (!ent.skill) ent.skill = `@be/${best.id}`;
  return { rules: ['launch'], intent: ent.intent || '', entities: ent };
}

// Test/diagnostic hook: expose the loaded skill count.
export function _loadedSkillCount() { return load().skills.length; }
