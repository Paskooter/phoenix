import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  WOLFRAM_SOURCE_ANSWER_POD_INDEX,
  WOLFRAM_SOURCE_CONFIG_KEY,
  WOLFRAM_SOURCE_MODULE,
  WOLFRAM_SOURCE_REVISION,
  WOLFRAM_SOURCE_SCAN_TIMEOUT,
  WOLFRAM_SOURCE_TOTAL_TIMEOUT,
  cleanWolframAnswer,
  createWolframProvider,
  extractWolframPodAnswer,
  extractWolframSpokenAnswer,
  wolframProviderContract,
} from '../src/gqaWolframProvider.js';

function sourceBody({ spokenTemplate, spokenText, genericTemplate, pods, success = true } = {}) {
  const queryresult = { success };
  if (spokenTemplate !== undefined || spokenText !== undefined || genericTemplate !== undefined) {
    queryresult.spokenresult = {};
    if (spokenTemplate !== undefined) queryresult.spokenresult.srtemplate = { sampletext: spokenTemplate };
    if (spokenText !== undefined) queryresult.spokenresult.sampletext = spokenText;
    if (genericTemplate !== undefined) queryresult.spokenresult.generictemplate = genericTemplate;
  }
  if (pods !== undefined) queryresult.pods = pods;
  return { queryresult };
}

function resultPod(text = 'A pod answer.', extra = {}) {
  return {
    title: 'Result',
    primary: true,
    subpods: [{ plaintext: text }],
    ...extra,
  };
}

function clockFactory(values) {
  const remaining = [...values];
  return () => remaining.shift();
}

