// N-08 pinned-corpus replay: the complete original HTTP parser corpus replayed
// through the Phoenix NLU request path.
//
// Input: the frozen original parser capture. Each row carries the *exact* NLU
// request data the original cloud received and the *exact* NLU response data it
// returned (`{entities, intent, rules}`), so the comparison is field-for-field
// against the original service, not against a re-derived expectation.
//
//   phase 1  parseRequest()   — the exact entry the HTTP handler calls, over
//                               every selected row.
//   phase 2  POST /v1/parse   — a live service bound to an ephemeral port, over
//                               every phase-1 mismatch plus `--http-limit` rows
//                               taken from the head of the selection (0 = all).
//
// Usage:
//   node packages/nlu/tools/replayPinnedCorpusHttp.mjs \
//     --original <full-original-parser.json> [--out FILE] [--limit N]
//     [--ids FILE] [--http-limit N]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';
import { start } from '../src/index.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const originalPath = arg('original');
if (!originalPath) throw new Error('usage: replayPinnedCorpusHttp.mjs --original FILE [--out FILE] [--limit N] [--ids FILE] [--http-limit N]');

const originalBytes = readFileSync(originalPath);
const capture = JSON.parse(originalBytes.toString('utf8'));

function requestData(row) {
  const value = row.input && row.input.value;
  // Three boundary rows intentionally carry a malformed request (missing body,
  // missing `data`, or a non-string `text`). They never reach the parser: the
  // original answers HTTP 400. Keep them in the denominator and assert that.
  if (!value || !value.data || typeof value.data.text !== 'string') return malformed(value);
  return value.data;
}

// Distinguish a genuinely malformed request from an unrelated capture shape.
function malformed(value) {
  return { __malformed: true, value };
}

function expectedData(row) {
  if (row.status !== 200) return { thrown: true, status: row.status };
  const value = row.response && row.response.value;
  if (!value || !value.data) return null;
  const { entities, intent, rules } = value.data;
  return { entities: entities === undefined ? null : entities, intent: intent === undefined ? null : intent, rules: rules === undefined ? [] : rules };
}

const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};
const same = (a, b) => stable(a) === stable(b);

const limit = Number(arg('limit') || 0) || 0;
const httpLimit = Number(arg('http-limit') || 0) || 0;
const idsArg = arg('ids');
const idSet = idsArg ? new Set(JSON.parse(readFileSync(idsArg, 'utf8'))) : null;
let rows = capture.rows.filter(row => requestData(row));
if (idSet) rows = rows.filter(row => idSet.has(row.id));
if (limit) rows = rows.slice(0, limit);

const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });

// --- phase 1: direct parseRequest -------------------------------------------
const directRows = rows.map(row => {
  const request = requestData(row);
  const expected = expectedData(row);
  let status = 200;
  let got = null;
  let error = null;
  try { got = norm(parseRequest(request.__malformed ? request.value && request.value.data : request)); }
  catch (e) { status = 500; error = e.message; }
  const matches = expected && expected.thrown
    ? status !== 200
    : status === 200 && same(got, expected);
  const text = request.__malformed ? null : request.text;
  return { id: row.id, text, rules: request.__malformed ? null : request.rules, expected, got, status, error, matches };
});

const directDifferences = directRows.filter(row => !row.matches);

// --- phase 2: live HTTP -----------------------------------------------------
const httpSelection = httpLimit ? directRows.slice(0, httpLimit) : directRows;
const httpIds = new Set([...httpSelection, ...directDifferences].map(row => row.id));
const httpInputs = directRows.filter(row => httpIds.has(row.id));
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const httpRows = [];
try {
  for (const row of httpInputs) {
    const source = rows.find(r => r.id === row.id);
    const request = requestData(source);
    // Reproduce the original wire body: malformed boundary rows are sent
    // exactly as captured (null body / missing `data` / numeric `text`).
    const body = request.__malformed
      ? JSON.stringify({ type: 'NLU', msgID: `${row.id}:parser-input`, ts: 0, ...(request.value || {}) })
      : JSON.stringify({ type: 'NLU', data: request });
    const expected = row.expected;
    let status = 0;
    let got = null;
    let error = null;
    try {
      const response = await fetch(`${base}/v1/parse`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body,
      });
      status = response.status;
      const parsed = await response.json().catch(() => null);
      got = parsed && parsed.data ? norm(parsed.data) : null;
    } catch (e) { error = e.message; }
    const matches = expected && expected.thrown
      ? status >= 400
      : status === 200 && same(got, expected);
    httpRows.push({ id: row.id, status, got, error, matches });
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const httpDifferences = httpRows.filter(row => !row.matches);
const runtime = getCompiledFstRuntime();

// Group the direct mismatches by root signature so the report is itemized.
const groups = new Map();
for (const row of directDifferences) {
  const gotIntent = row.status === 200 ? (row.got && row.got.intent) : `THROW(${row.error})`;
  const key = `${row.expected && row.expected.thrown ? '<original-error>' : row.expected && row.expected.intent} -> ${gotIntent}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row.id);
}

const out = {
  schema: 'phoenix.nlu.n08-pinned-corpus-replay',
  referenceRevision: capture.sourceRevision,
  referenceSha256: capture.referenceSha256,
  captureSha256: createHash('sha256').update(originalBytes).digest('hex'),
  profile: runtime ? 'compiled-fst' : 'ast',
  cases: rows.length,
  directMatches: directRows.filter(row => row.matches).length,
  directDifferences: directDifferences.length,
  httpCases: httpRows.length,
  httpMatches: httpRows.filter(row => row.matches).length,
  httpDifferences: httpDifferences.length,
  mismatchGroups: [...groups.entries()].map(([signature, ids]) => ({ signature, count: ids.length, ids })).sort((a, b) => b.count - a.count),
  directDifferenceIds: directDifferences.map(row => row.id),
  httpDifferenceIds: httpDifferences.map(row => row.id),
  directRows,
};

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target)) throw new Error(`refusing to overwrite existing ${target}`);
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`profile                : ${out.profile}`);
console.log(`reference revision     : ${out.referenceRevision}`);
console.log(`capture                : ${out.captureSha256}`);
console.log(`cases                  : ${out.cases}`);
console.log(`direct parseRequest    : ${out.directMatches}/${out.cases}`);
console.log(`live HTTP /v1/parse    : ${out.httpMatches}/${out.httpCases}`);
console.log(`direct differences     : ${out.directDifferences}`);
console.log(`http differences       : ${out.httpDifferences}`);
for (const group of out.mismatchGroups) console.log(`  ${String(group.count).padStart(4)}  ${group.signature}`);
process.exitCode = directDifferences.length || httpDifferences.length ? 1 : 0;
