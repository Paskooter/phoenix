import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGqaDefaultSkill, start } from '../src/index.js';
import { createGateway } from '../../gateway/src/index.js';
import { loadConfig } from '../../gateway/src/config.js';

const GQA_REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'default-gqa-request',
  ts: 1700000000000,
  data: {
    general: {
      accountID: 'fixture-account',
      robotID: 'fixture-robot',
      remoteAddress: '127.0.0.1',
    },
    runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
    skill: { id: 'answer-skill', session: null },
    result: {
      nlu: { intent: 'generalWhatQuestions', entities: {} },
      asr: { text: 'what is a fixture fact', confidence: 1 },
    },
  },
};

const REPORT_REQUEST = {
  type: 'LISTEN_LAUNCH',
  msgID: 'default-report-request',
  ts: 1700000000000,
  data: {
    general: { accountID: 'fixture-account', robotID: 'fixture-robot', lang: 'en-US' },
    runtime: {
      loop: {
        loopId: 'fixture-loop',
        users: [{ id: 'fixture-speaker', accountId: 'fixture-account', birthdate: '1990-01-01' }],
      },
      location: { lat: 42.36, lng: -71.06, iso: '2018-05-30T12:00:00+00:00' },
      perception: { speaker: 'fixture-speaker' },
      character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
      dialog: {},
    },
    skill: { id: 'report-skill' },
    result: {
      nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] },
      asr: { text: 'personal report', confidence: 1 },
      memo: 'Reactive',
    },
  },
};

function bingAnswer() {
  return {
    rankingResponse: { mainline: { items: [{ answerType: 'Facts' }] } },
    facts: { conversation: { spokenText: 'The default GQA fact' } },
  };
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function providerPeers(mode = 'success') {
  const peers = [];
  const make = (kind) => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (mode === 'errors') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture provider unavailable' }));
        return;
      }
      if (kind === 'Bing') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'BingAPIs-Market': 'en-us',
        });
        response.end(JSON.stringify(bingAnswer()));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(kind === 'Wikipedia'
        ? { query: { pages: { '-1': { title: 'Unknown fixture', missing: '' } } } }
        : { queryresult: { success: false } }));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      peers.push(server);
      resolve({
        server,
        requests,
        endpoint: `http://127.0.0.1:${server.address().port}/fixture`,
      });
    }));
  };
  const [bing, wikipedia, wolfram] = await Promise.all([
    make('Bing'),
    make('Wikipedia'),
    make('Wolfram Alpha'),
  ]);
  return {
    bing,
    wikipedia,
    wolfram,
    async close() { await Promise.all(peers.map(closeServer)); },
  };
}

function profileEnvironment(peers) {
  return {
    ETCO_gqa_bingApi: peers.bing.endpoint,
    ETCO_gqa_bingKey: 'fixture-bing-key',
    ETCO_gqa_wikiApi: peers.wikipedia.endpoint,
    ETCO_gqa_wolframApi: peers.wolfram.endpoint,
    ETCO_gqa_wolframKey: 'fixture-wolfram-key',
  };
}

async function post(server, path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jibo-transid': 'default-gqa-trans', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function answerText(body) {
  return body.data.action.config.jcp.config.play.esml;
}

function assertGqaAnswer(body) {
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.skill.id, 'answer-skill');
  assert.equal(answerText(body), 'The default GQA fact.');
  assert.equal(body.data.analytics.answer[1].properties.type, 'bing');
  assert.equal(body.data.analytics.answer[1].properties.success, true);
}

test('shared-host GQA profile requires an explicit source provider configuration', () => {
  assert.throws(
    () => createGqaDefaultSkill({ env: {} }),
    /Bing endpoint must be configured explicitly/,
  );
  assert.throws(
    () => start(0, {
      skillId: null,
      gqaDefaultProfile: 'multi-provider',
      gqaEnvironment: {},
    }),
    /Bing endpoint must be configured explicitly/,
  );
  assert.throws(
    () => start(0, { skillId: null, gqaDefaultProfile: 'unknown' }),
    /Unknown PHOENIX_GQA_DEFAULT_PROFILE 'unknown'/,
  );
});

