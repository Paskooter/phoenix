// N-01 per-rule probe: request every named public rule exactly once and report
// which requests are honoured and which are refused, with the refusal reason.
//
// This is the "load every named rule" observable. RobustParserClient.init()
// (RobustParserClient.ts:40-50) compiles every discovered rule before serving,
// and handleNLU throws `No rules known by Robust Parser` rather than dropping an
// unknown name, so a requested rule must be accounted for: honoured or refused
// with a reason — never silently reduced to a no-match.
//
// Usage: node packages/nlu/tools/probeNamedRules.mjs [--text "five minutes"]
import { readFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';

const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url)));
const names = Object.keys(inventory.publicRules).sort();
const textIndex = process.argv.indexOf('--text');
const text = textIndex !== -1 ? process.argv[textIndex + 1] : 'five minutes';

const runtime = getCompiledFstRuntime();
const profile = runtime ? 'compiled-fst' : 'ast';

const honored = [];
const refused = [];
for (const name of names) {
  try {
    const result = parseRequest({ text, rules: [name] });
    honored.push([name, result.intent]);
  } catch (error) {
    refused.push([name, error.message]);
  }
}

console.log(`profile       : ${profile}`);
console.log(`probe text    : ${JSON.stringify(text)}`);
console.log(`named rules   : ${names.length}`);
console.log(`honored       : ${honored.length}`);
console.log(`refused       : ${refused.length}`);
for (const [name, message] of refused) console.log(`  ${name}: ${message}`);
process.exitCode = refused.length ? 1 : 0;
