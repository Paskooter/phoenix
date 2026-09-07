import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createGqaMultiProviderProfile,
  createGqaMultiProviderService,
  readGqaMultiProviderProfileConfig,
} from '../src/gqaMultiProviderService.js';
import { start } from '../src/index.js';

const REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'multi-profile-request',
  ts: 1700000000000,
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
      asr: { text: 'what is a fixture fact', confidence: 1 },
    },
  },
};

function deepRequest() {
  return structuredClone(REQUEST);
}

function bingAnswer() {
  return {
    rankingResponse: { mainline: { items: [{ answerType: 'Facts' }] } },
    facts: { conversation: { spokenText: 'The Bing fixture answer' } },
  };
}

function wikiAnswer() {
  return {
    query: {
      pages: {
        '1': {
          title: 'Fixture fact',
          fullurl: 'https://en.wikipedia.org/wiki/Fixture_fact',
          extract: 'The Wikipedia fixture answer.',
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
      spokenresult: { srtemplate: { sampletext: 'The Wolfram fixture answer' } },
    },
  };
}

function noBingAnswer() {
  return { rankingResponse: { mainline: { items: [] } } };
}

function noWikiAnswer() {
  return { query: { pages: { '-1': { title: 'Unknown fixture', missing: '' } } } };
}

function noWolframAnswer() {
  return { queryresult: { success: false } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPeer(kind, state) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://fixture.invalid');
    requests.push({
      kind,
      sequence: state.events.length,
      method: request.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      at: performance.now(),
    });
    state.events.push({ kind, at: performance.now() });
    const delay = state.delays[kind] || 0;
    if (delay > 0) await wait(delay);

    if (state.mode === 'errors') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture upstream failure' }));
      return;
    }

    let body;
    if (kind === 'Bing') {
      body = state.mode === 'bing-success' || state.mode === 'all-success'
        || state.mode === 'late-bing' ? bingAnswer() : noBingAnswer();
      response.writeHead(200, {
        'content-type': 'application/json',
        'BingAPIs-Market': 'en-us',
      });
    } else if (kind === 'Wikipedia') {
      body = state.mode === 'wiki-success' || state.mode === 'all-success'
        ? wikiAnswer() : noWikiAnswer();
      response.writeHead(200, { 'content-type': 'application/json' });
    } else {
      body = state.mode === 'wolfram-success' || state.mode === 'late-bing'
        ? wolframAnswer() : noWolframAnswer();
      response.writeHead(200, { 'content-type': 'application/json' });
    }
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}/fixture`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withPeers(callback, { mode = 'all-success', delays = {} } = {}) {
  const state = { mode, delays, events: [] };
  const peers = await Promise.all([
    createPeer('Bing', state),
    createPeer('Wikipedia', state),
    createPeer('Wolfram Alpha', state),
  ]);
  const peerMap = {
    bing: peers[0],
    wikipedia: peers[1],
    wolfram: peers[2],
  };
  try {
    return await callback({
      state,
      peers: peerMap,
      ...peerMap,
    });
  } finally {
    await Promise.all(Object.values(peerMap).map(({ server }) => closeServer(server)));
  }
}

function makeProfile({ peers, timeouts } = {}) {
  return createGqaMultiProviderProfile({
    bing: { endpoint: peers.bing.endpoint, apiKey: 'fixture-bing-key' },
    wikipedia: { endpoint: peers.wikipedia.endpoint },
    wolfram: { endpoint: peers.wolfram.endpoint, apiKey: 'fixture-wolfram-key' },
    timeouts,
    random: () => 0,
  });
}

async function post(server, body = deepRequest()) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/answer_skill/v1/main`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-jibo-transid': 'fixture-trans',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function actionText(body) {
  return body.data.action.config.jcp.config.play.esml;
}

function assertSourceAction(body, source, text, analytics) {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.skill.id, 'answer');
  assert.equal(body.data.skill.version, '5.2.15');
  assert.equal(body.data.action.type, 'JCP');
  assert.equal(body.data.action.config.jcp.type, 'SLIM');
  assert.equal(actionText(body), text);
  assert.equal(body.data.final, true);
  assert.equal(body.data.fireAndForget, true);
  assert.deepEqual(body.data.analytics.answer[1].properties, analytics || {
    success: true,
    type: source,
  });
  assert.equal(typeof body.timings.total, 'number');
  assert.ok(Number.isFinite(body.timings.total));
}

function assertNoAnswer(body) {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.action.config.jcp.config.play.type, 'PLAY');
  assert.equal(body.data.action.config.jcp.config.display.type, 'DISPLAY');
  assert.equal(body.data.analytics.answer[1].properties.success, false);
  assert.equal(typeof body.timings.total, 'number');
}

