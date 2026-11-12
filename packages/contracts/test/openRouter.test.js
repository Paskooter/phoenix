// The one OpenRouter key: who gets it, and who never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenRouterUrl, openRouterKey, resolveLlmProvider } from '../src/index.js';

test('only an https openrouter.ai URL is OpenRouter', () => {
  assert.equal(isOpenRouterUrl('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouterUrl('https://www.openrouter.ai/api/v1'), true);
  for (const url of ['http://openrouter.ai/api/v1', 'https://openrouter.ai.example.invalid/v1', 'https://example.invalid/openrouter.ai', '', 'not a url', undefined]) {
    assert.equal(isOpenRouterUrl(url), false, String(url));
  }
});

test('the one key comes first, then each feature’s older key', () => {
  assert.equal(openRouterKey({ OPENROUTER_API_KEY: ' one ', OLD: 'old' }, 'OLD'), 'one');
  assert.equal(openRouterKey({ OPENROUTER_API_KEY: '  ', OLD: 'old' }, 'OLD'), 'old');
  assert.equal(openRouterKey({}, 'OLD'), '');
});

test('the OpenRouter key goes to OpenRouter endpoints and never to a custom one', () => {
  const env = { OPENROUTER_API_KEY: 'fixture-one-key', PHOENIX_LLM_API_KEY: 'fixture-custom-key' };
  assert.equal(resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: 'https://openrouter.ai/api/v1' } }).apiKey, 'fixture-one-key');
  assert.equal(resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: 'http://192.0.2.1:1234/v1' } }).apiKey, 'fixture-custom-key');
  assert.equal(resolveLlmProvider('answer', { env: { OPENROUTER_API_KEY: 'fixture-one-key', ETCO_answer_llmUrl: 'http://192.0.2.1:1234/v1' } }).apiKey, '');
  assert.equal(resolveLlmProvider('answer', { env: { PHOENIX_LLM_API_KEY: 'fixture-custom-key', ETCO_answer_llmUrl: 'https://openrouter.ai/api/v1' } }).apiKey,
    'fixture-custom-key', 'an older shared key used with OpenRouter keeps working until the one key is set');
});
