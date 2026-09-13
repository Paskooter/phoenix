import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGqaMemoryAttributionStore,
} from '../src/gqaAccountAttribution.js';
import {
  createStructQaClassicHandler,
  formatStructQaFakeAccountResponse,
  createStructQaHandler,
  createStructQaScriptedProvider,
  createStructQaService,
  STRUCTQA_BAD_REQUEST_HTML,
  STRUCTQA_PRODUCTION_ERROR_MESSAGE,
  STRUCTQA_FAKE_ACCOUNT_PATH,
  STRUCTQA_HEALTHCHECK_BODY,
  formatStructQaPythonValue,
  structQaErrorModeFromEnv,
  structQaContract,
} from '../src/gqaStructQaService.js';
import { createGqaProviderPipeline } from '../src/gqaAnswerSkill.js';

const NOW = 1700000000000;

function credentials(id = 'account-1', extra = {}) {
  return { 'x-amz-credentials': JSON.stringify({ id, ...extra }) };
}

function sourceRequest(body, { headers = credentials(), remoteAddress = '127.0.0.1' } = {}) {
  return { headers, remoteAddress, socket: { remoteAddress } };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('Q-01 /structQA source route inventories GQA, News, Scripted, and unknown intent branches', async () => {
  const events = [];
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async (accountId) => {
      events.push(['account', accountId]);
      return 'loop-1';
    },
    newsProvider: async ({ isKid }) => {
      events.push(['news', isKid]);
      return ['fixture headline'];
    },
  });

  const news = await handler({ Intent: 'News', HasKid: true }, { req: sourceRequest({}) });
  assert.equal(news.success, true);
  assert.equal(news.source, 'AP');
  assert.deepEqual(news.response, { type: 'array', payload: ['fixture headline'] });
  assert.equal(news.input, undefined);
  assert.deepEqual(events, [['account', 'account-1'], ['news', true]]);
  assert.equal(news.version, '5.2.15');
  assert.deepEqual(news.timestamps, { receive_request: NOW, return_response: NOW });

  const unknown = await handler({ Input: 'test test' }, { req: sourceRequest({}) });
  assert.equal(unknown.success, false);
  assert.equal(unknown.message, "Unknown Intent 'None'");

  const missingInput = await handler({ Intent: 'GQA' }, { req: sourceRequest({}) });
  assert.equal(missingInput.success, false);
  assert.equal(missingInput.message, 'No Input field supplied in query');
});

test('Q-01 /structQA account identity is resolved before body routing and defaults to missing robot', async () => {
  let calls = 0;
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => { calls += 1; return {}; },
    newsProvider: async () => { throw new Error('must not run'); },
  });

  const noHeader = await handler({ Intent: 'News' }, { req: sourceRequest({}, { headers: {} }) });
  assert.equal(noHeader.success, false);
  assert.equal(noHeader.message, 'Missing robot_id!');
  assert.equal(calls, 0);

  const unknownAccount = await handler({ Intent: 'News' }, { req: sourceRequest({}) });
  assert.equal(unknownAccount.success, false);
  assert.equal(unknownAccount.message, 'Missing robot_id!');
  assert.equal(calls, 1);
});

test('Q-01 /structQA forwards full credential context to Account lookup', async () => {
  let observed;
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async (accountId, context) => {
      observed = { accountId, context };
      return 'loop-1';
    },
  });
  const req = sourceRequest({}, {
    headers: credentials('short-key', { accessKeyId: 'short-key' }),
  });

  const result = await handler({ Intent: 'GQA', Input: 'fixture' }, { req });

  assert.equal(result.success, false);
  assert.equal(result.source, undefined);
  assert.equal(observed.accountId, 'short-key');
  assert.deepEqual(observed.context.credentials, {
    id: 'short-key',
    accessKeyId: 'short-key',
  });
  assert.equal(observed.context.req.headers, req.headers);
});

