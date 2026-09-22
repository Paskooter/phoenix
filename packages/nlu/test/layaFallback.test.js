import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLayaClient,
  envLayaConfig,
  LAYA_ENTITYLESS_INTENTS,
} from '../src/layaFallback.js';

function response(status, body) {
  return { status, json: async () => body };
}

test('Laya fallback is disabled without an explicit private URL and token', async () => {
  let called = false;
  const client = createLayaClient({
    enabled: false,
    fetch: async () => { called = true; return response(200, {}); },
  });
  assert.equal(await client.handleNLU({ text: 'make it brighter', rules: ['launch'] }), null);
  assert.equal(called, false);
});

test('Laya fallback accepts only a validated entityless leaf result', async () => {
  let request;
  const client = createLayaClient({
    enabled: true,
    url: 'http://192.168.1.252:6973',
    token: 'test-token',
    minConfidence: 0.85,
    fetch: async (url, init) => {
      request = { url, init };
      return response(200, {
        intent: 'lightsUp', unknown: false, confidence: 0.91,
        profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'],
      });
    },
  });
  assert.deepEqual(await client.handleNLU({ text: 'make it brighter', rules: ['launch'] }), {
    intent: 'lightsUp', entities: {}, rules: ['launch'],
  });
  assert.equal(request.url, 'http://192.168.1.252:6973/v1/classify');
  assert.equal(request.init.headers.authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.init.body), { text: 'make it brighter', profile: 'phoenix-core' });
});

test('Laya fallback rejects entity-bearing, unknown, stale, and low-confidence results', async () => {
  const badResults = [
    { intent: 'lightsOn', unknown: false, confidence: 0.99, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'lightsUp', unknown: true, confidence: 0.99, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'lightsUp', unknown: false, confidence: 0.7, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'lightsUp', unknown: false, confidence: 0.99, profile: 'phoenix-core', route: ['phoenix-core'] },
  ];
  for (const body of badResults) {
    const client = createLayaClient({
      enabled: true, url: 'http://private', token: 'test-token', minConfidence: 0.85,
      fetch: async () => response(200, body),
    });
    assert.equal(await client.handleNLU({ text: 'anything' }), null);
  }
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('lightsOn'), false);
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('lightsUp'), true);
});

test('Laya environment configuration requires every explicit enablement component', () => {
  const prior = {
    enabled: process.env.ETCO_parser_layaEnabled,
    url: process.env.ETCO_parser_layaUrl,
    token: process.env.ETCO_parser_layaToken,
    timeout: process.env.ETCO_parser_layaTimeoutMs,
  };
  try {
    process.env.ETCO_parser_layaEnabled = 'true';
    delete process.env.ETCO_parser_layaUrl;
    delete process.env.ETCO_parser_layaToken;
    assert.equal(envLayaConfig().enabled, false);
    process.env.ETCO_parser_layaUrl = 'http://192.168.1.252:6973/';
    process.env.ETCO_parser_layaToken = 'secret';
    process.env.ETCO_parser_layaTimeoutMs = '99999';
    const config = envLayaConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.url, 'http://192.168.1.252:6973');
    assert.equal(config.timeoutMs, 700);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      const envKey = `ETCO_parser_laya${key === 'enabled' ? 'Enabled' : key === 'url' ? 'Url' : key === 'token' ? 'Token' : 'TimeoutMs'}`;
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
