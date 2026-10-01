#!/usr/bin/env node
// Evaluate the NLU decision layer against its invented case set, through the
// same code the parser service runs: the grammar parse, then decideCommand with
// a live engine. It needs a configured engine, and it sends each case's text to
// that engine (OpenRouter/TypeSafe for Jev):
//
//   ETCO_parser_decisionEngine=jev ETCO_parser_decisionApiKey=<openrouter key> \
//     node scripts/decision-layer-eval.mjs [--split dev|holdout|all] [--show]
//
// Every third case of each label is held out. Change the command wording or the
// thresholds against the dev split only, then run the held-out split once.
// See docs/DECISION-LAYER.md for the results this reproduces.

import { readFileSync } from 'node:fs';
import { parseRequestDetailedAsync } from '../packages/nlu/src/requestParser.js';
import { createDecisionClient, decideCommand, decisionKind, DECISION_COMMANDS } from '../packages/nlu/src/decisionLayer.js';

// packages/gateway/src/listenTransaction.js GLOBAL_TURN_RULES: a "Hey Jibo" turn.
const GLOBAL_RULES = ['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks'];
const args = process.argv.slice(2);
const split = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'dev';
const show = args.includes('--show');

const client = createDecisionClient();
if (!client.enabled) {
  console.error('Set ETCO_parser_decisionEngine=jev and ETCO_parser_decisionApiKey (an OpenRouter key) first.');
  process.exit(2);
}

const COMMANDS = new Set(Object.keys(DECISION_COMMANDS).filter((key) => DECISION_COMMANDS[key].intent));

/** What the hub would do with a parse, in the case set's labels. */
function routed(nlu) {
  if (!nlu?.intent) return 'none';
  const e = nlu.entities || {};
  for (const [key, command] of Object.entries(DECISION_COMMANDS)) {
    if (!command.intent || command.intent !== nlu.intent) continue;
    if (key === 'weather_today' && e.date === 'tomorrow') continue;
    if (key === 'weather_tomorrow' && e.date !== 'tomorrow') continue;
    if (key === 'joke' && e.JiboContent !== 'Joke') continue;
    if (key === 'fun_fact' && e.JiboContent !== 'FunFact') continue;
    return key;
  }
  if (nlu.intent === 'requestTellSomething') return 'joke';
  if (/^general\w*Questions$/.test(nlu.intent)
    || ['whoIsPerson', 'requestTellAboutThing', 'whatDoesThingMean', 'requestWeather'].includes(nlu.intent)) return 'knowledge';
  return 'other';
}

/** Chitchat and "none" only need not to become a command. */
function correct(label, route) {
  if (label === 'chitchat' || label === 'none') return !COMMANDS.has(route);
  return route === label;
}

const counters = {};
const cases = readFileSync(new URL('../packages/nlu/test/fixtures/decision-eval-cases.txt', import.meta.url), 'utf8')
  .split('\n').filter((line) => line.trim() && !line.startsWith('#')).map((line) => {
    const [label, text] = line.split(' | ').map((part) => part.trim());
    counters[label] = (counters[label] || 0) + 1;
    return { label, text, split: counters[label] % 3 === 0 ? 'holdout' : 'dev' };
  }).filter((entry) => split === 'all' || entry.split === split);

let grammarRight = 0; let layerRight = 0; let fixed = 0; let broken = 0; let wrongCommand = 0;
const latencies = [];
const changes = [];
for (const entry of cases) {
  const parsed = await parseRequestDetailedAsync({ text: entry.text, rules: [...GLOBAL_RULES] });
  const asked = decisionKind(parsed, GLOBAL_RULES) !== null;
  const started = performance.now();
  const decided = await decideCommand({ text: entry.text, rules: GLOBAL_RULES }, parsed, { client });
  if (asked) latencies.push(performance.now() - started);
  const before = routed(parsed.nlu);
  const after = routed(decided || parsed.nlu);
  const was = correct(entry.label, before);
  const is = correct(entry.label, after);
  grammarRight += was; layerRight += is;
  if (!was && is) fixed += 1;
  if (was && !is) broken += 1;
  if (decided && COMMANDS.has(after) && after !== entry.label) wrongCommand += 1;
  if (show && (before !== after || !is)) {
    changes.push(`${is ? (was ? '  ' : '+ ') : (was ? '! ' : '- ')}${entry.label.padEnd(16)} ${entry.text.padEnd(42)} ${String(parsed.nlu?.intent).padEnd(24)} -> ${decided ? decided.intent : '(kept)'}`);
  }
}
latencies.sort((a, b) => a - b);
const percent = (n) => `${((100 * n) / cases.length).toFixed(1)}%`;
const at = (q) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]) : 0);
console.log(`${split}: ${cases.length} cases; the engine was asked about ${latencies.length}`);
console.log(`routed correctly: grammar alone ${grammarRight} (${percent(grammarRight)}), with the decision layer ${layerRight} (${percent(layerRight)})`);
console.log(`fixed ${fixed}, broken ${broken}, wrong command ${wrongCommand}`);
console.log(`decision latency: p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`);
if (show) console.log(changes.join('\n'));
