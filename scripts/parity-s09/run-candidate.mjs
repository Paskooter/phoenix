#!/usr/bin/env node

// S-09's report graph is exercised through the real Phoenix skill HTTP host.
// The peer below is a frozen Data HTTP fixture: it speaks the relay envelope
// that the source LassoClient expects, records every request, and never reaches
// a live provider. The source runner uses the same fixture contract.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createSkillService } from '../../packages/skills/src/skillService.js';
import { getReportSkill } from '../../packages/skills/src/reportSkill.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-candidate.mjs <matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's09-report-weather-http-v1') throw new Error('unsupported S-09 matrix schema');

const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sourceRevision = matrix.referenceRevision;
const candidateRevision = process.env.PHOENIX_CANDIDATE_REVISION || 'working-tree';
const calls = [];
let currentCase;

const NEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata">
  <entry>
    <summary>Provider feed header.</summary>
    <apcm:ContentMetadata><apcm:ExtendedHeadLine>Top stories</apcm:ExtendedHeadLine></apcm:ContentMetadata>
    <content><nitf><body><body.content><media>
      <media-reference source="header-full" width="4000" height="3000" />
      <media-reference source="header-preview" width="512" height="300" />
      <media-reference source="header-thumbnail" width="128" height="80" />
    </media></body.content></body></nitf></content>
  </entry>
  <entry>
    <summary>A friendly robot returns to shelves this year.</summary>
    <apcm:ContentMetadata><apcm:ExtendedHeadLine>Jibo robot makes a comeback</apcm:ExtendedHeadLine></apcm:ContentMetadata>
    <content><nitf><body><body.content><media>
      <media-reference source="story-full" width="4000" height="3000" />
      <media-reference source="story-preview" width="512" height="300" />
      <media-reference source="story-thumbnail" width="128" height="80" />
    </media></body.content></body></nitf></content>
  </entry>