test('Q-01 /structQA preserves PII-before-cleaning and IP forwarding boundaries', async () => {
  let calls = 0;
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async () => { calls += 1; return {}; },
  });
  const result = await handler({ Intent: 'GQA', Input: 'what is fixture@example.com?' }, {
    req: sourceRequest({}, { headers: { ...credentials(), 'x-forwarded-for': ' 192.0.2.4, 10.0.0.1 ' } }),
  });
  assert.equal(result.success, false);
  assert.equal(result.message, 'Filtered by PII filter');
  assert.equal(result.input, 'what is fixture@example.com?');
  assert.equal(calls, 0);

  let seen;
  const contextHandler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async (context) => {
      seen = context;
      return {};
    },
  });
  await contextHandler({ Intent: 'GQA', Input: 'hey what is a fixture?', Latitude: 1, Longitude: 2 }, {
    req: sourceRequest({}, { headers: { ...credentials(), 'x-forwarded-for': ' 192.0.2.4, 10.0.0.1 ' } }),
  });
  assert.equal(seen.queryText, 'what is a fixture');
  assert.equal(seen.ipAddress, '192.0.2.4');
  assert.equal(seen.latitude, '1');
  assert.equal(seen.longitude, '2');
  assert.equal(seen.countryCode, 'US');
  assert.equal(seen.loopId, 'loop-1');
});

test('Q-01 archived PII request preserves the real /structQA 200 envelope', async () => {
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async (accountId) => {
      assert.equal(accountId, 'tester');
      return 'tester';
    },
    gqaProvider: async () => {
      throw new Error('PII must stop before a provider call');
    },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials('tester') },
      body: JSON.stringify({
        HasKid: null,
        Input: '234567890',
        Intent: 'GQA',
        Latitude: 42.3517272,
        Longitude: -71.0408624,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await response.text()), {
      input: '234567890',
      message: 'Filtered by PII filter',
      version: '5.2.15',
      success: false,
      timestamps: { receive_request: NOW, return_response: NOW },
    });
  } finally {
    await closeServer(server);
  }
});

test('Q-01 Scripted branch uses source API-AI arguments and MIM registry result shape', async () => {
  const calls = [];
  const payload = { mim_id: 'OI_USR_IsAngry', prompts: [{ prompt_id: 'OI_USR_IsAngry_AN_01' }] };
  const scripted = createStructQaScriptedProvider({
    apiAi: async (query, ipAddress) => {
      calls.push(['api-ai', query, ipAddress]);
      return { status: { code: 200 }, result: { metadata: { intentName: 'userIsDescriptor' } } };
    },
    registry: {
      getIntentPattern(value) {
        calls.push(['pattern', value.result.metadata.intentName]);
        return 'userIsDescriptor;Emotion:Angry';
      },
      getMimPayload(pattern) {
        calls.push(['mim', pattern]);
        return payload;
      },
    },
  });
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    scriptedProvider: scripted,
  });
  const result = await handler({ Intent: 'Scripted', Input: "hey what's angry?" }, {
    req: sourceRequest({}, { headers: credentials(), remoteAddress: '198.51.100.8' }),
  });
  assert.equal(result.success, true);
  assert.equal(result.source, 'Scripted Response');
  assert.deepEqual(result.response, { type: 'mim', payload });
  assert.deepEqual(result.timestamps, {
    receive_request: NOW,
    api_ai_request: NOW,
    api_ai_response: NOW,
    return_response: NOW,
  });
  assert.deepEqual(calls, [
    ['api-ai', "what's angry", '198.51.100.8'],
    ['pattern', 'userIsDescriptor'],
    ['mim', 'userIsDescriptor;Emotion:Angry'],
  ]);
});

test('Q-01 archived Scripted response preserves the real /structQA request and checkpoints', async () => {
  const calls = [];
  const payload = {
    mim_id: 'OI_USR_IsAngry',
    prompts: [{ prompt_id: 'OI_USR_IsAngry_AN_01' }],
  };
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async (accountId) => {
      assert.equal(accountId, 'scripted-test');
      return 'scripted-test';
    },
    apiAi: async (query, ipAddress) => {
      calls.push(['api-ai', query, ipAddress]);
      return {
        status: { code: 200 },
        result: { metadata: { intentName: 'userIsDescriptor' } },
      };
    },
    registry: {
      getIntentPattern(value) {
        calls.push(['pattern', value.result.metadata.intentName]);
        return 'userIsDescriptor;Emotion:Angry';
      },
      getMimPayload(pattern) {
        calls.push(['mim', pattern]);
        return payload;
      },
    },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials('scripted-test') },
      body: JSON.stringify({
        HasKid: null,
        Input: 'I am angry',
        Intent: 'Scripted',
        Latitude: 42.3517272,
        Longitude: -71.0408624,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await response.text()), {
      input: 'I am angry',
      source: 'Scripted Response',
      response: { type: 'mim', payload },
      version: '5.2.15',
      success: true,
      timestamps: {
        receive_request: NOW,
        api_ai_request: NOW,
        api_ai_response: NOW,
        return_response: NOW,
      },
    });
    assert.equal(calls[0][0], 'api-ai');
    assert.equal(calls[0][1], 'I am angry');
    assert.equal(calls[1][0], 'pattern');
    assert.equal(calls[2][0], 'mim');
    assert.deepEqual(calls.slice(1), [
      ['pattern', 'userIsDescriptor'],
      ['mim', 'userIsDescriptor;Emotion:Angry'],
    ]);
  } finally {
    await closeServer(server);
  }
});

