// Inputs shared by the original Node 8 runner and the Phoenix runner. Expected
// results are produced by the original modules, never by the implementation.
'use strict';
const clone = value => JSON.parse(JSON.stringify(value));
const valid = () => ({ id: 'alpha', URL: 'http://skill/v1/main', intents: [{ name: 'hello' }] });
const proactive = () => ({ topics: ['CLOCK'], contextRules: [] });
const view = () => ({ type: 'group', index: 0, childViews: [{ type: 'toggle', index: 1, valueDefinition: { target: 'lasso', key: 'enabled' } }] });

function validationCases() {
  const out = [];
  function add(id, mutate) { const entry = valid(); mutate(entry); out.push({ id, configs: [entry] }); }
  add('valid-minimal', () => {});
  add('valid-empty-id', c => { c.id = ''; });
  add('valid-unknown-metadata', c => { c.extension = { array: [1, { alive: true }] }; });
  add('missing-id', c => { delete c.id; });
  add('numeric-id', c => { c.id = 1; });
  add('missing-url-on-robot', c => { delete c.URL; c.onRobot = true; });
  add('empty-url-cloud', c => { c.URL = ''; });
  add('empty-url-robot', c => { c.URL = ''; c.onRobot = true; });
  add('truthy-on-robot', c => { c.URL = ''; c.onRobot = 'yes'; });
  add('non-http-url', c => { c.URL = 'not-an-http-url'; });
  add('missing-intents', c => { delete c.intents; });
  add('null-intents', c => { c.intents = null; });
  add('intent-no-name', c => { c.intents = [{}]; });
  add('intent-truthy-numeric-name', c => { c.intents = [{ name: 1 }]; });
  add('null-intent', c => { c.intents = [null]; });
  for (const entities of [null, false, {}, [null], [{ name: 4, value: 'a' }], [{ name: 'x' }], [{ name: 'x', value: '' }], [{ name: '', value: false }], [{ name: 'x', value: 0 }], [{ name: 'x', value: {} }]]) {
    add('entities-' + JSON.stringify(entities), c => { c.intents[0].entities = entities; });
  }
  for (const value of [null, false, {}, []]) add('proactives-' + JSON.stringify(value), c => { c.proactives = value; });
  for (const [id, delta] of [
    ['valid', {}], ['missing-topics', { topics: undefined }], ['bad-topic', { topics: [4] }],
    ['bad-rules', { contextRules: {} }], ['context-extra', { contextRules: [{ extra: true }] }],
    ['context-field', { contextRules: [{ field: 3 }] }], ['context-match', { contextRules: [{ field: '' }] }],
    ['context-value', { contextRules: [{ field: 'x', matchRule: 'EXACT' }] }],
    ['context-null', { contextRules: [{ field: 'x', matchRule: 'EXACT', value: null }] }],
    ['ih-list', { IHRules: {} }], ['settings-list', { settingsRules: {} }],
  ]) add('proactive-' + id, c => { c.proactives = [Object.assign(proactive(), delta)]; });
  const ih = { query: { type: 'LastEvent' }, matchRule: 'EXACT', value: null };
  for (const [id, delta] of [
    ['valid', {}], ['missing-query', { query: undefined }], ['unknown-query', { query: 'other' }],
    ['numeric-query', { query: 4 }], ['extra', { extra: 1 }], ['missing-match', { matchRule: undefined }],
    ['bad-match', { matchRule: 'bad' }], ['transform', { transform: 'bad' }],
    ['time-invalid', { transform: 'TimeSince', value: 5 }], ['time-valid', { transform: 'TimeSince', value: [1, 'sec'] }],
    ['check-property', { checkProperty: 2 }], ['missing-value', { value: undefined }],
    ['string-value', { value: 'a' }], ['object-value', { value: {} }], ['array-value', { value: [] }],
    ['named-query', { query: 'known' }],
  ]) add('ih-' + id, c => { c.IHQueries = { known: { type: 'Count' } }; c.proactives = [Object.assign(proactive(), { IHRules: [Object.assign({}, ih, delta)] })]; });
  for (const query of [{}, { type: 'bad' }, { type: 'Count', extra: 1 }, { type: 'Count', queryRules: {} },
    { type: 'Count', startTimeOffset: [1, 'day'] }, { type: 'Count', startTimeOffset: [-1, 'day'] },
    { type: 'Count', endTimeOffset: 'SinceWaking' }, { type: 'Count', endTimeOffset: 'bad' },
    { type: 'Count', endTimeOffset: [1, 'bad'] }, { type: 'Count', startTimeOffset: 0 },
    { type: 'Count', queryRules: [{}] }, { type: 'Count', queryRules: [{ field: 'bad' }] },
    { type: 'Count', queryRules: [{ field: 'skillID' }] },
    { type: 'Count', queryRules: [{ field: 'skillID', match: 'bad', value: 3 }] },
    { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT' }] },
    { type: 'Count', queryRules: [{ field: 'payload', match: 'ONE_OF', value: null, key: 'enabled' }] },
  ]) add('query-' + JSON.stringify(query), c => { c.IHQueries = { q: query }; });
  for (const value of ['bad', [], null, false]) add('queries-' + JSON.stringify(value), c => { c.IHQueries = value; });
  for (const rule of [{}, { skill: 3 }, { skill: 'x' }, { skill: 'x', key: 3 }, { skill: 'x', key: 'a' },
    { skill: 'x', key: 'a', matchRule: 'bad' }, { skill: 'x', key: 'a', matchRule: 'NOT' },
    { skill: 'x', key: 'a', matchRule: 'EXACT', value: true, extra: 1 },
  ]) add('settings-rule-' + JSON.stringify(rule), c => { c.proactives = [Object.assign(proactive(), { settingsRules: [rule] })]; });
  for (const [id, mutate] of [
    ['valid', () => {}], ['no-view', c => { delete c.settings.view; }], ['null-view', c => { c.settings.view = null; }],
    ['type', c => { c.settings.view.type = ' '; }], ['index', c => { c.settings.view.index = '0'; }],
    ['nan-index', c => { c.settings.view.index = NaN; }], ['children', c => { c.settings.view.childViews = {}; }],
    ['reverse-child-order', c => { c.settings.view.childViews = [{ type: ' ' }, { type: 'x', index: 'bad' }]; }],
    ['empty-definition', c => { c.settings.view.valueDefinition = {}; }],
    ['bad-target', c => { c.settings.view.childViews[0].valueDefinition.target = 'other'; }],
    ['empty-key', c => { c.settings.view.childViews[0].valueDefinition.key = ' '; }],
    ['numeric-zero-target', c => { c.settings.view.childViews[0].valueDefinition.target = 0; }],
    ['string-zero-target', c => { c.settings.view.childViews[0].valueDefinition.target = '0'; }],
    ['numeric-one-target', c => { c.settings.view.childViews[0].valueDefinition.target = 1; }],
    ['prototype-target', c => { c.settings.view.childViews[0].valueDefinition.target = 'toString'; }],
  ]) add('view-' + id, c => { c.settings = { view: view() }; mutate(c); });
  out.push({ id: 'duplicate-case-insensitive', configs: [valid(), Object.assign(valid(), { id: 'beta' }), Object.assign(valid(), { id: 'ALPHA', onRobot: true, URL: '', proactives: [] })] });
  out.push({ id: 'null-config', configs: [null] });
  out.push({ id: 'undefined-config', configs: [undefined] });
  return out;
}

function registryCases() {
  const basic = { id: 'alpha', intents: [{ name: 'hello', memo: { greeting: true } }], settings: { view: view() }, basePath: '/api/custom/', vendor: { keep: [1, false] }, URL: 'overwritten' };
  const out = [];
  function add(id, entry, manifest) { out.push({ id, index: { skills: [Object.assign({ configPath: 'manifest.json' }, entry)] }, files: { 'manifest.json': manifest === undefined ? clone(basic) : manifest } }); }
  for (const baseURL of ['http://skill/', '/http://skill/', 'http://skill///', 'https://skill', '', null, 'ftp://skill', 4]) add('url-' + JSON.stringify(baseURL), { baseURL });
  for (const basePath of ['', '/', '//custom//', null, 3]) add('base-path-' + JSON.stringify(basePath), { baseURL: 'http://skill/' }, Object.assign(clone(basic), { basePath }));
  add('on-robot', {}, { id: '@be/clock', onRobot: true, intents: [], settings: { view: view() } });
  add('no-inferred-on-robot', {}, { id: 'broken', intents: [] });
  add('null-manifest', {}, null);
  add('primitive-manifest', {}, 5);
  add('missing-manifest', { configPath: 'missing.json' });
  out.push({ id: 'broken-manifest-json', index: { skills: [{ configPath: 'manifest.json' }] }, files: { 'manifest.json': { raw: '{"a":}' } }, rawFiles: true });
  out.push({ id: 'mixed-missing-manifest', index: { skills: [{ configPath: 'missing.json' }, { configPath: 'manifest.json', baseURL: 'http://skill' }] }, files: { 'manifest.json': basic } });
  for (const index of [{ skills: [] }, {}, null, { skills: {} }, { skills: [null] }, { skills: [{}] }, { skills: [{ configPath: 1 }] }]) out.push({ id: 'index-' + JSON.stringify(index), index, files: {} });
  out.push({ id: 'broken-index-json', rawIndex: '{"skills":', files: {} });
  return out;
}

function httpSkills() {
  return [Object.assign(valid(), { settings: { view: view() }, extension: { preserve: true } }),
    { id: '@be/clock', onRobot: true, URL: '', intents: [{ name: 'time' }] },
    Object.assign(valid(), { id: 'ALPHA', URL: 'http://replacement/v1/main', proactives: [] })];
}

function httpCases() {
  const paths = ['/skills/robot', '/v1/skills/robot', '/skills/settings/robot', '/v1/skills/settings/robot',
    '/V1/Skills/Robot/?ignored=1', '/skills/other', '/skills/settings', '/skills/settings/', '/skills/settings/robot/extra',
    '/skills/%E2%98%83', '/skills/robot?settings=true', '/v1/skills/settings/%2F', '/skills/%ZZ'];
  const out = paths.map(path => ({ id: 'GET ' + path, method: 'GET', path }));
  for (const method of ['HEAD', 'OPTIONS', 'POST']) out.push({ id: method + ' list', method, path: '/v1/skills/settings/robot' });
  out.push({ id: 'invalid-authorization-ignored', method: 'GET', path: '/skills/settings/robot', headers: { authorization: 'bad' } });
  out.push({ id: 'malformed-json-before-route', method: 'GET', path: '/skills/robot', body: '{"a":}', headers: { 'content-type': 'application/json' } });
  return out;
}

const configKeys = ['ETCO_hub_disableAuth', 'ETCO_hub_skillsConfig', 'ETCO_hub_speechConfig', 'NET_parser', 'NET_history', 'ETCO_hub_recordSpeechHistory', 'ETCO_hub_recordLaunchHistory', 'NET_settings'];
function configCases() {
  return [
    { id: 'defaults', env: {} },
    { id: 'true-flags', env: { ETCO_hub_disableAuth: 'true', ETCO_hub_recordSpeechHistory: 'true' } },
    { id: 'case-sensitive-flags', env: { ETCO_hub_disableAuth: 'TRUE', ETCO_hub_recordSpeechHistory: 'TRUE', ETCO_hub_recordLaunchHistory: 'TRUE' } },
    { id: 'false-launch-history', env: { ETCO_hub_recordLaunchHistory: 'false' } },
    { id: 'empty-defaults', env: Object.fromEntries ? Object.fromEntries(configKeys.map(key => [key, ''])) : configKeys.reduce((o, key) => { o[key] = ''; return o; }, {}) },
    { id: 'net-authorities', env: { NET_parser: 'parser:9090', NET_history: 'history:9091', NET_settings: 'settings:9092' } },
    { id: 'source-prefixes-even-schemes', env: { NET_parser: 'https://parser', NET_history: 'http://history', NET_settings: 'http://settings' } },
  ];
}
module.exports = { validationCases, registryCases, httpSkills, httpCases, configCases, configKeys };
