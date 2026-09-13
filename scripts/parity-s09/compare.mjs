#!/usr/bin/env node

// Compare the source and Phoenix report graphs at the HTTP boundary. The
// matrix intentionally owns the observable contract: MIM order, dynamic
// speech, weather-view presence, and every frozen Data peer request.

import fs from 'node:fs';
import path from 'node:path';

const [matrixPath, sourcePath, candidatePath, outputArg] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) {
  throw new Error('usage: compare.mjs <matrix.json> <source.json> <candidate.json> [comparison.json]');
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
if (matrix.schema !== 's09-report-weather-http-v1') throw new Error('unsupported S-09 matrix schema');

const canonical = (value) => JSON.stringify(value);
const expectedTimestamp = (item) => String(Math.round(
  (Date.parse(item.nowISO || item.locationISO) - 86400000) / 1000,
));
const expectedNewsIDs = (item) => item.prefs === 'weatherNews' ? matrix.defaultNewsSourceIDs : [];

function expectedRequests(item) {
  const headers = { transID: 'tid:1234', robotID: 'unknown', loggingConfig: '{}' };
  const timestamp = expectedTimestamp(item);
  const weatherStatus = item.failure === 'yesterday' ? 503 : 200;
  const todayStatus = item.failure === 'today' ? 503 : 200;
  const requests = [
    {
      method: 'GET', path: '/v1/dark_sky',
      query: { lat: matrix.coordinates.queryLat, lon: matrix.coordinates.queryLon, secondsSinceEpoch: timestamp },
      hasTimestamp: true, headers, status: weatherStatus,
    },
    {
      method: 'GET', path: '/v1/dark_sky',
      query: { lat: matrix.coordinates.queryLat, lon: matrix.coordinates.queryLon },
      hasTimestamp: false, headers, status: todayStatus,
    },
  ];
  const newsStatus = item.newsFailure ? 503 : 200;
  expectedNewsIDs(item).forEach((sourceID) => requests.push({
    method: 'GET', path: '/v1/ap_news', query: { sourceID }, hasTimestamp: false, headers, status: newsStatus,
  }));
  return requests;
}

function rowsById(receipt, side, differences) {
  if (!receipt || receipt.schema !== 's09-report-weather-http-receipt-v1') {
    differences.push({ side, kind: 'receipt-schema', actual: receipt?.schema || null });
    return new Map();
  }
  if (!Array.isArray(receipt.rows)) {
    differences.push({ side, kind: 'rows-not-array' });
    return new Map();
  }
  const ids = new Set();
  const rows = new Map();
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

function compareRow(item, row, side, differences) {
  const id = item.id;
  const expected = item.expected;
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
  const expectedMims = expected.mims || [];
  if (canonical(response.mimIds) !== canonical(expectedMims)) {
    differences.push({ id, side, kind: 'mim-order', actual: response.mimIds, expected: expectedMims });
  }
  if (response.weatherView !== expected.weatherView) {
    differences.push({ id, side, kind: 'weather-view', actual: response.weatherView, expected: expected.weatherView });
  }
  const speech = Array.isArray(response.speeches) ? response.speeches.join(' ') : '';
  for (const token of expected.speechIncludes || []) {
    if (!speech.includes(token)) differences.push({ id, side, kind: 'speech-token', token });
  }

  const requests = expectedRequests(item);
  if (canonical(row.dataRequests) !== canonical(requests)) {
    differences.push({ id, side, kind: 'provider-requests', actual: row.dataRequests, expected: requests });
  }
  const weatherRequests = requests.filter((request) => request.path === '/v1/dark_sky');
  if (canonical(row.weatherRequests) !== canonical(weatherRequests)) {
    differences.push({ id, side, kind: 'dark-sky-requests', actual: row.weatherRequests, expected: weatherRequests });
  }
  const requestExpectation = row.requestExpectation || {};
  const expectedRequestExpectation = {
    count: 2,
    queryLat: matrix.coordinates.queryLat,
    queryLon: matrix.coordinates.queryLon,
    yesterdayTimestamp: expectedTimestamp(item),
    newsSourceIDs: expectedNewsIDs(item),
  };
  if (canonical(requestExpectation) !== canonical(expectedRequestExpectation)) {
    differences.push({ id, side, kind: 'request-expectation', actual: requestExpectation, expected: expectedRequestExpectation });
  }
}

const differences = [];
const sourceRows = rowsById(source, 'source', differences);
const candidateRows = rowsById(candidate, 'candidate', differences);
const sourceOrder = Array.isArray(source?.rows) ? source.rows.map((row) => row && row.id) : [];
const candidateOrder = Array.isArray(candidate?.rows) ? candidate.rows.map((row) => row && row.id) : [];
const matrixOrder = matrix.cases.map((item) => item.id);
if (canonical(sourceOrder) !== canonical(matrixOrder)) {
  differences.push({ side: 'source', kind: 'row-order', actual: sourceOrder, expected: matrixOrder });
}
if (canonical(candidateOrder) !== canonical(matrixOrder)) {
  differences.push({ side: 'candidate', kind: 'row-order', actual: candidateOrder, expected: matrixOrder });
}

for (const item of matrix.cases) {
  const sourceRow = sourceRows.get(item.id);
  const candidateRow = candidateRows.get(item.id);
  compareRow(item, sourceRow, 'source', differences);
  compareRow(item, candidateRow, 'candidate', differences);
  if (sourceRow && candidateRow) {
    const sourceResponse = sourceRow.response || {};
    const candidateResponse = candidateRow.response || {};
    for (const key of ['responseType', 'final', 'mimIds', 'weatherView', 'speeches', 'action', 'analytics', 'transitions']) {
      if (canonical(sourceResponse[key]) !== canonical(candidateResponse[key])) {
        differences.push({ id: item.id, kind: 'source-candidate-response', field: key,
          source: sourceResponse[key], candidate: candidateResponse[key] });
      }
    }
    if (canonical(sourceRow.dataRequests) !== canonical(candidateRow.dataRequests)) {
      differences.push({ id: item.id, kind: 'source-candidate-requests',
        source: sourceRow.dataRequests, candidate: candidateRow.dataRequests });
    }
  }
}

const outputPath = path.resolve(outputArg || path.join(path.dirname(candidatePath), 'comparison.json'));
const result = {
  schema: 's09-report-weather-http-comparison-v1',
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
