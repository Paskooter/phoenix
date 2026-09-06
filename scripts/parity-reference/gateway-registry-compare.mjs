import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeHttp } from './gateway-registry-normalize.mjs';

const [originalFile, candidateFile, outputFile] = process.argv.slice(2);
const original = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = [];
function compare(id, expected, actual) {
  const equal = isDeepStrictEqual(expected, actual);
  rows.push({ id, equal, ...(equal ? {} : { original: expected, candidate: actual }) });
}
for (const group of ['validations', 'registries', 'config']) {
  compare(group + '/row-ids', original[group].map(row => row.id), candidate[group].map(row => row.id));
  for (const row of original[group]) compare(group + '/' + row.id, row, candidate[group].find(item => item.id === row.id));
}
compare('original-registry', original.originalIndex, candidate.originalIndex);
compare('http/row-ids', original.http.map(row => row.id), candidate.http.map(row => row.id));
for (const row of original.http) compare('http/' + row.id, normalizeHttp(row), normalizeHttp(candidate.http.find(item => item.id === row.id)));
const report = {
  original: { runtime: original.runtime, sha256: hash(originalFile) },
  candidate: { runtime: candidate.runtime, sha256: hash(candidateFile) },
  scope: 'Full registry values/freeze, manager results and errors; real HubService/createGateway TCP status, body text and headers',
  normalization: ['Registry fixture directory only', 'HTTP Date only', 'ERROR msgID/ts only; error ETag independently verified against raw bytes'],
  total: rows.length,
  matches: rows.filter(row => row.equal).length,
  differences: rows.filter(row => !row.equal),
  rows: rows.map(({ id, equal }) => ({ id, equal })),
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ total: report.total, matches: report.matches, differences: report.differences.map(row => row.id) }));
if (report.differences.length) process.exitCode = 1;
