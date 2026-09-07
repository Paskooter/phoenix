import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGqaWikipediaService, readGqaWikipediaProfileConfig } from '../src/gqaWikipediaService.js';
import { buildComponents, createGateway } from '../../gateway/src/index.js';
import { loadConfig } from '../../gateway/src/config.js';
import { start } from '../src/index.js';

function page({
  title = 'Fixture fact',
  extract = 'Fixture fact is a fixture fact.',
  categories = [],
  pageprops,
  disambiguationOptions,
  missing,
} = {}) {
  const value = {
    title,
    extract,
    categories: categories.map((category) => ({ title: `Category:${category}` })),
  };
  if (pageprops) value.pageprops = pageprops;
  if (disambiguationOptions) value.disambiguationOptions = disambiguationOptions;
  if (missing !== undefined) value.missing = missing;
  return { query: { pages: { '1': value } } };
}

function requestBody(text = 'what is Fixture fact') {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'profile-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'fixture-account',
        robotID: 'fixture-robot',
        remoteAddress: '127.0.0.1',
      },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
      skill: { id: 'answer', session: { id: 'session-1', nodeID: 3, data: {}, trace: [] } },
      result: {
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text, confidence: 1 },
      },
    },
  };
}

async function withApiPeer(callback) {
  const requests = [];
  let scenario = 'success';
  const server = createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://fixture.invalid');
    requests.push({ scenario, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
    if (scenario === 'late') await new Promise((resolve) => setTimeout(resolve, 90));
    let status = 200;
    let raw;
    if (scenario === 'malformed') raw = '{not-json';
    else if (scenario === 'http-error') {
      status = 502;
      raw = JSON.stringify({ error: { info: 'fixture upstream failure' } });
    } else if (scenario === 'missing') raw = JSON.stringify(page({ title: 'Unknown fixture', extract: '', missing: '' }));
    else if (scenario === 'disambiguation') {
      const title = parsed.searchParams.get('titles');
      raw = JSON.stringify(title === 'Mercury'
        ? page({
          title,
          extract: '',
          pageprops: { disambiguation: '' },
          disambiguationOptions: ['Mercury (planet)', 'Mercury (disambiguation)'],
        })
        : page({
          title,
          extract: 'Mercury planet is the smallest planet in the Solar System.',
        }));
    } else if (scenario === 'blacklisted') {
      // The provider blocks this source-listed article before making a peer
      // request; this branch is a guard against accidental fixture reliance.
      raw = JSON.stringify(page({
        title: 'Nipple piercing',
        extract: 'Nipple piercing is a body piercing.',
      }));
    } else if (scenario === 'blacklisted-category') {
      raw = JSON.stringify(page({
        title: 'Fixture fact',
        extract: 'Fixture fact is a fixture fact.',
        categories: ['BDSM'],
      }));
    }
    else raw = JSON.stringify(page());
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
    response.end(raw);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/w/api.php`;
  try {
    await callback({ endpoint, requests, setScenario: (value) => { scenario = value; } });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(port, path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jibo-transid': 'profile-trans', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function assertWikipediaAction(body, expectedText) {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.skill.id, 'answer');
  assert.equal(body.data.skill.version, '5.2.15');
  assert.equal(body.data.action.type, 'JCP');
  assert.equal(body.data.action.config.version, '2.0');
  assert.equal(body.data.action.config.jcp.type, 'SLIM');
  assert.equal(body.data.action.config.jcp.config.play.type, 'PLAY');
  assert.equal(body.data.action.config.jcp.config.display, undefined);
  assert.equal(body.data.action.config.jcp.config.play.esml, expectedText);
  assert.equal(body.data.final, true);
  assert.equal(body.data.fireAndForget, true);
  assert.equal(body.data.analytics.answer[1].event, 'Answer Query');
  assert.deepEqual(body.data.analytics.answer[1].properties, {
    success: true,
    type: 'wiki',
  });
  assert.equal(typeof body.timings.total, 'number');
}

function assertNoAnswerAction(body, promptId = 'GQA_no_answer_what_01') {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.skill.id, 'answer');
  assert.equal(body.data.action.type, 'JCP');
  assert.equal(body.data.action.config.jcp.config.play.meta.prompt_id, promptId);
  assert.equal(body.data.action.config.jcp.config.display.type, 'DISPLAY');
  assert.equal(body.data.final, true);
  assert.equal(body.data.fireAndForget, true);
  assert.deepEqual(body.data.analytics.answer[1].properties, {
    success: false,
  });
  assert.equal(typeof body.timings.total, 'number');
}

test('Q-01 Wikipedia profile reads only explicit configuration', () => {
  assert.deepEqual(readGqaWikipediaProfileConfig({
    ETCO_gqa_wikiApi: 'http://fixture.invalid/w/api.php',
    ETCO_gqa_wikiTimeoutMs: '37',
    ETCO_gqa_wikiUserAgent: 'fixture-agent',
  }), {
    endpoint: 'http://fixture.invalid/w/api.php',
    timeoutMs: 37,
    userAgent: 'fixture-agent',
  });
  assert.throws(
    () => readGqaWikipediaProfileConfig({ ETCO_gqa_wikiTimeoutMs: '-1' }),
    /non-negative number/,
  );
});

test('Q-01 selectable Wikipedia profile serves original answer endpoint and aliases', async () => {
  await withApiPeer(async ({ endpoint, requests }) => {
    const server = await start(0, {
      gqaProfile: 'wikipedia',
      gqaEndpoint: endpoint,
      gqaTimeoutMs: '100',
    });
    try {
      const first = await postJson(server.address().port, '/answer_skill/v1/main', requestBody());
      assert.equal(first.response.status, 200);
      assertWikipediaAction(first.body, 'Fixture fact is a fixture fact.');
      assert.equal(requests.length, 1);

      const legacy = await postJson(server.address().port, '/answer_skill', requestBody());
      assert.equal(legacy.response.status, 200);
      assertWikipediaAction(legacy.body, 'Fixture fact is a fixture fact.');

      const phoenixAlias = await postJson(server.address().port, '/v1/main', requestBody());
      assert.equal(phoenixAlias.response.status, 200);
      assertWikipediaAction(phoenixAlias.body, 'Fixture fact is a fixture fact.');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('Q-01 gateway SkillClient reaches the selectable Wikipedia profile over HTTP', async () => {
  await withApiPeer(async ({ endpoint }) => {
    const service = createGqaWikipediaService({ endpoint, timeoutMs: 100 });
    const server = await service.listen(0);
    try {
      const components = buildComponents({
        disableAuth: true,
        hubTokenSecret: '',
        parserURL: 'http://127.0.0.1:9',
        historyURL: 'http://127.0.0.1:9',
        skills: [{ id: 'answer', URL: `http://127.0.0.1:${server.address().port}/answer_skill/v1/main`, intents: [] }],
      });
      const result = await components.skillClient.launch('answer', {
        context: {
          general: { accountID: 'fixture-account', robotID: 'fixture-robot', remoteAddress: '127.0.0.1' },
          runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
        },
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text: 'what is Fixture fact', confidence: 1 },
      }, { transId: 'gateway-trans' });
      assert.equal(result.error, undefined);
      assertWikipediaAction(result.response, 'Fixture fact is a fixture fact.');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('Q-01 actual gateway exposes the explicit profile and reaches its answer service', async () => {
  await withApiPeer(async ({ endpoint }) => {
    const profile = await createGqaWikipediaService({
      endpoint,
      timeoutMs: 100,
      random: () => 0,
    }).listen(0);
    const loaded = await loadConfig({ ETCO_hub_skillsConfig: 'skills-gqa-wikipedia.json' });
    const profileUrl = `http://127.0.0.1:${profile.address().port}/answer_skill/v1/main`;
    const gateway = await createGateway({
      ...loaded,
      disableAuth: true,
      hubTokenSecret: '',
      parserURL: 'http://127.0.0.1:9',
      historyURL: 'http://127.0.0.1:9',
      skills: loaded.skills.map((skill) => ({ ...skill, URL: profileUrl })),
    });
    await gateway.service.listen(0);
    try {
      const discovery = await fetch(`http://127.0.0.1:${gateway.service.server.address().port}/v1/skills`);
      assert.equal(discovery.status, 200);
      assert.deepEqual((await discovery.json()).skills.map(({ id }) => id), ['answer']);

      const result = await gateway.components.skillClient.launch('answer', {
        context: {
          general: { accountID: 'fixture-account', robotID: 'fixture-robot', remoteAddress: '127.0.0.1' },
          runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
        },
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text: 'what is Fixture fact', confidence: 1 },
      }, { transId: 'gateway-profile-trans' });
      assert.equal(result.error, undefined);
      assertWikipediaAction(result.response, 'Fixture fact is a fixture fact.');
    } finally {
      gateway.wss.close();
      await new Promise((resolve) => gateway.service.server.close(resolve));
      await new Promise((resolve) => profile.close(resolve));
    }
  });
});

