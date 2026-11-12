// Speech recognition through OpenRouter or a speech server of your own, from the
// console: the settings an administrator sets, what the voice gateway receives
// when the launcher starts it, the OpenRouter speech model checked against
// OpenRouter's list when it is saved (typed by hand when the list can't be had),
// and what the overview reports about the recognizer in use and its recent cost.
// Keys are invented fixtures; none may appear in a view, a model list or a status.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminSettingsRoutes } from '../src/admin/settingsRoutes.js';
import { BY_KEY, SETTINGS, checkTogether } from '../src/admin/configCatalog.js';
import { readEnvFile } from '../src/admin/envFile.js';
import { safeAsrStatus } from '../src/admin/asrStatusRoutes.js';
import * as adminRoutes from '../src/admin/adminRoutes.js';
import { asrSettingsFromEnv } from '../../gateway/src/asr/asrRouter.js';

const OPENROUTER_KEY = 'fixture-openrouter-one-key-for-speech-0001';
const CUSTOM_KEY = 'fixture-own-speech-server-key-0002';
const KEYS = [OPENROUTER_KEY, CUSTOM_KEY];
const launcherHelper = new URL('../../../scripts/console-settings-env.mjs', import.meta.url).pathname;
const TRANSCRIPTION_LIST = 'https://openrouter.ai/api/v1/models?output_modalities=transcription';

/** OpenRouter's speech-to-text list, shaped as it answers today (prices per second of audio). */
const speechModels = () => ({ data: [
  { id: 'nvidia/parakeet-tdt-0.6b-v3', name: 'NVIDIA: Parakeet TDT 0.6B v3', pricing: { prompt: '0.0000166667' } },
  { id: 'qwen/qwen3-asr-0.6b', name: 'Qwen: Qwen3 ASR 0.6B', pricing: { prompt: '0.00000333' } },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'OpenAI: GPT-4o mini Transcribe', pricing: { prompt: '0.00000125', completion: '0.000005' } },
  { id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large v3 Turbo', pricing: { prompt: '0.00000333' } },
  { id: 'microsoft/mai-transcribe-1.5', name: 'Microsoft: MAI Transcribe 1.5', pricing: { prompt: '0.36' } },
] });

const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server with a launcher running the voice gateway, and a fake network. */
function server(t, { envLines = [], network = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-asr-console-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, 'server.env');
  writeFileSync(envFile, `${envLines.join('\n')}\n`);
  const file = join(dir, 'config', 'console-settings.json');
  writeFileSync(join(dir, 'services.json'), JSON.stringify({ version: 1, services: {
    hub: { state: 'running', revision: 0 }, account: { state: 'running', revision: 0 },
  } }));
  const failures = [];
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), authorization: init.headers?.authorization ?? null, redirect: init.redirect });
    if (network) return network(String(url), init);
    if (String(url) === TRANSCRIPTION_LIST) return respond(speechModels());
    throw new TypeError('unreachable');
  };
  const routes = adminSettingsRoutes({ file: join(dir, 'store.json') }, {
    env: { PHOENIX_CONSOLE_SETTINGS_FILE: file, PHOENIX_ENV_FILE: envFile },
    requireAdmin: () => true, currentAccount: () => ({ email: 'admin@example.invalid' }),
    control: () => ({ available: true, dir, pid: 1 }),
    sendJson: (_res, status, body) => { failures.push({ status, body }); return undefined; },
    restart: () => assert.fail('nothing here restarts a service'),
    fetchImpl,
    modelListCache: new Map(),
  });
  const put = (changes) => routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes } });
  const view = () => routes['GET /api/admin/settings']({ req: {}, res: {} });
  const models = (key) => routes['GET /api/admin/settings/models']({ req: {}, res: {}, url: new URL(`http://x/api/admin/settings/models?key=${key}`) });
  /** What the voice gateway sees when the launcher starts it: the file, then console settings over it. */
  const launched = () => {
    const pairs = existsSync(file) ? execFileSync(process.execPath, [launcherHelper, file], { encoding: 'utf8' })
      .split('\0').filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]) : [];
    return { ...readEnvFile(envFile).values, ...Object.fromEntries(pairs) };
  };
  return { dir, file, put, view, models, launched, failures, requests };
}

