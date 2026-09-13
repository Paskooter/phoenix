import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGqaMemoryAttributionStore,
} from '../src/gqaAccountAttribution.js';
import {
  createStructQaClassicHandler,
  createStructQaHandler,
  createStructQaScriptedProvider,
  createStructQaService,
  STRUCTQA_BAD_REQUEST_HTML,
  structQaContract,
} from '../src/gqaStructQaService.js';

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

test('Q-01 HTTP framing preserves malformed JSON 400 and x-amz credential parse 500', async () => {
  const service = createStructQaService({ clock: () => NOW, accountLookup: async () => 'loop-1' });
  const server = await service.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/structQA`;
    const malformed = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '8' },
      body: 'not-json',
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
