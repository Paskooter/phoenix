#!/usr/bin/env node

// Fail-closed comparator for the pinned Pegasus and current Phoenix commute
// HTTP receipts. Ordered graph output and the exact Maps request are both
// part of the comparison; a plausible subset cannot pass.

import fs from 'node:fs';
import path from 'node:path';

const [matrixPath, sourcePath, candidatePath, outputArg] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) {
  throw new Error('usage: compare.mjs <matrix.json> <source.json> <candidate.json> [comparison.json]');
}

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const matrix = readJSON(matrixPath);
const source = readJSON(sourcePath);
const candidate = readJSON(candidatePath);
if (matrix.schema !== 's11-report-commute-http-v1') throw new Error('unsupported S-11 matrix schema');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
const canonical = (value) => JSON.stringify(stable(value));

function axiosEncode(value) {
  return encodeURIComponent(value)
    .replace(/%40/gi, '@').replace(/%3A/gi, ':').replace(/%24/g, '$').replace(/%2C/gi, ',')
    .replace(/%20/gi, '+').replace(/%5B/gi, '[').replace(/%5D/gi, ']');
}

const requestHeaders = { transID: 'tid:1234', robotID: 'unknown', loggingConfig: '{}' };
const expectedSourceRevision = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';
const expectedSourceImage = 'node';
const expectedSourceImageDigest = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';

function speakerKind(item, turn) {
  if (turn && Object.prototype.hasOwnProperty.call(turn, 'identity')) return turn.identity;
  return item.identity || 'identified';
}

function providerFailure(item, service) {
  return item.failure === 'all'
    || (Array.isArray(item.providerFailures) && item.providerFailures.includes(service));
}