test('Q-01 archived age Scripted request preserves the exact no-answer envelope', async () => {
  const calls = [];
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async () => 'entity-test',
    apiAi: async (query) => {
      calls.push(['api-ai', query]);
      return {
        status: { code: 200 },
        result: {
          metadata: { intentName: 'ageIntent' },
          parameters: { age: { amount: 25, unit: 'year' } },
        },
      };
    },
    registry: {
      getIntentPattern(value) {
        calls.push(['pattern', value.result.parameters.age]);
        return 'ageIntent;age:25year';
      },
      getMimPayload(pattern) {
        calls.push(['mim', pattern]);
        return undefined;
      },
    },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials('entity-test') },
      body: JSON.stringify({
        HasKid: null,
        Input: 'I am 25 years old',
        Intent: 'Scripted',
        Latitude: 42.3517272,
        Longitude: -71.0408624,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await response.text()), {
      input: 'I am 25 years old',
      source: 'Scripted Response',
      version: '5.2.15',
      success: false,
      timestamps: {
        receive_request: NOW,
        api_ai_request: NOW,
        api_ai_response: NOW,
        return_response: NOW,
      },
    });
    assert.deepEqual(calls, [
      ['api-ai', 'I am 25 years old'],
      ['pattern', { amount: 25, unit: 'year' }],
      ['mim', 'ageIntent;age:25year'],
    ]);
  } finally {
    await closeServer(server);
  }
});

test('Q-01 Scripted API-AI no-answer stays HTTP-200 success false', async () => {
  const scripted = createStructQaScriptedProvider({
    apiAi: async () => ({}),
    registry: {
      getIntentPattern: () => '',
      getMimPayload: () => undefined,
    },
  });
  const handler = createStructQaHandler({ clock: () => NOW, accountLookup: async () => 'loop-1', scriptedProvider: scripted });
  const result = await handler({ Intent: 'Scripted', Input: 'I am angry' }, { req: sourceRequest({}) });
  assert.equal(result.success, false);
  assert.equal(result.source, 'Scripted Response');
  assert.equal(result.response, undefined);
  assert.equal(result.message, undefined);
});

test('Q-01 Scripted API-AI transport failure reaches the registry as an empty mapping', async () => {
  const calls = [];
  const scripted = createStructQaScriptedProvider({
    apiAi: async () => { throw new Error('API-AI unavailable'); },
    registry: {
      getIntentPattern(value) {
        calls.push(['pattern', value]);
        return '';
      },
      getMimPayload(pattern) {
        calls.push(['mim', pattern]);
        return undefined;
      },
    },
  });
  const handler = createStructQaHandler({ clock: () => NOW, accountLookup: async () => 'loop-1', scriptedProvider: scripted });
  const result = await handler({ Intent: 'Scripted', Input: 'transport failure' }, { req: sourceRequest({}) });
  assert.equal(result.success, false);
  assert.deepEqual(calls, [['pattern', {}], ['mim', '']]);
});

test('Q-01 GQA success appends punctuation and reuses accepted attribution storage', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => NOW });
  let seen;
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async (accountId) => {
      assert.equal(accountId, 'account-1');
      return 'loop-1';
    },
    attribution,
    gqaProvider: async (context) => {
      seen = context;
      return {
        source: 'Bing',
        type: 'Facts',
        url: 'https://fixture.invalid/result',
        response: { type: 'string', payload: 'A fixture answer' },
        timestamps: { bing_request: NOW + 1, bing_response: NOW + 2 },
        timings: { bing: 0.001 },
      };
    },
  });
  const result = await handler({ Intent: 'GQA', Input: 'what is a fixture fact', Country: 'usa' }, {
    req: sourceRequest({}),
  });
  assert.equal(result.success, true);
  assert.equal(result.source, 'Bing');
  assert.equal(result.response.payload, 'A fixture answer.');
  assert.equal(result.timings, undefined);
  assert.equal(result.timestamps.receive_request, NOW);
  assert.equal(result.timestamps.bing_request, NOW + 1);
  assert.equal(seen.countryCode, 'US');
  assert.deepEqual(attribution.snapshot(), [{
    service: 'Bing',
    query: 'A fixture answer.',
    url: 'https://fixture.invalid/result',
    image_url: null,
    loop_id: 'loop-1',
    timestamp: NOW,
  }]);
});