test('default skills host routes GQA answer and preserves other skill selection', async () => {
  const peers = await providerPeers();
  const service = await start(0, {
    skillId: null,
    gqaDefaultProfile: 'multi-provider',
    gqaEnvironment: profileEnvironment(peers),
    gqaConfig: { random: () => 0 },
  });
  try {
    const defaultResult = await post(service, '/v1/main', GQA_REQUEST);
    assert.equal(defaultResult.response.status, 200);
    assertGqaAnswer(defaultResult.body);

    const namedResult = await post(service, '/v1/answer-skill/main', GQA_REQUEST);
    assert.equal(namedResult.response.status, 200);
    assertGqaAnswer(namedResult.body);
    assert.equal(peers.bing.requests.length, 2);
    assert.equal(peers.wikipedia.requests.length, 2);
    assert.equal(peers.wolfram.requests.length, 0);

    const reportResult = await post(service, '/v1/report-skill/main', REPORT_REQUEST);
    assert.equal(reportResult.response.status, 200);
    assert.equal(reportResult.body.type, 'SKILL_ACTION');
    assert.equal(reportResult.body.data.skill.id, 'report-skill');
  } finally {
    await closeServer(service);
    await peers.close();
  }
});

test('selected answer-skill host uses the source GQA route under the default profile', async () => {
  const peers = await providerPeers();
  const service = await start(0, {
    skillId: 'answer-skill',
    gqaDefaultProfile: 'multi-provider',
    gqaEnvironment: profileEnvironment(peers),
    gqaConfig: { random: () => 0 },
  });
  try {
    const result = await post(service, '/v1/main', GQA_REQUEST);
    assert.equal(result.response.status, 200);
    assertGqaAnswer(result.body);
    assert.equal(peers.bing.requests.length, 1);
    assert.equal(peers.wikipedia.requests.length, 1);
    assert.equal(peers.wolfram.requests.length, 0);
  } finally {
    await closeServer(service);
    await peers.close();
  }
});

test('default gateway registry reaches the GQA host through the answer-skill entry', async () => {
  const peers = await providerPeers();
  const skills = await start(0, {
    skillId: null,
    gqaDefaultProfile: 'multi-provider',
    gqaEnvironment: profileEnvironment(peers),
    gqaConfig: { random: () => 0 },
  });
  const loaded = await loadConfig({ ETCO_hub_skillsConfig: 'skills-gqa-default.json' });
  const answerURL = `http://127.0.0.1:${skills.address().port}/v1/answer-skill/main`;
  const gateway = await createGateway({
    ...loaded,
    disableAuth: true,
    hubTokenSecret: '',
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    skills: loaded.skills.map((skill) => skill.id === 'answer-skill'
      ? { ...skill, URL: answerURL }
      : skill),
  });
  await gateway.service.listen(0);
  try {
    assert.equal(loaded.skills[0].id, 'answer-skill');
    assert.match(loaded.skills[0].URL, /answer-skill:8080\/v1\/main$/);
    const result = await gateway.components.skillClient.launch('answer-skill', {
      context: GQA_REQUEST.data,
      nlu: GQA_REQUEST.data.result.nlu,
      asr: GQA_REQUEST.data.result.asr,
    }, { transId: 'gateway-default-gqa' });
    assert.equal(result.error, undefined);
    assertGqaAnswer(result.response);
  } finally {
    await new Promise((resolve) => gateway.wss.close(resolve));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => error ? reject(error) : resolve()));
    await closeServer(skills);
    await peers.close();
  }
});

test('default GQA provider outage returns source no-answer instead of the LLM placeholder', async () => {
  const peers = await providerPeers('errors');
  const service = await start(0, {
    skillId: null,
    gqaDefaultProfile: 'multi-provider',
    gqaEnvironment: profileEnvironment(peers),
    gqaConfig: { random: () => 0, timeouts: [20, 20] },
  });
  try {
    const result = await post(service, '/v1/main', GQA_REQUEST);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.type, 'SKILL_ACTION');
    assert.equal(result.body.data.skill.id, 'answer-skill');
    assert.equal(result.body.data.action.config.jcp.config.display.type, 'DISPLAY');
    assert.equal(result.body.data.analytics.answer[1].properties.success, false);
    assert.notEqual(answerText(result.body), "I'm not sure about that one.");
    assert.equal(peers.bing.requests.length, 1);
    assert.equal(peers.wikipedia.requests.length, 1);
    assert.equal(peers.wolfram.requests.length, 1);
  } finally {
    await closeServer(service);
    await peers.close();
  }
});
