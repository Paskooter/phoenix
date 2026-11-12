// One OpenRouter key for every AI feature.
//
// A server set up before the one key existed had a separate OpenRouter key per
// feature: Free AI chat's in the environment file, the decision layer's (Jev) in
// the environment file and, newer, a dedicated one saved in the console. When
// the account service starts it must move the key Phoenix was really using for
// Jev into the one setting, without anyone pasting it again, so that every
// feature, as the launcher would start it, uses that key and Jev keeps its key
// and model. Keys are invented fixtures, and none may appear in a view, the
// settings history or a log line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLlmProvider } from '@phoenix/contracts';
import { adminSettingsRoutes } from '../src/admin/settingsRoutes.js';
import { checkTogether } from '../src/admin/configCatalog.js';
import { readEnvFile } from '../src/admin/envFile.js';
import { freeChatConfigFromEnv } from '../src/freeChat/routes.js';
import { decisionConfig } from '../../nlu/src/decisionLayer.js';
import { newsBriefingConfig } from '../../data/src/newsBriefings/config.js';

// Invented values only: never a real key.
const JEV_KEY = 'fixture-openrouter-jev-dedicated-key-0001';
const OLD_DECISION_KEY = 'fixture-openrouter-old-decision-key-0002';
const CHAT_KEY = 'fixture-openrouter-free-chat-key-0003';
const CUSTOM_KEY = 'fixture-custom-endpoint-key-0004';
const ALL_KEYS = [JEV_KEY, OLD_DECISION_KEY, CHAT_KEY, CUSTOM_KEY];
const launcherHelper = new URL('../../../scripts/console-settings-env.mjs', import.meta.url).pathname;

