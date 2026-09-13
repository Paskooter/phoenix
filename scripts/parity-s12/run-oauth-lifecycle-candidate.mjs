#!/usr/bin/env node

// Real Data -> Report lifecycle checks for expired/revoked calendar credentials.
// The token endpoint is a local fixture, but CredentialStore, OAuth refresh /
// invalidation, HTTP calendar route, Lasso client, and report graph are real.

import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRequestType } from '../../packages/contracts/src/index.js';
import { createDataService } from '../../packages/data/src/index.js';
import { CredentialStore } from '../../packages/data/src/credentials.js';
import { createOAuthProvider, CredentialError } from '../../packages/data/src/oauth.js';
import { reportSkill } from '../../packages/skills/src/reportSkill.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';
import { endOfTomorrowISO } from '../../packages/skills/src/report/calendar.js';

const [matrixPath, sourcePath, outputPath] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !outputPath) {
  throw new Error('usage: run-oauth-lifecycle-candidate.mjs <matrix.json> <source.json> <output.json>');
}
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
if (matrix.schema !== 's12-calendar-matrix-v1' || source.schema !== 's12-calendar-receipt-v1') throw new Error('unsupported receipt');

Math.random = () => 0;
const actionIdPaths = Object.freeze([
  'config.jcp.id',
  'config.jcp.children[*].id',
  'config.jcp.children[*].config.play.id',
  'config.jcp.children[*].config.display.id',
]);

function normalizeAction(value, path = '') {
  if (Array.isArray(value)) return value.map((child, index) => normalizeAction(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'id' && actionIdPaths.includes(childPath.replace(/children\[\d+\]/g, 'children[*]'))) continue;
    out[key] = normalizeAction(value[key], childPath);
  }
  return out;
}

function actionSummary(response) {
  const data = response && response.data;
  const trace = data && data.skill && data.skill.session && data.skill.session.trace;
  return {
    responseType: response && response.type,
    final: data && data.final,
    action: normalizeAction(data && data.action),
    analytics: normalizeAction(data && data.analytics),
    transitions: Array.isArray(trace) ? trace.map((entry) => entry.transition) : [],
  };
}

function prefsFor(vector) {
  const c = vector.credentials || {};
  return {
    weather: { active: false, useCelsius: false },
    calendar: {
      active: true,
      googlePersonalCreds: !!c.googlePersonal,
      googleWorkCreds: !!c.googleWork,
      outlookPersonalCreds: !!c.outlookPersonal,
      outlookWorkCreds: !!c.outlookWork,
    },
    commute: { active: false, workTime: { hour: 9, min: 0 }, origin: { lat: null, lng: null }, destination: { lat: null, lng: null }, mode: null, complete: false },
    news: { active: false, activeNewsCategories: {} },
  };
}

function launch(vector, accountID) {
  return {
    type: SkillRequestType.LISTEN_LAUNCH, msgID: `s12-oauth-${vector.id}`, ts: 1,
    data: {
      general: { accountID, robotID: 'robot-s12', lang: 'en-US' },
      runtime: {
        dialog: { referent: null }, perception: { speaker: 'u1' },
        loop: { loopId: `loop-oauth-${vector.id}`, users: [{ id: 'u1', name: 'Alice Smith', phoneticName: 'Jane', firstName: 'Jane', lastName: 'Jetson', accountId: accountID, birthdate: '1990-01-01', gender: 'female' }] },
        character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 1 } },
        location: { lat: 42.36, lng: -71.06, iso: vector.locationISO },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent: vector.intent || 'requestCalendar', entities: vector.entities || {}, rules: [] }, asr: { text: '', confidence: 1 }, memo: 'Reactive' },
    },
  };
}

function requestContext() {
  return { req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 's12-oauth-transid', 'x-jibo-robotid': 'robot-s12', 'x-jibo-logging-config': '{}' }) } } };
}

