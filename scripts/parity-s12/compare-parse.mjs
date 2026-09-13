#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [sourcePath, candidatePath, receiptPath = path.join(path.dirname(candidatePath || '.'), 'parse-differential.json'), expectedPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'parse-matrix.json')] = process.argv.slice(2);
if (!sourcePath || !candidatePath) throw new Error('usage: compare-parse.mjs <source.json> <candidate.json> [receipt.json]');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const coverageErrors = [];

function rowsFor(receipt, label) {
  if (!receipt || receipt.schema !== 's12-calendar-parse-receipt-v1') {
    coverageErrors.push(`${label} schema is missing or unsupported`);
    return [];
  }
  if (!Array.isArray(receipt.rows)) {
    coverageErrors.push(`${label}.rows is not an array`);
    return [];
  }
  const seen = new Set();
  receipt.rows.forEach((row, index) => {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) coverageErrors.push(`${label}.rows[${index}] is missing row ID`);
    else if (seen.has(row.id)) coverageErrors.push(`${label} duplicate row ID ${row.id}`);
    else seen.add(row.id);
    if (!row || !Object.hasOwn(row, 'parsed')) coverageErrors.push(`${label}.${row?.id || index} is missing parsed`);
  });
  return receipt.rows;
}

const sourceRows = rowsFor(source, 'source');
const candidateRows = rowsFor(candidate, 'candidate');
const sourceIDs = sourceRows.map((row) => row && row.id);
const candidateIDs = candidateRows.map((row) => row && row.id);
const expectedIDs = Array.isArray(expected.cases) ? expected.cases.map((row) => row && row.id) : [];
if (JSON.stringify(sourceIDs) !== JSON.stringify(candidateIDs)) coverageErrors.push(`row ID/order mismatch: source=${JSON.stringify(sourceIDs)} candidate=${JSON.stringify(candidateIDs)}`);
if (JSON.stringify(sourceIDs) !== JSON.stringify(expectedIDs)) coverageErrors.push(`source row ID/order does not match expected parse matrix`);
if (JSON.stringify(candidateIDs) !== JSON.stringify(expectedIDs)) coverageErrors.push(`candidate row ID/order does not match expected parse matrix`);

function withoutRevision(value) {
  if (Array.isArray(value)) return value.map(withoutRevision);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceRevision' || key === 'candidateRevision') continue;
    out[key] = withoutRevision(child);
  }
  return out;
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const differences = [];
for (let index = 0; index < Math.max(sourceRows.length, candidateRows.length); index += 1) {
  const left = sourceRows[index];
  const right = candidateRows[index];
  if (!left || !right || left.id !== right.id) {
    differences.push({ id: left?.id || right?.id || `row-${index}`, source: left?.parsed, candidate: right?.parsed });
  } else if (!equal(withoutRevision(left.parsed), withoutRevision(right.parsed))) {
    differences.push({ id: left.id, source: left.parsed, candidate: right.parsed });
  }
}
const result = {
  schema: 's12-calendar-parse-differential-v1',
  result: coverageErrors.length || differences.length ? 'fail' : 'pass',
  totalRows: Math.max(sourceRows.length, candidateRows.length),
  matches: Math.max(sourceRows.length, candidateRows.length) - differences.length,
  coverageErrors,
  differences,
};
fs.writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`result=${result.result} rows=${result.totalRows} matches=${result.matches} coverageErrors=${result.coverageErrors.length}`);
process.exitCode = result.result === 'pass' ? 0 : 1;