/** A server as it was before the one key: per-feature keys in its file and console. */
function server(t, { envLines = [], consoleSettings = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-one-openrouter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, 'server.env');
  writeFileSync(envFile, `${envLines.join('\n')}\n`);
  const file = join(dir, 'config', 'console-settings.json');
  if (consoleSettings) {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(consoleSettings, null, 2)}\n`, { mode: 0o600 });
  }
  writeFileSync(join(dir, 'services.json'), JSON.stringify({ version: 1, services: {
    account: { state: 'running', revision: 0 }, parser: { state: 'running', revision: 0 },
    'answer-skill': { state: 'running', revision: 0 }, lasso: { state: 'running', revision: 0 },
  } }));
  const failures = [];
  const options = (extra = {}) => ({
    env: { PHOENIX_CONSOLE_SETTINGS_FILE: file, PHOENIX_ENV_FILE: envFile },
    requireAdmin: () => true, currentAccount: () => ({ email: 'admin@example.invalid' }),
    control: () => ({ available: true, dir, pid: 1 }),
    sendJson: (_res, status, body) => { failures.push({ status, body }); return undefined; },
    restart: () => assert.fail('nothing here restarts a service'),
    ...extra,
  });
  const routes = (extra) => adminSettingsRoutes({ file: join(dir, 'store.json') }, options(extra));
  /** What every service sees when the launcher starts it: the file, then console settings over it. */
  const launched = () => {
    const pairs = execFileSync(process.execPath, [launcherHelper, file], { encoding: 'utf8' })
      .split('\0').filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]);
    return { ...readEnvFile(envFile).values, ...Object.fromEntries(pairs) };
  };
  return { dir, file, envFile, routes, launched, failures };
}

/** The live jibo.io shape, with invented keys: Jev's dedicated key was saved in the console. */
const jiboIoShape = () => ({
  envLines: [
    'ETCO_parser_decisionEngine=jev',
    `ETCO_parser_decisionApiKey=${OLD_DECISION_KEY}`,
    'PHOENIX_FREE_CHAT_ENABLED=true',
    `PHOENIX_FREE_CHAT_API_KEY=${CHAT_KEY}`,
    'LLM_URL=http://192.0.2.10:1234/v1',
    'LLM_MODEL=fixture/local-model',
  ],
  consoleSettings: {
    version: 1,
    revision: 9,
    settings: {
      ETCO_parser_decisionApiKey: { value: JEV_KEY, revision: 9, changedAt: 1794466681430, changedBy: 'owner@example.invalid' },
      WORLD_NEWS_API_KEY: { value: 'fixture-world-news-key-0005', revision: 3, changedAt: 1794000000000, changedBy: 'owner@example.invalid' },
    },
    history: [{ revision: 9, at: 1794466681430, by: 'owner@example.invalid', changes: [{ key: 'ETCO_parser_decisionApiKey', action: 'set' }] }],
  },
});

test('per-feature OpenRouter keys move to the one key, and Jev keeps its own key and model', (t) => {
  const s = server(t, jiboIoShape());
  const routes = s.routes();

  // The console shows one OpenRouter key, already set, from the key Jev was using.
  const view = routes['GET /api/admin/settings']({ req: {}, res: {} });
  const one = view.settings.find((setting) => setting.key === 'OPENROUTER_API_KEY');
  assert.ok(one, 'there is one OpenRouter key setting');
  assert.equal(one.isSet, true);
  assert.equal(one.source, 'console');
  assert.equal(one.editable, true);
  assert.equal(one.hint, JEV_KEY.slice(-4), 'the key Jev was using, told apart by its last four characters');
  const keySettings = view.settings.filter((setting) => setting.group === one.group && setting.type === 'secret' && setting.editable);
  assert.deepEqual(keySettings.map((setting) => setting.key).sort(), ['OPENROUTER_API_KEY', 'PHOENIX_LLM_API_KEY'],
    'the only keys left to set are the OpenRouter key and a custom endpoint’s own');
  for (const key of ['ETCO_parser_decisionApiKey', 'ETCO_news_llmApiKey', 'PHOENIX_FREE_CHAT_API_KEY']) {
    const older = view.settings.find((setting) => setting.key === key);
    assert.equal(older.editable, false, `${key} can no longer be set`);
    assert.equal(older.replacedBy, 'OPENROUTER_API_KEY');
  }
  assert.equal(view.settings.find((setting) => setting.key === 'ETCO_parser_decisionApiKey').removable, true);

  // Each feature picks its own model from the one key.
  for (const key of ['PHOENIX_FREE_CHAT_MODEL', 'PHOENIX_FREE_CHAT_OVERFLOW_MODEL', 'ETCO_parser_decisionModel', 'ETCO_news_llmModel']) {
    const model = view.settings.find((setting) => setting.key === key);
    assert.equal(model?.type, 'model', `${key} is a model picker`);
    assert.equal(model.models, 'openrouter');
    assert.equal(model.group, one.group);
  }
  assert.equal(view.settings.find((setting) => setting.key === 'LLM_MODEL').models, 'endpoint');

  // Every feature, as the launcher starts it, now uses Jev's key.
  const env = s.launched();
  const jev = decisionConfig(env);
  assert.equal(jev.enabled, true);
  assert.equal(jev.apiKey, JEV_KEY, 'Jev keeps its dedicated key');
  assert.equal(jev.model, 'typesafe/jev-1.13', 'Jev keeps its model');
  assert.equal(freeChatConfigFromEnv(env).provider.apiKey, JEV_KEY, 'Free AI chat uses the one key');
  assert.equal(newsBriefingConfig({ ...env, PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true' }).llm.apiKey, JEV_KEY, 'news uses the one key');
  const openRouterEndpoint = resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: 'https://openrouter.ai/api/v1' } });
  assert.equal(openRouterEndpoint.apiKey, JEV_KEY, 'an OpenRouter endpoint uses the one key');
  const customEndpoint = resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: env.LLM_URL } });
  assert.equal(customEndpoint.apiKey, '', 'the OpenRouter key never goes to a custom endpoint');
  assert.equal(resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: env.LLM_URL, PHOENIX_LLM_API_KEY: CUSTOM_KEY } }).apiKey,
    CUSTOM_KEY, 'a custom endpoint gets its own key');

  // The older keys stay where they were, so a rolled-back release still finds them.
  const saved = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.equal(saved.settings.ETCO_parser_decisionApiKey.value, JEV_KEY);
  assert.equal(saved.settings.OPENROUTER_API_KEY.value, JEV_KEY);
  assert.equal(saved.revision, 10);
  assert.equal(readFileSync(s.envFile, 'utf8'), `${jiboIoShape().envLines.join('\n')}\n`, 'the server’s file is never written');

  // Neither the view nor the history holds a key; the history says where it came from.
  const shown = JSON.stringify(routes['GET /api/admin/settings']({ req: {}, res: {} }));
  for (const key of ALL_KEYS) assert.ok(!shown.includes(key), 'no key is ever sent to the browser');
  for (const key of ALL_KEYS) assert.ok(!JSON.stringify(saved.history).includes(key), 'no key in the history');
  assert.deepEqual(view.history[0].changes, [{ key: 'OPENROUTER_API_KEY', label: 'OpenRouter key', action: 'set', movedFrom: 'Old decision layer key' }]);
  assert.equal(s.failures.length, 0);

  // It happens once: starting again changes nothing.
  const before = readFileSync(s.file, 'utf8');
  s.routes();
  assert.equal(readFileSync(s.file, 'utf8'), before);
});

test('an OpenRouter key removed in the console is not moved back', (t) => {
  const s = server(t, jiboIoShape());
  const routes = s.routes();
  const removed = routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: { OPENROUTER_API_KEY: null } } });
  assert.deepEqual(removed.saved, ['OPENROUTER_API_KEY']);
  s.routes();
  const view = s.routes()['GET /api/admin/settings']({ req: {}, res: {} });
  assert.equal(view.settings.find((setting) => setting.key === 'OPENROUTER_API_KEY').isSet, false);
  // Without it, each feature falls back to its own older key, as before.
  assert.equal(decisionConfig(s.launched()).apiKey, JEV_KEY);
  assert.equal(freeChatConfigFromEnv(s.launched()).provider.apiKey, CHAT_KEY);
});

test('a server with keys only in its environment file moves the decision layer’s key', (t) => {
  const s = server(t, { envLines: [`PHOENIX_FREE_CHAT_API_KEY=${CHAT_KEY}`, `ETCO_parser_decisionApiKey=${OLD_DECISION_KEY}`] });
  s.routes();
  const saved = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.equal(saved.settings.OPENROUTER_API_KEY.value, OLD_DECISION_KEY);
  assert.equal(saved.history[0].changes[0].movedFrom, 'ETCO_parser_decisionApiKey');
  assert.equal(freeChatConfigFromEnv(s.launched()).provider.apiKey, OLD_DECISION_KEY);
});

test('a server that already has the one key in its file, and nothing older in the console, is left alone', (t) => {
  const s = server(t, { envLines: [`OPENROUTER_API_KEY=${JEV_KEY}`, `PHOENIX_FREE_CHAT_API_KEY=${CHAT_KEY}`] });
  s.routes();
  assert.equal(existsSync(s.file), false, 'nothing to move, nothing written');
  const env = s.launched();
  assert.equal(freeChatConfigFromEnv(env).provider.apiKey, JEV_KEY, 'the one key wins over the older one');
  assert.equal(decisionConfig({ ...env, ETCO_parser_decisionEngine: 'jev' }).apiKey, JEV_KEY);
});

test('older key settings can be removed but not set again', (t) => {
  const s = server(t, jiboIoShape());
  const routes = s.routes();
  routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: { ETCO_parser_decisionApiKey: 'fixture-another-key-0006' } } });
  assert.equal(s.failures.at(-1).status, 400);
  assert.match(s.failures.at(-1).body.errors.ETCO_parser_decisionApiKey, /replaced by the OpenRouter key/);
  routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: { PHOENIX_FREE_CHAT_API_KEY: null } } });
  assert.equal(s.failures.at(-1).status, 400, 'a key only in the server’s file is not the console’s to remove');
  const removed = routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: { ETCO_parser_decisionApiKey: null } } });
  assert.deepEqual(removed.saved, ['ETCO_parser_decisionApiKey']);
  assert.equal(decisionConfig(s.launched()).apiKey, JEV_KEY, 'Jev still has its key, through the one key');
});

test('model pickers list what the chosen endpoint offers, and keys go only where they belong', async (t) => {
  const s = server(t, { envLines: ['LLM_URL=http://192.0.2.10:1234/v1', `PHOENIX_LLM_API_KEY=${CUSTOM_KEY}`, `OPENROUTER_API_KEY=${JEV_KEY}`] });
  const requests = [];
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization || null, redirect: init.redirect });
    if (String(url) === 'https://openrouter.ai/api/v1/models') {
      return respond({ data: [
        { id: 'vendor/paid-model', name: 'Vendor: Paid', context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
        { id: 'vendor/free-model:free', name: 'Vendor: Free', context_length: 32000, pricing: { prompt: '0', completion: '0' } },
        { id: 'has a space', name: 'refused' },
      ] });
    }
    if (String(url) === 'http://192.0.2.10:1234/v1/models') return respond({ object: 'list', data: [{ id: 'fixture/local-model', object: 'model' }] });
    if (String(url) === 'http://192.0.2.99/v1/models') return respond({ error: 'nope' }, 404);
    throw new TypeError('unreachable');
  };
  const routes = s.routes({ fetchImpl });
  const models = (query) => routes['GET /api/admin/settings/models']({ req: {}, res: {}, url: new URL(`http://x/api/admin/settings/models?${query}`) });

  const all = await models('key=ETCO_parser_decisionModel');
  assert.equal(all.available, true);
  assert.deepEqual(all.models.map((m) => m.id), ['vendor/free-model:free', 'vendor/paid-model']);
  assert.deepEqual(all.models[1], { id: 'vendor/paid-model', name: 'Vendor: Paid', context: 128000, free: false });
  const free = await models('key=PHOENIX_FREE_CHAT_MODEL');
  assert.deepEqual(free.models.map((m) => m.id), ['vendor/free-model:free'], 'the free chat model only offers free models');

  const local = await models('key=LLM_MODEL');
  assert.equal(local.available, true);
  assert.equal(local.endpoint, 'http://192.0.2.10:1234/v1');
  assert.deepEqual(local.models.map((m) => m.id), ['fixture/local-model']);

  const unsaved = await models(`key=LLM_MODEL&url=${encodeURIComponent('http://192.0.2.99/v1')}`);
  assert.equal(unsaved.available, false, 'an endpoint that cannot list models asks for the name by hand');
  assert.match(unsaved.message, /404/);

  assert.deepEqual(requests.map((r) => [r.url, r.authorization]), [
    ['https://openrouter.ai/api/v1/models', null],
    ['http://192.0.2.10:1234/v1/models', `Bearer ${CUSTOM_KEY}`],
    ['http://192.0.2.99/v1/models', null],
  ], 'OpenRouter lists without a key (the second list came from cache); the custom key goes only to its own endpoint');
  assert.ok(requests.every((r) => r.redirect === 'error'));
  for (const result of [all, free, local, unsaved]) for (const key of ALL_KEYS) assert.ok(!JSON.stringify(result).includes(key));

  routes['GET /api/admin/settings/models']({ req: {}, res: {}, url: new URL('http://x/api/admin/settings/models?key=OPENROUTER_API_KEY') });
  assert.equal(s.failures.at(-1).status, 400, 'only model settings list models');
});

