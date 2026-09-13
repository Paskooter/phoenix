'use strict';

// Execute the pinned Pegasus Report HTTP graph in Node 8.9.4 against a local,
// providerless Google Maps peer. The source image is network-isolated by
// run.mjs; this process can only reach the peer bound inside this container.

const fs = require('fs');
const http = require('http');
const path = require('path');
const urlParse = require('url').parse;
const contract = require('./contract.cjs');

const referenceRoot = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-source.cjs <reference-root> <matrix.json> <output.json>');
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const matrixErrors = contract.validateMatrix(matrix, contract.EXPECTED_MATRIX_SEMANTIC_SHA256);
if (matrixErrors.length) throw new Error(`matrix contract mismatch: ${JSON.stringify(matrixErrors)}`);
if (process.version !== 'v8.9.4') throw new Error(`source runner requires Node v8.9.4, got ${process.version}`);
const fixtures = require(path.join(__dirname, 'maps-fixtures.cjs'));

process.env.TZ = 'UTC';
process.env.NET_settings = 'settings.jibo.aws';
process.env.prefsFromConfig = 'false';

const main = require(path.join(referenceRoot, 'packages/report-skill/lib/index.js'));
const baseskill = require(path.join(referenceRoot, 'packages/baseskill/lib/baseskill.js'));
const sourceGraph = require(path.join(referenceRoot, 'packages/baseskill/lib/graph/index.js'));
const { PersonalReport, SettingsClient } = main;
const { GraphManager } = sourceGraph;

const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sourceRevision = matrix.referenceRevision;
const calls = [];
let currentCase;

