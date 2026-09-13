#!/usr/bin/env node

// Fail-closed comparator for SettingsClient output, errors, and HTTP records.
// Every matrix descriptor must appear once and in order on both sides. The
// source/candidate rows are compared field-for-field, including undefined
// sentinels and exact request wire records.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [matrixPathArg, sourcePathArg, candidatePathArg, outputPathArg] = process.argv.slice(2);
if (!matrixPathArg || !sourcePathArg || !candidatePathArg) {
  throw new Error('usage: compare.mjs <matrix.json> <source.json> <candidate.json> [comparison.json]');
}
const matrixPath = path.resolve(matrixPathArg);
const sourcePath = path.resolve(sourcePathArg);
const candidatePath = path.resolve(candidatePathArg);
const outputPath = path.resolve(outputPathArg || path.join(path.dirname(candidatePath), 'comparison.json'));
const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_REVISION = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';
const SOURCE_IMAGE = 'node';
const EXPECTED_SOURCE_IMAGE_DIGEST = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';
const EXPECTED_CASE_INVENTORY = 'caac62ef04775f8cc02496adc7aaf626a7d33fba0e9cb8d53fd034be6b5e261a';
const EXPECTED_MATRIX_SEMANTIC_SHA256 = '32739ae87fae1c0928d0acaa6db3ffe2230ac09187df1acacc2655beca39ae80';
// Keep the ordered acceptance inventory outside matrix.json. The inventory
// digest catches edits to the ID list, while this literal list makes the
// expected count and order independently reviewable and fail closed even if
// a forged matrix reauthorizes its own digest.
const EXPECTED_CASE_IDS = Object.freeze([
  'convert-mode-0',
  'convert-mode-1',
  'convert-mode-2',
  'convert-mode-3',
  'convert-mode-negative',
  'convert-mode-four',
  'convert-mode-large',
  'convert-mode-fraction',
  'convert-mode-nan',
  'convert-mode-string-driving',
  'convert-mode-string-invalid',
  'convert-mode-null',
  'convert-mode-missing',
  'convert-missing-origin-lat',
  'convert-missing-origin-lng',
  'convert-missing-destination-lat',
  'convert-missing-destination-lng',
  'convert-missing-work-hour',
  'convert-missing-work-minute',
  'convert-presence-zero-and-out-of-range',
  'convert-out-of-range-work-time',
  'convert-malformed-partial',
  'convert-malformed-null',
  'convert-malformed-undefined',
  'convert-malformed-zero',
  'prefs-default-no-speaker',
  'prefs-default-not-in-loop',
  'prefs-default-child',
  'prefs-adult-transid',
  'prefs-adult-null-transid',
  'prefs-adult-missing-transid',
  'prefs-http-503',
  'prefs-http-400-malformed',
  'prefs-http-200-null',
  'prefs-http-200-empty',
  'prefs-http-200-missing-report',
  'prefs-http-200-missing-data',
  'prefs-http-200-wrong-shape',
  'prefs-http-200-malformed-array',
  'get-settings-valid',
  'get-settings-missing-account',
  'get-settings-missing-loop',
  'get-settings-no-auth',
]);

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { $readError: `${error.name}: ${error.message}` }; }
}

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function inventoryHash(cases) { return sha(JSON.stringify(cases.map((item) => item && item.id))); }
function hasOwn(value, key) { return Boolean(value && Object.prototype.hasOwnProperty.call(value, key)); }

const matrix = readJSON(matrixPath);
const source = readJSON(sourcePath);
const candidate = readJSON(candidatePath);
const differences = [];

