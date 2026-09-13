'use strict';

// Run the Personal Report graph from the pinned Pegasus build under Node 8.9.4.
// This file intentionally uses only CommonJS and ES2015 syntax accepted by the
// archived runtime. The candidate runner has the same case/spec contract.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ref = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'matrix-spec.json')));
process.env.TZ = 'UTC';
process.env.prefsFromConfig = 'false';
process.env.NET_lasso = 'lasso:8080';
process.env.NET_settings = 'settings.jibo.aws';

const RealDate = Date;
const FIXED_NOW = RealDate.parse(spec.runtimeISO);
global.Date = class FixtureDate extends RealDate {
  constructor() {
    const args = Array.prototype.slice.call(arguments);
    if (args.length) super(...args);
    else super(FIXED_NOW);
  }
  static now() { return FIXED_NOW; }
};

global.main = require(path.join(ref, 'packages/report-skill/lib/index.js'));
const { PersonalReport } = require(path.join(ref, 'packages/report-skill/lib/PersonalReport.js'));
const { SettingsClient } = require(path.join(ref, 'packages/report-skill/lib/SettingsClient.js'));
const { LassoClient } = require(path.join(ref, 'packages/report-skill/lib/LassoClient.js'));
const { GraphManager } = require(path.join(ref, 'packages/baseskill/lib/graph/GraphManager.js'));
const { EnvVars } = require(path.join(ref, 'packages/report-skill/lib/EnvVars.js'));

let randomState = 0x50454741;
Math.random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const log = {
  debug() {}, info() {}, warn() {}, error() {},
  createChild() { return this; },
};

// The pinned @jibo/test-utils runtime carries birthdate as epoch milliseconds;
// speakerIsAdult in the original performs arithmetic on this field.
function adultUser() { return { id: 'u1', accountId: 'acct-1', name: 'Alice Smith', birthdate: 631152000000 }; }
function childUser() { return { id: 'kid', accountId: 'acct-kid', name: 'Kid Smith', birthdate: 1388534400000 }; }

function settingsShape(type) {
  const enabled = (value) => ({ value: value ? 1 : 0 });
  const shape = {
    weatherEnabled: enabled(true), weather: enabled(false), calendarEnabled: enabled(true),
    commuteEnabled: enabled(true), commuteTime: { hour: 15, min: 0 },
    homeLocation: { lat: 42.36, lng: -71.06 }, workLocation: { lat: 42.37, lng: -71.07 },
    commuteType: { value: type === null || type === undefined ? undefined : type },
    newsEnabled: enabled(true), newsTechnology: enabled(true), newsSports: enabled(true),
    newsBusiness: enabled(true), newsScience: enabled(false), newsEntertainment: enabled(false),
    newsStrange: enabled(false), newsHealth: enabled(false), newsInternational: enabled(false),
    newsNational: enabled(true), newsPolitics: enabled(false),
    'google:personalCalendar:readonly': { credentialExists: true },
    'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false },
    'outlook:workCalendar:readonly': { credentialExists: false },
  };
  if (type === undefined) delete shape.commuteType;
  return shape;
}

function defaultPrefs() { return SettingsClient.getDefaultPrefs(log); }

function prefsFor(name) {
  const prefs = clone(defaultPrefs());
  let active;
  if (name === 'all') active = ['weather', 'calendar', 'commute', 'news'];
  else if (name === 'weatherNews') active = ['weather', 'news'];
  else if (name === 'weather') active = ['weather'];
  else if (name === 'news') active = ['news'];
  else if (name === 'calendar' || name === 'calendarIncomplete') active = ['calendar'];
  else if (name === 'commute' || name === 'commuteIncomplete') active = ['commute'];
  else if (name === 'newsEmpty') active = ['news'];
  else if (name === 'none') active = [];
  else active = ['weather', 'news'];
  ['weather', 'calendar', 'commute', 'news'].forEach(cat => { prefs[cat].active = active.indexOf(cat) >= 0; });
  if (name === 'calendar' || name === 'all') prefs.calendar.googlePersonalCreds = true;
  if (name === 'calendarIncomplete') {
    prefs.calendar.googlePersonalCreds = false;
    prefs.calendar.googleWorkCreds = false;
    prefs.calendar.outlookPersonalCreds = false;
    prefs.calendar.outlookWorkCreds = false;
  }
  if (name === 'commute' || name === 'all') Object.assign(prefs.commute, {
    complete: true, mode: 'driving', workTime: { hour: 15, min: 0 },
    origin: { lat: 42.36, lng: -71.06 }, destination: { lat: 42.37, lng: -71.07 },
  });
  if (name === 'commuteIncomplete') Object.assign(prefs.commute, {
    complete: false, mode: null, workTime: { hour: null, min: null },
    origin: { lat: null, lng: null }, destination: { lat: null, lng: null },
  });
  if (name === 'newsEmpty') Object.keys(prefs.news.activeNewsCategories).forEach(k => { prefs.news.activeNewsCategories[k] = false; });
  return prefs;
}

