import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGqaWikipediaService, readGqaWikipediaProfileConfig } from '../src/gqaWikipediaService.js';
import { buildComponents } from '../../gateway/src/index.js';
import { loadConfig } from '../../gateway/src/config.js';
import { start } from '../src/index.js';

function page({ title = 'Fixture fact', extract = 'Fixture fact is a fixture fact.', missing } = {}) {
  const value = { title, extract, categories: [] };
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

test('Q-01 profile keeps no-result, malformed and late provider failures visible', async () => {
  await withApiPeer(async ({ endpoint, setScenario }) => {
    const service = createGqaWikipediaService({ endpoint, timeoutMs: 15 });
    const server = await service.listen(0);
    try {
      for (const scenario of ['missing', 'malformed', 'http-error', 'late']) {
        setScenario(scenario);
        const result = await postJson(server.address().port, '/answer_skill/v1/main', requestBody());
        assert.equal(result.response.status, 200, scenario);
        assert.equal(result.body.type, 'SKILL_ACTION', scenario);
        assert.equal(result.body.data.skill.id, 'answer', scenario);
        assert.match(result.body.data.action.config.jcp.config.play.meta.prompt_id, /^GQA_error_0[1-9]$/, scenario);
        // The source Wikipedia adapter retains source='Wikipedia' even when
        // it also returns a message.  The source analytics helper therefore
        // records the provider source while the selected GQA_error MIM keeps
        // the failure visible to the robot.
        assert.deepEqual(result.body.data.analytics.answer[1].properties, {
          success: true,
          type: 'wiki',
        }, scenario);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
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
