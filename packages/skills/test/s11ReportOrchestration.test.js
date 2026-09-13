// S-11 report graph orchestration at the HTTP skill boundary.
//
// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/{PersonalReport.ts,nodes/*,subgraphs/userid/*} and
// tests/{PersonalReport.test.js,SingleSkills.test.js}.  These checks keep the
// commute-specific SingleSkills paths separate from the timing/MIM tests:
// category isolation, identity gates, preference failures, provider failure
// classification, and the calendar dependency are all observed through the
// real Phoenix HTTP skill route and graph handler.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SkillRequestType } from '@phoenix/contracts';
import { createSkillService } from '../src/skillService.js';
import { createReportSkill } from '../src/reportSkill.js';
import { GraphManager } from '../src/graph/graphManager.js';
import { clearReportEnvCache } from '../src/report/env.js';

const LOCATION_ISO = '2026-06-12T08:00:00-04:00';
const ORIGIN = { lat: 42.36, lng: -71.06 };
const DESTINATION = { lat: 42.37, lng: -71.12 };

function settingsShape({
  weather = false,
  calendar = false,
  calendarCredentials = false,
  commute = true,
  commuteComplete = true,
  news = false,
} = {}) {
  const settings = {
    weatherEnabled: { value: weather },
    weather: { value: 0 },
    calendarEnabled: { value: calendar },
    'google:personalCalendar:readonly': { credentialExists: calendarCredentials },
    'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false },
    'outlook:workCalendar:readonly': { credentialExists: false },
    commuteEnabled: { value: commute },
    commuteTime: { hour: 9, min: 0 },
    homeLocation: { lat: ORIGIN.lat, lng: ORIGIN.lng },
    workLocation: { lat: DESTINATION.lat, lng: DESTINATION.lng },
    commuteType: { value: 0 }, // driving, the first source CommuteMode enum value
    newsEnabled: { value: news },
    newsTechnology: { value: false },
    newsSports: { value: false },
    newsBusiness: { value: false },
    newsScience: { value: false },
    newsEntertainment: { value: false },
    newsStrange: { value: false },
    newsHealth: { value: false },
    newsInternational: { value: false },
    newsNational: { value: false },
    newsPolitics: { value: false },
  };
  if (!commuteComplete) delete settings.commuteType;
  return settings;
}

function sendJSON(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

let settingsMode = 'complete';
let settingsValue = settingsShape();
let lassoMode = 'up';
const settingsCalls = [];
const dataCalls = [];

const settingsPeer = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  settingsCalls.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
  if (settingsMode === 'error') {
    sendJSON(response, 503, { message: 'settings fixture is down' });
    return;
  }
  sendJSON(response, 200, [{ skillId: 'report-skill', data: settingsValue }]);
});

const WEATHER_YESTERDAY = {
  daily: { data: [{ temperatureHigh: 60, temperatureLow: 45, summary: 'Cloudy yesterday', icon: 'cloudy' }] },
};
const WEATHER_TODAY = {
  currently: { temperature: 71, summary: 'Light rain', icon: 'rain' },
  daily: {
    data: [
      { temperatureHigh: 75, temperatureLow: 58, summary: 'Rain today', icon: 'rain' },
      { temperatureHigh: 68, temperatureLow: 51, summary: 'Partly cloudy tomorrow', icon: 'partly-cloudy-day' },
    ],
  },
};

function endpointEnabled(pathname) {
  if (lassoMode === 'up') return true;
  if (lassoMode === 'down') return false;
  if (lassoMode === 'calendar-up') return pathname.endsWith('_calendar');
  if (lassoMode === 'weather-up') return pathname === '/v1/dark_sky';
  return false;
}

const dataPeer = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://report-data-peer');
  dataCalls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  if (!endpointEnabled(url.pathname)) {
    sendJSON(response, 503, { message: 'data fixture is down' });
    return;
  }
  if (url.pathname === '/v1/google_maps') {
    sendJSON(response, 200, {
      relayData: {
        status: 'OK',
        routes: [{ legs: [{ duration: { value: 1500 }, duration_in_traffic: { value: 1500 } }] }],
      },
    });
    return;
  }
  if (url.pathname === '/v1/google_calendar' || url.pathname === '/v1/outlook_calendar') {
    sendJSON(response, 200, { relayData: { events: [] } });
    return;
  }
  if (url.pathname === '/v1/dark_sky') {
    sendJSON(response, 200, {
      relayData: url.searchParams.has('secondsSinceEpoch') ? WEATHER_YESTERDAY : WEATHER_TODAY,
    });
    return;
  }
  if (url.pathname === '/v1/ap_news') {
    // News is only used as a down/isolation target in this lane.  Keep an
    // explicit valid envelope here so an accidental request cannot escape to
    // the network when another case is added.
    sendJSON(response, 200, { relayData: '<feed><entry/></feed>' });
    return;
  }
  sendJSON(response, 404, { message: 'unknown data fixture path' });
});

