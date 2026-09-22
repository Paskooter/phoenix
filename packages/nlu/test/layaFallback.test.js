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

test('Laya fallback uses candidate probability and accepts only a validated leaf result', async () => {
  let request;
  const client = createLayaClient({
    enabled: true,
    url: 'http://192.168.1.252:6973',
    token: 'test-token',
    minConfidence: 0.45,
    fetch: async (url, init) => {
      request = { url, init };
      return response(200, {
        intent: 'galleryOpen', unknown: false, confidence: 0.12,
        top_probability: 0.91,
        margin: 0.88,
        probabilities: { unknown: 0.03, galleryOpen: 0.91 },
        profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'],
      });
    },
  });
  assert.deepEqual(await client.handleNLU({ text: 'open the gallery', rules: ['launch'] }), {
    intent: 'galleryOpen', entities: {}, rules: ['launch'],
  });
  assert.equal(request.url, 'http://192.168.1.252:6973/v1/classify');
  assert.equal(request.init.headers.authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.init.body), { text: 'open the gallery', profile: 'phoenix-core' });
});

test('Laya fallback rejects entity-bearing, unknown, stale, and low-probability results', async () => {
  const badResults = [
    { intent: 'lightsUp', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { lightsUp: 0.99, unknown: 0.01 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'lightsDown', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { lightsDown: 0.99, unknown: 0.01 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'requestNews', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { requestNews: 0.99, unknown: 0.01 }, profile: 'phoenix-information', route: ['phoenix-core', 'phoenix-information'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { galleryOpen: 0.99, unknown: 0.01 }, profile: 'phoenix-play', route: ['phoenix-core', 'phoenix-play'] },
    { intent: 'galleryOpen', unknown: true, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { galleryOpen: 0.99, unknown: 0.01 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.6, probabilities: { galleryOpen: 0.7, unknown: 0.1 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.4, probabilities: { galleryOpen: 0.7, unknown: 0.3 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.89, probabilities: { galleryOpen: 0.7, unknown: 0.99 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.99, margin: 0.98, probabilities: { galleryOpen: 0.99, unknown: 0.01 }, profile: 'phoenix-core', route: ['phoenix-core'] },
    { intent: 'galleryOpen', unknown: false, confidence: 0.99, top_probability: 0.44, margin: 0.4, probabilities: { galleryOpen: 0.44, unknown: 0.04 }, profile: 'phoenix-home', route: ['phoenix-core', 'phoenix-home'] },
  ];
  for (const body of badResults) {
    const client = createLayaClient({
      enabled: true, url: 'http://private', token: 'test-token', minConfidence: 0.45,
      fetch: async () => response(200, body),
    });
    assert.equal(await client.handleNLU({ text: 'anything' }), null);
  }
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('lightsOn'), false);
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('lightsUp'), false);
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('lightsDown'), false);
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('galleryOpen'), true);
  assert.equal(LAYA_ENTITYLESS_INTENTS.has('requestNews'), false);
  assert.equal(LAYA_ENTITYLESS_INTENTS.size, 11);
});

test('Laya environment configuration requires every explicit enablement component', () => {
  const prior = {
    enabled: process.env.ETCO_parser_layaEnabled,
    url: process.env.ETCO_parser_layaUrl,
    token: process.env.ETCO_parser_layaToken,
    timeout: process.env.ETCO_parser_layaTimeoutMs,
    confidence: process.env.ETCO_parser_layaMinConfidence,
  };
  try {
    process.env.ETCO_parser_layaEnabled = 'true';
    delete process.env.ETCO_parser_layaUrl;
    delete process.env.ETCO_parser_layaToken;
    delete process.env.ETCO_parser_layaMinConfidence;
    assert.equal(envLayaConfig().enabled, false);
    assert.equal(envLayaConfig().minConfidence, 0.45);
    process.env.ETCO_parser_layaUrl = 'http://192.168.1.252:6973/';
    process.env.ETCO_parser_layaToken = 'secret';
    process.env.ETCO_parser_layaTimeoutMs = '99999';
    const config = envLayaConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.url, 'http://192.168.1.252:6973');
    assert.equal(config.timeoutMs, 700);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      const envKey = `ETCO_parser_laya${key === 'enabled' ? 'Enabled' : key === 'url' ? 'Url' : key === 'token' ? 'Token' : key === 'timeout' ? 'TimeoutMs' : 'MinConfidence'}`;
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
