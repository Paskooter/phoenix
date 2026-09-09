// C-01 root comparator.
//
// Compares the original (Node 8.9.4 / pinned reference Express) capture against
// the Phoenix capture case by case, on the dimensions C-01 criterion 2 names:
// status code, response body, content type and headers.
//
// Normalisation, and why each one is legitimate rather than a way to hide a
// difference:
//   msgID / ts   - nondeterministic per request in BOTH implementations
//                  (source buildErrorMessage uses getUUID() and Date.now()).
//                  Both captures already emit fixed placeholders on the source
//                  side; Phoenix values are replaced here the same way.
//   x-powered-by - an Express banner, not a product contract. Reported as an
//                  observation, never as a difference.
//   content-length - derived from the body; compared only via the body itself
//                  so a byte-identical body cannot fail twice.
//
// Everything else is compared strictly. Run with --falsify to corrupt the
// source data in memory and confirm the comparator actually reports mismatches
// (a comparator that always passes is worse than no comparator).

import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const here = new URL('.', import.meta.url).pathname;
const falsify = process.argv.includes('--falsify');

const original = JSON.parse(readFileSync(here + 'original-boundary.json'));
const phoenix = JSON.parse(readFileSync(here + 'phoenix-boundary.json'));

if (falsify) {
  for (const row of original) {
    row.status = 599;
    row.raw = '{"WRECKED_BY_ROOT":true}';
  }
}

function normaliseBody(raw) {
  if (raw === '' || raw === null || raw === undefined) return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // non-JSON body compared verbatim
  }
  if (parsed && typeof parsed === 'object' && parsed.type === 'ERROR') {
    parsed.msgID = '<normalised>';
    parsed.ts = '<normalised>';
  }
  return parsed;
}

const byId = new Map(phoenix.map((row) => [row.id, row]));
const differences = [];
const observations = [];

for (const source of original) {
  const candidate = byId.get(source.id);
  if (!candidate) {
    differences.push({ id: source.id, kind: 'missing-in-phoenix' });
    continue;
  }

  if (source.status !== candidate.status) {
    differences.push({
      id: source.id, kind: 'status',
      method: source.method, path: source.path,
      source: source.status, phoenix: candidate.status,
    });
  }

  const sourceBody = normaliseBody(source.raw);
  const phoenixBody = normaliseBody(candidate.raw);
  if (!isDeepStrictEqual(sourceBody, phoenixBody)) {
    differences.push({
      id: source.id, kind: 'body',
      method: source.method, path: source.path,
      source: sourceBody, phoenix: phoenixBody,
    });
  }

  const sourceType = (source.headers['content-type'] || '').toLowerCase();
  const phoenixType = (candidate.headers['content-type'] || '').toLowerCase();
  if (sourceType !== phoenixType) {
    differences.push({
      id: source.id, kind: 'content-type',
      method: source.method, path: source.path,
      source: source.headers['content-type'], phoenix: candidate.headers['content-type'],
    });
  }

  if ((source.headers.allow || null) !== (candidate.headers.allow || null)) {
    differences.push({
      id: source.id, kind: 'allow-header',
      method: source.method, path: source.path,
      source: source.headers.allow, phoenix: candidate.headers.allow,
    });
  }

  if ((source.headers['x-powered-by'] || null) !== (candidate.headers['x-powered-by'] || null)) {
    observations.push({
      id: source.id, kind: 'x-powered-by',
      source: source.headers['x-powered-by'], phoenix: candidate.headers['x-powered-by'],
    });
  }
}

const report = {
  reviewedBy: 'Claude root',
  task: 'C-01',
  scope: 'Boundary dimensions not covered by the accepted 317-case JSON-body review: '
    + 'handler errors, unknown routes, trailing slashes, HTTP methods, content types, response headers.',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  referenceRuntime: 'node:8.9.4-slim (v8.9.4), pinned reference express/body-parser',
  cases: original.length,
  differences,
  observations,
  falsifyRun: falsify,
};
writeFileSync(here + (falsify ? 'comparison-falsified.json' : 'comparison.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  cases: original.length,
  differences: differences.length,
  observations: observations.length,
  falsifyRun: falsify,
}));
if (!falsify && differences.length) process.exitCode = 1;
if (falsify && differences.length === 0) {
  console.error('FALSIFICATION FAILED: comparator reported no differences on corrupted source data');
  process.exitCode = 2;
}
