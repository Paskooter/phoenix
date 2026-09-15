#!/usr/bin/env node
// Generate Phoenix's LLM NLU intent catalog from Jibo's REAL intent surface.
//
// WHAT THE REAL SURFACE IS
// Jibo understood speech through two cooperating parsers, not one:
//
//   robust-parser/rules_src/   611 intents over 21 rule-set domains. This is
//                              where every utility lived: clock (askForTime,
//                              timerValue, alarmValue), hue-control, radio,
//                              gallery, create, settings, globals, greetings,
//                              who-am-i, report (commute / calendar / news).
//   dialogflow/main_agent/      99 intents. The ML backstop for the open-domain
//                              chitchat space only; 74 of them chitchat already
//                              covered by rule. It has no timer, light, radio,
//                              camera or settings intent at all.
//
// Union: 631 intents. Neither source alone is the catalog, which is why the
// Dialogflow-only catalog built earlier lost askForTime and the joke intents
// while the hand-written 15 invented names for them.
//
// WHAT THIS EMITS
// One tool per real intent, carrying its real name, its real slots, the rule-set
// domains it belongs to, and the scope the runtime gave it:
//
//   global    always available (globals/: stop, help, volume, mainMenu, ...)
//   skill     only while that skill's rule set is loaded (clock, radio, ...)
//   chitchat  the open-domain set, Dialogflow's ML territory
//
// Scope matters because a flat 631-tool prompt is not how Jibo worked and is not
// how a tool-calling model performs best. The router selects a working set:
// always-on globals, plus the active skill's domain, plus chitchat when idle.
//
// Usage:
//   node scripts/parity-nlu-catalog/build.mjs            # write the catalog
//   node scripts/parity-nlu-catalog/build.mjs --report   # summarise only

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFstIntents } from './fstIntents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const REFERENCE = '5c0a7390539663ba749d360de348a428c088505c';
const TREE = join(repo, '.parity/reference', REFERENCE);
const RULES = join(TREE, 'packages/parser/robust-parser/rules_src');
const AGENT = join(TREE, 'packages/parser/dialogflow/main_agent');

/** Dialogflow `@Type` -> a JSON-Schema fragment the tool-calling API accepts. */
function schemaForDialogflow(dataType) {
  const name = String(dataType || '').replace(/^@/, '');
  if (name === 'sys.date-time' || name === 'sys.date' || name === 'sys.time') {
    return { type: 'string', description: 'a date and/or time as the user said it' };
  }
  if (name === 'sys.duration') return { type: 'string', description: 'a duration as the user said it' };
  if (name === 'sys.number') return { type: 'number' };
  if (name.startsWith('sys.')) return { type: 'string', description: name };
  return { type: 'string', description: `${name} (Dialogflow entity category)` };
}

/** A rule slot carries no declared type, so it is described by its own name. */
function schemaForSlot(slot) {
  if (/^(hours|minutes|seconds|volumeLevel|itemPosition|number)$/i.test(slot)) return { type: 'number' };
  return { type: 'string', description: `${slot} as the user said it` };
}

function readDialogflowIntents() {
  const dir = join(AGENT, 'intents');
  if (!existsSync(dir)) throw new Error(`the Dialogflow agent is not present at ${dir}`);
  const files = readdirSync(dir);
  const byName = new Map();
  for (const file of files) {
    if (!file.endsWith('.json') || file.includes('usersays')) continue;
    const intent = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const params = (intent.responses?.[0]?.parameters || [])
      .filter((param) => param?.name && param.name !== 'undefined');
    // The intent's own training phrases: verbatim human text, so they make far
    // better tool descriptions than anything rendered out of the FST grammar.
    const saysFile = files.find((f) => f.startsWith(`${intent.name}_usersays`));
    let examples = [];
    if (saysFile) {
      try {
        const rows = JSON.parse(readFileSync(join(dir, saysFile), 'utf8'));
        examples = (Array.isArray(rows) ? rows : [])
          .map((row) => (row?.data || []).map((part) => part.text).join('').trim())
          .filter((text) => text && !text.includes('@'));
      } catch { examples = []; }
    }
    byName.set(intent.name, { name: intent.name, params, examples });
  }
  return byName;
}

