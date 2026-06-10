import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseRules } from '../../src/grammar/parser.js';
import { matchRule, tokenize, parseScore } from '../../src/grammar/matcher.js';

const RES = new URL('../../resources/grammar', import.meta.url).pathname;
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

const golden = readFileSync(new URL('./golden.jsonl', import.meta.url).pathname,'utf8').trim().split('\n').map(l=>{
  const arr = JSON.parse(l); const o=arr[0]||{}; return { input:o.Input, nl:o.NLParse||{} };
}).filter(g=>g.input && g.input!=='undefined');
let intentHit=0, tot=0; const misses=[];
for (const g of golden){
  tot++;
  const got = parseUtt(g.input);
  const want = g.nl.intent||'';
  if (got && got.intent===want && want) intentHit++;
  else misses.push(`  x "${g.input}"  want=${want||'-'}  got=${got?got.intent||'(nomatch-intent)':'NOMATCH'}`);
}
console.log(`\nINTENT PARITY: ${intentHit}/${tot} (${Math.round(100*intentHit/tot)}%)`);
console.log('MISSES:\n'+misses.join('\n'));
