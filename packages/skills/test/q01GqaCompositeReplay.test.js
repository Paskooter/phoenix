import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createGqaMemoryAttributionStore,
  createGqaMultiProviderProfile,
  start,
} from '../src/index.js';

// Q-01 current-main composite replay.  The source service starts Bing and
// Wikipedia as one group, gives Bing priority, and starts Wolfram after that
// group has no answer or reaches its deadline.  These peers are deliberately
// loopback HTTP servers: the selected multi-provider profile must cross the
// actual HTTP adapters and route boundary for every provider outcome.

const FIXED_NOW = 1_700_000_000_000;
const FIRST_GROUP_TIMEOUT = 25;
const WOLFRAM_GROUP_TIMEOUT = 160;

const REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'q01-composite-request',
  ts: FIXED_NOW,
  data: {
    general: {
      accountID: 'fixture-account',
      robotID: 'fixture-robot',
      remoteAddress: '127.0.0.1',
    },
    runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
    skill: { id: 'answer', session: null },
    result: {
      nlu: { intent: 'generalWhatQuestions', entities: {} },
      asr: { text: 'what is fixture fact', confidence: 1 },
    },
  },
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function bingAnswer() {
  return {
    rankingResponse: { mainline: { items: [{ answerType: 'Facts' }] } },
    facts: {
      conversation: { spokenText: 'The Bing source answer' },
      screenshot: {
        webSearchUrl: 'https://fixture.invalid/bing-result',
        thumbnailUrl: 'https://fixture.invalid/bing-image',
      },
    },
  };
}

function wikiAnswer() {
  return {
    query: {
      pages: {
        '1': {
          title: 'Fixture fact',
          fullurl: 'https://en.wikipedia.org/wiki/Fixture_fact',
          extract: 'Fixture fact is the Wikipedia source answer.',
          categories: [],
        },
      },
    },
  };
}

function wolframAnswer() {
  return {
    queryresult: {
      success: true,
      spokenresult: { srtemplate: { sampletext: 'The Wolfram source answer' } },
    },
  };
}

function emptyBing() {
  return { rankingResponse: { mainline: { items: [] } } };
}

function emptyWiki() {
  return { query: { pages: { '-1': { title: 'Unknown fixture', missing: '' } } } };
}

function emptyWolfram() {
  return { queryresult: { success: false } };
}

function expectedProviderBody(kind, mode) {
  if (mode === 'errors') return ['error', { error: 'fixture upstream failure' }];
  if (kind === 'Bing') return ['bing', ['success', 'bing-success', 'late-bing'].includes(mode) ? bingAnswer() : emptyBing()];
  if (kind === 'Wikipedia') return ['wiki', mode === 'wiki-success' ? wikiAnswer() : emptyWiki()];
  return ['wolfram', ['wolfram-success', 'late-bing'].includes(mode) ? wolframAnswer() : emptyWolfram()];
}

async function makeProviderPeer(kind, state) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://fixture.invalid');
    const receivedAt = performance.now();
    requests.push({
      method: request.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      headers: { ...request.headers },
      receivedAt,
      mode: state.mode,
    });
    state.events.push({ kind, receivedAt });

    const delay = state.delays[kind] || 0;
    if (delay > 0) await wait(delay);

    const [, body] = expectedProviderBody(kind, state.mode);
    if (state.mode === 'errors') {
      response.writeHead(503, {
        'content-type': 'application/json',
        ...(kind === 'Bing' ? { 'BingAPIs-Market': 'en-us' } : {}),
      });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(kind === 'Bing' ? { 'BingAPIs-Market': 'en-us' } : {}),
    });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}/fixture`,
  };
}

async function makeAccountPeer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: new URL(request.url, 'http://fixture.invalid').pathname,
      headers: { ...request.headers },
      body,
      receivedAt: performance.now(),
    });
    const payload = JSON.stringify({ 'fixture-account': ['fixture-loop'] });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}/accounts`,
  };
}