test('Q-01 GQA provider exceptions and empty/fallback results remain no-answer HTTP 200', async () => {
  const throwing = createStructQaHandler({ clock: () => NOW, accountLookup: async () => 'loop-1', gqaProvider: async () => { throw new Error('provider down'); } });
  const empty = await throwing({ Intent: 'GQA', Input: 'what is unavailable' }, { req: sourceRequest({}) });
  assert.equal(empty.success, false);
  assert.equal(empty.message, undefined);
  assert.equal(empty.response, undefined);

  const fallback = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    providers: {
      Bing: async () => ({}),
      Wikipedia: async () => ({ source: 'Wikipedia', response: { type: 'string', payload: 'A wiki answer' } }),
      'Wolfram Alpha': async () => ({ source: 'Wolfram Alpha', response: { type: 'string', payload: 'A wolfram answer' } }),
    },
  });
  const result = await fallback({ Intent: 'GQA', Input: 'what is fallback' }, { req: sourceRequest({}) });
  assert.equal(result.success, true);
  assert.equal(result.source, 'Wikipedia');
  assert.equal(result.response.payload, 'A wiki answer.');
});

test('Q-01 configured providers retain source provider timestamps and parent fork checkpoints', async () => {
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    providers: {
      Bing: async () => ({
        timestamps: { bing_request: NOW + 1, bing_response: NOW + 2 },
      }),
      Wikipedia: async () => ({
        timestamps: {
          wiki_begin_tokenization: NOW + 3,
          wikipedia_fork: NOW - 1,
          wiki_request: NOW + 4,
          wiki_response: NOW + 5,
        },
      }),
      'Wolfram Alpha': async () => ({
        source: 'Wolfram Alpha',
        url: 'https://fixture.invalid/wolfram',
        response: { type: 'string', payload: 'A computed answer' },
        timestamps: {
          wolfram_alpha_fork: NOW - 2,
          wolfram_request: NOW + 6,
          wolfram_response: NOW + 7,
        },
      }),
    },
  });
  const result = await handler({ Intent: 'GQA', Input: 'what is a computed answer' }, { req: sourceRequest({}) });
  assert.equal(result.success, true);
  assert.equal(result.source, 'Wolfram Alpha');
  assert.equal(result.timestamps.bing_fork, NOW);
  assert.equal(result.timestamps.wikipedia_fork, NOW);
  assert.equal(result.timestamps.wolfram_alpha_fork, NOW);
  assert.equal(result.timestamps.bing_request, undefined);
  assert.equal(result.timestamps.wiki_begin_tokenization, undefined);
  assert.equal(result.timestamps.wolfram_request, NOW + 6);
  assert.equal(result.timestamps.wolfram_response, NOW + 7);
  assert.equal(result.timestamps.services_timedout, undefined);
  assert.equal(result.timestamps.timeout_timedout, undefined);
});

test('Q-01 configured provider timeout preserves the pinned source timedout-key bug', async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const pipeline = createGqaProviderPipeline({
    providers: {
      Bing: async () => { await sleep(35); return {}; },
      Wikipedia: async () => { await sleep(35); return {}; },
      'Wolfram Alpha': async () => ({
        source: 'Wolfram Alpha',
        response: { type: 'string', payload: 'fallback' },
        timestamps: { wolfram_response: Date.now() },
      }),
    },
    timeouts: [5, 100],
  });
  const result = await pipeline({ queryText: 'timeout fixture' });
  assert.equal(result.source, 'Wolfram Alpha');
  assert.equal(typeof result.timestamps.bing_fork, 'number');
  assert.equal(typeof result.timestamps.wikipedia_fork, 'number');
  assert.equal(typeof result.timestamps.wolfram_alpha_fork, 'number');
  assert.equal(typeof result.timestamps.services_timedout, 'number');
  assert.equal(typeof result.timestamps.timeout_timedout, 'number');
  assert.equal(result.timestamps.bing_timedout, undefined);
  assert.equal(result.timestamps.wikipedia_timedout, undefined);
});