function mimIDs(action) {
  const ids = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.play?.meta?.mim_id) ids.push(value.play.meta.mim_id);
    Object.values(value).forEach(walk);
  };
  walk(action);
  return ids;
}

const googleVector = matrix.cases.find((vector) => vector.id === 'google-personal-expired');
const outlookVector = matrix.cases.find((vector) => vector.id === 'outlook-work-expired');
if (!googleVector || !outlookVector) throw new Error('lifecycle vectors missing from matrix');

const tempRoot = mkdtempSync(join(tmpdir(), 'phoenix-s12-oauth-'));
const credentialFile = join(tempRoot, 'credentials.json');
const tokenRequests = [];
const tokenServer = http.createServer((req, res) => {
  tokenRequests.push(req.url);
  req.resume();
  req.on('end', () => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }));
  });
});
await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));

const googleClientID = 's12-google-client';
const outlookClientID = 's12-outlook-client';
const oauth = createOAuthProvider({
  secrets: {
    google: { [googleClientID]: { client_id: googleClientID, client_secret: 'google-secret', redirect_uri: 'https://example.test/google' } },
    outlook: { [outlookClientID]: { client_id: outlookClientID, client_secret: 'outlook-secret', redirect_uri: 'https://example.test/outlook' } },
  },
  endpoints: {
    google: { tokenUrl: `http://127.0.0.1:${tokenServer.address().port}/google-token` },
    outlook: { tokenUrl: `http://127.0.0.1:${tokenServer.address().port}/outlook-token` },
  },
});
const store = new CredentialStore({ file: credentialFile, oauth });
const googleAccount = 's12-oauth-google';
const outlookAccount = 's12-oauth-outlook';
const googleProviderCalls = [];
const outlookProviderCalls = [];
store.save({ accountId: googleAccount, skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: ['https://www.googleapis.com/auth/calendar.readonly'], clientId: googleClientID, accessToken: 'old-google-token', refreshToken: 'old-google-refresh', expiresAt: Date.parse(googleVector.nowISO) - 1000 });
store.save({ accountId: outlookAccount, skillId: 'report-skill', serviceName: 'outlook', serviceAccountName: 'workCalendar', scopes: ['Calendars.Read', 'offline_access'], clientId: outlookClientID, accessToken: 'old-outlook-token', refreshToken: 'old-outlook-refresh', expiresAt: Date.parse(outlookVector.nowISO) + 3600 * 1000 });

const dataService = await createDataService({
  credentialStore: store,
  oauth,
  googleCalendarProvider: async () => { googleProviderCalls.push(true); return { events: [] }; },
  outlookCalendarProvider: async () => { outlookProviderCalls.push(true); throw new Error('Failed to get Outlook events, Outlook response was 401 InvalidAuthenticationToken'); },
  newsPolling: { enabled: false },
}).listen(0);
delete process.env.NET_lasso;
process.env.NET_data = `localhost:${dataService.address().port}`;
clearReportEnvCache();
const originalPrefs = SettingsClient.getUserPrefs;
const cases = [
  { id: 'google-refresh-failure', sourceID: googleVector.id, vector: googleVector, accountID: googleAccount, prefs: { ...prefsFor(googleVector), calendar: { ...prefsFor(googleVector).calendar } } },
  { id: 'outlook-invalid-token', sourceID: outlookVector.id, vector: outlookVector, accountID: outlookAccount, prefs: { ...prefsFor(outlookVector), calendar: { ...prefsFor(outlookVector).calendar } } },
];
cases[0].prefs.calendar.googlePersonalCreds = true;
cases[0].prefs.calendar.outlookWorkCreds = false;
cases[1].prefs.calendar.googlePersonalCreds = false;
cases[1].prefs.calendar.outlookWorkCreds = true;

function operationSnapshot() {
  return {
    tokenPaths: [...tokenRequests],
    googleProviderCalls: googleProviderCalls.length,
    outlookProviderCalls: outlookProviderCalls.length,
  };
}

