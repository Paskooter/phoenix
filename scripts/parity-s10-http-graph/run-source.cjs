'use strict';

// Execute the pinned Pegasus Report HTTP graph in Node 8.9.4. Its LassoClient
// calls the local AP Data peer, which returns only the frozen AP XML fixtures.

const fs = require('fs');
const http = require('http');
const path = require('path');
const urlParse = require('url').parse;

const referenceRoot = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-source.cjs <reference-root> <matrix.json> <output.json>');
}
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's10-report-news-http-v1') throw new Error('unsupported S-10 matrix schema');
const fixtures = require(path.join(__dirname, 'ap-fixtures.cjs'));

process.env.TZ = 'UTC';
process.env.NET_settings = 'settings.jibo.aws';
process.env.prefsFromConfig = 'false';

const main = require(path.join(referenceRoot, 'packages/report-skill/lib/index.js'));
const baseskill = require(path.join(referenceRoot, 'packages/baseskill/lib/baseskill.js'));
const sourceGraph = require(path.join(referenceRoot, 'packages/baseskill/lib/graph/index.js'));
const testUtils = require(path.join(referenceRoot, 'packages/test-utils/lib/test-utils.js'));
const { PersonalReport, SettingsClient } = main;
const { GraphManager } = sourceGraph;
const SkillConversation = testUtils.skill_test.SkillConversation;

const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sourceRevision = matrix.referenceRevision;
const calls = [];
let currentCase;

function failureFor(item, sourceID) {
  return item.failure === 'all'
    || (item.failure && Array.isArray(item.failure.sourceIDs) && item.failure.sourceIDs.indexOf(String(sourceID)) >= 0);
}

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
      query: clone(query),
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    calls.push(entry);

    if (parsed.pathname !== '/v1/ap_news') {
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
  if (item.identity === 'unidentified') return SettingsClient.getDefaultPrefs({ info: function () {} });
  const defaults = SettingsClient.getDefaultPrefs({ debug: function () {}, info: function () {}, warn: function () {}, error: function () {} });
  const categories = {};
  CATEGORY_NAMES.forEach((name) => { categories[name] = false; });
  Object.keys(item.prefs.categories || {}).forEach((name) => { categories[name] = !!item.prefs.categories[name]; });
  defaults.weather.active = !!item.prefs.weather;
  defaults.news.active = !!item.prefs.news;
  defaults.news.activeNewsCategories = categories;
  defaults.calendar.active = false;
  defaults.commute.active = false;
  return defaults;
}

const GENERATED_ACTION_ID_PATHS = {
  'config.jcp.id': true,
  'config.jcp.children[*].id': true,
  'config.jcp.children[*].config.play.id': true,
  'config.jcp.children[*].config.display.id': true,
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
  const headlineClip = component('headlineClip');
  const categoryText = component('categoryText');
  const valueOrNull = (value) => value === undefined || value === null ? null : value;
  return {
    id: data && data.viewConfig && data.viewConfig.id || null,
    source: headlineClip && headlineClip.assets && headlineClip.assets[0] && headlineClip.assets[0].src || null,
    scale: valueOrNull(headlineClip && headlineClip.transform && headlineClip.transform.scaleX),
    x: valueOrNull(headlineClip && headlineClip.position && headlineClip.position.x),
    y: valueOrNull(headlineClip && headlineClip.position && headlineClip.position.y),
    category: categoryText && categoryText.text || null,
    leaveEmpty: data && data.defaultSelect && data.defaultSelect.leaveEmpty === undefined
      ? null : data && data.defaultSelect && data.defaultSelect.leaveEmpty,
  };
}

function actionSummary(response) {
  const data = response && response.data;
  const mims = mimsFromAction(data && data.action);
  const newsMims = mims.filter((mim) => mim.mim_id === 'NewsHeadline');
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
    headlineSpeeches: newsMims.map((mim) => mim.esml),
    newsViews: newsMims.map((mim) => viewProjection(mim.display)),
    action: normalizeAction(data && data.action),
    analytics,
    resultsAnalytics: resultsEvent && resultsEvent.properties || null,
    transitions: data && data.skill && data.skill.session && data.skill.session.trace
      ? data.skill.session.trace.map((entry) => entry.transition) : [],
  };
}

function expectedSourceIDs(item) {
  const categories = item.prefs.categories || {};
  const configured = CATEGORY_NAMES.filter((name) => categories[name])
    .map((name) => matrix.categorySourceIDs[name]);
  return configured.length ? configured : matrix.defaultNewsSourceIDs;
}

async function runCase(dataPeerBase, item) {
  currentCase = item;
  calls.length = 0;
  Date.now = function () { return Date.parse(item.nowISO || item.locationISO || matrix.locationISO); };
  process.env.NET_lasso = dataPeerBase.replace(/^http:\/\//, '');
  SettingsClient.getUserPrefs = async function () { return prefsFor(item); };
  GraphManager._resetInstance();
  const skill = new PersonalReport();
  const service = new baseskill.SkillService(skill);
  const conversation = new SkillConversation(service);
  try {
    await conversation.init();
    conversation.atISOTime(item.locationISO || matrix.locationISO);
    await conversation.launch(item.intent, {}, { nlu: { entities: {} } });
    const dataCalls = calls.map(clone);
    return {
      id: item.id,
      httpStatus: 200,
      response: actionSummary(conversation.response),
      dataRequests: dataCalls,
      newsRequests: dataCalls.filter((entry) => entry.path === '/v1/ap_news'),
      requestExpectation: { count: expectedSourceIDs(item).length, sourceIDs: expectedSourceIDs(item) },
    };
  } finally {
    await conversation.close();
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
  const result = {
    schema: 's10-report-news-http-receipt-v1',
    mode: 'source',
    sourceRevision,
    runtime: process.version,
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
