// N-04 runtime replay: identity / introduction / greeting follow-up rules
// through the real NLU request path.
//
// Three phases over the SAME fixture set (test/fixtures/identity-intro-greetings.json):
//   phase 1  parseRequest()   — the exact entry the HTTP handler calls.
//   phase 2  POST /v1/parse   — a live service bound to an ephemeral port.
//   phase 3  native oracle    — the `basis:"native"` launch rows compared with
//            resources/legacy-oracle/golden.jsonl (nativeSourceRevision 91b1bb6).
//
// Fixture sections: namedRules (the 21 introductions/who-am-i/greetings public
// rules), launchIntents (their */launch graphs through the launch union),
// noInput, ambiguous (two members sharing a first name) and transcripts
// (multi-turn robot turns with known/unknown loop members).
//
// Usage: node packages/nlu/tools/replayIdentityIntroHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';
import { start } from '../src/index.js';

const fixtureBytes = readFileSync(new URL('../test/fixtures/identity-intro-greetings.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url), 'utf8'));
if (fixture.referenceRevision !== inventory.referenceRevision) {
  throw new Error(`N-04 fixture referenceRevision ${fixture.referenceRevision} != inventory ${inventory.referenceRevision}`);
}

const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};
const same = (a, b) => stable(a) === stable(b);

const rows = [];
for (const row of fixture.launchIntents) rows.push({ section: 'launchIntents', id: row.id, basis: row.basis, request: { text: row.text, rules: row.rules }, expected: row.expect });
for (const row of fixture.namedRules) {
  for (const positive of row.positives) rows.push({ section: 'namedRules', id: `${row.rule}:pos:${positive.text}`, request: { text: positive.text, rules: [row.rule] }, expected: positive.expect });
  if (row.negative) rows.push({ section: 'namedRules', id: `${row.rule}:neg`, request: { text: row.negative.text, rules: [row.rule] }, expected: row.negative.expect });
}
for (const row of fixture.noInput) rows.push({ section: 'noInput', id: row.id, request: { text: row.text, rules: row.rules }, expected: { entities: null, intent: null, rules: [] } });
for (const row of fixture.ambiguous) rows.push({ section: 'ambiguous', id: row.id, request: row, expected: row.expect });
for (const transcript of fixture.transcripts) {
  transcript.turns.forEach((turn, index) => {
    const request = { text: turn.text, rules: turn.rules };
    if (transcript.loop) request.loop = transcript.loop;
    rows.push({ section: 'transcripts', id: `${transcript.id}#${index}`, request, expected: turn.expect });
  });
}

// --- phase 1: direct parseRequest -------------------------------------------
const directRows = rows.map(row => {
  let status = 200;
  let got = null;
  let error = null;
  try { got = norm(parseRequest(row.request)); }
  catch (e) { status = 500; error = e.message; }
  return { ...row, status, got, error, matches: status === 200 && same(got, row.expected) };
});

// --- phase 2: live HTTP ------------------------------------------------------
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const httpRows = [];
try {
  for (const row of rows) {
    const response = await fetch(`${base}/v1/parse`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: row.request }),
    });
    const body = await response.json().catch(() => null);
    const got = body && body.data ? norm(body.data) : null;
    httpRows.push({ ...row, status: response.status, got, matches: response.status === 200 && same(got, row.expected) });
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// --- phase 3: native oracle cross-check --------------------------------------
const oracle = new Map();
for (const line of readFileSync(new URL('../resources/legacy-oracle/golden.jsonl', import.meta.url), 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const entries = JSON.parse(trimmed);
  if (!entries.length) continue;
  const { NLParse } = entries[0];
  const { intent, priority, ...entities } = NLParse;
  oracle.set(entries[0].Input, { intent, entities });
}
const oracleRows = directRows
  .filter(row => row.basis === 'native')
  .map(row => {
    const anchor = oracle.get(row.request.text);
    return { id: row.id, text: row.request.text, expected: row.expected, anchor, matches: Boolean(anchor) && same({ entities: row.expected.entities, intent: row.expected.intent }, anchor) };
  });

const directDifferences = directRows.filter(row => !row.matches);
const httpDifferences = httpRows.filter(row => !row.matches);
const oracleDifferences = oracleRows.filter(row => !row.matches);
const runtime = getCompiledFstRuntime();
const out = {
  schema: 'phoenix.nlu.n04-identity-intro-greetings-replay',
  referenceRevision: fixture.referenceRevision,
  fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  profile: runtime ? 'compiled-fst' : 'ast',
  namedRuleCoverage: fixture.namedRules.length,
  transcripts: fixture.transcripts.length,
  cases: rows.length,
  directMatches: directRows.filter(row => row.matches).length,
  httpMatches: httpRows.filter(row => row.matches).length,
  oracleCases: oracleRows.length,
  oracleMatches: oracleRows.filter(row => row.matches).length,
  differences: {
    direct: directDifferences.map(row => row.id),
    http: httpDifferences.map(row => row.id),
    oracle: oracleDifferences.map(row => row.id),
  },
  directRows,
  httpRows,
  oracleRows,
};

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target)) throw new Error(`refusing to overwrite existing ${target}`);
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`profile                : ${out.profile}`);
console.log(`reference revision     : ${out.referenceRevision}`);
console.log(`fixture                : ${out.fixtureSha256}`);
console.log(`named-rule coverage    : ${out.namedRuleCoverage}`);
console.log(`transcripts            : ${out.transcripts}`);
console.log(`cases                  : ${out.cases}`);
console.log(`direct parseRequest    : ${out.directMatches}/${out.cases}`);
console.log(`live HTTP /v1/parse    : ${out.httpMatches}/${out.cases}`);
console.log(`native oracle          : ${out.oracleMatches}/${out.oracleCases}`);
console.log(`direct differences     : ${directDifferences.length ? directDifferences.map(row => row.id).join(', ') : 'none'}`);
console.log(`http differences       : ${httpDifferences.length ? httpDifferences.map(row => row.id).join(', ') : 'none'}`);
for (const row of directDifferences.slice(0, 20)) {
  console.log(`  ${row.id}\n    expected ${stable(row.expected)}\n    got      ${stable(row.got)}`);
}
process.exitCode = directDifferences.length || httpDifferences.length || oracleDifferences.length ? 1 : 0;