</feed>`;

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

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function createDataPeer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://data-peer');
    const query = {};
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
    const hasTimestamp = url.searchParams.has('secondsSinceEpoch');
    const entry = {
      method: req.method,
      path: url.pathname,
      query,
      hasTimestamp,
      headers: {
        transID: req.headers['x-jibo-transid'] || null,
        robotID: req.headers['x-jibo-robotid'] || null,
        loggingConfig: req.headers['x-jibo-logging-config'] || null,
      },
    };
    calls.push(entry);

    if (url.pathname === '/v1/dark_sky') {
      const failure = currentCase && currentCase.failure;
      const failed = (failure === 'yesterday' && hasTimestamp) || (failure === 'today' && !hasTimestamp);
      if (failed) {
        entry.status = 503;
        return send(res, 503, 'weather fixture failure', 'text/plain');
      }
      const payload = darkSkyFor(currentCase, hasTimestamp);
      entry.status = 200;
      return send(res, 200, { relayData: payload, lassoDataFromRedis: false });
    }
    if (url.pathname === '/v1/ap_news') {
      if (currentCase?.newsFailure) {
        entry.status = 503;
        return send(res, 503, 'news fixture failure', 'text/plain');
      }
      entry.status = 200;
      return send(res, 200, { relayData: NEWS_XML, lassoDataFromRedis: false });
    }
    entry.status = 404;
    return send(res, 404, 'not found', 'text/plain');
  });
  return server;
}

function prefsFor(kind) {
  const useCelsius = kind === 'weatherOnlyCelsius';
  const weatherNews = kind === 'weatherNews';
  // Match the pinned source's default category set. The source still fetches
  // all configured default categories when News is enabled; its parser then
  // de-duplicates identical headlines across those category feeds.
  return {
    weather: { active: true, useCelsius },
    calendar: {
      active: false,
      googlePersonalCreds: false,
      googleWorkCreds: false,
      outlookPersonalCreds: false,
      outlookWorkCreds: false,
    },
    commute: {
      active: false,
      workTime: { hour: 9, min: 0 },
      origin: { lat: null, lng: null },
      destination: { lat: null, lng: null },
      mode: null,
      complete: false,
    },
    news: {
      active: weatherNews,
      activeNewsCategories: {
        technology: weatherNews,
        sports: weatherNews,
        business: weatherNews,
        science: false,
        entertainment: false,
        strange: false,
        health: false,
        international: false,
        national: weatherNews,
        politics: false,
      },
    },
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
      lng: matrix.coordinates.lng,
      lat: matrix.coordinates.lat,
      country: 'usa',
      countryCode: 'US',
      stateAbbr: 'ma',
      state: 'Massachusetts',
      city: 'boston',
      iso: item.locationISO,
    },
    perception: { peoplePresent: [], speaker: 'test-looper-id-3' },
    character: { motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 }, emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

function requestBody(item) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: `s09-${item.id}`,
    ts: 1,
    data: {
      general: { accountID: 'some-account-id', robotID: 'some-robot-id', lang: 'en-US' },
      runtime: runtimeFor(item),
      skill: { id: 'report-skill' },
      result: {
        nlu: { intent: item.intent, entities: item.entities || {}, rules: [] },
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

function actionSummary(response) {
  const data = response?.data;
  const mims = mimsFromAction(data?.action);
  return {
    responseType: response?.type || null,
    final: data?.final ?? null,
    mims,
    mimIds: mims.map((mim) => mim.mim_id),
    speeches: mims.map((mim) => mim.esml),
    // Report weather views are emitted as a DISPLAY JCP child whose source
    // view config is weatherTempView. News MIMs also carry DISPLAY children,
    // so presence of any display is not enough for this assertion.
    weatherView: mims.some((mim) => mim.display?.view?.context?.data?.viewConfig?.id === 'weatherTempView'),
    action: normalizeAction(data?.action),
    analytics: normalizeAction(data?.analytics),
    transitions: data?.skill?.session?.trace?.map((entry) => entry.transition) || [],
  };
}

function expectedTimestamp(item) {
  return String(Math.round((Date.parse(item.nowISO || item.locationISO) - 86400000) / 1000));
}

async function runCase(reportBase, item) {
  currentCase = item;
  calls.length = 0;
  const now = Date.parse(item.nowISO || item.locationISO);
  Date.now = () => now;
  const response = await fetch(`${reportBase}/v1/main`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-jibo-transid': 'tid:1234',
      // SkillConversation's pinned source fixture supplies the legacy
      // provider header value "unknown"; keep the candidate transport input
      // identical so header parity is observable alongside query parity.
      'x-jibo-robotid': 'unknown',
      'x-jibo-logging-config': '{}',
    },
    body: JSON.stringify(requestBody(item)),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const dataCalls = calls.map(clone);
  const weatherCalls = dataCalls.filter((entry) => entry.path === '/v1/dark_sky');
  return {
    id: item.id,
    httpStatus: response.status,
    response: actionSummary(body),
    dataRequests: dataCalls,
    weatherRequests: weatherCalls,
    requestExpectation: {
      count: 2,
      queryLat: matrix.coordinates.queryLat,
      queryLon: matrix.coordinates.queryLon,
      yesterdayTimestamp: expectedTimestamp(item),
      newsSourceIDs: item.prefs === 'weatherNews' ? matrix.defaultNewsSourceIDs : [],
    },
  };
}

const dataPeer = createDataPeer();
// Freeze weighted prompt selection so the source and candidate receipts are
// reproducible; generated JCP ids are normalized separately below.
Math.random = () => 0;
await new Promise((resolve) => dataPeer.listen(0, '127.0.0.1', resolve));
const dataBase = `http://127.0.0.1:${dataPeer.address().port}`;
process.env.NET_lasso = `127.0.0.1:${dataPeer.address().port}`;
delete process.env.NET_data;
clearReportEnvCache();

const originalGetUserPrefs = SettingsClient.getUserPrefs;
SettingsClient.getUserPrefs = async () => prefsFor(currentCase.prefs);
const handler = getReportSkill({ graphManager: new GraphManager() });
const reportService = await createSkillService({
  name: 'report-skill',
  skillId: 'report-skill',
  handler,
}).listen(0);
const reportBase = `http://127.0.0.1:${reportService.address().port}`;

const rows = [];
try {
  for (const item of matrix.cases) rows.push(await runCase(reportBase, item));
} finally {
  SettingsClient.getUserPrefs = originalGetUserPrefs;
  await new Promise((resolve) => reportService.close(resolve));
  await new Promise((resolve) => dataPeer.close(resolve));
}

const result = {
  schema: 's09-report-weather-http-receipt-v1',
  mode: 'candidate',
  sourceRevision,
  candidateRevision,
  runtime: process.version,
  rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ mode: result.mode, rows: rows.length, httpFailures: rows.filter((row) => row.httpStatus !== 200).length }));