function send(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType || 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function createDataPeer() {
  return http.createServer((req, res) => {
    const parsed = urlParse(req.url, true);
    const query = parsed.query || {};
    const entry = {
      sequence: calls.length,
      method: req.method,
      path: parsed.pathname,
      rawQuery: (req.url || '').replace(/^[^?]*\??/, (match) => match.indexOf('?') >= 0 ? '' : match),
      query: clone(query),
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    // The replacement above intentionally leaves a bare query string. Keep it
    // explicit for a URL without `?`, which is useful in failure diagnostics.
    entry.rawQuery = (req.url && req.url.indexOf('?') >= 0) ? req.url.slice(req.url.indexOf('?') + 1) : '';
    calls.push(entry);

    const service = parsed.pathname === '/v1/google_maps' ? 'maps'
      : (parsed.pathname === '/v1/google_calendar' || parsed.pathname === '/v1/outlook_calendar') ? 'calendar'
        : parsed.pathname === '/v1/dark_sky' ? 'weather'
          : parsed.pathname === '/v1/ap_news' ? 'news' : null;
    if (!service) {
      entry.status = 404;
      return send(res, 404, 'not found', 'text/plain');
    }
    const failed = currentCase.failure === 'all'
      || (Array.isArray(currentCase.providerFailures) && currentCase.providerFailures.indexOf(service) >= 0);
    if (failed) {
      entry.status = 503;
      return send(res, 503, `${service} fixture failure`, 'text/plain');
    }
    entry.status = 200;
    return send(res, 200, fixtures.buildProviderResponse(service, currentCase, parsed.query || {}));
  });
}

function prefsFor(item, log) {
  if (item.settingsFailure) throw new Error('settings fixture failure');
  if (item.identity === 'unidentified') return SettingsClient.getDefaultPrefs(log);

  const defaults = SettingsClient.getDefaultPrefs(log);
  const p = item.prefs || {};
  const active = item.active || { weather: false, calendar: false, commute: true, news: false };
  const complete = p.complete !== false && !p.invalid;
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
    complete,
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
      iso: (item.locationISO || matrix.locationISO),
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

function postJSON(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/main', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-jibo-transid': 'tid:1234',
        'x-jibo-robotid': 'unknown',
        'x-jibo-logging-config': '{}',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = JSON.parse(text); } catch (error) { reject(error); return; }
        resolve({ statusCode: res.statusCode, body: value });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const GENERATED_ACTION_ID_PATHS = {
  'config.jcp.id': true,
  'config.jcp.children[*].id': true,
  'config.jcp.children[*].config.play.id': true,
  'config.jcp.children[*].config.display.id': true,
  'config.jcp.config.play.id': true,
  'config.jcp.config.display.id': true,
  'config.jcp.config.listen.id': true,
};

function normalizeAction(value, pathName) {
  pathName = pathName || '';
  if (Array.isArray(value)) return value.map((child, index) => normalizeAction(child, `${pathName}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    const childPath = pathName ? `${pathName}.${key}` : key;
    const wildcard = childPath.replace(/children\[\d+\]/g, 'children[*]');
    if (key === 'id' && GENERATED_ACTION_ID_PATHS[wildcard]) return;
    out[key] = normalizeAction(value[key], childPath);
  });
  return out;
}

function mimsFromAction(action) {
  const out = [];
  function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'SLIM' && value.config && value.config.play && value.config.play.meta
      && value.config.play.meta.mim_id) {
      const config = value.config;
      out.push({
        mim_id: config.play.meta.mim_id,
        prompt_id: config.play.meta.prompt_id || null,
        esml: config.play.esml || '',
        display: config.display || null,
      });
      return;
    }
    Object.keys(value).forEach((key) => walk(value[key]));
  }
  walk(action);
  return out;
}

function viewProjection(display) {
  const data = display && display.view && display.view.context && display.view.context.data;
  const components = data && data.componentConfigs || [];
  const component = (id) => components.find((item) => item.id === id);
  const trafficClip = component('trafficClip');
  const departTime = component('departTimeLabel');
  const departAmPm = component('departAmPmLabel');
  return {
    id: data && data.viewConfig && data.viewConfig.id || null,
    trafficSource: trafficClip && trafficClip.assets && trafficClip.assets[0] && trafficClip.assets[0].src || null,
    trafficX: trafficClip && trafficClip.position && trafficClip.position.x !== undefined ? trafficClip.position.x : null,
    trafficY: trafficClip && trafficClip.position && trafficClip.position.y !== undefined ? trafficClip.position.y : null,
    departTime: departTime && departTime.text || null,
    departAmPm: departAmPm && departAmPm.text || null,
    defaultSelect: data && data.defaultSelect || null,
    open: data && data.open || null,
  };
}

function actionSummary(response) {
  const data = response && response.data;
  const mims = mimsFromAction(data && data.action);
  const commuteMims = mims.filter((mim) => mim.mim_id.indexOf('Commute') === 0);
  const analytics = normalizeAction(data && data.analytics);
  const analyticsEvents = analytics && analytics['report-skill'] || [];
  const resultsEvent = analyticsEvents.find((event) => event.event === 'Personal Report Results');
  return {
    responseType: response && response.type || null,
    final: data && data.final === undefined ? null : data && data.final,
    mims,
    mimIds: mims.map((mim) => mim.mim_id),
    promptIds: mims.map((mim) => mim.prompt_id),
    speeches: mims.map((mim) => mim.esml),
    commuteSpeeches: commuteMims.map((mim) => mim.esml),
    commuteViews: commuteMims.filter((mim) => mim.display).map((mim) => ({ mim_id: mim.mim_id, view: viewProjection(mim.display) })),
    action: normalizeAction(data && data.action),
    analytics,
    resultsAnalytics: resultsEvent && resultsEvent.properties || null,
    transitions: data && data.skill && data.skill.session && data.skill.session.trace
      ? data.skill.session.trace.map((entry) => entry.transition) : [],
  };
}

async function runCase(dataPeerBase, item) {
  currentCase = item;
  calls.length = 0;
  Date.now = function () { return Date.parse(item.nowISO || item.locationISO || matrix.locationISO); };
  process.env.NET_lasso = dataPeerBase.replace(/^http:\/\//, '');
  SettingsClient.getUserPrefs = async function (data) { return prefsFor(item, data && data.log); };
  GraphManager._resetInstance();
  const skill = new PersonalReport();
  const service = new baseskill.SkillService(skill);
  await service.init(0);
  const port = service.server.address().port;
  const responses = [];
  const responseStatuses = [];
  let session;
  try {
    for (let i = 0; i <= (item.turns || []).length; i += 1) {
      const turn = i === 0 ? null : item.turns[i - 1];
      const result = await postJSON(port, requestBody(item, turn, session));
      responses.push(actionSummary(result.body));
      responseStatuses.push(result.statusCode);
      session = result.body && result.body.data && result.body.data.skill && result.body.data.skill.session;
    }
    const dataCalls = calls.map(clone);
    return {
      id: item.id,
      httpStatus: responseStatuses.length ? responseStatuses[responseStatuses.length - 1] : null,
      response: responses[responses.length - 1],
      responses,
      responseStatuses,
      dataRequests: dataCalls,
      mapRequests: dataCalls.filter((entry) => entry.path === '/v1/google_maps'),
      requestExpectation: { count: dataCalls.length, requests: dataCalls },
    };
  } finally {
    await service.close();
  }
}

async function mainRunner() {
  Math.random = function () { return 0; };
  const dataPeer = createDataPeer();
  await new Promise((resolve) => dataPeer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${dataPeer.address().port}`;
  const rows = [];
  try {
    for (let i = 0; i < matrix.cases.length; i += 1) rows.push(await runCase(base, matrix.cases[i]));
  } finally {
    await new Promise((resolve) => dataPeer.close(resolve));
  }
  const counts = contract.receiptCounts(rows);
  if (contract.canonical(counts) !== contract.canonical(contract.EXPECTED_COUNTS)) {
    throw new Error(`source receipt counts mismatch: ${JSON.stringify(counts)}`);
  }
  const result = {
    schema: 's11-report-commute-http-receipt-v1',
    mode: 'source',
    sourceRevision,
    sourceImage: matrix.sourceImage,
    sourceImageDigest: matrix.sourceImageDigest,
    network: 'none',
    runtime: process.version,
    counts,
    rows,
  };
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ mode: result.mode, rows: rows.length }) + '\n');
}

mainRunner().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
