// Q-01 focused API-AI/MIM registry replay.
//
// The source controls are the pinned srv-gqa-ws files named in the fixture.
// All HTTP and registry data is injected from that fixture; this test never
// contacts api.ai or reads the archived registry at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGqaApiAiClient, GQA_API_AI_ENDPOINT } from '../src/gqaApiAi.js';
import { createGqaMimRegistry } from '../src/gqaMimRegistry.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/q01-api-ai-mim.json', import.meta.url), 'utf8'));

function responseJson(value) {
  return { json: async () => structuredClone(value) };
}

function registry() {
  return createGqaMimRegistry(fixture.registry);
}

test('Q-01 API-AI client sends the archived query/session shape through an injected transport', async () => {
  const calls = [];
  const client = createGqaApiAiClient({
    endpoint: fixture.apiAi.endpoint,
    apiKey: fixture.apiAi.apiKey,
    request: async (url, options) => {
      calls.push({ url, options });
      return responseJson(fixture.apiAi.successResponse);
    },
  });

  const output = await client.call(fixture.apiAi.request.query, fixture.apiAi.request.robotName);
  assert.deepEqual(output, fixture.apiAi.successResponse);
  assert.deepEqual(calls, [{
    url: GQA_API_AI_ENDPOINT,
    options: {
      params: {
        query: 'do you like dog?',
        lang: 'en',
        sessionId: '1234567890',
      },
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer fixture-api-ai-key',
      },
    },
  }]);
});

test('Q-01 API-AI exceptions and empty JSON responses fall back to an empty object', async () => {
  const calls = [];
  const client = createGqaApiAiClient({
    request: async (_url, options) => {
      calls.push(options);
      if (options.params.query === 'exception test') throw new Error('fixture transport failure');
      return responseJson(fixture.apiAi.emptyResponse);
    },
  });
  assert.deepEqual(await client.call('exception test', '123'), {});
  assert.deepEqual(await client.call('empty test', '123'), {});
  assert.equal(calls.length, 2);
});

test('Q-01 API-AI client has no implicit live transport', () => {
  assert.throws(() => createGqaApiAiClient(), /request implementation must be a function/);
  assert.throws(() => createGqaMimRegistry(), /MIM lookup data must be injected/);
});

test('Q-01 API-AI status 500 is retained by the client and rejected by the MIM registry', async () => {
  const client = createGqaApiAiClient({
    request: async () => responseJson(fixture.apiAi.status500Response),
  });
  const output = await client.call('status test', '123');
  assert.deepEqual(output, fixture.apiAi.status500Response);
  assert.equal(registry().getIntentPattern(output), null);
});

test('Q-01 MIM registry builds the sorted semicolon intent/entity pattern', () => {
  const mim = registry();
  assert.equal(mim.getIntentPattern(fixture.apiAi.successResponse), 'doesJiboLikeThing;Object:Dogs');

  const withUnsortedEntities = structuredClone(fixture.apiAi.successResponse);
  withUnsortedEntities.result.parameters.Zed = 'last';
  assert.equal(
    mim.getIntentPattern(withUnsortedEntities),
    'doesJiboLikeThing;Object:Dogs;Zed:last',
  );

  const entityFree = {
    status: { code: 200 },
    result: {
      metadata: { intentName: 'doesJiboHaveOpinionAboutThing' },
      parameters: { Object: '', OtherAgent: '', OtherLikes: '', OtherSubjects: '' },
    },
  };
  assert.equal(mim.getIntentPattern(entityFree), 'doesJiboHaveOpinionAboutThing;');
});

test('Q-01 MIM registry formats Dialogflow age entities and preserves source empty-output behavior', () => {
  const mim = registry();
  const ageOutput = {
    status: { code: 200 },
    result: {
      metadata: { intentName: 'ageIntent' },
      parameters: { age: { amount: 25, unit: 'year' } },
    },
  };
  assert.equal(mim.getIntentPattern(ageOutput), 'ageIntent;age:25year');
  assert.equal(mim.getIntentPattern({}), null);
  assert.equal(mim.getIntentPattern(null), null);
});

test('Q-01 MIM payload lookup returns the pinned Dogs response and exposes missing-key behavior', () => {
  const mim = registry();
  const payload = mim.getMimPayload('doesJiboLikeThing;Object:Dogs');
  assert.equal(payload.prompts[0].prompt, 'Dogs are great! They have so many more legs than I do.');
  assert.equal(payload.prompts[0].prompt_id, 'OI_JBO_LikesDogs_AN_01');
  assert.equal(mim.getMimPayload('doesJiboLikeThing;Object:Cats'), undefined);
  assert.equal(mim.getMimPayload(''), null);
});

test('Q-01 MIM registry rejects duplicate patterns and mismatched entity vectors', () => {
  assert.throws(() => createGqaMimRegistry({
    lookup: {
      one: { entity_name: ['Object'], entity_val: ['Dogs'], intent: 'same' },
      two: { entity_name: ['Object'], entity_val: ['Dogs'], intent: 'same' },
    },
    payloads: {},
  }), /Different MIMs sharing same intent pattern/);
  assert.throws(() => createGqaMimRegistry({
    lookup: {
      broken: { entity_name: ['Object'], entity_val: [], intent: 'broken' },
    },
    payloads: {},
  }), /Different length/);
});
