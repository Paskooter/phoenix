import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  BING_SOURCE_CONFIG_KEY,
  BING_SOURCE_MODULE,
  BING_SOURCE_REVISION,
  bingProviderContract,
  createBingProvider,
  extractBingSpokenAnswer,
} from '../src/gqaBingProvider.js';
import {
  SOURCE_UNIDECODE_DATA,
} from '../src/gqaUnidecodeFilterData.js';
import { unidecodeForBingFilter } from '../src/gqaUnidecodeFilter.js';

function answerBody(answerType = 'Facts', spokenText = 'The fixture answer.') {
  const key = answerType.slice(0, 1).toLowerCase() + answerType.slice(1);
  return {
    rankingResponse: { mainline: { items: [{ answerType }] } },
    [key]: { conversation: { spokenText } },
  };
}

function withScreenshot(body, kind = 'Facts') {
  const key = kind.slice(0, 1).toLowerCase() + kind.slice(1);
  const answer = body[key];
  const screenshot = {
    webSearchUrl: 'https://fixture.invalid/search?q=fixture',
    thumbnailUrl: 'https://fixture.invalid/thumb.jpg',
  };
  if (kind === 'Entities') answer.value = [{ screenshot }];
  else if (kind === 'SportsTeam') answer.value = { matches: [{ screenshot }] };
  else answer.screenshot = screenshot;
  return body;
}