test('Q-01 provider payload uses Python truthiness at the no-answer boundary', async () => {
  for (const payload of [false, 0, '', [], {}]) {
    const handler = createStructQaHandler({
      clock: () => NOW,
      accountLookup: async () => 'loop-1',
      gqaProvider: async () => ({
        source: 'Bing',
        url: 'https://fixture.invalid/empty',
        response: { type: 'string', payload },
      }),
    });
    const result = await handler({ Intent: 'GQA', Input: 'empty answer' }, { req: sourceRequest({}) });
    assert.equal(result.success, false, `payload ${JSON.stringify(payload)} must be falsey`);
    assert.equal(result.response, undefined);
    assert.equal(result.source, undefined);
  }

  const truthy = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async () => ({
      source: 'Wikipedia',
      response: { type: 'array', payload: ['answer'] },
    }),
  });
  const result = await truthy({ Intent: 'GQA', Input: 'array answer' }, { req: sourceRequest({}) });
  assert.equal(result.success, true);
  assert.deepEqual(result.response, { type: 'array', payload: ['answer'] });
});

test('Q-01 truthy non-string Bing/Wolfram payloads retain the source attribution 500 boundary', async () => {
  for (const source of ['Bing', 'Wolfram Alpha']) {
    for (const response of [
      { type: 'array', payload: ['truthy'] },
      { type: 'string', payload: 7 },
    ]) {
      const service = createStructQaService({
        clock: () => NOW,
        accountLookup: async () => 'loop-1',
        gqaProvider: async () => ({ source, url: 'https://fixture.invalid/answer', response }),
      });
      const server = await service.listen(0);
      try {
        const result = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...credentials() },
          body: JSON.stringify({ Intent: 'GQA', Input: 'truthy non-string' }),
        });
        assert.equal(result.status, 500, `${source}/${response.type} must preserve source failure`);
        const body = JSON.parse(await result.text());
        assert.equal(body.version, '5.2.15');
        assert.match(body.message, /attributed provider (payload|response type)|string response payload/);
      } finally {
        await closeServer(server);
      }
    }
  }
});

test('Q-01 source string-type list payloads append a list period before attribution', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => NOW });
  const handler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    attribution,
    gqaProvider: async () => ({
      source: 'Bing',
      url: 'https://fixture.invalid/list',
      response: { type: 'string', payload: ['list answer'] },
    }),
  });
  const result = await handler({ Intent: 'GQA', Input: 'list answer' }, { req: sourceRequest({}) });
  assert.equal(result.success, true);
  assert.deepEqual(result.response.payload, ['list answer', '.']);
  assert.deepEqual(attribution.snapshot(), [{
    service: 'Bing',
    query: ['list answer', '.'],
    url: 'https://fixture.invalid/list',
    image_url: null,
    loop_id: 'loop-1',
    timestamp: NOW,
  }]);

  const wikipedia = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async () => ({ source: 'Wikipedia', response: { type: 'string', payload: ['wiki answer'] } }),
  });
  const wikiResult = await wikipedia({ Intent: 'GQA', Input: 'wiki list' }, { req: sourceRequest({}) });
  assert.deepEqual(wikiResult.response.payload, ['wiki answer', '.']);
});

test('Q-01 unknown intents and provider coordinates use Python JSON-value formatting', async () => {
  assert.equal(formatStructQaPythonValue({ answer: true, missing: null, words: ['a', false] }), "{'answer': True, 'missing': None, 'words': ['a', False]}");
  assert.equal(formatStructQaPythonValue({ quote: "can't" }), "{'quote': \"can't\"}");
  assert.equal(formatStructQaPythonValue(1.0), '1');
  const unknownHandler = createStructQaHandler({ clock: () => NOW, accountLookup: async () => 'loop-1' });
  const unknown = await unknownHandler({ Intent: { answer: true, missing: null }, Input: 'unknown' }, { req: sourceRequest({}) });
  assert.equal(unknown.message, "Unknown Intent '{'answer': True, 'missing': None}'");

  let seen;
  const coordinateHandler = createStructQaHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async (context) => { seen = context; return {}; },
  });
  await coordinateHandler({ Intent: 'GQA', Input: 'coordinates', Latitude: { north: true }, Longitude: [1, null] }, {
    req: sourceRequest({}),
  });
  assert.equal(seen.latitude, "{'north': True}");
  assert.equal(seen.longitude, '[1, None]');
});

