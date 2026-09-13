#!/usr/bin/env node

// Run Phoenix's real report HTTP graph against the local AP-shaped Data peer.
// The peer is providerless and records the exact legacy request contract.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSkillService } from '../../packages/skills/src/skillService.js';
import { getReportSkill } from '../../packages/skills/src/reportSkill.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-candidate.mjs <matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's10-report-news-http-v1') throw new Error('unsupported S-10 matrix schema');
const require = createRequire(import.meta.url);
const fixtures = require(path.join(path.dirname(new URL(import.meta.url).pathname), 'ap-fixtures.cjs'));

const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sourceRevision = matrix.referenceRevision;
const candidateRevision = process.env.PHOENIX_CANDIDATE_REVISION || 'working-tree';
const calls = [];
let currentCase;

function failureFor(item, sourceID) {
  return item.failure === 'all'
    || (item.failure && Array.isArray(item.failure.sourceIDs) && item.failure.sourceIDs.includes(String(sourceID)));
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function createDataPeer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://ap-data-peer');
    const query = {};
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
    const entry = {
      sequence: calls.length,
      method: req.method,
      path: url.pathname,
      query,
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    calls.push(entry);

    if (url.pathname !== '/v1/ap_news') {
      entry.status = 404;
      return send(res, 404, 'not found', 'text/plain');
    }
    const sourceID = query.sourceID;
    if (failureFor(currentCase, sourceID)) {
      entry.status = 503;
      return send(res, 503, `AP fixture failure for ${sourceID}`, 'text/plain');
    }
    entry.status = 200;
    return send(res, 200, {
      relayData: fixtures.buildFeed(currentCase.fixture, sourceID),
      lassoDataFromRedis: false,
    });
  });
}

const CATEGORY_NAMES = matrix.categoryOrder || Object.keys(matrix.categorySourceIDs);

function prefsFor(item) {
  if (item.settingsFailure) throw new Error('settings fixture failure');
  if (item.identity === 'unidentified') {
    return SettingsClient.getDefaultPrefs();
  }
  const categories = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, false]));
  Object.assign(categories, item.prefs.categories || {});
  return {
    weather: { active: !!item.prefs.weather, useCelsius: false },
    calendar: {
      active: false,
      googlePersonalCreds: false,
      googleWorkCreds: false,
      outlookPersonalCreds: false,
      outlookWorkCreds: false,
    },
    commute: {
      active: false,
      workTime: { hour: null, min: null },
      origin: { lat: null, lng: null },
      destination: { lat: null, lng: null },
      mode: null,
      complete: false,
    },
    news: { active: !!item.prefs.news, activeNewsCategories: categories },
  };
}