async function withFixture(callback, { mode = 'bing-success', delays = {} } = {}) {
  const state = { mode, delays, events: [] };
  const [bing, wikipedia, wolfram, account] = await Promise.all([
    makeProviderPeer('Bing', state),
    makeProviderPeer('Wikipedia', state),
    makeProviderPeer('Wolfram Alpha', state),
    makeAccountPeer(),
  ]);
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  const env = {
    ETCO_gqa_bingApi: bing.endpoint,
    ETCO_gqa_bingKey: 'fixture-bing-key',
    ETCO_gqa_wikiApi: wikipedia.endpoint,
    ETCO_gqa_wolframApi: wolfram.endpoint,
    ETCO_gqa_wolframKey: 'fixture-wolfram-key',
    ETCO_server_accountService: account.endpoint,
  };
  const service = await start(0, {
    gqaProfile: 'multi-provider',
    gqaEnvironment: env,
    gqaConfig: {
      attribution,
      random: () => 0,
      timeouts: [FIRST_GROUP_TIMEOUT, WOLFRAM_GROUP_TIMEOUT],
    },
  });
  try {
    return await callback({
      state,
      service,
      attribution,
      peers: { bing, wikipedia, wolfram, account },
      baseUrl: `http://127.0.0.1:${service.address().port}`,
    });
  } finally {
    await closeServer(service);
    // Late provider workers are intentionally detached by the source pipeline;
    // let them settle before closing their loopback peers.
    await wait(Math.max(...Object.values(delays), 0) + 10);
    await Promise.all([bing, wikipedia, wolfram, account].map(({ server }) => closeServer(server)));
  }
}

async function post(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jibo-transid': 'q01-composite-trans', ...headers },
    body: JSON.stringify(body),
  });
  const rawBody = await response.text();
  return {
    response,
    rawBody,
    body: JSON.parse(rawBody),
  };
}

function jcp(body) {
  return body.data.action.config.jcp;
}

function actionText(body) {
  return jcp(body).config.play.esml;
}

function assertCommonSourceResponse({ body, sourceTiming }) {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.skill.id, 'answer');
  assert.equal(body.data.skill.version, '5.2.15');
  assert.equal(body.data.action.type, 'JCP');
  assert.equal(body.data.action.config.version, '2.0');
  assert.equal(jcp(body).type, 'SLIM');
  assert.equal(jcp(body).config.play.type, 'PLAY');
  assert.equal(body.data.final, true);
  assert.equal(body.data.fireAndForget, true);
  assert.equal(typeof body.timings.total, 'number');
  assert.ok(Number.isFinite(body.timings.total));
  assert.equal(typeof body.timings.initialization_part, 'number');
  assert.equal(typeof body.timings.finalization_part, 'number');
  assert.equal(typeof body.timings[sourceTiming], 'number');
  assert.ok(Number.isFinite(body.timings[sourceTiming]));
  assert.deepEqual(body.data.analytics.answer[0], {
    event: 'Skill Entry',
    properties: {
      initial_intent: 'n/a',
      domain: '',
      was_hey_jibo_launch: true,
      user_initiated: true,
      last_skill: 'n/a',
    },
  });
}

function assertSourceAnswer(body, { source, text, category, sourceTiming }) {
  assertCommonSourceResponse({ body, sourceTiming });
  assert.equal(actionText(body), text);
  assert.equal(jcp(body).config.play.meta.prompt_id, source);
  assert.deepEqual(body.data.analytics.answer[1], {
    event: 'Answer Query',
    properties: {
      success: true,
      type: source.toLowerCase() === 'wikipedia' ? 'wiki' : source.toLowerCase().startsWith('wolfram') ? 'wolfram' : 'bing',
      ...(category ? { category } : {}),
    },
  });
  assert.equal(jcp(body).config.display, undefined);
}

function assertNoAnswer(body) {
  assertCommonSourceResponse({ body, sourceTiming: 'total' });
  assert.equal(jcp(body).config.play.meta.prompt_id, 'GQA_no_answer_what_01');
  const display = jcp(body).config.display;
  assert.equal(display.type, 'DISPLAY');
  assert.equal(display.name, 'GQA_NO_ANSWER_VIEW');
  assert.equal(display.visible, true);
  assert.equal(display.keepDisplay, false);
  assert.equal(display.view.type, 'SKILL');
  assert.equal(display.view.name, 'MIM_VIEW');
  assert.equal(display.view.context.type, 'Javascript');
  const view = JSON.parse(display.view.context.data);
  assert.equal(view.viewConfig.id, 'helpful_gqa_text');
  assert.equal(view.componentConfigs[0].type, 'Label');
  assert.equal(view.componentConfigs[0].text, '"what is fixture fact"');
  assert.deepEqual(body.data.analytics.answer[1], {
    event: 'Answer Query',
    properties: { success: false },
  });
}