function weatherData() {
  return [
    { daily: { data: [{ summary: 'Yesterday clear', icon: 'clear-day', temperatureHigh: 57.7, temperatureLow: 54.35 }] } },
    { currently: { icon: 'cloudy', temperature: 65, summary: 'Cloudy now' }, daily: { data: [
      { summary: 'Today rain', icon: 'rain', temperatureHigh: 50.3, temperatureLow: 45.83 },
      { summary: 'Tomorrow fog', icon: 'fog', temperatureHigh: 55.3, temperatureLow: 40.83 },
    ] } },
  ];
}

function calendarData() {
  return { events: [{ summary: 'Event 1', start: { dateTime: '2018-05-30T13:00:00.000Z', timestamp: 1527685200000 }, fullDay: false }] };
}

function commuteData() {
  return { routes: [{ legs: [{ duration: { text: '18 mins', value: 1080 }, duration_in_traffic: { text: '25 mins', value: 1500 } }] }] };
}

function newsItem(category, i, header) {
  const headline = `${category} ${header ? 'Provider' : 'Headline'} ${i}`;
  return {
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [headline] }],
    summary: [`A safe ${category} story ${i}.`],
    content: [{ nitf: [{ body: [{ 'body.content': [{ media: [{ 'media-reference': [
      { '$': { source: 'full', width: 4000, height: 3000 } },
      { '$': { source: 'preview', width: 512, height: 300 } },
    ] }] }] }] }] }],
  };
}

function newsData(prefs) {
  return Object.keys(prefs.news.activeNewsCategories).filter(k => prefs.news.activeNewsCategories[k]).map(category => ({
    category: { name: category, sourceID: 0 },
    data: { feed: { entry: [newsItem(category, 0, true), newsItem(category, 1, false), newsItem(category, 2, false)] } },
  }));
}

function speakerInfo(kind) {
  if (kind === 'none') return { speaker: null, users: [] };
  if (kind === 'child') return { speaker: 'kid', users: [childUser()] };
  return { speaker: 'u1', users: [adultUser()] };
}

function requestBody(item, step, session) {
  const speaker = step && Object.prototype.hasOwnProperty.call(step, 'speaker') ? step.speaker : item.speaker;
  const who = speakerInfo(speaker);
  const isInitial = !step;
  const type = isInitial ? (item.type || 'LISTEN_LAUNCH') : 'LISTEN_UPDATE';
  const data = {
    general: { accountID: 'acct-1', robotID: 'robot-1', lang: 'en-US' },
    runtime: {
      dialog: { referent: null }, perception: who.speaker ? { speaker: who.speaker } : {},
      loop: { loopId: 'loop-1', users: who.users },
      location: { lat: 42.36, lng: -71.06, iso: spec.runtimeISO },
    },
    skill: { id: 'report-skill' },
  };
  if (session) data.skill.session = session;
  if (isInitial) {
    data.result = item.intent
      ? { nlu: { intent: item.intent, entities: {}, rules: [] }, asr: { text: '' }, memo: item.memo || 'Reactive' }
      : { nlu: null, asr: { text: '' }, memo: item.memo || 'Reactive' };
  } else if (!step.omitResult) {
    if (step.noInput) data.result = { nlu: { intent: null, entities: null }, asr: { text: null } };
    else if (step.noMatch) data.result = { nlu: { intent: null, entities: null }, asr: { text: 'unmatched speech' } };
    else data.result = { nlu: { intent: step.intent, entities: step.entities || {}, rules: [] }, asr: { text: step.asr || '' } };
  }
  return { type, msgID: isInitial ? 's08-launch' : 's08-update', ts: 1, data };
}

function behaviorSummary(action) {
  if (!action || !action.config || !action.config.jcp) return [];
  const out = [];
  const visit = behavior => {
    if (!behavior) return;
    if (behavior.type === 'SLIM') {
      const play = behavior.config && behavior.config.play || {};
      const listen = behavior.config && behavior.config.listen || {};
      const meta = play.meta || {};
      out.push({ type: 'SLIM', mim_id: meta.mim_id || null, prompt_id: meta.prompt_id || null,
        contexts: listen.contexts || null });
      return;
    }
    if (Array.isArray(behavior.children)) behavior.children.forEach(visit);
    else out.push({ type: behavior.type || null });
  };
  visit(action.config.jcp);
  return out;
}

function normalizeResponse(response) {
  const data = response && response.data;
  const session = data && data.skill && data.skill.session;
  return {
    type: response && response.type,
    final: data && data.final,
    fireAndForget: data && data.fireAndForget,
    mims: behaviorSummary(data && data.action),
    analytics: (data && data.analytics) || {},
    trace: session ? session.trace.map(x => x.transition) : null,
    sessionData: session ? clone(session.data) : null,
  };
}

