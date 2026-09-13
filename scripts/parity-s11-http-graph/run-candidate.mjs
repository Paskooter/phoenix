#!/usr/bin/env node

// Run Phoenix's real Report HTTP graph against the same local Google Maps
// peer used by the pinned Pegasus runner. The peer records the provider wire
// contract; no external network is involved.

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
if (matrix.schema !== 's11-report-commute-http-v1') throw new Error('unsupported S-11 matrix schema');
if (matrix.referenceRevision !== 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c') throw new Error('unexpected Pegasus reference revision');
if (matrix.sourceImage !== 'node' || matrix.sourceImageDigest !== 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c') throw new Error('unexpected source image pin');
const require = createRequire(import.meta.url);
const fixtures = require(path.join(path.dirname(new URL(import.meta.url).pathname), 'maps-fixtures.cjs'));

const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sourceRevision = matrix.referenceRevision;
const candidateRevision = process.env.PHOENIX_CANDIDATE_REVISION || 'working-tree';
const calls = [];
let currentCase;

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function createDataPeer() {
  return http.createServer((req, res) => {
    const requestURL = new URL(req.url, 'http://maps-data-peer');
    const query = {};
    for (const [key, value] of requestURL.searchParams.entries()) query[key] = value;
    const entry = {
      sequence: calls.length,
      method: req.method,
      path: requestURL.pathname,
      rawQuery: requestURL.search ? requestURL.search.slice(1) : '',
      query,
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    calls.push(entry);

    const service = requestURL.pathname === '/v1/google_maps' ? 'maps'
      : (requestURL.pathname === '/v1/google_calendar' || requestURL.pathname === '/v1/outlook_calendar') ? 'calendar'
        : requestURL.pathname === '/v1/dark_sky' ? 'weather'
          : requestURL.pathname === '/v1/ap_news' ? 'news' : null;
    if (!service) {
      entry.status = 404;
      return send(res, 404, 'not found', 'text/plain');
    }
    const failed = currentCase.failure === 'all'
      || (Array.isArray(currentCase.providerFailures) && currentCase.providerFailures.includes(service));
    if (failed) {
      entry.status = 503;
      return send(res, 503, `${service} fixture failure`, 'text/plain');
    }
    entry.status = 200;
    return send(res, 200, fixtures.buildProviderResponse(service, currentCase, query));
  });
}

function prefsFor(item, log) {
  if (item.settingsFailure) throw new Error('settings fixture failure');
  if (item.identity === 'unidentified') return SettingsClient.getDefaultPrefs(log);

  const defaults = SettingsClient.getDefaultPrefs(log);
  const p = item.prefs || {};
  const active = item.active || { weather: false, calendar: false, commute: true, news: false };
  defaults.weather.active = !!active.weather;
  defaults.calendar.active = !!active.calendar;
  defaults.commute.active = !!active.commute;
  defaults.news.active = !!active.news;
  defaults.calendar.googlePersonalCreds = false;
  defaults.calendar.googleWorkCreds = false;
  defaults.calendar.outlookPersonalCreds = false;
  defaults.calendar.outlookWorkCreds = false;
  (item.calendarCredentials || []).forEach((key) => { defaults.calendar[key] = true; });
  defaults.commute = {
    active: !!active.commute,
    workTime: { hour: p.workHour === undefined ? 9 : p.workHour, min: p.workMin === undefined ? 0 : p.workMin },
    origin: { lat: p.originLat === undefined ? matrix.origin.lat : p.originLat, lng: p.originLng === undefined ? matrix.origin.lng : p.originLng },
    destination: { lat: p.destinationLat === undefined ? matrix.destination.lat : p.destinationLat, lng: p.destinationLng === undefined ? matrix.destination.lng : p.destinationLng },
    mode: p.mode === undefined ? 'driving' : p.mode,
    complete: p.complete !== false && !p.invalid,
  };
  defaults.news.activeNewsCategories = {
    technology: false, sports: false, business: false, science: false, entertainment: false,
    strange: false, health: false, international: false, national: false, politics: false,
  };
  return defaults;
}

function speakerKind(item, turn) {
  if (turn && Object.prototype.hasOwnProperty.call(turn, 'identity')) return turn.identity;
  return item.identity || 'identified';
}

function runtimeFor(item, turn) {
  const kind = speakerKind(item, turn);
  const speaker = kind === 'unidentified' || kind === 'notInLoop' ? null
    : kind === 'child' ? 'test-looper-id-child' : 'test-looper-id-3';
  return {
    loop: {
      loopId: 'test-loop-id',
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'white' },
      owner: 'test-looper-id-2',
      users: [
        { id: 'test-looper-id-2', accountId: 'test-account-id-2', birthdate: 220924800000, gender: 'male', phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George' },
        { id: 'test-looper-id-3', accountId: 'test-account-id-3', birthdate: 444528000000, gender: 'female', phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane' },
        { id: 'test-looper-id-4', accountId: 'test-account-id-4', birthdate: 983577600000, gender: 'female', phoneticName: 'Judy', lastName: 'Jetson', firstName: 'Judy' },
        { id: 'test-looper-id-child', accountId: 'test-account-id-child', birthdate: 1546300800000, gender: 'female', phoneticName: 'Kid', lastName: 'Jetson', firstName: 'Kid' },
      ],
    },
    location: {
      lng: -71.1273681,
      lat: 42.313352,
      country: 'usa', countryCode: 'US', stateAbbr: 'ma', state: 'Massachusetts', city: 'boston',
      iso: item.locationISO || matrix.locationISO,
    },
    perception: { peoplePresent: [], speaker },
    character: { motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 }, emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

function requestBody(item, turn, session) {
  const initial = !turn;
  return {
    type: initial ? 'LISTEN_LAUNCH' : 'LISTEN_UPDATE',
    msgID: `s11-${item.id}-${initial ? 'launch' : 'turn'}`,
    ts: 1,
    data: {
      general: { accountID: 'some-account-id', robotID: 'some-robot-id', lang: 'en-US' },
      runtime: runtimeFor(item, turn),
      skill: Object.assign({ id: 'report-skill' }, session ? { session } : {}),
      result: initial ? {
        nlu: { intent: item.intent, entities: item.entities || {}, rules: [] },
        asr: { text: '', confidence: 1 },
        memo: 'Reactive',
      } : {
        nlu: { intent: turn.intent || null, entities: turn.entities || {}, rules: [] },
        asr: { text: turn.asr || '', confidence: 1 },
      },
    },
  };
}

const GENERATED_ACTION_ID_PATHS = new Set([
  'config.jcp.id',
  'config.jcp.children[*].id',
  'config.jcp.children[*].config.play.id',
  'config.jcp.children[*].config.display.id',
  'config.jcp.config.play.id',
  'config.jcp.config.display.id',
  'config.jcp.config.listen.id',
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
  const trafficClip = component('trafficClip');
  const departTime = component('departTimeLabel');
  const departAmPm = component('departAmPmLabel');
  return {
    id: data?.viewConfig?.id || null,
    trafficSource: trafficClip?.assets?.[0]?.src || null,
    trafficX: trafficClip?.position?.x ?? null,
    trafficY: trafficClip?.position?.y ?? null,
    departTime: departTime?.text || null,
    departAmPm: departAmPm?.text || null,
    defaultSelect: data?.defaultSelect || null,
    open: data?.open || null,
  };
}

function actionSummary(response) {
  const data = response?.data;
  const mims = mimsFromAction(data?.action);
  const commuteMims = mims.filter((mim) => mim.mim_id.startsWith('Commute'));
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
    commuteSpeeches: commuteMims.map((mim) => mim.esml),
    commuteViews: commuteMims.filter((mim) => mim.display).map((mim) => ({ mim_id: mim.mim_id, view: viewProjection(mim.display) })),
    action: normalizeAction(data?.action),
    analytics,
    resultsAnalytics: resultsEvent?.properties || null,
    transitions: data?.skill?.session?.trace?.map((entry) => entry.transition) || [],
  };
}

async function runCase(reportBase, item) {
  currentCase = item;
  calls.length = 0;
  Date.now = () => Date.parse(item.nowISO || item.locationISO || matrix.locationISO);
  const responses = [];
  const responseStatuses = [];
  let session;
  for (let i = 0; i <= (item.turns || []).length; i += 1) {
    const turn = i === 0 ? null : item.turns[i - 1];
    const response = await fetch(`${reportBase}/v1/main`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jibo-transid': 'tid:1234',
        'x-jibo-robotid': 'unknown',
        'x-jibo-logging-config': '{}',
      },
      body: JSON.stringify(requestBody(item, turn, session)),
    });
    const responseText = await response.text();
    let body;
    try { body = JSON.parse(responseText); } catch { body = responseText; }
    responseStatuses.push(response.status);
    responses.push({ httpStatus: response.status, summary: actionSummary(body) });
    session = body?.data?.skill?.session;
  }
  const dataCalls = calls.map(clone);
  return {
      id: item.id,
      httpStatus: responseStatuses.length ? responseStatuses[responseStatuses.length - 1] : null,
      response: responses[responses.length - 1]?.summary || null,
      responses: responses.map((entry) => entry.summary),
      responseStatuses,
    dataRequests: dataCalls,
    mapRequests: dataCalls.filter((entry) => entry.path === '/v1/google_maps'),
    requestExpectation: { count: dataCalls.length, requests: dataCalls },
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
  SettingsClient.getUserPrefs = async (data) => prefsFor(currentCase, data?.log);
  const handler = getReportSkill({ graphManager: new GraphManager() });
  reportService = await createSkillService({ name: 'report-skill', skillId: 'report-skill', handler }).listen(0);
  const reportBase = `http://127.0.0.1:${reportService.address().port}`;
  const rows = [];
  for (const item of matrix.cases) rows.push(await runCase(reportBase, item));
  const result = {
    schema: 's11-report-commute-http-receipt-v1',
    mode: 'candidate',
    sourceRevision,
    candidateRevision,
    network: 'loopback-only',
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