test('the console offers OpenRouter and your own speech server, with the one OpenRouter key', (t) => {
  const provider = BY_KEY.get('PHOENIX_ASR_PROVIDER');
  assert.deepEqual(provider.options.map((o) => o.value), ['parakeet', 'auto', 'google', 'openrouter', 'custom']);
  assert.match(provider.help, /don’t support hints/, 'the choice says hints are not sent to these providers');
  for (const key of ['PHOENIX_ASR_FALLBACK_ORDER', 'PHOENIX_OPENROUTER_STT_MODEL', 'PHOENIX_OPENROUTER_STT_MONTHLY_USD',
    'PHOENIX_OPENROUTER_STT_DAILY_USD', 'PHOENIX_CUSTOM_STT_URL', 'PHOENIX_CUSTOM_STT_API_KEY', 'PHOENIX_CUSTOM_STT_MODEL',
    'PHOENIX_CUSTOM_STT_MONTHLY_MINUTES']) {
    const spec = BY_KEY.get(key);
    assert.ok(spec, `${key} is a setting`);
    assert.equal(spec.group, 'speech', `${key} is under Speech recognition`);
    assert.equal(spec.editable, true, `${key} can be changed in the console`);
    assert.deepEqual(spec.restart, ['hub'], `${key} applies when the voice gateway restarts`);
  }
  assert.equal(BY_KEY.get('PHOENIX_OPENROUTER_STT_MODEL').models, 'openrouter-transcription');
  assert.equal(BY_KEY.get('PHOENIX_OPENROUTER_STT_MODEL').default, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.equal(BY_KEY.get('PHOENIX_OPENROUTER_STT_MONTHLY_USD').default, '2', 'the gateway’s own default budget');
  assert.equal(BY_KEY.get('PHOENIX_CUSTOM_STT_API_KEY').type, 'secret');
  // The usage file is the server's, like Google's.
  assert.equal(BY_KEY.get('PHOENIX_OPENROUTER_STT_USAGE_FILE').editable, undefined);

  // No second OpenRouter key: speech recognition uses the one key, which now restarts the voice gateway too.
  const openRouterKeys = SETTINGS.filter((s) => s.type === 'secret' && s.editable && !s.replacedBy && /OPENROUTER/.test(s.key));
  assert.deepEqual(openRouterKeys.map((s) => s.key), ['OPENROUTER_API_KEY']);
  assert.ok(BY_KEY.get('OPENROUTER_API_KEY').restart.includes('hub'));
  assert.match(BY_KEY.get('OPENROUTER_API_KEY').help, /speech recognition/);
  const speechKeys = SETTINGS.filter((s) => s.group === 'speech' && s.type === 'secret').map((s) => s.key);
  assert.deepEqual(speechKeys, ['PHOENIX_CUSTOM_STT_API_KEY'], 'the only key under Speech recognition is your own server’s');

  const s = server(t);
  const shown = s.view().settings.filter((v) => v.group === 'speech').map((v) => v.key);
  assert.ok(shown.includes('PHOENIX_OPENROUTER_STT_MODEL') && shown.includes('PHOENIX_CUSTOM_STT_URL'));
});

test('saved speech settings reach the voice gateway when the launcher starts it', async (t) => {
  const s = server(t);
  const saved = await s.put({
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    PHOENIX_ASR_PROVIDER: 'openrouter',
    PHOENIX_OPENROUTER_STT_MODEL: 'qwen/qwen3-asr-0.6b',
    PHOENIX_OPENROUTER_STT_MONTHLY_USD: '5',
    PHOENIX_CUSTOM_STT_URL: 'http://192.0.2.30:8000',
    PHOENIX_CUSTOM_STT_API_KEY: CUSTOM_KEY,
    PHOENIX_CUSTOM_STT_MODEL: 'fixture/parakeet',
  });
  assert.equal(s.failures.length, 0, JSON.stringify(s.failures));
  assert.deepEqual(saved.restart, ['hub', 'account'], 'the voice gateway restarts to use them');
  assert.equal(saved.notices, undefined);

  const settings = asrSettingsFromEnv(s.launched());
  assert.equal(settings.mode, 'openrouter');
  assert.equal(settings.openrouter.model, 'qwen/qwen3-asr-0.6b');
  assert.equal(settings.openrouter.monthlyLimitMicroUsd, 5_000_000);
  assert.equal(settings.openrouter.dailyLimitMicroUsd, 500_000, 'one tenth of the month by default');
  assert.equal(settings.openrouter.apiKey(), OPENROUTER_KEY, 'OpenRouter speech uses the one key');
  assert.equal(settings.openrouter.configurationProblem, null);
  assert.equal(settings.custom.endpoint, 'http://192.0.2.30:8000/v1/audio/transcriptions');
  assert.equal(settings.custom.apiKey(), CUSTOM_KEY, 'your server gets its own key');
  assert.equal(settings.custom.model, 'fixture/parakeet');

  const fallback = await s.put({ PHOENIX_ASR_PROVIDER: 'auto', PHOENIX_ASR_FALLBACK_ORDER: 'custom,google' });
  assert.deepEqual(fallback.restart, ['hub']);
  const auto = asrSettingsFromEnv(s.launched());
  assert.equal(auto.mode, 'auto');
  assert.deepEqual(auto.fallbackOrder, ['custom', 'google']);
  assert.equal(auto.fallbackOrderProblem, null, 'every offered order is one the voice gateway accepts');
  for (const option of BY_KEY.get('PHOENIX_ASR_FALLBACK_ORDER').options) {
    assert.equal(asrSettingsFromEnv({ PHOENIX_ASR_FALLBACK_ORDER: option.value }).fallbackOrderProblem, null, option.value);
  }

  const off = await s.put({ PHOENIX_OPENROUTER_STT_MONTHLY_USD: '0' });
  assert.equal(asrSettingsFromEnv(s.launched()).openrouter.monthlyLimitMicroUsd, 0, 'a budget of 0 turns it off');
  assert.ok(off.saved.includes('PHOENIX_OPENROUTER_STT_MONTHLY_USD'));

  for (const text of [JSON.stringify(s.view()), readFileSync(s.file, 'utf8').replace(/"value":\s*"fixture-[^"]*"/g, '')]) {
    for (const key of KEYS) assert.ok(!text.includes(key), 'no key in the view or the history');
  }
});

test('the OpenRouter speech model is checked against OpenRouter’s list when it is saved', async (t) => {
  const s = server(t);
  // Not a speech model, a typo, and one dearer than the budget can hold back for.
  for (const [model, message] of [['deepseek/deepseek-v4.1-flash', /isn’t one of OpenRouter’s speech-to-text models/],
    ['nvidia/parakeet-tdt-0.6b-v4', /isn’t one of OpenRouter’s speech-to-text models/],
    ['microsoft/mai-transcribe-1.5', /costs about \$1,296 per hour of audio, more than the \$1 per hour/]]) {
    const before = existsSync(s.file) ? readFileSync(s.file, 'utf8') : null;
    const refused = await s.put({ PHOENIX_OPENROUTER_STT_MODEL: model, PHOENIX_ASR_PROVIDER: 'openrouter' });
    assert.equal(refused, undefined);
    assert.equal(s.failures.at(-1).status, 400, model);
    assert.match(s.failures.at(-1).body.errors.PHOENIX_OPENROUTER_STT_MODEL, message);
    assert.equal(s.failures.at(-1).body.errors.PHOENIX_ASR_PROVIDER, undefined);
    assert.equal(existsSync(s.file) ? readFileSync(s.file, 'utf8') : null, before, 'all or nothing: nothing was saved');
  }
  const accepted = await s.put({ PHOENIX_OPENROUTER_STT_MODEL: 'openai/gpt-4o-mini-transcribe' });
  assert.deepEqual(accepted.saved, ['PHOENIX_OPENROUTER_STT_MODEL'], 'a listed, token-priced model is accepted');
  const whisper = await s.put({ PHOENIX_OPENROUTER_STT_MODEL: 'openai/whisper-large-v3-turbo' });
  assert.match(whisper.warnings.find((w) => w.key === 'PHOENIX_OPENROUTER_STT_MODEL').message, /at least 10 seconds/);

  // OpenRouter is asked for its speech-to-text list, without any key, never following a redirect.
  assert.ok(s.requests.length >= 1);
  for (const request of s.requests) {
    assert.equal(request.url, TRANSCRIPTION_LIST);
    assert.equal(request.authorization, null);
    assert.equal(request.redirect, 'error');
  }

  // Removing the choice needs no check.
  const count = s.requests.length;
  const reset = await s.put({ PHOENIX_OPENROUTER_STT_MODEL: null });
  assert.deepEqual(reset.saved, ['PHOENIX_OPENROUTER_STT_MODEL']);
  assert.equal(s.requests.length, count);
});

test('when OpenRouter’s list can’t be had, the model is saved as typed and the answer says so', async (t) => {
  for (const network of [async () => { throw new TypeError('unreachable'); }, async () => respond({ error: 'busy' }, 503)]) {
    const s = server(t, { network });
    const saved = await s.put({ PHOENIX_OPENROUTER_STT_MODEL: 'vendor/new-speech-model' });
    assert.deepEqual(saved.saved, ['PHOENIX_OPENROUTER_STT_MODEL']);
    assert.equal(saved.notices.length, 1);
    assert.equal(saved.notices[0].key, 'PHOENIX_OPENROUTER_STT_MODEL');
    assert.match(saved.notices[0].message, /couldn’t be checked just now, so the model was saved as typed/);
    assert.equal(asrSettingsFromEnv(s.launched()).openrouter.model, 'vendor/new-speech-model');
    // The picker says the list is unavailable, so the console asks for the name by hand.
    const listed = await s.models('PHOENIX_OPENROUTER_STT_MODEL');
    assert.equal(listed.available, false);
  }
});

test('model pickers list OpenRouter’s speech models with prices, and your server’s with its own key only', async (t) => {
  const s = server(t, {
    envLines: [`OPENROUTER_API_KEY=${OPENROUTER_KEY}`],
    network: async (url) => {
      if (url === TRANSCRIPTION_LIST) return respond(speechModels());
      if (url === 'http://192.0.2.30:8000/v1/models') return respond({ object: 'list', data: [{ id: 'fixture/parakeet', object: 'model' }] });
      throw new TypeError('unreachable');
    },
  });
  const empty = await s.models('PHOENIX_CUSTOM_STT_MODEL');
  assert.deepEqual(empty, { available: false, message: 'Set your speech server’s address first, then its models are listed here.' });

  const openrouter = await s.models('PHOENIX_OPENROUTER_STT_MODEL');
  assert.equal(openrouter.available, true);
  assert.equal(openrouter.endpoint, 'https://openrouter.ai/api/v1');
  const parakeet = openrouter.models.find((m) => m.id === 'nvidia/parakeet-tdt-0.6b-v3');
  assert.deepEqual(parakeet, { id: 'nvidia/parakeet-tdt-0.6b-v3', name: 'NVIDIA: Parakeet TDT 0.6B v3', free: false, usdPerHour: 0.06 });
  assert.equal(openrouter.models.find((m) => m.id === 'openai/gpt-4o-mini-transcribe').usdPerHour, undefined,
    'a model priced by tokens has no per-hour price to show');

  await s.put({ PHOENIX_CUSTOM_STT_URL: 'http://192.0.2.30:8000/v1/audio/transcriptions', PHOENIX_CUSTOM_STT_API_KEY: CUSTOM_KEY });
  const own = await s.models('PHOENIX_CUSTOM_STT_MODEL');
  assert.equal(own.available, true);
  assert.equal(own.endpoint, 'http://192.0.2.30:8000/v1');
  assert.deepEqual(own.models.map((m) => m.id), ['fixture/parakeet']);

  assert.deepEqual(s.requests.map((r) => [r.url, r.authorization]), [
    [TRANSCRIPTION_LIST, null],
    ['http://192.0.2.30:8000/v1/models', `Bearer ${CUSTOM_KEY}`],
  ], 'the OpenRouter key never leaves for a model list; your server’s key goes only to your server');
  for (const result of [openrouter, own]) for (const key of KEYS) assert.ok(!JSON.stringify(result).includes(key));
});

test('settings that only fail together: OpenRouter as your own server, a missing key or address', async (t) => {
  const s = server(t);
  await s.put({ PHOENIX_CUSTOM_STT_URL: 'https://openrouter.ai/api/v1' });
  assert.equal(s.failures.at(-1).status, 400);
  assert.match(s.failures.at(-1).body.errors.PHOENIX_CUSTOM_STT_URL, /is OpenRouter, which has its own choice/);
  assert.equal(existsSync(s.file), false, 'nothing saved');

  const message = (values, key) => checkTogether(values).warnings.find((w) => w.key === key)?.message;
  assert.match(message({ PHOENIX_ASR_PROVIDER: 'openrouter' }, 'OPENROUTER_API_KEY'),
    /Speech recognition through OpenRouter is on but there is no OpenRouter key/);
  assert.equal(message({ PHOENIX_ASR_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'x' }, 'OPENROUTER_API_KEY'), undefined);
  assert.equal(message({ PHOENIX_ASR_PROVIDER: 'openrouter', ETCO_parser_decisionApiKey: 'x' }, 'OPENROUTER_API_KEY')
    ?.includes('Speech recognition'), true, 'an older per-feature key doesn’t reach speech recognition');
  assert.equal(message({ PHOENIX_ASR_PROVIDER: 'auto' }, 'OPENROUTER_API_KEY'), undefined,
    'automatic mode skips a fallback nobody set up, so it isn’t worth a warning');
  assert.match(message({ PHOENIX_ASR_PROVIDER: 'auto', PHOENIX_ASR_FALLBACK_ORDER: 'openrouter' }, 'OPENROUTER_API_KEY'), /Speech recognition/);
  assert.match(message({ PHOENIX_ASR_PROVIDER: 'custom' }, 'PHOENIX_CUSTOM_STT_URL'), /its address isn’t set/);
  assert.match(message({ PHOENIX_ASR_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'x', PHOENIX_OPENROUTER_STT_MONTHLY_USD: '0' },
    'PHOENIX_OPENROUTER_STT_MONTHLY_USD'), /budget is zero/);
  // Google's warnings only where Google would be used; automatic mode keeps them as before.
  assert.equal(message({ PHOENIX_ASR_PROVIDER: 'openrouter' }, 'PHOENIX_ASR_PROVIDER'), undefined);
  assert.match(message({ PHOENIX_ASR_PROVIDER: 'auto' }, 'PHOENIX_ASR_PROVIDER'), /Google needs a Cloud project/);
  assert.equal(message({ PHOENIX_ASR_PROVIDER: 'auto', PHOENIX_ASR_FALLBACK_ORDER: 'custom' }, 'PHOENIX_ASR_PROVIDER'), undefined);
});

test('the missing-key warning for OpenRouter speech reads the shared endpoint as the voice gateway does', () => {
  // The services read PHOENIX_LLM_URL before LLM_URL to decide whose key PHOENIX_LLM_API_KEY is.
  const warned = (values) => (checkTogether(values).warnings.find((w) => w.key === 'OPENROUTER_API_KEY')?.message || '')
    .includes('Speech recognition');
  const gatewayHasKey = (values) => !!asrSettingsFromEnv(values).openrouter.apiKey();
  const sharedKey = 'fixture-shared-endpoint-key-0003';
  const customFirst = { PHOENIX_ASR_PROVIDER: 'openrouter', PHOENIX_LLM_API_KEY: sharedKey,
    PHOENIX_LLM_URL: 'http://localhost:1234/v1', LLM_URL: 'https://openrouter.ai/api/v1' };
  assert.equal(gatewayHasKey(customFirst), false, 'the custom endpoint’s key never reaches OpenRouter');
  assert.equal(warned(customFirst), true, 'so the console says speech recognition has no key');
  const openRouterShared = { PHOENIX_ASR_PROVIDER: 'openrouter', PHOENIX_LLM_API_KEY: sharedKey,
    PHOENIX_LLM_URL: 'https://openrouter.ai/api/v1' };
  assert.equal(gatewayHasKey(openRouterShared), true, 'an older server’s OpenRouter endpoint key still works');
  assert.equal(warned(openRouterShared), false, 'so the console doesn’t warn');
});

/** A voice gateway's status in OpenRouter mode, with things the console must never show. */
const openRouterStatus = (overrides = {}) => ({
  mode: 'openrouter', parakeet: null, transcript: 'hidden words',
  google: { configured: false, unavailable: 'not-configured', model: 'chirp_3', location: 'us', activeStreams: 0, lastFailure: null, usage: null },
  fallbackOrder: null, fallbackOrderProblem: null,
  openrouter: {
    configured: true, unavailable: null, model: 'nvidia/parakeet-tdt-0.6b-v3', language: 'en', endpoint: 'https://hidden.invalid/x',
    apiKey: OPENROUTER_KEY, lastFailure: { kind: 'rate-limited', at: 10, until: 20, message: 'hidden error' },
    usage: { month: '2026-11', day: '2026-11-12', usedMicroUsd: 73_000, limitMicroUsd: 2_000_000, dayUsedMicroUsd: 4_000,
      dayLimitMicroUsd: 200_000, usedSeconds: 4380, limitSeconds: 0, requests: 1100, reservedMicroUsd: 0, exhausted: null,
      problem: null, file: '/hidden/usage.json' },
  },
  custom: { configured: false, unavailable: null, model: null, language: 'en', lastFailure: null, usage: null },
  ...overrides,
});

test('the status page shows OpenRouter as the recognizer in use, and its cost this month and today', () => {
  const safe = safeAsrStatus(openRouterStatus());
  assert.equal(safe.mode, 'openrouter', 'OpenRouter mode is reported, not dropped as unknown');
  assert.equal(safe.openrouter.model, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.deepEqual(safe.openrouter.usage, { month: '2026-11', day: '2026-11-12', usedMicroUsd: 73_000, limitMicroUsd: 2_000_000,
    dayUsedMicroUsd: 4_000, dayLimitMicroUsd: 200_000, usedSeconds: 4380, limitSeconds: 0, requests: 1100, reservedMicroUsd: 0,
    exhausted: null, problem: null });
  assert.deepEqual(safe.openrouter.lastFailure, { kind: 'rate-limited', at: 10, until: 20 });
  const text = JSON.stringify(safe);
  for (const hidden of ['hidden', OPENROUTER_KEY]) assert.ok(!text.includes(hidden), `${hidden} never reaches the console`);
  assert.equal(safeAsrStatus({ ...openRouterStatus(), mode: 'custom' }).mode, 'custom');

  // Hostile values are dropped one by one.
  const hostile = safeAsrStatus(openRouterStatus({ fallbackOrder: ['google', 'http://hidden.invalid', 'openrouter'],
    custom: { configured: true, unavailable: 'hidden reason', model: 'https://hidden.invalid/model', language: 'hidden language',
      usage: { usedMicroUsd: -1, requests: Infinity, problem: 'hidden', exhausted: 'hidden' } } }));
  assert.deepEqual(hostile.fallbackOrder, ['google', 'openrouter']);
  assert.deepEqual([hostile.custom.unavailable, hostile.custom.model, hostile.custom.language], [null, null, null]);
  assert.deepEqual([hostile.custom.usage.usedMicroUsd, hostile.custom.usage.requests, hostile.custom.usage.problem,
    hostile.custom.usage.exhausted], [null, null, null, null]);

  // An older voice gateway's status keeps exactly its old shape.
  assert.deepEqual(Object.keys(safeAsrStatus({ mode: 'auto', parakeet: null, google: null })), ['mode', 'parakeet', 'google']);
});

test('the overview says when OpenRouter or your server is off, and stays quiet about Google it doesn’t use', () => {
  const base = { status: { services: [] }, control: { available: true }, settingsError: null, pendingByService: {},
    effective: { PARAKEET_URL: 'http://192.0.2.2:6972', ETCO_account_mailSmtpHost: 'smtp.example.invalid', TOMTOM_API_KEY: 'x',
      ETCO_gqa_wolframKey: 'x' }, adminCount: 2, disk: null, serverFile: {}, launcherStartedAt: null };
  const titles = (asr, effective = {}) => adminRoutes.attentionItems({ ...base, effective: { ...base.effective, ...effective }, asr })
    .map((item) => `${item.level}: ${item.title}${item.body ? ` — ${item.body}` : ''}`);

  assert.deepEqual(titles(openRouterStatus()), [], 'OpenRouter in use and working: nothing to say, nothing about Google');
  assert.deepEqual(titles(openRouterStatus({ openrouter: { ...openRouterStatus().openrouter, unavailable: 'usage-file-missing' } })), [
    'error: OpenRouter speech recognition is off, so Jibo can’t understand anyone — Its usage file hasn’t been created on the server '
      + 'yet, so its spending can’t be counted. Create it once with scripts/init-openai-stt-usage.mjs.',
  ]);
  assert.deepEqual(titles(openRouterStatus({ openrouter: { ...openRouterStatus().openrouter,
    usage: { ...openRouterStatus().openrouter.usage, exhausted: 'month' } } })), [
    'error: OpenRouter speech recognition has reached its limit — It starts again next month (UTC).',
  ]);
  // Without a Parakeet address, OpenRouter mode still understands people.
  assert.deepEqual(titles(openRouterStatus(), { PARAKEET_URL: '', PHOENIX_ASR_PROVIDER: 'openrouter' }), []);

  // Automatic mode: a fallback nobody set up is skipped quietly; one never started is worth knowing.
  const auto = (openrouter) => openRouterStatus({ mode: 'auto', parakeet: { state: 'up' }, fallbackOrder: ['openrouter'],
    openrouter: { ...openRouterStatus().openrouter, ...openrouter } });
  assert.deepEqual(titles(auto({ unavailable: 'no-key', configured: false })), []);
  assert.deepEqual(titles(auto({ unavailable: 'usage-file-missing' })).map((t) => t.split(' — ')[0]),
    ['info: OpenRouter speech recognition is off']);
  assert.deepEqual(titles(auto({ unavailable: 'credentials' })).map((t) => t.split(' — ')[0]),
    ['warn: OpenRouter speech recognition is off']);
  assert.deepEqual(titles(openRouterStatus({ mode: 'custom', custom: { configured: false, unavailable: 'no-url' } }), { PHOENIX_ASR_PROVIDER: 'custom' }), [
    'error: Your speech server is off, so Jibo can’t understand anyone — Its address isn’t set.',
  ]);

  // Google is reported where it is used, including by an older voice gateway in automatic mode.
  const googleDown = { configured: false, unavailable: 'not-configured', usage: null };
  assert.equal(titles({ mode: 'auto', parakeet: null, google: googleDown }).length, 1);
  assert.equal(titles({ mode: 'auto', parakeet: null, google: googleDown, fallbackOrder: ['openrouter'], openrouter: null }).length, 0);
  assert.equal(titles({ mode: 'google', parakeet: null, google: googleDown }).length, 1);
});