function installGraphStubs(item, calls) {
  const originals = {
    prefs: SettingsClient.getUserPrefs,
    dark: LassoClient.fetchDarkSky,
    maps: LassoClient.fetchGoogleMaps,
    news: LassoClient.fetchAPNews,
    calendar: LassoClient.fetchCalendarEvents,
  };
  const prefs = prefsFor(item.settings || 'weatherNews');
  const failures = item.providerFailures || [];
  SettingsClient.getUserPrefs = async (data, looperID) => {
    calls.settings.push({ looperID: looperID || null });
    if (item.settingsError) throw new Error('fixture Settings failure');
    if (looperID === 'notInLoop') return defaultPrefs();
    if (item.speaker === 'child') return defaultPrefs();
    return clone(prefs);
  };
  const result = (name, value, args) => {
    const prefetch = name === 'weather' && !!args[2];
    calls.providers.push({ name, prefetch, phase: 'start' });
    if (prefetch) return Promise.resolve(undefined);
    if (failures.indexOf(name) >= 0) return Promise.reject(new Error(`${name} fixture failure`));
    return Promise.resolve(clone(value));
  };
  LassoClient.fetchDarkSky = function(data, utc, prefetch) {
    const value = prefetch ? undefined : (utc ? weatherData()[0] : weatherData()[1]);
    return result('weather', value, arguments);
  };
  LassoClient.fetchGoogleMaps = function() { return result('commute', commuteData(), arguments); };
  LassoClient.fetchAPNews = function() { return result('news', newsData(prefs), arguments); };
  LassoClient.fetchCalendarEvents = function() { return result('calendar', calendarData(), arguments); };
  return () => {
    SettingsClient.getUserPrefs = originals.prefs;
    LassoClient.fetchDarkSky = originals.dark;
    LassoClient.fetchGoogleMaps = originals.maps;
    LassoClient.fetchAPNews = originals.news;
    LassoClient.fetchCalendarEvents = originals.calendar;
  };
}

async function runGraphCase(item) {
  randomState = 0x50454741;
  GraphManager._resetInstance();
  const calls = { settings: [], providers: [] };
  const restore = installGraphStubs(item, calls);
  const responses = [];
  try {
    const skill = new PersonalReport();
    let session;
    for (let i = 0; i <= (item.steps || []).length; i++) {
      const step = i === 0 ? null : item.steps[i - 1];
      const response = await skill.handle({ body: requestBody(item, step, session), log, jibo: {
        transID: 'transaction-1', toHeader() { return { 'x-jibo-transid': this.transID }; },
      } });
      responses.push(normalizeResponse(response));
      session = response.data && response.data.skill && response.data.skill.session;
    }
    return { id: item.id, ok: true, responses, calls };
  } catch (error) {
    return { id: item.id, ok: false, error: { name: error.name, message: error.message }, responses, calls };
  } finally { restore(); }
}

function settingsData(item) {
  return {
    general: { accountID: 'acct-1', robotID: 'robot-1' },
    runtime: { location: { iso: spec.runtimeISO }, perception: { speaker: item.speaker === 'child' ? 'kid' : item.speaker === 'none' ? null : 'u1' },
      loop: { loopId: 'loop-1', users: [adultUser(), childUser()] } },
    req: { jibo: { transID: item.transID === undefined ? 'transaction-1' : item.transID } }, log,
  };
}

async function runSettingsCase(item) {
  const originalGet = SettingsClient.getSettings;
  const originalEnv = process.env.prefsFromConfig;
  const calls = [];
  try {
    if (item.kind === 'convert') return { id: item.id, ok: true, value: clone(await SettingsClient.convertSettingsToPrefs(settingsShape(item.commuteType))), calls };
    if (item.kind === 'config') {
      process.env.prefsFromConfig = 'true';
      EnvVars.clearCache();
      return { id: item.id, ok: true, value: clone(await SettingsClient.getUserPrefs(settingsData(item), 'u1')), calls };
    }
    SettingsClient.getSettings = async function(accountId, loopId, transID) {
      calls.push({ accountId, loopId, transID: transID === undefined ? null : transID });
      return [{ skillId: 'report-skill', data: settingsShape(0) }];
    };
    return { id: item.id, ok: true, value: clone(await SettingsClient.getUserPrefs(settingsData(item), item.speaker === 'none' ? null : item.speaker === 'child' ? 'kid' : 'u1')), calls };
  } catch (error) {
    return { id: item.id, ok: false, error: { name: error.name, message: error.message }, calls };
  } finally {
    SettingsClient.getSettings = originalGet;
    process.env.prefsFromConfig = originalEnv;
    EnvVars.clearCache();
  }
}

async function main() {
  const graph = [];
  for (const item of spec.graphCases) graph.push(await runGraphCase(item));
  const settings = [];
  for (const item of spec.settingsCases) settings.push(await runSettingsCase(item));
  const result = {
    schemaVersion: 1, mode: 'source', referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    runtime: process.version, image: 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c',
    runnerSha256: sha(fs.readFileSync(__filename)), graph, settings,
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const all = graph.concat(settings);
  console.log(JSON.stringify({ mode: result.mode, graph: graph.length, settings: settings.length,
    ok: all.filter(x => x.ok).length, failed: all.filter(x => !x.ok).length }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