function operationDelta(before, after) {
  return {
    tokenPaths: after.tokenPaths.slice(before.tokenPaths.length),
    googleProviderCalls: after.googleProviderCalls - before.googleProviderCalls,
    outlookProviderCalls: after.outlookProviderCalls - before.outlookProviderCalls,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
}

const rows = [];
try {
  for (const item of cases) {
    Date.now = () => Date.parse(item.vector.nowISO);
    SettingsClient.getUserPrefs = async () => item.prefs;
    const beforeReport = operationSnapshot();
    const response = await reportSkill(launch(item.vector, item.accountID), requestContext());
    const afterReport = operationSnapshot();
    const action = actionSummary(response);
    const service = item.id === 'google-refresh-failure' ? 'google' : 'outlook';
    const calendar = item.id === 'google-refresh-failure' ? 'personalCalendar' : 'workCalendar';
    const routeQuery = new URLSearchParams({ skillId: 'report-skill', accountId: item.accountID, calendar, endDate: endOfTomorrowISO(item.vector.locationISO) });
    const routeResponse = await fetch(`http://localhost:${dataService.address().port}/v1/${service}_calendar?${routeQuery}`);
    const routeBody = await routeResponse.text();
    const afterProbe = operationSnapshot();
    const reportDelta = operationDelta(beforeReport, afterReport);
    const probeDelta = operationDelta(afterReport, afterProbe);
    const sourceRow = source.rows.find((row) => row.id === item.sourceID);
    const stored = new CredentialStore({ file: credentialFile });
    const query = item.id === 'google-refresh-failure'
      ? { accountId: googleAccount, skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'personalCalendar', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }
      : { accountId: outlookAccount, skillId: 'report-skill', serviceName: 'outlook', serviceAccountName: 'workCalendar', scopes: ['Calendars.Read', 'offline_access'] };
    const credential = stored.find(query, true);
    const expectedError = item.id === 'google-refresh-failure' ? CredentialError.REFRESH_FAILED : CredentialError.INVALID_TOKEN;
    const expectedReportDelta = item.id === 'google-refresh-failure'
      ? { tokenPaths: ['/google-token'], googleProviderCalls: 0, outlookProviderCalls: 0 }
      : { tokenPaths: [], googleProviderCalls: 0, outlookProviderCalls: 1 };
    const expectedProbeDelta = { tokenPaths: [], googleProviderCalls: 0, outlookProviderCalls: 0 };
    const actionMatch = JSON.stringify(action) === JSON.stringify(sourceRow.action);
    const mims = mimIDs(action.action);
    if (routeResponse.status !== 502 || actionMatch === false || action.final !== true || mims.length !== 1 || mims[0] !== 'CalendarServiceDown' || !credential || credential.isActive !== false || credential.error !== expectedError || JSON.stringify(reportDelta) !== JSON.stringify(expectedReportDelta) || JSON.stringify(probeDelta) !== JSON.stringify(expectedProbeDelta)) {
      throw new Error(`${item.id}: lifecycle assertion failed`);
    }
    rows.push({ id: item.id, sourceID: item.sourceID, status: routeResponse.status, routeBody, action, mims, credential: { isActive: credential.isActive, error: credential.error }, actionMatch, operations: { beforeReport, afterReport, afterProbe, reportDelta, probeDelta } });
  }
} finally {
  SettingsClient.getUserPrefs = originalPrefs;
  await closeServer(dataService);
  await closeServer(tokenServer);
  delete process.env.NET_data;
  clearReportEnvCache();
  rmSync(tempRoot, { recursive: true, force: true });
}

fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-oauth-lifecycle-receipt-v1',
  sourceRevision: 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c',
  candidateRevision: 'phoenix-w21/s12-calendar-real-http-oauth',
  actionIdPaths,
  result: 'pass',
  rows,
}, null, 2)}\n`);
