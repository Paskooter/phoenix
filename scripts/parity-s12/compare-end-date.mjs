#!/usr/bin/env node

// Fail-closed comparison for the source's exact endDate formatter. The
// matrix order and IDs are part of coverage, so a paired omission cannot pass.
import fs from 'node:fs';

const [sourcePath, candidatePath, receiptPath, expectedPath] = process.argv.slice(2);
if (!sourcePath || !candidatePath || !receiptPath || !expectedPath) {
  throw new Error('usage: compare-end-date.mjs <source.json> <candidate.json> <receipt.json> <matrix.json>');
}
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const coverageErrors = [];

function rowsFor(value, label) {
  if (!value || value.schema !== 's12-calendar-end-date-receipt-v1' || !Array.isArray(value.rows)) {
    coverageErrors.push(`${label} schema/rows unsupported`);
    return [];
  }
  const seen = new Set();
  for (const [index, row] of value.rows.entries()) {
    if (!row || typeof row.id !== 'string' || !row.id) coverageErrors.push(`${label}.rows[${index}] missing id`);
    else if (seen.has(row.id)) coverageErrors.push(`${label} duplicate row ID ${row.id}`);
    else seen.add(row.id);
    if (!row || typeof row.iso !== 'string') coverageErrors.push(`${label}.${row?.id || index} missing iso`);
    if (!row || typeof row.endDate !== 'string') coverageErrors.push(`${label}.${row?.id || index} missing endDate`);
  }
  return value.rows;
}
const sourceRows = rowsFor(source, 'source');
const candidateRows = rowsFor(candidate, 'candidate');
const expectedIDs = expected.cases.map((row) => row.id);
const sourceIDs = sourceRows.map((row) => row && row.id);
const candidateIDs = candidateRows.map((row) => row && row.id);
if (JSON.stringify(sourceIDs) !== JSON.stringify(candidateIDs)) coverageErrors.push('source/candidate row IDs or order differ');
if (JSON.stringify(sourceIDs) !== JSON.stringify(expectedIDs)) coverageErrors.push('source rows do not match expected matrix');
if (JSON.stringify(candidateIDs) !== JSON.stringify(expectedIDs)) coverageErrors.push('candidate rows do not match expected matrix');
if (sourceRows.length !== candidateRows.length) coverageErrors.push('source/candidate row cardinality differs');

const rows = [];
let matches = 0;
const differences = [];
for (let index = 0; index < Math.max(sourceRows.length, candidateRows.length); index += 1) {
  const left = sourceRows[index];
  const right = candidateRows[index];
  const expectedRow = expected.cases[index];
  const id = left?.id || right?.id || `row-${index}`;
  if (left && expectedRow && left.iso !== expectedRow.iso) coverageErrors.push(`source ${id} iso does not match expected matrix`);
  if (right && expectedRow && right.iso !== expectedRow.iso) coverageErrors.push(`candidate ${id} iso does not match expected matrix`);
  const match = !!left && !!right && left.id === right.id && left.iso === right.iso && left.endDate === right.endDate;
  rows.push({ id, match });
  if (match) matches += 1;
  else differences.push({ id, source: left, candidate: right });
}
const result = {
  schema: 's12-calendar-end-date-differential-v1',
  result: coverageErrors.length || differences.length ? 'fail' : 'pass',
  totalRows: rows.length,
  matches,
  coverageErrors,
  differences,
  rows,
};
fs.writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`result=${result.result} rows=${result.totalRows} matches=${result.matches} coverageErrors=${result.coverageErrors.length}`);
process.exitCode = result.result === 'pass' ? 0 : 1;