let skillServer;
let skillPort;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
  await Promise.all([listen(settingsPeer), listen(dataPeer)]);
  process.env.NET_settings = `127.0.0.1:${settingsPeer.address().port}`;
  process.env.NET_lasso = `127.0.0.1:${dataPeer.address().port}`;
  delete process.env.NET_data;
  process.env.prefsFromConfig = 'false';
  delete process.env.ETCO_report_prefsFromConfig;
  clearReportEnvCache();

  const handler = createReportSkill({ graphManager: new GraphManager() });
  skillServer = await createSkillService({
    name: 's11-report-orchestration',
    skillId: 'report-skill',
    handler,
  }).listen(0);
  skillPort = skillServer.address().port;
});

after(async () => {
  await close(skillServer);
  await Promise.all([close(settingsPeer), close(dataPeer)]);
  clearReportEnvCache();
});

function setFixture({ mode = 'complete', value = settingsShape(), lasso = 'up' } = {}) {
  settingsMode = mode;
  settingsValue = value;
  lassoMode = lasso;
  settingsCalls.length = 0;
  dataCalls.length = 0;
}

function runtimeFor(speaker) {
  const users = [];
  if (speaker === 'adult') users.push({ id: 'adult', accountId: 'account-1', birthdate: '1990-01-01' });
  if (speaker === 'child') users.push({ id: 'child', accountId: 'account-1', birthdate: '2023-01-01' });
  return {
    perception: speaker ? { speaker } : {},
    loop: { loopId: 'loop-1', users },
    location: { lat: ORIGIN.lat, lng: ORIGIN.lng, iso: LOCATION_ISO },
    dialog: { referent: null },
  };
}