test('Q-01 profile retains source Wikipedia timing keys on a successful answer', async () => {
  await withApiPeer(async ({ endpoint, setScenario }) => {
    const service = await createGqaWikipediaService({ endpoint, timeoutMs: 100, random: () => 0 }).listen(0);
    try {
      setScenario('success');
      const result = await postJson(service.address().port, '/answer_skill/v1/main', requestBody());
      assert.equal(result.response.status, 200);
      assert.deepEqual(Object.keys(result.body.timings).sort(), [
        'finalization_part', 'initialization_part', 'total', 'wiki', 'wiki_tokenization',
      ].sort());
      assert.equal(typeof result.body.timings.wiki, 'number');
      assert.equal(typeof result.body.timings.wiki_tokenization, 'number');
    } finally {
      await new Promise((resolve) => service.close(resolve));
    }
  });
});

test('Q-01 profile measures Wikipedia phases from the source fork boundary', async () => {
  // start, fork, tokenization-begin, request, response, end
  const ticks = [1000, 1001, 1001, 1005, 1006];
  const service = await createGqaWikipediaService({
    endpoint: 'http://fixture.invalid/w/api.php',
    fetchImpl: async () => new Response(JSON.stringify(page()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    timeoutMs: 100,
    random: () => 0,
    clock: () => ticks.shift() ?? 1006,
  }).listen(0);
  try {
    const result = await postJson(service.address().port, '/answer_skill/v1/main', requestBody());
    assert.equal(result.response.status, 200);
    assert.equal(result.body.timings.wiki, 0.005);
    assert.equal(result.body.timings.wiki_tokenization, 0);
    assert.equal(result.body.timings.total, 6);
  } finally {
    await new Promise((resolve) => service.close(resolve));
  }
});

test('Q-01 profile maps provider failures to the source no-answer action', async () => {
  await withApiPeer(async ({ endpoint, setScenario }) => {
    const service = createGqaWikipediaService({ endpoint, timeoutMs: 15, random: () => 0 });
    const server = await service.listen(0);
    try {
      for (const scenario of ['missing', 'malformed', 'http-error', 'late']) {
        setScenario(scenario);
        const result = await postJson(server.address().port, '/answer_skill/v1/main', requestBody());
        assert.equal(result.response.status, 200, scenario);
        assert.equal(result.body.type, 'SKILL_ACTION', scenario);
        assert.equal(result.body.data.skill.id, 'answer', scenario);
        assertNoAnswerAction(result.body, 'GQA_no_answer_what_01');
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('Q-01 profile preserves source action selection across answer, no-result, disambiguation, blacklist and provider failure', async () => {
  await withApiPeer(async ({ endpoint, requests, setScenario }) => {
    const service = await createGqaWikipediaService({ endpoint, timeoutMs: 100, random: () => 0 }).listen(0);
    try {
      setScenario('success');
      const success = await postJson(service.address().port, '/answer_skill/v1/main', requestBody());
      assert.equal(success.response.status, 200);
      assertWikipediaAction(success.body, 'Fixture fact is a fixture fact.');

      setScenario('missing');
      const missing = await postJson(service.address().port, '/answer_skill/v1/main', requestBody('what is Unknown fixture'));
      assert.equal(missing.response.status, 200);
      assertNoAnswerAction(missing.body);

      setScenario('disambiguation');
      const disambiguation = await postJson(service.address().port, '/answer_skill/v1/main', requestBody('what is Mercury'));
      assert.equal(disambiguation.response.status, 200);
      assertWikipediaAction(
        disambiguation.body,
        "I found a few things. Here's one of them.  Mercury planet is the smallest planet in the Solar System.",
      );

      const beforeBlacklist = requests.length;
      setScenario('blacklisted');
      const blacklisted = await postJson(service.address().port, '/answer_skill/v1/main', requestBody('what is Nipple piercing'));
      assert.equal(blacklisted.response.status, 200);
      assertNoAnswerAction(blacklisted.body);
      assert.equal(requests.length, beforeBlacklist, 'blacklisted source article must be suppressed before HTTP');

      const beforeCategoryBlacklist = requests.length;
      setScenario('blacklisted-category');
      const categoryBlacklisted = await postJson(service.address().port, '/answer_skill/v1/main', requestBody());
      assert.equal(categoryBlacklisted.response.status, 200);
      assertNoAnswerAction(categoryBlacklisted.body);
      assert.equal(requests.length, beforeCategoryBlacklist + 1, 'blacklisted source category is checked after the page request');

      setScenario('http-error');
      const failed = await postJson(service.address().port, '/answer_skill/v1/main', requestBody());
      assert.equal(failed.response.status, 200);
      assertNoAnswerAction(failed.body);
    } finally {
      await new Promise((resolve) => service.close(resolve));
    }
  });
});

test('Q-01 profile keeps the source missing-transID status and failure media type', async () => {
  await withApiPeer(async ({ endpoint }) => {
    const service = await createGqaWikipediaService({ endpoint, timeoutMs: 100 }).listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${service.address().port}/answer_skill/v1/main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody()),
      });
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.match(await response.text(), /Missing X-JIBO-transID header/);
    } finally {
      await new Promise((resolve) => service.close(resolve));
    }
  });
});

test('Q-01 default skill registry does not select the Wikipedia profile implicitly', async () => {
  const server = await start(0, { skillId: 'answer-skill', gqaProfile: undefined });
  try {
    assert.ok(server.address().port > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-01 gateway profile registry is explicit and points at the source answer path', async () => {
  const config = await loadConfig({ ETCO_hub_skillsConfig: 'skills-gqa-wikipedia.json' });
  assert.deepEqual(config.skills.map(({ id, URL }) => ({ id, URL })), [
    { id: 'answer', URL: 'http://localhost:9013/answer_skill/v1/main' },
  ]);
});
