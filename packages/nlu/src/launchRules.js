// Launch-rule NLU — the deterministic grammar stage for on-robot (be-skill) launches.
//
// Vendors the jibo-web-sim launch-rule engine (src/grammar/, the .rule DSL parser+matcher) and
// the be-skill launch.rule grammars (resources/rules/@be/*) + factory grammars. This is the SAME
// matcher the simulator uses, so be-skill launch parsing is identical on both sides. A match
// yields a reference-shaped NLUResult whose entities include `skill` (e.g. '@be/clock'), which the
// gateway's IntentRouter requires to route a be-skill launch.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './grammar/index.js';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');

let registryPromise = null;

/** Build (once) the launch-rule registry from the vendored grammars. */
export function getRegistry() {
  if (!registryPromise) registryPromise = build();
  return registryPromise;
}

async function build() {
  const reg = createRegistry();
  const ruleRoot = join(RES, 'rules', '@be');
  if (existsSync(ruleRoot)) {
    for (const skill of readdirSync(ruleRoot)) {
      const f = join(ruleRoot, skill, 'launch.rule');
      if (!existsSync(f)) continue;
      try { await reg.loadSkill(`@be/${skill}`, readFileSync(f, 'utf8'), { onRobot: true }); }
      catch { /* skip a grammar that fails to parse rather than break the whole NLU */ }
    }
  }
  const facDir = join(RES, 'factory');
  if (existsSync(facDir)) {
    for (const g of readdirSync(facDir)) {
      try { await reg.loadFactory(g.replace(/\.(grm|rule)$/, ''), readFileSync(join(facDir, g), 'utf8')); }
      catch { /* ignore a bad factory grammar */ }
    }
  }
  return reg;
}

/**
 * Parse an utterance against the be-skill launch grammars.
 * @param {string} text
 * @returns {Promise<null|{rules:string[], intent:string, entities:object}>}
 */
export async function launchParse(text) {
  const reg = await getRegistry();
  let r = null;
  try { r = reg.parse(text); } catch { r = null; }
  if (!r || !r.nlu) return null;
  const entities = r.nlu.entities || {};
  // A match is usable if it has an intent OR a skill entity — some launch grammars
  // (main-menu, who-am-i, circuit-saver, ifttt) emit only the skill entity.
  if (!r.nlu.intent && !entities.skill) return null;
  return { rules: ['launch'], intent: r.nlu.intent || '', entities };
}