function expectedProviderRequests(item) {
  const p = item.prefs || {};
  if (item.settingsFailure || ['unidentified', 'child', 'notInLoop'].includes(speakerKind(item))) return [];
  const active = item.active || { weather: false, calendar: false, commute: true, news: false };
  const requests = [];
  const push = (pathName, rawQuery, query, status) => requests.push({
    sequence: requests.length,
    method: 'GET',
    path: pathName,
    rawQuery,
    query,
    headers: requestHeaders,
    status,
  });

  // Commute asks CalendarData for context whenever commute is active. A
  // credential is required before CalendarData makes a provider request.
  const credentials = item.calendarCredentials || [];
  const calendarCalls = [];
  if ((active.calendar || active.commute) && credentials.length) {
    if (credentials.includes('googlePersonalCreds')) calendarCalls.push(['google', 'personalCalendar']);
    else if (credentials.includes('outlookPersonalCreds')) calendarCalls.push(['outlook', 'personalCalendar']);
    if (credentials.includes('googleWorkCreds')) calendarCalls.push(['google', 'workCalendar']);
    else if (credentials.includes('outlookWorkCreds')) calendarCalls.push(['outlook', 'workCalendar']);
  }
  for (const [provider, calendar] of calendarCalls) {
    const iso = item.locationISO || matrix.locationISO;
    const offsetMatch = /([+-]\d\d:\d\d|Z)$/.exec(iso);
    const offset = offsetMatch ? offsetMatch[1] : 'Z';
    const nextDate = new Date(Date.parse(iso) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = `${nextDate}T23:59:59${offset}`;
    const query = { skillId: 'report-skill', accountId: 'test-account-id-3', calendar, endDate };
    const rawQuery = Object.entries(query).map(([key, value]) => `${axiosEncode(key)}=${axiosEncode(value)}`).join('&');
    push(`/v1/${provider}_calendar`, rawQuery, query, providerFailure(item, 'calendar') ? 503 : 200);
  }

  if (active.weather) {
    const now = Date.parse(item.nowISO || item.locationISO || matrix.locationISO);
    const historical = { lat: '42.3134', lon: '-71.1274', secondsSinceEpoch: String(Math.round((now - 24 * 60 * 60 * 1000) / 1000)) };
    const current = { lat: '42.3134', lon: '-71.1274' };
    push('/v1/dark_sky', Object.entries(historical).map(([key, value]) => `${key}=${axiosEncode(value)}`).join('&'), historical, providerFailure(item, 'weather') ? 503 : 200);
    push('/v1/dark_sky', Object.entries(current).map(([key, value]) => `${key}=${axiosEncode(value)}`).join('&'), current, providerFailure(item, 'weather') ? 503 : 200);
  }

  if (active.commute && p.complete !== false && !p.invalid && p.mode !== null && p.workHour !== null && p.workMin !== null) {
    const origin = { lat: p.originLat === undefined ? matrix.origin.lat : p.originLat, lon: p.originLng === undefined ? matrix.origin.lng : p.originLng };
    const destination = { lat: p.destinationLat === undefined ? matrix.destination.lat : p.destinationLat, lon: p.destinationLng === undefined ? matrix.destination.lng : p.destinationLng };
    const mode = p.mode === undefined ? 'driving' : p.mode;
    const query = { origin: JSON.stringify(origin), destination: JSON.stringify(destination), mode };
    const rawQuery = `origin=${axiosEncode(query.origin)}&destination=${axiosEncode(query.destination)}&mode=${axiosEncode(mode)}`;
    push('/v1/google_maps', rawQuery, query, providerFailure(item, 'maps') ? 503 : 200);
  }

  if (active.news) {
    const categorySourceIDs = { technology: 42208, sports: 42207, business: 42200, national: 42210 };
    const configured = Object.entries(item.newsCategories || {}).filter(([, enabled]) => enabled)
      .map(([category]) => categorySourceIDs[category]).filter((value) => value !== undefined);
    const sourceIDs = configured.length ? configured : [42208, 42207, 42200, 42210];
    for (const sourceID of sourceIDs) {
      const query = { sourceID: String(sourceID) };
      push('/v1/ap_news', `sourceID=${axiosEncode(query.sourceID)}`, query, providerFailure(item, 'news') ? 503 : 200);
    }
  }
  return requests;
}

function expectedResultAnalytics(item) {
  const kind = speakerKind(item);
  if (item.settingsFailure || ['unidentified', 'child', 'notInLoop'].includes(kind)) return null;
  const active = item.active || { weather: false, calendar: false, commute: true, news: false };
  const p = item.prefs || {};
  const categories = [];
  const status = [];
  if (active.weather) { categories.push('weather'); status.push(`weather=${providerFailure(item, 'weather') ? 'down' : 'up'}`); }
  if (active.calendar) { categories.push('calendar'); status.push(`calendar=${providerFailure(item, 'calendar') ? 'down' : 'up'}`); }
  if (active.commute) {
    categories.push('commute');
    const down = providerFailure(item, 'maps') || item.fixture === 'empty-envelope' || item.fixture === 'null-envelope';
    status.push(`commute=${down ? 'down' : 'up'}`);
  }
  if (active.news) {
    categories.push('news');
    // AP News catches per-category failures into an error-bearing array,
    // which remains truthy at the report analytics boundary.
    status.push('news=up');
  }
  if (!categories.length) return null;
  const allDown = categories.every((category) => {
    if (category === 'weather' || category === 'calendar') return providerFailure(item, category);
    if (category === 'commute') return providerFailure(item, 'maps') || item.fixture === 'empty-envelope' || item.fixture === 'null-envelope';
    return false;
  });
  if (allDown && !active.news && item.intent === 'launchPersonalReport') return null;
  return { details: categories.join(','), service_details: status.join(','), config_state: 'not configured' };
}

function rowsById(receipt, side, differences) {
  if (!receipt || receipt.schema !== 's11-report-commute-http-receipt-v1') {
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

function compareViews(item, response, side, differences) {
  const expectedMims = item.expected && item.expected.mims || [];
  const views = Array.isArray(response.commuteViews) ? response.commuteViews : [];
  const viewByMim = new Map(views.map((entry) => [entry.mim_id, entry.view]));
  const trafficMim = expectedMims.find((mim) => /Commute(?:Drive|Transport)(?:Normal|Poor|Terrible)$/.test(mim));
  const departMim = expectedMims.find((mim) => mim === 'CommuteDepartTimeNormal' || mim === 'CommuteDepartTimeNotNormal');
  if (trafficMim && !viewByMim.has(trafficMim)) {
    differences.push({ id: item.id, side, kind: 'traffic-view-missing', expected: trafficMim, actual: views });
  }
  if (departMim && !viewByMim.has(departMim)) {
    differences.push({ id: item.id, side, kind: 'departure-view-missing', expected: departMim, actual: views });
  }
  if (!trafficMim && !departMim && views.length) {
    differences.push({ id: item.id, side, kind: 'unexpected-commute-view', actual: views });
  }
  if (trafficMim) {
    const view = viewByMim.get(trafficMim);
    const p = item.prefs || {};
    const baseSeconds = p.baseSeconds || 0;
    const trafficSeconds = p.trafficSeconds === undefined || p.trafficSeconds === null ? 0 : p.trafficSeconds;
    const extraMins = Math.max(0, Math.floor((trafficSeconds - baseSeconds) / 60));
    const condition = extraMins >= 15 ? 'Terrible' : extraMins >= 5 ? 'Bad' : 'Normal';
    const expectedSource = `assets/personal-report-skill/commute/traffic${condition}_v01.crn`;
    if (!view || view.trafficSource !== expectedSource) {
      differences.push({ id: item.id, side, kind: 'traffic-view-source', actual: view && view.trafficSource || null, expected: expectedSource });
    }
    if (!view || view.id !== 'trafficView') {
      differences.push({ id: item.id, side, kind: 'traffic-view-id', actual: view && view.id || null, expected: 'trafficView' });
    }
  }
  if (departMim) {
    const view = viewByMim.get(departMim);
    if (!view || view.id !== 'departTimeView' || !view.departTime || !view.departAmPm) {
      differences.push({ id: item.id, side, kind: 'departure-view-fields', actual: view || null });
    }
  }
}

function compareResponseExpected(item, row, side, differences) {
  const id = item.id;
  if (!row) {
    differences.push({ id, side, kind: 'missing-row' });
    return;
  }
  if (row.httpStatus !== 200) differences.push({ id, side, kind: 'http-status', actual: row.httpStatus });
  const response = row.response || {};
  const expected = item.expected || {};
  const expectedType = expected.responseType || 'SKILL_ACTION';
  if (response.responseType !== expectedType) differences.push({ id, side, kind: 'response-type', actual: response.responseType, expected: expectedType });
  const expectedFinal = expectedType === 'ERROR' ? null : (typeof expected.final === 'boolean' ? expected.final : true);
  if (response.final !== expectedFinal) differences.push({ id, side, kind: 'final', actual: response.final, expected: expectedFinal });
  if (canonical(response.mimIds) !== canonical(expected.mims || [])) differences.push({ id, side, kind: 'mim-order', actual: response.mimIds, expected: expected.mims || [] });
  if (expected.promptIds && canonical(response.promptIds) !== canonical(expected.promptIds)) differences.push({ id, side, kind: 'prompt-ids', actual: response.promptIds, expected: expected.promptIds });

  const speech = Array.isArray(response.speeches) ? response.speeches.join(' ') : '';
  for (const token of expected.speechIncludes || []) if (!speech.includes(token)) differences.push({ id, side, kind: 'speech-token-missing', token });
  for (const token of expected.speechExcludes || []) if (speech.includes(token)) differences.push({ id, side, kind: 'speech-token-present', token });

  const expectedAnalytics = expectedResultAnalytics(item);
  if (canonical(response.resultsAnalytics) !== canonical(expectedAnalytics)) differences.push({ id, side, kind: 'results-analytics-expected', actual: response.resultsAnalytics, expected: expectedAnalytics });
  compareViews(item, response, side, differences);

  const requests = expectedProviderRequests(item);
  if (canonical(row.dataRequests) !== canonical(requests)) differences.push({ id, side, kind: 'provider-requests', actual: row.dataRequests, expected: requests });
  const mapRequests = requests.filter((request) => request.path === '/v1/google_maps');
  if (canonical(row.mapRequests) !== canonical(mapRequests)) differences.push({ id, side, kind: 'map-requests', actual: row.mapRequests, expected: mapRequests });
  const requestExpectation = row.requestExpectation || {};
  const expectedExpectation = { count: requests.length, requests };
  if (canonical(requestExpectation) !== canonical(expectedExpectation)) differences.push({ id, side, kind: 'request-expectation', actual: requestExpectation, expected: expectedExpectation });
}

function responseSequence(row, id, side, differences) {
  if (!Array.isArray(row.responses)) {
    differences.push({ id, side, kind: 'response-sequence-missing' });
    return [];
  }
  if (!row.responses.length) differences.push({ id, side, kind: 'response-sequence-empty' });
  row.responses.forEach((response, index) => {
    if (!response || typeof response !== 'object' || Array.isArray(response)) differences.push({ id, side, kind: 'response-without-summary', turn: index });
  });
  return row.responses;
}

function compareTurnExpectations(item, responses, side, differences) {
  const expectedTurns = item.expected && item.expected.turns;
  if (!expectedTurns) {
    if (responses.length !== 1) differences.push({ id: item.id, side, kind: 'response-sequence-length', actual: responses.length, expected: 1 });
    return;
  }
  if (responses.length !== expectedTurns.length) {
    differences.push({ id: item.id, side, kind: 'response-sequence-length', actual: responses.length, expected: expectedTurns.length });
  }
  expectedTurns.forEach((expected, index) => {
    const response = responses[index];
    if (!response || typeof response !== 'object') return;
    if (canonical(response.mimIds) !== canonical(expected.mims || [])) {
      differences.push({ id: item.id, side, kind: 'turn-mim-order', turn: index, actual: response.mimIds, expected: expected.mims || [] });
    }
    if (typeof expected.final === 'boolean' && response.final !== expected.final) {
      differences.push({ id: item.id, side, kind: 'turn-final', turn: index, actual: response.final, expected: expected.final });
    }
    if (expected.promptIds && canonical(response.promptIds) !== canonical(expected.promptIds)) {
      differences.push({ id: item.id, side, kind: 'turn-prompt-ids', turn: index, actual: response.promptIds, expected: expected.promptIds });
    }
  });
}

const differences = [];
const sourceRows = rowsById(source, 'source', differences);
const candidateRows = rowsById(candidate, 'candidate', differences);
const matrixOrder = matrix.cases.map((item) => item.id);
const sourceOrder = Array.isArray(source.rows) ? source.rows.map((row) => row && row.id) : [];
const candidateOrder = Array.isArray(candidate.rows) ? candidate.rows.map((row) => row && row.id) : [];
if (canonical(sourceOrder) !== canonical(matrixOrder)) differences.push({ side: 'source', kind: 'row-order', actual: sourceOrder, expected: matrixOrder });
if (canonical(candidateOrder) !== canonical(matrixOrder)) differences.push({ side: 'candidate', kind: 'row-order', actual: candidateOrder, expected: matrixOrder });

function compareReceiptMetadata(receipt, side, differences) {
  if (!receipt) return;
  if (receipt.sourceRevision !== expectedSourceRevision) {
    differences.push({ side, kind: 'source-revision', actual: receipt.sourceRevision || null, expected: expectedSourceRevision });
  }
  if (side === 'source') {
    if (receipt.sourceImage !== expectedSourceImage) differences.push({ side, kind: 'source-image', actual: receipt.sourceImage || null, expected: expectedSourceImage });
    if (receipt.sourceImageDigest !== expectedSourceImageDigest) differences.push({ side, kind: 'source-image-digest', actual: receipt.sourceImageDigest || null, expected: expectedSourceImageDigest });
    if (receipt.network !== 'none') differences.push({ side, kind: 'source-network', actual: receipt.network || null, expected: 'none' });
    if (receipt.runtime !== 'v8.9.4') differences.push({ side, kind: 'source-runtime', actual: receipt.runtime || null, expected: 'v8.9.4' });
  } else {
    if (typeof receipt.candidateRevision !== 'string' || !receipt.candidateRevision) differences.push({ side, kind: 'candidate-revision', actual: receipt.candidateRevision || null });
    if (receipt.network !== 'loopback-only') differences.push({ side, kind: 'candidate-network', actual: receipt.network || null, expected: 'loopback-only' });
    if (typeof receipt.runtime !== 'string' || !/^v\d+\.\d+\.\d+$/.test(receipt.runtime)) differences.push({ side, kind: 'candidate-runtime', actual: receipt.runtime || null });
  }
}

compareReceiptMetadata(source, 'source', differences);
compareReceiptMetadata(candidate, 'candidate', differences);

// These fields cover the ordered MIM sequence, prompt selection and ESML,
// display payloads, full normalized JCP, analytics, and graph transitions.
const responseFields = [
  'responseType', 'final', 'mimIds', 'promptIds', 'speeches', 'commuteSpeeches',
  'commuteViews', 'action', 'analytics', 'resultsAnalytics', 'transitions',
];
for (const item of matrix.cases) {
  const sourceRow = sourceRows.get(item.id);
  const candidateRow = candidateRows.get(item.id);
  compareResponseExpected(item, sourceRow, 'source', differences);
  compareResponseExpected(item, candidateRow, 'candidate', differences);
  if (!sourceRow || !candidateRow) continue;
  const sourceResponse = sourceRow.response || {};
  const candidateResponse = candidateRow.response || {};
  for (const field of responseFields) {
    if (canonical(sourceResponse[field]) !== canonical(candidateResponse[field])) {
      differences.push({ id: item.id, kind: 'source-candidate-response', field, source: sourceResponse[field], candidate: candidateResponse[field] });
    }
  }
  for (const field of ['dataRequests', 'mapRequests', 'requestExpectation']) {
    if (canonical(sourceRow[field]) !== canonical(candidateRow[field])) {
      differences.push({ id: item.id, kind: 'source-candidate-requests', field, source: sourceRow[field], candidate: candidateRow[field] });
    }
  }
  const sourceResponses = responseSequence(sourceRow, item.id, 'source', differences);
  const candidateResponses = responseSequence(candidateRow, item.id, 'candidate', differences);
  compareTurnExpectations(item, sourceResponses, 'source', differences);
  compareTurnExpectations(item, candidateResponses, 'candidate', differences);
  if (sourceResponses.length !== candidateResponses.length) {
    differences.push({ id: item.id, kind: 'source-candidate-response-sequence-length', source: sourceResponses.length, candidate: candidateResponses.length });
  }
  for (const [side, row, responses] of [['source', sourceRow, sourceResponses], ['candidate', candidateRow, candidateResponses]]) {
    if (responses.length && canonical(row.response) !== canonical(responses[responses.length - 1])) {
      differences.push({ id: item.id, side, kind: 'response-tail-mismatch' });
    }
    if (!Array.isArray(row.responseStatuses)) {
      differences.push({ id: item.id, side, kind: 'response-status-sequence-missing' });
    } else {
      if (row.responseStatuses.length !== responses.length) differences.push({ id: item.id, side, kind: 'response-status-sequence-length', actual: row.responseStatuses.length, expected: responses.length });
      row.responseStatuses.forEach((status, turn) => {
        if (status !== 200) differences.push({ id: item.id, side, kind: 'response-http-status', turn, actual: status, expected: 200 });
      });
    }
  }
  if (canonical(sourceRow.responseStatuses) !== canonical(candidateRow.responseStatuses)) {
    differences.push({ id: item.id, kind: 'source-candidate-response-statuses', source: sourceRow.responseStatuses, candidate: candidateRow.responseStatuses });
  }
  const turnCount = Math.min(sourceResponses.length, candidateResponses.length);
  for (let index = 0; index < turnCount; index += 1) {
    if (!sourceResponses[index] || typeof sourceResponses[index] !== 'object' || !candidateResponses[index] || typeof candidateResponses[index] !== 'object') continue;
    for (const field of responseFields) {
      if (canonical(sourceResponses[index][field]) !== canonical(candidateResponses[index][field])) {
        differences.push({ id: item.id, kind: 'source-candidate-response-sequence', turn: index, field, source: sourceResponses[index][field], candidate: candidateResponses[index][field] });
      }
    }
  }
}

const outputPath = path.resolve(outputArg || path.join(path.dirname(candidatePath), 'comparison.json'));
const result = {
  schema: 's11-report-commute-http-comparison-v1',
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
