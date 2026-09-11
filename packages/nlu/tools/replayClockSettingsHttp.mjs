// N-03 runtime replay: every clock/settings/main-menu fixture through the real
// NLU request path, plus the narrowing probe for the two time-factory rules.
//
// Phases over the same fixture (test/fixtures/clock-settings-menu.json):
//   1  parseRequest()          — the exact entry the HTTP handler calls.
//   2  POST /v1/parse          — a live service bound to an ephemeral port.
//   3  narrowing probe         — the arm-level outcome of the two gated rules
//      if the whole-rule refusal were removed (gate-free matcher context mirroring
//      requestParser.js:226-238). Proves the AM/PM arm matches AND that a time
//      utterance becomes a silent no-match instead of the shipped refusal.
//
// Usage: node packages/nlu/tools/replayClockSettingsHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../src/requestParser.js';
import { parse as parseRules } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';
import { start } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'resources');
const fixtureBytes = readFileSync(new URL('../test/fixtures/clock-settings-menu.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url), 'utf8'));
if (fixture.referenceRevision !== inventory.referenceRevision) {
  throw new Error(`N-03 fixture referenceRevision ${fixture.referenceRevision} != inventory ${inventory.referenceRevision}`);
}

const stableValue = value => (value === null || value === undefined ? 'null' : JSON.stringify(
  value,
  (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v),
));
const same = (a, b) => stableValue(a) === stableValue(b);
const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });

const rows = [];
for (const row of fixture.namedRules) {
  for (const c of row.cases) rows.push({ id: `${row.rule}:${c.kind}:${c.text}`, request: { text: c.text, rules: [row.rule] }, expected: c.expect });
}
const refusals = [];
for (const row of fixture.timeRules) {
  for (const text of row.refusalUtterances) refusals.push({ id: `${row.rule}:${text}`, request: { text, rules: [row.rule] }, error: row.error });
}

// --- phase 1: direct parseRequest -------------------------------------------
const directRows = [];
for (const row of rows) {
  let got = null; let error = null; let status = 200;
  try { got = norm(parseRequest(row.request)); } catch (e) { status = 500; error = e.message; }
  directRows.push({ ...row, status, got, error, matches: status === 200 && same(got, row.expected) });
}
const directRefusals = [];
for (const row of refusals) {
  let error = null;
  try { parseRequest(row.request); } catch (e) { error = e.message; }
  directRefusals.push({ ...row, status: error ? 500 : 200, error, matches: error === row.error });
}

// --- phase 2: live HTTP ------------------------------------------------------
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const httpRows = [];
const httpRefusals = [];
try {
  for (const row of rows) {
    const response = await fetch(`${base}/v1/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'NLU', data: row.request }) });
    const body = await response.json().catch(() => null);
    const got = body && body.data ? norm(body.data) : null;
    httpRows.push({ id: row.id, status: response.status, got, matches: response.status === 200 && same(got, row.expected) });
  }
  for (const row of refusals) {
    const response = await fetch(`${base}/v1/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'NLU', data: row.request }) });
    httpRefusals.push({ id: row.id, status: response.status, matches: response.status === 500 });
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

// --- phase 3: narrowing probe (gate-free matcher context) --------------------
function matchWithoutGate(ruleName, text) {
  const merged = {};
  for (const source of inventory.publicRules[ruleName].sources) {
    Object.assign(merged, parseRules(readFileSync(join(RES, 'rules-src', `${source}.rule`), 'utf8')).rules);
  }
  const factories = {};
  for (const entry of Object.values(inventory.factories)) {
    Object.assign(factories, parseRules(readFileSync(join(RES, entry.path), 'utf8')).rules);
  }
  return matchRule(merged.TopRule, tokenize(text), {
    rules: Object.assign({}, factories, merged),
    strictFactories: true,
    factoryHook: name => (inventory.factoryDependencies[name]?.status === 'unsupported' ? null : factories[name]),
  });
}
const narrowingProbe = {};
for (const [rule, texts] of [
  ['clock/alarm_timer_ampm', ['am', 'pm', 'a.m.', 'p.m.', 'noon', 'morning', 'seven thirty']],
  ['clock/alarm_set_value', ['one day from now', '3 days', 'seven thirty am', 'set an alarm for 7:30']],
]) {
  narrowingProbe[rule] = texts.map(text => {
    const match = matchWithoutGate(rule, text);
    return {
      text,
      narrowedMatch: Boolean(match),
      intent: match?.entities?.intent ?? null,
      ampm: match?.entities?.ampm ?? null,
      time: match?.entities?.time ?? null,
    };
  });
}
const timeParse = (() => { try { parseRules(readFileSync(join(RES, 'factory-sources', 'time.grm'), 'utf8')); return 'parses'; } catch (e) { return e.message; } })();

const directDifferences = directRows.filter(row => !row.matches);
const directRefusalDifferences = directRefusals.filter(row => !row.matches);
const httpDifferences = httpRows.filter(row => !row.matches);
const httpRefusalDifferences = httpRefusals.filter(row => !row.matches);
const runtime = getCompiledFstRuntime();
const out = {
  schema: 'phoenix.nlu.n03-clock-settings-menu-replay',
  referenceRevision: fixture.referenceRevision,
  fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  profile: runtime ? 'compiled-fst' : 'ast',
  namedRuleCoverage: fixture.namedRules.length + fixture.timeRules.length,
  matchCases: rows.length,
  refusalCases: refusals.length,
  directMatches: directRows.filter(row => row.matches).length,
  directRefusals: directRefusals.filter(row => row.matches).length,
  httpMatches: httpRows.filter(row => row.matches).length,
  httpRefusals: httpRefusals.filter(row => row.matches).length,
  differences: {
    direct: directDifferences.map(row => row.id),
    directRefusals: directRefusalDifferences.map(row => row.id),
    http: httpDifferences.map(row => row.id),
    httpRefusals: httpRefusalDifferences.map(row => row.id),
  },
  timeFactorySourceParse: timeParse,
  narrowingProbe,
  directRows,
  directRefusalRows: directRefusals,
  httpRows,
  httpRefusalRows: httpRefusals,
};

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target)) throw new Error(`refusing to overwrite existing ${target}`);
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`profile                 : ${out.profile}`);
console.log(`reference revision      : ${out.referenceRevision}`);
console.log(`fixture                 : ${out.fixtureSha256}`);
console.log(`named-rule coverage     : ${out.namedRuleCoverage}`);
console.log(`match cases             : ${out.matchCases}`);
console.log(`direct parseRequest     : ${out.directMatches}/${out.matchCases}`);
console.log(`live HTTP /v1/parse     : ${out.httpMatches}/${out.matchCases}`);
console.log(`refusal cases (thrown)  : ${out.directRefusals}/${out.refusalCases}`);
console.log(`refusal cases (HTTP 500): ${out.httpRefusals}/${out.refusalCases}`);
console.log(`time.grm parse          : ${out.timeFactorySourceParse}`);
console.log(`narrowing probe         :`);
for (const [rule, probes] of Object.entries(narrowingProbe)) {
  console.log(`  ${rule}`);
  for (const p of probes) console.log(`    ${JSON.stringify(p.text)} -> match=${p.narrowedMatch} intent=${JSON.stringify(p.intent)} ampm=${JSON.stringify(p.ampm)} time=${JSON.stringify(p.time)}`);
}
const bad = directDifferences.length + directRefusalDifferences.length + httpDifferences.length + httpRefusalDifferences.length;
process.exitCode = bad ? 1 : 0;