test('a custom endpoint’s key reaches OpenRouter only when that endpoint is OpenRouter itself', () => {
  // A self-hosted server with a keyed LM Studio, news on, and no OpenRouter key.
  const custom = { PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', LLM_URL: 'http://192.0.2.10:1234/v1',
    PHOENIX_LLM_URL: 'http://192.0.2.10:1234/v1', PHOENIX_LLM_API_KEY: CUSTOM_KEY };
  assert.equal(newsBriefingConfig(custom).llm.apiKey, '', 'news on OpenRouter must not get the LM Studio key');
  assert.equal(resolveLlmProvider('answer', { env: { ...custom, ETCO_answer_llmUrl: 'https://openrouter.ai/api/v1' } }).apiKey, '',
    'a service pointed at OpenRouter must not get the LM Studio key');
  assert.ok(checkTogether(custom).warnings.some((w) => w.key === 'OPENROUTER_API_KEY' && /news briefings/i.test(w.message)),
    'the console says news has no OpenRouter key');
  // An older server whose shared endpoint is OpenRouter kept its OpenRouter key there: that still works.
  const older = { PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', LLM_URL: 'https://openrouter.ai/api/v1',
    PHOENIX_LLM_URL: 'https://openrouter.ai/api/v1', PHOENIX_LLM_API_KEY: CUSTOM_KEY };
  assert.equal(newsBriefingConfig(older).llm.apiKey, CUSTOM_KEY);
  assert.equal(resolveLlmProvider('answer', { env: older }).apiKey, CUSTOM_KEY);
  assert.ok(!checkTogether(older).warnings.some((w) => w.key === 'OPENROUTER_API_KEY'));
});