function assertProviderRequests(peers, { bing = 1, wikipedia = 1, wolfram = 0 } = {}) {
  assert.equal(peers.bing.requests.length, bing);
  assert.equal(peers.wikipedia.requests.length, wikipedia);
  assert.equal(peers.wolfram.requests.length, wolfram);
  if (bing > 0) {
    assert.equal(peers.bing.requests[0].method, 'GET');
    assert.equal(peers.bing.requests[0].query.q, 'what is fixture fact');
    assert.equal(peers.bing.requests[0].query.mkt, 'en-US');
    assert.equal(peers.bing.requests[0].headers['x-msedge-clientip'], '127.0.0.1');
    assert.equal(peers.bing.requests[0].headers['x-search-location'], 'lat:42.1,long:-71.2,re:22');
  }
  if (wikipedia > 0) {
    assert.equal(peers.wikipedia.requests[0].query.titles, 'fixture fact');
    assert.equal(peers.wikipedia.requests[0].query.action, 'query');
    assert.match(peers.wikipedia.requests[0].headers['user-agent'], /wikipedia/i);
  }
  if (wolfram > 0) {
    assert.equal(peers.wolfram.requests[0].query.input, 'what is fixture fact');
    assert.equal(peers.wolfram.requests[0].query.totaltimeout, '3');
    assert.equal(peers.wolfram.requests[0].query.scantimeout, '1.0');
    assert.equal(peers.wolfram.requests[0].query.podindex, '2');
  }
}

test('Q-01 composite success replays selected HTTP profile, account lookup, attribution, MIM/JCP and source wire media', async () => {
  await withFixture(async ({ service, baseUrl, peers, attribution }) => {
    const result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('content-type'), 'text/html; charset=utf-8');
    assertSourceAnswer(result.body, {
      source: 'Bing',
      text: 'The Bing source answer.',
      category: 'facts',
      sourceTiming: 'bing',
    });
    assertProviderRequests(peers);
    assert.equal(peers.wolfram.requests.length, 0, 'lower-priority Wolfram must not run after Bing answer');

    assert.equal(peers.account.requests.length, 1);
    assert.equal(peers.account.requests[0].method, 'POST');
    assert.equal(peers.account.requests[0].path, '/accounts');
    assert.equal(peers.account.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(peers.account.requests[0].body), { accountsIds: ['fixture-account'] });
    assert.ok(
      peers.account.requests[0].receivedAt
        < Math.min(peers.bing.requests[0].receivedAt, peers.wikipedia.requests[0].receivedAt),
      'source account lookup must complete before provider dispatch',
    );
    assert.deepEqual(attribution.snapshot(), [{
      service: 'Bing',
      query: 'The Bing source answer.',
      url: 'https://fixture.invalid/bing-result',
      image_url: 'https://fixture.invalid/bing-image',
      loop_id: 'fixture-loop',
      timestamp: FIXED_NOW,
    }]);

    const retrieve = await post(baseUrl, '/retrieveAtt', { Service: 'Bing' }, {
      'x-amz-credentials': JSON.stringify({ id: 'fixture-account' }),
    });
    assert.equal(retrieve.response.status, 200);
    assert.equal(retrieve.response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(retrieve.body.data, attribution.snapshot());

    const wipe = await post(baseUrl, '/wipeID', { ID: 'fixture-loop' });
    assert.equal(wipe.response.status, 200);
    assert.equal(wipe.response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(wipe.body, { deleted_row: 1 });
    assert.deepEqual(attribution.snapshot(), []);

    // The source `/answer_skill/v1/main` route fails closed on a missing
    // transID before invoking a provider.  Keep its Flask-era text media type.
    const missingTransId = await fetch(`${baseUrl}/answer_skill/v1/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });
    assert.equal(missingTransId.status, 400);
    assert.equal(missingTransId.headers.get('content-type'), 'text/html');
    assert.equal(await missingTransId.text(), '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
      + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
      + '<p>Missing X-JIBO-transID header</p>\n');

    // A missing selected path stays outside the service registry.
    const missingEndpoint = await fetch(`${baseUrl}/answer_skill/v1/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jibo-transid': 'q01-missing' },
      body: JSON.stringify(REQUEST),
    });
    assert.equal(missingEndpoint.status, 404);
    const missingBody = await missingEndpoint.json();
    assert.equal(missingBody.type, 'ERROR');
    assert.equal(missingBody.final, true);
    assert.equal(missingBody.data.message, 'URL not found: /answer_skill/v1/missing');
  });
});

