// Historical alternate-engine diagnostic.
//
// Default mode replays the archived golden capture through the legacy AST
// matcher and reports intent parity. These saved expected values have
// incomplete provenance; production compatibility is graded by parity:gate.
//
// Production mode (`--production`) replays the same capture through the
// production request parser — the same parseRequest() entry the NLU HTTP
// handler calls, which selects the compiled-FST runtime when it is configured
// and the AST runtime otherwise — and additionally compares the exact entity
// values and types, reporting mismatches per feature (entity key).
//
// Usage:
//   node packages/nlu/tools/legacyOracleDiagnostic.mjs
//   node packages/nlu/tools/legacyOracleDiagnostic.mjs --production
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseRules } from '../src/grammar/parser.js';
import { matchRule, tokenize, parseScore } from '../src/grammar/matcher.js';

const PRODUCTION = process.argv.includes('--production');

const RES = new URL('../resources/grammar', import.meta.url).pathname;
const shared = {};
for (const dir of ['globals','shared']) for (const g of readdirSync(join(RES,dir))) {
  try { Object.assign(shared, parseRules(readFileSync(join(RES,dir,g),'utf8')).rules); } catch {}
}
const skills = [];
for (const s of readdirSync(join(RES,'skills'))) {
  const f = join(RES,'skills',s,'launch.rule');
  if (!existsSync(f)) continue;
  try { const ast = parseRules(readFileSync(f,'utf8'));
    const top = ast.rules.TopRule || ast.rules[Object.keys(ast.rules)[0]];
    skills.push({ id:s, rules:{...shared, ...ast.rules}, top });
  } catch(e){ console.error('skip',s,e.message); }
}
console.error(`loaded ${skills.length} skills`);

function parseUtt(text){
  const tokens = tokenize(text);
  let best=null, bestScore=-1;
  for (const sk of skills){
    let m=null; try { m = matchRule(sk.top, tokens, { rules: sk.rules }); } catch {}
    if(!m) continue;
    const score = parseScore(m.entities, m.specificity, m.cost);
    if(!best || score>bestScore){ best={ id:sk.id, ents:m.entities||{} }; bestScore=score; }
  }
  if(!best) return null;
  return { intent: best.ents.intent||'', skill: best.ents.skill||('@be/'+best.id) };
}

const golden = readFileSync(new URL('../resources/legacy-oracle/golden.jsonl', import.meta.url).pathname,'utf8').trim().split('\n').map(l=>{
  const arr = JSON.parse(l); const o=arr[0]||{}; return { input:o.Input, nl:o.NLParse||{} };
}).filter(g=>g.input && g.input!=='undefined');

let parseRequest = null;
if (PRODUCTION) {
  ({ parseRequest } = await import('../src/requestParser.js'));
  const { getCompiledFstRuntime } = await import('../src/compiledFstRuntime.js');
  console.log(`runtime: ${getCompiledFstRuntime() ? 'compiled-fst' : 'ast'} (PHOENIX_NLU_RUNTIME=${process.env.PHOENIX_NLU_RUNTIME || 'unset'})`);
}

const featureMisses = new Map();
const featureTotals = new Map();
const misses = [];
let intentHit=0, tot=0, valueMismatch=0;

// ParseRequestHandler returns `parserResult.nlu`, which is NLParse minus
// `intent` and `priority` (RobustParserClient.ts:95-102, 251-258): the wire
// result has no priority field, so the capture's priority is not comparable
// against a production response.
const WIRE_OMITTED = new Set(['priority']);

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

for (const g of golden){
  tot++;
  let got, gotIntent, gotEntities;
  if (PRODUCTION) {
    try {
      const r = parseRequest({ text: g.input, rules: ['launch'] });
      gotIntent = r.intent || '';
      gotEntities = r.entities || {};
      got = { intent: gotIntent, skill: gotEntities.skill };
    } catch (e) {
      misses.push(`  x ${JSON.stringify(g.input)}  production THROW ${e.message}`);
      bump(featureMisses, 'intent'); bump(featureTotals, 'intent');
      continue;
    }
  } else {
    got = parseUtt(g.input);
    gotIntent = got ? got.intent : '';
    gotEntities = {};
  }
  const want = g.nl.intent||'';
  if (got && gotIntent===want && want) intentHit++;
  else if (!PRODUCTION) misses.push(`  x "${g.input}"  want=${want||'-'}  got=${got?got.intent||'(nomatch-intent)':'NOMATCH'}`);

  if (PRODUCTION) {
    // Exact value + type comparison per entity feature the capture declares.
    for (const [key, expected] of Object.entries(g.nl)) {
      if (key === 'intent' || WIRE_OMITTED.has(key)) continue;
      bump(featureTotals, key);
      const actual = Object.prototype.hasOwnProperty.call(gotEntities, key) ? gotEntities[key] : undefined;
      const expectedIsNullString = expected === 'null';
      const actualIsNullString = actual === 'null';
      const same = expectedIsNullString || actualIsNullString
        ? expectedIsNullString === actualIsNullString
        : (actual !== undefined && typeof actual === typeof expected && actual === expected);
      if (!same) {
        bump(featureMisses, key);
        valueMismatch++;
        misses.push(`  x ${JSON.stringify(g.input)}  ${key}: want=${JSON.stringify(expected)} (${typeof expected})  got=${JSON.stringify(actual)} (${typeof actual})`);
      }
    }
  }
}

console.log(`\nINTENT PARITY: ${intentHit}/${tot} (${Math.round(100*intentHit/tot)}%)`);
if (PRODUCTION) {
  console.log(`ENTITY FEATURE TOTALS: ${[...featureTotals.entries()].sort().map(([k,v])=>`${k}=${v}`).join(' ')}`);
  console.log(`ENTITY FEATURE MISMATCHES: ${featureMisses.size ? [...featureMisses.entries()].sort().map(([k,v])=>`${k}=${v}`).join(' ') : 'none'}`);
  console.log(`ENTITY VALUE/TYPE MISMATCHES: ${valueMismatch}`);
}
console.log('MISSES:\n'+misses.join('\n'));
process.exitCode = misses.length ? 1 : 0;