test('Q-01 multi-provider profile requires explicit endpoints and preserves source group deadlines', () => {
  assert.deepEqual(readGqaMultiProviderProfileConfig({
    ETCO_gqa_bingApi: 'http://fixture.invalid/bing',
    ETCO_gqa_bingKey: 'bing-key',
    ETCO_gqa_wikiApi: 'http://fixture.invalid/wiki',
    ETCO_gqa_wolframApi: 'http://fixture.invalid/wolfram',
    ETCO_gqa_wolframKey: 'wolfram-key',
    ETCO_gqa_providerTimeoutMs: '3000',
    ETCO_gqa_wolframGroupTimeoutMs: '4000',
  }), {
    bing: { endpoint: 'http://fixture.invalid/bing', apiKey: 'bing-key', timeoutMs: undefined },
    wikipedia: { endpoint: 'http://fixture.invalid/wiki', timeoutMs: undefined, userAgent: undefined },
    wolfram: { endpoint: 'http://fixture.invalid/wolfram', apiKey: 'wolfram-key' },
    timeouts: [3000, 4000],
  });
  assert.throws(
    () => createGqaMultiProviderProfile({
      bing: { endpoint: 'http://fixture.invalid/bing' },
      wikipedia: { endpoint: 'http://fixture.invalid/wiki' },
      wolfram: {},
    }),
    /Wolfram Alpha endpoint must be configured explicitly/,
  );
});

test('Q-01 multi-provider profile is selectable through the explicit host profile', async () => {
  await withPeers(async ({ peers }) => {
    const server = await start(0, {
      gqaProfile: 'multi-provider',
      gqaEnvironment: {
        ETCO_gqa_bingApi: peers.bing.endpoint,
        ETCO_gqa_bingKey: 'fixture-bing-key',
        ETCO_gqa_wikiApi: peers.wikipedia.endpoint,
        ETCO_gqa_wolframApi: peers.wolfram.endpoint,
        ETCO_gqa_wolframKey: 'fixture-wolfram-key',
      },
      gqaConfig: { random: () => 0 },
    });
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertSourceAction(result.body, 'bing', 'The Bing fixture answer.', {
        success: true,
        type: 'bing',
        category: 'facts',
      });
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 0);
    } finally {
      await closeServer(server);
    }
  });
});

test('Q-01 multi-provider profile selects Bing before simultaneous Wikipedia and skips Wolfram', async () => {
  await withPeers(async ({ peers }) => {
    const service = createGqaMultiProviderService({ profile: makeProfile({ peers }) });
    const server = await service.listen(0);
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertSourceAction(result.body, 'bing', 'The Bing fixture answer.', {
        success: true,
        type: 'bing',
        category: 'facts',
      });
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 0);
      assert.equal(peers.bing.requests[0].query.q, 'what is a fixture fact');
      assert.equal(peers.bing.requests[0].query.mkt, 'en-US');
      assert.equal(peers.wikipedia.requests[0].query.titles, 'fixture fact');
    } finally {
      await closeServer(server);
    }
  });
});

test('Q-01 multi-provider profile falls through to Wikipedia after Bing no-answer', async () => {
  await withPeers(async ({ peers }) => {
    const service = createGqaMultiProviderService({
      profile: makeProfile({ peers }),
    });
    const server = await service.listen(0);
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertSourceAction(result.body, 'wiki', 'The Wikipedia fixture answer.');
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 0);
      assert.ok(peers.bing.requests[0].sequence < peers.wikipedia.requests[0].sequence);
    } finally {
      await closeServer(server);
    }
  }, { mode: 'wiki-success' });
});

test('Q-01 multi-provider profile starts Wolfram only after the first group has no answer', async () => {
  await withPeers(async ({ peers, state }) => {
    const service = createGqaMultiProviderService({ profile: makeProfile({ peers }) });
    const server = await service.listen(0);
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertSourceAction(result.body, 'wolfram', 'The Wolfram fixture answer.');
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 1);
      const wolframEvent = state.events.findIndex(({ kind }) => kind === 'Wolfram Alpha');
      assert.ok(wolframEvent > state.events.findIndex(({ kind }) => kind === 'Bing'));
      assert.ok(wolframEvent > state.events.findIndex(({ kind }) => kind === 'Wikipedia'));
      assert.equal(peers.wolfram.requests[0].query.input, 'what is a fixture fact');
      assert.equal(peers.wolfram.requests[0].query.totaltimeout, '3');
      assert.equal(peers.wolfram.requests[0].query.scantimeout, '1.0');
    } finally {
      await closeServer(server);
    }
  }, { mode: 'wolfram-success' });
});

test('Q-01 multi-provider profile preserves a late higher-priority answer over Wolfram', { timeout: 3000 }, async () => {
  await withPeers(async ({ peers }) => {
    const service = createGqaMultiProviderService({
      profile: makeProfile({ peers, timeouts: [25, 120] }),
    });
    const server = await service.listen(0);
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertSourceAction(result.body, 'bing', 'The Bing fixture answer.', {
        success: true,
        type: 'bing',
        category: 'facts',
      });
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 1);
    } finally {
      await closeServer(server);
      await wait(70);
    }
  }, { mode: 'late-bing', delays: { Bing: 45, 'Wolfram Alpha': 70 } });
});

test('Q-01 multi-provider profile maps all provider failures to source no-answer recovery', async () => {
  await withPeers(async ({ peers }) => {
    const service = createGqaMultiProviderService({ profile: makeProfile({ peers }) });
    const server = await service.listen(0);
    try {
      const result = await post(server);
      assert.equal(result.response.status, 200);
      assertNoAnswer(result.body);
      assert.equal(peers.bing.requests.length, 1);
      assert.equal(peers.wikipedia.requests.length, 1);
      assert.equal(peers.wolfram.requests.length, 1);
    } finally {
      await closeServer(server);
    }
  }, { mode: 'errors' });
});