if (matrix.schema !== 's11-settings-http-v1') differences.push({ side: 'matrix', kind: 'schema', actual: matrix.schema || null });
if (matrix.referenceRevision !== SOURCE_REVISION) differences.push({ side: 'matrix', kind: 'source-revision', actual: matrix.referenceRevision || null, expected: SOURCE_REVISION });
if (matrix.sourceImage !== SOURCE_IMAGE) differences.push({ side: 'matrix', kind: 'source-image', actual: matrix.sourceImage || null, expected: SOURCE_IMAGE });
if (matrix.sourceImageDigest !== EXPECTED_SOURCE_IMAGE_DIGEST) differences.push({ side: 'matrix', kind: 'source-image-digest', actual: matrix.sourceImageDigest || null, expected: EXPECTED_SOURCE_IMAGE_DIGEST });
if (!Array.isArray(matrix.cases)) differences.push({ side: 'matrix', kind: 'cases-not-array' });
const descriptors = Array.isArray(matrix.cases) ? matrix.cases : [];
const descriptorIds = descriptors.map((item) => item && item.id);
if (matrix.caseCount !== descriptors.length) differences.push({ side: 'matrix', kind: 'case-count', actual: descriptors.length, expected: matrix.caseCount });
if (matrix.caseCount !== EXPECTED_CASE_IDS.length) differences.push({ side: 'matrix', kind: 'case-count-pin', actual: matrix.caseCount, expected: EXPECTED_CASE_IDS.length });
if (canonical(descriptorIds) !== canonical(EXPECTED_CASE_IDS)) differences.push({ side: 'matrix', kind: 'case-id-order', actual: descriptorIds, expected: EXPECTED_CASE_IDS });
if (inventoryHash(descriptors) !== EXPECTED_CASE_INVENTORY) differences.push({ side: 'matrix', kind: 'case-inventory-hash', actual: inventoryHash(descriptors), expected: EXPECTED_CASE_INVENTORY });
if (matrix.caseInventorySha256 !== EXPECTED_CASE_INVENTORY) differences.push({ side: 'matrix', kind: 'case-inventory-pin', actual: matrix.caseInventorySha256 || null, expected: EXPECTED_CASE_INVENTORY });
if (sha(canonical(matrix)) !== EXPECTED_MATRIX_SEMANTIC_SHA256) differences.push({ side: 'matrix', kind: 'matrix-semantic-hash', actual: sha(canonical(matrix)), expected: EXPECTED_MATRIX_SEMANTIC_SHA256 });
if (new Set(descriptorIds).size !== descriptorIds.length) differences.push({ side: 'matrix', kind: 'duplicate-case-id' });

function receiptRows(receipt, side) {
  if (!receipt || receipt.$readError) {
    differences.push({ side, kind: 'receipt-read', actual: receipt && receipt.$readError || null });
    return [];
  }
  if (receipt.schema !== 's11-settings-http-receipt-v1') differences.push({ side, kind: 'receipt-schema', actual: receipt.schema || null });
  if (!Array.isArray(receipt.rows)) differences.push({ side, kind: 'rows-not-array' });
  return Array.isArray(receipt.rows) ? receipt.rows : [];
}

function validateMetadata(receipt, side) {
  if (!receipt || receipt.$readError) return;
  if (receipt.sourceRevision !== SOURCE_REVISION) differences.push({ side, kind: 'source-revision', actual: receipt.sourceRevision || null, expected: SOURCE_REVISION });
  if (receipt.fixedNowISO !== matrix.fixedNowISO) differences.push({ side, kind: 'fixed-time', actual: receipt.fixedNowISO || null, expected: matrix.fixedNowISO });
  if (receipt.matrixSha256 !== sha(fs.readFileSync(matrixPath))) differences.push({ side, kind: 'matrix-hash', actual: receipt.matrixSha256 || null, expected: sha(fs.readFileSync(matrixPath)) });
  if (receipt.caseCount !== EXPECTED_CASE_IDS.length) differences.push({ side, kind: 'receipt-case-count', actual: receipt.caseCount, expected: EXPECTED_CASE_IDS.length });
  if (receipt.caseInventorySha256 !== EXPECTED_CASE_INVENTORY) differences.push({ side, kind: 'receipt-case-inventory', actual: receipt.caseInventorySha256 || null, expected: EXPECTED_CASE_INVENTORY });
  if (receipt.matrixSemanticSha256 !== EXPECTED_MATRIX_SEMANTIC_SHA256) differences.push({ side, kind: 'receipt-matrix-semantic-hash', actual: receipt.matrixSemanticSha256 || null, expected: EXPECTED_MATRIX_SEMANTIC_SHA256 });
  if (!/^[0-9a-f]{64}$/.test(receipt.runnerSha256 || '')) differences.push({ side, kind: 'runner-hash-format', actual: receipt.runnerSha256 || null });
  const expectedRunner = side === 'source' ? sha(fs.readFileSync(path.join(here, 'run-source.cjs'))) : sha(fs.readFileSync(path.join(here, 'run-candidate.mjs')));
  if (receipt.runnerSha256 !== expectedRunner) differences.push({ side, kind: 'runner-hash', actual: receipt.runnerSha256 || null, expected: expectedRunner });
  if (side === 'source') {
    if (receipt.sourceImage !== SOURCE_IMAGE) differences.push({ side, kind: 'source-image', actual: receipt.sourceImage || null, expected: SOURCE_IMAGE });
    if (receipt.sourceImageDigest !== EXPECTED_SOURCE_IMAGE_DIGEST) differences.push({ side, kind: 'source-image-digest', actual: receipt.sourceImageDigest || null, expected: EXPECTED_SOURCE_IMAGE_DIGEST });
    if (receipt.network !== 'none') differences.push({ side, kind: 'network', actual: receipt.network || null, expected: 'none' });
    if (receipt.runtime !== 'v8.9.4') differences.push({ side, kind: 'runtime', actual: receipt.runtime || null, expected: 'v8.9.4' });
  } else {
    if (receipt.network !== 'loopback-only') differences.push({ side, kind: 'network', actual: receipt.network || null, expected: 'loopback-only' });
    if (!/^v\d+\.\d+\.\d+$/.test(receipt.runtime || '')) differences.push({ side, kind: 'runtime', actual: receipt.runtime || null });
    if (!/^[0-9a-f]{40}$/.test(receipt.candidateRevision || '')) differences.push({ side, kind: 'candidate-revision', actual: receipt.candidateRevision || null });
  }
}