async function withBingPeer(callback) {
  const requests = [];
  const state = {
    status: 200,
    headers: { 'content-type': 'application/json', 'BingAPIs-Market': 'en-us' },
    body: answerBody(),
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
  const endpoint = `http://127.0.0.1:${server.address().port}/bing`;
  try {
    return await callback({ endpoint, requests, state });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function tickingClock(start = 1000) {
  let tick = start;
  return () => tick++;
}

test('Q-01 Bing exports identify the recovered source contract', () => {
  assert.equal(BING_SOURCE_REVISION, 'ebe1a7d38f511570060c1fbf61bec89d58419b26');
  assert.equal(BING_SOURCE_MODULE, 'gqa/bing.py');
  assert.equal(BING_SOURCE_CONFIG_KEY, 'bing_api');
  assert.deepEqual(bingProviderContract.licensing, 'US/US territories and Canada only; unsupported countries stop before HTTP');
});

test('Q-01 Bing success preserves request parameters, location headers, and screenshot output', async () => {
  await withBingPeer(async ({ endpoint, requests, state }) => {
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key', clock: tickingClock() });
    const body = withScreenshot(answerBody('Facts', 'The fixture answer.'), 'Facts');
    // The peer is mutable so this case uses the exact response shape under test.
    // `requests` is still captured before the response is sent.
    state.body = body;
    const output = await provider({
      queryText: 'what is a fixture?',
      countryCode: 'US',
      ipAddress: '192.0.2.4',
      latitude: '42.1',
      longitude: '-71.2',
    });
    assert.equal(output.source, 'Bing');
    assert.deepEqual(output.response, { type: 'string', payload: 'The fixture answer.' });
    assert.equal(output.type, 'facts');
    assert.equal(output.url, 'https://fixture.invalid/search?q=fixture');
    assert.equal(output.image_url, 'https://fixture.invalid/thumb.jpg');
    assert.deepEqual(output.timestamps, { bing_request: 1000, bing_response: 1001 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].body, '');
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.equal(requestUrl.pathname, '/bing');
    assert.deepEqual([...requestUrl.searchParams.entries()], [
      ['q', 'what is a fixture?'],
      ['appid', 'fixture-key'],
      ['screenshotstyle', 'small'],
      ['conversation', 'true'],
      ['responseFilter', 'knowledge'],
      ['mkt', 'en-US'],
    ]);
    assert.equal(requests[0].headers['x-msedge-clientip'], '192.0.2.4');
    assert.equal(requests[0].headers['x-search-location'], 'lat:42.1,long:-71.2,re:22');
  });
});

test('Q-01 Bing fallback URL uses the response query when no screenshot is present', async () => {
  await withBingPeer(async ({ endpoint, state }) => {
    state.body = answerBody('Facts', 'The fixture answer.');
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key', clock: tickingClock(10) });
    const output = await provider({ queryText: 'what is a fixture', countryCode: 'US' });
    assert.equal(output.url, 'https://www.bing.com/search?q=what+is+a+fixture');
    assert.equal(output.image_url, undefined);
  });
});

test('Q-01 Bing projects source image locations for Entities and SportsTeam', () => {
  const entities = withScreenshot(answerBody('Entities'), 'Entities');
  const sports = withScreenshot(answerBody('SportsTeam'), 'SportsTeam');
  for (const value of [entities, sports]) {
    assert.deepEqual(extractBingSpokenAnswer(value, 'en-US'), {
      response: { type: 'string', payload: 'The fixture answer.' },
      type: value === entities ? 'entities' : 'sportsTeam',
      url: 'https://fixture.invalid/search?q=fixture',
      image_url: 'https://fixture.invalid/thumb.jpg',
    });
  }
});

test('Q-01 Bing returns an empty source result for empty and blacklisted answer types', async () => {
  await withBingPeer(async ({ endpoint, state }) => {
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key', clock: tickingClock() });
    state.body = {};
    const empty = await provider({ queryText: 'what is empty', countryCode: 'US' });
    assert.deepEqual(empty, {
      source: 'Bing',
      timestamps: { bing_request: 1000, bing_response: 1001 },
    });
    state.body = answerBody('WebPages', 'A web result.');
    const blacklisted = await provider({ queryText: 'what is web', countryCode: 'US' });
    assert.equal(blacklisted.response, undefined);
    assert.equal(blacklisted.message, undefined);
    // The source adds a generic Bing search URL after any parsed non-empty
    // response when the decoder did not provide a screenshot URL.
    assert.deepEqual(Object.keys(blacklisted), ['source', 'timestamps', 'url']);
    assert.equal(blacklisted.url, 'https://www.bing.com/search?q=what+is+web');
  });
});

test('Q-01 Bing suppresses source boilerplate and parenthesized text without changing Unicode output', () => {
  const body = answerBody(
    'Facts',
    "The answer (from Bing) is café. You'll find more in your Cortana app history.",
  );
  assert.deepEqual(extractBingSpokenAnswer(body, 'en-US'), {
    response: { type: 'string', payload: 'The answer  is café.' },
    type: 'facts',
  });
  assert.deepEqual(extractBingSpokenAnswer(answerBody('Facts', 'I found this.')), {});
  assert.deepEqual(extractBingSpokenAnswer(answerBody('Facts', '北京的答案。'), 'en-US').response, {
    type: 'string',
    payload: '北京的答案。',
  });
});

test('Q-01 Bing uses the source Unidecode decision boundary for ignored and transliterated Unicode', () => {
  assert.deepEqual(SOURCE_UNIDECODE_DATA, {
    version: '1.0.22',
    sourceWheelSha256: '72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582',
    sourceLicense: 'GPLv2+ (source data provenance; lead review required)',
    emptyRangeCount: 215,
    prefixReplacementCount: 8511,
  });
  assert.equal(unidecodeForBingFilter('😀'), '');
  assert.equal(unidecodeForBingFilter('\ue000\ufeff\u2060'), '');
  assert.equal(unidecodeForBingFilter('Ι fοund thіs'), 'I found this');
  assert.equal(unidecodeForBingFilter('北京'), '\u0001\u0001');

  for (const spokenText of [
    '😀',
    '\ue000',
    '\ufeff',
    '\u2060',
    'Ι found this',
    'І found thіs',
    '😀I found this',
    'I 😀found this',
    '\ue000...',
  ]) {
    assert.deepEqual(extractBingSpokenAnswer(answerBody('Facts', spokenText), 'en-US'), {}, spokenText);
  }
  assert.deepEqual(extractBingSpokenAnswer(answerBody('Facts', 'Moist sang \u0378 (Heart) Is'), 'en-US').response, {
    type: 'string',
    payload: 'Moist sang \u0378  Is',
  });
  assert.deepEqual(extractBingSpokenAnswer(answerBody('Facts', '北京'), 'en-US').response, {
    type: 'string',
    payload: '北京',
  });
});

test('Q-01 Bing applies country gates before HTTP and Canada answer licensing after HTTP', async () => {
  await withBingPeer(async ({ endpoint, requests, state }) => {
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key' });
    const missing = await provider({ queryText: 'what is x', countryCode: '' });
    assert.deepEqual(missing, { message: 'Unable to determine country, which is required to use Bing' });
    const unsupported = await provider({ queryText: 'what is x', countryCode: 'de' });
    assert.deepEqual(unsupported, { message: "Not licensed to use Bing in country with code 'DE'" });
    assert.equal(requests.length, 0);

    state.body = answerBody('FoodAndDrink');
    state.headers['BingAPIs-Market'] = 'en-ca';
    const canada = await provider({ queryText: 'what is poutine', countryCode: 'CA' });
    assert.equal(canada.source, 'Bing');
    assert.equal(canada.message, "Bing answer type 'FoodAndDrink' not licensed for use in Canada");
    assert.equal(canada.response, undefined);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url, endpoint).searchParams.get('mkt'), 'en-CA');
  });
});

test('Q-01 Bing reports unknown answer types using the returned market', async () => {
  await withBingPeer(async ({ endpoint, state }) => {
    state.body = answerBody('News');
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key' });
    const us = await provider({ queryText: 'what is news', countryCode: 'US' });
    assert.equal(us.message, "Unknown Bing answer type 'News'");

    state.headers['BingAPIs-Market'] = 'en-ca';
    const mismatch = await provider({ queryText: 'what is news', countryCode: 'US' });
    assert.equal(mismatch.message, "Bing answer type 'News' not licensed for use in Canada");
  });
});

test('Q-01 Bing preserves source request/parse failures as a timestamped provider message', async () => {
  await withBingPeer(async ({ endpoint, state }) => {
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key', clock: tickingClock(50) });
    state.status = 503;
    state.body = { error: { message: 'upstream unavailable' } };
    const httpError = await provider({ queryText: 'what is unavailable', countryCode: 'US' });
    assert.equal(httpError.source, 'Bing');
    assert.deepEqual(Object.keys(httpError.timestamps), ['bing_request', 'bing_response']);
    assert.match(httpError.message, /^Unexpected exception: Error: HTTP 503$/);

    state.status = 200;
    state.body = '{not-json';
    const malformed = await provider({ queryText: 'what is malformed', countryCode: 'US' });
    assert.equal(malformed.source, 'Bing');
    assert.match(malformed.message, /^Unexpected exception:/);
    assert.deepEqual(Object.keys(malformed.timestamps), ['bing_request', 'bing_response']);
  });
});

test('Q-01 Bing keeps a missing response market header as an uncaught decoder boundary', async () => {
  await withBingPeer(async ({ endpoint, state }) => {
    delete state.headers['BingAPIs-Market'];
    const provider = createBingProvider({ endpoint, apiKey: 'fixture-key' });
    await assert.rejects(
      provider({ queryText: 'what is missing market', countryCode: 'US' }),
      /Bing response is missing 'BingAPIs-Market'/,
    );
  });
});

test('Q-01 Bing honors an explicit caller abort without awaiting the response', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (!response.destroyed) {
      const raw = JSON.stringify(answerBody());
      response.writeHead(200, { 'BingAPIs-Market': 'en-us', 'content-length': Buffer.byteLength(raw) });
      response.end(raw);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const provider = createBingProvider({
      endpoint: `http://127.0.0.1:${server.address().port}/bing`,
      apiKey: 'fixture-key',
    });
    const pending = provider({ queryText: 'what is late', countryCode: 'US', signal: controller.signal });
    for (let attempt = 0; attempt < 50 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    controller.abort();
    const output = await pending;
    assert.equal(output.source, 'Bing');
    assert.match(output.message, /^Unexpected exception:/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
