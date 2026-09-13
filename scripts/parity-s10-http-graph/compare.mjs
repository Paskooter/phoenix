#!/usr/bin/env node

// Fail-closed comparison of the pinned Pegasus and Phoenix Report HTTP
// receipts. Every provider call is part of the contract: route, query,
// header, response status, and order are checked alongside the graph output.

import fs from 'node:fs';
import path from 'node:path';

const [matrixPath, sourcePath, candidatePath, outputArg] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) {
  throw new Error('usage: compare.mjs <matrix.json> <source.json> <candidate.json> [comparison.json]');
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const matrix = readJSON(matrixPath);
const source = readJSON(sourcePath);
const candidate = readJSON(candidatePath);
if (matrix.schema !== 's10-report-news-http-v1') throw new Error('unsupported S-10 matrix schema');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

const canonical = (value) => JSON.stringify(stable(value));

function expectedSourceIDs(item) {
  const categories = item.prefs && item.prefs.categories || {};
  const configured = (matrix.categoryOrder || Object.keys(matrix.categorySourceIDs))
    .filter((name) => categories[name])
    .map((name) => matrix.categorySourceIDs[name]);
  return configured.length ? configured : matrix.defaultNewsSourceIDs;
}

function expectedRequests(item) {
  const headers = { transID: 'tid:1234', robotID: 'unknown', loggingConfig: '{}' };
  const failedIDs = item.failure && Array.isArray(item.failure.sourceIDs)
    ? item.failure.sourceIDs.map(String) : [];
  const allFailed = item.failure === 'all';
  return expectedSourceIDs(item).map((sourceID, sequence) => ({
    sequence,
    method: 'GET',
    path: '/v1/ap_news',
    query: { sourceID: String(sourceID) },
    headers,
    status: allFailed || failedIDs.includes(String(sourceID)) ? 503 : 200,
  }));
}

function rowsById(receipt, side, differences) {
  if (!receipt || receipt.schema !== 's10-report-news-http-receipt-v1') {
    differences.push({ side, kind: 'receipt-schema', actual: receipt && receipt.schema || null });
    return new Map();
  }
  if (!Array.isArray(receipt.rows)) {
    differences.push({ side, kind: 'rows-not-array' });
    return new Map();
  }
  const rows = new Map();
  const ids = new Set();
  receipt.rows.forEach((row, index) => {
    if (!row || typeof row.id !== 'string') {
      differences.push({ side, kind: 'row-without-id', index });
      return;
    }
    if (ids.has(row.id)) differences.push({ side, kind: 'duplicate-row', id: row.id });
    ids.add(row.id);
    rows.set(row.id, row);
  });
  if (receipt.rows.length !== matrix.cases.length) {
    differences.push({ side, kind: 'row-count', actual: receipt.rows.length, expected: matrix.cases.length });
  }
  return rows;
}

function compareHeadlineOrder(item, response, side, differences) {
  const expected = item.expected && item.expected.headlineOrder;
  if (!expected) return;
  const actual = Array.isArray(response.headlineSpeeches) ? response.headlineSpeeches : [];
  if (actual.length !== expected.length) {
    differences.push({ id: item.id, side, kind: 'headline-count', actual: actual.length, expected: expected.length });
  }
  expected.forEach((headline, index) => {
    if (!actual[index] || !actual[index].includes(headline)) {
      differences.push({ id: item.id, side, kind: 'headline-order', index, actual: actual[index] || null, expected: headline });
    }
  });
}

function compareRow(item, row, side, differences) {
  const id = item.id;
  const expected = item.expected || {};
  if (!row) {
    differences.push({ id, side, kind: 'missing-row' });
    return;
  }
  if (row.httpStatus !== 200) differences.push({ id, side, kind: 'http-status', actual: row.httpStatus });

  const response = row.response || {};
  const expectedType = expected.responseType || 'SKILL_ACTION';
  if (response.responseType !== expectedType) {
    differences.push({ id, side, kind: 'response-type', actual: response.responseType, expected: expectedType });
  }
  const expectedFinal = expectedType === 'ERROR' ? null : true;
  if (response.final !== expectedFinal) {
    differences.push({ id, side, kind: 'final', actual: response.final, expected: expectedFinal });
  }
  if (canonical(response.mimIds) !== canonical(expected.mims || [])) {
    differences.push({ id, side, kind: 'mim-order', actual: response.mimIds, expected: expected.mims || [] });
  }
  compareHeadlineOrder(item, response, side, differences);

  const speech = Array.isArray(response.speeches) ? response.speeches.join(' ') : '';
  for (const token of expected.speechIncludes || []) {
    if (!speech.includes(token)) differences.push({ id, side, kind: 'speech-token-missing', token });
  }
  for (const token of expected.speechExcludes || []) {
    if (speech.includes(token)) differences.push({ id, side, kind: 'speech-token-present', token });
  }

  if (expected.viewCategories && canonical((response.newsViews || []).map((view) => view.category))
    !== canonical(expected.viewCategories)) {
    differences.push({ id, side, kind: 'view-categories', actual: response.newsViews, expected: expected.viewCategories });
  }
  if (expected.viewGeometry && canonical(response.newsViews) !== canonical(expected.viewGeometry)) {
    differences.push({ id, side, kind: 'view-geometry', actual: response.newsViews, expected: expected.viewGeometry });
  }
  if (expected.analytics && canonical(response.resultsAnalytics) !== canonical(expected.analytics)) {
    differences.push({ id, side, kind: 'results-analytics', actual: response.resultsAnalytics, expected: expected.analytics });
  }

  const requests = expectedRequests(item);
  if (expected.sourceIDs && canonical(expected.sourceIDs) !== canonical(expectedSourceIDs(item))) {
    differences.push({ id, side: 'matrix', kind: 'source-id-expectation', actual: expected.sourceIDs, expected: expectedSourceIDs(item) });
  }
  if (canonical(row.dataRequests) !== canonical(requests)) {
    differences.push({ id, side, kind: 'provider-requests', actual: row.dataRequests, expected: requests });
  }
  if (canonical(row.newsRequests) !== canonical(requests)) {
    differences.push({ id, side, kind: 'news-requests', actual: row.newsRequests, expected: requests });
  }
  const requestExpectation = row.requestExpectation || {};
  const expectedExpectation = { count: requests.length, sourceIDs: expectedSourceIDs(item) };
  if (canonical(requestExpectation) !== canonical(expectedExpectation)) {
    differences.push({ id, side, kind: 'request-expectation', actual: requestExpectation, expected: expectedExpectation });
  }
}

const differences = [];
const sourceRows = rowsById(source, 'source', differences);
const candidateRows = rowsById(candidate, 'candidate', differences);
const matrixOrder = matrix.cases.map((item) => item.id);
const sourceOrder = Array.isArray(source.rows) ? source.rows.map((row) => row && row.id) : [];
const candidateOrder = Array.isArray(candidate.rows) ? candidate.rows.map((row) => row && row.id) : [];
if (canonical(sourceOrder) !== canonical(matrixOrder)) {
  differences.push({ side: 'source', kind: 'row-order', actual: sourceOrder, expected: matrixOrder });
}
if (canonical(candidateOrder) !== canonical(matrixOrder)) {
  differences.push({ side: 'candidate', kind: 'row-order', actual: candidateOrder, expected: matrixOrder });
}

const responseFields = [
  // `mims` retains generated display IDs for view extraction; normalized
  // `action` below is the full display-bearing graph comparison.
  'responseType', 'final', 'mimIds', 'promptIds', 'speeches',
  'headlineSpeeches', 'newsViews', 'action', 'analytics', 'resultsAnalytics', 'transitions',
];
for (const item of matrix.cases) {
  const sourceRow = sourceRows.get(item.id);
  const candidateRow = candidateRows.get(item.id);
  compareRow(item, sourceRow, 'source', differences);
  compareRow(item, candidateRow, 'candidate', differences);
  if (!sourceRow || !candidateRow) continue;
  const sourceResponse = sourceRow.response || {};
  const candidateResponse = candidateRow.response || {};
  for (const field of responseFields) {
    if (canonical(sourceResponse[field]) !== canonical(candidateResponse[field])) {
      differences.push({ id: item.id, kind: 'source-candidate-response', field,
        source: sourceResponse[field], candidate: candidateResponse[field] });
    }
  }
  for (const field of ['dataRequests', 'newsRequests', 'requestExpectation']) {
    if (canonical(sourceRow[field]) !== canonical(candidateRow[field])) {
      differences.push({ id: item.id, kind: 'source-candidate-requests', field,
        source: sourceRow[field], candidate: candidateRow[field] });
    }
  }
}

const outputPath = path.resolve(outputArg || path.join(path.dirname(candidatePath), 'comparison.json'));
const result = {
  schema: 's10-report-news-http-comparison-v1',
  result: differences.length ? 'fail' : 'pass',
  sourceRevision: source.sourceRevision || null,
  candidateRevision: candidate.candidateRevision || null,
  cases: matrix.cases.length,
  differences,
};
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, cases: result.cases, differences: differences.length, output: outputPath }));
if (differences.length) process.exitCode = 1;