test('Q-01 composite provider replay enforces Bing priority, Wikipedia fallback, Wolfram fallback and late priority', async () => {
  await withFixture(async ({ baseUrl, peers, state }) => {
    let result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assertSourceAnswer(result.body, {
      source: 'Bing', text: 'The Bing source answer.', category: 'facts', sourceTiming: 'bing',
    });
    assertProviderRequests(peers, { bing: 1, wikipedia: 1, wolfram: 0 });

    state.mode = 'wiki-success';
    result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assertSourceAnswer(result.body, {
      source: 'Wikipedia', text: 'Fixture fact is the Wikipedia source answer.', sourceTiming: 'wiki',
    });
    assertProviderRequests(peers, { bing: 2, wikipedia: 2, wolfram: 0 });

    state.mode = 'wolfram-success';
    result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assertSourceAnswer(result.body, {
      source: 'Wolfram Alpha', text: 'The Wolfram source answer.', sourceTiming: 'wolfram',
    });
    assertProviderRequests(peers, { bing: 3, wikipedia: 3, wolfram: 1 });
    const wolframEvent = state.events.findIndex(({ kind }) => kind === 'Wolfram Alpha');
    assert.ok(wolframEvent > state.events.findIndex(({ kind }, index) => kind === 'Bing' && index < wolframEvent));
    assert.ok(wolframEvent > state.events.findIndex(({ kind }, index) => kind === 'Wikipedia' && index < wolframEvent));

    state.mode = 'late-bing';
    state.delays.Bing = 55;
    state.delays['Wolfram Alpha'] = 90;
    result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assertSourceAnswer(result.body, {
      source: 'Bing', text: 'The Bing source answer.', category: 'facts', sourceTiming: 'bing',
    });
    assertProviderRequests(peers, { bing: 4, wikipedia: 4, wolfram: 2 });
    assert.ok(result.body.timings.total >= FIRST_GROUP_TIMEOUT, 'late answer must cross the first group deadline');
  }, { mode: 'bing-success' });
});

test('Q-01 composite empty and error replays emit source no-answer MIM/display with no provider answer leak', async () => {
  await withFixture(async ({ baseUrl, peers, state }) => {
    let result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('content-type'), 'text/html; charset=utf-8');
    assertNoAnswer(result.body);
    assertProviderRequests(peers, { bing: 1, wikipedia: 1, wolfram: 1 });

    state.mode = 'errors';
    result = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assert.equal(result.response.status, 200);
    assertNoAnswer(result.body);
    assertProviderRequests(peers, { bing: 2, wikipedia: 2, wolfram: 2 });
    assert.equal(result.body.data.action.config.jcp.config.play.esml.includes('fixture upstream failure'), false);
  }, { mode: 'empty' });
});

test('Q-01 composite Wolfram attribution is source-backed and retrieve/wipe remains HTTP-visible', async () => {
  await withFixture(async ({ baseUrl, peers, attribution, state }) => {
    const bingResult = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assertSourceAnswer(bingResult.body, {
      source: 'Bing', text: 'The Bing source answer.', category: 'facts', sourceTiming: 'bing',
    });
    assert.equal(peers.bing.requests[0].query.q, 'what is fixture fact');

    state.mode = 'wolfram-success';
    const wolframResult = await post(baseUrl, '/answer_skill/v1/main', REQUEST);
    assertSourceAnswer(wolframResult.body, {
      source: 'Wolfram Alpha', text: 'The Wolfram source answer.', sourceTiming: 'wolfram',
    });
    assertProviderRequests(peers, { bing: 2, wikipedia: 2, wolfram: 1 });
    assert.equal(attribution.snapshot().length, 2);
    assert.deepEqual(attribution.snapshot().map(({ service, query, url, image_url, loop_id }) => (
      { service, query, url, image_url, loop_id }
    )), [
      {
        service: 'Bing',
        query: 'The Bing source answer.',
        url: 'https://fixture.invalid/bing-result',
        image_url: 'https://fixture.invalid/bing-image',
        loop_id: 'fixture-loop',
      },
      {
        service: 'Wolfram Alpha',
        query: 'The Wolfram source answer.',
        url: 'https://www.wolframalpha.com/input/?i=what+is+fixture+fact',
        image_url: null,
        loop_id: 'fixture-loop',
      },
    ]);

    const retrieve = await post(baseUrl, '/retrieveAtt', {}, {
      'x-amz-credentials': JSON.stringify({ id: 'fixture-account' }),
    });
    assert.equal(retrieve.response.status, 200);
    assert.deepEqual(retrieve.body.data, attribution.snapshot());
    const wipe = await post(baseUrl, '/wipeID', { ID: 'fixture-loop' });
    assert.equal(wipe.response.status, 200);
    assert.deepEqual(wipe.body, { deleted_row: 2 });
    assert.deepEqual(attribution.snapshot(), []);
  }, { mode: 'bing-success' });
});

test('Q-01 composite selected profile rejects any missing provider endpoint before opening a listener', () => {
  assert.throws(
    () => createGqaMultiProviderProfile({
      bing: { endpoint: 'http://fixture.invalid/bing' },
      wikipedia: { endpoint: 'http://fixture.invalid/wiki' },
      wolfram: {},
    }),
    /GQA Wolfram Alpha endpoint must be configured explicitly/,
  );
  assert.throws(
    () => start(0, { gqaProfile: 'multi-provider', gqaEnvironment: {} }),
    /Bing endpoint must be configured explicitly/,
  );
});
