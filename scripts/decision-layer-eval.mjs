#!/usr/bin/env node
// Evaluate the NLU decision layer against its invented case set, through the
// same code the parser service runs: the grammar parse, then decideCommand with
// a live engine. It needs a configured engine, and it sends each case's text to
// that engine (OpenRouter/TypeSafe for Jev):
//
//   ETCO_parser_decisionEngine=jev ETCO_parser_decisionApiKey=<openrouter key> \
//     node scripts/decision-layer-eval.mjs [--split dev|holdout|all] [--home] [--show]
//
// --home scores a robot whose owner linked Home Assistant: each turn takes the
// gateway's own route (packages/gateway/src/homeAssistantRoute.js) around the
// parse, so smart_home cases must reach Home Assistant and nothing else may.
// Without it, smart_home cases only need not to become a command.
//
// Every third case of each label is held out. Change the command wording or the
// thresholds against the dev split only, then run the held-out split once.
// See docs/DECISION-LAYER.md for the results this reproduces.

import { readFileSync } from 'node:fs';
import { parseRequestDetailedAsync } from '../packages/nlu/src/requestParser.js';
import { createDecisionClient, decideCommand, decisionKind, DECISION_COMMANDS } from '../packages/nlu/src/decisionLayer.js';
import { homeCommandCandidate, homeCommandEligible } from '../packages/gateway/src/homeAssistantRoute.js';

// packages/gateway/src/listenTransaction.js GLOBAL_TURN_RULES: a "Hey Jibo" turn.
const GLOBAL_RULES = ['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks'];
const args = process.argv.slice(2);
const split = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'dev';
const show = args.includes('--show');
const homeMode = args.includes('--home');
// A current connector: every routing capability, no owner shortcuts.
const SELECTION = { enabled: true, capabilities: ['room_context', 'state_queries', 'follow_up', 'routine_shortcuts'], shortcuts: [] };

const client = createDecisionClient();
if (!client.enabled) {
  console.error('Set ETCO_parser_decisionEngine=jev and ETCO_parser_decisionApiKey (an OpenRouter key) first.');
  process.exit(2);
}

const COMMANDS = new Set(Object.keys(DECISION_COMMANDS).filter((key) => DECISION_COMMANDS[key].intent));
const HOME = 'smart_home';

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

/** Chitchat and "none" only need not to become a command (or, for a home robot, a home command). */
function correct(label, route) {
  if (label === HOME && !homeMode) return !COMMANDS.has(route);
  if (label === 'chitchat' || label === 'none') return !COMMANDS.has(route) && route !== HOME;
  return route === label;
}

/**
 * One turn as the hub routes it. With --home, the gateway's direct-command fast
 * path runs before the parse and its Home Assistant route after it.
 * @returns {Promise<{route: string, parsed: object, decided: object|null, asked: boolean, ms: number|null}>}
 */
async function routeTurn(text) {
  if (homeMode && homeCommandCandidate(text, { selection: SELECTION })?.route.kind === 'command') {
    return { route: HOME, parsed: null, decided: null, asked: false, ms: null };
  }
  const home = homeMode && homeCommandEligible(text, {});
  const parsed = await parseRequestDetailedAsync({ text, rules: [...GLOBAL_RULES] });
  const asked = decisionKind(parsed, GLOBAL_RULES, { home }) !== null;
  const started = performance.now();
  const decided = await decideCommand({ text, rules: GLOBAL_RULES, ...(home ? { home: true } : {}) }, parsed, { client });
  const ms = asked ? performance.now() - started : null;
  const nlu = decided || parsed.nlu;
  const route = homeMode && homeCommandCandidate(text, { selection: SELECTION, nlu }) ? HOME : routed(nlu);
  return { route, parsed, decided, asked, ms };
}

/** The same turn without the decision layer. */
async function grammarRoute(text) {
  if (homeMode && homeCommandCandidate(text, { selection: SELECTION })?.route.kind === 'command') return HOME;
  const parsed = await parseRequestDetailedAsync({ text, rules: [...GLOBAL_RULES] });
  return homeMode && homeCommandCandidate(text, { selection: SELECTION, nlu: parsed.nlu }) ? HOME : routed(parsed.nlu);
}

const counters = {};
const cases = readFileSync(new URL('../packages/nlu/test/fixtures/decision-eval-cases.txt', import.meta.url), 'utf8')
  .split('\n').filter((line) => line.trim() && !line.startsWith('#')).map((line) => {
    const [label, text] = line.split(' | ').map((part) => part.trim());
    counters[label] = (counters[label] || 0) + 1;
    return { label, text, split: counters[label] % 3 === 0 ? 'holdout' : 'dev' };
  }).filter((entry) => split === 'all' || entry.split === split);

let grammarRight = 0; let layerRight = 0; let fixed = 0; let broken = 0; let wrongCommand = 0;
const home = { cases: 0, grammar: 0, layer: 0 };
const latencies = [];
const changes = [];
for (const entry of cases) {
  const { route: after, parsed, decided, ms } = await routeTurn(entry.text);
  if (ms !== null) latencies.push(ms);
  const before = await grammarRoute(entry.text);
  const was = correct(entry.label, before);
  const is = correct(entry.label, after);
  grammarRight += was; layerRight += is;
  if (entry.label === HOME) { home.cases += 1; home.grammar += was; home.layer += is; }
  if (!was && is) fixed += 1;
  if (was && !is) broken += 1;
  if ((COMMANDS.has(after) || after === HOME) && after !== entry.label && after !== before) wrongCommand += 1;
  if (show && (before !== after || !is)) {
    const from = parsed ? String(parsed.nlu?.intent) : '(fast path)';
    changes.push(`${is ? (was ? '  ' : '+ ') : (was ? '! ' : '- ')}${entry.label.padEnd(16)} ${entry.text.padEnd(42)} ${from.padEnd(24)} -> ${decided ? decided.intent : '(kept)'} => ${after}`);
  }
}
latencies.sort((a, b) => a - b);
const percent = (n) => `${((100 * n) / cases.length).toFixed(1)}%`;
const at = (q) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]) : 0);
console.log(`${split}${homeMode ? ' (home)' : ''}: ${cases.length} cases; the engine was asked about ${latencies.length}`);
console.log(`routed correctly: grammar alone ${grammarRight} (${percent(grammarRight)}), with the decision layer ${layerRight} (${percent(layerRight)})`);
console.log(`fixed ${fixed}, broken ${broken}, wrong command ${wrongCommand}`);
if (homeMode) console.log(`smart-home requests reaching Home Assistant: grammar alone ${home.grammar}/${home.cases}, with the decision layer ${home.layer}/${home.cases}`);
console.log(`decision latency: p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`);
if (show) console.log(changes.join('\n'));
