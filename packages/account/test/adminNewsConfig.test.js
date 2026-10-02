import test from 'node:test';
import assert from 'node:assert/strict';
import { BY_KEY, validate, servicesFor, checkTogether } from '../src/admin/configCatalog.js';

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