async function withWolframPeer(callback) {
  const requests = [];
  const state = {
    status: 200,
    body: sourceBody({ spokenTemplate: 'The fixture answer.' }),
    headers: { 'content-type': 'application/json' },
    responseUrl: null,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const raw = typeof state.body === 'string' ? state.body : JSON.stringify(state.body);
    response.writeHead(state.status, {
      ...state.headers,
      'content-length': Buffer.byteLength(raw),
    });
    response.end(raw);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/wolfram`;
  try {
    return await callback({ endpoint, requests, state });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Q-01 Wolfram exports identify the recovered source contract', () => {
  assert.equal(WOLFRAM_SOURCE_REVISION, 'ebe1a7d38f511570060c1fbf61bec89d58419b26');
  assert.equal(WOLFRAM_SOURCE_MODULE, 'gqa/wolfram.py');
  assert.equal(WOLFRAM_SOURCE_CONFIG_KEY, 'wolfram_api');
  assert.equal(WOLFRAM_SOURCE_TOTAL_TIMEOUT, '3');
  assert.equal(WOLFRAM_SOURCE_SCAN_TIMEOUT, '1.0');
  assert.equal(WOLFRAM_SOURCE_ANSWER_POD_INDEX, '2');
  assert.deepEqual(wolframProviderContract.request, [
    'input', 'appid', 'output', 'spokenresult', 'totaltimeout', 'scantimeout', 'podindex', 'ip', 'latlong',
  ]);
});

test('Q-01 Wolfram spoken extraction follows response suppression and source precedence', () => {
  const responsePod = sourceBody({
    spokenTemplate: 'Should not be spoken.',
    pods: [resultPod('A result.'), { title: 'Response', primary: true, subpods: [] }],
  });
  assert.equal(extractWolframSpokenAnswer(responsePod), '');

  const dateTemplate = sourceBody({ spokenTemplate: 'The weather for Date Boston is sunny.' });
  assert.equal(extractWolframSpokenAnswer(dateTemplate), 'The weather Boston is sunny.');

  const repeatedDateTemplate = sourceBody({ spokenTemplate: 'A for Date B for Date C' });
  assert.equal(extractWolframSpokenAnswer(repeatedDateTemplate), 'A B C');

  const sample = sourceBody({ spokenText: 'A sample fallback.' });
  assert.equal(extractWolframSpokenAnswer(sample), 'A sample fallback.');

  const sampleWithDate = sourceBody({ spokenText: 'A for Date fallback.' });
  assert.equal(extractWolframSpokenAnswer(sampleWithDate), 'A for Date fallback.');

  const podFallback = sourceBody({ pods: [resultPod('A primary pod answer.')] });
  assert.equal(extractWolframSpokenAnswer(podFallback), 'A primary pod answer.');

  const entityFallback = sourceBody({
    genericTemplate: 'EntityInformation',
    spokenText: 'Ignored entity answer.',
    pods: [resultPod('Entity pod answer.')],
  });
  assert.equal(extractWolframSpokenAnswer(entityFallback), 'Entity pod answer.');
});

test('Q-01 Wolfram pod extraction keeps the source last-Result selection', () => {
  const body = sourceBody({ pods: [
    { title: 'Result', primary: false, subpods: [{ plaintext: 'First result.' }] },
    { title: 'Other', primary: true, subpods: [{ plaintext: 'Other pod.' }] },
    { title: 'Result', primary: true, subpods: [{ plaintext: 'Last result.' }] },
  ] });
  assert.equal(extractWolframPodAnswer(body), 'Last result.');
  assert.equal(extractWolframPodAnswer(sourceBody({ pods: [{ primary: true, subpods: [] }] })), '');
  assert.throws(
    () => extractWolframPodAnswer(sourceBody({ pods: [{ title: 'Result', primary: true, subpods: [] }] })),
    /subpods\[0\]/,
  );
});

test('Q-01 Wolfram clean_answer preserves source rejection and parenthesis rules', () => {
  for (const value of ['{}', 'a$b', 'line\nbreak', 'a-b', 'a<b', 'a|b', 'This is an empty list']) {
    assert.equal(cleanWolframAnswer(value), '', value);
  }
  assert.equal(cleanWolframAnswer('RegularExpression result'), '');
  assert.equal(cleanWolframAnswer('From definitions, the first one is: '), '');
  assert.equal(cleanWolframAnswer('I have an image for you'), '');
  assert.equal(cleanWolframAnswer('(not spoken)'), '');
  assert.equal(cleanWolframAnswer('Answer (with detail) here'), 'Answer with detail here');
  assert.equal(cleanWolframAnswer('  preserve surrounding spaces  '), '  preserve surrounding spaces  ');
});

test('Q-01 Wolfram success sends ordered source parameters and returns spoken output', async () => {
  await withWolframPeer(async ({ endpoint, requests, state }) => {
    state.body = sourceBody({ spokenTemplate: 'The fixture answer.' });
    const provider = createWolframProvider({
      endpoint,
      apiKey: 'fixture-key',
      clock: clockFactory([1000, 1007]),
    });
    const output = await provider({
      queryText: 'what is a fixture?',
      ipAddress: '192.0.2.4',
      latitude: '42.1',
      longitude: '-71.2',
    });
    assert.deepEqual(output, {
      source: 'Wolfram Alpha',
      timestamps: { wolfram_request: 1000, wolfram_response: 1007 },
      url: 'https://www.wolframalpha.com/input/?i=what+is+a+fixture%3F',
      response: { type: 'string', payload: 'The fixture answer.' },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].body, '');
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.equal(requestUrl.pathname, '/wolfram');
    assert.deepEqual([...requestUrl.searchParams.entries()], [
      ['input', 'what is a fixture?'],
      ['appid', 'fixture-key'],
      ['output', 'JSON'],
      ['spokenresult', 'true'],
      ['totaltimeout', '3'],
      ['scantimeout', '1.0'],
      ['podindex', '2'],
      ['ip', '192.0.2.4'],
      ['latlong', '42.1,-71.2'],
    ]);
    assert.equal(requests[0].headers.host, `127.0.0.1:${new URL(endpoint).port}`);
  });
});

test('Q-01 Wolfram source no-answer paths retain the input URL and omit response', async () => {
  await withWolframPeer(async ({ endpoint, state }) => {
    const provider = createWolframProvider({ endpoint, apiKey: 'fixture-key', clock: clockFactory([10, 11, 12, 13]) });
    state.body = {};
    const empty = await provider({ queryText: 'empty result', ipAddress: '127.0.0.1' });
    assert.deepEqual(empty, {
      source: 'Wolfram Alpha',
      timestamps: { wolfram_request: 10, wolfram_response: 11 },
      url: 'https://www.wolframalpha.com/input/?i=empty+result',
    });

    state.body = sourceBody({ success: false });
    const unsuccessful = await provider({ queryText: 'unsuccessful result', ipAddress: '127.0.0.1' });
    assert.deepEqual(unsuccessful, {
      source: 'Wolfram Alpha',
      timestamps: { wolfram_request: 12, wolfram_response: 13 },
      url: 'https://www.wolframalpha.com/input/?i=unsuccessful+result',
    });
  });
});

test('Q-01 Wolfram clean_answer output becomes no response without hiding source URL', async () => {
  await withWolframPeer(async ({ endpoint, state }) => {
    state.body = sourceBody({ spokenTemplate: 'The answer is {}' });
    const provider = createWolframProvider({ endpoint, apiKey: 'fixture-key', clock: clockFactory([20, 21]) });
    const output = await provider({ queryText: 'unspoken', ipAddress: '127.0.0.1' });
    assert.deepEqual(output, {
      source: 'Wolfram Alpha',
      timestamps: { wolfram_request: 20, wolfram_response: 21 },
      url: 'https://www.wolframalpha.com/input/?i=unspoken',
    });
  });
});

test('Q-01 Wolfram omits false location pair and source None app id parameters', async () => {
  await withWolframPeer(async ({ endpoint, requests, state }) => {
    state.body = sourceBody({ spokenTemplate: 'A fixture answer.' });
    const provider = createWolframProvider({ endpoint, clock: clockFactory([30, 31]) });
    await provider({ queryText: 'location absent', ipAddress: '' });
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.deepEqual([...requestUrl.searchParams.entries()], [
      ['input', 'location absent'],
      ['output', 'JSON'],
      ['spokenresult', 'true'],
      ['totaltimeout', '3'],
      ['scantimeout', '1.0'],
      ['podindex', '2'],
      ['ip', ''],
    ]);
    assert.equal(requestUrl.searchParams.has('latlong'), false);
  });
});

test('Q-01 Wolfram request/status/JSON failures are timestamped provider messages', async () => {
  await withWolframPeer(async ({ endpoint, state }) => {
    const provider = createWolframProvider({ endpoint, apiKey: 'fixture-key', clock: clockFactory([40, 41, 42, 43, 44, 45]) });
    state.status = 503;
    state.body = { error: 'upstream unavailable' };
    const httpError = await provider({ queryText: 'http failure', ipAddress: '127.0.0.1' });
    assert.equal(httpError.source, 'Wolfram Alpha');
    assert.deepEqual(httpError.timestamps, { wolfram_request: 40, wolfram_response: 41 });
    assert.equal(httpError.url, undefined);
    assert.match(httpError.message, /^Unexpected exception: Error: HTTP 503$/);

    state.status = 200;
    state.body = '{not-json';
    const malformed = await provider({ queryText: 'malformed', ipAddress: '127.0.0.1' });
    assert.equal(malformed.source, 'Wolfram Alpha');
    assert.deepEqual(malformed.timestamps, { wolfram_request: 42, wolfram_response: 43 });
    assert.equal(malformed.url, 'https://www.wolframalpha.com/input/?i=malformed');
    assert.match(malformed.message, /^Unexpected exception:/);

    const rejected = createWolframProvider({
      endpoint,
      apiKey: 'fixture-key',
      fetchImpl: async () => { throw new Error('connection refused'); },
      clock: clockFactory([44]),
    });
    const transport = await rejected({ queryText: 'transport', ipAddress: '127.0.0.1' });
    assert.deepEqual(transport.timestamps, { wolfram_request: 44 });
    assert.equal(transport.url, undefined);
    assert.match(transport.message, /^Unexpected exception: Error: connection refused$/);
  });
});

test('Q-01 Wolfram successful JSON shape failures stay outside the request catch boundary', async () => {
  await withWolframPeer(async ({ endpoint, state }) => {
    state.body = { unexpected: true };
    const provider = createWolframProvider({ endpoint, apiKey: 'fixture-key', clock: clockFactory([50, 51, 52, 53, 54, 55]) });
    await assert.rejects(
      provider({ queryText: 'malformed shape', ipAddress: '127.0.0.1' }),
      /result_json is missing 'queryresult'/,
    );

    state.body = { queryresult: {} };
    await assert.rejects(
      provider({ queryText: 'missing success', ipAddress: '127.0.0.1' }),
      /result_json\.queryresult is missing 'success'/,
    );

    state.body = sourceBody({ spokenTemplate: 42 });
    await assert.rejects(
      provider({ queryText: 'non-string answer', ipAddress: '127.0.0.1' }),
      /replace(?:All)? is not a function|Wolfram answer must be a string/,
    );
  });
});

test('Q-01 Wolfram preserves an explicit null input as an omitted source query parameter', async () => {
  await withWolframPeer(async ({ endpoint, requests, state }) => {
    state.body = sourceBody({ success: false });
    const provider = createWolframProvider({ endpoint, apiKey: 'fixture-key', clock: clockFactory([70, 71]) });
    const output = await provider({ queryText: null, ipAddress: '127.0.0.1' });
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.equal(requestUrl.searchParams.has('input'), false);
    assert.equal(output.url, undefined);
  });
});

test('Q-01 Wolfram response URL without a nonempty input omits the derived attribution URL', async () => {
  const provider = createWolframProvider({
    endpoint: 'http://fixture.invalid/wolfram',
    apiKey: 'fixture-key',
    fetchImpl: async () => ({
      status: 200,
      url: 'http://fixture.invalid/wolfram?input=',
      async json() { return sourceBody({ success: false }); },
    }),
    clock: clockFactory([60, 61]),
  });
  const output = await provider({ queryText: 'blank url', ipAddress: '127.0.0.1' });
  assert.equal(output.url, undefined);
  assert.deepEqual(output.timestamps, { wolfram_request: 60, wolfram_response: 61 });
});

test('Q-01 Wolfram direct latitude type failure remains before the request output boundary', async () => {
  await assert.rejects(
    createWolframProvider({ endpoint: 'http://fixture.invalid', apiKey: 'fixture-key' })({
      queryText: 'numeric location',
      ipAddress: '127.0.0.1',
      latitude: 42.1,
      longitude: '-71.2',
    }),
    /latitude and longitude must be strings/,
  );
});