/** Which working set an intent belongs to, from the rule-set directories it is in. */
function scopeOf(ruleDomains) {
  if (ruleDomains.has('globals')) return 'global';
  if (ruleDomains.has('chitchat')) return 'chitchat';
  return 'skill';
}

export function buildCatalog() {
  const fst = readFstIntents(RULES);
  const df = readDialogflowIntents();

  const names = new Set([...fst.keys(), ...df.keys()]);
  names.delete('decoyIntent'); // Dialogflow's negative-training discard
  names.delete('wildcard');    // the FST catch-all, not an intent
  names.delete('noMatch');     // both map onto the `unknown` sentinel below

  const tools = [];
  for (const name of [...names].sort()) {
    const rule = fst.get(name);
    const agent = df.get(name);

    const properties = {};
    for (const param of agent?.params || []) properties[param.name] = schemaForDialogflow(param.dataType);
    for (const slot of rule?.slots || []) {
      if (!properties[slot]) properties[slot] = schemaForSlot(slot);
    }

    // Verbatim training phrases first, then phrases rendered from the grammar.
    const examples = [...new Set([...(agent?.examples || []).slice(0, 2), ...(rule?.examples || [])])].slice(0, 3);
    const ruleDomains = rule ? rule.ruleDomains : new Set(['chitchat']);

    tools.push({
      name,
      description: examples.length
        ? `e.g. ${examples.map((text) => `"${text}"`).join(', ')}`
        : `the ${name} intent`,
      entities: { type: 'object', properties, required: [] },
      scope: scopeOf(ruleDomains),
      // Reachable from idle: the runtime compiled every domain's launch.rule
      // into one launch.fst, so that union is what Jibo could hear with no
      // skill running. Everything else needs its rule set loaded first.
      launch: rule ? [...rule.files].some((file) => file.endsWith('/launch.rule')) : true,
      // The rule-set directories the intent is defined in: what the router
      // loads. `emits` is the domain the match is tagged with downstream, which
      // is not always the same (clock/ defines timerValue but emits `timer`).
      domains: [...ruleDomains].sort(),
      emits: rule ? [...rule.domains].sort() : [],
      source: {
        reference: REFERENCE,
        fst: rule ? [...rule.files].sort() : [],
        dialogflow: agent ? `main_agent/intents/${name}.json` : null,
      },
    });
  }

  // The sentinel the handler uses to mean "no match". Both parsers had one:
  // Dialogflow's decoyIntent and the rules' noMatch / wildcard.
  tools.push({
    name: 'unknown',
    description: 'the utterance matches none of the other intents',
    entities: { type: 'object', properties: {}, required: [] },
    scope: 'global',
    launch: true,
    domains: ['globals'],
    emits: [],
    source: { reference: REFERENCE, fst: [], dialogflow: 'main_agent/intents/decoyIntent.json' },
  });
  return tools;
}

function main() {
  const report = process.argv.includes('--report');
  const tools = buildCatalog();
  const byScope = {};
  const byDomain = {};
  for (const tool of tools) {
    byScope[tool.scope] = (byScope[tool.scope] || 0) + 1;
    for (const domain of tool.domains) byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  if (!report) {
    const out = join(repo, 'packages/nlu/src/generatedIntentCatalog.json');
    writeFileSync(out, `${JSON.stringify({
      schema: 'phoenix.nlu.intent-catalog.v2',
      generatedFrom: {
        rules: 'packages/parser/robust-parser/rules_src',
        agent: 'packages/parser/dialogflow/main_agent',
        reference: REFERENCE,
      },
      note: 'Generated by scripts/parity-nlu-catalog/build.mjs. Do not hand-edit.',
      tools,
    }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  console.log(JSON.stringify({
    tools: tools.length,
    withSlots: tools.filter((tool) => Object.keys(tool.entities.properties).length > 0).length,
    withExample: tools.filter((tool) => tool.description.startsWith('e.g.')).length,
    launchReachable: tools.filter((tool) => tool.launch).length,
    byScope,
    byDomain,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
