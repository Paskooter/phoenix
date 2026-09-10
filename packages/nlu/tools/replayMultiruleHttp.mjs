// N-01 differential replay harness: run every original multi-rule HTTP parser
// case through the live parseRequest() and compare with the pinned original
// native capture.
//
// The oracle is vendored as test/fixtures/multirule-http-42.json (see its
// `provenance` block for the source paths and hashes of the root-accepted
// review capture it was generated from:
// docs/parity/evidence/2026-09-06/nlu-compiled-fst/multirule-http-review.json,
// suite sha256 2c958166863314ef96e1b4d2f8a6b3eceb8728f1a6939af10c7418d0b6d60ac8).
//
// Usage: node packages/nlu/tools/replayMultiruleHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { getCompiledFstRuntime } from '../src/compiledFstRuntime.js';

const EXPECTED_SUITE_SHA256 = '2c958166863314ef96e1b4d2f8a6b3eceb8728f1a6939af10c7418d0b6d60ac8';
const fixtureBytes = readFileSync(new URL('../test/fixtures/multirule-http-42.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (fixture.provenance.suiteSha256 !== EXPECTED_SUITE_SHA256) {
  throw new Error(`multi-rule suite hash mismatch: ${fixture.provenance.suiteSha256}`);
}
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');

const runtime = getCompiledFstRuntime();
const profile = runtime ? 'compiled-fst' : 'ast';

const rows = [];
for (const c of fixture.cases) {
  let status = 200;
  let data;
  try {
    data = parseRequest({ text: c.text, rules: c.rules });
  } catch (error) {
    status = 500;
    data = { error: error.message };
  }
  rows.push({
    id: c.id,
    group: c.group,
    request: { text: c.text, rules: c.rules },
    status,
    statusMatches: status === c.expectedStatus,
    dataMatches: status === c.expectedStatus && JSON.stringify(data) === JSON.stringify(c.expectedData),
    expected: c.expectedData,
    got: data,
  });
}

const differences = rows.filter(r => !r.dataMatches).map(r => r.id);
const out = {
  schema: 'phoenix.nlu.n01-multirule-http-replay',
  fixtureSha256,
  suite: fixture.provenance.suiteId,
  suiteSha256: fixture.provenance.suiteSha256,
  reference: fixture.provenance.profile,
  profile,
  cases: rows.length,
  statusMatches: rows.filter(r => r.statusMatches).length,
  dataMatches: rows.filter(r => r.dataMatches).length,
  differences,
  rows,
};

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target) && !process.env.N01_ALLOW_OVERWRITE) {
    throw new Error(`refusing to overwrite existing ${target}`);
  }
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`profile                : ${profile}`);
console.log(`fixture                : ${fixture.provenance.suiteId} (${fixture.provenance.suiteSha256})`);
console.log(`cases                  : ${out.cases}`);
console.log(`status matches         : ${out.statusMatches}`);
console.log(`decoded-data matches   : ${out.dataMatches}`);
console.log(`differences            : ${differences.length ? differences.join(', ') : 'none'}`);
for (const r of rows.filter(x => !x.dataMatches)) {
  console.log(`  ${r.id}\n    expected ${JSON.stringify(r.expected)}\n    got      ${JSON.stringify(r.got)}`);
}
process.exitCode = out.dataMatches === out.cases ? 0 : 1;
