'use strict';

// Execute the pinned Pegasus report graph while its LassoClient talks to the
// frozen Data HTTP peer below. The peer is deliberately local and providerless;
// its only purpose is to make the source's timestamp/query and relay-envelope
// behavior observable under the same inputs as the Phoenix runner.

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
if (matrix.schema !== 's09-report-weather-http-v1') throw new Error('unsupported S-09 matrix schema');

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

const NEWS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata">\n'
  + '  <entry>\n'
  + '    <summary>Provider feed header.</summary>\n'
  + '    <apcm:ContentMetadata><apcm:ExtendedHeadLine>Top stories</apcm:ExtendedHeadLine></apcm:ContentMetadata>\n'
  + '    <content><nitf><body><body.content><media>\n'
  + '      <media-reference source="header-full" width="4000" height="3000" />\n'
  + '      <media-reference source="header-preview" width="512" height="300" />\n'
  + '      <media-reference source="header-thumbnail" width="128" height="80" />\n'
  + '    </media></body.content></body></nitf></content>\n'
  + '  </entry>\n'
  + '  <entry>\n'
  + '    <summary>A friendly robot returns to shelves this year.</summary>\n'
  + '    <apcm:ContentMetadata><apcm:ExtendedHeadLine>Jibo robot makes a comeback</apcm:ExtendedHeadLine></apcm:ContentMetadata>\n'
  + '    <content><nitf><body><body.content><media>\n'
  + '      <media-reference source="story-full" width="4000" height="3000" />\n'
  + '      <media-reference source="story-preview" width="512" height="300" />\n'
  + '      <media-reference source="story-thumbnail" width="128" height="80" />\n'
  + '    </media></body.content></body></nitf></content>\n'
  + '  </entry>\n'
  + '</feed>';

function dataPoint(value) {
  return {
    temperatureHigh: value.high,
    temperatureLow: value.low,
    icon: value.icon,
    summary: value.summary,
  };
}

function darkSkyFor(item, timestamped) {
  const value = timestamped ? item.weather.yesterday : item.weather.today;
  if (value === null) return null;
  const daily = timestamped
    ? [dataPoint(value)]
    : [dataPoint(value), dataPoint(item.weather.tomorrow)];
  const response = {
    latitude: matrix.coordinates.lat,
    longitude: matrix.coordinates.lng,
    timezone: 'UTC',
    daily: { data: daily },
  };
  if (!timestamped) {
    response.currently = {
      temperature: item.weather.current.temp,
      icon: item.weather.current.icon,
      summary: item.weather.current.summary,
    };
  }
  return response;
}

function send(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType || 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function createDataPeer() {
  return http.createServer((req, res) => {
    const parsed = urlParse(req.url, true);
    const query = parsed.query || {};
    const hasTimestamp = Object.prototype.hasOwnProperty.call(query, 'secondsSinceEpoch');
    const entry = {
      method: req.method,
      path: parsed.pathname,
      query: clone(query),
      hasTimestamp,
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    calls.push(entry);
    if (parsed.pathname === '/v1/dark_sky') {
      const failed = (currentCase.failure === 'yesterday' && hasTimestamp)
        || (currentCase.failure === 'today' && !hasTimestamp);
      if (failed) {
        entry.status = 503;
        return send(res, 503, 'weather fixture failure', 'text/plain');
      }
      entry.status = 200;
      return send(res, 200, { relayData: darkSkyFor(currentCase, hasTimestamp), lassoDataFromRedis: false });
    }
    if (parsed.pathname === '/v1/ap_news') {
      if (currentCase.newsFailure) {
        entry.status = 503;
        return send(res, 503, 'news fixture failure', 'text/plain');
      }
      entry.status = 200;
      return send(res, 200, { relayData: NEWS_XML, lassoDataFromRedis: false });
    }
    entry.status = 404;
    return send(res, 404, 'not found', 'text/plain');
  });
}

function prefsFor(kind) {
  const useCelsius = kind === 'weatherOnlyCelsius';
  const weatherNews = kind === 'weatherNews';
  const defaults = SettingsClient.getDefaultPrefs({
    debug: function () {}, info: function () {}, warn: function () {}, error: function () {},
  });
  defaults.weather.active = true;
  defaults.weather.useCelsius = useCelsius;
  defaults.calendar.active = false;
  defaults.commute.active = false;
  defaults.news.active = weatherNews;
  Object.keys(defaults.news.activeNewsCategories).forEach((name) => {
    defaults.news.activeNewsCategories[name] = weatherNews && name === 'general';
  });
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

function actionSummary(response) {
  const data = response && response.data;
  const mims = mimsFromAction(data && data.action);
  return {
    responseType: response && response.type || null,
    final: data && data.final === undefined ? null : data && data.final,
    mims,
    mimIds: mims.map((mim) => mim.mim_id),
    speeches: mims.map((mim) => mim.esml),
    weatherView: mims.some((mim) => mim.display && mim.display.view && mim.display.view.context
      && mim.display.view.context.data && mim.display.view.context.data.viewConfig
      && mim.display.view.context.data.viewConfig.id === 'weatherTempView'),
    action: normalizeAction(data && data.action),
    analytics: normalizeAction(data && data.analytics),
    transitions: data && data.skill && data.skill.session && data.skill.session.trace
      ? data.skill.session.trace.map((entry) => entry.transition) : [],
  };
}

function expectedTimestamp(item) {
  return String(Math.round((Date.parse(item.nowISO || item.locationISO) - 86400000) / 1000));
}

async function runCase(dataPeerBase, item) {
  currentCase = item;
  calls.length = 0;
  Date.now = function () { return Date.parse(item.nowISO || item.locationISO); };
  process.env.NET_lasso = dataPeerBase.replace(/^http:\/\//, '');

  SettingsClient.getUserPrefs = async function () { return prefsFor(item.prefs); };
  GraphManager._resetInstance();
  const skill = new PersonalReport();
  const service = new baseskill.SkillService(skill);
  const conversation = new SkillConversation(service);
  try {
    await conversation.init();
    conversation.atISOTime(item.locationISO);
    await conversation.launch(item.intent, {}, { nlu: { entities: item.entities || {} } });
    const dataCalls = calls.map(clone);
    return {
      id: item.id,
      httpStatus: 200,
      response: actionSummary(conversation.response),
      dataRequests: dataCalls,
      weatherRequests: dataCalls.filter((entry) => entry.path === '/v1/dark_sky'),
      requestExpectation: {
        count: 2,
        queryLat: matrix.coordinates.queryLat,
        queryLon: matrix.coordinates.queryLon,
        yesterdayTimestamp: expectedTimestamp(item),
        newsSourceIDs: item.prefs === 'weatherNews' ? matrix.defaultNewsSourceIDs : [],
      },
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
    for (let i = 0; i < matrix.cases.length; i++) rows.push(await runCase(base, matrix.cases[i]));
  } finally {
    await new Promise((resolve) => dataPeer.close(resolve));
  }
  const result = {
    schema: 's09-report-weather-http-receipt-v1',
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