test('Q-01 news provider empty/error behavior retains source message and status boundaries', async () => {
  const empty = createStructQaHandler({ clock: () => NOW, accountLookup: async () => 'loop-1', newsProvider: async () => [] });
  const result = await empty({ Intent: 'News' }, { req: sourceRequest({}) });
  assert.equal(result.success, false);
  assert.equal(result.message, 'Empty news DB');
  assert.equal(result.source, undefined);

  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    newsProvider: async () => { throw new Error('AP unavailable'); },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials() },
      body: JSON.stringify({ Intent: 'News' }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = JSON.parse(await response.text());
    assert.equal(body.version, '5.2.15');
    assert.match(body.message, /AP unavailable/);
    assert.equal(typeof body.stacktrace, 'string');
  } finally {
    await closeServer(server);
  }
});

test('Q-01 archived AP request composes the /structQA route with exact source feed output', async () => {
  const calls = [];
  const recent = NOW - 1000;
  const store = {
    find(query, options) {
      calls.push({ query, options });
      if (query.feedID !== '41664') return [];
      return [{ feedID: '41664', storedTime: recent, adult: false, summary: 'testsummary' }];
    },
  };
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async (accountId) => {
      assert.equal(accountId, 'tester');
      return 'tester';
    },
    apStore: store,
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials('tester') },
      body: JSON.stringify({
        HasKid: null,
        Intent: 'News',
        Latitude: 42.3517272,
        Longitude: -71.0408624,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await response.text()), {
      success: true,
      source: 'AP',
      response: { type: 'array', payload: ['testsummary'] },
      version: '5.2.15',
      timestamps: { receive_request: NOW, return_response: NOW },
    });
    const expectedOptions = {
      projection: { _id: 0 },
      sort: { storedTime: -1 },
      limit: 5,
    };
    assert.deepEqual(calls, [
      {
        query: { storedTime: { $gt: NOW - 24 * 60 * 60 * 1000 }, feedID: '42210' },
        options: expectedOptions,
      },
      {
        query: { storedTime: { $gt: NOW - 24 * 60 * 60 * 1000 }, feedID: '41664' },
        options: expectedOptions,
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test('Q-01 HTTP framing preserves malformed JSON 400 and x-amz credential parse 500', async () => {
  const service = createStructQaService({ clock: () => NOW, accountLookup: async () => 'loop-1' });
  const server = await service.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/structQA`;
    const malformed = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '4' },
      body: 'test',
    });
    assert.equal(malformed.status, 400);
    assert.equal(await malformed.text(), STRUCTQA_BAD_REQUEST_HTML);

    const invalidCredentials = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-credentials': '{bad' },
      body: JSON.stringify({ Intent: 'News' }),
    });
    assert.equal(invalidCredentials.status, 500);
    const body = JSON.parse(await invalidCredentials.text());
    assert.equal(body.version, '5.2.15');
    assert.match(body.message, /Unexpected token|JSON/);

    const emptyEntity = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '0' },
    });
    assert.equal(emptyEntity.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('Q-01 standalone GQA auxiliary routes preserve source health 42 and developer fakeAccount JSON', async () => {
  assert.equal(STRUCTQA_HEALTHCHECK_BODY, '42');
  assert.equal(formatStructQaFakeAccountResponse({ accountsIds: ['unit-test'] }), '{"unit-test": ["unit-test"]}');

  const service = createStructQaService({ clock: () => NOW, accountLookup: async () => 'loop-1' });
  const server = await service.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/healthcheck`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await health.text(), '42');

    const fakeAccount = await fetch(`${base}${STRUCTQA_FAKE_ACCOUNT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountsIds: ['unit-test'] }),
    });
    assert.equal(fakeAccount.status, 200);
    assert.equal(fakeAccount.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await fakeAccount.text(), '{"unit-test": ["unit-test"]}');

    const malformed = await fetch(`${base}${STRUCTQA_FAKE_ACCOUNT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 200);
    assert.equal(malformed.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await malformed.text(), 'ERROR');
  } finally {
    await closeServer(server);
  }
});

test('Q-01 /structQA HTTP route preserves archived no-input and absent-intent envelopes', async () => {
  const service = createStructQaService({ clock: () => NOW, accountLookup: async () => 'loop-1' });
  const server = await service.listen(0);
  try {
    const post = async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...credentials() },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
      };
    };

    const noInput = await post({ Intent: 'GQA' });
    assert.equal(noInput.status, 200);
    assert.equal(noInput.contentType, 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(noInput.text), {
      timestamps: { receive_request: NOW, return_response: NOW },
      message: 'No Input field supplied in query',
      version: '5.2.15',
      success: false,
    });

    const noIntent = await post({ Input: 'test test' });
    assert.equal(noIntent.status, 200);
    assert.equal(noIntent.contentType, 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(noIntent.text), {
      timestamps: { receive_request: NOW, return_response: NOW },
      input: 'test test',
      message: "Unknown Intent 'None'",
      version: '5.2.15',
      success: false,
    });
  } finally {
    await closeServer(server);
  }
});