function runtimeFor(item) {
  return {
    loop: {
      loopId: 'test-loop-id',
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'white' },
      owner: 'test-looper-id-2',
      users: [
        { id: 'test-looper-id-2', accountId: 'test-account-id-2', birthdate: 220924800000, gender: 'male', phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George' },
        { id: 'test-looper-id-3', accountId: 'test-account-id-3', birthdate: 444528000000, gender: 'female', phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane' },
        { id: 'test-looper-id-4', accountId: 'test-account-id-4', birthdate: 983577600000, gender: 'female', phoneticName: 'Judy', lastName: 'Jetson', firstName: 'Judy' },
      ],
    },
    location: {
      lng: -71.1273681,
      lat: 42.313352,
      country: 'usa', countryCode: 'US', stateAbbr: 'ma', state: 'Massachusetts', city: 'boston',
      iso: item.locationISO || matrix.locationISO,
    },
    perception: { peoplePresent: [], speaker: item.identity === 'unidentified' ? null : 'test-looper-id-3' },
    character: { motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 }, emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

function requestBody(item) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: `s10-${item.id}`,
    ts: 1,
    data: {
      general: { accountID: 'some-account-id', robotID: 'some-robot-id', lang: 'en-US' },
      runtime: runtimeFor(item),
      skill: { id: 'report-skill' },
      result: {
        nlu: { intent: item.intent, entities: {}, rules: [] },
        asr: { text: '', confidence: 1 },
        memo: 'Reactive',
      },
    },
  };
}

const GENERATED_ACTION_ID_PATHS = new Set([
  'config.jcp.id',
  'config.jcp.children[*].id',
  'config.jcp.children[*].config.play.id',
  'config.jcp.children[*].config.display.id',
]);

function normalizeAction(value, pathName = '') {
  if (Array.isArray(value)) return value.map((child, index) => normalizeAction(child, `${pathName}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = pathName ? `${pathName}.${key}` : key;
    const wildcardPath = childPath.replace(/children\[\d+\]/g, 'children[*]');
    if (key === 'id' && GENERATED_ACTION_ID_PATHS.has(wildcardPath)) continue;
    out[key] = normalizeAction(value[key], childPath);
  }
  return out;
}

function mimsFromAction(action) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'SLIM' && value.config?.play?.meta?.mim_id) {
      const config = value.config;
      out.push({
        mim_id: config.play.meta.mim_id,
        prompt_id: config.play.meta.prompt_id || null,
        esml: config.play.esml || '',
        display: config.display || null,
      });
      return;
    }
    Object.values(value).forEach(walk);
  };
  walk(action);
  return out;
}

function viewProjection(display) {
  const data = display?.view?.context?.data;
  const components = data?.componentConfigs || [];
  const component = (id) => components.find((item) => item.id === id);
  const headlineClip = component('headlineClip');
  const categoryText = component('categoryText');
  return {
    id: data?.viewConfig?.id || null,
    source: headlineClip?.assets?.[0]?.src || null,
    scale: headlineClip?.transform?.scaleX ?? null,
    x: headlineClip?.position?.x ?? null,
    y: headlineClip?.position?.y ?? null,
    category: categoryText?.text || null,
    leaveEmpty: data?.defaultSelect?.leaveEmpty ?? null,
  };
}

function actionSummary(response) {
  const data = response?.data;
  const mims = mimsFromAction(data?.action);
  const newsMims = mims.filter((mim) => mim.mim_id === 'NewsHeadline');
  const analytics = normalizeAction(data?.analytics);
  const analyticsEvents = analytics?.['report-skill'] || [];
  const resultsEvent = analyticsEvents.find((event) => event.event === 'Personal Report Results');
  return {
    responseType: response?.type || null,
    final: data?.final ?? null,
    mims,
    mimIds: mims.map((mim) => mim.mim_id),
    promptIds: mims.map((mim) => mim.prompt_id),
    speeches: mims.map((mim) => mim.esml),
    headlineSpeeches: newsMims.map((mim) => mim.esml),
    newsViews: newsMims.map((mim) => viewProjection(mim.display)),
    action: normalizeAction(data?.action),
    analytics,
    resultsAnalytics: resultsEvent?.properties || null,
    transitions: data?.skill?.session?.trace?.map((entry) => entry.transition) || [],
  };
}

function expectedSourceIDs(item) {
  const categories = item.prefs.categories || {};
  const configured = CATEGORY_NAMES
    .filter((name) => categories[name])
    .map((name) => matrix.categorySourceIDs[name]);
  return configured.length ? configured : matrix.defaultNewsSourceIDs;
}

async function runCase(reportBase, item) {
  currentCase = item;
  calls.length = 0;
  Date.now = () => Date.parse(item.nowISO || item.locationISO || matrix.locationISO);
  const response = await fetch(`${reportBase}/v1/main`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-jibo-transid': 'tid:1234',
      'x-jibo-robotid': 'unknown',
      'x-jibo-logging-config': '{}',
    },
    body: JSON.stringify(requestBody(item)),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const dataCalls = calls.map(clone);
  return {
    id: item.id,
    httpStatus: response.status,
    response: actionSummary(body),
    dataRequests: dataCalls,
    newsRequests: dataCalls.filter((entry) => entry.path === '/v1/ap_news'),
    requestExpectation: {
      count: expectedSourceIDs(item).length,
      sourceIDs: expectedSourceIDs(item),
    },
  };
}

const dataPeer = createDataPeer();
Math.random = () => 0;
await new Promise((resolve) => dataPeer.listen(0, '127.0.0.1', resolve));
process.env.NET_lasso = `127.0.0.1:${dataPeer.address().port}`;
delete process.env.NET_data;
delete process.env.NET_settings;
process.env.prefsFromConfig = 'false';
clearReportEnvCache();

const originalGetUserPrefs = SettingsClient.getUserPrefs;
let reportService;
try {
  SettingsClient.getUserPrefs = async () => prefsFor(currentCase);
  const handler = getReportSkill({ graphManager: new GraphManager() });
  reportService = await createSkillService({ name: 'report-skill', skillId: 'report-skill', handler }).listen(0);
  const reportBase = `http://127.0.0.1:${reportService.address().port}`;
  const rows = [];
  for (const item of matrix.cases) rows.push(await runCase(reportBase, item));
  const result = {
    schema: 's10-report-news-http-receipt-v1',
    mode: 'candidate',
    sourceRevision,
    candidateRevision,
    runtime: process.version,
    rows,
  };
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ mode: result.mode, rows: rows.length, httpFailures: rows.filter((row) => row.httpStatus !== 200).length }));
} finally {
  SettingsClient.getUserPrefs = originalGetUserPrefs;
  if (reportService) await new Promise((resolve) => reportService.close(resolve));
  await new Promise((resolve) => dataPeer.close(resolve));
}
