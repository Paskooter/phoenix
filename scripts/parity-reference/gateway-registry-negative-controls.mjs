// Prove that the differential rejects omissions and altered observable values.
// Inputs are real captures, never reconstructed expected service responses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [originalFile, candidateFile, outputDir] = process.argv.slice(2);
if (!originalFile || !candidateFile || !outputDir) throw new Error('Expected original.json candidate.json output-directory');
fs.mkdirSync(outputDir, { recursive: true });
const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
const comparator = fileURLToPath(new URL('./gateway-registry-compare.mjs', import.meta.url));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mutations = [
  ['missing-metadata', value => { delete value.registries[0].skills[0].settings; }],
  ['changed-url', value => { value.registries[0].skills[0].URL += '/wrong'; }],
  ['missing-validation-row', value => { value.validations.pop(); }],
  ['duplicate-validation-row', value => { value.validations[value.validations.length - 1] = structuredClone(value.validations[0]); }],
  ['reordered-validation-rows', value => { [value.validations[0], value.validations[1]] = [value.validations[1], value.validations[0]]; }],
  ['mutable-registry', value => { value.registries[0].frozen = false; }],
  ['body-key-order', value => {
    const body = JSON.parse(value.http[0].body);
    body.skills[0] = Object.fromEntries(Object.entries(body.skills[0]).reverse());
    value.http[0].body = JSON.stringify(body);
  }],
  ['missing-content-type', value => { delete value.http[0].headers['content-type']; }],
  ['wrong-content-length', value => { value.http[0].headers['content-length'] = String(Number(value.http[0].headers['content-length']) + 1); }],
  ['added-keep-alive', value => { value.http[0].headers['keep-alive'] = 'timeout=5'; }],
  ['invalid-error-etag', value => {
    const row = value.http.find(item => item.body.startsWith('{') && JSON.parse(item.body).type === 'ERROR');
    if (!row) throw new Error('Capture has no error ETag control');
    row.headers.etag = 'W/"incorrect"';
  }],
];

function compare(input, report) {
  return spawnSync(process.execPath, [comparator, originalFile, input, report], { encoding: 'utf8' });
}
const baseline = compare(candidateFile, path.join(outputDir, 'baseline.json'));
if (baseline.status !== 0) throw new Error(`Unmodified capture does not pass: ${baseline.stderr || baseline.stdout}`);
const rows = mutations.map(([id, mutate]) => {
  const value = structuredClone(candidate);
  mutate(value);
  const input = path.join(outputDir, `${id}.input.json`);
  const report = path.join(outputDir, `${id}.comparison.json`);
  fs.writeFileSync(input, JSON.stringify(value, null, 2) + '\n');
  const result = compare(input, report);
  const differenceIds = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')).differences.map(row => row.id) : [];
  const validationError = result.stderr.includes('ETag does not cover error body') ? 'ETag does not cover error body' : undefined;
  return { id, rejected: result.status === 1 && (differenceIds.length > 0 || !!validationError), exitCode: result.status, differenceIds, ...(validationError ? { validationError } : {}) };
});
const result = { originalSha256: sha(originalFile), candidateSha256: sha(candidateFile), comparatorSha256: sha(comparator), baselineMatches: JSON.parse(fs.readFileSync(path.join(outputDir, 'baseline.json'), 'utf8')).matches, total: rows.length, rejected: rows.filter(row => row.rejected).length, controls: rows };
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ total: result.total, rejected: result.rejected }));
if (result.rejected !== result.total) process.exitCode = 1;
