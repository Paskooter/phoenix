// The one OpenRouter key: who gets it, and who never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenRouterHost, isOpenRouterUrl, openRouterKey, resolveLlmProvider, sharedKeyForOpenRouter } from '../src/index.js';

test('only an https openrouter.ai URL is OpenRouter', () => {
  assert.equal(isOpenRouterUrl('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouterUrl('https://www.openrouter.ai/api/v1'), true);
  for (const url of ['http://openrouter.ai/api/v1', 'https://openrouter.ai.example.invalid/v1', 'https://example.invalid/openrouter.ai', '', 'not a url', undefined]) {
    assert.equal(isOpenRouterUrl(url), false, String(url));
  }
});

// The same host written with a trailing dot (a fully qualified name), in mixed
// case or with a port is still openrouter.ai, so it must never get a custom
// endpoint's key.
const OPENROUTER_HOST_SPELLINGS = Object.freeze([
  'http://openrouter.ai./api/v1',
  'https://openrouter.ai./api/v1',
  'http://OpenRouter.AI./api/v1',
  'http://openrouter.ai.:80/api/v1',
  'https://OPENROUTER.ai.:443/api/v1',
  'http://www.openrouter.ai.:8080/api/v1',
  'https://WWW.OpenRouter.AI.:8443/api/v1',
  'HTTP://WWW.OpenRouter.Ai./api/alpha/decisions',
]);

test('any spelling of the openrouter.ai host is OpenRouter’s host', () => {
  for (const url of ['https://openrouter.ai/api/v1', 'http://openrouter.ai/api/v1', 'http://www.openrouter.ai/v1', ...OPENROUTER_HOST_SPELLINGS]) {
    assert.equal(isOpenRouterHost(url), true, url);
  }
  for (const url of ['http://openrouter.ai.example.invalid/v1', 'http://example.invalid/openrouter.ai.', 'http://notopenrouter.ai./v1',
    'http://sub.openrouter.ai./v1', 'https://openrouter.ai.@example.invalid/v1',
    'http://192.0.2.1:1234/v1', '', 'not a url', undefined]) {
    assert.equal(isOpenRouterHost(url), false, String(url));
  }
});

test('a trailing-dot host does not widen the OpenRouter credential-send allowlist', () => {
  for (const url of OPENROUTER_HOST_SPELLINGS) {
    assert.equal(isOpenRouterUrl(url), false, url);
    assert.equal(sharedKeyForOpenRouter({ PHOENIX_LLM_URL: url, PHOENIX_LLM_API_KEY: 'fixture-custom-key' }), '', url);
    assert.equal(sharedKeyForOpenRouter({ LLM_URL: url, PHOENIX_LLM_API_KEY: 'fixture-custom-key' }), '', url);
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
  assert.equal(resolveLlmProvider('answer', { env: { PHOENIX_LLM_API_KEY: 'fixture-custom-key', PHOENIX_LLM_URL: 'https://openrouter.ai/api/v1' } }).apiKey,
    'fixture-custom-key', 'an older shared key used with an OpenRouter endpoint keeps working until the one key is set');
});

test('no key, neither the one key nor a custom one, goes to a trailing-dot openrouter.ai address', () => {
  const env = { OPENROUTER_API_KEY: 'fixture-one-key', PHOENIX_LLM_API_KEY: 'fixture-custom-key', ETCO_answer_llmApiKey: 'fixture-scoped-key' };
  for (const url of OPENROUTER_HOST_SPELLINGS) {
    assert.equal(resolveLlmProvider('answer', { env: { ...env, ETCO_answer_llmUrl: url } }).apiKey, '', url);
    assert.equal(resolveLlmProvider('answer', { env: { PHOENIX_LLM_API_KEY: 'fixture-custom-key', PHOENIX_LLM_URL: url } }).apiKey, '', url);
  }
});
