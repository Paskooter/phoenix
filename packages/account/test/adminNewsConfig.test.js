import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { adminSettingsRoutes } from '../src/admin/settingsRoutes.js';
import { BY_KEY, validate, servicesFor, checkTogether, isSecret, isEditable } from '../src/admin/configCatalog.js';
import { newsBriefingConfig } from '../../data/src/newsBriefings/config.js';

test('news credentials are secret and settings restart their consuming services', () => {
  assert.equal(BY_KEY.get('WORLD_NEWS_API_KEY').type, 'secret');
  assert.equal(BY_KEY.get('ETCO_news_llmApiKey').type, 'secret');
  assert.deepEqual(new Set(servicesFor(['PHOENIX_NEWS_BRIEFINGS_ENABLED'])), new Set(['lasso', 'report-skill']));
  assert.deepEqual(servicesFor(['WORLD_NEWS_API_KEY']), ['lasso']);
  assert.ok(servicesFor(['ETCO_parser_decisionApiKey']).includes('lasso'));
  assert.ok(servicesFor(['PHOENIX_LLM_API_KEY']).includes('lasso'));
  assert.ok(validate('PHOENIX_NEWS_REFRESH_HOURS', '1'));
  assert.ok(!validate('PHOENIX_NEWS_DAILY_LLM_USD', '0.15'));
  const check = checkTogether({ PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true' });
  assert.deepEqual(check.errors, {});
  assert.ok(check.warnings.some(w => w.key === 'WORLD_NEWS_API_KEY'));
});

test('Personal report exposes an editable secret LumenFeed key and an explicit provider choice', () => {
  const key = BY_KEY.get('LUMENFEED_API_KEY');
  assert.equal(key?.group, 'report');
  assert.equal(key.type, 'secret');
  assert.ok(isSecret(key.key));
  assert.ok(isEditable(key.key));
  assert.equal(key.advanced, undefined, 'the owner should not need More settings');
  assert.deepEqual(servicesFor([key.key]), ['lasso']);
  const provider = BY_KEY.get('PHOENIX_NEWS_PROVIDER');
  assert.equal(provider?.group, 'report');
  assert.equal(provider.type, 'enum');
  assert.equal(provider.default, null, 'an unset setting must preserve automatic key-based selection');
  assert.ok(isEditable(provider.key));
  assert.deepEqual(servicesFor([provider.key]), ['lasso']);
  assert.deepEqual(provider.options.map(option => option.value), ['curated', 'worldnews', 'lumenfeed']);
  for (const value of ['', 'curated', 'worldnews', 'lumenfeed']) assert.equal(validate(provider.key, value), null);
  assert.ok(validate(provider.key, 'unknown'));
  assert.ok(validate(key.key, 'fixture\nkey'));
});

test('news-key warnings follow the same explicit or automatic provider choice as the worker', () => {
  const cases = [
    [{}, 'WORLD_NEWS_API_KEY'],
    [{ LUMENFEED_API_KEY: 'fixture-lumen' }, null],
    [{ WORLD_NEWS_API_KEY: 'fixture-world' }, null],
    [{ PHOENIX_NEWS_PROVIDER: 'lumenfeed', WORLD_NEWS_API_KEY: 'fixture-world' }, 'LUMENFEED_API_KEY'],
    [{ PHOENIX_NEWS_PROVIDER: 'worldnews', LUMENFEED_API_KEY: 'fixture-lumen' }, 'WORLD_NEWS_API_KEY'],
    [{ PHOENIX_NEWS_PROVIDER: 'lumenfeed', LUMENFEED_API_KEY: 'fixture-lumen' }, null],
    [{ PHOENIX_NEWS_PROVIDER: 'worldnews', WORLD_NEWS_API_KEY: 'fixture-world', LUMENFEED_API_KEY: 'fixture-lumen' }, null],
  ];
  for (const [keys, expected] of cases) {
    const values = { PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', ...keys };
    const result = checkTogether(values);
    assert.deepEqual(result.errors, {});
    const warnings = result.warnings.filter(w => ['WORLD_NEWS_API_KEY', 'LUMENFEED_API_KEY'].includes(w.key));
    assert.deepEqual(warnings.map(w => w.key), expected ? [expected] : [], JSON.stringify(Object.keys(keys)));
    if (expected) {
      assert.equal(newsBriefingConfig(values).apiKey, '');
      assert.doesNotMatch(warnings[0].message, /basic feed|RSS/i, 'briefing mode skips unavailable categories rather than substituting worldwide RSS');
    }
  }
  assert.deepEqual(checkTogether({ PHOENIX_NEWS_BRIEFINGS_ENABLED: 'false', PHOENIX_NEWS_PROVIDER: 'lumenfeed' }).warnings, []);
});

test('curated console choice saves, reloads and reaches the launcher without a news-provider key warning', t => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-curated-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  const serverFile = join(directory, 'server.env');
  writeFileSync(serverFile, '');
  writeFileSync(join(directory, 'services.json'), JSON.stringify({ version: 1,
    services: { lasso: { state: 'running', revision: 0 }, 'report-skill': { state: 'running', revision: 0 } },
  }));
  const options = {
    env: { PHOENIX_CONSOLE_SETTINGS_FILE: file, PHOENIX_ENV_FILE: serverFile },
    requireAdmin: () => true, currentAccount: () => null,
    control: () => ({ available: true, dir: directory, pid: 1 }),
    sendJson: (_res, status, body) => assert.fail(`Unexpected ${status}: ${JSON.stringify(body)}`),
    restart: () => assert.fail('saving settings must not restart a service'),
  };
  const routes = adminSettingsRoutes({ file: join(directory, 'store.json') }, options);
  const result = routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: {
    PHOENIX_NEWS_PROVIDER: 'curated', PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true',
  } } });
  assert.deepEqual(new Set(result.restart), new Set(['lasso', 'report-skill']));
  const reloaded = adminSettingsRoutes({ file: join(directory, 'store.json') }, options);
  const view = reloaded['GET /api/admin/settings']({ req: {}, res: {} });
  assert.equal(view.settings.find(s => s.key === 'PHOENIX_NEWS_PROVIDER').value, 'curated');
  assert.ok(!view.warnings.some(w => ['WORLD_NEWS_API_KEY', 'LUMENFEED_API_KEY'].includes(w.key)));
  const exported = execFileSync(process.execPath, [new URL('../../../scripts/console-settings-env.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
  const values = Object.fromEntries(exported.split('\0').filter(Boolean).map(pair => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
  assert.equal(newsBriefingConfig(values).provider, 'curated');
  assert.equal(newsBriefingConfig(values).apiKey, '');
  assert.equal(newsBriefingConfig(values).fallbackProvider, null, 'curated never silently spends on a paid publisher API');
});

test('console save and readback keep the key private and the real launcher export selects LumenFeed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-news-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'console-settings.json');
  const serverFile = join(directory, 'server.env');
  writeFileSync(serverFile, 'WORLD_NEWS_API_KEY=fixture-world-key\n');
  writeFileSync(join(directory, 'services.json'), JSON.stringify({ version: 1,
    services: { lasso: { state: 'running', revision: 0 }, 'report-skill': { state: 'running', revision: 0 } },
  }));
  const env = { PHOENIX_CONSOLE_SETTINGS_FILE: file, PHOENIX_ENV_FILE: serverFile };
  const routes = adminSettingsRoutes({ file: join(directory, 'store.json') }, {
    env, requireAdmin: () => true, currentAccount: () => null,
    control: () => ({ available: true, dir: directory, pid: 1 }),
    sendJson: (_res, status, body) => assert.fail(`Unexpected ${status}: ${JSON.stringify(body)}`),
    restart: () => assert.fail('saving settings must not restart a real service'),
  });
  const key = 'fixture-lumen-account-key-0001';
  const saved = routes['PUT /api/admin/settings']({ req: {}, res: {}, body: { changes: {
    LUMENFEED_API_KEY: key, PHOENIX_NEWS_PROVIDER: 'lumenfeed', PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true',
  } } });
  assert.deepEqual(new Set(saved.restart), new Set(['lasso', 'report-skill']));
  const view = routes['GET /api/admin/settings']({ req: {}, res: {} });
  assert.equal(view.revision, 1);
  assert.ok(!JSON.stringify(view).includes(key));
  const secret = view.settings.find(s => s.key === 'LUMENFEED_API_KEY');
  assert.equal(secret.value, null);
  assert.equal(secret.isSet, true);
  assert.equal(secret.hint, '0001');
  assert.deepEqual(secret.pending, ['lasso']);
  assert.equal(view.settings.find(s => s.key === 'PHOENIX_NEWS_PROVIDER').value, 'lumenfeed');
  assert.ok(!JSON.stringify(view.history).includes(key));
  assert.ok(!view.warnings.some(w => ['WORLD_NEWS_API_KEY', 'LUMENFEED_API_KEY'].includes(w.key)));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(serverFile, 'utf8'), 'WORLD_NEWS_API_KEY=fixture-world-key\n');
  const exported = execFileSync(process.execPath, [new URL('../../../scripts/console-settings-env.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
  const values = Object.fromEntries(exported.split('\0').filter(Boolean).map(pair => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
  assert.equal(values.LUMENFEED_API_KEY, key);
  assert.equal(newsBriefingConfig(values).provider, 'lumenfeed');
  assert.equal(newsBriefingConfig(values).apiKey, key);
});
