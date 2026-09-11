// N-05 runtime replay: every device/content + global-command fixture through
// the real NLU request path.
//
// Two phases over the SAME fixture set:
//   phase 1  parseRequest()          — the exact entry the HTTP handler calls.
//   phase 2  POST /v1/parse          — a live service bound to an ephemeral port.
//
// Fixture: test/fixtures/device-content-globals.json (see its referenceRevision
// and per-row `source` / `anchor` citations). Sections:
//   globals          explicit global stop/repeat/thanks/navigation/volume intents
//   globalNegatives  non-command utterances that must NOT match a global rule
//   namedRules       positive (+ negative where one can exist) for all 98 named rules
//   interruption     global-interrupts-skill and skill-wins-over-global journeys
//   overTriggers     false-launch guards (a global must not steal a non-command)
//
// Usage: node packages/nlu/tools/replayDeviceContentHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';
import { start } from '../src/index.js';

const fixtureBytes = readFileSync(new URL('../test/fixtures/device-content-globals.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url), 'utf8'));
if (fixture.referenceRevision !== inventory.referenceRevision) {
  throw new Error(`N-05 fixture referenceRevision ${fixture.referenceRevision} != inventory ${inventory.referenceRevision}`);
}

const stable = value => JSON.stringify(value === undefined ? null : value);
const same = (a, b) => stable(a) === stable(b);
const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });

const rows = [];
function expectRow(section, id, request, expected) {
  rows.push({ section, id, request, expected });
}
for (const row of fixture.globals) expectRow('globals', row.id, { text: row.text, rules: [row.rule] }, row.expect);
for (const row of fixture.globalNegatives) expectRow('globalNegatives', row.id, { text: row.text, rules: [row.rule] }, row.expect);
for (const row of fixture.namedRules) {
  if (row.positive.unsupported) continue; // exercised as a documented refusal below
  expectRow('namedRules', `${row.rule}:positive`, { text: row.positive.text, rules: [row.rule] }, row.positive.expect);
  if (row.negative) expectRow('namedRules', `${row.rule}:negative`, { text: row.negative.text, rules: [row.rule] }, row.negative.expect);
}
for (const row of fixture.interruption) expectRow('interruption', row.id, { text: row.text, rules: row.rules }, row.expect);
for (const row of fixture.overTriggers) expectRow('overTriggers', row.id, { text: row.text, rules: row.rules }, row.expect);

const refusals = fixture.namedRules.filter(row => row.positive.unsupported).map(row => ({
  section: 'namedRules',
  id: `${row.rule}:unsupported`,
  request: { text: row.positive.text || 'five minutes', rules: [row.rule] },
  expectedError: row.positive.error,
}));

// --- phase 1: direct parseRequest -------------------------------------------
const directRows = [];
for (const row of rows) {
  let status = 200;
  let got;
  let error = null;
  try { got = parseRequest(row.request); }
  catch (e) { status = 500; error = e.message; got = null; }
  directRows.push({ ...row, status, got: got ? norm(got) : null, error, matches: status === 200 && same(got ? norm(got) : null, row.expected) });
}
for (const refusal of refusals) {
  let error = null;
  try { parseRequest(refusal.request); } catch (e) { error = e.message; }
  directRows.push({ ...refusal, status: error ? 500 : 200, got: null, error, matches: error === refusal.expectedError });
}

// --- phase 2: live HTTP ------------------------------------------------------
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const httpRows = [];
try {
  for (const row of rows) {
    const response = await fetch(`${base}/v1/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: row.request }),
    });
    const body = await response.json().catch(() => null);
    const got = body && body.data ? norm(body.data) : null;
    httpRows.push({ ...row, status: response.status, got, matches: response.status === 200 && same(got, row.expected) });
  }
  for (const refusal of refusals) {
    const response = await fetch(`${base}/v1/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: refusal.request }),
    });
    httpRows.push({ ...refusal, status: response.status, got: null, matches: response.status === 500 });
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const directDifferences = directRows.filter(row => !row.matches);
const httpDifferences = httpRows.filter(row => !row.matches);
const runtime = getCompiledFstRuntime();
const out = {
  schema: 'phoenix.nlu.n05-device-content-globals-replay',
  referenceRevision: fixture.referenceRevision,
  fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  profile: runtime ? 'compiled-fst' : 'ast',
  cases: rows.length + refusals.length,
  directMatches: directRows.filter(row => row.matches).length,
  httpMatches: httpRows.filter(row => row.matches).length,
  differences: { direct: directDifferences.map(row => row.id), http: httpDifferences.map(row => row.id) },
  namedRuleCoverage: fixture.namedRules.length,
  directRows,
  httpRows,
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
console.log(`cases                  : ${out.cases}`);
console.log(`direct parseRequest    : ${out.directMatches}/${out.cases}`);
console.log(`live HTTP /v1/parse    : ${out.httpMatches}/${out.cases}`);
console.log(`direct differences     : ${directDifferences.length ? directDifferences.map(row => row.id).join(', ') : 'none'}`);
console.log(`http differences       : ${httpDifferences.length ? httpDifferences.map(row => row.id).join(', ') : 'none'}`);
for (const row of directDifferences.slice(0, 20)) {
  console.log(`  ${row.id}\n    expected ${stable(row.expected)}\n    got      ${stable(row.got)}`);
}
process.exitCode = directDifferences.length || httpDifferences.length ? 1 : 0;