test('the one key never goes to OpenRouter over plain http', () => {
  const config = newsBriefingConfig({ PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', OPENROUTER_API_KEY: JEV_KEY,
    ETCO_news_llmUrl: 'http://openrouter.ai/api/v1' });
  assert.notEqual(config.llm.apiKey, JEV_KEY);
  assert.equal(config.llm.apiKey, '');
  assert.equal(config.openRouter, false);
});

test('the console reads the shared endpoint the way the services do: PHOENIX_LLM_URL first', (t) => {
  // The file sets a custom shared endpoint (PHOENIX_LLM_URL) with its own key, while the
  // console's Endpoint (LLM_URL) is OpenRouter. The services treat that key as the custom
  // endpoint's, so news gets no OpenRouter key: the console must say so, and must not move
  // that key into the OpenRouter key.
  const s = server(t, { envLines: ['PHOENIX_NEWS_BRIEFINGS_ENABLED=true', 'PHOENIX_NEWS_PROVIDER=curated',
    'LLM_URL=https://openrouter.ai/api/v1', 'PHOENIX_LLM_URL=http://192.0.2.10:1234/v1', `PHOENIX_LLM_API_KEY=${CUSTOM_KEY}`] });
  const view = s.routes()['GET /api/admin/settings']({ req: {}, res: {} });
  assert.equal(newsBriefingConfig(s.launched()).llm.apiKey, '', 'the services send news no key');
  assert.notEqual(view.settings.find((setting) => setting.key === 'OPENROUTER_API_KEY').isSet, true,
    'the custom endpoint’s key is not moved into the OpenRouter key');
  assert.ok(view.warnings.some((w) => w.key === 'OPENROUTER_API_KEY' && /news briefings/i.test(w.message)),
    'the console says news has no OpenRouter key');

  // The other way round, the services do send that key to OpenRouter, so there is nothing to warn about.
  const other = server(t, { envLines: ['PHOENIX_NEWS_BRIEFINGS_ENABLED=true', 'PHOENIX_NEWS_PROVIDER=curated',
    'LLM_URL=http://192.0.2.10:1234/v1', 'PHOENIX_LLM_URL=https://openrouter.ai/api/v1', `PHOENIX_LLM_API_KEY=${CUSTOM_KEY}`] });
  const otherView = other.routes({ migrate: false })['GET /api/admin/settings']({ req: {}, res: {} });
  assert.equal(newsBriefingConfig(other.launched()).llm.apiKey, CUSTOM_KEY);
  assert.ok(!otherView.warnings.some((w) => w.key === 'OPENROUTER_API_KEY' && /news briefings/i.test(w.message)));
});