function launchBody(intent, speaker = 'adult') {
  return {
    type: SkillRequestType.LISTEN_LAUNCH,
    msgID: `s11-${intent}`,
    ts: 1,
    data: {
      general: { accountID: 'account-1', robotID: 'robot-1', lang: 'en-US' },
      runtime: runtimeFor(speaker),
      skill: { id: 'report-skill' },
      result: { nlu: { intent, entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  };
}

function updateBody(session, intent, speaker = null, asr = 'not in the loop') {
  return {
    type: SkillRequestType.LISTEN_UPDATE,
    msgID: `s11-update-${intent}`,
    ts: 2,
    data: {
      general: { accountID: 'account-1', robotID: 'robot-1', lang: 'en-US' },
      runtime: runtimeFor(speaker),
      skill: { id: 'report-skill', session },
      result: { nlu: { intent, entities: {}, rules: [] }, asr: { text: asr }, memo: 'Reactive' },
    },
  };
}

function postJSON(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port: skillPort,
      path: '/v1/report-skill/main',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-jibo-transid': 'trans-1',
        'x-jibo-robotid': 'robot-1',
        'x-jibo-logging-config': '{}',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function mims(response) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'SLIM' && value.config?.play?.meta?.mim_id) {
      out.push(value.config.play.meta.mim_id);
      return;
    }
    Object.values(value).forEach(walk);
  };
  walk(response.body?.data?.action);
  return out;
}

function paths() {
  return dataCalls.map((call) => call.path);
}

function assertAction(response, expectedMims) {
  assert.equal(response.status, 200);
  assert.equal(response.body.type, 'SKILL_ACTION');
  assert.deepEqual(mims(response), expectedMims);
}

test('S-11 HTTP graph isolates each requested report category and keeps commute calendar dependency', { concurrency: false }, async () => {
  setFixture({
    value: settingsShape({ weather: true, calendar: true, calendarCredentials: true, commute: true, news: true }),
    lasso: 'up',
  });

  const commute = await postJSON(launchBody('requestCommute'));
  assertAction(commute, ['CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.equal(paths().filter((path) => path === '/v1/google_maps').length, 1);
  assert.equal(paths().filter((path) => path === '/v1/google_calendar').length, 1,
    'an active commute asks CalendarData for early-event context');
  assert.equal(paths().some((path) => path === '/v1/dark_sky' || path === '/v1/ap_news'), false);
  assert.equal(mims(commute).some((id) => /Weather|Calendar|News/.test(id)), false);

  setFixture({
    value: settingsShape({ weather: true, calendar: true, calendarCredentials: true, commute: true, news: true }),
    lasso: 'down',
  });
  const weather = await postJSON(launchBody('requestWeatherPR', null));
  assertAction(weather, ['WeatherServiceDown']);
  assert.equal(mims(weather).includes('PersonalReportWhoIsThis'), false,
    'weather bypasses UserID when no speaker is present');
  assert.equal(paths().some((path) => path === '/v1/google_maps' || path.endsWith('_calendar') || path === '/v1/ap_news'), false);

  setFixture({
    value: settingsShape({ weather: true, calendar: true, calendarCredentials: true, commute: true, news: true }),
    lasso: 'down',
  });
  const news = await postJSON(launchBody('requestNews', null));
  assertAction(news, ['NewsServiceDown']);
  assert.equal(mims(news).includes('PersonalReportWhoIsThis'), false,
    'news bypasses UserID when no speaker is present');
  assert.equal(paths().some((path) => path === '/v1/google_maps' || path.endsWith('_calendar')), false);

  setFixture({
    value: settingsShape({ weather: true, calendar: true, calendarCredentials: true, commute: true, news: true }),
    lasso: 'calendar-up',
  });
  const calendar = await postJSON(launchBody('requestCalendar'));
  assertAction(calendar, ['CalendarNothing']);
  assert.equal(paths().filter((path) => path.endsWith('_calendar')).length, 1);
  assert.equal(paths().some((path) => path === '/v1/google_maps'), false,
    'calendar single skill never enters commute');
});

test('S-11 HTTP graph routes commute identity gates and identified confirmation', { concurrency: false }, async () => {
  setFixture({ value: settingsShape({ commute: true }), lasso: 'up' });
  const unknown = await postJSON(launchBody('requestCommute', null));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.data.final, false);
  assert.deepEqual(mims(unknown), ['PersonalReportWhoIsThis']);
  assert.equal(paths().includes('/v1/google_maps'), false);

  const notInLoop = await postJSON(updateBody(unknown.body.data.skill.session, 'notInLoop'));
  assertAction(notInLoop, ['PersonalReportMustBeLooper']);
  assert.equal(notInLoop.body.data.final, true);
  assert.equal(paths().includes('/v1/google_maps'), false);

  setFixture({ value: settingsShape({ commute: true }), lasso: 'up' });
  const child = await postJSON(launchBody('requestCommute', 'child'));
  assertAction(child, ['PersonalReportMustBeAdult']);
  assert.equal(paths().includes('/v1/google_maps'), false);

  setFixture({ value: settingsShape({ commute: true }), lasso: 'up' });
  const adult = await postJSON(launchBody('requestCommute', 'adult'));
  assertAction(adult, ['CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.equal(paths().filter((path) => path === '/v1/google_maps').length, 1);
});

test('S-11 HTTP graph keeps incomplete commute setup and SettingsFailed exact', { concurrency: false }, async () => {
  setFixture({
    value: settingsShape({ commute: true, commuteComplete: false }),
    lasso: 'up',
  });
  const incomplete = await postJSON(launchBody('requestCommute'));
  assertAction(incomplete, ['CommuteAppSetup']);
  assert.equal(paths().includes('/v1/google_maps'), false,
    'incomplete commute preferences stop before Maps');

  setFixture({ mode: 'error', value: settingsShape({ commute: true }), lasso: 'up' });
  const failed = await postJSON(launchBody('requestCommute'));
  assertAction(failed, ['PersonalReportSettingsFailed']);
  assert.equal(paths().includes('/v1/google_maps'), false);
  assert.equal(paths().some((path) => path.endsWith('_calendar')), false);
});

test('S-11 HTTP graph splits single commute ServiceDown from full AllServicesDown', { concurrency: false }, async () => {
  setFixture({ value: settingsShape({ commute: true }), lasso: 'down' });
  const singleDown = await postJSON(launchBody('requestCommute'));
  assertAction(singleDown, ['CommuteServiceDown']);
  assert.equal(mims(singleDown).some((id) => /PersonalReport(?:Outro|AllServicesDown)/.test(id)), false);

  // Keep news inactive so every active provider returns a null data result;
  // this exercises GetDataNode's source AllServicesDown transition through
  // the same HTTP provider boundary.
  setFixture({
    value: settingsShape({ weather: true, calendar: true, calendarCredentials: true, commute: true, news: false }),
    lasso: 'down',
  });
  const fullDown = await postJSON(launchBody('launchPersonalReport'));
  assertAction(fullDown, ['PersonalReportKickOff', 'PersonalReportAllServicesDown']);
  assert.equal(mims(fullDown).includes('CommuteServiceDown'), false);
});

test('S-11 HTTP graph never fetches Maps for an inactive full-report commute', { concurrency: false }, async () => {
  setFixture({ value: settingsShape({ weather: true, calendar: false, commute: false, news: false }), lasso: 'weather-up' });
  const full = await postJSON(launchBody('launchPersonalReport'));
  assert.equal(full.status, 200);
  assert.equal(full.body.data.final, true);
  assert.equal(mims(full).some((id) => id.startsWith('Commute')), false);
  assert.equal(paths().includes('/v1/google_maps'), false);
});
