import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReportSkill } from '../../packages/skills/src/report/personalReport.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { LassoClient } from '../../packages/skills/src/report/lassoClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';

const out = path.resolve(process.argv[2]);
const spec = JSON.parse(fs.readFileSync(new URL('./matrix-spec.json', import.meta.url)));
process.env.TZ = 'UTC';
process.env.prefsFromConfig = 'false';
process.env.NET_lasso = 'lasso:8080';
process.env.NET_settings = 'settings.jibo.aws';

const RealDate = Date;
const FIXED_NOW = RealDate.parse(spec.runtimeISO);
globalThis.Date = class FixtureDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
};
let randomState = 0x50454741;
Math.random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };

// Match the pinned @jibo/test-utils runtime shape: source speakerIsAdult
// performs arithmetic on epoch-millisecond birthdates.
function adultUser() { return { id: 'u1', accountId: 'acct-1', name: 'Alice Smith', birthdate: 631152000000 }; }
function childUser() { return { id: 'kid', accountId: 'acct-kid', name: 'Kid Smith', birthdate: 1388534400000 }; }
function settingsShape(type) {
  const enabled = value => ({ value: value ? 1 : 0 });
  const shape = {
    weatherEnabled: enabled(true), weather: enabled(false), calendarEnabled: enabled(true), commuteEnabled: enabled(true),
    commuteTime: { hour: 15, min: 0 }, homeLocation: { lat: 42.36, lng: -71.06 }, workLocation: { lat: 42.37, lng: -71.07 },
    commuteType: { value: type === null || type === undefined ? undefined : type }, newsEnabled: enabled(true),
    newsTechnology: enabled(true), newsSports: enabled(true), newsBusiness: enabled(true), newsScience: enabled(false),
    newsEntertainment: enabled(false), newsStrange: enabled(false), newsHealth: enabled(false), newsInternational: enabled(false),
    newsNational: enabled(true), newsPolitics: enabled(false),
    'google:personalCalendar:readonly': { credentialExists: true }, 'google:workCalendar:readonly': { credentialExists: false },
    'outlook:personalCalendar:readonly': { credentialExists: false }, 'outlook:workCalendar:readonly': { credentialExists: false },
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
  ['weather', 'calendar', 'commute', 'news'].forEach(cat => { prefs[cat].active = active.includes(cat); });
  if (name === 'calendar' || name === 'all') prefs.calendar.googlePersonalCreds = true;
  if (name === 'calendarIncomplete') {
    prefs.calendar.googlePersonalCreds = false; prefs.calendar.googleWorkCreds = false;
    prefs.calendar.outlookPersonalCreds = false; prefs.calendar.outlookWorkCreds = false;
  }
  if (name === 'commute' || name === 'all') Object.assign(prefs.commute, {
    complete: true, mode: 'driving', workTime: { hour: 15, min: 0 }, origin: { lat: 42.36, lng: -71.06 },
    destination: { lat: 42.37, lng: -71.07 },
  });
  if (name === 'commuteIncomplete') Object.assign(prefs.commute, {
    complete: false, mode: null, workTime: { hour: null, min: null }, origin: { lat: null, lng: null }, destination: { lat: null, lng: null },
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
function calendarData() { return { events: [{ summary: 'Event 1', start: { dateTime: '2018-05-30T13:00:00.000Z', timestamp: 1527685200000 }, fullDay: false }] }; }
function commuteData() { return { routes: [{ legs: [{ duration: { text: '18 mins', value: 1080 }, duration_in_traffic: { text: '25 mins', value: 1500 } }] }] }; }
function newsItem(category, i, header) {
  return {
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [`${category} ${header ? 'Provider' : 'Headline'} ${i}`] }],
    summary: [`A safe ${category} story ${i}.`],
    content: [{ nitf: [{ body: [{ 'body.content': [{ media: [{ 'media-reference': [
      { '$': { source: 'full', width: 4000, height: 3000 } }, { '$': { source: 'preview', width: 512, height: 300 } },
    ] }] }] }] }] }],
  };
}
function newsData(prefs) {
  return Object.keys(prefs.news.activeNewsCategories).filter(k => prefs.news.activeNewsCategories[k]).map(category => ({
    category: { name: category, sourceID: 0 }, data: { feed: { entry: [newsItem(category, 0, true), newsItem(category, 1, false), newsItem(category, 2, false)] } },
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
  const initial = !step;
  const data = {
    general: { accountID: 'acct-1', robotID: 'robot-1', lang: 'en-US' },
    runtime: { dialog: { referent: null }, perception: who.speaker ? { speaker: who.speaker } : {},
      loop: { loopId: 'loop-1', users: who.users }, location: { lat: 42.36, lng: -71.06, iso: spec.runtimeISO } },
    skill: { id: 'report-skill' },
  };
  if (session) data.skill.session = session;
  if (initial) data.result = item.intent
    ? { nlu: { intent: item.intent, entities: {}, rules: [] }, asr: { text: '' }, memo: item.memo || 'Reactive' }
    : { nlu: null, asr: { text: '' }, memo: item.memo || 'Reactive' };
  else if (!step.omitResult) {
    if (step.noInput) data.result = { nlu: { intent: null, entities: null }, asr: { text: null } };
    else if (step.noMatch) data.result = { nlu: { intent: null, entities: null }, asr: { text: 'unmatched speech' } };
    else data.result = { nlu: { intent: step.intent, entities: step.entities || {}, rules: [] }, asr: { text: step.asr || '' } };
  }
  return { type: initial ? (item.type || 'LISTEN_LAUNCH') : 'LISTEN_UPDATE', msgID: initial ? 's08-launch' : 's08-update', ts: 1, data };
}
function behaviorSummary(action) {
  if (!action?.config?.jcp) return [];
  const out = [];
  const visit = behavior => {
    if (!behavior) return;
    if (behavior.type === 'SLIM') {
      const play = behavior.config?.play || {}; const listen = behavior.config?.listen || {}; const meta = play.meta || {};
      out.push({ type: 'SLIM', mim_id: meta.mim_id || null, prompt_id: meta.prompt_id || null, contexts: listen.contexts || null });
    } else if (Array.isArray(behavior.children)) behavior.children.forEach(visit);
    else out.push({ type: behavior.type || null });
  };
  visit(action.config.jcp); return out;
}
function normalizeResponse(response) {
  const data = response?.data; const session = data?.skill?.session;
  return { type: response?.type, final: data?.final, fireAndForget: data?.fireAndForget, mims: behaviorSummary(data?.action),
    analytics: data?.analytics || {}, trace: session ? session.trace.map(x => x.transition) : null, sessionData: session ? clone(session.data) : null };
}
function installGraphStubs(item, calls) {
  const originals = { prefs: SettingsClient.getUserPrefs, dark: LassoClient.fetchDarkSky, maps: LassoClient.fetchGoogleMaps,
    news: LassoClient.fetchAPNews, calendar: LassoClient.fetchCalendarEvents };
  const prefs = prefsFor(item.settings || 'weatherNews'); const failures = item.providerFailures || [];
  SettingsClient.getUserPrefs = async (_data, looperID) => {
    calls.settings.push({ looperID: looperID || null });
    if (item.settingsError) throw new Error('fixture Settings failure');
    if (looperID === 'notInLoop' || item.speaker === 'child') return defaultPrefs();
    return clone(prefs);
  };
  const result = (name, value, args) => {
    const prefetch = name === 'weather' && !!args[2]; calls.providers.push({ name, prefetch, phase: 'start' });
    if (prefetch) return Promise.resolve(undefined);
    if (failures.includes(name)) return Promise.reject(new Error(`${name} fixture failure`));
    return Promise.resolve(clone(value));
  };
  LassoClient.fetchDarkSky = (...args) => { const [, utc, prefetch] = args; return result('weather', prefetch ? undefined : (utc ? weatherData()[0] : weatherData()[1]), args); };
  LassoClient.fetchGoogleMaps = (...args) => result('commute', commuteData(), args);
  LassoClient.fetchAPNews = (...args) => result('news', newsData(prefs), args);
  LassoClient.fetchCalendarEvents = (...args) => result('calendar', calendarData(), args);
  return () => { SettingsClient.getUserPrefs = originals.prefs; LassoClient.fetchDarkSky = originals.dark; LassoClient.fetchGoogleMaps = originals.maps;
    LassoClient.fetchAPNews = originals.news; LassoClient.fetchCalendarEvents = originals.calendar; };
}
async function runGraphCase(item) {
  randomState = 0x50454741;
  const calls = { settings: [], providers: [] }; const restore = installGraphStubs(item, calls); const responses = [];
  try {
    const skill = createReportSkill({ graphManager: new GraphManager() }); let session;
    for (let i = 0; i <= (item.steps || []).length; i++) {
      const step = i === 0 ? null : item.steps[i - 1];
      const response = await skill(requestBody(item, step, session), { log, req: { jibo: { transID: 'transaction-1', toHeader() { return { 'x-jibo-transid': this.transID }; } } } });
      responses.push(normalizeResponse(response)); session = response.data?.skill?.session;
    }
    return { id: item.id, ok: true, responses, calls };
  } catch (error) { return { id: item.id, ok: false, error: { name: error.name, message: error.message }, responses, calls }; }
  finally { restore(); }
}
function settingsData(item) {
  return { general: { accountID: 'acct-1', robotID: 'robot-1' }, runtime: {
    location: { iso: spec.runtimeISO }, perception: { speaker: item.speaker === 'child' ? 'kid' : item.speaker === 'none' ? null : 'u1' },
    loop: { loopId: 'loop-1', users: [adultUser(), childUser()] },
  }, req: { jibo: { transID: item.transID === undefined ? 'transaction-1' : item.transID } }, log };
}
async function runSettingsCase(item) {
  const originalGet = SettingsClient.getSettings; const calls = []; const old = process.env.prefsFromConfig;
  try {
    if (item.kind === 'convert') return { id: item.id, ok: true, value: clone(await SettingsClient.convertSettingsToPrefs(settingsShape(item.commuteType))), calls };
    if (item.kind === 'config') { process.env.prefsFromConfig = 'true'; clearReportEnvCache(); return { id: item.id, ok: true, value: clone(await SettingsClient.getUserPrefs(settingsData(item), 'u1')), calls }; }
    SettingsClient.getSettings = async (accountId, loopId, transID) => { calls.push({ accountId, loopId, transID: transID ?? null }); return [{ skillId: 'report-skill', data: settingsShape(0) }]; };
    const id = item.speaker === 'none' ? null : item.speaker === 'child' ? 'kid' : 'u1';
    return { id: item.id, ok: true, value: clone(await SettingsClient.getUserPrefs(settingsData(item), id)), calls };
  } catch (error) { return { id: item.id, ok: false, error: { name: error.name, message: error.message }, calls }; }
  finally { SettingsClient.getSettings = originalGet; process.env.prefsFromConfig = old; clearReportEnvCache(); }
}
const graph = []; for (const item of spec.graphCases) graph.push(await runGraphCase(item));
const settings = []; for (const item of spec.settingsCases) settings.push(await runSettingsCase(item));
let candidateRevision = 'unknown';
try { candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch {}
const result = { schemaVersion: 1, mode: 'candidate', candidateRevision, runtime: process.version,
  runnerSha256: sha(fs.readFileSync(new URL('./run-candidate.mjs', import.meta.url))), graph, settings };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
const all = graph.concat(settings);
console.log(JSON.stringify({ mode: result.mode, graph: graph.length, settings: settings.length, ok: all.filter(x => x.ok).length, failed: all.filter(x => !x.ok).length }));