test('no key goes to openrouter.ai over plain http, not even a custom endpoint’s', async (t) => {
  const plain = 'http://openrouter.ai/api/v1';
  assert.equal(resolveLlmProvider('answer', { env: { ETCO_answer_llmUrl: plain, PHOENIX_LLM_API_KEY: CUSTOM_KEY } }).apiKey, '',
    'a service pointed at plain-http OpenRouter gets no key');
  assert.equal(resolveLlmProvider('answer', { env: { ETCO_answer_llmUrl: 'http://WWW.OpenRouter.ai/api/v1',
    ETCO_answer_llmApiKey: OLD_DECISION_KEY, OPENROUTER_API_KEY: JEV_KEY } }).apiKey, '');
  assert.equal(decisionConfig({ ETCO_parser_decisionEngine: 'jev', ETCO_parser_decisionUrl: 'http://openrouter.ai/api/alpha/decisions',
    ETCO_parser_decisionApiKey: OLD_DECISION_KEY }).apiKey, '', 'the decision layer sends no key over plain http');
  // A custom endpoint still gets its own key.
  assert.equal(resolveLlmProvider('answer', { env: { ETCO_answer_llmUrl: 'http://192.0.2.10:1234/v1', PHOENIX_LLM_API_KEY: CUSTOM_KEY } }).apiKey,
    CUSTOM_KEY);

  // Listing models at a plain-http OpenRouter endpoint sends no key either.
  const s = server(t, { envLines: [`LLM_URL=${plain}`, `PHOENIX_LLM_API_KEY=${CUSTOM_KEY}`] });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization ?? null });
    return new Response(JSON.stringify({ data: [{ id: 'vendor/model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const listed = await s.routes({ fetchImpl, migrate: false })['GET /api/admin/settings/models']({ req: {}, res: {},
    url: new URL('http://x/api/admin/settings/models?key=LLM_MODEL') });
  assert.equal(listed.available, true);
  assert.deepEqual(requests, [{ url: `${plain}/models`, authorization: null }]);
});