test('Q-01 500 mode mirrors Python env comparison and supports an explicit production envelope', async () => {
  assert.equal(structQaErrorModeFromEnv({ ETCO_gqa_production: '1' }), 'debug');
  assert.equal(structQaErrorModeFromEnv({ ETCO_gqa_production: 1 }), 'production');

  const service = createStructQaService({
    errorMode: 'production',
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    newsProvider: async () => { throw new Error('private fixture failure'); },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials() },
      body: JSON.stringify({ Intent: 'News' }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await response.text()), {
      version: '5.2.15',
      message: STRUCTQA_PRODUCTION_ERROR_MESSAGE,
    });
  } finally {
    await closeServer(server);
  }
});

test('Q-01 Classic adapter passes context into the stable source handler without branch duplication', async () => {
  assert.equal(structQaContract.sourceHandler, '(body, { req, headers }) => response object');
  assert.match(structQaContract.classicAdapter, /^createStructQaClassicHandler/);
  const sent = {};
  const response = {
    status(code) {
      sent.status = code;
      return this;
    },
    type(value) {
      sent.type = value;
      return this;
    },
    send(body) {
      sent.body = body;
      return this;
    },
  };
  const classic = createStructQaClassicHandler({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    newsProvider: async ({ isKid }) => (isKid ? ['kid headline'] : []),
  });
  const result = await classic({
    req: sourceRequest({}, { headers: credentials() }),
    body: { Intent: 'News', HasKid: true },
    res: response,
  });
  assert.equal(result, undefined);
  assert.equal(sent.status, 200);
  assert.equal(sent.type, 'html');
  assert.deepEqual(JSON.parse(sent.body), {
    success: true,
    source: 'AP',
    response: { type: 'array', payload: ['kid headline'] },
    version: '5.2.15',
    timestamps: { receive_request: NOW, return_response: NOW },
  });
});

test('Q-01 non-string Country remains a source 500 rather than an implicit cast', async () => {
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async () => { throw new Error('provider must not run'); },
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/structQA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials() },
      body: JSON.stringify({ Intent: 'GQA', Input: 'country shape', Country: 7 }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = JSON.parse(await response.text());
    assert.equal(body.version, '5.2.15');
    assert.match(body.message, /Country.*lower/);
    assert.equal(typeof body.stacktrace, 'string');
  } finally {
    await closeServer(server);
  }
});

test('Q-01 malformed successful provider shape is a source HTTP 500, while unknown intent is HTTP 200', async () => {
  const service = createStructQaService({
    clock: () => NOW,
    accountLookup: async () => 'loop-1',
    gqaProvider: async () => ({ source: 'Wikipedia', response: null }),
  });
  const server = await service.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/structQA`;
    const malformed = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials() },
      body: JSON.stringify({ Intent: 'GQA', Input: 'what is broken' }),
    });
    assert.equal(malformed.status, 500);
    const malformedBody = JSON.parse(await malformed.text());
    assert.equal(malformedBody.version, '5.2.15');

    const unknown = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials() },
      body: JSON.stringify({ Intent: 'WOW', Input: 'test' }),
    });
    assert.equal(unknown.status, 200);
    const unknownBody = JSON.parse(await unknown.text());
    assert.deepEqual({ success: unknownBody.success, message: unknownBody.message }, {
      success: false,
      message: "Unknown Intent 'WOW'",
    });
  } finally {
    await closeServer(server);
  }
});