function rowsForSide(receipt, side) {
  const rows = receiptRows(receipt, side);
  const counts = new Map();
  rows.forEach((row, index) => {
    const id = row && typeof row === 'object' ? row.id : undefined;
    if (typeof id !== 'string' || !id) differences.push({ side, kind: 'row-without-id', index });
    else counts.set(id, (counts.get(id) || 0) + 1);
  });
  if (rows.length !== descriptors.length) differences.push({ side, kind: 'row-count', actual: rows.length, expected: descriptors.length });
  const order = rows.map((row) => row && row.id);
  if (canonical(order) !== canonical(descriptorIds)) differences.push({ side, kind: 'row-order', actual: order, expected: descriptorIds });
  if (canonical(order) !== canonical(EXPECTED_CASE_IDS)) differences.push({ side, kind: 'row-order-pin', actual: order, expected: EXPECTED_CASE_IDS });
  for (const [id, count] of counts) {
    if (count > 1) differences.push({ side, kind: 'duplicate-row', id, count });
    if (!descriptorIds.includes(id)) differences.push({ side, kind: 'unexpected-row', id });
  }
  for (const id of descriptorIds) if (!counts.has(id)) differences.push({ side, kind: 'missing-row', id });
  return new Map(rows.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, row]));
}

function expectedRequestCount(item) {
  if (item.kind === 'http-prefs') return 1;
  if (item.kind !== 'get-settings') return 0;
  return item.accountId && item.accountId !== 'no-auth-provided' && item.loopId ? 1 : 0;
}

function validateRowShape(item, row, side) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return;
  for (const key of ['id', 'kind', 'ok', 'value', 'error', 'requests']) {
    if (!hasOwn(row, key)) differences.push({ id: item.id, side, kind: 'row-field-missing', field: key });
  }
  if (row.kind !== item.kind) differences.push({ id: item.id, side, kind: 'row-kind', actual: row.kind, expected: item.kind });
  if (typeof row.ok !== 'boolean') differences.push({ id: item.id, side, kind: 'row-ok-type', actual: row.ok });
  if (!Array.isArray(row.requests)) differences.push({ id: item.id, side, kind: 'request-records-not-array', actual: row.requests });
  else {
    if (row.requests.length !== expectedRequestCount(item)) differences.push({ id: item.id, side, kind: 'request-count', actual: row.requests.length, expected: expectedRequestCount(item) });
    row.requests.forEach((request, index) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) differences.push({ id: item.id, side, kind: 'request-record-invalid', index });
      else {
        for (const key of ['sequence', 'method', 'path', 'headers', 'bodyRaw', 'body', 'responseStatus', 'responseHeaders', 'responseBodyRaw']) if (!hasOwn(request, key)) differences.push({ id: item.id, side, kind: 'request-field-missing', index, field: key });
        if (request.sequence !== index) differences.push({ id: item.id, side, kind: 'request-sequence', index, actual: request.sequence });
      }
    });
  }
}

validateMetadata(source, 'source');
validateMetadata(candidate, 'candidate');
const sourceRows = rowsForSide(source, 'source');
const candidateRows = rowsForSide(candidate, 'candidate');
const fields = ['kind', 'ok', 'value', 'error', 'requests'];
for (const item of descriptors) {
  const s = sourceRows.get(item.id);
  const c = candidateRows.get(item.id);
  validateRowShape(item, s, 'source');
  validateRowShape(item, c, 'candidate');
  if (!s || !c) continue;
  if (canonical(s) !== canonical(c)) differences.push({ id: item.id, kind: 'source-candidate-row', source: s, candidate: c });
  for (const field of fields) if (canonical(s[field]) !== canonical(c[field])) differences.push({ id: item.id, kind: 'source-candidate', field, source: s[field], candidate: c[field] });
}

const result = {
  schema: 's11-settings-http-comparison-v1',
  result: differences.length ? 'fail' : 'pass',
  sourceRevision: source.sourceRevision || null,
  candidateRevision: candidate.candidateRevision || null,
  cases: descriptors.length,
  sourceRows: Array.isArray(source.rows) ? source.rows.length : null,
  candidateRows: Array.isArray(candidate.rows) ? candidate.rows.length : null,
  differences,
};
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, cases: result.cases, differences: differences.length, output: outputPath }));
if (differences.length) process.exitCode = 1;
